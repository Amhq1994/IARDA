// Material requests, approvals inbox, delegation, pick lists, deliveries, notifications.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, one, many, withTx } from "../db/pool.ts";
import { E } from "../lib/errors.ts";
import { parse, uuid, idParam, listQuery, versionField } from "../lib/http.ts";
import { requirePerm, requireAuth, txCtx, warehouseScope, assertWarehouseInScope, can, type AuthUser } from "../auth/context.ts";
import * as mr from "../services/requests.ts";

const mrBody = z.object({
  requestType: z.enum(["issue", "urgent", "work_order", "custody", "reservation"]),
  warehouseId: uuid, neededBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), purpose: z.string().max(500).nullable().optional(),
  justification: z.string().max(1000).nullable().optional(), workOrderRef: z.string().max(40).nullable().optional(),
  priority: z.enum(["normal", "high", "urgent"]).optional(),
  lines: z.array(z.object({ itemId: uuid, uomId: uuid.nullable().optional(), qty: z.number().positive(), notes: z.string().max(300).nullable().optional() })).min(1).max(100),
});

/** Row-level visibility of material requests. */
function scopeSql(u: AuthUser, p: unknown[]): string {
  const parts: string[] = [];
  p.push(u.id); const me = `$${p.length}`;
  parts.push(`m.requester_id = ${me}`);
  parts.push(`EXISTS (SELECT 1 FROM approval_task t WHERE t.doc_type = 'MR' AND t.doc_id = m.id AND (t.assignee_id = ${me} OR t.original_assignee_id = ${me}))`);
  if (u.roles.some((r) => r.code === "DM") && u.orgUnitId) { p.push(u.orgUnitId); parts.push(`m.org_unit_id = $${p.length}`); }
  if (can(u, "issue.execute") || can(u, "request.approve")) {
    const s = warehouseScope(u, can(u, "issue.execute") ? "issue.execute" : "request.approve");
    if (s === "all" && u.roles.some((r) => r.code === "WM" || r.code === "SK")) parts.push("true");
    else if (Array.isArray(s) && s.length) { p.push(s); parts.push(`m.warehouse_id = ANY($${p.length})`); }
  }
  if (can(u, "audit.read") && u.roles.some((r) => r.scope === "all")) parts.push("true");
  return `(${parts.join(" OR ")})`;
}

async function visibleMr(u: AuthUser, id: string) {
  const p: unknown[] = [id];
  const r = await one(pool, `SELECT m.id FROM material_request m WHERE m.id = $1 AND ${scopeSql(u, p)}`, p);
  if (!r) throw E.notFound("material request");
}

export async function requestRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- list & detail
  app.get("/api/requests", { preHandler: requirePerm("request.create", "request.approve", "issue.execute", "audit.read"), schema: { tags: ["requests"] } }, async (req) => {
    const q = parse(listQuery.extend({ status: z.string().optional(), type: z.string().optional(), view: z.enum(["mine", "approvals", "fulfil", "all"]).default("all"),
      overdue: z.coerce.boolean().optional() }), req.query);
    const u = req.user!;
    const p: unknown[] = [];
    const w = [scopeSql(u, p)];
    if (q.view === "mine") { p.push(u.id); w.push(`m.requester_id = $${p.length}`); }
    if (q.view === "approvals") { p.push(u.id); w.push(`EXISTS (SELECT 1 FROM approval_task t WHERE t.doc_type = 'MR' AND t.doc_id = m.id AND t.revision = m.revision AND t.status = 'pending' AND t.assignee_id = $${p.length})`); }
    if (q.view === "fulfil") w.push(`m.status IN ('approved','reserved','picking','ready_for_delivery','partially_delivered')`);
    if (q.status) { p.push(q.status); w.push(`m.status = ANY(string_to_array($${p.length}, ','))`); }
    if (q.type) { p.push(q.type); w.push(`m.request_type = ANY(string_to_array($${p.length}, ','))`); }
    if (q.overdue) w.push("m.is_overdue");
    if (q.q) { p.push(`%${q.q}%`); w.push(`(m.mr_no ILIKE $${p.length} OR m.purpose ILIKE $${p.length} OR m.work_order_ref ILIKE $${p.length})`); }
    const where = `WHERE ${w.join(" AND ")}`;
    const total = (await one(pool, `SELECT count(*)::int AS n FROM material_request m ${where}`, p))!.n;
    const data = await many(pool, `SELECT m.*, u.name_ar AS requester_ar, u.name_en AS requester_en, o.name_ar AS org_ar, o.name_en AS org_en,
        wh.code AS warehouse_code, wh.name_ar AS warehouse_name_ar, wh.name_en AS warehouse_name_en,
        (SELECT count(*)::int FROM mr_line l WHERE l.mr_id = m.id AND l.deleted_at IS NULL) AS lines
      FROM material_request m JOIN app_user u ON u.id = m.requester_id JOIN org_unit o ON o.id = m.org_unit_id JOIN warehouse wh ON wh.id = m.warehouse_id
      ${where} ORDER BY m.is_overdue DESC, m.updated_at DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, p);
    return { data, total, page: q.page, pageSize: q.pageSize };
  });

  app.get("/api/requests/:id", { preHandler: requirePerm("request.create", "request.approve", "issue.execute", "audit.read"), schema: { tags: ["requests"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    await visibleMr(req.user!, id);
    const m = await one(pool, `SELECT m.*, u.name_ar AS requester_ar, u.name_en AS requester_en, o.name_ar AS org_ar, o.name_en AS org_en, o.cost_center_code,
        wh.code AS warehouse_code, wh.name_ar AS warehouse_name_ar, wh.name_en AS warehouse_name_en
      FROM material_request m JOIN app_user u ON u.id = m.requester_id JOIN org_unit o ON o.id = m.org_unit_id JOIN warehouse wh ON wh.id = m.warehouse_id WHERE m.id = $1`, [id]);
    const [lines, approvals, events, pickTasks, deliveries] = await Promise.all([
      many(pool, `SELECT l.*, i.item_code, i.name_ar, i.name_en, i.track_batch, i.track_serial, u.code AS uom_code, u.name_ar AS uom_name_ar, u.name_en AS uom_name_en,
                    (SELECT coalesce(sum(qty_free),0) FROM v_pickable_stock s WHERE s.item_id = l.item_id AND s.warehouse_id = $2) AS available
                    FROM mr_line l JOIN item i ON i.id = l.item_id JOIN uom u ON u.id = i.base_uom_id
                   WHERE l.mr_id = $1 AND l.deleted_at IS NULL ORDER BY l.line_no`, [id, m.warehouse_id]),
      many(pool, `SELECT t.*, a.name_ar AS assignee_ar, a.name_en AS assignee_en, o.name_ar AS original_ar, o.name_en AS original_en,
                         b.name_ar AS acted_by_ar, b.name_en AS acted_by_en
                    FROM approval_task t JOIN app_user a ON a.id = t.assignee_id LEFT JOIN app_user o ON o.id = t.original_assignee_id
                    LEFT JOIN app_user b ON b.id = t.acted_by WHERE t.doc_type = 'MR' AND t.doc_id = $1 ORDER BY t.revision, t.level, t.created_at`, [id]),
      many(pool, `SELECT e.*, u.name_ar AS actor_ar, u.name_en AS actor_en FROM doc_event e LEFT JOIN app_user u ON u.id = e.actor_id
                   WHERE e.doc_type = 'MR' AND e.doc_id = $1 ORDER BY e.id`, [id]),
      many(pool, `SELECT t.*, pl.pick_no, pl.status AS list_status, i.item_code, i.name_ar, i.name_en, l.full_code, sl.lot_no, sl.serial_no, sl.expiry_date,
                         pb.name_ar AS picked_by_ar, pb.name_en AS picked_by_en
                    FROM pick_task t JOIN pick_list pl ON pl.id = t.pick_list_id JOIN item i ON i.id = t.item_id JOIN location l ON l.id = t.location_id
                    LEFT JOIN stock_lot sl ON sl.id = t.lot_id LEFT JOIN app_user pb ON pb.id = t.picked_by
                   WHERE pl.mr_id = $1 ORDER BY pl.created_at, t.seq`, [id]),
      many(pool, `SELECT d.*, ib.name_ar AS issued_by_ar, ib.name_en AS issued_by_en FROM delivery_note d JOIN app_user ib ON ib.id = d.issued_by
                   WHERE d.mr_id = $1 ORDER BY d.created_at`, [id]),
    ]);
    const u = req.user!;
    const myTask = approvals.find((a) => a.status === "pending" && a.assignee_id === u.id && a.revision === m.revision);
    const isApprover = approvals.some((a) => a.status === "approved" && a.acted_by === u.id);
    const canFulfil = can(u, "issue.execute") && u.id !== m.requester_id && !isApprover
      && (warehouseScope(u, "issue.execute") === "all" || (warehouseScope(u, "issue.execute") as string[]).includes(m.warehouse_id));
    return { ...m, lines, approvals, events, pickTasks, deliveries,
      actions: {
        edit: m.status === "draft" && m.requester_id === u.id,
        submit: m.status === "draft" && m.requester_id === u.id,
        decide: !!myTask,
        reserve: canFulfil && ["approved", "partially_delivered"].includes(m.status),
        releasePicks: canFulfil && m.status === "reserved",
        deliver: canFulfil && m.status === "ready_for_delivery",
        shortClose: can(u, "request.approve") && u.roles.some((r) => r.code === "WM") && m.status === "partially_delivered",
        cancel: ["draft", "pending_approval", "approved", "reserved"].includes(m.status) && (m.requester_id === u.id || u.roles.some((r) => r.code === "WM")),
      } };
  });

  // ---------------------------------------------------------------- create / edit / submit
  app.post("/api/requests", { preHandler: requirePerm("request.create"), schema: { tags: ["requests"], summary: "Create material request (draft)" } }, async (req, rep) => {
    const b = parse(mrBody, req.body);
    const out = await withTx(txCtx(req), (c) => mr.createDraft(c, { id: req.user!.id, orgUnitId: req.user!.orgUnitId }, b));
    rep.status(201); return out;
  });
  app.put("/api/requests/:id", { preHandler: requirePerm("request.create"), schema: { tags: ["requests"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(mrBody.extend({ version: versionField }), req.body);
    await withTx(txCtx(req), (c) => mr.updateDraft(c, req.user!.id, id, b, b.version));
    return { ok: true };
  });
  app.post("/api/requests/:id/submit", { preHandler: requirePerm("request.create"), schema: { tags: ["requests"], summary: "Submit: auto-validation + DoA routing" } }, async (req, rep) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ acknowledgeWarnings: z.boolean().default(false) }), req.body ?? {});
    const r = await withTx(txCtx(req), (c) => mr.submit(c, req.user!.id, id, b.acknowledgeWarnings));
    if (!r.ok) rep.status(422);
    return r.ok ? r : { error: { code: "validation_failed", message_ar: "لم يجتز الطلب التحقق الآلي", message_en: "The request failed auto-validation", details: r } };
  });

  // ---------------------------------------------------------------- approvals
  app.post("/api/requests/:id/decision", { preHandler: requireAuth, schema: { tags: ["requests"], summary: "Approve / reject / return (assigned approver or delegate)" } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ action: z.enum(["approve", "reject", "return"]), comment: z.string().max(1000).optional(),
      lines: z.array(z.object({ lineId: uuid, qtyApproved: z.number().min(0) })).optional() }), req.body);
    return withTx(txCtx(req), (c) => mr.decide(c, req.user!.id, id, b.action, b.comment, b.lines));
  });

  // ---------------------------------------------------------------- fulfilment
  const fulfil = async (req: any, id: string) => {
    const m = await one(pool, "SELECT warehouse_id FROM material_request WHERE id = $1", [id]);
    if (!m) throw E.notFound("material request");
    assertWarehouseInScope(req.user, "issue.execute", m.warehouse_id);
  };
  app.post("/api/requests/:id/reserve", { preHandler: requirePerm("issue.execute"), schema: { tags: ["requests"], summary: "Reserve stock (FIFO / FEFO / LIFO)" } }, async (req) => {
    const { id } = parse(idParam, req.params); await fulfil(req, id);
    return withTx(txCtx(req), (c) => mr.reserveStock(c, req.user!.id, id));
  });
  app.post("/api/requests/:id/pick-list", { preHandler: requirePerm("issue.execute"), schema: { tags: ["requests"] } }, async (req) => {
    const { id } = parse(idParam, req.params); await fulfil(req, id);
    const b = parse(z.object({ assignTo: uuid.nullable().optional() }), req.body ?? {});
    return withTx(txCtx(req), (c) => mr.releasePickList(c, req.user!.id, id, b.assignTo));
  });
  app.post("/api/requests/:id/deliver", { preHandler: requirePerm("issue.execute"), bodyLimit: 1024 * 1024, schema: { tags: ["requests"], summary: "Deliver with e-signature (posts goods issue)" } }, async (req) => {
    const { id } = parse(idParam, req.params); await fulfil(req, id);
    const b = parse(z.object({ receivedByUserId: uuid.nullable().optional(), receivedByName: z.string().trim().min(3).max(120),
      signaturePng: z.string().max(700_000), deviceInfo: z.string().max(300).optional() }), req.body);
    return withTx(txCtx(req), (c) => mr.deliver(c, req.user!.id, id, { ...b, deviceInfo: b.deviceInfo ?? String(req.headers["user-agent"] ?? "") }));
  });
  app.post("/api/requests/:id/short-close", { preHandler: requirePerm("request.approve"), schema: { tags: ["requests"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const m = await one(pool, "SELECT warehouse_id FROM material_request WHERE id = $1", [id]);
    if (!m) throw E.notFound("material request");
    if (!req.user!.roles.some((r) => r.code === "WM")) throw E.forbidden("warehouse manager");
    assertWarehouseInScope(req.user!, "request.approve", m.warehouse_id);
    const b = parse(z.object({ reason: z.string().trim().min(3).max(500) }), req.body);
    await withTx(txCtx(req), (c) => mr.shortClose(c, req.user!.id, id, b.reason));
    return { ok: true };
  });
  app.post("/api/requests/:id/cancel", { preHandler: requirePerm("request.create", "request.approve"), schema: { tags: ["requests"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    await visibleMr(req.user!, id);
    const b = parse(z.object({ reason: z.string().trim().min(3).max(500) }), req.body);
    await withTx(txCtx(req), (c) => mr.cancel(c, req.user!.id, id, b.reason, req.user!.roles.some((r) => r.code === "WM")));
    return { ok: true };
  });

  // ---------------------------------------------------------------- picking (mobile)
  app.get("/api/pick-lists", { preHandler: requirePerm("pick.execute", "issue.execute"), schema: { tags: ["requests"] } }, async (req) => {
    const u = req.user!;
    const s = warehouseScope(u, "pick.execute");
    const p: unknown[] = [];
    const w = ["pl.status IN ('open','in_progress')"];
    if (s !== "all") { p.push(s); w.push(`pl.warehouse_id = ANY($${p.length})`); }
    return { data: await many(pool, `SELECT pl.*, m.mr_no, m.priority, m.request_type, m.is_overdue, wh.code AS warehouse_code,
        (SELECT count(*)::int FROM pick_task t WHERE t.pick_list_id = pl.id) AS tasks,
        (SELECT count(*)::int FROM pick_task t WHERE t.pick_list_id = pl.id AND t.status = 'open') AS open_tasks
      FROM pick_list pl JOIN material_request m ON m.id = pl.mr_id JOIN warehouse wh ON wh.id = pl.warehouse_id
      WHERE ${w.join(" AND ")} ORDER BY m.priority = 'urgent' DESC, m.is_overdue DESC, pl.created_at`, p) };
  });
  app.get("/api/pick-lists/:id", { preHandler: requirePerm("pick.execute", "issue.execute"), schema: { tags: ["requests"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const pl = await one(pool, `SELECT pl.*, m.mr_no FROM pick_list pl JOIN material_request m ON m.id = pl.mr_id WHERE pl.id = $1`, [id]);
    if (!pl) throw E.notFound("pick list");
    assertWarehouseInScope(req.user!, can(req.user, "pick.execute") ? "pick.execute" : "issue.execute", pl.warehouse_id);
    const tasks = await many(pool, `SELECT t.*, i.item_code, i.name_ar, i.name_en, u.code AS uom_code, l.full_code, l.barcode AS location_barcode,
        sl.lot_no, sl.serial_no, sl.expiry_date,
        (SELECT value FROM item_identifier ii WHERE ii.item_id = i.id AND ii.id_type = 'barcode' AND ii.deleted_at IS NULL ORDER BY is_primary DESC LIMIT 1) AS item_barcode
      FROM pick_task t JOIN item i ON i.id = t.item_id JOIN uom u ON u.id = i.base_uom_id JOIN location l ON l.id = t.location_id
      LEFT JOIN stock_lot sl ON sl.id = t.lot_id WHERE t.pick_list_id = $1 ORDER BY t.seq`, [id]);
    return { ...pl, tasks };
  });
  app.post("/api/pick-tasks/:id/confirm", { preHandler: requirePerm("pick.execute"), schema: { tags: ["requests"], summary: "Scan-confirm a pick (bin + item [+ lot])" } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ location: z.string().trim().min(1).max(80), item: z.string().trim().min(1).max(120), lot: z.string().trim().max(60).nullable().optional(),
      qty: z.number().positive() }), req.body);
    const t = await one(pool, "SELECT pl.warehouse_id FROM pick_task t JOIN pick_list pl ON pl.id = t.pick_list_id WHERE t.id = $1", [id]);
    if (!t) throw E.notFound("pick task");
    assertWarehouseInScope(req.user!, "pick.execute", t.warehouse_id);
    return withTx(txCtx(req), (c) => mr.confirmPick(c, req.user!.id, id, b));
  });

  // ---------------------------------------------------------------- delivery note (print)
  app.get("/api/delivery-notes/:id", { preHandler: requirePerm("request.create", "issue.execute", "audit.read"), schema: { tags: ["requests"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const dn = await one(pool, `SELECT d.*, m.mr_no, m.request_type, m.purpose, m.work_order_ref, m.id AS mr_id, o.name_ar AS org_ar, o.name_en AS org_en, o.cost_center_code,
        wh.name_ar AS warehouse_name_ar, wh.name_en AS warehouse_name_en, ib.name_ar AS issued_by_ar, ib.name_en AS issued_by_en,
        rq.name_ar AS requester_ar, rq.name_en AS requester_en
      FROM delivery_note d JOIN material_request m ON m.id = d.mr_id JOIN org_unit o ON o.id = m.org_unit_id JOIN warehouse wh ON wh.id = m.warehouse_id
      JOIN app_user ib ON ib.id = d.issued_by JOIN app_user rq ON rq.id = m.requester_id WHERE d.id = $1`, [id]);
    if (!dn) throw E.notFound("delivery note");
    await visibleMr(req.user!, dn.mr_id);
    const lines = await many(pool, `SELECT dl.*, i.item_code, i.name_ar, i.name_en, u.code AS uom_code, l.full_code, sl.lot_no, sl.serial_no, sl.expiry_date
      FROM delivery_line dl JOIN item i ON i.id = dl.item_id JOIN uom u ON u.id = i.base_uom_id JOIN location l ON l.id = dl.location_id
      LEFT JOIN stock_lot sl ON sl.id = dl.lot_id WHERE dl.delivery_note_id = $1 ORDER BY i.item_code`, [id]);
    return { ...dn, lines };
  });

  // ---------------------------------------------------------------- DoA rules (read; edit via admin.workflows)
  app.get("/api/doa-rules", { preHandler: requirePerm("admin.workflows", "audit.read", "request.approve"), schema: { tags: ["requests"] } }, async () => ({
    data: await many(pool, `SELECT r.*, u.name_ar AS user_ar, u.name_en AS user_en FROM doa_rule r LEFT JOIN app_user u ON u.id = r.approver_user_id
                              WHERE r.deleted_at IS NULL ORDER BY r.doc_type, r.level, r.min_value`),
  }));
  app.patch("/api/doa-rules/:id", { preHandler: requirePerm("admin.workflows"), schema: { tags: ["requests"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ minValue: z.number().min(0).optional(), maxValue: z.number().min(0).nullable().optional(), slaHours: z.number().int().min(1).max(720).optional(),
      approverUserId: uuid.nullable().optional(), isActive: z.boolean().optional(), version: versionField }), req.body) as any;
    return withTx(txCtx(req), async (c) => {
      const cur = await one(c, "SELECT version FROM doa_rule WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]);
      if (!cur) throw E.notFound("rule");
      if (cur.version !== b.version) throw E.stale();
      const map: Record<string, string> = { minValue: "min_value", maxValue: "max_value", slaHours: "sla_hours", approverUserId: "approver_user_id", isActive: "is_active" };
      const sets: string[] = []; const p: unknown[] = [id];
      for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { p.push(b[k]); sets.push(`${col} = $${p.length}`); }
      return sets.length ? one(c, `UPDATE doa_rule SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, p) : cur;
    });
  });

  // ---------------------------------------------------------------- my delegations (absence)
  app.post("/api/delegations", { preHandler: requirePerm("delegation.own", "admin.delegations"), schema: { tags: ["requests"], summary: "Delegate my approvals for a period" } }, async (req, rep) => {
    const b = parse(z.object({ toUserId: uuid, validFrom: z.string().datetime({ offset: true }), validTo: z.string().datetime({ offset: true }),
      reason: z.string().trim().min(3).max(300), maxValue: z.number().positive().nullable().optional(), docTypes: z.array(z.string()).nullable().optional() }), req.body);
    if (b.toUserId === req.user!.id) throw E.invalid([{ path: "toUserId", message: "cannot_delegate_to_self" }]);
    if (new Date(b.validTo) <= new Date(b.validFrom)) throw E.invalid([{ path: "validTo", message: "must_be_after_start" }]);
    if (new Date(b.validTo).getTime() - new Date(b.validFrom).getTime() > 90 * 86400_000) throw E.invalid([{ path: "validTo", message: "max_90_days" }]);
    const out = await withTx(txCtx(req), async (c) => {
      const d = await one(c, `INSERT INTO delegation (from_user_id, to_user_id, valid_from, valid_to, reason, max_value, doc_types) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.user!.id, b.toUserId, b.validFrom, b.validTo, b.reason, b.maxValue ?? null, b.docTypes ?? null]);
      // route the delegator's open approvals to the delegate (except where the delegate is the requester — SoD-7)
      await c.query(`UPDATE approval_task t SET original_assignee_id = t.assignee_id, assignee_id = $2, delegation_id = $3
                       FROM material_request m WHERE m.id = t.doc_id AND t.doc_type = 'MR' AND t.assignee_id = $1 AND t.status IN ('pending','waiting')
                        AND m.requester_id <> $2 AND now() BETWEEN $4::timestamptz AND $5::timestamptz AND ($6::numeric IS NULL OR m.estimated_value <= $6)`,
        [req.user!.id, b.toUserId, d.id, b.validFrom, b.validTo, b.maxValue ?? null]);
      return d;
    });
    rep.status(201); return out;
  });
  app.post("/api/delegations/:id/revoke", { preHandler: requirePerm("delegation.own", "admin.delegations"), schema: { tags: ["requests"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    await withTx(txCtx(req), async (c) => {
      const d = await one(c, "SELECT * FROM delegation WHERE id = $1 FOR UPDATE", [id]);
      if (!d) throw E.notFound("delegation");
      if (d.from_user_id !== req.user!.id && !can(req.user, "admin.delegations")) throw E.forbidden();
      await c.query("UPDATE delegation SET status = 'revoked' WHERE id = $1", [id]);
      await c.query(`UPDATE approval_task SET assignee_id = original_assignee_id, original_assignee_id = NULL, delegation_id = NULL
                     WHERE delegation_id = $1 AND status IN ('pending','waiting')`, [id]);
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- notifications
  app.get("/api/notifications", { preHandler: requireAuth, schema: { tags: ["requests"] } }, async (req) => ({
    unread: (await one(pool, "SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND read_at IS NULL", [req.user!.id]))!.n,
    data: await many(pool, "SELECT * FROM notification WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30", [req.user!.id]),
  }));
  app.post("/api/notifications/read", { preHandler: requireAuth, schema: { tags: ["requests"] } }, async (req) => {
    const b = parse(z.object({ ids: z.array(uuid).optional() }), req.body ?? {});
    await pool.query(`UPDATE notification SET read_at = now() WHERE user_id = $1 AND read_at IS NULL ${b.ids ? "AND id = ANY($2)" : ""}`, b.ids ? [req.user!.id, b.ids] : [req.user!.id]);
    return { ok: true };
  });
}
