// Material Issue Request lifecycle (docs/wms/01-design.md §2.5):
// Draft → Submitted → [auto-validation] → Pending Approval → Approved / Rejected / Returned → Reserved → Picking
// → Ready for Delivery → Delivered (Partial/Full) → Closed. Exceptions: Cancelled; Overdue (SLA escalation).
import { many, one } from "../db/pool.ts";
import { E, ApiError } from "../lib/errors.ts";
import { issueCustody } from "./custody.ts";
import { enqueue } from "./integrations.ts";
import { docEvent, findItemId, findLocation, nextDocNo, notify, post, release, reserve, round4, setting, type Tx } from "./common.ts";
import { actOnTask, buildChain, createTasks, type DocCtx } from "./workflow.ts";
import { encryptBlob, sha256 } from "../lib/crypto.ts";
import { config } from "../config.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface MrInput {
  requestType: "issue" | "urgent" | "work_order" | "custody" | "reservation";
  warehouseId: string; neededBy?: string | null; purpose?: string | null; justification?: string | null; workOrderRef?: string | null;
  priority?: "normal" | "high" | "urgent";
  lines: { itemId: string; uomId?: string | null; qty: number; notes?: string | null }[];
}

export async function lockMr(c: Tx, id: string) {
  const mr = await one(c, "SELECT * FROM material_request WHERE id = $1 FOR UPDATE", [id]);
  if (!mr) throw E.notFound("material request");
  return mr;
}

function assertStatus(mr: any, allowed: string[], action: string) {
  if (!allowed.includes(mr.status)) throw E.state(mr.status, action);
}

async function writeLines(c: Tx, mrId: string, warehouseId: string, lines: MrInput["lines"]) {
  if (!lines.length) throw E.invalid([{ path: "lines", message: "at_least_one_line" }]);
  const seen = new Set<string>();
  let n = 0, total = 0;
  for (const l of lines) {
    if (seen.has(l.itemId)) throw E.invalid([{ path: `lines.${n}.itemId`, message: "duplicate_line_item" }]);
    seen.add(l.itemId);
    const it = await one(c, "SELECT id, base_uom_id, standard_cost FROM item WHERE id = $1 AND deleted_at IS NULL", [l.itemId]);
    if (!it) throw E.invalid([{ path: `lines.${n}.itemId`, message: "unknown_item" }]);
    let factor = 1;
    const uomId = l.uomId ?? it.base_uom_id;
    if (uomId !== it.base_uom_id) {
      const cv = await one(c, "SELECT factor_to_base FROM item_uom_conversion WHERE item_id = $1 AND uom_id = $2 AND deleted_at IS NULL", [l.itemId, uomId]);
      if (!cv) throw E.invalid([{ path: `lines.${n}.uomId`, message: "no_conversion_for_uom" }]);
      factor = Number(cv.factor_to_base);
    }
    const val = await one(c, "SELECT avg_cost FROM item_valuation WHERE item_id = $1 AND warehouse_id = $2", [l.itemId, warehouseId]);
    const cost = Number(val?.avg_cost) || Number(it.standard_cost) || 0;
    const base = round4(l.qty * factor);
    await c.query(`INSERT INTO mr_line (mr_id, line_no, item_id, uom_id, factor_to_base, qty_requested, unit_cost_est, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [mrId, ++n, l.itemId, uomId, factor, base, cost, l.notes ?? null]);
    total += base * cost;
  }
  await c.query("UPDATE material_request SET estimated_value = $2 WHERE id = $1", [mrId, Math.round(total * 100) / 100]);
}

export async function createDraft(c: Tx, actor: { id: string; orgUnitId: string | null }, b: MrInput) {
  if (!actor.orgUnitId) throw new ApiError(422, "no_department", "المستخدم غير مرتبط بإدارة", "User is not linked to a department");
  const no = await nextDocNo(c, "MR");
  const mr = await one(c, `INSERT INTO material_request (mr_no, request_type, requester_id, org_unit_id, warehouse_id, priority, needed_by, purpose, justification, work_order_ref)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [no, b.requestType, actor.id, actor.orgUnitId, b.warehouseId, b.requestType === "urgent" ? "urgent" : b.priority ?? "normal", b.neededBy ?? null,
     b.purpose ?? null, b.justification ?? null, b.workOrderRef ?? null]);
  await writeLines(c, mr.id, b.warehouseId, b.lines);
  await docEvent(c, "MR", mr.id, "created", { to: "draft", actorId: actor.id });
  return mr;
}

export async function updateDraft(c: Tx, actorId: string, id: string, b: MrInput, version: number) {
  const mr = await lockMr(c, id);
  assertStatus(mr, ["draft"], "edit");
  if (mr.requester_id !== actorId) throw E.forbidden("own draft only");
  if (mr.version !== version) throw E.stale();
  await c.query(`UPDATE material_request SET request_type = $2, warehouse_id = $3, priority = $4, needed_by = $5, purpose = $6, justification = $7, work_order_ref = $8
                 WHERE id = $1`, [id, b.requestType, b.warehouseId, b.requestType === "urgent" ? "urgent" : b.priority ?? "normal", b.neededBy ?? null,
    b.purpose ?? null, b.justification ?? null, b.workOrderRef ?? null]);
  // replaced lines are soft-deleted (history stays in the audit trail)
  await c.query("UPDATE mr_line SET deleted_at = now(), deleted_by = $2 WHERE mr_id = $1 AND deleted_at IS NULL", [id, actorId]);
  await writeLines(c, id, b.warehouseId, b.lines);
}

const activeLines = (c: Tx, mrId: string) => many(c,
  `SELECT l.*, i.item_code, i.name_ar, i.name_en, i.status AS item_status, i.item_type, g.parent_id AS category_id, cat.is_critical
     FROM mr_line l JOIN item i ON i.id = l.item_id JOIN item_category g ON g.id = i.group_id JOIN item_category cat ON cat.id = g.parent_id
    WHERE l.mr_id = $1 AND l.deleted_at IS NULL ORDER BY l.line_no`, [mrId]);

export async function freeStock(c: Tx, itemId: string, warehouseId: string): Promise<number> {
  const r = await one(c, "SELECT coalesce(sum(qty_free), 0) AS q FROM v_pickable_stock WHERE item_id = $1 AND warehouse_id = $2", [itemId, warehouseId]);
  return Number(r.q);
}

/** Auto-validation: stock, budget, duplicates, mandatory fields. Errors always block; warnings block unless acknowledged. */
export async function validate(c: Tx, mr: any) {
  const lines = await activeLines(c, mr.id);
  const errors: any[] = [], warnings: any[] = [];
  if (!lines.length) errors.push({ code: "no_lines" });
  if (mr.request_type === "urgent" && (mr.justification ?? "").trim().length < 10) errors.push({ code: "justification_required" });
  if (mr.request_type === "work_order" && !mr.work_order_ref) errors.push({ code: "work_order_ref_required" });
  for (const l of lines) {
    if (l.item_status !== "active") errors.push({ code: "item_not_active", item: l.item_code });
    if (l.item_type === "non_stock") errors.push({ code: "non_stock_item", item: l.item_code });
    if (mr.request_type === "custody" && l.item_type !== "asset") warnings.push({ code: "custody_non_asset", item: l.item_code });
    const free = await freeStock(c, l.item_id, mr.warehouse_id);
    if (free <= 0) errors.push({ code: "out_of_stock", item: l.item_code, requested: Number(l.qty_requested), available: 0 });
    else if (free < Number(l.qty_requested)) warnings.push({ code: "partial_stock", item: l.item_code, requested: Number(l.qty_requested), available: free });
  }
  // budget (annual, per department; 0 = not controlled)
  const org = await one(c, "SELECT annual_budget FROM org_unit WHERE id = $1", [mr.org_unit_id]);
  if (Number(org?.annual_budget) > 0) {
    const used = await one(c, `SELECT
        coalesce((SELECT sum(issued_value) FROM material_request WHERE org_unit_id = $1 AND date_trunc('year', submitted_at) = date_trunc('year', now())), 0)
      + coalesce((SELECT sum(estimated_value - issued_value) FROM material_request WHERE org_unit_id = $1 AND id <> $2
                    AND status IN ('pending_approval','approved','reserved','picking','ready_for_delivery','partially_delivered')), 0) AS n`, [mr.org_unit_id, mr.id]);
    const remaining = Number(org.annual_budget) - Number(used.n);
    if (Number(mr.estimated_value) > remaining) errors.push({ code: "budget_exceeded", budget: Number(org.annual_budget), remaining: Math.round(remaining), requested: Number(mr.estimated_value) });
  }
  // duplicates: same requester, same item, open request in the last 7 days
  const dups = await many(c, `SELECT DISTINCT m.mr_no, i.item_code FROM material_request m JOIN mr_line l ON l.mr_id = m.id AND l.deleted_at IS NULL JOIN item i ON i.id = l.item_id
                               WHERE m.requester_id = $1 AND m.id <> $2 AND m.created_at > now() - interval '7 days'
                                 AND m.status NOT IN ('draft','rejected','cancelled','closed') AND l.item_id = ANY($3)`,
    [mr.requester_id, mr.id, lines.map((l) => l.item_id)]);
  for (const d of dups) warnings.push({ code: "possible_duplicate", mr: d.mr_no, item: d.item_code });
  return { ok: errors.length === 0, errors, warnings, lines };
}

export async function submit(c: Tx, actorId: string, id: string, acknowledgeWarnings = false) {
  const mr = await lockMr(c, id);
  assertStatus(mr, ["draft"], "submit");
  if (mr.requester_id !== actorId) throw E.forbidden("own request only");
  const v = await validate(c, mr);
  const blocking = !v.ok || (v.warnings.length > 0 && !acknowledgeWarnings);
  await c.query("UPDATE material_request SET validation = $2 WHERE id = $1", [id, JSON.stringify({ errors: v.errors, warnings: v.warnings, at: new Date() })]);
  if (blocking) {
    await docEvent(c, "MR", id, "validation_failed", { from: "draft", to: "draft", actorId, data: { errors: v.errors, warnings: v.warnings } });
    return { ok: false, errors: v.errors, warnings: v.warnings };
  }
  const slaHours = await setting<{ standard: number; urgent: number }>(c, "requests.sla_hours", { standard: 24, urgent: 4 });
  const ctx: DocCtx = {
    docType: "MR", docId: id, docNo: mr.mr_no, requestType: mr.request_type, value: Number(mr.estimated_value), orgUnitId: mr.org_unit_id,
    warehouseId: mr.warehouse_id, requesterId: mr.requester_id, hasCritical: v.lines.some((l) => l.is_critical),
    categoryIds: [...new Set(v.lines.map((l) => l.category_id))], revision: mr.revision,
  };
  const chain = await buildChain(c, ctx);
  await c.query(`UPDATE material_request SET status = $2, submitted_at = now(), current_level = $3, status_reason = NULL,
                   sla_due_at = now() + make_interval(hours => $4), is_overdue = false WHERE id = $1`,
    [id, chain.length ? "pending_approval" : "approved", chain[0]?.level ?? null, mr.request_type === "urgent" ? slaHours.urgent : slaHours.standard]);
  await docEvent(c, "MR", id, "submitted", { from: "draft", to: chain.length ? "pending_approval" : "approved", actorId,
    data: { warnings: v.warnings, chain: chain.map((l) => ({ level: l.level, approvers: l.assignees.map((a) => a.userId), anyOne: l.anyOne })) } });
  if (chain.length) await createTasks(c, ctx, chain);
  else await approveFinal(c, id, actorId);
  return { ok: true, warnings: v.warnings, levels: chain.length };
}

async function approveFinal(c: Tx, id: string, actorId: string) {
  await c.query("UPDATE material_request SET status = 'approved', approved_at = now(), current_level = NULL WHERE id = $1", [id]);
  await c.query("UPDATE mr_line SET qty_approved = coalesce(qty_approved, qty_requested) WHERE mr_id = $1 AND deleted_at IS NULL", [id]);
  const mr = await one(c, "SELECT mr_no, requester_id, warehouse_id FROM material_request WHERE id = $1", [id]);
  await docEvent(c, "MR", id, "approved", { from: "pending_approval", to: "approved", actorId });
  const keepers = await many(c, `SELECT u.id FROM app_user u JOIN user_role ur ON ur.user_id = u.id AND ur.is_active JOIN role r ON r.id = ur.role_id AND r.code = 'SK'
                                 WHERE ur.warehouse_ids IS NULL OR $1 = ANY(ur.warehouse_ids)`, [mr.warehouse_id]);
  await notify(c, [mr.requester_id], { kind: "mr_approved", titleAr: `تم اعتماد طلبك ${mr.mr_no}`, titleEn: `Your request ${mr.mr_no} was approved`, link: `/requests/${id}`, docType: "MR", docId: id });
  await notify(c, keepers.map((k) => k.id), { kind: "mr_to_fulfil", titleAr: `طلب معتمد جاهز للتجهيز — ${mr.mr_no}`, titleEn: `Approved request ready to fulfil — ${mr.mr_no}`,
    link: `/requests/${id}`, docType: "MR", docId: id });
}

export async function decide(c: Tx, actorId: string, id: string, action: "approve" | "reject" | "return", comment?: string,
  lineQty?: { lineId: string; qtyApproved: number }[]) {
  const mr = await lockMr(c, id);
  assertStatus(mr, ["pending_approval"], action);
  if (action !== "approve" && !(comment && comment.trim().length >= 3)) throw E.invalid([{ path: "comment", message: "reason_required" }]);
  // approvers may reduce (never increase) approved quantities
  if (action === "approve" && lineQty?.length) {
    for (const lq of lineQty) {
      const l = await one(c, "SELECT * FROM mr_line WHERE id = $1 AND mr_id = $2 AND deleted_at IS NULL", [lq.lineId, id]);
      if (!l) throw E.notFound("request line");
      if (lq.qtyApproved > Number(l.qty_approved ?? l.qty_requested) + 1e-9) throw E.invalid([{ path: "qtyApproved", message: "cannot_exceed_requested" }]);
      await c.query("UPDATE mr_line SET qty_approved = $2 WHERE id = $1", [lq.lineId, lq.qtyApproved]);
    }
  }
  const map = { approve: "approved", reject: "rejected", return: "returned" } as const;
  const r = await actOnTask(c, { docType: "MR", docId: id, docNo: mr.mr_no, revision: mr.revision }, actorId, map[action], comment);
  await docEvent(c, "MR", id, `${map[action]}_l${r.level}`, { actorId, comment });
  if (action === "reject") {
    await c.query("UPDATE material_request SET status = 'rejected', status_reason = $2 WHERE id = $1", [id, comment]);
    await notify(c, [mr.requester_id], { kind: "mr_rejected", titleAr: `تم رفض طلبك ${mr.mr_no}`, titleEn: `Your request ${mr.mr_no} was rejected`,
      bodyAr: comment, bodyEn: comment, link: `/requests/${id}`, docType: "MR", docId: id });
  } else if (action === "return") {
    await c.query("UPDATE material_request SET status = 'draft', status_reason = $2, revision = revision + 1, current_level = NULL, sla_due_at = NULL WHERE id = $1", [id, comment]);
    await notify(c, [mr.requester_id], { kind: "mr_returned", titleAr: `أعيد طلبك ${mr.mr_no} للتعديل`, titleEn: `Your request ${mr.mr_no} was returned for revision`,
      bodyAr: comment, bodyEn: comment, link: `/requests/${id}`, docType: "MR", docId: id });
  } else if (r.result === "done") {
    await approveFinal(c, id, actorId);
  } else if (r.result === "next") {
    await c.query("UPDATE material_request SET current_level = $2 WHERE id = $1", [id, r.level]);
  }
  return { status: (await one(c, "SELECT status FROM material_request WHERE id = $1", [id])).status };
}

async function approversOf(c: Tx, id: string): Promise<string[]> {
  return (await many(c, "SELECT DISTINCT acted_by FROM approval_task WHERE doc_type = 'MR' AND doc_id = $1 AND status = 'approved'", [id])).map((r) => r.acted_by);
}

/** SoD-1/2: the issuer can be neither the requester nor an approver of the same request. */
async function assertIssuer(c: Tx, mr: any, actorId: string) {
  if (actorId === mr.requester_id) throw E.sod("SoD-1", "لا يجوز لمقدّم الطلب صرف طلبه", "The requester cannot fulfil their own request");
  if ((await approversOf(c, mr.id)).includes(actorId)) throw E.sod("SoD-2", "لا يجوز لمن اعتمد الطلب أن يصرفه", "An approver of the request cannot issue it");
}

const ORDER: Record<string, string> = {
  FEFO: "expiry_date ASC NULLS LAST, first_received_at ASC NULLS LAST, pick_sequence",
  FIFO: "first_received_at ASC NULLS LAST, expiry_date ASC NULLS LAST, pick_sequence",
  LIFO: "first_received_at DESC NULLS LAST, pick_sequence",
};

export async function pickingRule(c: Tx, itemId: string, warehouseId: string): Promise<"FIFO" | "FEFO" | "LIFO"> {
  const r = await one(c, `SELECT p.picking_rule, i.track_expiry, w.default_picking_rule
                            FROM item i JOIN warehouse w ON w.id = $2
                            LEFT JOIN item_warehouse_policy p ON p.item_id = i.id AND p.warehouse_id = w.id AND p.deleted_at IS NULL
                           WHERE i.id = $1`, [itemId, warehouseId]);
  return r.picking_rule ?? (r.track_expiry ? "FEFO" : r.default_picking_rule);
}

/** Reserves remaining approved quantities following each item's picking rule (FIFO / FEFO / LIFO). */
export async function reserveStock(c: Tx, actorId: string, id: string) {
  const mr = await lockMr(c, id);
  assertStatus(mr, ["approved", "partially_delivered"], "reserve");
  await assertIssuer(c, mr, actorId);
  const lines = await activeLines(c, id);
  let reservedAny = 0;
  const shortages: any[] = [];
  for (const l of lines) {
    const active = await one(c, "SELECT coalesce(sum(qty - qty_consumed), 0) AS q FROM reservation WHERE source_type = 'MR' AND source_line_id = $1 AND status = 'active'", [l.id]);
    let need = round4(Number(l.qty_approved ?? l.qty_requested) - Number(l.qty_issued) - Number(active.q));
    if (need <= 0) continue;
    const rule = await pickingRule(c, l.item_id, mr.warehouse_id);
    const cands = await many(c, `SELECT * FROM v_pickable_stock WHERE item_id = $1 AND warehouse_id = $2 ORDER BY ${ORDER[rule]}`, [l.item_id, mr.warehouse_id]);
    for (const b of cands) {
      if (need <= 0) break;
      const q = Math.min(need, Number(b.qty_free));
      if (q <= 0) continue;
      await reserve(c, b.id, q, "MR", id, l.id);
      need = round4(need - q);
      reservedAny += q;
    }
    const totalRes = await one(c, "SELECT coalesce(sum(qty - qty_consumed), 0) AS q FROM reservation WHERE source_type = 'MR' AND source_line_id = $1 AND status = 'active'", [l.id]);
    await c.query("UPDATE mr_line SET qty_reserved = $2 WHERE id = $1", [l.id, totalRes.q]);
    if (need > 0) shortages.push({ item: l.item_code, short: need });
  }
  if (reservedAny <= 0) throw new ApiError(409, "out_of_stock", "لا يتوفر مخزون قابل للحجز لهذا الطلب", "No stock available to reserve for this request", { shortages });
  await c.query("UPDATE material_request SET status = 'reserved' WHERE id = $1", [id]);
  await docEvent(c, "MR", id, "reserved", { from: mr.status, to: "reserved", actorId, data: { shortages } });
  return { shortages };
}

/** Releases a pick list sorted by bin pick sequence (path order). */
export async function releasePickList(c: Tx, actorId: string, id: string, assignTo?: string | null) {
  const mr = await lockMr(c, id);
  assertStatus(mr, ["reserved"], "release pick list");
  await assertIssuer(c, mr, actorId);
  const res = await many(c, `SELECT r.*, l.pick_sequence, l.full_code FROM reservation r JOIN location l ON l.id = r.location_id
                              WHERE r.source_type = 'MR' AND r.source_id = $1 AND r.status = 'active'
                                AND NOT EXISTS (SELECT 1 FROM pick_task t WHERE t.reservation_id = r.id AND t.status <> 'cancelled')
                              ORDER BY l.pick_sequence, l.full_code`, [id]);
  if (!res.length) throw new ApiError(409, "nothing_to_pick", "لا توجد كميات محجوزة للتجهيز", "Nothing reserved to pick");
  const items = new Set(res.map((r) => r.item_id));
  const rules = await Promise.all([...items].map((i) => pickingRule(c, i, mr.warehouse_id)));
  const pickNo = await nextDocNo(c, "PCK");
  const pl = await one(c, `INSERT INTO pick_list (pick_no, mr_id, warehouse_id, picking_rule, assigned_to, released_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [pickNo, id, mr.warehouse_id, [...new Set(rules)].join("/"), assignTo ?? null, actorId]);
  let seq = 0;
  for (const r of res) {
    await c.query(`INSERT INTO pick_task (pick_list_id, mr_line_id, reservation_id, item_id, lot_id, location_id, seq, qty) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [pl.id, r.source_line_id, r.id, r.item_id, r.lot_id, r.location_id, ++seq, Number(r.qty) - Number(r.qty_consumed)]);
  }
  await c.query("UPDATE material_request SET status = 'picking' WHERE id = $1", [id]);
  await docEvent(c, "MR", id, "pick_list_released", { from: "reserved", to: "picking", actorId, data: { pickNo, tasks: seq } });
  if (assignTo) await notify(c, [assignTo], { kind: "pick_task", titleAr: `قائمة تجهيز جديدة ${pickNo}`, titleEn: `New pick list ${pickNo}`, link: `/m/pick/${pl.id}`, docType: "MR", docId: id });
  return pl;
}

/** Scan-confirmed pick: bin and item (and lot/serial when tracked) must match the task. */
export async function confirmPick(c: Tx, actorId: string, taskId: string, scan: { location: string; item: string; lot?: string | null; qty: number }) {
  const t = await one(c, `SELECT t.*, pl.mr_id, pl.warehouse_id, sl.lot_no, sl.serial_no FROM pick_task t JOIN pick_list pl ON pl.id = t.pick_list_id
                            LEFT JOIN stock_lot sl ON sl.id = t.lot_id WHERE t.id = $1 FOR UPDATE OF t`, [taskId]);
  if (!t) throw E.notFound("pick task");
  if (t.status !== "open") throw E.state(t.status, "pick");
  const loc = await findLocation(c, scan.location, t.warehouse_id);
  if (!loc || loc.id !== t.location_id) throw new ApiError(422, "wrong_location", "الموقع الممسوح لا يطابق موقع التجهيز", "Scanned location does not match the pick location");
  const itemId = await findItemId(c, scan.item);
  if (itemId !== t.item_id) throw new ApiError(422, "wrong_item", "الصنف الممسوح لا يطابق الصنف المطلوب", "Scanned item does not match the pick item");
  if (t.lot_id && scan.lot !== t.lot_no && scan.lot !== t.serial_no) {
    throw new ApiError(422, "wrong_lot", "الدفعة/الرقم التسلسلي لا يطابق المحجوز", "Batch / serial does not match the reserved one");
  }
  if (scan.qty <= 0 || scan.qty > Number(t.qty) + 1e-9) throw E.invalid([{ path: "qty", message: "invalid_qty" }]);
  const short = scan.qty < Number(t.qty) - 1e-9;
  await c.query("UPDATE pick_task SET qty_picked = $2, status = $3, picked_by = $4, picked_at = now() WHERE id = $1", [taskId, scan.qty, short ? "short" : "picked", actorId]);
  await c.query("UPDATE mr_line SET qty_picked = qty_picked + $2 WHERE id = $1", [t.mr_line_id, scan.qty]);
  await c.query("UPDATE pick_list SET status = 'in_progress' WHERE id = $1 AND status = 'open'", [t.pick_list_id]);
  const open = await one(c, "SELECT count(*)::int AS n FROM pick_task WHERE pick_list_id = $1 AND status = 'open'", [t.pick_list_id]);
  if (open.n === 0) {
    await c.query("UPDATE pick_list SET status = 'done', completed_at = now() WHERE id = $1", [t.pick_list_id]);
    const mr = await lockMr(c, t.mr_id);
    if (mr.status === "picking") {
      await c.query("UPDATE material_request SET status = 'ready_for_delivery' WHERE id = $1", [t.mr_id]);
      await docEvent(c, "MR", t.mr_id, "picked", { from: "picking", to: "ready_for_delivery", actorId });
      await notify(c, [mr.requester_id], { kind: "mr_ready", titleAr: `طلبك ${mr.mr_no} جاهز للاستلام`, titleEn: `Your request ${mr.mr_no} is ready for collection`,
        link: `/requests/${mr.id}`, docType: "MR", docId: mr.id });
    }
  }
  return { short };
}

/** Delivery with the receiver's e-signature: posts the goods issue (GI) for picked quantities. */
export async function deliver(c: Tx, actorId: string, id: string, b: { receivedByUserId?: string | null; receivedByName: string; signaturePng: string; deviceInfo?: string }) {
  const mr = await lockMr(c, id);
  assertStatus(mr, ["ready_for_delivery"], "deliver");
  await assertIssuer(c, mr, actorId);
  if (b.receivedByUserId) {
    const rc = await one(c, "SELECT org_unit_id FROM app_user WHERE id = $1 AND status = 'active'", [b.receivedByUserId]);
    if (!rc) throw E.invalid([{ path: "receivedByUserId", message: "unknown_user" }]);
    if (b.receivedByUserId !== mr.requester_id && rc.org_unit_id !== mr.org_unit_id) {
      throw new ApiError(422, "receiver_not_authorised", "المستلم يجب أن يكون مقدّم الطلب أو من نفس الإدارة", "Receiver must be the requester or from the same department");
    }
    if (b.receivedByUserId === actorId) throw E.sod("SoD-2", "لا يجوز أن يكون المستلم هو أمين المستودع نفسه", "The issuer cannot sign as the receiver");
  }
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(b.signaturePng ?? "");
  if (!m) throw E.invalid([{ path: "signaturePng", message: "png_data_url_required" }]);
  const png = Buffer.from(m[1], "base64");
  if (png.length < 200 || png.length > 500_000 || png.subarray(0, 4).toString("hex") !== "89504e47") throw E.invalid([{ path: "signaturePng", message: "invalid_signature" }]);

  const tasks = await many(c, `SELECT t.*, r.status AS res_status FROM pick_task t JOIN pick_list pl ON pl.id = t.pick_list_id
                               LEFT JOIN reservation r ON r.id = t.reservation_id
                               WHERE pl.mr_id = $1 AND t.status IN ('picked','short') AND t.qty_picked > t.qty_delivered ORDER BY t.seq`, [id]);
  if (!tasks.length) throw new ApiError(409, "nothing_to_deliver", "لا توجد كميات مجهزة للتسليم", "Nothing picked to deliver");
  const dnNo = await nextDocNo(c, "DN");
  const sigSha = sha256(png);
  const key = `delivery_note/${sigSha.slice(0, 2)}/${sigSha}-${Date.now()}.bin`;
  await mkdir(join(config.storageDir, "delivery_note", sigSha.slice(0, 2)), { recursive: true });
  await writeFile(join(config.storageDir, key), encryptBlob(png));
  const dn = await one(c, `INSERT INTO delivery_note (dn_no, mr_id, is_partial, issued_by, received_by_user_id, received_by_name, signature_sha256, device_info)
                           VALUES ($1,$2,false,$3,$4,$5,$6,$7) RETURNING *`,
    [dnNo, id, actorId, b.receivedByUserId ?? null, b.receivedByName, sigSha, (b.deviceInfo ?? "").slice(0, 300)]);
  const att = await one(c, `INSERT INTO attachment (owner_type, owner_id, category, file_name, mime_type, size_bytes, sha256, storage_key)
                            VALUES ('delivery_note',$1,'signature',$2,'image/png',$3,$4,$5) RETURNING id`, [dn.id, `${dnNo}-signature.png`, png.length, sigSha, key]);
  let total = 0;
  for (const t of tasks) {
    const qty = round4(Number(t.qty_picked) - Number(t.qty_delivered));
    const ledgerId = await post(c, { docType: "MR", docId: id, docNo: mr.mr_no, docLineId: t.mr_line_id, movement: "GI", itemId: t.item_id,
      locationId: t.location_id, lotId: t.lot_id, qty: -qty, reservationId: t.res_status === "active" ? t.reservation_id : null });
    const led = await one(c, "SELECT unit_cost, value FROM stock_ledger WHERE id = $1", [ledgerId]);
    const dl = await one(c, `INSERT INTO delivery_line (delivery_note_id, mr_line_id, pick_task_id, item_id, lot_id, location_id, qty, unit_cost, value, ledger_id)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [dn.id, t.mr_line_id, t.id, t.item_id, t.lot_id, t.location_id, qty, led.unit_cost, -led.value, ledgerId]);
    // custody requests: every delivered asset is registered against the requester
    if (mr.request_type === "custody") await issueCustody(c, { mr, deliveryLineId: dl.id, itemId: t.item_id, lotId: t.lot_id, qty, unitCost: Number(led.unit_cost) });
    await c.query("UPDATE pick_task SET qty_delivered = qty_delivered + $2, status = 'delivered' WHERE id = $1", [t.id, qty]);
    await c.query("UPDATE mr_line SET qty_issued = qty_issued + $2 WHERE id = $1", [t.mr_line_id, qty]);
    // short picks: give back what was reserved but not picked
    if (t.reservation_id) await release(c, t.reservation_id);
    total += -Number(led.value);
  }
  const rem = await one(c, `SELECT coalesce(sum(coalesce(qty_approved, qty_requested) - qty_issued), 0) AS q FROM mr_line WHERE mr_id = $1 AND deleted_at IS NULL`, [id]);
  const full = Number(rem.q) <= 1e-9;
  await c.query("UPDATE delivery_note SET is_partial = $2, total_value = $3, signature_attachment_id = $4 WHERE id = $1", [dn.id, !full, Math.round(total * 100) / 100, att.id]);
  await c.query(`UPDATE material_request SET status = $2, issued_value = issued_value + $3, delivered_at = now(),
                   closed_at = CASE WHEN $2 = 'closed' THEN now() END, is_overdue = CASE WHEN $2 = 'closed' THEN false ELSE is_overdue END WHERE id = $1`,
    [id, full ? "closed" : "partially_delivered", Math.round(total * 100) / 100]);
  if (mr.work_order_ref) {
    await enqueue(c, "cmms", "materials.issued", { type: "MR", id, no: mr.mr_no }, { mrNo: mr.mr_no, workOrderRef: mr.work_order_ref, dnNo, value: Math.round(total * 100) / 100,
      complete: full, lines: tasks.map((t) => ({ itemId: t.item_id, qty: round4(Number(t.qty_picked) - Number(t.qty_delivered)) })) });
  }
  await docEvent(c, "MR", id, full ? "delivered_full" : "delivered_partial", { from: "ready_for_delivery", to: full ? "delivered" : "partially_delivered", actorId,
    data: { dnNo, value: total } });
  if (full) await docEvent(c, "MR", id, "closed", { from: "delivered", to: "closed", actorId, comment: "journal entries are generated with valuation (phase 4)" });
  await notify(c, [mr.requester_id], { kind: "mr_delivered", titleAr: `تم تسليم ${full ? "" : "جزء من "}طلبك ${mr.mr_no}`, titleEn: `${full ? "" : "Part of "}your request ${mr.mr_no} was delivered`,
    link: `/requests/${id}`, docType: "MR", docId: id });
  return { dnNo, deliveryNoteId: dn.id, full, value: Math.round(total * 100) / 100 };
}

/** Closes a partially delivered request without delivering the rest (Warehouse Manager). */
export async function shortClose(c: Tx, actorId: string, id: string, reason: string) {
  const mr = await lockMr(c, id);
  assertStatus(mr, ["partially_delivered"], "short-close");
  for (const r of await many(c, "SELECT id FROM reservation WHERE source_type = 'MR' AND source_id = $1 AND status = 'active'", [id])) await release(c, r.id);
  await c.query("UPDATE pick_task t SET status = 'cancelled' FROM pick_list pl WHERE pl.id = t.pick_list_id AND pl.mr_id = $1 AND t.status = 'open'", [id]);
  await c.query("UPDATE material_request SET status = 'closed', closed_at = now(), status_reason = $2, is_overdue = false WHERE id = $1", [id, reason]);
  await docEvent(c, "MR", id, "short_closed", { from: "partially_delivered", to: "closed", actorId, comment: reason });
}

export async function cancel(c: Tx, actorId: string, id: string, reason: string, isManager: boolean) {
  const mr = await lockMr(c, id);
  assertStatus(mr, ["draft", "pending_approval", "approved", "reserved"], "cancel");
  if (mr.requester_id !== actorId && !isManager) throw E.forbidden("requester or warehouse manager");
  for (const r of await many(c, "SELECT id FROM reservation WHERE source_type = 'MR' AND source_id = $1 AND status = 'active'", [id])) await release(c, r.id);
  await c.query("UPDATE approval_task SET status = 'cancelled' WHERE doc_type = 'MR' AND doc_id = $1 AND status IN ('pending','waiting')", [id]);
  await c.query("UPDATE material_request SET status = 'cancelled', status_reason = $2, is_overdue = false WHERE id = $1", [id, reason]);
  await docEvent(c, "MR", id, "cancelled", { from: mr.status, to: "cancelled", actorId, comment: reason });
}

/**
 * SLA sweep (runs every minute): flags overdue requests and escalates stuck approvals to the
 * approver's manager (or the warehouse manager), notifying requester and approvers.
 */
export async function slaSweep(c: Tx) {
  const late = await many(c, `SELECT * FROM material_request WHERE NOT is_overdue AND sla_due_at < now()
                               AND status IN ('pending_approval','approved','reserved','picking','ready_for_delivery','partially_delivered') FOR UPDATE SKIP LOCKED`);
  for (const mr of late) {
    await c.query("UPDATE material_request SET is_overdue = true, escalated_at = now() WHERE id = $1", [mr.id]);
    await docEvent(c, "MR", mr.id, "overdue", { data: { slaDueAt: mr.sla_due_at, status: mr.status } });
    const wh = await one(c, "SELECT manager_user_id FROM warehouse WHERE id = $1", [mr.warehouse_id]);
    if (mr.status === "pending_approval") {
      const pending = await many(c, `SELECT t.*, u.manager_id FROM approval_task t JOIN app_user u ON u.id = t.assignee_id
                                     WHERE t.doc_type = 'MR' AND t.doc_id = $1 AND t.revision = $2 AND t.status = 'pending' AND NOT t.is_escalation`, [mr.id, mr.revision]);
      for (const t of pending) {
        const target = [t.manager_id, wh?.manager_user_id].find((u) => u && u !== mr.requester_id && u !== t.assignee_id);
        if (!target) continue;
        await c.query(`INSERT INTO approval_task (doc_type, doc_id, revision, level, rule_id, assignee_id, status, due_at, is_escalation)
                       VALUES ('MR',$1,$2,$3,$4,$5,'pending', now() + interval '8 hours', true)`, [mr.id, mr.revision, t.level, t.rule_id, target]);
        await notify(c, [target], { kind: "escalation", titleAr: `تصعيد: طلب متأخر ${mr.mr_no}`, titleEn: `Escalation: overdue request ${mr.mr_no}`,
          link: `/requests/${mr.id}`, docType: "MR", docId: mr.id });
      }
    }
    await notify(c, [mr.requester_id, wh?.manager_user_id], { kind: "overdue", titleAr: `تجاوز الطلب ${mr.mr_no} مدة الخدمة`, titleEn: `Request ${mr.mr_no} breached its SLA`,
      link: `/requests/${mr.id}`, docType: "MR", docId: mr.id });
  }
  return late.length;
}
