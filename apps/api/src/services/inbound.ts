// Inbound lifecycle: PO → ASN → Arrived → Quantity check → Technical inspection (committee)
// → Accepted/Rejected → GRN posted → Put-away → 3-way match → Ready for payment.
import { many, one } from "../db/pool.ts";
import { E, ApiError } from "../lib/errors.ts";
import { docEvent, nextDocNo, notify, post, setting, findLocation, round4, type Tx } from "./common.ts";
import { suggestBins, validateBin } from "./putaway.ts";

// ------------------------------------------------------------------ purchase orders
export interface PoInput {
  supplierId: string; warehouseId: string; etimadRef?: string | null; expectedDate?: string | null; source?: "erp" | "manual"; poNo?: string;
  notes?: string | null; lines: { itemId: string; uomId?: string; qty: number; unitPrice: number; vatRate?: number }[];
}

export async function createPo(c: Tx, actorId: string, b: PoInput) {
  if (!b.lines.length) throw E.invalid([{ path: "lines", message: "at_least_one_line" }]);
  const poNo = b.poNo ?? (await nextDocNo(c, "PO"));
  const po = await one(c, `INSERT INTO purchase_order (po_no, etimad_ref, supplier_id, warehouse_id, expected_date, source, notes)
                           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [poNo, b.etimadRef ?? null, b.supplierId, b.warehouseId, b.expectedDate ?? null, b.source ?? "manual", b.notes ?? null]);
  let total = 0, n = 0;
  for (const l of b.lines) {
    const it = await one(c, "SELECT id, base_uom_id, status, item_type FROM item WHERE id = $1 AND deleted_at IS NULL", [l.itemId]);
    if (!it || it.status !== "active") throw E.invalid([{ path: `lines.${n}.itemId`, message: "item_not_active" }]);
    let factor = 1;
    const uomId = l.uomId ?? it.base_uom_id;
    if (uomId !== it.base_uom_id) {
      const cv = await one(c, "SELECT factor_to_base FROM item_uom_conversion WHERE item_id = $1 AND uom_id = $2 AND deleted_at IS NULL", [l.itemId, uomId]);
      if (!cv) throw E.invalid([{ path: `lines.${n}.uomId`, message: "no_conversion_for_uom" }]);
      factor = Number(cv.factor_to_base);
    }
    await c.query(`INSERT INTO po_line (po_id, line_no, item_id, uom_id, factor_to_base, qty_ordered, unit_price, vat_rate) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [po.id, ++n, l.itemId, uomId, factor, l.qty, l.unitPrice, l.vatRate ?? 15]);
    total += l.qty * l.unitPrice;
  }
  await c.query("UPDATE purchase_order SET total_amount = $2 WHERE id = $1", [po.id, Math.round(total * 100) / 100]);
  await docEvent(c, "PO", po.id, "created", { to: "open", actorId });
  return po;
}

// ------------------------------------------------------------------ ASN (supplier portal or storekeeper)
export async function createAsn(c: Tx, actorId: string, b: { poId: string; expectedAt: string; vehicleNo?: string; driverName?: string; driverMobile?: string;
  supplierDeliveryRef?: string; lines: { poLineId: string; qty: number; lotNo?: string; serialNos?: string[]; mfgDate?: string; expiryDate?: string }[] }, supplierScope?: string | null) {
  const po = await one(c, "SELECT * FROM purchase_order WHERE id = $1 FOR UPDATE", [b.poId]);
  if (!po) throw E.notFound("purchase order");
  if (supplierScope && po.supplier_id !== supplierScope) throw E.outOfScope();
  if (!["open", "partially_received"].includes(po.status)) throw E.state(po.status, "submit ASN");
  const asnNo = await nextDocNo(c, "ASN");
  const asn = await one(c, `INSERT INTO asn (asn_no, po_id, supplier_id, expected_at, vehicle_no, driver_name, driver_mobile, supplier_delivery_ref)
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [asnNo, po.id, po.supplier_id, b.expectedAt, b.vehicleNo ?? null, b.driverName ?? null, b.driverMobile ?? null, b.supplierDeliveryRef ?? null]);
  for (const [i, l] of b.lines.entries()) {
    const pl = await one(c, "SELECT * FROM po_line WHERE id = $1 AND po_id = $2", [l.poLineId, po.id]);
    if (!pl) throw E.invalid([{ path: `lines.${i}.poLineId`, message: "not_on_po" }]);
    if (l.qty > Number(pl.qty_ordered) - Number(pl.qty_received) + 1e-9) throw E.invalid([{ path: `lines.${i}.qty`, message: "exceeds_open_qty" }]);
    await c.query(`INSERT INTO asn_line (asn_id, po_line_id, qty, lot_no, serial_nos, mfg_date, expiry_date) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [asn.id, l.poLineId, l.qty, l.lotNo ?? null, l.serialNos ?? null, l.mfgDate ?? null, l.expiryDate ?? null]);
  }
  await docEvent(c, "ASN", asn.id, "submitted", { to: "submitted", actorId });
  return asn;
}

// ------------------------------------------------------------------ receiving
export async function arrive(c: Tx, actorId: string, b: { poId?: string; asnId?: string; dockLocationId?: string; supplierDeliveryRef?: string; notes?: string }) {
  let asn: any = null;
  let poId = b.poId;
  if (b.asnId) {
    asn = await one(c, "SELECT * FROM asn WHERE id = $1 FOR UPDATE", [b.asnId]);
    if (!asn) throw E.notFound("ASN");
    if (asn.status !== "submitted") throw E.state(asn.status, "arrive");
    poId = asn.po_id;
  }
  if (!poId) throw E.invalid([{ path: "poId", message: "po_or_asn_required" }]);
  const po = await one(c, "SELECT * FROM purchase_order WHERE id = $1", [poId]);
  if (!po || !["open", "partially_received"].includes(po.status)) throw E.state(po?.status ?? "unknown", "receive");
  let dock = b.dockLocationId;
  if (!dock) {
    const d = await one(c, `SELECT l.id FROM location l JOIN location r ON r.id = l.parent_id JOIN location a ON a.id = r.parent_id JOIN location z ON z.id = a.parent_id
                            WHERE l.warehouse_id = $1 AND l.level = 'bin' AND z.zone_type = 'receiving' AND NOT l.is_blocked AND l.deleted_at IS NULL
                            ORDER BY l.full_code LIMIT 1`, [po.warehouse_id]);
    if (!d) throw new ApiError(409, "no_dock", "لا توجد خانة استلام متاحة في هذا المستودع", "No receiving dock bin available in this warehouse");
    dock = d.id;
  }
  const receiptNo = await nextDocNo(c, "RCV");
  const r = await one(c, `INSERT INTO receipt (receipt_no, po_id, asn_id, warehouse_id, dock_location_id, supplier_delivery_ref, received_by, notes)
                          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [receiptNo, po.id, asn?.id ?? null, po.warehouse_id, dock, b.supplierDeliveryRef ?? asn?.supplier_delivery_ref ?? null, actorId, b.notes ?? null]);
  const lines = asn
    ? await many(c, `SELECT al.*, pl.item_id FROM asn_line al JOIN po_line pl ON pl.id = al.po_line_id WHERE al.asn_id = $1`, [asn.id])
    : await many(c, `SELECT pl.id AS po_line_id, pl.item_id, pl.qty_ordered - pl.qty_received AS qty FROM po_line pl
                      WHERE pl.po_id = $1 AND pl.qty_ordered > pl.qty_received ORDER BY pl.line_no`, [po.id]);
  for (const l of lines) {
    await c.query(`INSERT INTO receipt_line (receipt_id, po_line_id, item_id, qty_expected, lot_no, serial_nos, mfg_date, expiry_date)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [r.id, l.po_line_id, l.item_id, l.qty, l.lot_no ?? null, l.serial_nos ?? null, l.mfg_date ?? null, l.expiry_date ?? null]);
  }
  if (asn) await c.query("UPDATE asn SET status = 'arrived' WHERE id = $1", [asn.id]);
  await docEvent(c, "RCV", r.id, "arrived", { to: "arrived", actorId, data: { asn: asn?.asn_no, po: po.po_no } });
  return r;
}

export async function quantityCheck(c: Tx, actorId: string, receiptId: string, lines: {
  lineId: string; qtyReceived: number; qtyDamaged?: number; lotNo?: string | null; serialNos?: string[] | null; mfgDate?: string | null; expiryDate?: string | null }[]) {
  const r = await lockReceipt(c, receiptId, ["arrived", "qty_checked"], "quantity check");
  for (const l of lines) {
    const rl = await one(c, `SELECT rl.*, i.track_batch, i.track_serial, i.track_expiry, i.item_code, pl.factor_to_base, pl.qty_ordered, pl.qty_received AS po_received
                              FROM receipt_line rl JOIN item i ON i.id = rl.item_id JOIN po_line pl ON pl.id = rl.po_line_id
                             WHERE rl.id = $1 AND rl.receipt_id = $2`, [l.lineId, receiptId]);
    if (!rl) throw E.notFound("receipt line");
    const damaged = l.qtyDamaged ?? 0;
    if (damaged > l.qtyReceived) throw E.invalid([{ path: "qtyDamaged", message: "exceeds_received" }]);
    if (l.qtyReceived > Number(rl.qty_ordered) - Number(rl.po_received) + 1e-9) {
      throw new ApiError(422, "over_receipt", `الكمية المستلمة للصنف ${rl.item_code} تتجاوز الكمية المتبقية في أمر الشراء`,
        `Received quantity for ${rl.item_code} exceeds the open PO quantity`);
    }
    const lotNo = l.lotNo ?? rl.lot_no;
    const serials = l.serialNos ?? rl.serial_nos;
    const expiry = l.expiryDate ?? rl.expiry_date;
    if (l.qtyReceived > 0) {
      if (rl.track_batch && !lotNo) throw E.invalid([{ path: `lines.${rl.item_code}.lotNo`, message: "batch_required" }]);
      if (rl.track_expiry && !expiry) throw E.invalid([{ path: `lines.${rl.item_code}.expiryDate`, message: "expiry_required" }]);
      if (expiry && new Date(expiry) <= new Date()) throw E.invalid([{ path: `lines.${rl.item_code}.expiryDate`, message: "already_expired" }]);
      if (rl.track_serial) {
        const base = l.qtyReceived * Number(rl.factor_to_base);
        if (!serials || serials.length !== base || new Set(serials).size !== base) {
          throw E.invalid([{ path: `lines.${rl.item_code}.serialNos`, message: `need_${base}_unique_serials` }]);
        }
      }
    }
    await c.query(`UPDATE receipt_line SET qty_received = $2, qty_damaged = $3, lot_no = $4, serial_nos = $5, mfg_date = $6, expiry_date = $7,
                     qty_accepted = NULL, qty_rejected = NULL WHERE id = $1`,
      [l.lineId, l.qtyReceived, damaged, lotNo, serials, l.mfgDate ?? rl.mfg_date, expiry]);
  }
  await c.query("UPDATE receipt SET status = 'qty_checked', qty_checked_at = now() WHERE id = $1", [receiptId]);
  await docEvent(c, "RCV", receiptId, "quantity_checked", { from: r.status, to: "qty_checked", actorId });
}

export async function startInspection(c: Tx, actorId: string, receiptId: string, memberIds: string[], chairId: string) {
  const r = await lockReceipt(c, receiptId, ["qty_checked"], "start inspection");
  const min = await setting<number>(c, "inspection.min_members", 2);
  const ids = [...new Set(memberIds)];
  if (ids.length < min) throw E.invalid([{ path: "memberIds", message: `at_least_${min}_members` }]);
  if (!ids.includes(chairId)) throw E.invalid([{ path: "chairId", message: "chair_must_be_member" }]);
  // SoD-4: the storekeeper who received the goods cannot sit on the inspection committee
  if (ids.includes(r.received_by)) throw E.sod("SoD-4", "مستلم المواد لا يجوز أن يكون عضواً في لجنة الفحص", "The receiver cannot be an inspection committee member");
  const valid = await many(c, `SELECT u.id FROM app_user u JOIN user_role ur ON ur.user_id = u.id AND ur.is_active JOIN role ro ON ro.id = ur.role_id
                               WHERE u.id = ANY($1) AND ro.code = 'IRC' AND u.status = 'active'`, [ids]);
  if (valid.length !== ids.length) throw E.invalid([{ path: "memberIds", message: "members_must_hold_IRC_role" }]);
  for (const id of ids) await c.query("INSERT INTO inspection_member (receipt_id, user_id, is_chair) VALUES ($1,$2,$3)", [receiptId, id, id === chairId]);
  await c.query("UPDATE receipt SET status = 'in_inspection', inspection_started_at = now() WHERE id = $1", [receiptId]);
  await docEvent(c, "RCV", receiptId, "inspection_started", { from: r.status, to: "in_inspection", actorId, data: { members: ids } });
  await notify(c, ids, { kind: "inspection", titleAr: `فحص فني مطلوب — ${r.receipt_no}`, titleEn: `Inspection required — ${r.receipt_no}`,
    link: `/inbound/receipts/${receiptId}`, docType: "RCV", docId: receiptId });
}

async function assertMember(c: Tx, receiptId: string, userId: string) {
  const m = await one(c, "SELECT * FROM inspection_member WHERE receipt_id = $1 AND user_id = $2", [receiptId, userId]);
  if (!m) throw E.forbidden("inspection committee member");
  return m;
}

export async function recordInspection(c: Tx, actorId: string, receiptId: string,
  lines: { lineId: string; qtyAccepted: number; rejectReason?: string | null; notes?: string | null }[]) {
  await lockReceipt(c, receiptId, ["in_inspection"], "record inspection");
  await assertMember(c, receiptId, actorId);
  for (const l of lines) {
    const rl = await one(c, "SELECT * FROM receipt_line WHERE id = $1 AND receipt_id = $2", [l.lineId, receiptId]);
    if (!rl) throw E.notFound("receipt line");
    if (l.qtyAccepted > Number(rl.qty_received) + 1e-9) throw E.invalid([{ path: "qtyAccepted", message: "exceeds_received" }]);
    const rejected = round4(Number(rl.qty_received) - l.qtyAccepted);
    if (rejected > 0 && !(l.rejectReason && l.rejectReason.trim().length >= 3)) throw E.invalid([{ path: "rejectReason", message: "required_when_rejecting" }]);
    await c.query("UPDATE receipt_line SET qty_accepted = $2, qty_rejected = $3, reject_reason = $4, inspection_notes = $5 WHERE id = $1",
      [l.lineId, l.qtyAccepted, rejected, rejected > 0 ? l.rejectReason : null, l.notes ?? null]);
  }
  // results changed → previous signatures are void
  await c.query("UPDATE inspection_member SET decision = NULL, signed_at = NULL WHERE receipt_id = $1", [receiptId]);
  await docEvent(c, "RCV", receiptId, "inspection_recorded", { actorId });
}

export async function signInspection(c: Tx, actorId: string, receiptId: string, decision: "agree" | "object", comment?: string) {
  const r = await lockReceipt(c, receiptId, ["in_inspection"], "sign inspection");
  await assertMember(c, receiptId, actorId);
  const open = await one(c, "SELECT count(*)::int AS n FROM receipt_line WHERE receipt_id = $1 AND qty_received > 0 AND qty_accepted IS NULL", [receiptId]);
  if (open.n > 0) throw new ApiError(409, "results_missing", "يجب تسجيل نتيجة الفحص لكل البنود قبل التوقيع", "Record inspection results for every line before signing");
  const report = await one(c, "SELECT id FROM attachment WHERE owner_type = 'receipt' AND owner_id = $1 AND category = 'inspection_report' AND deleted_at IS NULL LIMIT 1", [receiptId]);
  if (!report) throw new ApiError(409, "report_required", "يجب إرفاق محضر الفحص الفني قبل التوقيع", "The inspection report must be attached before signing");
  await c.query("UPDATE inspection_member SET decision = $3, comment = $4, signed_at = now() WHERE receipt_id = $1 AND user_id = $2", [receiptId, actorId, decision, comment ?? null]);
  await docEvent(c, "RCV", receiptId, `inspection_${decision}`, { actorId, comment });
  const min = await setting<number>(c, "inspection.min_members", 2);
  const s = await one(c, `SELECT count(*) FILTER (WHERE decision = 'agree')::int AS agree, count(*) FILTER (WHERE decision = 'object')::int AS object,
                                 bool_or(is_chair AND decision = 'agree') AS chair_agreed, count(*)::int AS members
                            FROM inspection_member WHERE receipt_id = $1`, [receiptId]);
  if (s.object === 0 && s.chair_agreed && s.agree >= Math.min(min, s.members)) {
    await c.query("UPDATE receipt SET status = 'inspected', inspected_at = now() WHERE id = $1", [receiptId]);
    await docEvent(c, "RCV", receiptId, "inspection_completed", { from: "in_inspection", to: "inspected", actorId });
    await notify(c, [r.received_by], { kind: "inspection_done", titleAr: `اكتمل الفحص — ${r.receipt_no}`, titleEn: `Inspection completed — ${r.receipt_no}`,
      link: `/inbound/receipts/${receiptId}`, docType: "RCV", docId: receiptId });
  }
}

/** Posts the GRN: creates lots/serials, books accepted quantities into the dock bin, creates put-away tasks. */
export async function postGrn(c: Tx, actorId: string, receiptId: string) {
  const r = await lockReceipt(c, receiptId, ["inspected"], "post GRN");
  const member = await one(c, "SELECT 1 FROM inspection_member WHERE receipt_id = $1 AND user_id = $2", [receiptId, actorId]);
  if (member) throw E.sod("SoD-4", "عضو لجنة الفحص لا يرحّل سند الاستلام", "An inspection committee member cannot post the GRN");
  const po = await one(c, "SELECT * FROM purchase_order WHERE id = $1 FOR UPDATE", [r.po_id]);
  const grnNo = await nextDocNo(c, "GRN");
  const lines = await many(c, `SELECT rl.*, pl.factor_to_base, pl.unit_price, pl.id AS pl_id, i.track_serial, i.track_batch, i.item_code
                                 FROM receipt_line rl JOIN po_line pl ON pl.id = rl.po_line_id JOIN item i ON i.id = rl.item_id
                                WHERE rl.receipt_id = $1 ORDER BY rl.created_at`, [receiptId]);
  let total = 0;
  const tasks: any[] = [];
  for (const l of lines) {
    const accepted = Number(l.qty_accepted ?? 0);
    if (accepted <= 0) continue;
    const factor = Number(l.factor_to_base);
    const baseQty = round4(accepted * factor);
    const unitCost = Number(l.unit_price) / factor;
    const lotsToPost: { lotId: string | null; qty: number }[] = [];
    if (l.track_serial) {
      const serials: string[] = (l.serial_nos ?? []).slice(0, baseQty);
      if (serials.length !== baseQty) throw E.invalid([{ path: l.item_code, message: "serials_do_not_match_accepted_qty" }]);
      for (const s of serials) {
        const lot = await one(c, `INSERT INTO stock_lot (item_id, serial_no, mfg_date, expiry_date, supplier_id, source_doc) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [l.item_id, s, l.mfg_date, l.expiry_date, po.supplier_id, grnNo]);
        lotsToPost.push({ lotId: lot.id, qty: 1 });
      }
    } else if (l.track_batch) {
      const lot = await one(c, `INSERT INTO stock_lot (item_id, lot_no, mfg_date, expiry_date, supplier_id, source_doc) VALUES ($1,$2,$3,$4,$5,$6)
                                ON CONFLICT (item_id, lot_no) WHERE serial_no IS NULL DO UPDATE SET expiry_date = coalesce(stock_lot.expiry_date, EXCLUDED.expiry_date)
                                RETURNING id`, [l.item_id, l.lot_no, l.mfg_date, l.expiry_date, po.supplier_id, grnNo]);
      lotsToPost.push({ lotId: lot.id, qty: baseQty });
      await c.query("UPDATE receipt_line SET lot_id = $2 WHERE id = $1", [l.id, lot.id]);
    } else {
      lotsToPost.push({ lotId: null, qty: baseQty });
    }
    for (const lp of lotsToPost) {
      await post(c, { docType: "GRN", docId: receiptId, docNo: grnNo, docLineId: l.id, movement: "GR", itemId: l.item_id,
        locationId: r.dock_location_id, lotId: lp.lotId, qty: lp.qty, unitCost });
      total += lp.qty * unitCost;
    }
    // one put-away task per lot (serials of the same receipt line are grouped into one task per serial)
    for (const lp of lotsToPost) {
      const sug = await suggestBins(c, { itemId: l.item_id, warehouseId: r.warehouse_id, qty: lp.qty, excludeLocationId: r.dock_location_id });
      const taskNo = await nextDocNo(c, "PUT");
      tasks.push(await one(c, `INSERT INTO putaway_task (task_no, receipt_id, receipt_line_id, warehouse_id, item_id, lot_id, qty, from_location_id, suggested_location_id, suggestion)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [taskNo, receiptId, l.id, r.warehouse_id, l.item_id, lp.lotId, lp.qty, r.dock_location_id, sug[0]?.locationId ?? null, JSON.stringify(sug)]));
    }
    await c.query("UPDATE po_line SET qty_received = qty_received + $2 WHERE id = $1", [l.pl_id, accepted]);
  }
  const open = await one(c, "SELECT count(*)::int AS n FROM po_line WHERE po_id = $1 AND qty_received < qty_ordered", [po.id]);
  await c.query("UPDATE purchase_order SET status = $2 WHERE id = $1", [po.id, open.n ? "partially_received" : "received"]);
  if (r.asn_id) await c.query("UPDATE asn SET status = 'received' WHERE id = $1", [r.asn_id]);
  const next = tasks.length ? "grn_posted" : "putaway_done";
  await c.query(`UPDATE receipt SET status = $2, grn_no = $3, grn_posted_at = now(), grn_posted_by = $4, grn_value = $5,
                   putaway_completed_at = CASE WHEN $2 = 'putaway_done' THEN now() ELSE NULL END WHERE id = $1`,
    [receiptId, next, grnNo, actorId, Math.round(total * 100) / 100]);
  await docEvent(c, "RCV", receiptId, "grn_posted", { from: "inspected", to: next, actorId, data: { grnNo, value: total, putawayTasks: tasks.length } });
  return { grnNo, value: Math.round(total * 100) / 100, putawayTasks: tasks.length };
}

/** Directed put-away: operator scans the destination bin; deviations from the suggestion need a reason. */
export async function completePutaway(c: Tx, actorId: string, taskId: string, scannedLocation: string, overrideReason?: string) {
  const t = await one(c, "SELECT * FROM putaway_task WHERE id = $1 FOR UPDATE", [taskId]);
  if (!t) throw E.notFound("put-away task");
  if (t.status !== "open") throw E.state(t.status, "complete put-away");
  const loc = await findLocation(c, scannedLocation, t.warehouse_id);
  if (!loc) throw new ApiError(422, "unknown_location", "الموقع الممسوح غير موجود في هذا المستودع", "Scanned location not found in this warehouse");
  if (loc.id !== t.suggested_location_id && !(overrideReason && overrideReason.trim().length >= 3)) {
    throw new ApiError(409, "override_reason_required", "الموقع يختلف عن الموقع المقترح — اذكر السبب", "Location differs from the suggestion — a reason is required",
      { suggested: t.suggested_location_id });
  }
  const ok = await validateBin(c, { itemId: t.item_id, warehouseId: t.warehouse_id, locationId: loc.id, qty: Number(t.qty) });
  if (!ok) throw new ApiError(409, "bin_not_suitable", "الخانة غير مناسبة (السعة أو التوافق أو موقوفة)", "Bin is not suitable (capacity, compatibility or blocked)");
  const doc = { docType: "PUTAWAY", docId: t.id, docNo: t.task_no, itemId: t.item_id, lotId: t.lot_id };
  await post(c, { ...doc, movement: "PUTAWAY_OUT", locationId: t.from_location_id, qty: -Number(t.qty) });
  const avg = await one(c, "SELECT avg_cost FROM item_valuation WHERE item_id = $1 AND warehouse_id = $2", [t.item_id, t.warehouse_id]);
  await post(c, { ...doc, movement: "PUTAWAY_IN", locationId: loc.id, qty: Number(t.qty), unitCost: Number(avg.avg_cost) });
  await c.query(`UPDATE putaway_task SET status = 'done', to_location_id = $2, override_reason = $3, completed_by = $4, completed_at = now() WHERE id = $1`,
    [taskId, loc.id, loc.id === t.suggested_location_id ? null : overrideReason, actorId]);
  if (t.receipt_id) {
    const left = await one(c, "SELECT count(*)::int AS n FROM putaway_task WHERE receipt_id = $1 AND status = 'open'", [t.receipt_id]);
    if (left.n === 0) {
      await c.query("UPDATE receipt SET status = 'putaway_done', putaway_completed_at = now() WHERE id = $1 AND status = 'grn_posted'", [t.receipt_id]);
      await docEvent(c, "RCV", t.receipt_id, "putaway_completed", { from: "grn_posted", to: "putaway_done", actorId });
    }
  }
  return { locationId: loc.id, fullCode: loc.full_code };
}

// ------------------------------------------------------------------ invoices & 3-way match
export async function createInvoice(c: Tx, actorId: string, b: { poId: string; invoiceNo: string; invoiceDate: string;
  lines: { poLineId: string; qty: number; unitPrice: number }[] }) {
  const po = await one(c, "SELECT * FROM purchase_order WHERE id = $1 FOR UPDATE", [b.poId]);
  if (!po) throw E.notFound("purchase order");
  let amount = 0, vat = 0;
  const inv = await one(c, `INSERT INTO supplier_invoice (invoice_no, supplier_id, po_id, invoice_date, amount_excl_vat, vat_amount)
                            VALUES ($1,$2,$3,$4,0,0) RETURNING *`, [b.invoiceNo, po.supplier_id, po.id, b.invoiceDate]);
  for (const l of b.lines) {
    const pl = await one(c, "SELECT * FROM po_line WHERE id = $1 AND po_id = $2 FOR UPDATE", [l.poLineId, po.id]);
    if (!pl) throw E.invalid([{ path: "poLineId", message: "not_on_po" }]);
    await c.query("INSERT INTO invoice_line (invoice_id, po_line_id, qty, unit_price) VALUES ($1,$2,$3,$4)", [inv.id, l.poLineId, l.qty, l.unitPrice]);
    await c.query("UPDATE po_line SET qty_invoiced = qty_invoiced + $2 WHERE id = $1", [l.poLineId, l.qty]);
    amount += l.qty * l.unitPrice;
    vat += l.qty * l.unitPrice * Number(pl.vat_rate) / 100;
  }
  await c.query("UPDATE supplier_invoice SET amount_excl_vat = $2, vat_amount = $3 WHERE id = $1", [inv.id, round2(amount), round2(vat)]);
  const result = await threeWayMatch(c, actorId, inv.id);
  return { ...inv, ...result };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function threeWayMatch(c: Tx, actorId: string, invoiceId: string) {
  const tol = await setting<{ qty: number; price: number }>(c, "match.tolerance_pct", { qty: 2, price: 1 });
  const lines = await many(c, `SELECT il.*, pl.line_no, pl.qty_ordered, pl.qty_received, pl.qty_invoiced, pl.unit_price AS po_price, i.item_code
                                 FROM invoice_line il JOIN po_line pl ON pl.id = il.po_line_id JOIN item i ON i.id = pl.item_id
                                WHERE il.invoice_id = $1 ORDER BY pl.line_no`, [invoiceId]);
  const details = lines.map((l) => {
    const qtyOk = Number(l.qty_invoiced) <= Number(l.qty_received) * (1 + tol.qty / 100) + 1e-9;
    const priceDev = Number(l.po_price) > 0 ? Math.abs(Number(l.unit_price) - Number(l.po_price)) / Number(l.po_price) * 100 : 0;
    const priceOk = priceDev <= tol.price + 1e-9;
    return { line: l.line_no, item: l.item_code, ordered: Number(l.qty_ordered), received: Number(l.qty_received), invoiced: Number(l.qty_invoiced),
      poPrice: Number(l.po_price), invoicePrice: Number(l.unit_price), priceDeviationPct: Math.round(priceDev * 100) / 100,
      result: qtyOk && priceOk ? "matched" : !qtyOk ? "qty_variance" : "price_variance" };
  });
  const matched = details.every((d) => d.result === "matched");
  const status = matched ? "ready_for_payment" : "exception";
  await c.query("UPDATE supplier_invoice SET status = $2, match_result = $3, matched_at = now() WHERE id = $1", [invoiceId, status, JSON.stringify(details)]);
  await docEvent(c, "INV", invoiceId, matched ? "matched" : "match_exception", { to: status, actorId, data: details });
  return { status, match: details };
}

async function lockReceipt(c: Tx, id: string, allowed: string[], action: string) {
  const r = await one(c, "SELECT * FROM receipt WHERE id = $1 FOR UPDATE", [id]);
  if (!r) throw E.notFound("receipt");
  if (!allowed.includes(r.status)) throw E.state(r.status, action);
  return r;
}
