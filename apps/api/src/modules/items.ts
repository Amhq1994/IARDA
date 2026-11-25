// Item Master: catalogue, duplicate detection, lifecycle (requested → draft → pending_approval → active),
// UoM conversions, identifiers (barcode/QR/RFID/MPN), substitutes, per-warehouse stock policies.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type pg from "pg";
import { pool, one, many, withTx, type Db } from "../db/pool.ts";
import { E } from "../lib/errors.ts";
import { parse, listQuery, orderBy, uuid, idParam, nameAr, nameEn, versionField } from "../lib/http.ts";
import { requirePerm, can, txCtx, assertWarehouseInScope, type AuthUser } from "../auth/context.ts";

const BLOCKING_SIMILARITY = 0.6;

const identifierInput = z.object({
  idType: z.enum(["barcode", "qr", "rfid", "mpn"]),
  value: z.string().trim().min(1).max(120),
  manufacturer: z.string().trim().max(120).optional(),
  isPrimary: z.boolean().default(false),
});
const conversionInput = z.object({
  uomId: uuid,
  factorToBase: z.number().positive(),
  isPurchaseDefault: z.boolean().default(false),
  isIssueDefault: z.boolean().default(false),
  barcode: z.string().trim().max(120).optional(),
});

const itemFields = {
  nameAr, nameEn,
  descriptionAr: z.string().max(2000).optional().nullable(),
  descriptionEn: z.string().max(2000).optional().nullable(),
  specs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  groupId: uuid,
  itemType: z.enum(["stock", "non_stock", "consumable", "asset"]),
  baseUomId: uuid,
  trackBatch: z.boolean().default(false),
  trackSerial: z.boolean().default(false),
  trackExpiry: z.boolean().default(false),
  shelfLifeDays: z.number().int().positive().optional().nullable(),
  unitWeightKg: z.number().min(0).optional().nullable(),
  unitVolumeM3: z.number().min(0).optional().nullable(),
  hazardClass: z.string().max(40).optional().nullable(),
  storageConditions: z.string().max(300).optional().nullable(),
  vedClass: z.enum(["V", "E", "D"]).optional().nullable(),
  standardCost: z.number().min(0).optional().nullable(),
};

const createBody = z.object({
  ...itemFields,
  identifiers: z.array(identifierInput).max(20).default([]),
  conversions: z.array(conversionInput).max(20).default([]),
  acknowledgeDuplicates: z.boolean().default(false),
}).refine((b) => !(b.trackBatch && b.trackSerial), { message: "batch_and_serial_exclusive", path: ["trackSerial"] })
  .refine((b) => !b.trackExpiry || b.trackBatch || b.trackSerial, { message: "expiry_needs_batch_or_serial", path: ["trackExpiry"] });

const updateBody = z.object({
  ...Object.fromEntries(Object.entries(itemFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])),
  version: versionField,
}).strict();

const COLS: Record<string, string> = {
  nameAr: "name_ar", nameEn: "name_en", descriptionAr: "description_ar", descriptionEn: "description_en", specs: "specs",
  groupId: "group_id", itemType: "item_type", baseUomId: "base_uom_id", trackBatch: "track_batch", trackSerial: "track_serial",
  trackExpiry: "track_expiry", shelfLifeDays: "shelf_life_days", unitWeightKg: "unit_weight_kg", unitVolumeM3: "unit_volume_m3",
  hazardClass: "hazard_class", storageConditions: "storage_conditions", vedClass: "ved_class", standardCost: "standard_cost",
};

// ------------------------------------------------------------------ duplicate detection
export async function findDuplicates(db: Db, input: { nameAr: string; nameEn?: string; identifiers?: { idType: string; value: string }[]; excludeId?: string }) {
  const similar = await many(db,
    `SELECT * FROM (
       SELECT i.id, i.item_code, i.name_ar, i.name_en, i.status,
              round(greatest(item_name_score(i.name_ar, $1),
                             CASE WHEN $2 <> '' THEN similarity(lower(i.name_en), lower($2)) ELSE 0 END)::numeric, 3) AS score
         FROM item i
        WHERE i.deleted_at IS NULL AND ($3::uuid IS NULL OR i.id <> $3)) s
      WHERE s.score >= 0.3
      ORDER BY s.score DESC LIMIT 8`,
    [input.nameAr, input.nameEn ?? "", input.excludeId ?? null]);
  const ids = input.identifiers ?? [];
  const exact = ids.length
    ? await many(db,
        `SELECT i.id, i.item_code, i.name_ar, i.name_en, i.status, ii.id_type, ii.value
           FROM item_identifier ii JOIN item i ON i.id = ii.item_id
          WHERE ii.deleted_at IS NULL AND i.deleted_at IS NULL AND ($1::uuid IS NULL OR i.id <> $1)
            AND (ii.id_type, ii.value) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
        [input.excludeId ?? null, ids.map((x) => x.idType), ids.map((x) => x.value)])
    : [];
  return {
    similar: similar.map((r) => ({ ...r, blocking: r.score >= BLOCKING_SIMILARITY })),
    identifierMatches: exact,
  };
}

// ------------------------------------------------------------------ helpers
async function nextItemCode(c: pg.PoolClient, groupId: string): Promise<string> {
  const g = await one(c, "SELECT code, level FROM item_category WHERE id = $1 AND deleted_at IS NULL AND is_active", [groupId]);
  if (!g) throw E.invalid([{ path: "groupId", message: "unknown_group" }]);
  if (g.level !== "group") throw E.invalid([{ path: "groupId", message: "items_belong_to_groups" }]);
  const r = await one(c,
    `INSERT INTO item_code_sequence (group_id, next_no) VALUES ($1, 2)
     ON CONFLICT (group_id) DO UPDATE SET next_no = item_code_sequence.next_no + 1
     RETURNING next_no - 1 AS n`, [groupId]);
  return `${g.code}-${String(r.n).padStart(5, "0")}`;
}

async function getItem(db: Db, id: string, includeDeleted = false) {
  const it = await one(db,
    `SELECT i.*, g.code AS group_code, g.name_ar AS group_name_ar, g.name_en AS group_name_en,
            c.id AS category_id, c.code AS category_code, c.name_ar AS category_name_ar, c.name_en AS category_name_en,
            u.code AS uom_code, u.name_ar AS uom_name_ar, u.name_en AS uom_name_en,
            cb.name_ar AS created_by_name_ar, cb.name_en AS created_by_name_en,
            ab.name_ar AS approved_by_name_ar, ab.name_en AS approved_by_name_en
       FROM item i
       JOIN item_category g ON g.id = i.group_id
       JOIN item_category c ON c.id = g.parent_id
       JOIN uom u ON u.id = i.base_uom_id
       LEFT JOIN app_user cb ON cb.id = i.created_by
       LEFT JOIN app_user ab ON ab.id = i.approved_by
      WHERE i.id = $1 ${includeDeleted ? "" : "AND i.deleted_at IS NULL"}`, [id]);
  if (!it) throw E.notFound("item");
  return it;
}

function assertVersion(row: { version: number }, version: number) {
  if (row.version !== version) throw E.stale();
}

const canSeeNonActive = (u: AuthUser) => can(u, "item.manage") || can(u, "item.approve") || can(u, "audit.read");

// ------------------------------------------------------------------ routes
export async function itemRoutes(app: FastifyInstance) {
  // ---- list / search
  app.get("/api/items", { preHandler: requirePerm("item.read"), schema: { tags: ["items"], summary: "Search items (paginated)" } }, async (req) => {
    const q = parse(listQuery.extend({
      status: z.string().optional(), groupId: uuid.optional(), categoryId: uuid.optional(),
      itemType: z.string().optional(), abc: z.string().optional(), ved: z.string().optional(),
      mine: z.coerce.boolean().optional(),
    }), req.query);
    const u = req.user!;
    const where: string[] = [];
    const p: unknown[] = [];
    const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replaceAll("$?", `$${p.length}`)); };
    if (!(q.includeDeleted && can(u, "audit.read"))) where.push("i.deleted_at IS NULL");
    // requesters and other read-only roles only see active items (plus their own requests)
    if (!canSeeNonActive(u)) { p.push(u.id); where.push(`(i.status IN ('active','blocked') OR i.requested_by = $${p.length})`); }
    if (q.q) {
      p.push(q.q);
      const n = p.length;
      where.push(`(i.item_code ILIKE '%' || $${n} || '%' OR i.normalized_name LIKE '%' || normalize_ar($${n}) || '%'
               OR lower(i.name_en) LIKE '%' || lower($${n}) || '%'
               OR EXISTS (SELECT 1 FROM item_identifier ii WHERE ii.item_id = i.id AND ii.deleted_at IS NULL AND ii.value = $${n}))`);
    }
    if (q.status) add("i.status = ANY(string_to_array($?, ','))", q.status);
    if (q.groupId) add("i.group_id = $?", q.groupId);
    if (q.categoryId) add("g.parent_id = $?", q.categoryId);
    if (q.itemType) add("i.item_type = ANY(string_to_array($?, ','))", q.itemType);
    if (q.abc) add("i.abc_class = ANY(string_to_array($?, ','))", q.abc);
    if (q.ved) add("i.ved_class = ANY(string_to_array($?, ','))", q.ved);
    if (q.mine) add("(i.requested_by = $? OR i.created_by = $?)", u.id);
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const order = orderBy(q, { code: "i.item_code", nameAr: "i.name_ar", nameEn: "i.name_en", status: "i.status", updated: "i.updated_at", abc: "i.abc_class" }, "i.item_code");
    const from = `FROM item i JOIN item_category g ON g.id = i.group_id JOIN item_category c ON c.id = g.parent_id JOIN uom u ON u.id = i.base_uom_id`;
    const total = (await one(pool, `SELECT count(*)::int AS n ${from} ${w}`, p))!.n;
    p.push(q.pageSize, (q.page - 1) * q.pageSize);
    const data = await many(pool,
      `SELECT i.id, i.item_code, i.name_ar, i.name_en, i.item_type, i.status, i.abc_class, i.xyz_class, i.ved_class,
              i.track_batch, i.track_serial, i.track_expiry, i.deleted_at, i.updated_at,
              g.id AS group_id, g.name_ar AS group_name_ar, g.name_en AS group_name_en,
              c.name_ar AS category_name_ar, c.name_en AS category_name_en, u.code AS uom_code, u.name_ar AS uom_name_ar, u.name_en AS uom_name_en,
              (SELECT a.id FROM attachment a WHERE a.owner_type = 'item' AND a.owner_id = i.id AND a.category = 'image'
                 AND a.deleted_at IS NULL ORDER BY a.is_primary DESC, a.created_at LIMIT 1) AS image_id
       ${from} ${w} ORDER BY ${order} LIMIT $${p.length - 1} OFFSET $${p.length}`, p);
    return { data, total, page: q.page, pageSize: q.pageSize };
  });

  // ---- scan / lookup by code or identifier (mobile)
  app.get("/api/items/lookup", { preHandler: requirePerm("item.read"), schema: { tags: ["items"] } }, async (req) => {
    const { code } = parse(z.object({ code: z.string().trim().min(1).max(120) }), req.query);
    const row = await one(pool,
      `SELECT i.id FROM item i WHERE i.deleted_at IS NULL AND i.item_code = $1
       UNION ALL
       SELECT ii.item_id FROM item_identifier ii WHERE ii.deleted_at IS NULL AND ii.value = $1
       UNION ALL
       SELECT c.item_id FROM item_uom_conversion c WHERE c.deleted_at IS NULL AND c.barcode = $1
       LIMIT 1`, [code]);
    if (!row) throw E.notFound("item");
    return { id: row.id };
  });

  // ---- duplicate check (used live by the creation form)
  app.post("/api/items/duplicate-check", { preHandler: requirePerm("item.manage", "item.request"), schema: { tags: ["items"] } }, async (req) => {
    const b = parse(z.object({ nameAr: z.string().trim().min(2), nameEn: z.string().trim().optional(),
      identifiers: z.array(identifierInput.pick({ idType: true, value: true })).optional(), excludeId: uuid.optional() }), req.body);
    return findDuplicates(pool, b);
  });

  // ---- detail
  app.get("/api/items/:id", { preHandler: requirePerm("item.read"), schema: { tags: ["items"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const u = req.user!;
    const it = await getItem(pool, id, can(u, "audit.read"));
    if (!canSeeNonActive(u) && !["active", "blocked"].includes(it.status) && it.requested_by !== u.id) throw E.notFound("item");
    const [conversions, identifiers, substitutes, policies, images] = await Promise.all([
      many(pool, `SELECT c.*, u.code AS uom_code, u.name_ar AS uom_name_ar, u.name_en AS uom_name_en
                    FROM item_uom_conversion c JOIN uom u ON u.id = c.uom_id
                   WHERE c.item_id = $1 AND c.deleted_at IS NULL ORDER BY c.factor_to_base`, [id]),
      many(pool, "SELECT * FROM item_identifier WHERE item_id = $1 AND deleted_at IS NULL ORDER BY is_primary DESC, id_type", [id]),
      many(pool, `SELECT s.*, i.item_code, i.name_ar, i.name_en, i.status FROM item_substitute s JOIN item i ON i.id = s.substitute_item_id
                   WHERE s.item_id = $1 AND s.deleted_at IS NULL ORDER BY s.priority`, [id]),
      many(pool, `SELECT p.*, w.code AS warehouse_code, w.name_ar AS warehouse_name_ar, w.name_en AS warehouse_name_en,
                         l.full_code AS preferred_location_code
                    FROM item_warehouse_policy p JOIN warehouse w ON w.id = p.warehouse_id
                    LEFT JOIN location l ON l.id = p.preferred_location_id
                   WHERE p.item_id = $1 AND p.deleted_at IS NULL ORDER BY w.code`, [id]),
      many(pool, `SELECT id, file_name, mime_type, size_bytes, is_primary, created_at FROM attachment
                   WHERE owner_type = 'item' AND owner_id = $1 AND deleted_at IS NULL ORDER BY is_primary DESC, created_at`, [id]),
    ]);
    return { ...it, conversions, identifiers, substitutes, policies, images };
  });

  // ---- create (MDO: draft; other roles: "new item request")
  app.post("/api/items", { preHandler: requirePerm("item.manage", "item.request"), schema: { tags: ["items"], summary: "Create item or new-item request" } }, async (req, rep) => {
    const b = parse(createBody, req.body);
    const u = req.user!;
    const isMdo = can(u, "item.manage");
    const dup = await findDuplicates(pool, { nameAr: b.nameAr, nameEn: b.nameEn, identifiers: b.identifiers });
    if (dup.identifierMatches.length) {
      throw E.conflict("identifier_exists", "أحد المعرّفات (باركود/رقم قطعة) مستخدم لصنف آخر", "An identifier is already used by another item", dup);
    }
    const blocking = dup.similar.filter((s) => s.blocking);
    if (blocking.length && !b.acknowledgeDuplicates) {
      throw E.conflict("possible_duplicates", "يوجد أصناف مشابهة، يرجى المراجعة قبل الإنشاء", "Similar items exist; review before creating", dup);
    }
    const item = await withTx(txCtx(req), async (c) => {
      const code = await nextItemCode(c, b.groupId);
      const row = await one(c,
        `INSERT INTO item (item_code, name_ar, name_en, description_ar, description_en, specs, group_id, item_type, base_uom_id,
           track_batch, track_serial, track_expiry, shelf_life_days, unit_weight_kg, unit_volume_m3, hazard_class, storage_conditions,
           ved_class, standard_cost, status, requested_by, duplicate_ack)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
        [code, b.nameAr, b.nameEn, b.descriptionAr ?? null, b.descriptionEn ?? null, JSON.stringify(b.specs ?? {}), b.groupId, b.itemType,
         b.baseUomId, b.trackBatch, b.trackSerial, b.trackExpiry, b.shelfLifeDays ?? null, b.unitWeightKg ?? null, b.unitVolumeM3 ?? null,
         b.hazardClass ?? null, b.storageConditions ?? null, b.vedClass ?? null, b.standardCost ?? null,
         isMdo ? "draft" : "requested", u.id, blocking.length ? JSON.stringify(blocking) : null]);
      for (const idf of b.identifiers) {
        await c.query("INSERT INTO item_identifier (item_id, id_type, value, manufacturer, is_primary) VALUES ($1,$2,$3,$4,$5)",
          [row.id, idf.idType, idf.value, idf.manufacturer ?? null, idf.isPrimary]);
      }
      for (const cv of b.conversions) {
        await c.query(`INSERT INTO item_uom_conversion (item_id, uom_id, factor_to_base, is_purchase_default, is_issue_default, barcode)
                       VALUES ($1,$2,$3,$4,$5,$6)`, [row.id, cv.uomId, cv.factorToBase, cv.isPurchaseDefault, cv.isIssueDefault, cv.barcode ?? null]);
      }
      return getItem(c, row.id);
    });
    rep.status(201);
    return item;
  });

  // ---- update (optimistic locking)
  app.patch("/api/items/:id", { preHandler: requirePerm("item.manage"), schema: { tags: ["items"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(updateBody, req.body) as Record<string, any>;
    return withTx(txCtx(req), async (c) => {
      const cur = await one(c, "SELECT * FROM item WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]);
      if (!cur) throw E.notFound("item");
      assertVersion(cur, b.version);
      if (cur.status === "obsolete") throw E.state(cur.status, "edit");
      const sets: string[] = []; const p: unknown[] = [id];
      for (const [k, col] of Object.entries(COLS)) {
        if (b[k] === undefined) continue;
        p.push(k === "specs" ? JSON.stringify(b[k]) : b[k]);
        sets.push(`${col} = $${p.length}`);
      }
      if (b.groupId && b.groupId !== cur.group_id) {
        const g = await one(c, "SELECT level FROM item_category WHERE id = $1", [b.groupId]);
        if (g?.level !== "group") throw E.invalid([{ path: "groupId", message: "items_belong_to_groups" }]);
      }
      if (sets.length) await c.query(`UPDATE item SET ${sets.join(", ")} WHERE id = $1`, p);
      return getItem(c, id);
    });
  });

  // ---- lifecycle transitions
  const transition = (action: string, perm: "item.manage" | "item.approve", from: string[], to: string,
    extra?: (c: pg.PoolClient, cur: any, u: AuthUser, body: any) => Promise<Record<string, unknown> | void>) =>
    app.post(`/api/items/:id/${action}`, { preHandler: requirePerm(perm), schema: { tags: ["items"], summary: `Item: ${action}` } }, async (req) => {
      const { id } = parse(idParam, req.params);
      const body = (req.body ?? {}) as any;
      return withTx(txCtx(req), async (c) => {
        const cur = await one(c, "SELECT * FROM item WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]);
        if (!cur) throw E.notFound("item");
        if (!from.includes(cur.status)) throw E.state(cur.status, action);
        const fields = (await extra?.(c, cur, req.user!, body)) ?? {};
        const all = { status: to, ...fields };
        const keys = Object.keys(all);
        await c.query(`UPDATE item SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [id, ...Object.values(all)]);
        return getItem(c, id);
      });
    });

  const reason = (body: any) => parse(z.object({ reason: z.string().trim().min(3).max(500) }), body).reason;

  transition("submit", "item.manage", ["requested", "draft"], "pending_approval", async (_c, _cur, u) => ({ submitted_by: u.id, status_reason: null }));
  transition("approve", "item.approve", ["pending_approval"], "active", async (_c, cur, u) => {
    // SoD-6: the person who requested, created or submitted the item cannot approve it
    if ([cur.requested_by, cur.created_by, cur.submitted_by].includes(u.id)) {
      throw E.sod("SoD-6", "لا يمكن اعتماد صنف قمت بطلبه أو إنشائه أو رفعه للاعتماد", "You cannot approve an item you requested, created or submitted");
    }
    return { approved_by: u.id, approved_at: new Date(), status_reason: null };
  });
  transition("reject", "item.approve", ["pending_approval"], "draft", async (_c, cur, u, body) => {
    if (cur.submitted_by === u.id) throw E.sod("SoD-6", "لا يمكن رفض صنف قمت برفعه", "You cannot reject an item you submitted");
    return { status_reason: reason(body) };
  });
  transition("block", "item.manage", ["active"], "blocked", async (_c, _cur, _u, body) => ({ status_reason: reason(body) }));
  transition("unblock", "item.manage", ["blocked"], "active", async () => ({ status_reason: null }));
  transition("obsolete", "item.manage", ["active", "blocked"], "obsolete", async (_c, _cur, _u, body) => ({ status_reason: reason(body) }));

  // ---- soft delete (only before activation; active items are blocked/obsoleted instead)
  app.delete("/api/items/:id", { preHandler: requirePerm("item.manage"), schema: { tags: ["items"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return withTx(txCtx(req), async (c) => {
      const cur = await one(c, "SELECT status FROM item WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]);
      if (!cur) throw E.notFound("item");
      if (!["requested", "draft"].includes(cur.status)) throw E.state(cur.status, "delete");
      await c.query("UPDATE item SET deleted_at = now(), deleted_by = $2 WHERE id = $1", [id, req.user!.id]);
      return { ok: true };
    });
  });

  // ---- sub-resources
  const subPerm = requirePerm("item.manage");
  const ensureEditable = async (c: Db, id: string) => {
    const it = await one(c, "SELECT status FROM item WHERE id = $1 AND deleted_at IS NULL", [id]);
    if (!it) throw E.notFound("item");
    if (it.status === "obsolete") throw E.state(it.status, "edit");
  };

  app.post("/api/items/:id/identifiers", { preHandler: subPerm, schema: { tags: ["items"] } }, async (req, rep) => {
    const { id } = parse(idParam, req.params);
    const b = parse(identifierInput, req.body);
    const out = await withTx(txCtx(req), async (c) => {
      await ensureEditable(c, id);
      return one(c, "INSERT INTO item_identifier (item_id, id_type, value, manufacturer, is_primary) VALUES ($1,$2,$3,$4,$5) RETURNING *",
        [id, b.idType, b.value, b.manufacturer ?? null, b.isPrimary]);
    });
    rep.status(201); return out;
  });
  app.post("/api/items/:id/conversions", { preHandler: subPerm, schema: { tags: ["items"] } }, async (req, rep) => {
    const { id } = parse(idParam, req.params);
    const b = parse(conversionInput, req.body);
    const out = await withTx(txCtx(req), async (c) => {
      await ensureEditable(c, id);
      const base = await one(c, "SELECT base_uom_id FROM item WHERE id = $1", [id]);
      if (base.base_uom_id === b.uomId) throw E.invalid([{ path: "uomId", message: "base_uom_has_factor_1" }]);
      return one(c, `INSERT INTO item_uom_conversion (item_id, uom_id, factor_to_base, is_purchase_default, is_issue_default, barcode)
                     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [id, b.uomId, b.factorToBase, b.isPurchaseDefault, b.isIssueDefault, b.barcode ?? null]);
    });
    rep.status(201); return out;
  });
  app.post("/api/items/:id/substitutes", { preHandler: subPerm, schema: { tags: ["items"] } }, async (req, rep) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ substituteItemId: uuid, ratio: z.number().positive().default(1), priority: z.number().int().min(1).default(1),
      notes: z.string().max(300).optional() }), req.body);
    const out = await withTx(txCtx(req), async (c) => {
      await ensureEditable(c, id);
      return one(c, "INSERT INTO item_substitute (item_id, substitute_item_id, ratio, priority, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *",
        [id, b.substituteItemId, b.ratio, b.priority, b.notes ?? null]);
    });
    rep.status(201); return out;
  });
  for (const [path, table] of [["identifiers", "item_identifier"], ["conversions", "item_uom_conversion"], ["substitutes", "item_substitute"]] as const) {
    app.delete(`/api/items/:id/${path}/:subId`, { preHandler: subPerm, schema: { tags: ["items"] } }, async (req) => {
      const { id, subId } = parse(z.object({ id: uuid, subId: uuid }), req.params);
      return withTx(txCtx(req), async (c) => {
        await ensureEditable(c, id);
        const r = await c.query(`UPDATE ${table} SET deleted_at = now(), deleted_by = $3 WHERE id = $1 AND item_id = $2 AND deleted_at IS NULL`,
          [subId, id, req.user!.id]);
        if (!r.rowCount) throw E.notFound(path);
        return { ok: true };
      });
    });
  }

  // ---- per-warehouse stock policy (Inventory Planner)
  app.put("/api/items/:id/policies/:warehouseId", { preHandler: requirePerm("item.policy"), schema: { tags: ["items"] } }, async (req) => {
    const { id, warehouseId } = parse(z.object({ id: uuid, warehouseId: uuid }), req.params);
    assertWarehouseInScope(req.user!, "item.policy", warehouseId);
    const b = parse(z.object({
      minQty: z.number().min(0).default(0), maxQty: z.number().min(0).nullable().optional(),
      reorderPoint: z.number().min(0).nullable().optional(), safetyStock: z.number().min(0).default(0),
      reorderQty: z.number().positive().nullable().optional(), leadTimeDays: z.number().int().min(0).nullable().optional(),
      preferredLocationId: uuid.nullable().optional(), pickingRule: z.enum(["FIFO", "FEFO", "LIFO"]).nullable().optional(),
      isStocked: z.boolean().default(true),
    }), req.body);
    return withTx(txCtx(req), async (c) => {
      await ensureEditable(c, id);
      if (b.preferredLocationId) {
        const l = await one(c, "SELECT warehouse_id, level FROM location WHERE id = $1 AND deleted_at IS NULL", [b.preferredLocationId]);
        if (!l || l.warehouse_id !== warehouseId || l.level !== "bin") throw E.invalid([{ path: "preferredLocationId", message: "must_be_bin_in_warehouse" }]);
      }
      const vals = [b.minQty, b.maxQty ?? null, b.reorderPoint ?? null, b.safetyStock, b.reorderQty ?? null, b.leadTimeDays ?? null,
        b.preferredLocationId ?? null, b.pickingRule ?? null, b.isStocked];
      const existing = await one(c, "SELECT id FROM item_warehouse_policy WHERE item_id = $1 AND warehouse_id = $2 AND deleted_at IS NULL FOR UPDATE", [id, warehouseId]);
      if (existing) {
        return one(c, `UPDATE item_warehouse_policy SET min_qty=$2, max_qty=$3, reorder_point=$4, safety_stock=$5, reorder_qty=$6,
                         lead_time_days=$7, preferred_location_id=$8, picking_rule=$9, is_stocked=$10 WHERE id = $1 RETURNING *`, [existing.id, ...vals]);
      }
      return one(c, `INSERT INTO item_warehouse_policy (item_id, warehouse_id, min_qty, max_qty, reorder_point, safety_stock, reorder_qty,
                       lead_time_days, preferred_location_id, picking_rule, is_stocked) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [id, warehouseId, ...vals]);
    });
  });
}
