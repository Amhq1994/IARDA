// Warehouse structure: Warehouse > Zone > Aisle > Rack > Bin, capacity by weight/volume,
// bulk generation of aisles/racks/bins, blocking, scan lookup.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type pg from "pg";
import { ZONE_TYPES, type ZoneType } from "@iarda/shared";
import { pool, one, many, withTx } from "../db/pool.ts";
import { E } from "../lib/errors.ts";
import { parse, uuid, idParam, nameAr, nameEn, versionField } from "../lib/http.ts";
import { requirePerm, txCtx, warehouseScope, assertWarehouseInScope } from "../auth/context.ts";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

async function getWarehouse(db: pg.Pool | pg.PoolClient, id: string) {
  const w = await one(db,
    `SELECT w.*, m.name_ar AS manager_name_ar, m.name_en AS manager_name_en
       FROM warehouse w LEFT JOIN app_user m ON m.id = w.manager_user_id
      WHERE w.id = $1 AND w.deleted_at IS NULL`, [id]);
  if (!w) throw E.notFound("warehouse");
  return w;
}

export async function warehouseRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- warehouses
  app.get("/api/warehouses", { preHandler: requirePerm("warehouse.read", "item.read"), schema: { tags: ["warehouses"] } }, async (req) => {
    const scope = req.user!.permissions.has("warehouse.read") ? warehouseScope(req.user!, "warehouse.read") : "all";
    const data = await many(pool,
      `SELECT w.*, m.name_ar AS manager_name_ar, m.name_en AS manager_name_en,
              count(l.id) FILTER (WHERE l.level = 'zone')::int AS zones,
              count(l.id) FILTER (WHERE l.level = 'bin')::int AS bins,
              count(l.id) FILTER (WHERE l.level = 'bin' AND l.is_blocked)::int AS blocked_bins,
              coalesce(sum(l.max_volume_m3) FILTER (WHERE l.level = 'bin'), 0) AS capacity_m3,
              coalesce(sum(l.current_volume_m3) FILTER (WHERE l.level = 'bin'), 0) AS used_m3
         FROM warehouse w
         LEFT JOIN app_user m ON m.id = w.manager_user_id
         LEFT JOIN location l ON l.warehouse_id = w.id AND l.deleted_at IS NULL
        WHERE w.deleted_at IS NULL ${scope === "all" ? "" : "AND w.id = ANY($1)"}
        GROUP BY w.id, m.name_ar, m.name_en ORDER BY w.code`, scope === "all" ? [] : [scope]);
    return { data };
  });

  app.get("/api/warehouses/:id", { preHandler: requirePerm("warehouse.read"), schema: { tags: ["warehouses"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    assertWarehouseInScope(req.user!, "warehouse.read", id);
    const w = await getWarehouse(pool, id);
    const zones = await many(pool,
      `WITH RECURSIVE tree AS (
         SELECT id, id AS zone_id FROM location WHERE warehouse_id = $1 AND level = 'zone' AND deleted_at IS NULL
         UNION ALL SELECT l.id, t.zone_id FROM location l JOIN tree t ON l.parent_id = t.id WHERE l.deleted_at IS NULL)
       SELECT z.id, z.code, z.full_code, z.name_ar, z.name_en, z.zone_type, z.is_blocked, z.version,
              count(*) FILTER (WHERE b.level = 'aisle')::int AS aisles,
              count(*) FILTER (WHERE b.level = 'rack')::int AS racks,
              count(*) FILTER (WHERE b.level = 'bin')::int AS bins,
              coalesce(sum(b.max_volume_m3) FILTER (WHERE b.level = 'bin'), 0) AS capacity_m3,
              coalesce(sum(b.current_volume_m3) FILTER (WHERE b.level = 'bin'), 0) AS used_m3,
              coalesce(sum(b.max_weight_kg) FILTER (WHERE b.level = 'bin'), 0) AS capacity_kg,
              coalesce(sum(b.current_weight_kg) FILTER (WHERE b.level = 'bin'), 0) AS used_kg
         FROM location z
         LEFT JOIN tree t ON t.zone_id = z.id AND t.id <> z.id
         LEFT JOIN location b ON b.id = t.id
        WHERE z.warehouse_id = $1 AND z.level = 'zone' AND z.deleted_at IS NULL
        GROUP BY z.id ORDER BY z.code`, [id]);
    return { ...w, zones };
  });

  const whBody = z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,10}$/), nameAr, nameEn,
    warehouseType: z.enum(["central", "site", "spare_parts", "consumables", "assets", "scrap"]), city: z.string().max(60).nullable().optional(),
    address: z.string().max(300).nullable().optional(), latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(), managerUserId: uuid.nullable().optional(),
    defaultPickingRule: z.enum(["FIFO", "FEFO", "LIFO"]).default("FIFO"),
    createStandardZones: z.boolean().default(true),
  });

  app.post("/api/warehouses", { preHandler: requirePerm("warehouse.manage"), schema: { tags: ["warehouses"], summary: "Create warehouse (+ the 7 standard zones)" } }, async (req, rep) => {
    const b = parse(whBody, req.body);
    if (warehouseScope(req.user!, "warehouse.manage") !== "all") throw E.forbidden("warehouse.manage(all)");
    const out = await withTx(txCtx(req), async (c) => {
      const w = await one(c,
        `INSERT INTO warehouse (code, name_ar, name_en, warehouse_type, city, address, latitude, longitude, manager_user_id, default_picking_rule)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [b.code, b.nameAr, b.nameEn, b.warehouseType, b.city ?? null, b.address ?? null, b.latitude ?? null, b.longitude ?? null,
         b.managerUserId ?? null, b.defaultPickingRule]);
      if (b.createStandardZones) {
        for (const [type, z] of Object.entries(ZONE_TYPES)) {
          await c.query(`INSERT INTO location (warehouse_id, level, code, full_code, name_ar, name_en, zone_type)
                         VALUES ($1,'zone',$2,$3,$4,$5,$6)`, [w.id, z.code, `${b.code}-${z.code}`, `منطقة ${z.ar}`, `${z.en} zone`, type]);
        }
      }
      return getWarehouse(c, w.id);
    });
    rep.status(201); return out;
  });

  app.patch("/api/warehouses/:id", { preHandler: requirePerm("warehouse.manage"), schema: { tags: ["warehouses"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    assertWarehouseInScope(req.user!, "warehouse.manage", id);
    const b = parse(z.object({
      nameAr: nameAr.optional(), nameEn: nameEn.optional(), warehouseType: z.enum(["central", "site", "spare_parts", "consumables", "assets", "scrap"]).optional(),
      city: z.string().max(60).nullable().optional(), address: z.string().max(300).nullable().optional(),
      managerUserId: uuid.nullable().optional(), defaultPickingRule: z.enum(["FIFO", "FEFO", "LIFO"]).optional(),
      isActive: z.boolean().optional(), version: versionField,
    }), req.body) as any;
    return withTx(txCtx(req), async (c) => {
      const cur = await one(c, "SELECT version FROM warehouse WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]);
      if (!cur) throw E.notFound("warehouse");
      if (cur.version !== b.version) throw E.stale();
      const map: Record<string, string> = { nameAr: "name_ar", nameEn: "name_en", warehouseType: "warehouse_type", city: "city", address: "address",
        managerUserId: "manager_user_id", defaultPickingRule: "default_picking_rule", isActive: "is_active" };
      const sets: string[] = []; const p: unknown[] = [id];
      for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { p.push(b[k]); sets.push(`${col} = $${p.length}`); }
      if (sets.length) await c.query(`UPDATE warehouse SET ${sets.join(", ")} WHERE id = $1`, p);
      return getWarehouse(c, id);
    });
  });

  // ---------------------------------------------------------------- locations
  app.get("/api/warehouses/:id/locations", { preHandler: requirePerm("warehouse.read"), schema: { tags: ["warehouses"], summary: "Children of a location (lazy tree)" } }, async (req) => {
    const { id } = parse(idParam, req.params);
    assertWarehouseInScope(req.user!, "warehouse.read", id);
    const q = parse(z.object({ parentId: uuid.optional(), level: z.enum(["zone", "aisle", "rack", "bin"]).optional(),
      q: z.string().trim().max(60).optional(), limit: z.coerce.number().int().min(1).max(1000).default(500) }), req.query);
    const p: unknown[] = [id]; const where = ["l.warehouse_id = $1", "l.deleted_at IS NULL"];
    if (q.q) { p.push(`%${q.q.toUpperCase()}%`); where.push(`l.full_code LIKE $${p.length}`); }
    else if (q.parentId) { p.push(q.parentId); where.push(`l.parent_id = $${p.length}`); }
    else if (!q.level) where.push("l.parent_id IS NULL");
    if (q.level) { p.push(q.level); where.push(`l.level = $${p.length}`); }
    p.push(q.limit);
    const data = await many(pool,
      `SELECT l.*, (SELECT count(*)::int FROM location ch WHERE ch.parent_id = l.id AND ch.deleted_at IS NULL) AS child_count
         FROM location l WHERE ${where.join(" AND ")} ORDER BY l.full_code LIMIT $${p.length}`, p);
    return { data };
  });

  app.get("/api/locations/lookup", { preHandler: requirePerm("warehouse.read"), schema: { tags: ["warehouses"], summary: "Scan lookup by bin barcode or code" } }, async (req) => {
    const { code } = parse(z.object({ code: z.string().trim().min(1).max(80) }), req.query);
    const l = await one(pool, `SELECT l.*, w.code AS warehouse_code FROM location l JOIN warehouse w ON w.id = l.warehouse_id
                                WHERE l.deleted_at IS NULL AND (l.barcode = $1 OR l.full_code = upper($1)) LIMIT 1`, [code]);
    if (!l) throw E.notFound("location");
    assertWarehouseInScope(req.user!, "warehouse.read", l.warehouse_id);
    return l;
  });

  const capacity = {
    maxWeightKg: z.number().positive().nullable().optional(), maxVolumeM3: z.number().positive().nullable().optional(),
    velocityClass: z.enum(["fast", "medium", "slow"]).nullable().optional(), temperatureControlled: z.boolean().optional(),
    hazmatAllowed: z.boolean().optional(), mixedItemsAllowed: z.boolean().optional(),
  };

  app.post("/api/locations", { preHandler: requirePerm("warehouse.manage"), schema: { tags: ["warehouses"] } }, async (req, rep) => {
    const b = parse(z.object({
      warehouseId: uuid, parentId: uuid.nullable().optional(), level: z.enum(["zone", "aisle", "rack", "bin"]),
      code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,8}$/), nameAr: z.string().max(100).optional(), nameEn: z.string().max(100).optional(),
      zoneType: z.enum(Object.keys(ZONE_TYPES) as [ZoneType, ...ZoneType[]]).optional(), ...capacity,
    }), req.body);
    assertWarehouseInScope(req.user!, "warehouse.manage", b.warehouseId);
    const out = await withTx(txCtx(req), async (c) => {
      const w = await getWarehouse(c, b.warehouseId);
      let prefix = w.code;
      if (b.parentId) {
        const parent = await one(c, "SELECT full_code FROM location WHERE id = $1 AND deleted_at IS NULL", [b.parentId]);
        if (!parent) throw E.notFound("parent location");
        prefix = parent.full_code;
      }
      return one(c,
        `INSERT INTO location (warehouse_id, parent_id, level, code, full_code, name_ar, name_en, zone_type, max_weight_kg, max_volume_m3,
                               velocity_class, temperature_controlled, hazmat_allowed, mixed_items_allowed, barcode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$5) RETURNING *`,
        [b.warehouseId, b.parentId ?? null, b.level, b.code, `${prefix}-${b.code}`, b.nameAr ?? null, b.nameEn ?? null,
         b.level === "zone" ? b.zoneType ?? null : null, b.maxWeightKg ?? null, b.maxVolumeM3 ?? null, b.velocityClass ?? null,
         b.temperatureControlled ?? false, b.hazmatAllowed ?? false, b.mixedItemsAllowed ?? true]);
    });
    rep.status(201); return out;
  });

  app.patch("/api/locations/:id", { preHandler: requirePerm("warehouse.manage"), schema: { tags: ["warehouses"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ nameAr: z.string().max(100).nullable().optional(), nameEn: z.string().max(100).nullable().optional(),
      ...capacity, pickSequence: z.number().int().min(0).nullable().optional(), version: versionField }), req.body) as any;
    return withTx(txCtx(req), async (c) => {
      const cur = await one(c, "SELECT * FROM location WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]);
      if (!cur) throw E.notFound("location");
      assertWarehouseInScope(req.user!, "warehouse.manage", cur.warehouse_id);
      if (cur.version !== b.version) throw E.stale();
      const map: Record<string, string> = { nameAr: "name_ar", nameEn: "name_en", maxWeightKg: "max_weight_kg", maxVolumeM3: "max_volume_m3",
        velocityClass: "velocity_class", temperatureControlled: "temperature_controlled", hazmatAllowed: "hazmat_allowed",
        mixedItemsAllowed: "mixed_items_allowed", pickSequence: "pick_sequence" };
      const sets: string[] = []; const p: unknown[] = [id];
      for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { p.push(b[k]); sets.push(`${col} = $${p.length}`); }
      if (b.maxWeightKg != null && b.maxWeightKg < cur.current_weight_kg) throw E.invalid([{ path: "maxWeightKg", message: "below_current_load" }]);
      if (b.maxVolumeM3 != null && b.maxVolumeM3 < cur.current_volume_m3) throw E.invalid([{ path: "maxVolumeM3", message: "below_current_load" }]);
      return sets.length ? one(c, `UPDATE location SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, p) : cur;
    });
  });

  for (const action of ["block", "unblock"] as const) {
    app.post(`/api/locations/:id/${action}`, { preHandler: requirePerm("warehouse.manage"), schema: { tags: ["warehouses"] } }, async (req) => {
      const { id } = parse(idParam, req.params);
      const reason = action === "block" ? parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body).reason : null;
      return withTx(txCtx(req), async (c) => {
        const cur = await one(c, "SELECT warehouse_id FROM location WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]);
        if (!cur) throw E.notFound("location");
        assertWarehouseInScope(req.user!, "warehouse.manage", cur.warehouse_id);
        return one(c, "UPDATE location SET is_blocked = $2, block_reason = $3 WHERE id = $1 RETURNING *", [id, action === "block", reason]);
      });
    });
  }

  app.delete("/api/locations/:id", { preHandler: requirePerm("warehouse.manage"), schema: { tags: ["warehouses"], summary: "Soft delete an empty location" } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return withTx(txCtx(req), async (c) => {
      const cur = await one(c, "SELECT * FROM location WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]);
      if (!cur) throw E.notFound("location");
      assertWarehouseInScope(req.user!, "warehouse.manage", cur.warehouse_id);
      const kids = await one(c, "SELECT count(*)::int AS n FROM location WHERE parent_id = $1 AND deleted_at IS NULL", [id]);
      if (kids.n > 0) throw E.conflict("has_children", "لا يمكن حذف موقع يحتوي مواقع فرعية", "Location has child locations");
      if (cur.current_volume_m3 > 0 || cur.current_weight_kg > 0) throw E.conflict("not_empty", "لا يمكن حذف موقع يحتوي مخزوناً", "Location is not empty");
      await c.query("UPDATE location SET deleted_at = now(), deleted_by = $2 WHERE id = $1", [id, req.user!.id]);
      return { ok: true };
    });
  });

  // ---------------------------------------------------------------- bulk generator
  app.post("/api/locations/:id/generate", { preHandler: requirePerm("warehouse.manage"), schema: { tags: ["warehouses"], summary: "Generate aisles > racks > bins under a zone" } }, async (req, rep) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({
      aisles: z.number().int().min(1).max(50), racksPerAisle: z.number().int().min(1).max(50), binsPerRack: z.number().int().min(1).max(40),
      startAisle: z.number().int().min(1).max(99).default(1),
      binMaxWeightKg: z.number().positive().default(500), binMaxVolumeM3: z.number().positive().default(1.2),
      velocityClass: z.enum(["fast", "medium", "slow"]).nullable().optional(),
    }).refine((x) => x.aisles * x.racksPerAisle * x.binsPerRack <= 5000, { message: "max_5000_bins_per_run" }), req.body);
    const out = await withTx(txCtx(req), async (c) => {
      const zone = await one(c, "SELECT * FROM location WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]);
      if (!zone) throw E.notFound("zone");
      if (zone.level !== "zone") throw E.invalid([{ path: "id", message: "generate_under_zone_only" }]);
      assertWarehouseInScope(req.user!, "warehouse.manage", zone.warehouse_id);
      let seq = (await one(c, "SELECT coalesce(max(pick_sequence), 0)::int AS s FROM location WHERE warehouse_id = $1", [zone.warehouse_id])).s;
      let created = 0;
      for (let a = b.startAisle; a < b.startAisle + b.aisles; a++) {
        const aCode = `A${pad(a)}`;
        const aisle = await one(c, `INSERT INTO location (warehouse_id, parent_id, level, code, full_code, barcode)
                                    VALUES ($1,$2,'aisle',$3,$4,$4) RETURNING id, full_code`,
          [zone.warehouse_id, zone.id, aCode, `${zone.full_code}-${aCode}`]);
        created++;
        for (let r = 1; r <= b.racksPerAisle; r++) {
          const rCode = `R${pad(r)}`;
          const rack = await one(c, `INSERT INTO location (warehouse_id, parent_id, level, code, full_code, barcode)
                                     VALUES ($1,$2,'rack',$3,$4,$4) RETURNING id, full_code`,
            [zone.warehouse_id, aisle.id, rCode, `${aisle.full_code}-${rCode}`]);
          created++;
          const values: unknown[] = []; const rows: string[] = [];
          for (let s = 1; s <= b.binsPerRack; s++) {
            const bCode = `B${pad(s)}`;
            const full = `${rack.full_code}-${bCode}`;
            values.push(zone.warehouse_id, rack.id, bCode, full, b.binMaxWeightKg, b.binMaxVolumeM3, b.velocityClass ?? null, ++seq);
            const o = values.length - 8;
            rows.push(`($${o + 1},$${o + 2},'bin',$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 4})`);
          }
          await c.query(`INSERT INTO location (warehouse_id, parent_id, level, code, full_code, max_weight_kg, max_volume_m3, velocity_class, pick_sequence, barcode)
                         VALUES ${rows.join(",")}`, values);
          created += b.binsPerRack;
        }
      }
      return { created, bins: b.aisles * b.racksPerAisle * b.binsPerRack };
    });
    rep.status(201); return out;
  });
}
