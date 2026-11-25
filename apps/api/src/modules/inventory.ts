// Stock queries (balances, item card / ledger, availability), put-away tasks, scan lookups.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, one, many, withTx } from "../db/pool.ts";
import { E } from "../lib/errors.ts";
import { parse, uuid, idParam } from "../lib/http.ts";
import { requirePerm, txCtx, warehouseScope, assertWarehouseInScope, can } from "../auth/context.ts";
import { completePutaway } from "../services/inbound.ts";
import { suggestBins } from "../services/putaway.ts";
import { freeStock } from "../services/requests.ts";

export async function inventoryRoutes(app: FastifyInstance) {
  // ---- stock by item (all warehouses in scope)
  app.get("/api/items/:id/stock", { preHandler: requirePerm("item.read"), schema: { tags: ["inventory"], summary: "Balances by warehouse / bin / lot" } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const scope = can(req.user, "warehouse.read") ? warehouseScope(req.user!, "warehouse.read") : "all";
    const balances = await many(pool,
      `SELECT b.*, b.qty_on_hand - b.qty_reserved AS qty_free, l.full_code, w.code AS warehouse_code, w.name_ar AS warehouse_name_ar, w.name_en AS warehouse_name_en,
              sl.lot_no, sl.serial_no, sl.expiry_date, z.zone_type
         FROM stock_balance b JOIN location l ON l.id = b.location_id JOIN warehouse w ON w.id = b.warehouse_id
         JOIN location r ON r.id = l.parent_id JOIN location a ON a.id = r.parent_id JOIN location z ON z.id = a.parent_id
         LEFT JOIN stock_lot sl ON sl.id = b.lot_id
        WHERE b.item_id = $1 AND b.qty_on_hand > 0 ${scope === "all" ? "" : "AND b.warehouse_id = ANY($2)"}
        ORDER BY w.code, sl.expiry_date NULLS LAST, l.full_code`, scope === "all" ? [id] : [id, scope]);
    const valuation = await many(pool,
      `SELECT v.*, w.code AS warehouse_code, w.name_ar AS warehouse_name_ar, w.name_en AS warehouse_name_en
         FROM item_valuation v JOIN warehouse w ON w.id = v.warehouse_id WHERE v.item_id = $1 ${scope === "all" ? "" : "AND v.warehouse_id = ANY($2)"}`,
      scope === "all" ? [id] : [id, scope]);
    // requesters see quantities but not values
    const showValue = can(req.user, "valuation.manage") || can(req.user, "warehouse.read");
    return { balances, valuation: showValue ? valuation : valuation.map(({ total_value, avg_cost, ...v }) => v) };
  });

  app.get("/api/items/:id/ledger", { preHandler: requirePerm("warehouse.read", "audit.read"), schema: { tags: ["inventory"], summary: "Item card (stock ledger)" } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ warehouseId: uuid.optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const scope = warehouseScope(req.user!, can(req.user, "warehouse.read") ? "warehouse.read" : "audit.read");
    const p: unknown[] = [id]; const w = ["s.item_id = $1"];
    if (q.warehouseId) { p.push(q.warehouseId); w.push(`s.warehouse_id = $${p.length}`); }
    if (scope !== "all") { p.push(scope); w.push(`s.warehouse_id = ANY($${p.length})`); }
    const total = (await one(pool, `SELECT count(*)::int AS n FROM stock_ledger s WHERE ${w.join(" AND ")}`, p))!.n;
    const data = await many(pool,
      `SELECT s.*, l.full_code, w.code AS warehouse_code, sl.lot_no, sl.serial_no, u.name_ar AS posted_by_ar, u.name_en AS posted_by_en
         FROM stock_ledger s JOIN location l ON l.id = s.location_id JOIN warehouse w ON w.id = s.warehouse_id
         LEFT JOIN stock_lot sl ON sl.id = s.lot_id LEFT JOIN app_user u ON u.id = s.posted_by
        WHERE ${w.join(" AND ")} ORDER BY s.id DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, p);
    return { data, total, page: q.page, pageSize: q.pageSize };
  });

  // ---- availability for request forms
  app.get("/api/stock/available", { preHandler: requirePerm("item.read"), schema: { tags: ["inventory"] } }, async (req) => {
    const q = parse(z.object({ itemId: uuid, warehouseId: uuid }), req.query);
    return { itemId: q.itemId, warehouseId: q.warehouseId, available: await freeStock(pool as any, q.itemId, q.warehouseId) };
  });

  // ---- stock overview (by warehouse, with policy breaches)
  app.get("/api/stock", { preHandler: requirePerm("warehouse.read"), schema: { tags: ["inventory"], summary: "Stock on hand per item & warehouse" } }, async (req) => {
    const q = parse(z.object({ warehouseId: uuid.optional(), q: z.string().trim().max(100).optional(), below: z.enum(["min", "rop", "zero"]).optional(),
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(25) }), req.query);
    const scope = warehouseScope(req.user!, "warehouse.read");
    const p: unknown[] = []; const w = ["i.deleted_at IS NULL", "i.item_type <> 'non_stock'"];
    if (q.warehouseId) { assertWarehouseInScope(req.user!, "warehouse.read", q.warehouseId); p.push(q.warehouseId); w.push(`wh.id = $${p.length}`); }
    else if (scope !== "all") { p.push(scope); w.push(`wh.id = ANY($${p.length})`); }
    if (q.q) { p.push(q.q); w.push(`(i.item_code ILIKE '%'||$${p.length}||'%' OR i.normalized_name LIKE '%'||normalize_ar($${p.length})||'%' OR lower(i.name_en) LIKE '%'||lower($${p.length})||'%')`); }
    const base = `FROM item i JOIN item_warehouse_policy pol ON pol.item_id = i.id AND pol.deleted_at IS NULL JOIN warehouse wh ON wh.id = pol.warehouse_id
      LEFT JOIN LATERAL (SELECT coalesce(sum(b.qty_on_hand),0) AS on_hand, coalesce(sum(b.qty_reserved),0) AS reserved,
                                coalesce(sum(b.qty_on_hand) FILTER (WHERE b.stock_status = 'available'),0) - coalesce(sum(b.qty_reserved),0) AS free
                           FROM stock_balance b WHERE b.item_id = i.id AND b.warehouse_id = wh.id) s ON true
      LEFT JOIN item_valuation v ON v.item_id = i.id AND v.warehouse_id = wh.id
      WHERE ${w.join(" AND ")}${q.below === "min" ? " AND s.on_hand < pol.min_qty" : q.below === "rop" ? " AND s.free <= coalesce(pol.reorder_point, pol.min_qty)" : q.below === "zero" ? " AND s.on_hand = 0" : ""}`;
    const total = (await one(pool, `SELECT count(*)::int AS n ${base}`, p))!.n;
    const data = await many(pool,
      `SELECT i.id AS item_id, i.item_code, i.name_ar, i.name_en, i.ved_class, wh.id AS warehouse_id, wh.code AS warehouse_code,
              s.on_hand, s.reserved, s.free, pol.min_qty, pol.max_qty, pol.reorder_point, pol.safety_stock, v.avg_cost, v.total_value
       ${base} ORDER BY (s.free <= coalesce(pol.reorder_point, pol.min_qty)) DESC, i.item_code LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, p);
    return { data, total, page: q.page, pageSize: q.pageSize };
  });

  // ---- bin contents (scan a bin)
  app.get("/api/locations/:id/stock", { preHandler: requirePerm("warehouse.read"), schema: { tags: ["inventory"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const l = await one(pool, "SELECT warehouse_id FROM location WHERE id = $1", [id]);
    if (!l) throw E.notFound("location");
    assertWarehouseInScope(req.user!, "warehouse.read", l.warehouse_id);
    return { data: await many(pool, `SELECT b.*, i.item_code, i.name_ar, i.name_en, sl.lot_no, sl.serial_no, sl.expiry_date
                                       FROM stock_balance b JOIN item i ON i.id = b.item_id LEFT JOIN stock_lot sl ON sl.id = b.lot_id
                                      WHERE b.location_id = $1 AND b.qty_on_hand > 0 ORDER BY i.item_code`, [id]) };
  });

  // ---- put-away tasks
  app.get("/api/putaway-tasks", { preHandler: requirePerm("putaway.execute", "receipt.execute"), schema: { tags: ["inventory"] } }, async (req) => {
    const q = parse(z.object({ status: z.enum(["open", "done", "cancelled"]).default("open"), receiptId: uuid.optional() }), req.query);
    const scope = warehouseScope(req.user!, "putaway.execute");
    const p: unknown[] = [q.status]; const w = ["t.status = $1"];
    if (q.receiptId) { p.push(q.receiptId); w.push(`t.receipt_id = $${p.length}`); }
    if (scope !== "all") { p.push(scope); w.push(`t.warehouse_id = ANY($${p.length})`); }
    return { data: await many(pool,
      `SELECT t.*, i.item_code, i.name_ar, i.name_en, u.code AS uom_code, sl.lot_no, sl.serial_no, sl.expiry_date,
              f.full_code AS from_code, s.full_code AS suggested_code, d.full_code AS to_code, r.receipt_no, r.grn_no
         FROM putaway_task t JOIN item i ON i.id = t.item_id JOIN uom u ON u.id = i.base_uom_id
         JOIN location f ON f.id = t.from_location_id LEFT JOIN location s ON s.id = t.suggested_location_id
         LEFT JOIN location d ON d.id = t.to_location_id LEFT JOIN stock_lot sl ON sl.id = t.lot_id LEFT JOIN receipt r ON r.id = t.receipt_id
        WHERE ${w.join(" AND ")} ORDER BY t.created_at LIMIT 300`, p) };
  });

  app.get("/api/putaway-tasks/:id/suggestions", { preHandler: requirePerm("putaway.execute"), schema: { tags: ["inventory"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const t = await one(pool, "SELECT * FROM putaway_task WHERE id = $1", [id]);
    if (!t) throw E.notFound("put-away task");
    assertWarehouseInScope(req.user!, "putaway.execute", t.warehouse_id);
    return { data: await suggestBins(pool, { itemId: t.item_id, warehouseId: t.warehouse_id, qty: Number(t.qty), excludeLocationId: t.from_location_id, limit: 5 }) };
  });

  app.post("/api/putaway-tasks/:id/complete", { preHandler: requirePerm("putaway.execute"), schema: { tags: ["inventory"], summary: "Directed put-away (scan bin)" } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ scannedLocation: z.string().trim().min(1).max(80), overrideReason: z.string().trim().max(300).optional() }), req.body);
    const t = await one(pool, "SELECT warehouse_id FROM putaway_task WHERE id = $1", [id]);
    if (!t) throw E.notFound("put-away task");
    assertWarehouseInScope(req.user!, "putaway.execute", t.warehouse_id);
    return withTx(txCtx(req), (c) => completePutaway(c, req.user!.id, id, b.scannedLocation, b.overrideReason));
  });
}
