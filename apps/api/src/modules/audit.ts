// Audit trail explorer: search, per-record history, hash-chain verification, security events.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, one, many } from "../db/pool.ts";
import { parse, uuid } from "../lib/http.ts";
import { requirePerm } from "../auth/context.ts";

const AUDITED_TABLES = ["item", "item_identifier", "item_uom_conversion", "item_substitute", "item_warehouse_policy", "item_category", "uom",
  "warehouse", "location", "supplier", "app_user", "user_role", "role_permission", "role", "org_unit", "setting", "attachment", "delegation"];

export async function auditRoutes(app: FastifyInstance) {
  const guard = requirePerm("audit.read");

  app.get("/api/audit", { preHandler: guard, schema: { tags: ["audit"], summary: "Search the audit trail" } }, async (req) => {
    const q = parse(z.object({
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50),
      table: z.string().optional(), recordId: uuid.optional(), actorId: uuid.optional(), action: z.enum(["INSERT", "UPDATE", "DELETE"]).optional(),
      from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(),
    }), req.query);
    const p: unknown[] = []; const where: string[] = [];
    const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace("$?", `$${p.length}`)); };
    if (q.table) add("a.table_name = $?", q.table);
    if (q.recordId) add("a.record_id = $?", q.recordId);
    if (q.actorId) add("a.actor_id = $?", q.actorId);
    if (q.action) add("a.action = $?", q.action);
    if (q.from) add("a.at >= $?", q.from);
    if (q.to) add("a.at <= $?", q.to);
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (await one(pool, `SELECT count(*)::int AS n FROM audit_log a ${w}`, p))!.n;
    const data = await many(pool,
      `SELECT a.*, u.name_ar AS actor_name_ar, u.name_en AS actor_name_en, u.username AS actor_username
         FROM audit_log a LEFT JOIN app_user u ON u.id = a.actor_id ${w}
        ORDER BY a.id DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, p);
    return { data, total, page: q.page, pageSize: q.pageSize, tables: AUDITED_TABLES };
  });

  app.get("/api/audit/record/:table/:id", { preHandler: guard, schema: { tags: ["audit"], summary: "Full history of one record (incl. child tables)" } }, async (req) => {
    const { table, id } = parse(z.object({ table: z.enum(AUDITED_TABLES as [string, ...string[]]), id: uuid }), req.params);
    // item history also includes its identifiers, conversions, substitutes and policies
    const data = await many(pool,
      `SELECT a.*, u.name_ar AS actor_name_ar, u.name_en AS actor_name_en, u.username AS actor_username
         FROM audit_log a LEFT JOIN app_user u ON u.id = a.actor_id
        WHERE (a.table_name = $1 AND a.record_id = $2)
           OR ($1 = 'item' AND a.table_name IN ('item_identifier','item_uom_conversion','item_substitute','item_warehouse_policy')
               AND coalesce(a.new_values->>'item_id', a.old_values->>'item_id') = $2::text)
           OR ($1 = 'item' AND a.table_name = 'attachment' AND coalesce(a.new_values->>'owner_id', a.old_values->>'owner_id') = $2::text)
        ORDER BY a.id DESC LIMIT 500`, [table, id]);
    return { data };
  });

  app.get("/api/audit/verify", { preHandler: guard, schema: { tags: ["audit"], summary: "Verify the hash chain (tamper detection)" } }, async () => {
    const r = await one(pool, "SELECT * FROM audit_verify()");
    return { checked: r.checked, intact: r.first_broken_id === null, firstBrokenId: r.first_broken_id };
  });

  app.get("/api/audit/security-events", { preHandler: guard, schema: { tags: ["audit"] } }, async (req) => {
    const q = parse(z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50),
      event: z.string().optional() }), req.query);
    const p: unknown[] = q.event ? [q.event] : [];
    const w = q.event ? "WHERE event = $1" : "";
    const total = (await one(pool, `SELECT count(*)::int AS n FROM security_event ${w}`, p))!.n;
    const data = await many(pool, `SELECT * FROM security_event ${w} ORDER BY id DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, p);
    return { data, total, page: q.page, pageSize: q.pageSize };
  });
}
