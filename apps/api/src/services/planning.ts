// Inventory planning: demand statistics → safety stock, reorder point, EOQ, min/max; reorder suggestions,
// automatic purchase requisitions (DoA-approved, converted to POs by procurement), dead & slow-moving stock.
//
//   d   = average daily demand over the history window (ledger GI net of returns + legacy consumption history)
//   σd  = daily demand standard deviation (from 30-day buckets: σ30 / √30)
//   SS  = z · σd · √LT                      ROP = d · LT + SS
//   EOQ = √(2 · D · S / (H · c))            D = annual demand, S = ordering cost, H = holding rate, c = unit cost
//   min = SS, max = ROP + EOQ; reorder when free + on order ≤ ROP, up to max (at least one EOQ)
import { one, many } from "../db/pool.ts";
import { E, ApiError } from "../lib/errors.ts";
import { docEvent, nextDocNo, setting, round4, type Tx } from "./common.ts";
import { approversOfDoc, lockDoc, submitDoc } from "./approvals.ts";
import { createPo } from "./inbound.ts";

const BUCKET = 30;
const key = (i: string, w: string) => `${i}|${w}`;
const ceil = (n: number) => Math.ceil(n - 1e-9);

export interface PlanParams { z: number; orderCost: number; holdingRate: number; months: number; defaultLeadTime: number; deadDays: number; slowDays: number }

export async function planParams(c: Tx): Promise<PlanParams> {
  return {
    z: Number(await setting(c, "planning.service_level_z", 1.65)),
    orderCost: Number(await setting(c, "planning.order_cost_sar", 150)),
    holdingRate: Number(await setting(c, "planning.holding_rate", 0.2)),
    months: Number(await setting(c, "planning.history_months", 6)),
    defaultLeadTime: Number(await setting(c, "planning.default_lead_time_days", 14)),
    deadDays: Number(await setting(c, "planning.dead_stock_days", 180)),
    slowDays: Number(await setting(c, "planning.slow_moving_days", 90)),
  };
}

/** Pure computation for one item/warehouse (exported for tests and the API "what-if"). */
export function computeLine(buckets: number[], p: PlanParams & { leadTime: number; unitCost: number }) {
  const n = buckets.length;
  const mean30 = buckets.reduce((a, b) => a + b, 0) / n;
  const sd30 = n > 1 ? Math.sqrt(buckets.reduce((a, b) => a + (b - mean30) ** 2, 0) / (n - 1)) : 0;
  const d = mean30 / BUCKET;
  const sdD = sd30 / Math.sqrt(BUCKET);
  const ss = p.z * sdD * Math.sqrt(p.leadTime);
  const rop = d * p.leadTime + ss;
  const annual = d * 365;
  const eoq = annual > 0 && p.unitCost > 0 ? Math.sqrt((2 * annual * p.orderCost) / (p.holdingRate * p.unitCost)) : null;
  // forecast: weighted moving average of the three most recent 30-day buckets (bucket 0 = most recent)
  const w = [0.5, 0.3, 0.2];
  const used = buckets.slice(0, 3);
  const forecast = used.length ? used.reduce((a, b, i) => a + b * w[i], 0) / w.slice(0, used.length).reduce((a, b) => a + b, 0) : 0;
  const min = ceil(ss);
  const ropR = ceil(rop);
  const eoqR = eoq == null ? null : Math.max(1, ceil(eoq));
  return { d, sdD, forecast: round4(forecast), ss: min, rop: Math.max(ropR, min), eoq: eoqR, min, max: Math.max(ropR, min) + (eoqR ?? 0),
    monthsWithDemand: buckets.filter((b) => b > 0).length };
}

/** Computes a planning run for all stocked item/warehouse policies (optionally one warehouse). */
export async function runPlanning(c: Tx, actorId: string, warehouseId?: string | null) {
  const p = await planParams(c);
  const whArgs = warehouseId ? [warehouseId] : [];
  const whF = (col: string) => (warehouseId ? `AND ${col} = $1` : "");
  const policies = await many(c, `SELECT p.item_id, p.warehouse_id, p.min_qty, p.reorder_point, p.max_qty, p.lead_time_days,
        coalesce(v.avg_cost, i.standard_cost, 0) AS unit_cost
      FROM item_warehouse_policy p JOIN item i ON i.id = p.item_id
      LEFT JOIN item_valuation v ON v.item_id = p.item_id AND v.warehouse_id = p.warehouse_id
     WHERE p.deleted_at IS NULL AND p.is_stocked AND i.status = 'active' AND i.item_type <> 'non_stock' ${whF("p.warehouse_id")}`, whArgs);
  const horizon = p.months * BUCKET;
  const demand = new Map<string, number[]>();
  const add = (i: string, w: string, b: number, q: number) => {
    if (b < 0 || b >= p.months) return;
    const k = key(i, w);
    if (!demand.has(k)) demand.set(k, Array(p.months).fill(0));
    demand.get(k)![b] += q;
  };
  for (const r of await many(c, `SELECT item_id, warehouse_id, floor(extract(epoch FROM now() - posted_at) / ${BUCKET * 86400})::int AS b, -sum(qty) AS q
        FROM stock_ledger WHERE movement_type IN ('GI','RTW') AND posted_at > now() - make_interval(days => ${horizon}) ${whF("warehouse_id")}
       GROUP BY 1, 2, 3`, whArgs)) add(r.item_id, r.warehouse_id, r.b, Number(r.q));
  for (const r of await many(c, `SELECT item_id, warehouse_id, floor((current_date - (period + 14)) / ${BUCKET}.0)::int AS b, sum(qty) AS q
        FROM consumption_history WHERE period >= current_date - make_interval(days => ${horizon + 31}) ${whF("warehouse_id")} GROUP BY 1, 2, 3`, whArgs)) {
    add(r.item_id, r.warehouse_id, r.b, Number(r.q));
  }
  const pick = async (sql: string) => new Map((await many(c, sql, whArgs)).map((r) => [key(r.item_id, r.warehouse_id), r]));
  const onHand = await pick(`SELECT item_id, warehouse_id, sum(qty_on_hand) AS q FROM stock_balance WHERE stock_status <> 'in_transit' ${whF("warehouse_id")} GROUP BY 1, 2`);
  const free = await pick(`SELECT item_id, warehouse_id, sum(qty_free) AS q FROM v_pickable_stock WHERE true ${whF("warehouse_id")} GROUP BY 1, 2`);
  const onOrder = await pick(`SELECT item_id, warehouse_id, sum(q) AS q FROM (
        SELECT l.item_id, po.warehouse_id, greatest(l.qty_ordered - l.qty_received, 0) * l.factor_to_base AS q FROM po_line l JOIN purchase_order po ON po.id = l.po_id
         WHERE po.status IN ('open','partially_received')
        UNION ALL
        SELECT l.item_id, r.warehouse_id, l.qty FROM pr_line l JOIN purchase_requisition r ON r.id = l.pr_id WHERE r.status IN ('draft','pending_approval','approved')
      ) x WHERE true ${whF("warehouse_id")} GROUP BY 1, 2`);
  const firstIn = await pick(`SELECT item_id, warehouse_id, min(posted_at) AS at FROM stock_ledger WHERE qty > 0 ${whF("warehouse_id")} GROUP BY 1, 2`);
  const lastIssue = await pick(`SELECT item_id, warehouse_id, max(at) AS at FROM (
        SELECT item_id, warehouse_id, posted_at AS at FROM stock_ledger WHERE movement_type = 'GI'
        UNION ALL SELECT item_id, warehouse_id, (period + interval '1 month' - interval '1 day')::timestamptz FROM consumption_history WHERE qty > 0
      ) x WHERE true ${whF("warehouse_id")} GROUP BY 1, 2`);

  const run = await one(c, `INSERT INTO planning_run (run_no, warehouse_id, params) VALUES ($1,$2,$3) RETURNING *`,
    [await nextDocNo(c, "PLN"), warehouseId ?? null, JSON.stringify(p)]);
  let reorder = 0, dead = 0;
  for (const pol of policies) {
    const k = key(pol.item_id, pol.warehouse_id);
    const buckets = demand.get(k) ?? Array(p.months).fill(0);
    const lt = Number(pol.lead_time_days ?? p.defaultLeadTime);
    const cost = Number(pol.unit_cost);
    const x = computeLine(buckets.map((b) => Math.max(0, b)), { ...p, leadTime: lt, unitCost: cost });
    const oh = Number(onHand.get(k)?.q ?? 0), fr = Number(free.get(k)?.q ?? 0), oo = Number(onOrder.get(k)?.q ?? 0);
    const li: Date | null = lastIssue.get(k)?.at ?? null;
    const since = li ?? firstIn.get(k)?.at ?? null;  // never issued: idle since it first arrived
    const idle = since ? (Date.now() - new Date(since).getTime()) / 86400e3 : 0;
    let action = "ok", sug = 0;
    if (x.d <= 0) action = oh > 0 && idle >= p.deadDays ? "dead" : "no_demand";
    else if (fr + oo <= x.rop) { action = "reorder"; sug = ceil(Math.max(x.eoq ?? 1, x.max - (fr + oo))); }
    else if (x.max > 0 && oh > x.max * 2) action = "excess";
    if (action === "reorder") reorder++;
    if (action === "dead") dead++;
    await c.query(`INSERT INTO planning_line (run_id, item_id, warehouse_id, avg_daily_demand, demand_sd_daily, forecast_30d, months_with_demand, lead_time_days, unit_cost,
        safety_stock, reorder_point, eoq, min_qty, max_qty, cur_min, cur_rop, cur_max, on_hand, free_qty, on_order, suggested_qty, suggested_value, action, last_issue_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [run.id, pol.item_id, pol.warehouse_id, x.d, x.sdD, x.forecast, x.monthsWithDemand, lt, cost, x.ss, x.rop, x.eoq, x.min, x.max,
       pol.min_qty, pol.reorder_point, pol.max_qty, oh, fr, oo, sug, Math.round(sug * cost * 100) / 100, action, li]);
  }
  await c.query("UPDATE planning_run SET lines = $2, reorder_lines = $3, dead_lines = $4 WHERE id = $1", [run.id, policies.length, reorder, dead]);
  return { ...run, lines: policies.length, reorder_lines: reorder, dead_lines: dead };
}

/** Writes the computed min / safety stock / ROP / max / reorder qty into the item-warehouse policies. */
export async function applyPlan(c: Tx, actorId: string, runId: string, lineIds?: string[]) {
  const lines = await many(c, `SELECT * FROM planning_line WHERE run_id = $1 AND applied_at IS NULL AND action IN ('reorder','ok','excess')
                                ${lineIds?.length ? "AND id = ANY($2)" : ""}`, lineIds?.length ? [runId, lineIds] : [runId]);
  for (const l of lines) {
    await c.query(`UPDATE item_warehouse_policy SET min_qty = $3, safety_stock = $3, reorder_point = $4, max_qty = $5, reorder_qty = $6
                   WHERE item_id = $1 AND warehouse_id = $2 AND deleted_at IS NULL`, [l.item_id, l.warehouse_id, l.min_qty, l.reorder_point, l.max_qty, l.eoq]);
    await c.query("UPDATE planning_line SET applied_at = now(), applied_by = $2 WHERE id = $1", [l.id, actorId]);
  }
  return { applied: lines.length };
}

// ------------------------------------------------------------------ purchase requisitions
async function prLines(c: Tx, prId: string, lines: { itemId: string; qty: number; estUnitCost?: number; planningLineId?: string; notes?: string }[], warehouseId: string) {
  let n = 0, total = 0;
  for (const l of lines) {
    const it = await one(c, `SELECT i.status, i.item_type, coalesce(v.avg_cost, i.standard_cost, 0) AS cost FROM item i
                              LEFT JOIN item_valuation v ON v.item_id = i.id AND v.warehouse_id = $2 WHERE i.id = $1`, [l.itemId, warehouseId]);
    if (!it || it.status !== "active" || it.item_type === "non_stock") throw E.invalid([{ path: `lines.${n}.itemId`, message: "item_not_active" }]);
    const cost = l.estUnitCost ?? Number(it.cost);
    const value = Math.round(l.qty * cost * 100) / 100;
    await c.query(`INSERT INTO pr_line (pr_id, line_no, item_id, qty, est_unit_cost, value, planning_line_id, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [prId, ++n, l.itemId, l.qty, cost, value, l.planningLineId ?? null, l.notes ?? null]);
    total += value;
  }
  if (!n) throw E.invalid([{ path: "lines", message: "at_least_one_line" }]);
  return one(c, "UPDATE purchase_requisition SET estimated_value = $2 WHERE id = $1 RETURNING *", [prId, Math.round(total * 100) / 100]);
}

export async function createPr(c: Tx, actorId: string, b: { warehouseId: string; neededBy?: string | null; notes?: string | null; source?: "auto" | "manual";
  planningRunId?: string | null; lines: { itemId: string; qty: number; estUnitCost?: number; planningLineId?: string; notes?: string }[] }) {
  const pr = await one(c, `INSERT INTO purchase_requisition (pr_no, warehouse_id, source, planning_run_id, requested_by, needed_by, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [await nextDocNo(c, "PR"), b.warehouseId, b.source ?? "manual", b.planningRunId ?? null, actorId, b.neededBy ?? null, b.notes ?? null]);
  const out = await prLines(c, pr.id, b.lines, b.warehouseId);
  await docEvent(c, "PR", pr.id, "created", { to: "draft", actorId, data: { source: b.source ?? "manual" } });
  return out;
}

export async function submitPr(c: Tx, actorId: string, id: string) {
  const pr = await lockDoc(c, "PR", id);
  if (pr.status !== "draft") throw E.state(pr.status, "submit");
  const cats = await many(c, `SELECT DISTINCT g.parent_id AS id FROM pr_line l JOIN item i ON i.id = l.item_id JOIN item_category g ON g.id = i.group_id WHERE l.pr_id = $1`, [id]);
  return submitDoc(c, actorId, "PR", pr, { value: Number(pr.estimated_value), warehouseId: pr.warehouse_id, categoryIds: cats.map((x) => x.id) });
}

/** Auto-PR: one requisition per warehouse from the run's reorder suggestions, submitted for approval. */
export async function prsFromRun(c: Tx, actorId: string, runId: string, lineIds?: string[]) {
  const lines = await many(c, `SELECT * FROM planning_line WHERE run_id = $1 AND action = 'reorder' AND pr_id IS NULL AND suggested_qty > 0
                                ${lineIds?.length ? "AND id = ANY($2)" : ""} ORDER BY warehouse_id`, lineIds?.length ? [runId, lineIds] : [runId]);
  const byWh = new Map<string, any[]>();
  for (const l of lines) byWh.set(l.warehouse_id, [...(byWh.get(l.warehouse_id) ?? []), l]);
  const out: any[] = [];
  for (const [wh, ls] of byWh) {
    const pr = await createPr(c, actorId, { warehouseId: wh, source: "auto", planningRunId: runId, notes: "طلب شراء آلي من تشغيل التخطيط / auto-generated from planning",
      lines: ls.map((l) => ({ itemId: l.item_id, qty: Number(l.suggested_qty), estUnitCost: Number(l.unit_cost), planningLineId: l.id })) });
    await c.query("UPDATE planning_line SET pr_id = $2 WHERE id = ANY($1)", [ls.map((l) => l.id), pr.id]);
    await submitPr(c, actorId, pr.id);
    out.push({ id: pr.id, pr_no: pr.pr_no, lines: ls.length });
  }
  return out;
}

/** Procurement converts an approved requisition into a PO (the Etimad award reference is recorded on the PO). */
export async function convertPr(c: Tx, actorId: string, id: string, b: { supplierId: string; etimadRef?: string | null; expectedDate?: string | null;
  prices?: Record<string, number> }) {
  const pr = await lockDoc(c, "PR", id);
  if (pr.status !== "approved") throw E.state(pr.status, "convert");
  if ((await approversOfDoc(c, "PR", id)).includes(actorId)) throw E.sod("SoD-PR", "من اعتمد طلب الشراء لا يحوّله إلى أمر شراء", "An approver of the requisition cannot convert it to a PO");
  const lines = await many(c, "SELECT * FROM pr_line WHERE pr_id = $1 ORDER BY line_no", [id]);
  const po = await createPo(c, actorId, { supplierId: b.supplierId, warehouseId: pr.warehouse_id, etimadRef: b.etimadRef ?? null, expectedDate: b.expectedDate ?? null,
    notes: `من طلب الشراء ${pr.pr_no}`, lines: lines.map((l) => ({ itemId: l.item_id, qty: Number(l.qty), unitPrice: b.prices?.[l.id] ?? Number(l.est_unit_cost) })) });
  await c.query("UPDATE purchase_order SET pr_id = $2 WHERE id = $1", [po.id, id]);
  await c.query("UPDATE pr_line SET po_id = $2 WHERE pr_id = $1", [id, po.id]);
  await c.query("UPDATE purchase_requisition SET status = 'converted', converted_at = now(), converted_by = $2 WHERE id = $1", [id, actorId]);
  await docEvent(c, "PR", id, "converted", { from: "approved", to: "converted", actorId, data: { po: po.po_no } });
  return po;
}

export async function cancelPr(c: Tx, actorId: string, id: string, reason: string) {
  const pr = await lockDoc(c, "PR", id);
  if (!["draft", "approved"].includes(pr.status)) throw E.state(pr.status, "cancel");
  await c.query("UPDATE purchase_requisition SET status = 'cancelled', status_reason = $2 WHERE id = $1", [id, reason]);
  await docEvent(c, "PR", id, "cancelled", { from: pr.status, to: "cancelled", actorId, comment: reason });
}

/** Dead (no issue for ≥ deadDays) and slow-moving (≥ slowDays) stock with value. */
export async function deadStock(c: Tx, warehouseScope: "all" | string[], whId?: string) {
  const p = await planParams(c);
  const args: unknown[] = [p.slowDays];
  let f = "";
  if (whId) { args.push(whId); f += ` AND b.warehouse_id = $${args.length}`; }
  if (warehouseScope !== "all") { args.push(warehouseScope); f += ` AND b.warehouse_id = ANY($${args.length})`; }
  const rows = await many(c, `WITH oh AS (
        SELECT b.item_id, b.warehouse_id, sum(b.qty_on_hand) AS qty FROM stock_balance b WHERE b.qty_on_hand > 0 AND b.stock_status <> 'in_transit' ${f} GROUP BY 1, 2),
      li AS (SELECT item_id, warehouse_id, max(at) AS at FROM (
        SELECT item_id, warehouse_id, posted_at AS at FROM stock_ledger WHERE movement_type = 'GI'
        UNION ALL SELECT item_id, warehouse_id, (period + interval '1 month' - interval '1 day')::timestamptz FROM consumption_history WHERE qty > 0) x GROUP BY 1, 2),
      fi AS (SELECT item_id, warehouse_id, min(posted_at) AS at FROM stock_ledger WHERE qty > 0 GROUP BY 1, 2)
      SELECT oh.*, i.item_code, i.name_ar, i.name_en, i.abc_class, w.code AS warehouse_code, v.avg_cost, round(oh.qty * coalesce(v.avg_cost, 0), 2) AS value, li.at AS last_issue_at,
             floor(extract(epoch FROM now() - coalesce(li.at, fi.at)) / 86400)::int AS idle_days
        FROM oh JOIN item i ON i.id = oh.item_id JOIN warehouse w ON w.id = oh.warehouse_id
        LEFT JOIN item_valuation v ON v.item_id = oh.item_id AND v.warehouse_id = oh.warehouse_id
        LEFT JOIN li ON li.item_id = oh.item_id AND li.warehouse_id = oh.warehouse_id
        LEFT JOIN fi ON fi.item_id = oh.item_id AND fi.warehouse_id = oh.warehouse_id
       WHERE coalesce(li.at, fi.at) < now() - make_interval(days => $1)
       ORDER BY value DESC`, args);
  return rows.map((r) => ({ ...r, class: r.idle_days >= p.deadDays ? "dead" : "slow" }));
}

