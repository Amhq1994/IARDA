// Transfers, returns, quarantine, RTV, counting, adjustments, disposals, unified approvals inbox, ABC classification.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, one, many, withTx } from "../db/pool.ts";
import { E } from "../lib/errors.ts";
import { parse, uuid, idParam } from "../lib/http.ts";
import { requirePerm, requireAuth, txCtx, warehouseScope, assertWarehouseInScope, can, type AuthUser } from "../auth/context.ts";
import type { Permission } from "@iarda/shared";
import * as tr from "../services/transfers.ts";
import * as rt from "../services/returns.ts";
import * as cnt from "../services/counting.ts";
import { decideDoc, DOC_TABLE } from "../services/approvals.ts";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** SQL filter for documents in the user's warehouse scope (any of the given permissions). */
function whFilter(u: AuthUser, perms: Permission[], cols: string[], p: unknown[]): string {
  for (const perm of perms) {
    if (!u.permissions.has(perm)) continue;
    const s = warehouseScope(u, perm);
    if (s === "all") return "true";
    p.push(s);
    return `(${cols.map((c) => `${c} = ANY($${p.length})`).join(" OR ")})`;
  }
  return "false";
}

async function events(docType: string, id: string) {
  return many(pool, `SELECT e.*, u.name_ar AS actor_ar, u.name_en AS actor_en FROM doc_event e LEFT JOIN app_user u ON u.id = e.actor_id
                     WHERE e.doc_type = $1 AND e.doc_id = $2 ORDER BY e.id`, [docType, id]);
}
async function approvals(docType: string, id: string) {
  return many(pool, `SELECT t.*, a.name_ar AS assignee_ar, a.name_en AS assignee_en, o.name_ar AS original_ar, o.name_en AS original_en
                       FROM approval_task t JOIN app_user a ON a.id = t.assignee_id LEFT JOIN app_user o ON o.id = t.original_assignee_id
                      WHERE t.doc_type = $1 AND t.doc_id = $2 ORDER BY t.revision, t.level, t.created_at`, [docType, id]);
}

export async function phase3Routes(app: FastifyInstance) {
  // ================================================================ approvals inbox (all document types)
  app.get("/api/approvals/inbox", { preHandler: requireAuth, schema: { tags: ["approvals"] } }, async (req) => ({
    data: await many(pool, `SELECT t.id, t.doc_type, t.doc_id, t.level, t.due_at, t.is_escalation, t.original_assignee_id, t.created_at,
        coalesce(m.mr_no, tr.tr_no, a.adj_no, d.dsp_no, r.ret_no) AS doc_no,
        coalesce(m.estimated_value, tr.estimated_value, a.value_abs, d.total_value, r.estimated_value) AS value
      FROM approval_task t
      LEFT JOIN material_request m ON t.doc_type = 'MR' AND m.id = t.doc_id
      LEFT JOIN transfer_order tr ON t.doc_type = 'TR' AND tr.id = t.doc_id
      LEFT JOIN adjustment a ON t.doc_type = 'ADJ' AND a.id = t.doc_id
      LEFT JOIN disposal d ON t.doc_type = 'DSP' AND d.id = t.doc_id
      LEFT JOIN return_doc r ON t.doc_type = 'RTV' AND r.id = t.doc_id
      WHERE t.assignee_id = $1 AND t.status = 'pending' ORDER BY t.is_escalation DESC, t.due_at NULLS LAST`, [req.user!.id]),
  }));

  app.post("/api/approvals/:docType/:id/decision", { preHandler: requireAuth, schema: { tags: ["approvals"], summary: "Approve / reject / return a TR, ADJ, DSP or RTV" } }, async (req) => {
    const { docType, id } = parse(z.object({ docType: z.enum(["TR", "ADJ", "DSP", "RTV"]), id: uuid }), req.params);
    const b = parse(z.object({ action: z.enum(["approve", "reject", "return"]), comment: z.string().max(1000).optional() }), req.body);
    return withTx(txCtx(req), (c) =>
      docType === "ADJ" ? cnt.decideAdjustment(c, req.user!.id, id, b.action, b.comment)
        : docType === "DSP" ? cnt.decideDisposal(c, req.user!.id, id, b.action, b.comment)
        : decideDoc(c, req.user!.id, docType, id, b.action, b.comment));
  });

  // ================================================================ bin-to-bin moves
  app.post("/api/moves", { preHandler: requirePerm("transfer.bin"), schema: { tags: ["transfers"], summary: "Move stock between bins (scan both)" } }, async (req) => {
    const b = parse(z.object({ from: z.string().trim().min(1), to: z.string().trim().min(1), item: z.string().trim().min(1), lot: z.string().trim().nullable().optional(),
      qty: z.number().positive() }), req.body);
    return withTx(txCtx(req), (c) => tr.moveBin(c, req.user!.id, { ...b, warehouseScope: warehouseScope(req.user!, "transfer.bin") }));
  });

  // ================================================================ inter-warehouse transfers
  const trPerms: Permission[] = ["transfer.request", "transfer.approve", "issue.execute", "receipt.execute", "audit.read"];
  app.get("/api/transfers", { preHandler: requirePerm(...trPerms), schema: { tags: ["transfers"] } }, async (req) => {
    const p: unknown[] = [];
    const scope = whFilter(req.user!, trPerms, ["t.from_warehouse_id", "t.to_warehouse_id"], p);
    p.push(req.user!.id);
    return { data: await many(pool, `SELECT t.*, f.code AS from_code, f.name_ar AS from_ar, f.name_en AS from_en, w.code AS to_code, w.name_ar AS to_ar, w.name_en AS to_en,
        u.name_ar AS requester_ar, u.name_en AS requester_en, (SELECT count(*)::int FROM transfer_line l WHERE l.transfer_id = t.id) AS lines
      FROM transfer_order t JOIN warehouse f ON f.id = t.from_warehouse_id JOIN warehouse w ON w.id = t.to_warehouse_id JOIN app_user u ON u.id = t.requested_by
      WHERE ${scope} OR t.requested_by = $${p.length} ORDER BY t.updated_at DESC LIMIT 200`, p) };
  });
  app.get("/api/transfers/:id", { preHandler: requirePerm(...trPerms), schema: { tags: ["transfers"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const t = await one(pool, `SELECT t.*, f.code AS from_code, f.name_ar AS from_ar, f.name_en AS from_en, w.code AS to_code, w.name_ar AS to_ar, w.name_en AS to_en,
        u.name_ar AS requester_ar, u.name_en AS requester_en FROM transfer_order t JOIN warehouse f ON f.id = t.from_warehouse_id JOIN warehouse w ON w.id = t.to_warehouse_id
        JOIN app_user u ON u.id = t.requested_by WHERE t.id = $1`, [id]);
    if (!t) throw E.notFound("transfer");
    const u = req.user!;
    const inScope = (perm: Permission, wh: string) => u.permissions.has(perm) && (warehouseScope(u, perm) === "all" || (warehouseScope(u, perm) as string[]).includes(wh));
    if (t.requested_by !== u.id && !trPerms.some((pp) => inScope(pp, t.from_warehouse_id) || inScope(pp, t.to_warehouse_id))) throw E.outOfScope();
    const [lines, shipments, ev, ap] = await Promise.all([
      many(pool, `SELECT l.*, i.item_code, i.name_ar, i.name_en, u.code AS uom_code FROM transfer_line l JOIN item i ON i.id = l.item_id JOIN uom u ON u.id = i.base_uom_id
                   WHERE l.transfer_id = $1 ORDER BY l.line_no`, [id]),
      many(pool, `SELECT s.*, i.item_code, f.full_code AS from_code, d.full_code AS transit_code, sl.lot_no, sl.serial_no FROM transfer_shipment s JOIN transfer_line l ON l.id = s.transfer_line_id
                   JOIN item i ON i.id = s.item_id JOIN location f ON f.id = s.from_location_id JOIN location d ON d.id = s.transit_location_id LEFT JOIN stock_lot sl ON sl.id = s.lot_id
                   WHERE l.transfer_id = $1 ORDER BY i.item_code`, [id]),
      events("TR", id), approvals("TR", id)]);
    const approverIds = ap.filter((a) => a.status === "approved").map((a) => a.acted_by);
    return { ...t, lines, shipments, events: ev, approvals: ap, actions: {
      submit: t.status === "draft" && t.requested_by === u.id,
      decide: ap.some((a) => a.status === "pending" && a.assignee_id === u.id && a.revision === t.revision),
      ship: t.status === "approved" && inScope("issue.execute", t.from_warehouse_id) && !approverIds.includes(u.id),
      receive: t.status === "in_transit" && inScope("receipt.execute", t.to_warehouse_id) && t.shipped_by !== u.id,
    } };
  });
  app.post("/api/transfers", { preHandler: requirePerm("transfer.request"), schema: { tags: ["transfers"] } }, async (req, rep) => {
    const b = parse(z.object({ fromWarehouseId: uuid, toWarehouseId: uuid, reason: z.string().max(500).optional(), neededBy: dateStr.nullable().optional(),
      lines: z.array(z.object({ itemId: uuid, qty: z.number().positive() })).min(1).max(100) }), req.body);
    const s = warehouseScope(req.user!, "transfer.request");
    if (s !== "all" && !s.includes(b.fromWarehouseId) && !s.includes(b.toWarehouseId)) throw E.outOfScope();
    const out = await withTx(txCtx(req), (c) => tr.createTransfer(c, req.user!.id, b));
    rep.status(201); return out;
  });
  app.post("/api/transfers/:id/submit", { preHandler: requirePerm("transfer.request"), schema: { tags: ["transfers"] } }, async (req) =>
    withTx(txCtx(req), (c) => tr.submitTransfer(c, req.user!.id, parse(idParam, req.params).id)));
  app.post("/api/transfers/:id/ship", { preHandler: requirePerm("issue.execute"), schema: { tags: ["transfers"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const t = await one(pool, "SELECT from_warehouse_id FROM transfer_order WHERE id = $1", [id]);
    if (!t) throw E.notFound("transfer");
    assertWarehouseInScope(req.user!, "issue.execute", t.from_warehouse_id);
    await withTx(txCtx(req), (c) => tr.shipTransfer(c, req.user!.id, id));
    return { ok: true };
  });
  app.post("/api/transfers/:id/receive", { preHandler: requirePerm("receipt.execute"), schema: { tags: ["transfers"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ lines: z.array(z.object({ shipmentId: uuid, qty: z.number().min(0) })).optional() }), req.body ?? {});
    const t = await one(pool, "SELECT to_warehouse_id FROM transfer_order WHERE id = $1", [id]);
    if (!t) throw E.notFound("transfer");
    assertWarehouseInScope(req.user!, "receipt.execute", t.to_warehouse_id);
    return withTx(txCtx(req), (c) => tr.receiveTransfer(c, req.user!.id, id, b.lines));
  });

  // ================================================================ returns (to warehouse / to vendor) & quarantine
  const retPerms: Permission[] = ["return.warehouse", "return.vendor", "return.vendor.approve", "issue.execute", "audit.read"];
  app.get("/api/returns", { preHandler: requirePerm(...retPerms), schema: { tags: ["returns"] } }, async (req) => {
    const u = req.user!;
    const p: unknown[] = [];
    const scope = whFilter(u, ["issue.execute", "return.vendor", "return.vendor.approve", "audit.read"], ["r.warehouse_id"], p);
    p.push(u.id);
    return { data: await many(pool, `SELECT r.*, w.code AS warehouse_code, s.name_ar AS supplier_ar, s.name_en AS supplier_en, u.name_ar AS returned_by_ar, u.name_en AS returned_by_en,
        (SELECT count(*)::int FROM return_line l WHERE l.return_id = r.id) AS lines
      FROM return_doc r JOIN warehouse w ON w.id = r.warehouse_id LEFT JOIN supplier s ON s.id = r.supplier_id LEFT JOIN app_user u ON u.id = r.returned_by
      WHERE ${scope} OR r.returned_by = $${p.length} OR r.created_by = $${p.length} ORDER BY r.updated_at DESC LIMIT 200`, p) };
  });
  app.get("/api/returns/:id", { preHandler: requirePerm(...retPerms), schema: { tags: ["returns"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await one(pool, `SELECT r.*, w.code AS warehouse_code, w.name_ar AS warehouse_ar, w.name_en AS warehouse_en, s.name_ar AS supplier_ar, s.name_en AS supplier_en,
        m.mr_no FROM return_doc r JOIN warehouse w ON w.id = r.warehouse_id LEFT JOIN supplier s ON s.id = r.supplier_id LEFT JOIN material_request m ON m.id = r.mr_id WHERE r.id = $1`, [id]);
    if (!r) throw E.notFound("return");
    const u = req.user!;
    const mine = r.returned_by === u.id || r.created_by === u.id;
    if (!mine) assertWarehouseInScope(u, (["issue.execute", "return.vendor", "return.vendor.approve", "audit.read"] as Permission[]).find((x) => u.permissions.has(x)) ?? "issue.execute", r.warehouse_id);
    const dt = r.return_type === "to_vendor" ? "RTV" : "RET";
    const [lines, ev, ap] = await Promise.all([
      many(pool, `SELECT l.*, i.item_code, i.name_ar, i.name_en, u.code AS uom_code, f.full_code AS from_code, t.full_code AS to_code, sl.lot_no AS stock_lot_no, sl.serial_no AS stock_serial_no
                   FROM return_line l JOIN item i ON i.id = l.item_id JOIN uom u ON u.id = i.base_uom_id LEFT JOIN location f ON f.id = l.from_location_id
                   LEFT JOIN location t ON t.id = l.to_location_id LEFT JOIN stock_lot sl ON sl.id = l.lot_id WHERE l.return_id = $1 ORDER BY l.line_no`, [id]),
      events(dt, id), approvals(dt, id)]);
    const keeper = can(u, "issue.execute") && (warehouseScope(u, "issue.execute") === "all" || (warehouseScope(u, "issue.execute") as string[]).includes(r.warehouse_id));
    const approverIds = ap.filter((a) => a.status === "approved").map((a) => a.acted_by);
    return { ...r, lines, events: ev, approvals: ap, actions: {
      receive: r.return_type === "to_warehouse" && r.status === "draft" && keeper,
      submit: r.return_type === "to_vendor" && r.status === "draft" && r.created_by === u.id,
      decide: ap.some((a) => a.status === "pending" && a.assignee_id === u.id && a.revision === r.revision),
      ship: r.return_type === "to_vendor" && r.status === "approved" && keeper && !approverIds.includes(u.id),
      creditNote: r.return_type === "to_vendor" && r.status === "shipped" && can(u, "return.vendor"),
    } };
  });
  app.post("/api/returns", { preHandler: requirePerm("return.warehouse"), schema: { tags: ["returns"], summary: "Return to warehouse" } }, async (req, rep) => {
    const b = parse(z.object({ warehouseId: uuid, reason: z.string().trim().min(3).max(500), mrId: uuid.nullable().optional(),
      lines: z.array(z.object({ itemId: uuid, qty: z.number().positive(), lotNo: z.string().max(60).nullable().optional(), serialNo: z.string().max(60).nullable().optional(),
        condition: z.enum(["good", "quarantine", "damaged"]).optional(), notes: z.string().max(300).nullable().optional() })).min(1).max(50) }), req.body);
    const out = await withTx(txCtx(req), (c) => rt.createReturn(c, { id: req.user!.id, orgUnitId: req.user!.orgUnitId }, b));
    rep.status(201); return out;
  });
  app.post("/api/returns/:id/receive", { preHandler: requirePerm("issue.execute"), schema: { tags: ["returns"], summary: "Inspect & book returned goods by condition" } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await one(pool, "SELECT warehouse_id FROM return_doc WHERE id = $1", [id]);
    if (!r) throw E.notFound("return");
    assertWarehouseInScope(req.user!, "issue.execute", r.warehouse_id);
    const b = parse(z.object({ lines: z.array(z.object({ lineId: uuid, condition: z.enum(["good", "quarantine", "damaged"]) })).default([]) }), req.body ?? {});
    await withTx(txCtx(req), (c) => rt.receiveReturn(c, req.user!.id, id, b.lines));
    return { ok: true };
  });
  app.post("/api/rtv", { preHandler: requirePerm("return.vendor"), schema: { tags: ["returns"], summary: "Return to vendor (from quarantine/damaged/available stock)" } }, async (req, rep) => {
    const b = parse(z.object({ warehouseId: uuid, supplierId: uuid, reason: z.string().trim().min(3).max(500), receiptId: uuid.nullable().optional(),
      lines: z.array(z.object({ balanceId: uuid, qty: z.number().positive() })).min(1) }), req.body);
    assertWarehouseInScope(req.user!, "return.vendor", b.warehouseId);
    const out = await withTx(txCtx(req), (c) => rt.createRtv(c, req.user!.id, b));
    rep.status(201); return out;
  });
  app.post("/api/rtv/:id/submit", { preHandler: requirePerm("return.vendor"), schema: { tags: ["returns"] } }, async (req) =>
    withTx(txCtx(req), (c) => rt.submitRtv(c, req.user!.id, parse(idParam, req.params).id)));
  app.post("/api/rtv/:id/ship", { preHandler: requirePerm("issue.execute"), schema: { tags: ["returns"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await one(pool, "SELECT warehouse_id FROM return_doc WHERE id = $1", [id]);
    if (!r) throw E.notFound("return");
    assertWarehouseInScope(req.user!, "issue.execute", r.warehouse_id);
    await withTx(txCtx(req), (c) => rt.shipRtv(c, req.user!.id, id));
    return { ok: true };
  });
  app.post("/api/rtv/:id/credit-note", { preHandler: requirePerm("return.vendor"), schema: { tags: ["returns"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ creditNoteRef: z.string().trim().min(2).max(60) }), req.body);
    await withTx(txCtx(req), (c) => rt.closeRtv(c, req.user!.id, id, b.creditNoteRef));
    return { ok: true };
  });

  app.get("/api/quarantine", { preHandler: requirePerm("warehouse.read"), schema: { tags: ["returns"], summary: "Quarantined & damaged stock" } }, async (req) => {
    const p: unknown[] = [];
    const scope = whFilter(req.user!, ["warehouse.read"], ["b.warehouse_id"], p);
    return { data: await many(pool, `SELECT b.*, b.qty_on_hand - b.qty_reserved AS qty_free, i.item_code, i.name_ar, i.name_en, l.full_code, w.code AS warehouse_code,
        sl.lot_no, sl.serial_no, sl.expiry_date, v.avg_cost
      FROM stock_balance b JOIN item i ON i.id = b.item_id JOIN location l ON l.id = b.location_id JOIN warehouse w ON w.id = b.warehouse_id
      LEFT JOIN stock_lot sl ON sl.id = b.lot_id LEFT JOIN item_valuation v ON v.item_id = b.item_id AND v.warehouse_id = b.warehouse_id
      WHERE b.qty_on_hand > 0 AND (b.stock_status IN ('quarantine','damaged') OR sl.expiry_date <= current_date) AND ${scope}
      ORDER BY b.stock_status, w.code, i.item_code`, p) };
  });
  app.post("/api/quarantine/:id/status", { preHandler: requirePerm("adjustment.approve"), schema: { tags: ["returns"], summary: "Release quarantine to available, or move to damaged" } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ to: z.enum(["available", "damaged"]), qty: z.number().positive(), reason: z.string().trim().min(3).max(300) }), req.body);
    const bal = await one(pool, "SELECT warehouse_id FROM stock_balance WHERE id = $1", [id]);
    if (!bal) throw E.notFound("stock");
    assertWarehouseInScope(req.user!, "adjustment.approve", bal.warehouse_id);
    await withTx(txCtx(req), (c) => rt.changeStatus(c, req.user!.id, id, b.qty, b.to, b.reason));
    return { ok: true };
  });

  // ================================================================ counting
  const cntPerms: Permission[] = ["count.plan", "count.execute", "count.review", "audit.read"];
  app.get("/api/counts", { preHandler: requirePerm(...cntPerms), schema: { tags: ["counting"] } }, async (req) => {
    const u = req.user!;
    const p: unknown[] = [];
    const scope = whFilter(u, ["count.plan", "count.review", "audit.read"], ["c.warehouse_id"], p);
    p.push(u.id);
    return { data: await many(pool, `SELECT c.*, w.code AS warehouse_code, w.name_ar AS warehouse_ar, w.name_en AS warehouse_en,
        (SELECT count(*)::int FROM count_line l WHERE l.plan_id = c.id) AS lines,
        (SELECT count(*)::int FROM count_line l WHERE l.plan_id = c.id AND l.status IN ('counted','final')) AS counted,
        (SELECT count(*)::int FROM count_line l WHERE l.plan_id = c.id AND l.status = 'recount') AS recount
      FROM count_plan c JOIN warehouse w ON w.id = c.warehouse_id WHERE ${scope} OR $${p.length} = ANY(c.counter_ids) ORDER BY c.created_at DESC LIMIT 200`, p) };
  });
  app.get("/api/counts/:id", { preHandler: requirePerm(...cntPerms), schema: { tags: ["counting"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const u = req.user!;
    const pl = await one(pool, `SELECT c.*, w.code AS warehouse_code, w.name_ar AS warehouse_ar, w.name_en AS warehouse_en FROM count_plan c JOIN warehouse w ON w.id = c.warehouse_id WHERE c.id = $1`, [id]);
    if (!pl) throw E.notFound("count plan");
    const isCounter = pl.counter_ids.includes(u.id);
    if (!isCounter) assertWarehouseInScope(u, (["count.plan", "count.review", "audit.read"] as Permission[]).find((x) => u.permissions.has(x)) ?? "count.plan", pl.warehouse_id);
    // blind counts: counters never see expected quantities while counting
    const hide = pl.blind && pl.status === "counting" && !can(u, "count.plan") && !(can(u, "count.review") && !isCounter);
    const lines = await many(pool, `SELECT l.*, i.item_code, i.name_ar, i.name_en, i.abc_class, u.code AS uom_code, loc.full_code, loc.barcode AS location_barcode,
        sl.lot_no, sl.serial_no, sl.expiry_date, c1.name_ar AS c1_ar, c1.name_en AS c1_en, c2.name_ar AS c2_ar, c2.name_en AS c2_en
      FROM count_line l JOIN item i ON i.id = l.item_id JOIN uom u ON u.id = i.base_uom_id JOIN location loc ON loc.id = l.location_id
      LEFT JOIN stock_lot sl ON sl.id = l.lot_id LEFT JOIN app_user c1 ON c1.id = l.counted1_by LEFT JOIN app_user c2 ON c2.id = l.counted2_by
      WHERE l.plan_id = $1 ORDER BY loc.pick_sequence, loc.full_code, i.item_code`, [id]);
    const counters = await many(pool, "SELECT id, name_ar, name_en FROM app_user WHERE id = ANY($1)", [pl.counter_ids]);
    const adj = await one(pool, "SELECT id, adj_no, status, value_abs, value_net FROM adjustment WHERE count_plan_id = $1 ORDER BY created_at DESC LIMIT 1", [id]);
    return { ...pl, counters, adjustment: adj, blindHidden: hide, events: await events("CNT", id),
      // blind: counters see neither book quantities nor a colleague's count (independent recount)
      lines: hide ? lines.map(({ qty_snapshot, qty_system1, qty_system2, qty_count1, qty_count2, final_qty, variance_qty, variance_value, unit_cost, within_tolerance, ...l }) => l) : lines,
      actions: { release: pl.status === "draft" && can(u, "count.plan"), count: pl.status === "counting" && isCounter, finish: pl.status === "counting" && can(u, "count.review") } };
  });
  app.post("/api/counts", { preHandler: requirePerm("count.plan"), schema: { tags: ["counting"], summary: "Create count plan (annual / cycle / surprise)" } }, async (req, rep) => {
    const b = parse(z.object({ warehouseId: uuid, countType: z.enum(["annual", "cycle", "surprise"]), blind: z.boolean().optional(), abcClasses: z.array(z.enum(["A", "B", "C"])).nullable().optional(),
      zoneIds: z.array(uuid).nullable().optional(), itemIds: z.array(uuid).nullable().optional(), sampleSize: z.number().int().min(1).max(500).nullable().optional(),
      counterIds: z.array(uuid).min(1).max(20), scheduledFor: dateStr.optional(), notes: z.string().max(500).optional() }), req.body);
    assertWarehouseInScope(req.user!, "count.plan", b.warehouseId);
    const out = await withTx(txCtx(req), (c) => cnt.createPlan(c, req.user!.id, b));
    rep.status(201); return out;
  });
  app.post("/api/counts/:id/release", { preHandler: requirePerm("count.plan"), schema: { tags: ["counting"] } }, async (req) =>
    withTx(txCtx(req), (c) => cnt.releasePlan(c, req.user!.id, parse(idParam, req.params).id)));
  app.post("/api/count-lines/:id", { preHandler: requirePerm("count.execute"), schema: { tags: ["counting"], summary: "Enter a count (blind)" } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ qty: z.number().min(0), reason: z.string().max(300).optional() }), req.body);
    return withTx(txCtx(req), (c) => cnt.recordCount(c, req.user!.id, id, b.qty, b.reason));
  });
  app.post("/api/counts/:id/unplanned", { preHandler: requirePerm("count.execute"), schema: { tags: ["counting"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ location: z.string().min(1), item: z.string().min(1), lot: z.string().nullable().optional(), qty: z.number().min(0) }), req.body);
    return withTx(txCtx(req), (c) => cnt.addUnplanned(c, req.user!.id, id, b));
  });
  app.post("/api/counts/:id/finish", { preHandler: requirePerm("count.review"), schema: { tags: ["counting"], summary: "Review: variances → adjustment (DoA)" } }, async (req) =>
    withTx(txCtx(req), (c) => cnt.finishCount(c, req.user!.id, parse(idParam, req.params).id)));

  // ================================================================ adjustments
  const adjPerms: Permission[] = ["adjustment.request", "adjustment.approve", "count.review", "valuation.manage", "audit.read"];
  app.get("/api/adjustments", { preHandler: requirePerm(...adjPerms), schema: { tags: ["counting"] } }, async (req) => {
    const p: unknown[] = [];
    const scope = whFilter(req.user!, adjPerms, ["a.warehouse_id"], p);
    return { data: await many(pool, `SELECT a.*, w.code AS warehouse_code, (SELECT count(*)::int FROM adjustment_line l WHERE l.adjustment_id = a.id) AS lines,
        cp.plan_no, t.tr_no FROM adjustment a JOIN warehouse w ON w.id = a.warehouse_id LEFT JOIN count_plan cp ON cp.id = a.count_plan_id LEFT JOIN transfer_order t ON t.id = a.transfer_id
      WHERE ${scope} ORDER BY a.updated_at DESC LIMIT 200`, p) };
  });
  app.get("/api/adjustments/:id", { preHandler: requireAuth, schema: { tags: ["counting"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const a = await one(pool, `SELECT a.*, w.code AS warehouse_code, w.name_ar AS warehouse_ar, w.name_en AS warehouse_en, cp.plan_no, t.tr_no, cb.name_ar AS created_by_ar, cb.name_en AS created_by_en
      FROM adjustment a JOIN warehouse w ON w.id = a.warehouse_id LEFT JOIN count_plan cp ON cp.id = a.count_plan_id LEFT JOIN transfer_order t ON t.id = a.transfer_id
      LEFT JOIN app_user cb ON cb.id = a.created_by WHERE a.id = $1`, [id]);
    if (!a) throw E.notFound("adjustment");
    const ap = await approvals("ADJ", id);
    const u = req.user!;
    const assigned = ap.some((x) => x.assignee_id === u.id);
    if (!assigned) assertWarehouseInScope(u, adjPerms.find((x) => u.permissions.has(x)) ?? "adjustment.request", a.warehouse_id);
    const lines = await many(pool, `SELECT l.*, i.item_code, i.name_ar, i.name_en, u.code AS uom_code, loc.full_code, sl.lot_no, sl.serial_no
      FROM adjustment_line l JOIN item i ON i.id = l.item_id JOIN uom u ON u.id = i.base_uom_id JOIN location loc ON loc.id = l.location_id LEFT JOIN stock_lot sl ON sl.id = l.lot_id
      WHERE l.adjustment_id = $1 ORDER BY i.item_code`, [id]);
    return { ...a, lines, approvals: ap, events: await events("ADJ", id), actions: {
      submit: a.status === "draft" && can(u, "adjustment.request"),
      decide: ap.some((x) => x.status === "pending" && x.assignee_id === u.id && x.revision === a.revision),
      post: a.status === "approved" && can(u, "adjustment.request") && a.created_by !== u.id && !ap.some((x) => x.status === "approved" && x.acted_by === u.id),
    } };
  });
  app.post("/api/adjustments", { preHandler: requirePerm("adjustment.request"), schema: { tags: ["counting"], summary: "Manual adjustment request" } }, async (req, rep) => {
    const b = parse(z.object({ warehouseId: uuid, reason: z.string().trim().min(3).max(500),
      lines: z.array(z.object({ locationId: uuid, itemId: uuid, lotId: uuid.nullable().optional(), stockStatus: z.enum(["available", "quarantine", "damaged"]).optional(),
        qtyDelta: z.number().refine((v) => v !== 0, "non_zero"), reason: z.string().max(300).optional() })).min(1).max(100) }), req.body);
    assertWarehouseInScope(req.user!, "adjustment.request", b.warehouseId);
    const out = await withTx(txCtx(req), (c) => cnt.createAdjustment(c, req.user!.id, b));
    rep.status(201); return out;
  });
  app.post("/api/adjustments/:id/submit", { preHandler: requirePerm("adjustment.request"), schema: { tags: ["counting"] } }, async (req) =>
    withTx(txCtx(req), (c) => cnt.submitAdjustment(c, req.user!.id, parse(idParam, req.params).id)));
  app.post("/api/adjustments/:id/post", { preHandler: requirePerm("adjustment.request"), schema: { tags: ["counting"], summary: "Post approved adjustment (SoD-3)" } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const a = await one(pool, "SELECT warehouse_id FROM adjustment WHERE id = $1", [id]);
    if (!a) throw E.notFound("adjustment");
    assertWarehouseInScope(req.user!, "adjustment.request", a.warehouse_id);
    await withTx(txCtx(req), (c) => cnt.postAdjustment(c, req.user!.id, id));
    return { ok: true };
  });

  // ================================================================ disposals
  const dspPerms: Permission[] = ["disposal.recommend", "disposal.approve", "adjustment.request", "audit.read"];
  app.get("/api/disposals", { preHandler: requirePerm(...dspPerms), schema: { tags: ["counting"] } }, async (req) => {
    const p: unknown[] = [];
    const scope = whFilter(req.user!, dspPerms, ["d.warehouse_id"], p);
    return { data: await many(pool, `SELECT d.*, w.code AS warehouse_code, (SELECT count(*)::int FROM disposal_line l WHERE l.disposal_id = d.id) AS lines
      FROM disposal d JOIN warehouse w ON w.id = d.warehouse_id WHERE ${scope} ORDER BY d.updated_at DESC LIMIT 200`, p) };
  });
  app.get("/api/disposals/:id", { preHandler: requireAuth, schema: { tags: ["counting"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const d = await one(pool, `SELECT d.*, w.code AS warehouse_code, w.name_ar AS warehouse_ar, w.name_en AS warehouse_en FROM disposal d JOIN warehouse w ON w.id = d.warehouse_id WHERE d.id = $1`, [id]);
    if (!d) throw E.notFound("disposal");
    const ap = await approvals("DSP", id);
    const u = req.user!;
    if (!ap.some((x) => x.assignee_id === u.id) && !d.committee_ids.includes(u.id)) assertWarehouseInScope(u, dspPerms.find((x) => u.permissions.has(x)) ?? "disposal.recommend", d.warehouse_id);
    const [lines, committee, files] = await Promise.all([
      many(pool, `SELECT l.*, i.item_code, i.name_ar, i.name_en, u.code AS uom_code, loc.full_code, sl.lot_no, sl.serial_no, sl.expiry_date
        FROM disposal_line l JOIN item i ON i.id = l.item_id JOIN uom u ON u.id = i.base_uom_id JOIN location loc ON loc.id = l.location_id LEFT JOIN stock_lot sl ON sl.id = l.lot_id
        WHERE l.disposal_id = $1 ORDER BY i.item_code`, [id]),
      many(pool, "SELECT id, name_ar, name_en FROM app_user WHERE id = ANY($1)", [d.committee_ids]),
      many(pool, "SELECT id, category, file_name, created_at FROM attachment WHERE owner_type = 'disposal' AND owner_id = $1 AND deleted_at IS NULL", [id])]);
    const approverIds = ap.filter((x) => x.status === "approved").map((x) => x.acted_by);
    return { ...d, lines, committee, attachments: files, approvals: ap, events: await events("DSP", id), actions: {
      recommend: d.status === "draft" && d.committee_ids.includes(u.id),
      decide: ap.some((x) => x.status === "pending" && x.assignee_id === u.id && x.revision === d.revision),
      post: d.status === "approved" && can(u, "adjustment.request") && !d.committee_ids.includes(u.id) && !approverIds.includes(u.id),
    } };
  });
  app.post("/api/disposals", { preHandler: requirePerm("disposal.recommend"), schema: { tags: ["counting"], summary: "Committee drafts a write-off / disposal" } }, async (req, rep) => {
    const b = parse(z.object({ warehouseId: uuid, method: z.enum(["scrap", "sell", "donate", "recycle"]), reason: z.string().trim().min(3).max(500),
      committeeIds: z.array(uuid).min(1).max(7), lines: z.array(z.object({ balanceId: uuid, qty: z.number().positive() })).min(1).max(100) }), req.body);
    const out = await withTx(txCtx(req), (c) => cnt.createDisposal(c, req.user!.id, b));
    rep.status(201); return out;
  });
  app.post("/api/disposals/:id/recommend", { preHandler: requirePerm("disposal.recommend"), schema: { tags: ["counting"] } }, async (req) =>
    withTx(txCtx(req), (c) => cnt.recommendDisposal(c, req.user!.id, parse(idParam, req.params).id)));
  app.post("/api/disposals/:id/post", { preHandler: requirePerm("adjustment.request"), schema: { tags: ["counting"], summary: "Post approved write-off (SoD-5)" } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const d = await one(pool, "SELECT warehouse_id FROM disposal WHERE id = $1", [id]);
    if (!d) throw E.notFound("disposal");
    assertWarehouseInScope(req.user!, "adjustment.request", d.warehouse_id);
    await withTx(txCtx(req), (c) => cnt.postDisposal(c, req.user!.id, id));
    return { ok: true };
  });

  // ================================================================ pickers for forms
  app.get("/api/counters", { preHandler: requirePerm("count.plan"), schema: { tags: ["counting"], summary: "Users who may count in a warehouse" } }, async (req) => {
    const { warehouseId } = parse(z.object({ warehouseId: uuid }), req.query);
    return { data: await many(pool, `SELECT DISTINCT u.id, u.name_ar, u.name_en, r.code AS role FROM app_user u JOIN user_role ur ON ur.user_id = u.id AND ur.is_active
        JOIN role r ON r.id = ur.role_id JOIN role_permission rp ON rp.role_id = r.id AND rp.permission_key = 'count.execute' AND rp.is_granted
       WHERE u.status = 'active' AND u.deleted_at IS NULL AND (ur.warehouse_ids IS NULL OR $1 = ANY(ur.warehouse_ids)) ORDER BY r.code, u.name_ar`, [warehouseId]) };
  });
  app.get("/api/disposal-committee", { preHandler: requirePerm("disposal.recommend"), schema: { tags: ["counting"] } }, async () => ({
    data: await many(pool, `SELECT u.id, u.name_ar, u.name_en FROM app_user u JOIN user_role ur ON ur.user_id = u.id AND ur.is_active
                              JOIN role r ON r.id = ur.role_id AND r.code = 'CDC' WHERE u.status = 'active' AND u.deleted_at IS NULL ORDER BY u.name_ar`),
  }));

  // ================================================================ ABC classification (drives cycle counts)
  app.post("/api/classification/abc", { preHandler: requirePerm("planning.manage", "count.plan"), schema: { tags: ["counting"], summary: "Recompute ABC classes" } }, async (req) =>
    withTx(txCtx(req), async (c) => one(c, "SELECT * FROM classify_abc()")));
}

export { DOC_TABLE };
