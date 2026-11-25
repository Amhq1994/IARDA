// Transfers: bin-to-bin moves (immediate, scan-validated) and inter-warehouse transfers
// Draft → Pending approval (source WM) → Approved → In transit → Received (→ Closed, or discrepancy → adjustment).
import { one, many } from "../db/pool.ts";
import { E, ApiError } from "../lib/errors.ts";
import { docEvent, findItemId, findLocation, nextDocNo, notify, post, round4, type Tx } from "./common.ts";
import { validateBin, suggestBins } from "./putaway.ts";
import { pickingRule } from "./requests.ts";
import { approversOfDoc, lockDoc, submitDoc } from "./approvals.ts";

const ORDER: Record<string, string> = {
  FEFO: "expiry_date ASC NULLS LAST, first_received_at ASC NULLS LAST, pick_sequence",
  FIFO: "first_received_at ASC NULLS LAST, expiry_date ASC NULLS LAST, pick_sequence",
  LIFO: "first_received_at DESC NULLS LAST, pick_sequence",
};

const avgCost = async (c: Tx, itemId: string, whId: string) =>
  Number((await one(c, "SELECT avg_cost FROM item_valuation WHERE item_id = $1 AND warehouse_id = $2", [itemId, whId]))?.avg_cost ?? 0);

/** Moves free stock between two bins of the same warehouse (scan both). */
export async function moveBin(c: Tx, actorId: string, b: { from: string; to: string; item: string; lot?: string | null; qty: number; warehouseScope: "all" | string[] }) {
  const from = await findLocation(c, b.from);
  const to = await findLocation(c, b.to);
  if (!from || !to) throw new ApiError(422, "unknown_location", "الموقع غير موجود", "Location not found");
  if (from.warehouse_id !== to.warehouse_id) throw new ApiError(422, "different_warehouse", "النقل بين المواقع داخل نفس المستودع فقط", "Bin moves must stay within one warehouse");
  if (b.warehouseScope !== "all" && !b.warehouseScope.includes(from.warehouse_id)) throw E.outOfScope();
  if (from.id === to.id) throw E.invalid([{ path: "to", message: "same_location" }]);
  const itemId = await findItemId(c, b.item);
  if (!itemId) throw E.notFound("item");
  const bal = await one(c, `SELECT b.*, sl.lot_no, sl.serial_no FROM stock_balance b LEFT JOIN stock_lot sl ON sl.id = b.lot_id
                            WHERE b.item_id = $1 AND b.location_id = $2 AND b.stock_status = 'available' AND b.qty_on_hand - b.qty_reserved > 0
                              AND ($3::text IS NULL OR sl.lot_no = $3 OR sl.serial_no = $3) ORDER BY b.qty_on_hand DESC LIMIT 1`, [itemId, from.id, b.lot ?? null]);
  if (!bal) throw new ApiError(409, "nothing_to_move", "لا يوجد رصيد متاح لهذا الصنف في الموقع", "No free stock of this item in the source bin");
  if (b.qty > Number(bal.qty_on_hand) - Number(bal.qty_reserved) + 1e-9) throw new ApiError(409, "insufficient_stock", "الكمية أكبر من المتاح غير المحجوز", "Quantity exceeds free (unreserved) stock");
  if (!(await validateBin(c, { itemId, warehouseId: to.warehouse_id, locationId: to.id, qty: b.qty }))) {
    throw new ApiError(409, "bin_not_suitable", "الخانة غير مناسبة (السعة أو التوافق أو موقوفة)", "Bin is not suitable (capacity, compatibility or blocked)");
  }
  const cost = await avgCost(c, itemId, from.warehouse_id);
  const doc = { docType: "MOVE", docNo: `MV-${Date.now().toString(36).toUpperCase()}`, itemId, lotId: bal.lot_id };
  await post(c, { ...doc, movement: "MOVE_OUT", locationId: from.id, qty: -b.qty });
  await post(c, { ...doc, movement: "MOVE_IN", locationId: to.id, qty: b.qty, unitCost: cost });
  return { from: from.full_code, to: to.full_code, qty: b.qty };
}

// ------------------------------------------------------------------ inter-warehouse
export async function createTransfer(c: Tx, actorId: string, b: { fromWarehouseId: string; toWarehouseId: string; reason?: string; neededBy?: string | null;
  lines: { itemId: string; qty: number }[] }) {
  if (b.fromWarehouseId === b.toWarehouseId) throw E.invalid([{ path: "toWarehouseId", message: "must_differ" }]);
  const no = await nextDocNo(c, "TR");
  const tr = await one(c, `INSERT INTO transfer_order (tr_no, from_warehouse_id, to_warehouse_id, requested_by, reason, needed_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [no, b.fromWarehouseId, b.toWarehouseId, actorId, b.reason ?? null, b.neededBy ?? null]);
  let n = 0, value = 0;
  for (const l of b.lines) {
    const it = await one(c, "SELECT status, item_type FROM item WHERE id = $1", [l.itemId]);
    if (!it || it.status !== "active" || it.item_type === "non_stock") throw E.invalid([{ path: `lines.${n}.itemId`, message: "item_not_active" }]);
    await c.query("INSERT INTO transfer_line (transfer_id, line_no, item_id, qty_requested) VALUES ($1,$2,$3,$4)", [tr.id, ++n, l.itemId, l.qty]);
    value += l.qty * (await avgCost(c, l.itemId, b.fromWarehouseId));
  }
  if (!n) throw E.invalid([{ path: "lines", message: "at_least_one_line" }]);
  const out = await one(c, "UPDATE transfer_order SET estimated_value = $2 WHERE id = $1 RETURNING *", [tr.id, Math.round(value * 100) / 100]);
  await docEvent(c, "TR", tr.id, "created", { to: "draft", actorId });
  return out;
}

export async function submitTransfer(c: Tx, actorId: string, id: string) {
  const tr = await lockDoc(c, "TR", id);
  if (tr.status !== "draft") throw E.state(tr.status, "submit");
  if (tr.requested_by !== actorId) throw E.forbidden("own transfer only");
  const cats = await many(c, `SELECT DISTINCT g.parent_id AS id FROM transfer_line l JOIN item i ON i.id = l.item_id JOIN item_category g ON g.id = i.group_id WHERE l.transfer_id = $1`, [id]);
  return submitDoc(c, actorId, "TR", tr, { value: Number(tr.estimated_value), warehouseId: tr.from_warehouse_id, categoryIds: cats.map((x) => x.id) });
}

async function dockBin(c: Tx, warehouseId: string) {
  const d = await one(c, `SELECT l.id FROM location l JOIN location r ON r.id = l.parent_id JOIN location a ON a.id = r.parent_id JOIN location z ON z.id = a.parent_id
                          WHERE l.warehouse_id = $1 AND l.level = 'bin' AND z.zone_type = 'receiving' AND NOT l.is_blocked AND l.deleted_at IS NULL ORDER BY l.full_code LIMIT 1`, [warehouseId]);
  if (!d) throw new ApiError(409, "no_dock", "لا توجد خانة استلام متاحة", "No receiving dock bin available");
  return d.id as string;
}

/** Picks free stock at the source by the item's picking rule and books it in transit at the destination dock. */
export async function shipTransfer(c: Tx, actorId: string, id: string) {
  const tr = await lockDoc(c, "TR", id);
  if (tr.status !== "approved") throw E.state(tr.status, "ship");
  if ((await approversOfDoc(c, "TR", id)).includes(actorId)) throw E.sod("SoD-2", "من اعتمد النقل لا يشحنه", "An approver of the transfer cannot ship it");
  const transit = await dockBin(c, tr.to_warehouse_id);
  const lines = await many(c, "SELECT * FROM transfer_line WHERE transfer_id = $1 ORDER BY line_no", [id]);
  let shipped = 0;
  for (const l of lines) {
    let need = Number(l.qty_requested);
    const rule = await pickingRule(c, l.item_id, tr.from_warehouse_id);
    const cost = await avgCost(c, l.item_id, tr.from_warehouse_id);
    for (const b of await many(c, `SELECT * FROM v_pickable_stock WHERE item_id = $1 AND warehouse_id = $2 ORDER BY ${ORDER[rule]}`, [l.item_id, tr.from_warehouse_id])) {
      if (need <= 0) break;
      const q = Math.min(need, Number(b.qty_free));
      const doc = { docType: "TR", docId: id, docNo: tr.tr_no, docLineId: l.id, itemId: l.item_id, lotId: b.lot_id };
      await post(c, { ...doc, movement: "TR_OUT", locationId: b.location_id, qty: -q });
      await post(c, { ...doc, movement: "TR_IN_TRANSIT", locationId: transit, status: "in_transit", qty: q, unitCost: cost });
      await c.query(`INSERT INTO transfer_shipment (transfer_line_id, item_id, lot_id, from_location_id, transit_location_id, qty, unit_cost) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [l.id, l.item_id, b.lot_id, b.location_id, transit, q, cost]);
      need = round4(need - q);
      shipped += q;
    }
    await c.query("UPDATE transfer_line SET qty_shipped = $2 WHERE id = $1", [l.id, round4(Number(l.qty_requested) - Math.max(need, 0))]);
  }
  if (shipped <= 0) throw new ApiError(409, "out_of_stock", "لا يتوفر مخزون قابل للشحن", "No stock available to ship");
  await c.query("UPDATE transfer_order SET status = 'in_transit', shipped_at = now(), shipped_by = $2 WHERE id = $1", [id, actorId]);
  await docEvent(c, "TR", id, "shipped", { from: "approved", to: "in_transit", actorId });
  const keepers = await many(c, `SELECT DISTINCT u.id FROM app_user u JOIN user_role ur ON ur.user_id = u.id AND ur.is_active JOIN role r ON r.id = ur.role_id AND r.code IN ('SK','WM')
                                 WHERE ur.warehouse_ids IS NULL OR $1 = ANY(ur.warehouse_ids)`, [tr.to_warehouse_id]);
  await notify(c, keepers.map((k) => k.id), { kind: "transfer_inbound", titleAr: `نقل وارد في الطريق — ${tr.tr_no}`, titleEn: `Inbound transfer in transit — ${tr.tr_no}`,
    link: `/transfers/${id}`, docType: "TR", docId: id });
}

/** Receives in-transit stock at the destination: makes it available at the dock and creates put-away tasks. */
export async function receiveTransfer(c: Tx, actorId: string, id: string, lines?: { shipmentId: string; qty: number }[]) {
  const tr = await lockDoc(c, "TR", id);
  if (tr.status !== "in_transit") throw E.state(tr.status, "receive");
  if (tr.shipped_by === actorId) throw E.sod("SoD-2", "من شحن النقل لا يستلمه", "The shipper cannot receive the same transfer");
  const ships = await many(c, `SELECT s.* FROM transfer_shipment s JOIN transfer_line l ON l.id = s.transfer_line_id WHERE l.transfer_id = $1`, [id]);
  const qtyFor = (s: any) => (lines ? lines.find((x) => x.shipmentId === s.id)?.qty ?? 0 : Number(s.qty));
  let short = false;
  for (const s of ships) {
    const q = qtyFor(s);
    if (q < 0 || q > Number(s.qty) + 1e-9) throw E.invalid([{ path: "qty", message: "exceeds_shipped" }]);
    if (q < Number(s.qty) - 1e-9) short = true;
    if (q <= 0) continue;
    const doc = { docType: "TR", docId: id, docNo: tr.tr_no, docLineId: s.transfer_line_id, itemId: s.item_id, lotId: s.lot_id };
    // value-neutral status change at the destination's average cost (the cost was blended in when stock entered transit)
    const outId = await post(c, { ...doc, movement: "TR_RECEIVE_OUT", locationId: s.transit_location_id, status: "in_transit", qty: -q });
    const outCost = Number((await one(c, "SELECT unit_cost FROM stock_ledger WHERE id = $1", [outId])).unit_cost);
    await post(c, { ...doc, movement: "TR_RECEIVE_IN", locationId: s.transit_location_id, qty: q, unitCost: outCost });
    await c.query("UPDATE transfer_shipment SET qty_received = $2 WHERE id = $1", [s.id, q]);
    await c.query("UPDATE transfer_line SET qty_received = qty_received + $2 WHERE id = $1", [s.transfer_line_id, q]);
    const sug = await suggestBins(c, { itemId: s.item_id, warehouseId: tr.to_warehouse_id, qty: q, excludeLocationId: s.transit_location_id });
    await c.query(`INSERT INTO putaway_task (task_no, transfer_id, warehouse_id, item_id, lot_id, qty, from_location_id, suggested_location_id, suggestion)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [await nextDocNo(c, "PUT"), id, tr.to_warehouse_id, s.item_id, s.lot_id, q, s.transit_location_id,
      sug[0]?.locationId ?? null, JSON.stringify(sug)]);
  }
  const next = short ? "received" : "closed";
  await c.query("UPDATE transfer_order SET status = $2, received_at = now(), received_by = $3, has_discrepancy = $4 WHERE id = $1", [id, next, actorId, short]);
  await docEvent(c, "TR", id, short ? "received_with_discrepancy" : "received", { from: "in_transit", to: next, actorId });
  if (short) {
    // the shortfall stays in transit and is written off through an approved adjustment
    const adjNo = await nextDocNo(c, "ADJ");
    const adj = await one(c, `INSERT INTO adjustment (adj_no, warehouse_id, source, transfer_id, reason) VALUES ($1,$2,'transit',$3,$4) RETURNING *`,
      [adjNo, tr.to_warehouse_id, id, `فرق استلام نقل ${tr.tr_no} / transfer receipt shortfall`]);
    let value = 0;
    for (const s of ships) {
      const gap = round4(Number(s.qty) - qtyFor(s));
      if (gap <= 0) continue;
      await c.query(`INSERT INTO adjustment_line (adjustment_id, item_id, location_id, lot_id, stock_status, qty_delta, unit_cost, value, reason)
                     VALUES ($1,$2,$3,$4,'in_transit',$5,$6,$7,'transit_shortfall')`, [adj.id, s.item_id, s.transit_location_id, s.lot_id, -gap, s.unit_cost, -gap * Number(s.unit_cost)]);
      value += gap * Number(s.unit_cost);
    }
    await c.query("UPDATE adjustment SET value_abs = $2, value_net = $3 WHERE id = $1", [adj.id, Math.round(value * 100) / 100, -Math.round(value * 100) / 100]);
    await docEvent(c, "ADJ", adj.id, "created", { to: "draft", actorId, data: { transfer: tr.tr_no } });
    return { status: next, adjustmentId: adj.id };
  }
  return { status: next };
}
