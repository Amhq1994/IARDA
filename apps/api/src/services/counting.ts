// Stock counting (annual / cycle by ABC / surprise; blind by default), recount on out-of-tolerance
// variance by a different counter, review → adjustment with DoA approval and SoD-3
// (counter ≠ approver ≠ poster), and disposals / write-offs with committee minutes (SoD-5).
import { one, many } from "../db/pool.ts";
import { E, ApiError } from "../lib/errors.ts";
import { docEvent, findItemId, findLocation, nextDocNo, notify, post, round4, setting, type Tx } from "./common.ts";
import { approversOfDoc, lockDoc, submitDoc, decideDoc } from "./approvals.ts";

const FREQ_DAYS: Record<string, number> = { A: 30, B: 90, C: 180 };

const avgCost = async (c: Tx, itemId: string, whId: string) =>
  Number((await one(c, "SELECT avg_cost FROM item_valuation WHERE item_id = $1 AND warehouse_id = $2", [itemId, whId]))?.avg_cost ?? 0);

export async function createPlan(c: Tx, actorId: string, b: { warehouseId: string; countType: "annual" | "cycle" | "surprise"; blind?: boolean;
  abcClasses?: string[] | null; zoneIds?: string[] | null; itemIds?: string[] | null; sampleSize?: number | null; counterIds: string[]; scheduledFor?: string; notes?: string }) {
  if (!b.counterIds.length) throw E.invalid([{ path: "counterIds", message: "at_least_one_counter" }]);
  const ok = await many(c, `SELECT DISTINCT u.id FROM app_user u JOIN user_role ur ON ur.user_id = u.id AND ur.is_active
                             JOIN role_permission rp ON rp.role_id = ur.role_id AND rp.permission_key = 'count.execute' AND rp.is_granted
                            WHERE u.id = ANY($1) AND u.status = 'active'`, [b.counterIds]);
  if (ok.length !== new Set(b.counterIds).size) throw E.invalid([{ path: "counterIds", message: "counters_need_count_permission" }]);
  const plan = await one(c, `INSERT INTO count_plan (plan_no, warehouse_id, count_type, blind, abc_classes, zone_ids, item_ids, sample_size, counter_ids, scheduled_for, notes)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::date, current_date),$11) RETURNING *`,
    [await nextDocNo(c, "CNT"), b.warehouseId, b.countType, b.blind ?? true, b.abcClasses ?? (b.countType === "cycle" ? ["A", "B", "C"] : null),
     b.zoneIds ?? null, b.itemIds ?? null, b.sampleSize ?? (b.countType === "surprise" ? 15 : null), b.counterIds, b.scheduledFor ?? null, b.notes ?? null]);
  await docEvent(c, "CNT", plan.id, "created", { to: "draft", actorId });
  return plan;
}

/** Snapshots the balances in scope and opens the count. */
export async function releasePlan(c: Tx, actorId: string, id: string) {
  const p = await one(c, "SELECT * FROM count_plan WHERE id = $1 FOR UPDATE", [id]);
  if (!p) throw E.notFound("count plan");
  if (p.status !== "draft") throw E.state(p.status, "release");
  const params: unknown[] = [p.warehouse_id];
  const where = ["b.warehouse_id = $1", "b.qty_on_hand > 0", "b.stock_status IN ('available','quarantine','damaged')"];
  if (p.zone_ids?.length) { params.push(p.zone_ids); where.push(`z.id = ANY($${params.length})`); }
  if (p.item_ids?.length) { params.push(p.item_ids); where.push(`b.item_id = ANY($${params.length})`); }
  if (p.count_type === "cycle") {
    params.push(p.abc_classes ?? ["A", "B", "C"]);
    where.push(`coalesce(i.abc_class, 'C') = ANY($${params.length})`);
    // due when never counted, or last count older than the class frequency
    where.push(`NOT EXISTS (SELECT 1 FROM count_line cl JOIN count_plan cp ON cp.id = cl.plan_id
                 WHERE cl.item_id = b.item_id AND cp.warehouse_id = b.warehouse_id AND cl.status = 'final'
                   AND cl.counted1_at > now() - make_interval(days => CASE coalesce(i.abc_class,'C') WHEN 'A' THEN ${FREQ_DAYS.A} WHEN 'B' THEN ${FREQ_DAYS.B} ELSE ${FREQ_DAYS.C} END))`);
  }
  const order = p.count_type === "surprise" ? "random()" : "l.pick_sequence, l.full_code";
  const limit = p.count_type === "surprise" ? `LIMIT ${Math.max(1, Number(p.sample_size ?? 15))}` : "";
  const rows = await many(c, `SELECT b.item_id, b.location_id, b.lot_id, b.stock_status, b.qty_on_hand
      FROM stock_balance b JOIN item i ON i.id = b.item_id JOIN location l ON l.id = b.location_id
      JOIN location r ON r.id = l.parent_id JOIN location a ON a.id = r.parent_id JOIN location z ON z.id = a.parent_id
     WHERE ${where.join(" AND ")} ORDER BY ${order} ${limit}`, params);
  if (!rows.length) throw new ApiError(409, "nothing_to_count", "لا توجد أرصدة ضمن نطاق الجرد", "No stock in the count scope");
  for (const r of rows) {
    await c.query(`INSERT INTO count_line (plan_id, item_id, location_id, lot_id, stock_status, qty_snapshot) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, r.item_id, r.location_id, r.lot_id, r.stock_status, r.qty_on_hand]);
  }
  await c.query("UPDATE count_plan SET status = 'counting', released_at = now(), released_by = $2 WHERE id = $1", [id, actorId]);
  await docEvent(c, "CNT", id, "released", { from: "draft", to: "counting", actorId, data: { lines: rows.length } });
  await notify(c, p.counter_ids, { kind: "count_task", titleAr: `مهمة جرد ${p.plan_no} (${rows.length} بنداً)`, titleEn: `Count task ${p.plan_no} (${rows.length} lines)`,
    link: `/m/count/${id}`, docType: "CNT", docId: id });
  return { lines: rows.length };
}

async function systemQty(c: Tx, l: any) {
  const r = await one(c, `SELECT coalesce(sum(qty_on_hand), 0) AS q FROM stock_balance WHERE item_id = $1 AND location_id = $2
                          AND lot_key = coalesce($3::uuid, '00000000-0000-0000-0000-000000000000') AND stock_status = $4`, [l.item_id, l.location_id, l.lot_id, l.stock_status]);
  return Number(r.q);
}

async function tolerancePct(c: Tx, itemId: string) {
  const tol = await setting<Record<string, number>>(c, "count.tolerance_pct", { A: 0, B: 2, C: 2 });
  const it = await one(c, "SELECT abc_class FROM item WHERE id = $1", [itemId]);
  return Number(tol[it?.abc_class ?? "C"] ?? 2);
}

/** Records a count. First count outside tolerance asks for a recount by a different counter. */
export async function recordCount(c: Tx, actorId: string, lineId: string, qty: number, reason?: string) {
  const l = await one(c, "SELECT cl.*, p.counter_ids, p.status AS plan_status FROM count_line cl JOIN count_plan p ON p.id = cl.plan_id WHERE cl.id = $1 FOR UPDATE OF cl", [lineId]);
  if (!l) throw E.notFound("count line");
  if (l.plan_status !== "counting") throw E.state(l.plan_status, "count");
  if (!l.counter_ids.includes(actorId)) throw E.forbidden("assigned counter");
  if (qty < 0) throw E.invalid([{ path: "qty", message: "negative" }]);
  const sys = await systemQty(c, l);
  const tol = await tolerancePct(c, l.item_id);
  const within = Math.abs(qty - sys) <= Math.max(sys * tol / 100, 0) + 1e-9;
  if (l.status === "open" || (l.status === "counted" && l.counted1_by === actorId && l.qty_count2 == null)) {
    await c.query(`UPDATE count_line SET qty_count1 = $2, qty_system1 = $3, counted1_by = $4, counted1_at = now(), within_tolerance = $5,
                     status = $6, reason = coalesce($7, reason) WHERE id = $1`, [lineId, qty, sys, actorId, within, within ? "counted" : "recount", reason ?? null]);
    return { status: within ? "counted" : "recount" };
  }
  if (l.status === "recount") {
    if (l.counted1_by === actorId) throw E.sod("COUNT-2", "إعادة الجرد تتم بواسطة عضو آخر", "The recount must be done by a different counter");
    await c.query(`UPDATE count_line SET qty_count2 = $2, qty_system2 = $3, counted2_by = $4, counted2_at = now(), within_tolerance = $5, status = 'counted',
                     reason = coalesce($6, reason) WHERE id = $1`, [lineId, qty, sys, actorId, within, reason ?? null]);
    return { status: "counted" };
  }
  throw E.state(l.status, "count");
}

/** Bin contains an item that was not on the count sheet. */
export async function addUnplanned(c: Tx, actorId: string, planId: string, b: { location: string; item: string; lot?: string | null; qty: number }) {
  const p = await one(c, "SELECT * FROM count_plan WHERE id = $1", [planId]);
  if (!p || p.status !== "counting") throw E.state(p?.status ?? "unknown", "count");
  if (!p.counter_ids.includes(actorId)) throw E.forbidden("assigned counter");
  const loc = await findLocation(c, b.location, p.warehouse_id);
  const itemId = await findItemId(c, b.item);
  if (!loc || !itemId) throw E.notFound("location or item");
  const lot = b.lot ? await one(c, "SELECT id FROM stock_lot WHERE item_id = $1 AND (lot_no = $2 OR serial_no = $2)", [itemId, b.lot]) : null;
  const exists = await one(c, `SELECT id FROM count_line WHERE plan_id = $1 AND item_id = $2 AND location_id = $3 AND lot_id IS NOT DISTINCT FROM $4`, [planId, itemId, loc.id, lot?.id ?? null]);
  if (exists) return recordCount(c, actorId, exists.id, b.qty);
  const line = await one(c, `INSERT INTO count_line (plan_id, item_id, location_id, lot_id, stock_status, qty_snapshot, is_unplanned) VALUES ($1,$2,$3,$4,'available',0,true) RETURNING id`,
    [planId, itemId, loc.id, lot?.id ?? null]);
  return recordCount(c, actorId, line.id, b.qty);
}

/** Review: freezes final quantities, computes variances, raises an adjustment and routes it for approval. */
export async function finishCount(c: Tx, actorId: string, planId: string) {
  const p = await one(c, "SELECT * FROM count_plan WHERE id = $1 FOR UPDATE", [planId]);
  if (!p) throw E.notFound("count plan");
  if (p.status !== "counting") throw E.state(p.status, "finish");
  const open = await one(c, "SELECT count(*) FILTER (WHERE status = 'open')::int AS open, count(*) FILTER (WHERE status = 'recount')::int AS recount FROM count_line WHERE plan_id = $1", [planId]);
  if (open.open || open.recount) throw new ApiError(409, "count_incomplete", `بنود لم تُجرد: ${open.open} · بانتظار إعادة الجرد: ${open.recount}`,
    `Uncounted lines: ${open.open} · awaiting recount: ${open.recount}`, open);
  const lines = await many(c, "SELECT * FROM count_line WHERE plan_id = $1", [planId]);
  const variances: any[] = [];
  for (const l of lines) {
    const final = Number(l.qty_count2 ?? l.qty_count1);
    const sys = Number(l.qty_count2 != null ? l.qty_system2 : l.qty_system1);
    const cost = await avgCost(c, l.item_id, p.warehouse_id);
    const v = round4(final - sys);
    await c.query("UPDATE count_line SET final_qty = $2, variance_qty = $3, variance_value = $4, unit_cost = $5, status = 'final' WHERE id = $1",
      [l.id, final, v, Math.round(v * cost * 100) / 100, cost]);
    if (Math.abs(v) > 1e-9) variances.push({ ...l, v, cost });
  }
  await c.query("UPDATE count_plan SET status = $2, reviewed_at = now(), reviewed_by = $3, closed_at = CASE WHEN $2 = 'closed' THEN now() END WHERE id = $1",
    [planId, variances.length ? "review" : "closed", actorId]);
  await docEvent(c, "CNT", planId, "count_completed", { from: "counting", to: variances.length ? "review" : "closed", actorId, data: { lines: lines.length, variances: variances.length } });
  if (!variances.length) return { variances: 0 };
  const adj = await one(c, `INSERT INTO adjustment (adj_no, warehouse_id, source, count_plan_id, reason) VALUES ($1,$2,'count',$3,$4) RETURNING *`,
    [await nextDocNo(c, "ADJ"), p.warehouse_id, planId, `فروقات جرد ${p.plan_no} / count variances`]);
  let abs = 0, net = 0;
  for (const v of variances) {
    await c.query(`INSERT INTO adjustment_line (adjustment_id, count_line_id, item_id, location_id, lot_id, stock_status, qty_delta, unit_cost, value, reason)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [adj.id, v.id, v.item_id, v.location_id, v.lot_id, v.stock_status, v.v, v.cost, Math.round(v.v * v.cost * 100) / 100, v.reason ?? "count_variance"]);
    abs += Math.abs(v.v * v.cost); net += v.v * v.cost;
  }
  await c.query("UPDATE adjustment SET value_abs = $2, value_net = $3 WHERE id = $1", [adj.id, Math.round(abs * 100) / 100, Math.round(net * 100) / 100]);
  await docEvent(c, "ADJ", adj.id, "created", { to: "draft", actorId, data: { count: p.plan_no } });
  await submitAdjustment(c, actorId, adj.id);
  return { variances: variances.length, adjustmentId: adj.id };
}

// ------------------------------------------------------------------ adjustments
export async function createAdjustment(c: Tx, actorId: string, b: { warehouseId: string; reason: string;
  lines: { locationId: string; itemId: string; lotId?: string | null; stockStatus?: string; qtyDelta: number; reason?: string }[] }) {
  const adj = await one(c, `INSERT INTO adjustment (adj_no, warehouse_id, source, reason) VALUES ($1,$2,'manual',$3) RETURNING *`, [await nextDocNo(c, "ADJ"), b.warehouseId, b.reason]);
  let abs = 0, net = 0;
  for (const l of b.lines) {
    const loc = await one(c, "SELECT warehouse_id, level FROM location WHERE id = $1", [l.locationId]);
    if (!loc || loc.warehouse_id !== b.warehouseId || loc.level !== "bin") throw E.invalid([{ path: "locationId", message: "bin_in_warehouse" }]);
    const cost = await avgCost(c, l.itemId, b.warehouseId) || Number((await one(c, "SELECT standard_cost FROM item WHERE id = $1", [l.itemId]))?.standard_cost ?? 0);
    await c.query(`INSERT INTO adjustment_line (adjustment_id, item_id, location_id, lot_id, stock_status, qty_delta, unit_cost, value, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [adj.id, l.itemId, l.locationId, l.lotId ?? null, l.stockStatus ?? "available", l.qtyDelta, cost, Math.round(l.qtyDelta * cost * 100) / 100, l.reason ?? null]);
    abs += Math.abs(l.qtyDelta * cost); net += l.qtyDelta * cost;
  }
  const out = await one(c, "UPDATE adjustment SET value_abs = $2, value_net = $3 WHERE id = $1 RETURNING *", [adj.id, Math.round(abs * 100) / 100, Math.round(net * 100) / 100]);
  await docEvent(c, "ADJ", adj.id, "created", { to: "draft", actorId });
  return out;
}

export async function submitAdjustment(c: Tx, actorId: string, id: string) {
  const adj = await lockDoc(c, "ADJ", id);
  if (adj.status !== "draft") throw E.state(adj.status, "submit");
  const cats = await many(c, `SELECT DISTINCT g.parent_id AS id FROM adjustment_line l JOIN item i ON i.id = l.item_id JOIN item_category g ON g.id = i.group_id WHERE l.adjustment_id = $1`, [id]);
  return submitDoc(c, actorId, "ADJ", adj, { value: Number(adj.value_abs), warehouseId: adj.warehouse_id, categoryIds: cats.map((x) => x.id), requesterId: adj.created_by });
}

async function countersOf(c: Tx, adj: any): Promise<string[]> {
  if (!adj.count_plan_id) return [];
  return (await many(c, `SELECT DISTINCT unnest(ARRAY[counted1_by, counted2_by]) AS u FROM count_line WHERE plan_id = $1`, [adj.count_plan_id])).map((r) => r.u).filter(Boolean);
}

export async function decideAdjustment(c: Tx, actorId: string, id: string, action: "approve" | "reject" | "return", comment?: string) {
  const adj = await one(c, "SELECT * FROM adjustment WHERE id = $1", [id]);
  if (!adj) throw E.notFound("adjustment");
  return decideDoc(c, actorId, "ADJ", id, action, comment, { ids: await countersOf(c, adj), rule: "SoD-3",
    ar: "من شارك في الجرد لا يعتمد التسوية", en: "A counter cannot approve the resulting adjustment" });
}

/** SoD-3: the poster is neither the creator, an approver, nor a counter. */
export async function postAdjustment(c: Tx, actorId: string, id: string) {
  const adj = await lockDoc(c, "ADJ", id);
  if (adj.status !== "approved") throw E.state(adj.status, "post");
  const forbidden = new Set([adj.created_by, ...(await approversOfDoc(c, "ADJ", id)), ...(await countersOf(c, adj))]);
  if (forbidden.has(actorId)) throw E.sod("SoD-3", "مُرحّل التسوية يجب أن يختلف عن منشئها ومعتمديها والقائمين بالجرد", "The poster must differ from the creator, approvers and counters");
  for (const l of await many(c, "SELECT * FROM adjustment_line WHERE adjustment_id = $1", [id])) {
    const ledgerId = await post(c, { docType: "ADJ", docId: id, docNo: adj.adj_no, docLineId: l.id, movement: Number(l.qty_delta) > 0 ? "ADJ_PLUS" : "ADJ_MINUS",
      itemId: l.item_id, locationId: l.location_id, lotId: l.lot_id, status: l.stock_status, qty: Number(l.qty_delta), unitCost: Number(l.unit_cost), notes: l.reason });
    await c.query("UPDATE adjustment_line SET ledger_id = $2 WHERE id = $1", [l.id, ledgerId]);
  }
  await c.query("UPDATE adjustment SET status = 'posted', posted_at = now(), posted_by = $2 WHERE id = $1", [id, actorId]);
  await docEvent(c, "ADJ", id, "posted", { from: "approved", to: "posted", actorId });
  if (adj.count_plan_id) await c.query("UPDATE count_plan SET status = 'closed', closed_at = now() WHERE id = $1 AND status = 'review'", [adj.count_plan_id]);
  if (adj.transfer_id) await c.query("UPDATE transfer_order SET status = 'closed' WHERE id = $1 AND status = 'received'", [adj.transfer_id]);
}

// ------------------------------------------------------------------ disposals / write-offs
export async function createDisposal(c: Tx, actorId: string, b: { warehouseId: string; method: "scrap" | "sell" | "donate" | "recycle"; reason: string;
  committeeIds: string[]; lines: { balanceId: string; qty: number }[] }) {
  const committee = [...new Set([actorId, ...b.committeeIds])];
  const members = await many(c, `SELECT DISTINCT u.id FROM app_user u JOIN user_role ur ON ur.user_id = u.id AND ur.is_active JOIN role r ON r.id = ur.role_id AND r.code = 'CDC'
                                 WHERE u.id = ANY($1)`, [committee]);
  if (members.length < 2 || members.length !== committee.length) throw E.invalid([{ path: "committeeIds", message: "at_least_2_CDC_members" }]);
  const d = await one(c, `INSERT INTO disposal (dsp_no, warehouse_id, method, reason, committee_ids) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [await nextDocNo(c, "DSP"), b.warehouseId, b.method, b.reason, committee]);
  let total = 0;
  for (const l of b.lines) {
    const bal = await one(c, "SELECT * FROM stock_balance WHERE id = $1", [l.balanceId]);
    if (!bal || bal.warehouse_id !== b.warehouseId) throw E.invalid([{ path: "balanceId", message: "stock_not_in_warehouse" }]);
    if (l.qty > Number(bal.qty_on_hand) - Number(bal.qty_reserved) + 1e-9) throw new ApiError(409, "insufficient_stock", "الكمية أكبر من المتاح", "Quantity exceeds free stock");
    const cost = await avgCost(c, bal.item_id, b.warehouseId);
    await c.query(`INSERT INTO disposal_line (disposal_id, item_id, location_id, lot_id, stock_status, qty, unit_cost, value) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [d.id, bal.item_id, bal.location_id, bal.lot_id, bal.stock_status, l.qty, cost, Math.round(l.qty * cost * 100) / 100]);
    total += l.qty * cost;
  }
  const out = await one(c, "UPDATE disposal SET total_value = $2 WHERE id = $1 RETURNING *", [d.id, Math.round(total * 100) / 100]);
  await docEvent(c, "DSP", d.id, "created", { to: "draft", actorId });
  return out;
}

/** Committee recommendation: requires the signed minutes; then routed WM → Finance (→ executive above SAR 25,000). */
export async function recommendDisposal(c: Tx, actorId: string, id: string) {
  const d = await lockDoc(c, "DSP", id);
  if (d.status !== "draft") throw E.state(d.status, "recommend");
  if (!d.committee_ids.includes(actorId)) throw E.forbidden("committee member");
  const minutes = await one(c, "SELECT id FROM attachment WHERE owner_type = 'disposal' AND owner_id = $1 AND category = 'minutes' AND deleted_at IS NULL", [id]);
  if (!minutes) throw new ApiError(409, "minutes_required", "يجب إرفاق محضر لجنة الإتلاف قبل التوصية", "The committee minutes must be attached before recommending");
  await c.query("UPDATE disposal SET recommended_by = $2, recommended_at = now() WHERE id = $1", [id, actorId]);
  const cats = await many(c, `SELECT DISTINCT g.parent_id AS id FROM disposal_line l JOIN item i ON i.id = l.item_id JOIN item_category g ON g.id = i.group_id WHERE l.disposal_id = $1`, [id]);
  return submitDoc(c, actorId, "DSP", { ...d, recommended_by: actorId }, { value: Number(d.total_value), warehouseId: d.warehouse_id, categoryIds: cats.map((x) => x.id), requesterId: actorId });
}

export async function decideDisposal(c: Tx, actorId: string, id: string, action: "approve" | "reject" | "return", comment?: string) {
  const d = await one(c, "SELECT committee_ids FROM disposal WHERE id = $1", [id]);
  if (!d) throw E.notFound("disposal");
  return decideDoc(c, actorId, "DSP", id, action, comment, { ids: d.committee_ids, rule: "SoD-5", ar: "عضو لجنة الإتلاف لا يعتمد توصيتها", en: "A committee member cannot approve its own recommendation" });
}

/** SoD-5: the committee recommends only; a storekeeper outside the committee and approval chain posts the write-off. */
export async function postDisposal(c: Tx, actorId: string, id: string) {
  const d = await lockDoc(c, "DSP", id);
  if (d.status !== "approved") throw E.state(d.status, "post");
  const forbidden = new Set([...d.committee_ids, ...(await approversOfDoc(c, "DSP", id))]);
  if (forbidden.has(actorId)) throw E.sod("SoD-5", "مُرحّل الإتلاف يجب أن يكون من خارج اللجنة ومسار الاعتماد", "The poster must be outside the committee and the approval chain");
  for (const l of await many(c, "SELECT * FROM disposal_line WHERE disposal_id = $1", [id])) {
    const ledgerId = await post(c, { docType: "DSP", docId: id, docNo: d.dsp_no, docLineId: l.id, movement: "SCRAP", itemId: l.item_id,
      locationId: l.location_id, lotId: l.lot_id, status: l.stock_status, qty: -Number(l.qty), notes: d.method });
    await c.query("UPDATE disposal_line SET ledger_id = $2 WHERE id = $1", [l.id, ledgerId]);
  }
  await c.query("UPDATE disposal SET status = 'posted', posted_at = now(), posted_by = $2 WHERE id = $1", [id, actorId]);
  await docEvent(c, "DSP", id, "posted", { from: "approved", to: "posted", actorId });
}
