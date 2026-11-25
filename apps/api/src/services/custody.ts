// Assets & custody (عُهد): assets delivered on a custody request are registered against the requester, acknowledged,
// transferred between employees, returned to the warehouse (through the normal return inspection) or declared lost.
// Employee clearance (إخلاء طرف) is granted only when the employee holds no custody and has nothing open in the WMS.
import { one, many } from "../db/pool.ts";
import { E, ApiError } from "../lib/errors.ts";
import { docEvent, nextDocNo, notify, type Tx } from "./common.ts";

export async function issueCustody(c: Tx, b: { mr: any; deliveryLineId: string; itemId: string; lotId: string | null; qty: number; unitCost: number }) {
  // serial-tracked assets are registered unit by unit; anything else as one line
  const lot = b.lotId ? await one(c, "SELECT serial_no FROM stock_lot WHERE id = $1", [b.lotId]) : null;
  const units = lot?.serial_no ? Array(Math.round(b.qty)).fill(1) : [b.qty];
  const ids: string[] = [];
  for (const q of units) {
    const r = await one(c, `INSERT INTO custody (custody_no, item_id, lot_id, qty, holder_id, org_unit_id, warehouse_id, mr_id, delivery_line_id, unit_cost, value)
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [await nextDocNo(c, "CUS"), b.itemId, b.lotId, q, b.mr.requester_id, b.mr.org_unit_id, b.mr.warehouse_id, b.mr.id, b.deliveryLineId, b.unitCost,
       Math.round(q * b.unitCost * 100) / 100]);
    await docEvent(c, "CUS", r.id, "issued", { to: "active", data: { mr: b.mr.mr_no } });
    ids.push(r.id);
  }
  await notify(c, [b.mr.requester_id], { kind: "custody_issued", titleAr: "سُجّلت عهدة جديدة باسمك — يرجى الإقرار بالاستلام", titleEn: "New custody registered to you — please acknowledge",
    link: "/custody?view=mine", docType: "CUS", docId: ids[0] });
  return ids;
}

const lockCustody = async (c: Tx, id: string) => {
  const r = await one(c, "SELECT * FROM custody WHERE id = $1 FOR UPDATE", [id]);
  if (!r) throw E.notFound("custody");
  return r;
};

export async function acknowledge(c: Tx, actorId: string, id: string) {
  const r = await lockCustody(c, id);
  if (r.holder_id !== actorId) throw E.forbidden("custody holder only");
  if (r.acknowledged_at) return;
  await c.query("UPDATE custody SET acknowledged_at = now() WHERE id = $1", [id]);
  await docEvent(c, "CUS", id, "acknowledged", { actorId });
}

/** Moves custody to another employee (storekeeper records it; the new holder must acknowledge). */
export async function transferCustody(c: Tx, actorId: string, id: string, toUserId: string, reason: string) {
  const r = await lockCustody(c, id);
  if (r.status !== "active") throw E.state(r.status, "transfer");
  if (toUserId === r.holder_id) throw E.invalid([{ path: "toUserId", message: "same_holder" }]);
  const to = await one(c, "SELECT id, org_unit_id FROM app_user WHERE id = $1 AND status = 'active' AND deleted_at IS NULL AND supplier_id IS NULL", [toUserId]);
  if (!to) throw E.invalid([{ path: "toUserId", message: "unknown_user" }]);
  await c.query("UPDATE custody SET holder_id = $2, org_unit_id = $3, acknowledged_at = NULL WHERE id = $1", [id, toUserId, to.org_unit_id]);
  await docEvent(c, "CUS", id, "transferred", { actorId, comment: reason, data: { from: r.holder_id, to: toUserId } });
  await notify(c, [toUserId], { kind: "custody_issued", titleAr: "نُقلت إليك عهدة — يرجى الإقرار بالاستلام", titleEn: "Custody transferred to you — please acknowledge",
    link: "/custody?view=mine", docType: "CUS", docId: id });
}

/** Opens a return to warehouse for the asset; custody closes when the storekeeper books the return. */
export async function returnCustody(c: Tx, actorId: string, id: string, b: { condition?: "good" | "quarantine" | "damaged"; reason: string }) {
  const r = await lockCustody(c, id);
  if (r.status !== "active") throw E.state(r.status, "return");
  const holder = await one(c, "SELECT org_unit_id FROM app_user WHERE id = $1", [r.holder_id]);
  const lot = r.lot_id ? await one(c, "SELECT lot_no, serial_no FROM stock_lot WHERE id = $1", [r.lot_id]) : null;
  const ret = await one(c, `INSERT INTO return_doc (ret_no, return_type, warehouse_id, org_unit_id, returned_by, mr_id, reason, custody_id)
                            VALUES ($1,'to_warehouse',$2,$3,$4,$5,$6,$7) RETURNING *`,
    [await nextDocNo(c, "RET"), r.warehouse_id, holder?.org_unit_id ?? null, r.holder_id, r.mr_id, `إرجاع عهدة ${r.custody_no}: ${b.reason}`, id]);
  await c.query(`INSERT INTO return_line (return_id, line_no, item_id, qty, lot_no, serial_no, condition) VALUES ($1,1,$2,$3,$4,$5,$6)`,
    [ret.id, r.item_id, r.qty, lot?.lot_no ?? null, lot?.serial_no ?? null, b.condition ?? null]);
  await docEvent(c, "RET", ret.id, "created", { to: "draft", actorId, data: { custody: r.custody_no } });
  await c.query("UPDATE custody SET status = 'return_pending', return_id = $2 WHERE id = $1", [id, ret.id]);
  await docEvent(c, "CUS", id, "return_requested", { from: "active", to: "return_pending", actorId, comment: b.reason });
  return ret;
}

/** Declared lost — manager decision (custody.approve); the holder cannot confirm their own loss. */
export async function declareLost(c: Tx, actorId: string, id: string, reason: string) {
  const r = await lockCustody(c, id);
  if (r.status !== "active") throw E.state(r.status, "lost");
  if (r.holder_id === actorId) throw E.sod("SoD-CUS", "لا يقرّ حامل العهدة بفقدها بنفسه", "The holder cannot confirm the loss of their own custody");
  await c.query("UPDATE custody SET status = 'lost', lost_reason = $2, lost_confirmed_by = $3 WHERE id = $1", [id, reason, actorId]);
  await docEvent(c, "CUS", id, "lost", { from: "active", to: "lost", actorId, comment: reason });
}

// ------------------------------------------------------------------ employee clearance
async function blockersOf(c: Tx, employeeId: string) {
  const out: { code: string; ref: string; ar: string; en: string }[] = [];
  for (const r of await many(c, `SELECT cu.custody_no, cu.status, i.item_code, i.name_ar, i.name_en FROM custody cu JOIN item i ON i.id = cu.item_id
                                 WHERE cu.holder_id = $1 AND cu.status IN ('active','return_pending')`, [employeeId])) {
    out.push({ code: r.status === "active" ? "custody_active" : "custody_return_pending", ref: r.custody_no,
      ar: `${r.status === "active" ? "عهدة قائمة" : "عهدة قيد الإرجاع"}: ${r.item_code} ${r.name_ar}`, en: `${r.status === "active" ? "Active custody" : "Custody return pending"}: ${r.item_code} ${r.name_en}` });
  }
  for (const r of await many(c, `SELECT mr_no, status FROM material_request WHERE requester_id = $1
                                 AND status IN ('pending_approval','approved','reserved','picking','ready_for_delivery','partially_delivered')`, [employeeId])) {
    out.push({ code: "open_request", ref: r.mr_no, ar: `طلب مواد مفتوح (${r.status})`, en: `Open material request (${r.status})` });
  }
  for (const r of await many(c, `SELECT doc_type, count(*)::int AS n FROM approval_task WHERE assignee_id = $1 AND status = 'pending' GROUP BY 1`, [employeeId])) {
    out.push({ code: "pending_approvals", ref: r.doc_type, ar: `${r.n} مهمة اعتماد معلّقة يجب إعادة إسنادها`, en: `${r.n} pending approval task(s) must be reassigned` });
  }
  for (const r of await many(c, `SELECT pick_no FROM pick_list WHERE assigned_to = $1 AND status IN ('open','in_progress')`, [employeeId])) {
    out.push({ code: "open_pick_list", ref: r.pick_no, ar: "قائمة تجهيز مفتوحة مسندة إليه", en: "Open pick list assigned" });
  }
  return out;
}

export async function requestClearance(c: Tx, actorId: string | null, b: { employeeId: string; reason: string; notes?: string; source?: "manual" | "hr" }) {
  if (actorId && actorId === b.employeeId) throw E.sod("SoD-CL", "لا يطلب الموظف إخلاء طرفه بنفسه", "Employees cannot process their own clearance");
  const emp = await one(c, "SELECT id FROM app_user WHERE id = $1 AND supplier_id IS NULL", [b.employeeId]);
  if (!emp) throw E.invalid([{ path: "employeeId", message: "unknown_user" }]);
  const open = await one(c, "SELECT cl_no FROM clearance WHERE employee_id = $1 AND status = 'blocked'", [b.employeeId]);
  if (open) throw new ApiError(409, "clearance_open", `يوجد طلب إخلاء طرف قائم ${open.cl_no}`, `An open clearance exists: ${open.cl_no}`);
  const requester = actorId ?? (await one(c, "SELECT id FROM app_user WHERE username = 'system'")).id;
  const cl = await one(c, `INSERT INTO clearance (cl_no, employee_id, reason, notes, requested_by, source) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [await nextDocNo(c, "CL"), b.employeeId, b.reason, b.notes ?? null, requester, b.source ?? "manual"]);
  await docEvent(c, "CL", cl.id, "created", { actorId: requester });
  return recheckClearance(c, requester, cl.id);
}

export async function recheckClearance(c: Tx, actorId: string, id: string) {
  const cl = await one(c, "SELECT * FROM clearance WHERE id = $1 FOR UPDATE", [id]);
  if (!cl) throw E.notFound("clearance");
  if (cl.status !== "blocked") throw E.state(cl.status, "recheck");
  const blockers = await blockersOf(c, cl.employee_id);
  if (blockers.length) {
    await c.query("UPDATE clearance SET blockers = $2, checked_at = now() WHERE id = $1", [id, JSON.stringify(blockers)]);
    await docEvent(c, "CL", id, "checked", { actorId, data: { blockers: blockers.length } });
  } else {
    await c.query(`UPDATE clearance SET status = 'cleared', blockers = '[]', checked_at = now(), cleared_at = now(), cleared_by = $2, certificate_no = $3 WHERE id = $1`,
      [id, actorId, await nextDocNo(c, "CRT")]);
    await docEvent(c, "CL", id, "cleared", { from: "blocked", to: "cleared", actorId });
  }
  return one(c, "SELECT * FROM clearance WHERE id = $1", [id]);
}

