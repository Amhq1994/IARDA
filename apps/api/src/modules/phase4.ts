// Planning & purchase requisitions, valuation / provisions / journals, assets & custody, employee clearance.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, one, many, withTx } from "../db/pool.ts";
import { E } from "../lib/errors.ts";
import { parse, uuid, idParam } from "../lib/http.ts";
import { requirePerm, requireAuth, txCtx, warehouseScope, assertWarehouseInScope, can, type AuthUser } from "../auth/context.ts";
import type { Permission } from "@iarda/shared";
import * as plan from "../services/planning.ts";
import * as val from "../services/valuation.ts";
import * as cus from "../services/custody.ts";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const pageQ = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) });

function scopeFor(u: AuthUser, perms: Permission[]): "all" | string[] {
  let acc: string[] = [];
  for (const p of perms) {
    if (!u.permissions.has(p)) continue;
    const s = warehouseScope(u, p);
    if (s === "all") return "all";
    acc = [...acc, ...s];
  }
  return acc;
}
const inScope = (s: "all" | string[], wh: string) => s === "all" || s.includes(wh);
const events = (docType: string, id: string) => many(pool, `SELECT e.*, u.name_ar AS actor_ar, u.name_en AS actor_en FROM doc_event e LEFT JOIN app_user u ON u.id = e.actor_id
  WHERE e.doc_type = $1 AND e.doc_id = $2 ORDER BY e.id`, [docType, id]);

export async function phase4Routes(app: FastifyInstance) {
  // ================================================================ planning
  const planPerms: Permission[] = ["planning.manage", "pr.create", "pr.approve", "valuation.manage", "audit.read"];
  app.get("/api/planning/runs", { preHandler: requirePerm(...planPerms), schema: { tags: ["planning"] } }, async () => ({
    data: await many(pool, `SELECT r.*, w.code AS warehouse_code, u.name_ar AS created_by_ar, u.name_en AS created_by_en,
        (SELECT coalesce(sum(suggested_value), 0) FROM planning_line l WHERE l.run_id = r.id AND l.action = 'reorder') AS reorder_value
      FROM planning_run r LEFT JOIN warehouse w ON w.id = r.warehouse_id LEFT JOIN app_user u ON u.id = r.created_by ORDER BY r.created_at DESC LIMIT 50`),
  }));
  app.post("/api/planning/runs", { preHandler: requirePerm("planning.manage"), schema: { tags: ["planning"], summary: "Compute SS / ROP / EOQ / min-max and reorder suggestions" } }, async (req, rep) => {
    const b = parse(z.object({ warehouseId: uuid.nullable().optional() }), req.body ?? {});
    const out = await withTx(txCtx(req), (c) => plan.runPlanning(c, req.user!.id, b.warehouseId ?? null));
    rep.status(201); return out;
  });
  app.get("/api/planning/runs/:id", { preHandler: requirePerm(...planPerms), schema: { tags: ["planning"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(pageQ.extend({ action: z.enum(["reorder", "ok", "excess", "dead", "no_demand"]).optional(), warehouseId: uuid.optional(), q: z.string().max(80).optional() }), req.query);
    const run = await one(pool, "SELECT r.*, w.code AS warehouse_code FROM planning_run r LEFT JOIN warehouse w ON w.id = r.warehouse_id WHERE r.id = $1", [id]);
    if (!run) throw E.notFound("planning run");
    const args: unknown[] = [id];
    let f = "";
    if (q.action) { args.push(q.action); f += ` AND l.action = $${args.length}`; }
    if (q.warehouseId) { args.push(q.warehouseId); f += ` AND l.warehouse_id = $${args.length}`; }
    if (q.q) { args.push(`%${q.q}%`); f += ` AND (i.item_code ILIKE $${args.length} OR i.name_ar ILIKE $${args.length} OR i.name_en ILIKE $${args.length})`; }
    const total = Number((await one(pool, `SELECT count(*) AS n FROM planning_line l JOIN item i ON i.id = l.item_id WHERE l.run_id = $1 ${f}`, args)).n);
    const counts = await many(pool, "SELECT action, count(*)::int AS n, coalesce(sum(suggested_value), 0) AS value FROM planning_line WHERE run_id = $1 GROUP BY 1", [id]);
    args.push(q.pageSize, (q.page - 1) * q.pageSize);
    const data = await many(pool, `SELECT l.*, i.item_code, i.name_ar, i.name_en, i.abc_class, i.ved_class, w.code AS warehouse_code, u.code AS uom_code, pr.pr_no
      FROM planning_line l JOIN item i ON i.id = l.item_id JOIN warehouse w ON w.id = l.warehouse_id JOIN uom u ON u.id = i.base_uom_id
      LEFT JOIN purchase_requisition pr ON pr.id = l.pr_id
      WHERE l.run_id = $1 ${f} ORDER BY (l.action = 'reorder') DESC, l.suggested_value DESC, i.item_code LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
    return { ...run, counts, lines: { data, total, page: q.page, pageSize: q.pageSize } };
  });
  app.post("/api/planning/runs/:id/apply", { preHandler: requirePerm("planning.manage"), schema: { tags: ["planning"], summary: "Write computed parameters into item policies" } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ lineIds: z.array(uuid).max(2000).optional() }), req.body ?? {});
    return withTx(txCtx(req), (c) => plan.applyPlan(c, req.user!.id, id, b.lineIds));
  });
  app.post("/api/planning/runs/:id/prs", { preHandler: requirePerm("pr.create"), schema: { tags: ["planning"], summary: "Create purchase requisitions from reorder suggestions" } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ lineIds: z.array(uuid).max(2000).optional() }), req.body ?? {});
    return { data: await withTx(txCtx(req), (c) => plan.prsFromRun(c, req.user!.id, id, b.lineIds)) };
  });
  app.get("/api/planning/dead-stock", { preHandler: requirePerm("planning.manage", "valuation.manage", "warehouse.read"), schema: { tags: ["planning"] } }, async (req) => {
    const q = parse(z.object({ warehouseId: uuid.optional() }), req.query);
    const c = await pool.connect();
    try { return { data: await plan.deadStock(c, scopeFor(req.user!, ["planning.manage", "valuation.manage", "warehouse.read"]), q.warehouseId) }; } finally { c.release(); }
  });
  app.get("/api/planning/consumption", { preHandler: requirePerm("item.read"), schema: { tags: ["planning"], summary: "Monthly consumption (ledger + legacy history)" } }, async (req) => {
    const q = parse(z.object({ itemId: uuid, warehouseId: uuid.optional() }), req.query);
    const args: unknown[] = [q.itemId];
    if (q.warehouseId) args.push(q.warehouseId);
    const wf = q.warehouseId ? "AND warehouse_id = $2" : "";
    return { data: await many(pool, `SELECT to_char(m, 'YYYY-MM') AS month, sum(q) AS qty FROM (
        SELECT date_trunc('month', posted_at) AS m, -qty AS q FROM stock_ledger WHERE item_id = $1 AND movement_type IN ('GI','RTW') ${wf}
        UNION ALL SELECT period, qty FROM consumption_history WHERE item_id = $1 ${wf}) x
      WHERE m >= date_trunc('month', now()) - interval '11 months' GROUP BY 1 ORDER BY 1`, args) };
  });

  // ================================================================ purchase requisitions
  const prPerms: Permission[] = ["pr.create", "pr.approve", "pr.process", "planning.manage", "audit.read"];
  app.get("/api/prs", { preHandler: requirePerm(...prPerms), schema: { tags: ["planning"] } }, async (req) => {
    const q = parse(z.object({ status: z.string().max(30).optional() }), req.query);
    const s = scopeFor(req.user!, prPerms);
    const args: unknown[] = [];
    let f = "true";
    if (s !== "all") { args.push(s); f = `p.warehouse_id = ANY($1)`; }
    if (q.status) { args.push(q.status); f += ` AND p.status = $${args.length}`; }
    return { data: await many(pool, `SELECT p.*, w.code AS warehouse_code, u.name_ar AS requester_ar, u.name_en AS requester_en,
        (SELECT count(*)::int FROM pr_line l WHERE l.pr_id = p.id) AS lines, (SELECT min(po.po_no) FROM purchase_order po WHERE po.pr_id = p.id) AS po_no
      FROM purchase_requisition p JOIN warehouse w ON w.id = p.warehouse_id JOIN app_user u ON u.id = p.requested_by WHERE ${f} ORDER BY p.updated_at DESC LIMIT 200`, args) };
  });
  app.get("/api/prs/:id", { preHandler: requireAuth, schema: { tags: ["planning"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const p = await one(pool, `SELECT p.*, w.code AS warehouse_code, w.name_ar AS warehouse_ar, w.name_en AS warehouse_en, u.name_ar AS requester_ar, u.name_en AS requester_en, r.run_no
      FROM purchase_requisition p JOIN warehouse w ON w.id = p.warehouse_id JOIN app_user u ON u.id = p.requested_by LEFT JOIN planning_run r ON r.id = p.planning_run_id WHERE p.id = $1`, [id]);
    if (!p) throw E.notFound("purchase requisition");
    const u = req.user!;
    const ap = await many(pool, `SELECT t.*, a.name_ar AS assignee_ar, a.name_en AS assignee_en, o.name_ar AS original_ar, o.name_en AS original_en FROM approval_task t
      JOIN app_user a ON a.id = t.assignee_id LEFT JOIN app_user o ON o.id = t.original_assignee_id WHERE t.doc_type = 'PR' AND t.doc_id = $1 ORDER BY t.revision, t.level`, [id]);
    if (!ap.some((x) => x.assignee_id === u.id) && !inScope(scopeFor(u, prPerms), p.warehouse_id)) throw E.outOfScope();
    const lines = await many(pool, `SELECT l.*, i.item_code, i.name_ar, i.name_en, uo.code AS uom_code, po.po_no FROM pr_line l JOIN item i ON i.id = l.item_id
      JOIN uom uo ON uo.id = i.base_uom_id LEFT JOIN purchase_order po ON po.id = l.po_id WHERE l.pr_id = $1 ORDER BY l.line_no`, [id]);
    const po = await one(pool, "SELECT id, po_no, status FROM purchase_order WHERE pr_id = $1 LIMIT 1", [id]);
    const approvers = ap.filter((x) => x.status === "approved").map((x) => x.acted_by);
    return { ...p, lines, po, approvals: ap, events: await events("PR", id), actions: {
      submit: p.status === "draft" && p.requested_by === u.id,
      decide: ap.some((x) => x.status === "pending" && x.assignee_id === u.id && x.revision === p.revision),
      convert: p.status === "approved" && can(u, "pr.process") && !approvers.includes(u.id),
      cancel: ["draft", "approved"].includes(p.status) && (p.requested_by === u.id || can(u, "pr.process")),
    } };
  });
  app.post("/api/prs", { preHandler: requirePerm("pr.create"), schema: { tags: ["planning"], summary: "Manual purchase requisition" } }, async (req, rep) => {
    const b = parse(z.object({ warehouseId: uuid, neededBy: dateStr.nullable().optional(), notes: z.string().max(500).nullable().optional(),
      lines: z.array(z.object({ itemId: uuid, qty: z.number().positive(), estUnitCost: z.number().min(0).optional(), notes: z.string().max(300).optional() })).min(1).max(200) }), req.body);
    assertWarehouseInScope(req.user!, "pr.create", b.warehouseId);
    const out = await withTx(txCtx(req), (c) => plan.createPr(c, req.user!.id, b));
    rep.status(201); return out;
  });
  app.post("/api/prs/:id/submit", { preHandler: requirePerm("pr.create"), schema: { tags: ["planning"] } }, async (req) =>
    withTx(txCtx(req), (c) => plan.submitPr(c, req.user!.id, parse(idParam, req.params).id)));
  app.post("/api/prs/:id/convert", { preHandler: requirePerm("pr.process"), schema: { tags: ["planning"], summary: "Convert an approved requisition to a PO" } }, async (req, rep) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ supplierId: uuid, etimadRef: z.string().max(60).nullable().optional(), expectedDate: dateStr.nullable().optional(),
      prices: z.record(z.string(), z.number().min(0)).optional() }), req.body);
    const po = await withTx(txCtx(req), (c) => plan.convertPr(c, req.user!.id, id, b));
    rep.status(201); return po;
  });
  app.post("/api/prs/:id/cancel", { preHandler: requirePerm("pr.create", "pr.process"), schema: { tags: ["planning"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    await withTx(txCtx(req), (c) => plan.cancelPr(c, req.user!.id, id, b.reason));
    return { ok: true };
  });

  // ================================================================ valuation, provisions, journals
  const valPerms: Permission[] = ["valuation.manage", "journal.manage", "audit.read"];
  app.get("/api/valuation/summary", { preHandler: requirePerm(...valPerms), schema: { tags: ["valuation"], summary: "WAVG vs FIFO, ledger and GL reconciliation" } }, async (req) => {
    const c = await pool.connect();
    try { return await val.valuationSummary(c, scopeFor(req.user!, valPerms)); } finally { c.release(); }
  });
  app.get("/api/valuation/items", { preHandler: requirePerm(...valPerms), schema: { tags: ["valuation"] } }, async (req) => {
    const q = parse(pageQ.extend({ warehouseId: uuid, q: z.string().max(80).optional() }), req.query);
    if (!inScope(scopeFor(req.user!, valPerms), q.warehouseId)) throw E.outOfScope();
    const c = await pool.connect();
    try { return await val.valuationItems(c, q.warehouseId, q.q, q.page, q.pageSize); } finally { c.release(); }
  });
  app.get("/api/provisions", { preHandler: requirePerm(...valPerms), schema: { tags: ["valuation"] } }, async () => ({
    data: await many(pool, `SELECT p.*, je.je_no, je.status AS je_status, u.name_ar AS created_by_ar, u.name_en AS created_by_en
      FROM provision_run p LEFT JOIN journal_entry je ON je.id = p.je_id LEFT JOIN app_user u ON u.id = p.created_by ORDER BY p.created_at DESC LIMIT 50`),
  }));
  app.get("/api/provisions/:id", { preHandler: requirePerm(...valPerms), schema: { tags: ["valuation"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const p = await one(pool, "SELECT p.*, je.je_no FROM provision_run p LEFT JOIN journal_entry je ON je.id = p.je_id WHERE p.id = $1", [id]);
    if (!p) throw E.notFound("provision");
    return { ...p,
      byCategory: await many(pool, "SELECT category, count(*)::int AS n, sum(value) AS value, sum(provision) AS provision FROM provision_line WHERE run_id = $1 GROUP BY 1 ORDER BY 4 DESC", [id]),
      lines: await many(pool, `SELECT l.*, i.item_code, i.name_ar, i.name_en, w.code AS warehouse_code, sl.lot_no, sl.serial_no, sl.expiry_date FROM provision_line l
        JOIN item i ON i.id = l.item_id JOIN warehouse w ON w.id = l.warehouse_id LEFT JOIN stock_lot sl ON sl.id = l.lot_id WHERE l.run_id = $1 ORDER BY l.provision DESC LIMIT 500`, [id]) };
  });
  app.post("/api/provisions", { preHandler: requirePerm("valuation.manage"), schema: { tags: ["valuation"], summary: "Compute required provision and book the delta" } }, async (req, rep) => {
    const b = parse(z.object({ asOf: dateStr.optional() }), req.body ?? {});
    const out = await withTx(txCtx(req), (c) => val.runProvision(c, req.user!.id, b.asOf));
    rep.status(201); return out;
  });
  app.post("/api/journals/generate", { preHandler: requirePerm("valuation.manage", "journal.manage"), schema: { tags: ["valuation"], summary: "Journalise new ledger movements" } }, async (req) => {
    const b = parse(z.object({ upTo: z.string().datetime({ offset: true }).optional() }), req.body ?? {});
    return { data: await withTx(txCtx(req), (c) => val.generateJournals(c, req.user!.id, b.upTo)) };
  });
  app.get("/api/journals", { preHandler: requirePerm(...valPerms), schema: { tags: ["valuation"] } }, async (req) => {
    const q = parse(z.object({ status: z.enum(["draft", "posted", "exported"]).optional() }), req.query);
    return { data: await many(pool, `SELECT e.*, (SELECT count(*)::int FROM journal_line l WHERE l.je_id = e.id) AS lines, u.name_ar AS posted_by_ar, u.name_en AS posted_by_en
      FROM journal_entry e LEFT JOIN app_user u ON u.id = e.posted_by WHERE ($1::text IS NULL OR e.status = $1) ORDER BY e.period DESC, e.created_at DESC LIMIT 200`, [q.status ?? null]) };
  });
  app.get("/api/journals/:id", { preHandler: requirePerm(...valPerms), schema: { tags: ["valuation"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const je = await one(pool, "SELECT * FROM journal_entry WHERE id = $1", [id]);
    if (!je) throw E.notFound("journal");
    return { ...je, events: await events("JE", id),
      lines: await many(pool, `SELECT l.*, a.name_ar AS account_ar, a.name_en AS account_en, w.code AS warehouse_code, o.code AS org_code, o.name_ar AS org_ar, o.name_en AS org_en
        FROM journal_line l JOIN gl_account a ON a.code = l.account_code LEFT JOIN warehouse w ON w.id = l.warehouse_id LEFT JOIN org_unit o ON o.id = l.org_unit_id
        WHERE l.je_id = $1 ORDER BY l.line_no`, [id]),
      actions: { post: je.status === "draft" && can(req.user!, "journal.manage"), export: je.status === "posted" && can(req.user!, "journal.manage") } };
  });
  app.post("/api/journals/:id/post", { preHandler: requirePerm("journal.manage"), schema: { tags: ["valuation"] } }, async (req) => {
    await withTx(txCtx(req), (c) => val.postJournal(c, req.user!.id, parse(idParam, req.params).id));
    return { ok: true };
  });
  app.post("/api/journals/:id/export", { preHandler: requirePerm("journal.manage"), schema: { tags: ["valuation"], summary: "Mark as transferred to the ERP" } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ erpRef: z.string().trim().min(2).max(60) }), req.body);
    await withTx(txCtx(req), (c) => val.markExported(c, req.user!.id, id, b.erpRef));
    return { ok: true };
  });
  app.get("/api/gl/accounts", { preHandler: requirePerm(...valPerms), schema: { tags: ["valuation"] } }, async () => ({
    accounts: await many(pool, `SELECT a.*, coalesce((SELECT sum(debit - credit) FROM journal_line l JOIN journal_entry e ON e.id = l.je_id WHERE l.account_code = a.code AND e.status <> 'draft'), 0) AS posted_balance
      FROM gl_account a ORDER BY a.code`),
    movements: await many(pool, "SELECT * FROM movement_gl_map ORDER BY movement_type"),
    statuses: await many(pool, "SELECT * FROM status_gl_map ORDER BY stock_status"),
  }));

  // ================================================================ custody
  const cusPerms: Permission[] = ["custody.manage", "custody.approve", "audit.read"];
  app.get("/api/custody", { preHandler: requireAuth, schema: { tags: ["custody"] } }, async (req) => {
    const q = parse(z.object({ view: z.enum(["mine", "all"]).default("mine"), status: z.string().max(30).optional(), q: z.string().max(80).optional(), holderId: uuid.optional() }), req.query);
    const u = req.user!;
    const args: unknown[] = [];
    let f = "true";
    if (q.view === "mine" || !cusPerms.some((p) => u.permissions.has(p))) { args.push(u.id); f = "c.holder_id = $1"; }
    if (q.status) { args.push(q.status); f += ` AND c.status = $${args.length}`; }
    if (q.holderId) { args.push(q.holderId); f += ` AND c.holder_id = $${args.length}`; }
    if (q.q) { args.push(`%${q.q}%`); f += ` AND (i.item_code ILIKE $${args.length} OR i.name_ar ILIKE $${args.length} OR h.name_ar ILIKE $${args.length} OR h.name_en ILIKE $${args.length} OR sl.serial_no ILIKE $${args.length} OR c.custody_no ILIKE $${args.length})`; }
    return { data: await many(pool, `SELECT c.*, i.item_code, i.name_ar, i.name_en, sl.serial_no, sl.lot_no, h.name_ar AS holder_ar, h.name_en AS holder_en, h.employee_no,
        o.name_ar AS org_ar, o.name_en AS org_en, m.mr_no, w.code AS warehouse_code
      FROM custody c JOIN item i ON i.id = c.item_id JOIN app_user h ON h.id = c.holder_id LEFT JOIN org_unit o ON o.id = c.org_unit_id
      LEFT JOIN stock_lot sl ON sl.id = c.lot_id LEFT JOIN material_request m ON m.id = c.mr_id JOIN warehouse w ON w.id = c.warehouse_id
      WHERE ${f} ORDER BY c.issued_at DESC LIMIT 500`, args) };
  });
  app.get("/api/custody/:id", { preHandler: requireAuth, schema: { tags: ["custody"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await one(pool, `SELECT c.*, i.item_code, i.name_ar, i.name_en, sl.serial_no, sl.lot_no, h.name_ar AS holder_ar, h.name_en AS holder_en, h.employee_no,
        o.name_ar AS org_ar, o.name_en AS org_en, m.mr_no, rd.ret_no, w.code AS warehouse_code FROM custody c JOIN item i ON i.id = c.item_id JOIN app_user h ON h.id = c.holder_id
        LEFT JOIN org_unit o ON o.id = c.org_unit_id LEFT JOIN stock_lot sl ON sl.id = c.lot_id LEFT JOIN material_request m ON m.id = c.mr_id
        LEFT JOIN return_doc rd ON rd.id = c.return_id JOIN warehouse w ON w.id = c.warehouse_id WHERE c.id = $1`, [id]);
    if (!r) throw E.notFound("custody");
    const u = req.user!;
    if (r.holder_id !== u.id && !cusPerms.some((p) => u.permissions.has(p))) throw E.forbidden("custody");
    return { ...r, events: await events("CUS", id), actions: {
      acknowledge: r.holder_id === u.id && !r.acknowledged_at && r.status === "active",
      transfer: r.status === "active" && can(u, "custody.manage"),
      return: r.status === "active" && (can(u, "custody.manage") || r.holder_id === u.id),
      lost: r.status === "active" && can(u, "custody.approve") && r.holder_id !== u.id,
    } };
  });
  app.post("/api/custody/:id/acknowledge", { preHandler: requireAuth, schema: { tags: ["custody"] } }, async (req) => {
    await withTx(txCtx(req), (c) => cus.acknowledge(c, req.user!.id, parse(idParam, req.params).id));
    return { ok: true };
  });
  app.post("/api/custody/:id/transfer", { preHandler: requirePerm("custody.manage"), schema: { tags: ["custody"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ toUserId: uuid, reason: z.string().trim().min(3).max(300) }), req.body);
    await withTx(txCtx(req), (c) => cus.transferCustody(c, req.user!.id, id, b.toUserId, b.reason));
    return { ok: true };
  });
  app.post("/api/custody/:id/return", { preHandler: requireAuth, schema: { tags: ["custody"], summary: "Return the asset (opens a return to warehouse)" } }, async (req, rep) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ condition: z.enum(["good", "quarantine", "damaged"]).optional(), reason: z.string().trim().min(3).max(300) }), req.body);
    const cu = await one(pool, "SELECT holder_id FROM custody WHERE id = $1", [id]);
    if (!cu) throw E.notFound("custody");
    if (cu.holder_id !== req.user!.id && !can(req.user!, "custody.manage")) throw E.forbidden("custody.manage");
    const ret = await withTx(txCtx(req), (c) => cus.returnCustody(c, req.user!.id, id, b));
    rep.status(201); return ret;
  });
  app.post("/api/custody/:id/lost", { preHandler: requirePerm("custody.approve"), schema: { tags: ["custody"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
    await withTx(txCtx(req), (c) => cus.declareLost(c, req.user!.id, id, b.reason));
    return { ok: true };
  });
  app.get("/api/employees", { preHandler: requirePerm("custody.manage", "clearance.request", "admin.users"), schema: { tags: ["custody"], summary: "Employee picker" } }, async (req) => {
    const q = parse(z.object({ q: z.string().max(80).optional() }), req.query);
    return { data: await many(pool, `SELECT u.id, u.username, u.employee_no, u.name_ar, u.name_en, o.name_ar AS org_ar, o.name_en AS org_en FROM app_user u
      LEFT JOIN org_unit o ON o.id = u.org_unit_id WHERE u.deleted_at IS NULL AND u.supplier_id IS NULL AND u.username <> 'system'
        AND ($1::text IS NULL OR u.name_ar ILIKE '%' || $1 || '%' OR u.name_en ILIKE '%' || $1 || '%' OR u.employee_no ILIKE '%' || $1 || '%')
      ORDER BY u.name_ar LIMIT 50`, [q.q ?? null]) };
  });

  // ================================================================ clearance
  const clPerms: Permission[] = ["clearance.request", "admin.users", "audit.read"];
  app.get("/api/clearances", { preHandler: requirePerm(...clPerms), schema: { tags: ["custody"] } }, async () => ({
    data: await many(pool, `SELECT c.*, e.name_ar AS employee_ar, e.name_en AS employee_en, e.employee_no, r.name_ar AS requested_by_ar, r.name_en AS requested_by_en
      FROM clearance c JOIN app_user e ON e.id = c.employee_id JOIN app_user r ON r.id = c.requested_by ORDER BY c.created_at DESC LIMIT 200`),
  }));
  app.get("/api/clearances/:id", { preHandler: requireAuth, schema: { tags: ["custody"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const cl = await one(pool, `SELECT c.*, e.name_ar AS employee_ar, e.name_en AS employee_en, e.employee_no, e.position_ar, e.position_en, o.name_ar AS org_ar, o.name_en AS org_en,
        r.name_ar AS requested_by_ar, r.name_en AS requested_by_en, cb.name_ar AS cleared_by_ar, cb.name_en AS cleared_by_en
      FROM clearance c JOIN app_user e ON e.id = c.employee_id LEFT JOIN org_unit o ON o.id = e.org_unit_id JOIN app_user r ON r.id = c.requested_by
      LEFT JOIN app_user cb ON cb.id = c.cleared_by WHERE c.id = $1`, [id]);
    if (!cl) throw E.notFound("clearance");
    if (cl.employee_id !== req.user!.id && !clPerms.some((p) => req.user!.permissions.has(p))) throw E.forbidden("clearance");
    return { ...cl, events: await events("CL", id), actions: { recheck: cl.status === "blocked" && can(req.user!, "clearance.request"),
      cancel: cl.status === "blocked" && can(req.user!, "clearance.request") } };
  });
  app.post("/api/clearances", { preHandler: requirePerm("clearance.request"), schema: { tags: ["custody"], summary: "Employee clearance (إخلاء طرف)" } }, async (req, rep) => {
    const b = parse(z.object({ employeeId: uuid, reason: z.enum(["resignation", "transfer", "retirement", "end_of_contract", "other"]), notes: z.string().max(500).optional() }), req.body);
    const out = await withTx(txCtx(req), (c) => cus.requestClearance(c, req.user!.id, b));
    rep.status(201); return out;
  });
  app.post("/api/clearances/:id/recheck", { preHandler: requirePerm("clearance.request"), schema: { tags: ["custody"] } }, async (req) =>
    withTx(txCtx(req), (c) => cus.recheckClearance(c, req.user!.id, parse(idParam, req.params).id)));
  app.post("/api/clearances/:id/cancel", { preHandler: requirePerm("clearance.request"), schema: { tags: ["custody"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    await withTx(txCtx(req), async (c) => {
      const r = await c.query("UPDATE clearance SET status = 'cancelled' WHERE id = $1 AND status = 'blocked'", [id]);
      if (!r.rowCount) throw E.state("not blocked", "cancel");
    });
    return { ok: true };
  });
}
