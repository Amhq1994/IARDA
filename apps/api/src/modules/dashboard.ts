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

    // ---------------------------------------------------------------- phase 2: operations
    const whScope = can(u, "warehouse.read") ? warehouseScope(u, "warehouse.read") : can(u, "issue.execute") ? warehouseScope(u, "issue.execute") : "all";
    const wp = whScope === "all" ? [] : [whScope];
    const wf = (col: string) => (whScope === "all" ? "" : `AND ${col} = ANY($1)`);
    out.myApprovals = (await one(pool, "SELECT count(*)::int AS n FROM approval_task WHERE assignee_id = $1 AND status = 'pending'", [u.id]))!.n;
    if (can(u, "request.create")) {
      out.myRequests = await one(pool, `SELECT count(*) FILTER (WHERE status NOT IN ('closed','cancelled','rejected'))::int AS open,
          count(*) FILTER (WHERE status = 'ready_for_delivery')::int AS ready, count(*) FILTER (WHERE status = 'draft')::int AS drafts
        FROM material_request WHERE requester_id = $1`, [u.id]);
    }
    if (can(u, "warehouse.read") || can(u, "issue.execute")) {
      out.operations = await one(pool, `SELECT
          (SELECT count(*)::int FROM material_request m WHERE m.status IN ('approved','reserved','picking','ready_for_delivery','partially_delivered') ${wf("m.warehouse_id")}) AS to_fulfil,
          (SELECT count(*)::int FROM material_request m WHERE m.is_overdue AND m.status NOT IN ('closed','cancelled','rejected') ${wf("m.warehouse_id")}) AS overdue,
          (SELECT count(*)::int FROM receipt r WHERE r.status IN ('arrived','qty_checked') ${wf("r.warehouse_id")}) AS at_dock,
          (SELECT count(*)::int FROM receipt r WHERE r.status = 'in_inspection' ${wf("r.warehouse_id")}) AS in_inspection,
          (SELECT count(*)::int FROM receipt r WHERE r.status = 'inspected' ${wf("r.warehouse_id")}) AS awaiting_grn,
          (SELECT count(*)::int FROM putaway_task t WHERE t.status = 'open' ${wf("t.warehouse_id")}) AS putaway_open,
          (SELECT count(*)::int FROM pick_list p WHERE p.status IN ('open','in_progress') ${wf("p.warehouse_id")}) AS picks_open`, wp);
      out.stock = await one(pool, `SELECT
          (SELECT coalesce(sum(v.total_value), 0) FROM item_valuation v WHERE true ${wf("v.warehouse_id")}) AS value,
          (SELECT count(*)::int FROM item_warehouse_policy p JOIN item i ON i.id = p.item_id AND i.status = 'active'
             WHERE p.deleted_at IS NULL ${wf("p.warehouse_id")} AND coalesce((SELECT sum(qty_free) FROM v_pickable_stock s WHERE s.item_id = p.item_id AND s.warehouse_id = p.warehouse_id), 0)
                   <= coalesce(p.reorder_point, p.min_qty)) AS below_rop,
          (SELECT count(*)::int FROM item_warehouse_policy p JOIN item i ON i.id = p.item_id AND i.status = 'active' AND i.ved_class = 'V'
             WHERE p.deleted_at IS NULL ${wf("p.warehouse_id")} AND NOT EXISTS (SELECT 1 FROM v_pickable_stock s WHERE s.item_id = p.item_id AND s.warehouse_id = p.warehouse_id)) AS critical_stockouts,
          (SELECT count(DISTINCT b.lot_id)::int FROM stock_balance b JOIN stock_lot l ON l.id = b.lot_id
             WHERE b.qty_on_hand > 0 AND l.expiry_date <= current_date + 30 ${wf("b.warehouse_id")}) AS expiring_30d`, wp);
      out.kpis = await one(pool, `SELECT
          (SELECT round(extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY delivered_at - submitted_at)) / 3600, 1)
             FROM material_request m WHERE m.status = 'closed' AND m.delivered_at > now() - interval '90 days' ${wf("m.warehouse_id")}) AS cycle_time_h,
          (SELECT round(extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY putaway_completed_at - arrived_at)) / 3600, 1)
             FROM receipt r WHERE r.putaway_completed_at > now() - interval '90 days' ${wf("r.warehouse_id")}) AS dock_to_stock_h,
          (SELECT round(100.0 * sum(l.qty_issued) / nullif(sum(coalesce(l.qty_approved, l.qty_requested)), 0), 1)
             FROM mr_line l JOIN material_request m ON m.id = l.mr_id WHERE l.deleted_at IS NULL AND m.status = 'closed' ${wf("m.warehouse_id")}) AS fill_rate_pct`, wp);
      out.expiringLots = await many(pool, `SELECT i.id AS item_id, i.item_code, i.name_ar, i.name_en, l.lot_no, l.expiry_date, w.code AS warehouse_code, sum(b.qty_on_hand) AS qty
          FROM stock_balance b JOIN stock_lot l ON l.id = b.lot_id JOIN item i ON i.id = b.item_id JOIN warehouse w ON w.id = b.warehouse_id
         WHERE b.qty_on_hand > 0 AND l.expiry_date <= current_date + 30 ${wf("b.warehouse_id")}
         GROUP BY i.id, l.lot_no, l.expiry_date, w.code ORDER BY l.expiry_date LIMIT 6`, wp);
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
