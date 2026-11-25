// Catalogue reference data: item categories (Category > Group), units of measure, suppliers.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, one, many, withTx } from "../db/pool.ts";
import { E } from "../lib/errors.ts";
import { parse, listQuery, orderBy, uuid, idParam, nameAr, nameEn, versionField } from "../lib/http.ts";
import { requirePerm, txCtx } from "../auth/context.ts";

async function versioned(c: any, table: string, id: string, version: number) {
  const cur = await one(c, `SELECT * FROM ${table} WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id]);
  if (!cur) throw E.notFound(table);
  if (cur.version !== version) throw E.stale();
  return cur;
}

function updateSql(table: string, map: Record<string, string>, body: Record<string, unknown>) {
  const sets: string[] = []; const p: unknown[] = [];
  for (const [k, col] of Object.entries(map)) if (body[k] !== undefined) { p.push(body[k]); sets.push(`${col} = $${p.length + 1}`); }
  return { sql: `UPDATE ${table} SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params: p, empty: sets.length === 0 };
}

export async function catalogRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- categories
  app.get("/api/categories", { preHandler: requirePerm("item.read"), schema: { tags: ["catalog"], summary: "Category > Group tree with item counts" } }, async () => {
    const rows = await many(pool,
      `SELECT c.*, (SELECT count(*)::int FROM item i WHERE i.group_id = c.id AND i.deleted_at IS NULL) AS item_count
         FROM item_category c WHERE c.deleted_at IS NULL ORDER BY c.level, c.code`);
    const cats = rows.filter((r) => r.level === "category").map((c) => ({ ...c, groups: rows.filter((g) => g.parent_id === c.id) }));
    cats.forEach((c) => (c.item_count = c.groups.reduce((a: number, g: any) => a + g.item_count, 0)));
    return { data: cats };
  });

  const catBody = z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,8}$/), nameAr, nameEn,
    level: z.enum(["category", "group"]), parentId: uuid.nullable().optional(),
    glInventoryAccount: z.string().max(30).nullable().optional(), glExpenseAccount: z.string().max(30).nullable().optional(),
    valuationMethod: z.enum(["WAVG", "FIFO"]).nullable().optional(), isCritical: z.boolean().default(false),
  }).refine((b) => (b.level === "category") === !b.parentId, { message: "groups_need_a_parent_category", path: ["parentId"] });

  app.post("/api/categories", { preHandler: requirePerm("category.manage"), schema: { tags: ["catalog"] } }, async (req, rep) => {
    const b = parse(catBody, req.body);
    const out = await withTx(txCtx(req), async (c) => {
      if (b.parentId) {
        const p = await one(c, "SELECT level FROM item_category WHERE id = $1 AND deleted_at IS NULL", [b.parentId]);
        if (p?.level !== "category") throw E.invalid([{ path: "parentId", message: "parent_must_be_category" }]);
      }
      return one(c, `INSERT INTO item_category (code, name_ar, name_en, level, parent_id, gl_inventory_account, gl_expense_account, valuation_method, is_critical)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [b.code, b.nameAr, b.nameEn, b.level, b.parentId ?? null, b.glInventoryAccount ?? null, b.glExpenseAccount ?? null, b.valuationMethod ?? null, b.isCritical]);
    });
    rep.status(201); return out;
  });

  app.patch("/api/categories/:id", { preHandler: requirePerm("category.manage"), schema: { tags: ["catalog"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ nameAr: nameAr.optional(), nameEn: nameEn.optional(), glInventoryAccount: z.string().max(30).nullable().optional(),
      glExpenseAccount: z.string().max(30).nullable().optional(), valuationMethod: z.enum(["WAVG", "FIFO"]).nullable().optional(),
      isCritical: z.boolean().optional(), isActive: z.boolean().optional(), version: versionField }), req.body);
    return withTx(txCtx(req), async (c) => {
      await versioned(c, "item_category", id, b.version);
      const u = updateSql("item_category", { nameAr: "name_ar", nameEn: "name_en", glInventoryAccount: "gl_inventory_account",
        glExpenseAccount: "gl_expense_account", valuationMethod: "valuation_method", isCritical: "is_critical", isActive: "is_active" }, b);
      return u.empty ? one(c, "SELECT * FROM item_category WHERE id = $1", [id]) : one(c, u.sql, [id, ...u.params]);
    });
  });

  app.delete("/api/categories/:id", { preHandler: requirePerm("category.manage"), schema: { tags: ["catalog"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return withTx(txCtx(req), async (c) => {
      const used = await one(c, `SELECT (SELECT count(*) FROM item WHERE group_id = $1 AND deleted_at IS NULL)
                                      + (SELECT count(*) FROM item_category WHERE parent_id = $1 AND deleted_at IS NULL) AS n`, [id]);
      if (used.n > 0) throw E.conflict("in_use", "لا يمكن حذف تصنيف مرتبط بأصناف أو مجموعات", "Category is in use");
      await c.query("UPDATE item_category SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL", [id, req.user!.id]);
      return { ok: true };
    });
  });

  // ---------------------------------------------------------------- units of measure
  app.get("/api/uoms", { preHandler: requirePerm("item.read"), schema: { tags: ["catalog"] } }, async () => ({
    data: await many(pool, "SELECT * FROM uom WHERE deleted_at IS NULL ORDER BY dimension, code"),
  }));
  app.post("/api/uoms", { preHandler: requirePerm("category.manage"), schema: { tags: ["catalog"] } }, async (req, rep) => {
    const b = parse(z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{1,10}$/), nameAr, nameEn: z.string().trim().min(1).max(60),
      dimension: z.enum(["count", "weight", "volume", "length", "area", "time"]).default("count") }), req.body);
    const out = await withTx(txCtx(req), (c) => one(c, "INSERT INTO uom (code, name_ar, name_en, dimension) VALUES ($1,$2,$3,$4) RETURNING *",
      [b.code, b.nameAr, b.nameEn, b.dimension]));
    rep.status(201); return out;
  });
  app.patch("/api/uoms/:id", { preHandler: requirePerm("category.manage"), schema: { tags: ["catalog"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ nameAr: nameAr.optional(), nameEn: z.string().trim().min(1).max(60).optional(), isActive: z.boolean().optional(), version: versionField }), req.body);
    return withTx(txCtx(req), async (c) => {
      await versioned(c, "uom", id, b.version);
      const u = updateSql("uom", { nameAr: "name_ar", nameEn: "name_en", isActive: "is_active" }, b);
      return u.empty ? one(c, "SELECT * FROM uom WHERE id = $1", [id]) : one(c, u.sql, [id, ...u.params]);
    });
  });

  // ---------------------------------------------------------------- suppliers
  app.get("/api/suppliers", { preHandler: requirePerm("supplier.read", "supplier.manage"), schema: { tags: ["catalog"] } }, async (req) => {
    const q = parse(listQuery, req.query);
    const p: unknown[] = []; const where = ["deleted_at IS NULL"];
    if (q.q) { p.push(`%${q.q}%`); where.push(`(code ILIKE $1 OR name_ar ILIKE $1 OR name_en ILIKE $1 OR cr_number ILIKE $1 OR etimad_vendor_id ILIKE $1)`); }
    const w = `WHERE ${where.join(" AND ")}`;
    const total = (await one(pool, `SELECT count(*)::int AS n FROM supplier ${w}`, p))!.n;
    const data = await many(pool, `SELECT * FROM supplier ${w} ORDER BY ${orderBy(q, { code: "code", nameAr: "name_ar", nameEn: "name_en" }, "code")}
      LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, p);
    return { data, total, page: q.page, pageSize: q.pageSize };
  });
  const supplierFields = {
    nameAr, nameEn, crNumber: z.string().max(20).nullable().optional(), vatNumber: z.string().regex(/^3\d{13}3$/, "vat_format").nullable().optional(),
    etimadVendorId: z.string().max(30).nullable().optional(), contactName: z.string().max(100).nullable().optional(),
    contactEmail: z.string().email().nullable().optional(), contactPhone: z.string().max(20).nullable().optional(),
    address: z.string().max(300).nullable().optional(), city: z.string().max(60).nullable().optional(),
  };
  const supplierCols = { nameAr: "name_ar", nameEn: "name_en", crNumber: "cr_number", vatNumber: "vat_number", etimadVendorId: "etimad_vendor_id",
    contactName: "contact_name", contactEmail: "contact_email", contactPhone: "contact_phone", address: "address", city: "city", isActive: "is_active" };
  app.post("/api/suppliers", { preHandler: requirePerm("supplier.manage"), schema: { tags: ["catalog"] } }, async (req, rep) => {
    const b = parse(z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,15}$/), ...supplierFields }), req.body) as any;
    const keys = ["code", ...Object.keys(supplierCols).filter((k) => k !== "isActive")];
    const cols = keys.map((k) => (k === "code" ? "code" : (supplierCols as any)[k]));
    const out = await withTx(txCtx(req), (c) => one(c,
      `INSERT INTO supplier (${cols.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`, keys.map((k) => b[k] ?? null)));
    rep.status(201); return out;
  });
  app.patch("/api/suppliers/:id", { preHandler: requirePerm("supplier.manage"), schema: { tags: ["catalog"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ ...Object.fromEntries(Object.entries(supplierFields).map(([k, v]) => [k, (v as any).optional()])),
      isActive: z.boolean().optional(), version: versionField }), req.body) as any;
    return withTx(txCtx(req), async (c) => {
      await versioned(c, "supplier", id, b.version);
      const u = updateSql("supplier", supplierCols, b);
      return u.empty ? one(c, "SELECT * FROM supplier WHERE id = $1", [id]) : one(c, u.sql, [id, ...u.params]);
    });
  });

  // ---------------------------------------------------------------- organisation units (lookup)
  app.get("/api/org-units", { preHandler: requirePerm(), schema: { tags: ["catalog"] } }, async () => ({
    data: await many(pool, "SELECT id, code, name_ar, name_en, unit_type, parent_id, cost_center_code FROM org_unit WHERE deleted_at IS NULL AND is_active ORDER BY code"),
  }));
}
