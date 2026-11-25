// Role-aware dashboard summary for Phase 1 (master data & structure). Stock KPIs arrive with the posting engine (Phase 2+).
import type { FastifyInstance } from "fastify";
import { pool, one, many } from "../db/pool.ts";
import { requirePerm, can, warehouseScope } from "../auth/context.ts";

export async function dashboardRoutes(app: FastifyInstance) {
  app.get("/api/dashboard", { preHandler: requirePerm("dashboard.view", "mobile.tasks"), schema: { tags: ["admin"], summary: "Dashboard widgets for the current user" } }, async (req) => {
    const u = req.user!;
    const out: Record<string, unknown> = {};

    out.items = await one(pool, `SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
        count(*) FILTER (WHERE status = 'pending_approval')::int AS pending_approval,
        count(*) FILTER (WHERE status IN ('requested','draft'))::int AS drafts,
        count(*) FILTER (WHERE status = 'blocked')::int AS blocked,
        count(*)::int AS total FROM item WHERE deleted_at IS NULL`);

    if (can(u, "item.manage") || can(u, "item.approve") || can(u, "audit.read")) {
      out.dataQuality = await one(pool, `SELECT
          count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM item_identifier ii WHERE ii.item_id = i.id AND ii.deleted_at IS NULL AND ii.id_type IN ('barcode','qr')))::int AS no_barcode,
          count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM attachment a WHERE a.owner_type = 'item' AND a.owner_id = i.id AND a.category = 'image' AND a.deleted_at IS NULL))::int AS no_image,
          count(*) FILTER (WHERE i.unit_weight_kg IS NULL OR i.unit_volume_m3 IS NULL)::int AS no_dimensions,
          count(*) FILTER (WHERE i.ved_class IS NULL)::int AS no_ved,
          count(*)::int AS total
        FROM item i WHERE i.deleted_at IS NULL AND i.status = 'active'`);
      out.itemsByCategory = await many(pool, `SELECT c.code, c.name_ar, c.name_en, count(i.id)::int AS n
          FROM item_category c JOIN item_category g ON g.parent_id = c.id LEFT JOIN item i ON i.group_id = g.id AND i.deleted_at IS NULL
         WHERE c.level = 'category' AND c.deleted_at IS NULL GROUP BY c.id ORDER BY n DESC`);
    }

    if (can(u, "item.approve")) {
      out.pendingApprovals = await many(pool, `SELECT i.id, i.item_code, i.name_ar, i.name_en, i.updated_at, s.name_ar AS submitted_by_ar, s.name_en AS submitted_by_en
          FROM item i LEFT JOIN app_user s ON s.id = i.submitted_by
         WHERE i.status = 'pending_approval' AND i.deleted_at IS NULL ORDER BY i.updated_at LIMIT 10`);
    }
    if (can(u, "item.request")) {
      out.myItemRequests = await many(pool, `SELECT id, item_code, name_ar, name_en, status, status_reason, updated_at FROM item
         WHERE requested_by = $1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 6`, [u.id]);
    }

    if (can(u, "warehouse.read")) {
      const scope = warehouseScope(u, "warehouse.read");
      out.warehouses = await many(pool,
        `SELECT w.id, w.code, w.name_ar, w.name_en, w.warehouse_type,
                count(l.id) FILTER (WHERE l.level = 'bin')::int AS bins,
                count(l.id) FILTER (WHERE l.level = 'bin' AND l.is_blocked)::int AS blocked_bins,
                coalesce(sum(l.max_volume_m3) FILTER (WHERE l.level = 'bin'), 0) AS capacity_m3,
                coalesce(sum(l.current_volume_m3) FILTER (WHERE l.level = 'bin'), 0) AS used_m3
           FROM warehouse w LEFT JOIN location l ON l.warehouse_id = w.id AND l.deleted_at IS NULL
          WHERE w.deleted_at IS NULL ${scope === "all" ? "" : "AND w.id = ANY($1)"}
          GROUP BY w.id ORDER BY w.code`, scope === "all" ? [] : [scope]);
    }

    if (can(u, "audit.read")) {
      out.recentActivity = await many(pool, `SELECT a.id, a.at, a.table_name, a.action, a.record_id, a.changed_fields,
          u.name_ar AS actor_name_ar, u.name_en AS actor_name_en
          FROM audit_log a LEFT JOIN app_user u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 8`);
    }
    if (can(u, "admin.users")) {
      out.security = await one(pool, `SELECT
          (SELECT count(*)::int FROM app_user WHERE deleted_at IS NULL AND status = 'active') AS active_users,
          (SELECT count(*)::int FROM app_user WHERE locked_until > now()) AS locked_users,
          (SELECT count(*)::int FROM security_event WHERE event = 'login_failed' AND at > now() - interval '24 hours') AS failed_logins_24h,
          (SELECT count(*)::int FROM app_user WHERE deleted_at IS NULL AND NOT mfa_enabled AND status = 'active') AS without_mfa`);
    }
    return out;
  });
}
