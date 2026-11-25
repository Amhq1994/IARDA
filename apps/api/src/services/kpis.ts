// KPI engine: computes every KPI from transactions (with targets from settings), stores daily snapshots,
// and returns 6-month trends from the snapshot history.
import { one, many } from "../db/pool.ts";
import { setting, type Tx } from "./common.ts";
import type pg from "pg";

type Q = Tx | pg.Pool;
export const KPI_KEYS = ["accuracy_pct", "fill_rate_pct", "cycle_time_h", "dock_to_stock_h", "dead_stock_pct", "critical_stockouts",
  "space_utilisation_pct", "turnover", "approvals_on_time_pct"] as const;
export type KpiKey = (typeof KPI_KEYS)[number];

export const KPI_LABEL: Record<KpiKey, [string, string, string]> = {
  accuracy_pct: ["دقة المخزون", "Inventory accuracy", "%"],
  fill_rate_pct: ["معدل تلبية الطلبات", "Fill rate", "%"],
  cycle_time_h: ["زمن دورة الطلب (الوسيط)", "Request cycle time (median)", "h"],
  dock_to_stock_h: ["من الرصيف إلى التخزين (الوسيط)", "Dock-to-stock (median)", "h"],
  dead_stock_pct: ["المخزون الراكد من القيمة", "Dead stock (share of value)", "%"],
  critical_stockouts: ["نفاد الأصناف الحرجة (V)", "Critical (V) stock-outs", ""],
  space_utilisation_pct: ["إشغال المساحات التخزينية", "Space utilisation", "%"],
  turnover: ["معدل دوران المخزون (سنوي)", "Inventory turnover (annual)", "×"],
  approvals_on_time_pct: ["الاعتمادات ضمن المدة", "Approvals within SLA", "%"],
};

/** Computes all KPIs for a warehouse scope ("all" or warehouse ids). */
export async function computeKpis(c: Q, scope: "all" | string[]): Promise<Record<KpiKey, number | null>> {
  const p = scope === "all" ? [] : [scope];
  const wf = (col: string) => (scope === "all" ? "" : `AND ${col} = ANY($1)`);
  const dead = Number(await setting(c as Tx, "planning.dead_stock_days", 180));
  const r = await one(c, `SELECT
      (SELECT round(100.0 * count(*) FILTER (WHERE abs(l.qty_count1 - l.qty_system1) <= l.qty_system1 * coalesce((s.value ->> coalesce(i.abc_class, 'C'))::numeric, 2) / 100)
                    / nullif(count(*), 0), 1)
         FROM count_line l JOIN count_plan cp ON cp.id = l.plan_id JOIN item i ON i.id = l.item_id LEFT JOIN setting s ON s.key = 'count.tolerance_pct'
        WHERE l.qty_count1 IS NOT NULL AND l.counted1_at > now() - interval '90 days' ${wf("cp.warehouse_id")}) AS accuracy_pct,
      (SELECT round(100.0 * sum(l.qty_issued) / nullif(sum(coalesce(l.qty_approved, l.qty_requested)), 0), 1)
         FROM mr_line l JOIN material_request m ON m.id = l.mr_id WHERE l.deleted_at IS NULL AND m.status = 'closed' AND m.closed_at > now() - interval '90 days' ${wf("m.warehouse_id")}) AS fill_rate_pct,
      (SELECT round((extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY delivered_at - submitted_at)) / 3600)::numeric, 1)
         FROM material_request m WHERE m.status = 'closed' AND m.delivered_at > now() - interval '90 days' ${wf("m.warehouse_id")}) AS cycle_time_h,
      (SELECT round((extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY putaway_completed_at - arrived_at)) / 3600)::numeric, 1)
         FROM receipt r WHERE r.putaway_completed_at > now() - interval '90 days' ${wf("r.warehouse_id")}) AS dock_to_stock_h,
      (SELECT count(*)::int FROM item_warehouse_policy pl JOIN item i ON i.id = pl.item_id AND i.status = 'active' AND i.ved_class = 'V'
        WHERE pl.deleted_at IS NULL ${wf("pl.warehouse_id")}
          AND NOT EXISTS (SELECT 1 FROM v_pickable_stock s WHERE s.item_id = pl.item_id AND s.warehouse_id = pl.warehouse_id)) AS critical_stockouts,
      (SELECT round(100.0 * sum(l.current_volume_m3) / nullif(sum(l.max_volume_m3), 0), 1) FROM location l
        WHERE l.level = 'bin' AND l.deleted_at IS NULL AND NOT l.is_blocked ${wf("l.warehouse_id")}) AS space_utilisation_pct,
      (SELECT coalesce(sum(v.total_value), 0) FROM item_valuation v WHERE true ${wf("v.warehouse_id")}) AS stock_value,
      (SELECT coalesce(sum(-l.value), 0) FROM stock_ledger l WHERE l.movement_type IN ('GI','RTW') AND l.posted_at > now() - interval '365 days' ${wf("l.warehouse_id")})
       + (SELECT coalesce(sum(h.value), 0) FROM consumption_history h WHERE h.period > current_date - 365 ${wf("h.warehouse_id")}) AS issue_value_12m,
      (SELECT round(100.0 * count(*) FILTER (WHERE t.acted_at <= t.due_at OR t.due_at IS NULL) / nullif(count(*), 0), 1)
         FROM approval_task t WHERE t.status IN ('approved','rejected','returned') AND t.acted_at > now() - interval '90 days') AS approvals_on_time_pct`, p);
  // dead stock: on-hand value of item/warehouse pairs idle for ≥ dead days
  const d = await one(c, `WITH oh AS (SELECT item_id, warehouse_id, sum(total_value) AS value FROM item_valuation v WHERE qty > 0 ${wf("v.warehouse_id")} GROUP BY 1, 2),
      act AS (SELECT item_id, warehouse_id, max(at) AS at FROM (
        SELECT item_id, warehouse_id, posted_at AS at FROM stock_ledger WHERE movement_type IN ('GI','GR')
        UNION ALL SELECT item_id, warehouse_id, (period + interval '1 month')::timestamptz FROM consumption_history WHERE qty > 0) x GROUP BY 1, 2)
      SELECT coalesce(sum(oh.value) FILTER (WHERE coalesce(act.at, '-infinity') < now() - make_interval(days => ${dead})), 0) AS dead, coalesce(sum(oh.value), 0) AS total
        FROM oh LEFT JOIN act ON act.item_id = oh.item_id AND act.warehouse_id = oh.warehouse_id`, p);
  const n = (x: unknown) => (x == null ? null : Number(x));
  const value = Number(r.stock_value);
  return {
    accuracy_pct: n(r.accuracy_pct), fill_rate_pct: n(r.fill_rate_pct), cycle_time_h: n(r.cycle_time_h), dock_to_stock_h: n(r.dock_to_stock_h),
    dead_stock_pct: Number(d.total) > 0 ? Math.round((1000 * Number(d.dead)) / Number(d.total)) / 10 : null,
    critical_stockouts: n(r.critical_stockouts), space_utilisation_pct: n(r.space_utilisation_pct),
    turnover: value > 0 ? Math.round((Number(r.issue_value_12m) / value) * 100) / 100 : null,
    approvals_on_time_pct: n(r.approvals_on_time_pct),
  };
}

export function rate(key: KpiKey, v: number | null, targets: Record<string, { target: number | number[]; dir: string }>): "good" | "warn" | "bad" | "na" {
  const t = targets[key];
  if (v == null || !t) return "na";
  if (t.dir === "range") {
    const [lo, hi] = t.target as number[];
    return v >= lo && v <= hi ? "good" : v >= lo - 10 && v <= hi + 10 ? "warn" : "bad";
  }
  const tg = t.target as number;
  const ok = t.dir === "ge" ? v >= tg : v <= tg;
  if (ok) return "good";
  const gap = t.dir === "ge" ? (tg - v) / Math.max(1, tg) : (v - tg) / Math.max(1, tg);
  return gap <= 0.1 || (tg === 0 && v <= 1) ? "warn" : "bad";
}

export async function kpiBoard(c: Q, scope: "all" | string[]) {
  const values = await computeKpis(c, scope);
  const targets = await setting<Record<string, any>>(c as Tx, "kpi.targets", {});
  const trend = await many(c, `SELECT kpi, to_char(date_trunc('month', snap_date), 'YYYY-MM') AS month, round(avg(value), 2) AS value FROM kpi_snapshot
                               WHERE warehouse_id IS NULL AND snap_date > current_date - interval '6 months' GROUP BY 1, 2 ORDER BY 2`);
  return KPI_KEYS.map((k) => ({ key: k, label_ar: KPI_LABEL[k][0], label_en: KPI_LABEL[k][1], unit: KPI_LABEL[k][2], value: values[k],
    target: targets[k]?.target ?? null, dir: targets[k]?.dir ?? null, status: rate(k, values[k], targets),
    trend: trend.filter((t) => t.kpi === k).map((t) => ({ month: t.month, value: Number(t.value) })) }));
}

/** Daily snapshot (authority-wide and per warehouse). Idempotent per day. */
export async function snapshotKpis(c: Tx, date?: string) {
  const day = date ?? new Date().toISOString().slice(0, 10);
  const whs = await many(c, "SELECT id FROM warehouse WHERE deleted_at IS NULL");
  for (const scope of [null, ...whs.map((w) => w.id as string)]) {
    const v = await computeKpis(c, scope ? [scope] : "all");
    for (const k of KPI_KEYS) {
      await c.query(`INSERT INTO kpi_snapshot (snap_date, kpi, warehouse_id, value) VALUES ($1,$2,$3,$4)
                     ON CONFLICT (snap_date, kpi, coalesce(warehouse_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET value = EXCLUDED.value`,
        [day, k, scope, v[k]]);
    }
  }
}
