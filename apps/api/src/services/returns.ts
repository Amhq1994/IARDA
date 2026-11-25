// Returns to warehouse (condition-based routing: good → storage via put-away, quarantine, damaged),
// quarantine release, and returns to vendor (RTV: approval → shipment → credit note).
import { one, many } from "../db/pool.ts";
import { E, ApiError } from "../lib/errors.ts";
import { docEvent, nextDocNo, post, round4, type Tx } from "./common.ts";
import { suggestBins } from "./putaway.ts";
import { approversOfDoc, lockDoc, submitDoc } from "./approvals.ts";

async function zoneBin(c: Tx, warehouseId: string, zone: string) {
  const r = await one(c, `SELECT l.id FROM location l JOIN location r ON r.id = l.parent_id JOIN location a ON a.id = r.parent_id JOIN location z ON z.id = a.parent_id
                          WHERE l.warehouse_id = $1 AND l.level = 'bin' AND z.zone_type = $2 AND NOT l.is_blocked AND l.deleted_at IS NULL
                          ORDER BY l.current_volume_m3, l.full_code LIMIT 1`, [warehouseId, zone]);
  if (!r) throw new ApiError(409, "no_zone_bin", `لا توجد خانة متاحة في منطقة ${zone}`, `No available bin in the ${zone} zone`);
  return r.id as string;
}
const avgCost = async (c: Tx, itemId: string, whId: string) =>
  Number((await one(c, "SELECT avg_cost FROM item_valuation WHERE item_id = $1 AND warehouse_id = $2", [itemId, whId]))?.avg_cost ?? 0);

// ------------------------------------------------------------------ return to warehouse
export async function createReturn(c: Tx, actor: { id: string; orgUnitId: string | null }, b: { warehouseId: string; reason: string; mrId?: string | null;
  lines: { itemId: string; qty: number; lotNo?: string | null; serialNo?: string | null; condition?: "good" | "quarantine" | "damaged"; notes?: string | null }[] }) {
  if (b.mrId) {
    const mr = await one(c, "SELECT * FROM material_request WHERE id = $1", [b.mrId]);
    if (!mr) throw E.notFound("material request");
    for (const l of b.lines) {
      const issued = await one(c, `SELECT coalesce(sum(qty_issued), 0) AS q FROM mr_line WHERE mr_id = $1 AND item_id = $2 AND deleted_at IS NULL`, [b.mrId, l.itemId]);
      const returned = await one(c, `SELECT coalesce(sum(rl.qty), 0) AS q FROM return_line rl JOIN return_doc r ON r.id = rl.return_id
                                      WHERE r.mr_id = $1 AND rl.item_id = $2 AND r.status NOT IN ('cancelled','rejected')`, [b.mrId, l.itemId]);
      if (l.qty > Number(issued.q) - Number(returned.q) + 1e-9) throw new ApiError(422, "exceeds_issued", "الكمية المرتجعة تتجاوز المصروف على الطلب", "Returned quantity exceeds what was issued on the request");
    }
  }
  const ret = await one(c, `INSERT INTO return_doc (ret_no, return_type, warehouse_id, org_unit_id, returned_by, mr_id, reason) VALUES ($1,'to_warehouse',$2,$3,$4,$5,$6) RETURNING *`,
    [await nextDocNo(c, "RET"), b.warehouseId, actor.orgUnitId, actor.id, b.mrId ?? null, b.reason]);
  let n = 0;
  for (const l of b.lines) {
    await c.query(`INSERT INTO return_line (return_id, line_no, item_id, qty, lot_no, serial_no, condition, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ret.id, ++n, l.itemId, l.qty, l.lotNo ?? null, l.serialNo ?? null, l.condition ?? null, l.notes ?? null]);
  }
  await docEvent(c, "RET", ret.id, "created", { to: "draft", actorId: actor.id });
  return ret;
}

/** Storekeeper inspects the returned goods: good → returns bin + put-away; quarantine/damaged → their zones. */
export async function receiveReturn(c: Tx, actorId: string, id: string, decisions: { lineId: string; condition: "good" | "quarantine" | "damaged" }[]) {
  const ret = await one(c, "SELECT * FROM return_doc WHERE id = $1 AND return_type = 'to_warehouse' FOR UPDATE", [id]);
  if (!ret) throw E.notFound("return");
  if (ret.status !== "draft") throw E.state(ret.status, "receive");
  const lines = await many(c, `SELECT rl.*, i.track_batch, i.track_serial, i.item_code FROM return_line rl JOIN item i ON i.id = rl.item_id WHERE rl.return_id = $1 ORDER BY line_no`, [id]);
  let value = 0;
  for (const l of lines) {
    const cond = decisions.find((d) => d.lineId === l.id)?.condition ?? l.condition;
    if (!cond) throw E.invalid([{ path: l.item_code, message: "condition_required" }]);
    let lotId: string | null = null;
    if (l.track_batch || l.track_serial) {
      const lot = await one(c, `SELECT id FROM stock_lot WHERE item_id = $1 AND (lot_no = $2 OR serial_no = $3) LIMIT 1`, [l.item_id, l.lot_no, l.serial_no]);
      if (!lot) throw new ApiError(422, "unknown_lot", `الدفعة/الرقم التسلسلي غير معروف للصنف ${l.item_code}`, `Unknown batch/serial for ${l.item_code}`);
      lotId = lot.id;
    }
    // value returned at the original issue cost when the request is known, else the current average
    const issueCost = ret.mr_id ? await one(c, `SELECT avg(dl.unit_cost) AS c FROM delivery_line dl JOIN delivery_note d ON d.id = dl.delivery_note_id
                                                WHERE d.mr_id = $1 AND dl.item_id = $2`, [ret.mr_id, l.item_id]) : null;
    const cost = Number(issueCost?.c) || (await avgCost(c, l.item_id, ret.warehouse_id));
    const zone = cond === "good" ? "returns" : cond;
    const status = cond === "good" ? "available" : cond;
    const bin = await zoneBin(c, ret.warehouse_id, zone);
    const ledgerId = await post(c, { docType: "RET", docId: id, docNo: ret.ret_no, docLineId: l.id, movement: "RTW", itemId: l.item_id, locationId: bin,
      lotId, status, qty: Number(l.qty), unitCost: cost });
    await c.query("UPDATE return_line SET condition = $2, lot_id = $3, to_location_id = $4, unit_cost = $5, ledger_id = $6 WHERE id = $1", [l.id, cond, lotId, bin, cost, ledgerId]);
    if (cond === "good") {
      const sug = await suggestBins(c, { itemId: l.item_id, warehouseId: ret.warehouse_id, qty: Number(l.qty), excludeLocationId: bin });
      await c.query(`INSERT INTO putaway_task (task_no, return_id, warehouse_id, item_id, lot_id, qty, from_location_id, suggested_location_id, suggestion)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [await nextDocNo(c, "PUT"), id, ret.warehouse_id, l.item_id, lotId, l.qty, bin, sug[0]?.locationId ?? null, JSON.stringify(sug)]);
    }
    value += Number(l.qty) * cost;
  }
  await c.query("UPDATE return_doc SET status = 'received', estimated_value = $2, posted_at = now(), posted_by = $3 WHERE id = $1", [id, Math.round(value * 100) / 100, actorId]);
  if (ret.custody_id) await c.query("UPDATE custody SET status = 'returned', returned_at = now() WHERE id = $1 AND status = 'return_pending'", [ret.custody_id]);
  await docEvent(c, "RET", id, "received", { from: "draft", to: "received", actorId });
}

/** Releases quarantined stock (or moves it to damaged) — Warehouse Manager decision. */
export async function changeStatus(c: Tx, actorId: string, balanceId: string, qty: number, to: "available" | "damaged", reason: string) {
  const b = await one(c, "SELECT * FROM stock_balance WHERE id = $1", [balanceId]);
  if (!b) throw E.notFound("stock");
  if (!["quarantine", "damaged"].includes(b.stock_status) || b.stock_status === to) throw E.state(b.stock_status, `move to ${to}`);
  if (qty <= 0 || qty > Number(b.qty_on_hand) - Number(b.qty_reserved) + 1e-9) throw E.invalid([{ path: "qty", message: "invalid_qty" }]);
  const cost = await avgCost(c, b.item_id, b.warehouse_id);
  const docNo = `ST-${Date.now().toString(36).toUpperCase()}`;
  const target = to === "damaged" ? await zoneBin(c, b.warehouse_id, "damaged") : b.location_id;
  await post(c, { docType: "STATUS", docNo, itemId: b.item_id, lotId: b.lot_id, movement: "STATUS_OUT", locationId: b.location_id, status: b.stock_status, qty: -qty, notes: reason });
  await post(c, { docType: "STATUS", docNo, itemId: b.item_id, lotId: b.lot_id, movement: "STATUS_IN", locationId: target, status: to, qty, unitCost: cost, notes: reason });
  if (to === "available") {
    const sug = await suggestBins(c, { itemId: b.item_id, warehouseId: b.warehouse_id, qty, excludeLocationId: b.location_id });
    await c.query(`INSERT INTO putaway_task (task_no, warehouse_id, item_id, lot_id, qty, from_location_id, suggested_location_id, suggestion) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [await nextDocNo(c, "PUT"), b.warehouse_id, b.item_id, b.lot_id, qty, b.location_id, sug[0]?.locationId ?? null, JSON.stringify(sug)]);
  }
}

// ------------------------------------------------------------------ return to vendor
export async function createRtv(c: Tx, actorId: string, b: { warehouseId: string; supplierId: string; reason: string; receiptId?: string | null;
  lines: { balanceId: string; qty: number }[] }) {
  const ret = await one(c, `INSERT INTO return_doc (ret_no, return_type, warehouse_id, supplier_id, receipt_id, reason) VALUES ($1,'to_vendor',$2,$3,$4,$5) RETURNING *`,
    [await nextDocNo(c, "RTV"), b.warehouseId, b.supplierId, b.receiptId ?? null, b.reason]);
  let n = 0, value = 0;
  for (const l of b.lines) {
    const bal = await one(c, "SELECT * FROM stock_balance WHERE id = $1", [l.balanceId]);
    if (!bal || bal.warehouse_id !== b.warehouseId) throw E.invalid([{ path: "balanceId", message: "stock_not_in_warehouse" }]);
    if (l.qty > Number(bal.qty_on_hand) - Number(bal.qty_reserved) + 1e-9) throw new ApiError(409, "insufficient_stock", "الكمية أكبر من المتاح", "Quantity exceeds free stock");
    const cost = await avgCost(c, bal.item_id, b.warehouseId);
    await c.query(`INSERT INTO return_line (return_id, line_no, item_id, qty, lot_id, from_location_id, from_status, unit_cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ret.id, ++n, bal.item_id, l.qty, bal.lot_id, bal.location_id, bal.stock_status, cost]);
    value += l.qty * cost;
  }
  if (!n) throw E.invalid([{ path: "lines", message: "at_least_one_line" }]);
  const out = await one(c, "UPDATE return_doc SET estimated_value = $2 WHERE id = $1 RETURNING *", [ret.id, Math.round(value * 100) / 100]);
  await docEvent(c, "RTV", ret.id, "created", { to: "draft", actorId });
  return out;
}

export async function submitRtv(c: Tx, actorId: string, id: string) {
  const ret = await lockDoc(c, "RTV", id);
  if (ret.status !== "draft") throw E.state(ret.status, "submit");
  return submitDoc(c, actorId, "RTV", ret, { value: Number(ret.estimated_value), warehouseId: ret.warehouse_id, categoryIds: [] });
}

export async function shipRtv(c: Tx, actorId: string, id: string) {
  const ret = await lockDoc(c, "RTV", id);
  if (ret.status !== "approved") throw E.state(ret.status, "ship");
  if ((await approversOfDoc(c, "RTV", id)).includes(actorId)) throw E.sod("SoD-2", "من اعتمد الإرجاع لا ينفذه", "An approver cannot execute the return");
  for (const l of await many(c, "SELECT * FROM return_line WHERE return_id = $1 ORDER BY line_no", [id])) {
    const ledgerId = await post(c, { docType: "RTV", docId: id, docNo: ret.ret_no, docLineId: l.id, movement: "RTV", itemId: l.item_id,
      locationId: l.from_location_id, lotId: l.lot_id, status: l.from_status, qty: -Number(l.qty) });
    await c.query("UPDATE return_line SET ledger_id = $2 WHERE id = $1", [l.id, ledgerId]);
  }
  await c.query("UPDATE return_doc SET status = 'shipped', posted_at = now(), posted_by = $2 WHERE id = $1", [id, actorId]);
  await docEvent(c, "RTV", id, "shipped", { from: "approved", to: "shipped", actorId });
}

export async function closeRtv(c: Tx, actorId: string, id: string, creditNoteRef: string) {
  const ret = await lockDoc(c, "RTV", id);
  if (ret.status !== "shipped") throw E.state(ret.status, "close");
  await c.query("UPDATE return_doc SET status = 'closed', credit_note_ref = $2 WHERE id = $1", [id, creditNoteRef]);
  await docEvent(c, "RTV", id, "credit_note", { from: "shipped", to: "closed", actorId, comment: creditNoteRef });
}

export { round4 };
