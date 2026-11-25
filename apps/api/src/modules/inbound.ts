// Inbound REST endpoints: purchase orders, ASN (incl. supplier portal), receipts, inspection, GRN, invoices.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, one, many, withTx } from "../db/pool.ts";
import { E } from "../lib/errors.ts";
import { parse, uuid, idParam, listQuery } from "../lib/http.ts";
import { requirePerm, txCtx, warehouseScope, assertWarehouseInScope, can, hasRole } from "../auth/context.ts";
import * as inbound from "../services/inbound.ts";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function inboundRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- purchase orders
  app.get("/api/purchase-orders", { preHandler: requirePerm("po.read"), schema: { tags: ["inbound"] } }, async (req) => {
    const q = parse(listQuery.extend({ status: z.string().optional(), supplierId: uuid.optional() }), req.query);
    const u = req.user!;
    const p: unknown[] = []; const w: string[] = [];
    if (hasRole(u, "SUP")) { p.push(u.supplierId); w.push(`po.supplier_id = $${p.length}`); }        // supplier portal: own POs only
    else { const s = warehouseScope(u, "po.read"); if (s !== "all") { p.push(s); w.push(`po.warehouse_id = ANY($${p.length})`); } }
    if (q.status) { p.push(q.status); w.push(`po.status = ANY(string_to_array($${p.length}, ','))`); }
    if (q.supplierId) { p.push(q.supplierId); w.push(`po.supplier_id = $${p.length}`); }
    if (q.q) { p.push(`%${q.q}%`); w.push(`(po.po_no ILIKE $${p.length} OR po.etimad_ref ILIKE $${p.length} OR s.name_ar ILIKE $${p.length} OR s.name_en ILIKE $${p.length})`); }
    const where = w.length ? `WHERE ${w.join(" AND ")}` : "";
    const total = (await one(pool, `SELECT count(*)::int AS n FROM purchase_order po JOIN supplier s ON s.id = po.supplier_id ${where}`, p))!.n;
    const data = await many(pool, `SELECT po.*, s.name_ar AS supplier_name_ar, s.name_en AS supplier_name_en, wh.code AS warehouse_code,
        wh.name_ar AS warehouse_name_ar, wh.name_en AS warehouse_name_en,
        (SELECT count(*)::int FROM po_line pl WHERE pl.po_id = po.id) AS lines
      FROM purchase_order po JOIN supplier s ON s.id = po.supplier_id JOIN warehouse wh ON wh.id = po.warehouse_id ${where}
      ORDER BY po.created_at DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, p);
    return { data, total, page: q.page, pageSize: q.pageSize };
  });

  app.get("/api/purchase-orders/:id", { preHandler: requirePerm("po.read"), schema: { tags: ["inbound"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const po = await one(pool, `SELECT po.*, s.name_ar AS supplier_name_ar, s.name_en AS supplier_name_en, s.vat_number, wh.name_ar AS warehouse_name_ar, wh.name_en AS warehouse_name_en
                                  FROM purchase_order po JOIN supplier s ON s.id = po.supplier_id JOIN warehouse wh ON wh.id = po.warehouse_id WHERE po.id = $1`, [id]);
    if (!po) throw E.notFound("purchase order");
    if (hasRole(req.user, "SUP") && po.supplier_id !== req.user!.supplierId) throw E.outOfScope();
    if (!hasRole(req.user, "SUP")) assertWarehouseInScope(req.user!, "po.read", po.warehouse_id);
    const [lines, asns, receipts, invoices] = await Promise.all([
      many(pool, `SELECT pl.*, i.item_code, i.name_ar, i.name_en, i.track_batch, i.track_serial, i.track_expiry, u.code AS uom_code, u.name_ar AS uom_name_ar, u.name_en AS uom_name_en
                    FROM po_line pl JOIN item i ON i.id = pl.item_id JOIN uom u ON u.id = pl.uom_id WHERE pl.po_id = $1 ORDER BY pl.line_no`, [id]),
      many(pool, "SELECT * FROM asn WHERE po_id = $1 ORDER BY created_at DESC", [id]),
      many(pool, "SELECT id, receipt_no, grn_no, status, arrived_at, grn_value FROM receipt WHERE po_id = $1 ORDER BY created_at DESC", [id]),
      hasRole(req.user, "SUP") ? [] : many(pool, "SELECT * FROM supplier_invoice WHERE po_id = $1 ORDER BY created_at DESC", [id]),
    ]);
    return { ...po, lines, asns, receipts, invoices };
  });

  const poBody = z.object({
    supplierId: uuid, warehouseId: uuid, etimadRef: z.string().trim().max(40).nullable().optional(), expectedDate: dateStr.nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
    lines: z.array(z.object({ itemId: uuid, uomId: uuid.optional(), qty: z.number().positive(), unitPrice: z.number().min(0), vatRate: z.number().min(0).max(100).optional() })).min(1).max(200),
  });
  app.post("/api/purchase-orders", { preHandler: requirePerm("po.manage"), schema: { tags: ["inbound"], summary: "Create PO (manual; ERP sync uses the same rules)" } }, async (req, rep) => {
    const b = parse(poBody, req.body);
    const out = await withTx(txCtx(req), (c) => inbound.createPo(c, req.user!.id, b));
    rep.status(201); return out;
  });

  // ---------------------------------------------------------------- ASN
  const asnBody = z.object({
    poId: uuid, expectedAt: z.string().datetime({ offset: true }), vehicleNo: z.string().max(20).optional(), driverName: z.string().max(80).optional(),
    driverMobile: z.string().max(20).optional(), supplierDeliveryRef: z.string().max(40).optional(),
    lines: z.array(z.object({ poLineId: uuid, qty: z.number().positive(), lotNo: z.string().max(40).optional(), serialNos: z.array(z.string().max(60)).max(500).optional(),
      mfgDate: dateStr.optional(), expiryDate: dateStr.optional() })).min(1),
  });
  app.post("/api/asns", { preHandler: requirePerm("asn.submit", "receipt.execute"), schema: { tags: ["inbound"], summary: "Submit ASN (supplier portal or storekeeper)" } }, async (req, rep) => {
    const b = parse(asnBody, req.body);
    const u = req.user!;
    const out = await withTx(txCtx(req), async (c) => {
      if (!hasRole(u, "SUP")) {
        const po = await one(c, "SELECT warehouse_id FROM purchase_order WHERE id = $1", [b.poId]);
        if (!po) throw E.notFound("purchase order");
        assertWarehouseInScope(u, "receipt.execute", po.warehouse_id);
      }
      return inbound.createAsn(c, u.id, b, hasRole(u, "SUP") ? u.supplierId : null);
    });
    rep.status(201); return out;
  });

  app.get("/api/asns", { preHandler: requirePerm("asn.read", "asn.submit"), schema: { tags: ["inbound"] } }, async (req) => {
    const u = req.user!;
    const q = parse(z.object({ status: z.string().optional() }), req.query);
    const p: unknown[] = []; const w: string[] = [];
    if (hasRole(u, "SUP")) { p.push(u.supplierId); w.push(`a.supplier_id = $${p.length}`); }
    else { const s = warehouseScope(u, "asn.read"); if (s !== "all") { p.push(s); w.push(`po.warehouse_id = ANY($${p.length})`); } }
    if (q.status) { p.push(q.status); w.push(`a.status = ANY(string_to_array($${p.length}, ','))`); }
    return { data: await many(pool, `SELECT a.*, po.po_no, po.warehouse_id, s.name_ar AS supplier_name_ar, s.name_en AS supplier_name_en,
        (SELECT coalesce(sum(qty),0) FROM asn_line WHERE asn_id = a.id) AS total_qty
      FROM asn a JOIN purchase_order po ON po.id = a.po_id JOIN supplier s ON s.id = a.supplier_id ${w.length ? "WHERE " + w.join(" AND ") : ""}
      ORDER BY a.expected_at DESC LIMIT 200`, p) };
  });

  // ---------------------------------------------------------------- receipts
  app.get("/api/receipts", { preHandler: requirePerm("receipt.execute", "inspection.execute", "grn.post", "po.read"), schema: { tags: ["inbound"] } }, async (req) => {
    const q = parse(listQuery.extend({ status: z.string().optional(), mine: z.coerce.boolean().optional() }), req.query);
    const u = req.user!;
    const p: unknown[] = []; const w: string[] = [];
    const s = warehouseScope(u, can(u, "receipt.execute") ? "receipt.execute" : can(u, "inspection.execute") ? "inspection.execute" : "po.read");
    if (s !== "all") { p.push(s); w.push(`r.warehouse_id = ANY($${p.length})`); }
    if (q.status) { p.push(q.status); w.push(`r.status = ANY(string_to_array($${p.length}, ','))`); }
    if (q.mine) { p.push(u.id); w.push(`EXISTS (SELECT 1 FROM inspection_member m WHERE m.receipt_id = r.id AND m.user_id = $${p.length})`); }
    if (q.q) { p.push(`%${q.q}%`); w.push(`(r.receipt_no ILIKE $${p.length} OR r.grn_no ILIKE $${p.length} OR po.po_no ILIKE $${p.length})`); }
    const where = w.length ? `WHERE ${w.join(" AND ")}` : "";
    const total = (await one(pool, `SELECT count(*)::int AS n FROM receipt r JOIN purchase_order po ON po.id = r.po_id ${where}`, p))!.n;
    const data = await many(pool, `SELECT r.*, po.po_no, po.etimad_ref, s.name_ar AS supplier_name_ar, s.name_en AS supplier_name_en, wh.code AS warehouse_code,
        (SELECT count(*)::int FROM receipt_line rl WHERE rl.receipt_id = r.id) AS lines,
        (SELECT count(*)::int FROM putaway_task t WHERE t.receipt_id = r.id AND t.status = 'open') AS open_putaway
      FROM receipt r JOIN purchase_order po ON po.id = r.po_id JOIN supplier s ON s.id = po.supplier_id JOIN warehouse wh ON wh.id = r.warehouse_id ${where}
      ORDER BY r.created_at DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, p);
    return { data, total, page: q.page, pageSize: q.pageSize };
  });

  app.get("/api/receipts/:id", { preHandler: requirePerm("receipt.execute", "inspection.execute", "grn.post", "po.read"), schema: { tags: ["inbound"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await one(pool, `SELECT r.*, po.po_no, po.etimad_ref, s.name_ar AS supplier_name_ar, s.name_en AS supplier_name_en, wh.code AS warehouse_code,
        wh.name_ar AS warehouse_name_ar, wh.name_en AS warehouse_name_en, d.full_code AS dock_code, a.asn_no,
        rb.name_ar AS received_by_ar, rb.name_en AS received_by_en
      FROM receipt r JOIN purchase_order po ON po.id = r.po_id JOIN supplier s ON s.id = po.supplier_id JOIN warehouse wh ON wh.id = r.warehouse_id
      JOIN location d ON d.id = r.dock_location_id LEFT JOIN asn a ON a.id = r.asn_id LEFT JOIN app_user rb ON rb.id = r.received_by WHERE r.id = $1`, [id]);
    if (!r) throw E.notFound("receipt");
    const member = await one(pool, "SELECT 1 FROM inspection_member WHERE receipt_id = $1 AND user_id = $2", [id, req.user!.id]);
    if (!member) assertWarehouseInScope(req.user!, can(req.user, "receipt.execute") ? "receipt.execute" : can(req.user, "grn.post") ? "grn.post" : "po.read", r.warehouse_id);
    const [lines, members, tasks, events, attachments] = await Promise.all([
      many(pool, `SELECT rl.*, i.item_code, i.name_ar, i.name_en, i.track_batch, i.track_serial, i.track_expiry, pl.line_no, pl.qty_ordered, pl.factor_to_base,
                         u.code AS uom_code, u.name_ar AS uom_name_ar, u.name_en AS uom_name_en
                    FROM receipt_line rl JOIN item i ON i.id = rl.item_id JOIN po_line pl ON pl.id = rl.po_line_id JOIN uom u ON u.id = pl.uom_id
                   WHERE rl.receipt_id = $1 ORDER BY pl.line_no`, [id]),
      many(pool, `SELECT m.*, u.name_ar, u.name_en FROM inspection_member m JOIN app_user u ON u.id = m.user_id WHERE m.receipt_id = $1 ORDER BY m.is_chair DESC, u.name_ar`, [id]),
      many(pool, `SELECT t.*, i.item_code, s.full_code AS suggested_code, d.full_code AS to_code, sl.lot_no, sl.serial_no
                    FROM putaway_task t JOIN item i ON i.id = t.item_id LEFT JOIN location s ON s.id = t.suggested_location_id
                    LEFT JOIN location d ON d.id = t.to_location_id LEFT JOIN stock_lot sl ON sl.id = t.lot_id WHERE t.receipt_id = $1 ORDER BY t.task_no`, [id]),
      many(pool, `SELECT e.*, u.name_ar AS actor_ar, u.name_en AS actor_en FROM doc_event e LEFT JOIN app_user u ON u.id = e.actor_id
                   WHERE e.doc_type = 'RCV' AND e.doc_id = $1 ORDER BY e.id`, [id]),
      many(pool, "SELECT id, category, file_name, mime_type, size_bytes, created_at FROM attachment WHERE owner_type = 'receipt' AND owner_id = $1 AND deleted_at IS NULL", [id]),
    ]);
    return { ...r, lines, members, putawayTasks: tasks, events, attachments, isMember: !!member };
  });

  const scoped = async (req: any, perm: any, id: string) => {
    const r = await one(pool, "SELECT warehouse_id FROM receipt WHERE id = $1", [id]);
    if (!r) throw E.notFound("receipt");
    assertWarehouseInScope(req.user, perm, r.warehouse_id);
  };

  app.post("/api/receipts", { preHandler: requirePerm("receipt.execute"), schema: { tags: ["inbound"], summary: "Register arrival (from ASN or PO)" } }, async (req, rep) => {
    const b = parse(z.object({ poId: uuid.optional(), asnId: uuid.optional(), dockLocationId: uuid.optional(), supplierDeliveryRef: z.string().max(40).optional(),
      notes: z.string().max(500).optional() }), req.body);
    const out = await withTx(txCtx(req), async (c) => {
      const po = await one(c, b.asnId ? "SELECT po.warehouse_id FROM asn a JOIN purchase_order po ON po.id = a.po_id WHERE a.id = $1" : "SELECT warehouse_id FROM purchase_order WHERE id = $1",
        [b.asnId ?? b.poId]);
      if (!po) throw E.notFound("PO/ASN");
      assertWarehouseInScope(req.user!, "receipt.execute", po.warehouse_id);
      return inbound.arrive(c, req.user!.id, b);
    });
    rep.status(201); return out;
  });

  app.post("/api/receipts/:id/quantity-check", { preHandler: requirePerm("receipt.execute"), schema: { tags: ["inbound"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    await scoped(req, "receipt.execute", id);
    const b = parse(z.object({ lines: z.array(z.object({ lineId: uuid, qtyReceived: z.number().min(0), qtyDamaged: z.number().min(0).optional(),
      lotNo: z.string().trim().max(40).nullable().optional(), serialNos: z.array(z.string().trim().min(1).max(60)).max(1000).nullable().optional(),
      mfgDate: dateStr.nullable().optional(), expiryDate: dateStr.nullable().optional() })).min(1) }), req.body);
    await withTx(txCtx(req), (c) => inbound.quantityCheck(c, req.user!.id, id, b.lines));
    return { ok: true };
  });

  app.post("/api/receipts/:id/inspection", { preHandler: requirePerm("receipt.execute"), schema: { tags: ["inbound"], summary: "Start committee inspection" } }, async (req) => {
    const { id } = parse(idParam, req.params);
    await scoped(req, "receipt.execute", id);
    const b = parse(z.object({ memberIds: z.array(uuid).min(1).max(7), chairId: uuid }), req.body);
    await withTx(txCtx(req), (c) => inbound.startInspection(c, req.user!.id, id, b.memberIds, b.chairId));
    return { ok: true };
  });

  app.post("/api/receipts/:id/inspection/results", { preHandler: requirePerm("inspection.execute"), schema: { tags: ["inbound"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ lines: z.array(z.object({ lineId: uuid, qtyAccepted: z.number().min(0), rejectReason: z.string().max(300).nullable().optional(),
      notes: z.string().max(500).nullable().optional() })).min(1) }), req.body);
    await withTx(txCtx(req), (c) => inbound.recordInspection(c, req.user!.id, id, b.lines));
    return { ok: true };
  });

  app.post("/api/receipts/:id/inspection/sign", { preHandler: requirePerm("inspection.execute"), schema: { tags: ["inbound"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ decision: z.enum(["agree", "object"]), comment: z.string().max(500).optional() }), req.body);
    await withTx(txCtx(req), (c) => inbound.signInspection(c, req.user!.id, id, b.decision, b.comment));
    return { ok: true };
  });

  app.post("/api/receipts/:id/grn", { preHandler: requirePerm("grn.post"), schema: { tags: ["inbound"], summary: "Post GRN (books accepted stock, creates put-away tasks)" } }, async (req) => {
    const { id } = parse(idParam, req.params);
    await scoped(req, "grn.post", id);
    return withTx(txCtx(req), (c) => inbound.postGrn(c, req.user!.id, id));
  });

  // ---------------------------------------------------------------- invoices & 3-way match
  app.get("/api/invoices", { preHandler: requirePerm("invoice.manage"), schema: { tags: ["inbound"] } }, async () => ({
    data: await many(pool, `SELECT inv.*, po.po_no, s.name_ar AS supplier_name_ar, s.name_en AS supplier_name_en
                              FROM supplier_invoice inv JOIN purchase_order po ON po.id = inv.po_id JOIN supplier s ON s.id = inv.supplier_id
                             ORDER BY inv.created_at DESC LIMIT 200`),
  }));
  app.post("/api/invoices", { preHandler: requirePerm("invoice.manage"), schema: { tags: ["inbound"], summary: "Register supplier invoice and run 3-way match" } }, async (req, rep) => {
    const b = parse(z.object({ poId: uuid, invoiceNo: z.string().trim().min(1).max(40), invoiceDate: dateStr,
      lines: z.array(z.object({ poLineId: uuid, qty: z.number().positive(), unitPrice: z.number().min(0) })).min(1) }), req.body);
    const out = await withTx(txCtx(req), (c) => inbound.createInvoice(c, req.user!.id, b));
    rep.status(201); return out;
  });
}
