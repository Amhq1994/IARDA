// Machine-to-machine API v1 (header x-api-key, scoped keys, every call logged, per-key rate limit).
//   ERP     : stock on hand, posted journals (+ acknowledgement), purchase orders in
//   Etimad  : approved requisitions out, awarded purchase orders in
//   CMMS    : material requests for work orders, status
//   HR      : employee exit → clearance (إخلاء طرف)
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { pool, one, many, withTx } from "../db/pool.ts";
import { E, ApiError } from "../lib/errors.ts";
import { parse } from "../lib/http.ts";
import { authenticateKey, logCall, requireScope, type IntegrationAuth, type Scope } from "../services/integrations.ts";
import { createPo } from "../services/inbound.ts";
import { markExported } from "../services/valuation.ts";
import { requestClearance } from "../services/custody.ts";
import * as mr from "../services/requests.ts";

declare module "fastify" { interface FastifyRequest { integration?: IntegrationAuth; t0?: number } }

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ctx = (req: FastifyRequest, userId?: string) => ({ userId: userId ?? req.integration!.userId, requestId: req.id, ip: req.ip });
const scope = (s: Scope) => async (req: FastifyRequest) => requireScope(req.integration, s);

async function byCode(table: "warehouse" | "supplier", code: string) {
  const r = await one(pool, `SELECT id FROM ${table} WHERE code = $1 AND deleted_at IS NULL`, [code]);
  if (!r) throw E.invalid([{ path: `${table}Code`, message: `unknown ${table} ${code}` }]);
  return r.id as string;
}
async function itemByCode(code: string) {
  const r = await one(pool, `SELECT id FROM item WHERE deleted_at IS NULL AND item_code = $1
                             UNION ALL SELECT item_id FROM item_identifier WHERE deleted_at IS NULL AND value = $1 LIMIT 1`, [code]);
  if (!r) throw E.invalid([{ path: "itemCode", message: `unknown item ${code}` }]);
  return r.id as string;
}

export async function integrationRoutes(app: FastifyInstance) {
  await app.register(async (api) => {
    api.addHook("onRequest", async (req) => {
      req.t0 = Date.now();
      const a = await authenticateKey(req.headers["x-api-key"] as string | undefined, req.ip);
      if (!a) {
        await logCall({ method: req.method, path: req.url, status: 401, requestId: req.id, ip: req.ip, ms: 0 });
        throw new ApiError(401, "invalid_api_key", "مفتاح التكامل غير صالح", "Invalid or inactive API key");
      }
      req.integration = a;
    });
    api.addHook("onResponse", async (req, rep) => {
      if (req.integration) await logCall({ clientId: req.integration.clientId, method: req.method, path: req.url, status: rep.statusCode, requestId: req.id, ip: req.ip, ms: Date.now() - (req.t0 ?? Date.now()) });
    });
    const rl = { rateLimit: { max: 120, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => String(req.headers["x-api-key"] ?? req.ip).slice(0, 16) } };
    const S = (summary: string) => ({ tags: ["integration"], summary, security: [{ apiKey: [] }] });

    api.get("/api/integration/v1/ping", { config: rl, schema: S("Check the key") }, async (req) => ({ ok: true, client: req.integration!.name, scopes: req.integration!.scopes }));

    // ---------------------------------------------------------------- ERP
    api.get("/api/integration/v1/stock", { config: rl, preHandler: scope("erp.stock"), schema: S("Stock on hand and value per item / warehouse") }, async (req) => {
      const q = parse(z.object({ warehouseCode: z.string().max(10).optional() }), req.query);
      return { asOf: new Date().toISOString(), data: await many(pool, `SELECT w.code AS warehouse_code, i.item_code, i.name_en, v.qty, v.avg_cost, v.total_value
        FROM item_valuation v JOIN item i ON i.id = v.item_id JOIN warehouse w ON w.id = v.warehouse_id WHERE v.qty <> 0 AND ($1::text IS NULL OR w.code = $1)
        ORDER BY w.code, i.item_code`, [q.warehouseCode ?? null]) };
    });
    api.get("/api/integration/v1/journals", { config: rl, preHandler: scope("erp.journals"), schema: S("Posted journals awaiting transfer to the ERP") }, async (req) => {
      const q = parse(z.object({ status: z.enum(["posted", "exported"]).default("posted"), period: z.string().regex(/^\d{4}-\d{2}$/).optional() }), req.query);
      const jes = await many(pool, `SELECT id, je_no, period, je_date, source, description, status, total_debit, erp_ref FROM journal_entry
        WHERE status = $1 AND ($2::text IS NULL OR period = $2) ORDER BY je_no LIMIT 200`, [q.status, q.period ?? null]);
      for (const j of jes) {
        j.lines = await many(pool, `SELECT l.line_no, l.account_code, w.code AS warehouse_code, o.code AS cost_center, l.debit, l.credit, l.memo FROM journal_line l
          LEFT JOIN warehouse w ON w.id = l.warehouse_id LEFT JOIN org_unit o ON o.id = l.org_unit_id WHERE l.je_id = $1 ORDER BY l.line_no`, [j.id]);
      }
      return { data: jes };
    });
    api.post("/api/integration/v1/journals/:jeNo/ack", { config: rl, preHandler: scope("erp.journals"), schema: S("ERP acknowledges a journal (marks it exported)") }, async (req) => {
      const { jeNo } = parse(z.object({ jeNo: z.string().max(40) }), req.params);
      const b = parse(z.object({ erpRef: z.string().trim().min(1).max(60) }), req.body);
      const je = await one(pool, "SELECT id, status, erp_ref FROM journal_entry WHERE je_no = $1", [jeNo]);
      if (!je) throw E.notFound("journal");
      if (je.status === "exported" && je.erp_ref === b.erpRef) return { ok: true, idempotent: true };
      await withTx(ctx(req), (c) => markExported(c, null, je.id, b.erpRef));
      return { ok: true };
    });
    const poBody = z.object({ poNo: z.string().trim().min(3).max(40), etimadRef: z.string().max(60).nullable().optional(), supplierCode: z.string().max(20),
      warehouseCode: z.string().max(10), expectedDate: dateStr.nullable().optional(), notes: z.string().max(500).nullable().optional(),
      lines: z.array(z.object({ itemCode: z.string().max(60), qty: z.number().positive(), unitPrice: z.number().min(0), vatRate: z.number().min(0).max(100).optional() })).min(1).max(500) });
    const poIn = async (req: FastifyRequest, rep: any) => {
      const b = parse(poBody, req.body);
      const ex = await one(pool, "SELECT id, po_no, status FROM purchase_order WHERE po_no = $1", [b.poNo]);
      if (ex) return { ...ex, idempotent: true };
      const supplierId = await byCode("supplier", b.supplierCode), warehouseId = await byCode("warehouse", b.warehouseCode);
      const lines: { itemId: string; qty: number; unitPrice: number; vatRate?: number }[] = [];
      for (const l of b.lines) lines.push({ itemId: await itemByCode(l.itemCode), qty: l.qty, unitPrice: l.unitPrice, vatRate: l.vatRate });
      const po = await withTx(ctx(req), (c) => createPo(c, req.integration!.userId, { poNo: b.poNo, etimadRef: b.etimadRef ?? null, supplierId, warehouseId,
        expectedDate: b.expectedDate ?? null, source: "erp", notes: b.notes ?? null, lines }));
      rep.status(201);
      return { id: po.id, po_no: po.po_no, status: po.status };
    };
    api.post("/api/integration/v1/purchase-orders", { config: rl, preHandler: scope("erp.po"), schema: S("ERP: create a purchase order (idempotent on poNo)") }, poIn);
    api.post("/api/integration/v1/etimad/awards", { config: rl, preHandler: scope("etimad.po"), schema: S("Etimad: awarded purchase order (idempotent on poNo)") }, poIn);

    // ---------------------------------------------------------------- Etimad: approved requisitions (tendering)
    api.get("/api/integration/v1/etimad/requisitions", { config: rl, preHandler: scope("etimad.pr"), schema: S("Approved purchase requisitions for tendering") }, async () => {
      const prs = await many(pool, `SELECT p.id, p.pr_no, w.code AS warehouse_code, p.estimated_value, p.needed_by, p.status, p.updated_at FROM purchase_requisition p
        JOIN warehouse w ON w.id = p.warehouse_id WHERE p.status = 'approved' ORDER BY p.pr_no`);
      for (const p of prs) {
        p.lines = await many(pool, `SELECT l.line_no, i.item_code, i.name_ar, i.name_en, u.code AS uom, l.qty, l.est_unit_cost FROM pr_line l JOIN item i ON i.id = l.item_id
          JOIN uom u ON u.id = i.base_uom_id WHERE l.pr_id = $1 ORDER BY l.line_no`, [p.id]);
      }
      return { data: prs };
    });

    // ---------------------------------------------------------------- CMMS
    api.post("/api/integration/v1/cmms/material-requests", { config: rl, preHandler: scope("cmms.mr"), schema: S("CMMS: material request for a work order (submitted for approval)") },
      async (req, rep) => {
        const b = parse(z.object({ workOrderRef: z.string().trim().min(3).max(40), requesterEmployeeNo: z.string().max(20), warehouseCode: z.string().max(10),
          neededBy: dateStr.nullable().optional(), purpose: z.string().max(500).optional(),
          lines: z.array(z.object({ itemCode: z.string().max(60), qty: z.number().positive() })).min(1).max(100) }), req.body);
        const ex = await one(pool, "SELECT mr_no, status FROM material_request WHERE work_order_ref = $1 AND status NOT IN ('cancelled','rejected')", [b.workOrderRef]);
        if (ex) return { ...ex, idempotent: true };
        const u = await one(pool, "SELECT id, org_unit_id FROM app_user WHERE employee_no = $1 AND status = 'active' AND deleted_at IS NULL", [b.requesterEmployeeNo]);
        if (!u) throw E.invalid([{ path: "requesterEmployeeNo", message: "unknown_employee" }]);
        const warehouseId = await byCode("warehouse", b.warehouseCode);
        const lines: { itemId: string; qty: number }[] = [];
        for (const l of b.lines) lines.push({ itemId: await itemByCode(l.itemCode), qty: l.qty });
        // created and submitted in the requester's name; the audit trail records the integration request id
        const out = await withTx(ctx(req, u.id), async (c) => {
          const d = await mr.createDraft(c, { id: u.id, orgUnitId: u.org_unit_id }, { requestType: "work_order", warehouseId, workOrderRef: b.workOrderRef, neededBy: b.neededBy ?? null,
            purpose: b.purpose ?? `أمر عمل ${b.workOrderRef}`, lines });
          const s = await mr.submit(c, u.id, d.id, true);
          return { mr_no: d.mr_no, id: d.id, status: (s as any)?.status ?? "pending_approval" };
        });
        rep.status(201); return out;
      });
    api.get("/api/integration/v1/cmms/material-requests/:ref", { config: rl, preHandler: scope("cmms.mr"), schema: S("Status of the material request for a work order") }, async (req) => {
      const { ref } = parse(z.object({ ref: z.string().max(40) }), req.params);
      const m = await one(pool, `SELECT id, mr_no, work_order_ref, status, issued_value, delivered_at FROM material_request WHERE work_order_ref = $1 OR mr_no = $1 ORDER BY created_at DESC LIMIT 1`, [ref]);
      if (!m) throw E.notFound("material request");
      const lines = await many(pool, `SELECT i.item_code, l.qty_requested, l.qty_approved, l.qty_issued FROM mr_line l JOIN item i ON i.id = l.item_id WHERE l.mr_id = $1 AND l.deleted_at IS NULL ORDER BY l.line_no`, [m.id]);
      const { id: _id, ...rest } = m;
      return { ...rest, lines };
    });

    // ---------------------------------------------------------------- HR
    api.post("/api/integration/v1/hr/exits", { config: rl, preHandler: scope("hr.clearance"), schema: S("HR: employee exit → clearance check") }, async (req, rep) => {
      const b = parse(z.object({ employeeNo: z.string().max(20), reason: z.enum(["resignation", "transfer", "retirement", "end_of_contract", "other"]), lastDay: dateStr.optional() }), req.body);
      const u = await one(pool, "SELECT id FROM app_user WHERE employee_no = $1 AND deleted_at IS NULL", [b.employeeNo]);
      if (!u) throw E.invalid([{ path: "employeeNo", message: "unknown_employee" }]);
      const cl = await withTx(ctx(req), (c) => requestClearance(c, null, { employeeId: u.id, reason: b.reason, notes: b.lastDay ? `آخر يوم عمل ${b.lastDay}` : undefined, source: "hr" }));
      rep.status(201);
      return { cl_no: cl.cl_no, status: cl.status, certificate_no: cl.certificate_no, blockers: cl.blockers };
    });
  });
}

