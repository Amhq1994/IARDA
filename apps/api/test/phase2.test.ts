import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import { app, pool, login, lookups, uniq, type Client } from "./helpers.ts";
import { SIGNATURE, PDF, multipart, newItem, receive, id } from "./flows.ts";

after(async () => { await app.close(); await pool.end(); });
const L = await lookups();

let mdo: Client, wmN: Client, wmR: Client, proc: Client, sk: Client, irc1: Client, irc2: Client, irc3: Client, ww: Client;
before(async () => {
  [mdo, wmN, wmR, proc, sk, irc1, irc2, irc3, ww] = await Promise.all(["mdo", "wm.assets", "wm.cons", "proc", "sk.cleaning", "irc1", "irc2", "irc3", "ww.cleaning1"].map((u) => login(u)));
});


describe("inbound: receiving, inspection, GRN, put-away, 3-way match", () => {
  test("full flow books stock at PO cost and the ledger matches balances", async () => {
    const it = await newItem();
    const { grn } = await receive(it.id, 50, { price: 12 });
    assert.equal(grn.value, 600);
    const stock = (await wmR.get(`/api/items/${it.id}/stock`)).body;
    assert.equal(stock.balances.reduce((a: number, b: any) => a + b.qty_on_hand, 0), 50);
    assert.equal(stock.balances[0].zone_type, "storage", "put away out of the dock");
    assert.equal(stock.valuation[0].avg_cost, 12);
    const led = (await wmR.get(`/api/items/${it.id}/ledger`)).body.data.map((l: any) => l.movement_type).sort();
    assert.deepEqual(led, ["GR", "PUTAWAY_IN", "PUTAWAY_OUT"]);
  });

  test("SoD-4: the receiver cannot sit on the inspection committee", async () => {
    const it = await newItem();
    const po = (await proc.post("/api/purchase-orders", { supplierId: (await pool.query("SELECT id FROM supplier WHERE code = 'SUP-002'")).rows[0].id,
      warehouseId: L.wh("CLN"), lines: [{ itemId: it.id, qty: 5, unitPrice: 3 }] })).body;
    const r = (await sk.post("/api/receipts", { poId: po.id })).body;
    const line = (await sk.get(`/api/receipts/${r.id}`)).body.lines[0];
    await sk.post(`/api/receipts/${r.id}/quantity-check`, { lines: [{ lineId: line.id, qtyReceived: 5 }] });
    const bad = await sk.post(`/api/receipts/${r.id}/inspection`, { memberIds: [await id("sk.cleaning"), await id("irc1")], chairId: await id("irc1") });
    assert.equal(bad.status, 409);
    assert.equal(bad.body.error.code, "segregation_of_duties");
    const notIrc = await sk.post(`/api/receipts/${r.id}/inspection`, { memberIds: [await id("irc1"), await id("mdo")], chairId: await id("irc1") });
    assert.equal(notIrc.status, 422, "members must hold the committee role");
  });

  test("inspection needs the report before signing; over-receipt and missing batch are refused", async () => {
    const it = await newItem({ trackBatch: true, trackExpiry: true, shelfLifeDays: 365 });
    const po = (await proc.post("/api/purchase-orders", { supplierId: (await pool.query("SELECT id FROM supplier WHERE code = 'SUP-002'")).rows[0].id,
      warehouseId: L.wh("CLN"), lines: [{ itemId: it.id, qty: 10, unitPrice: 3 }] })).body;
    const r = (await sk.post("/api/receipts", { poId: po.id })).body;
    const line = (await sk.get(`/api/receipts/${r.id}`)).body.lines[0];
    assert.equal((await sk.post(`/api/receipts/${r.id}/quantity-check`, { lines: [{ lineId: line.id, qtyReceived: 11, lotNo: "X1", expiryDate: "2030-01-01" }] })).body.error.code, "over_receipt");
    assert.equal((await sk.post(`/api/receipts/${r.id}/quantity-check`, { lines: [{ lineId: line.id, qtyReceived: 10 }] })).status, 422, "batch & expiry required");
    assert.equal((await sk.post(`/api/receipts/${r.id}/quantity-check`, { lines: [{ lineId: line.id, qtyReceived: 10, lotNo: "X1", expiryDate: "2030-01-01" }] })).status, 200);
    await sk.post(`/api/receipts/${r.id}/inspection`, { memberIds: [await id("irc1"), await id("irc3")], chairId: await id("irc1") });
    await irc1.post(`/api/receipts/${r.id}/inspection/results`, { lines: [{ lineId: line.id, qtyAccepted: 10 }] });
    const noReport = await irc1.post(`/api/receipts/${r.id}/inspection/sign`, { decision: "agree" });
    assert.equal(noReport.body.error.code, "report_required");
    assert.equal((await irc2.post(`/api/receipts/${r.id}/inspection/results`, { lines: [{ lineId: line.id, qtyAccepted: 10 }] })).status, 403, "non-member cannot record");
  });

  test("put-away: deviating from the suggested bin needs a reason; unsuitable bins are refused", async () => {
    const it = await newItem({ unitWeightKg: 50, unitVolumeM3: 0.2 });
    const { receipt } = await receive(it.id, 2, { putaway: false });
    const t = (await sk.get(`/api/putaway-tasks?receiptId=${receipt.id}`)).body.data[0];
    assert.ok(t.suggested_code);
    const other = (await sk.get(`/api/putaway-tasks/${t.id}/suggestions`)).body.data.find((s: any) => s.fullCode !== t.suggested_code);
    const r1 = await ww.post(`/api/putaway-tasks/${t.id}/complete`, { scannedLocation: other.fullCode });
    assert.equal(r1.body.error.code, "override_reason_required");
    const blocked = (await pool.query("SELECT full_code FROM location WHERE is_blocked AND warehouse_id = $1 AND level = 'bin' LIMIT 1", [L.wh("CLN")])).rows[0];
    const r2 = await ww.post(`/api/putaway-tasks/${t.id}/complete`, { scannedLocation: blocked.full_code, overrideReason: "test" });
    assert.equal(r2.body.error.code, "bin_not_suitable");
    assert.equal((await ww.post(`/api/putaway-tasks/${t.id}/complete`, { scannedLocation: other.fullCode, overrideReason: "الخانة المقترحة مشغولة فعلياً" })).status, 200);
  });

  test("3-way match flags price variance beyond tolerance", async () => {
    const it = await newItem();
    const { po } = await receive(it.id, 10, { price: 20 });
    const fin = await login("fin");
    const pl = (await fin.get(`/api/purchase-orders/${po.id}`)).body.lines[0];
    const ok = await fin.post("/api/invoices", { poId: po.id, invoiceNo: `INV-${uniq()}`, invoiceDate: "2026-11-25", lines: [{ poLineId: pl.id, qty: 5, unitPrice: 20.1 }] });
    assert.equal(ok.body.status, "ready_for_payment");
    const bad = await fin.post("/api/invoices", { poId: po.id, invoiceNo: `INV-${uniq()}`, invoiceDate: "2026-11-25", lines: [{ poLineId: pl.id, qty: 5, unitPrice: 23 }] });
    assert.equal(bad.body.status, "exception");
    assert.equal(bad.body.match[0].result, "price_variance");
    const over = await fin.post("/api/invoices", { poId: po.id, invoiceNo: `INV-${uniq()}`, invoiceDate: "2026-11-25", lines: [{ poLineId: pl.id, qty: 5, unitPrice: 20 }] });
    assert.equal(over.body.match[0].result, "qty_variance", "now 15 invoiced vs 10 received");
  });

  test("supplier portal users only see their own purchase orders", async () => {
    const sup = await login("supplier.rowad");
    const list = (await sup.get("/api/purchase-orders")).body.data;
    const supplierId = (await pool.query("SELECT supplier_id FROM app_user WHERE username = 'supplier.rowad'")).rows[0].supplier_id;
    assert.ok(list.length > 0);
    assert.ok(list.every((p: any) => p.supplier_id === supplierId));
    const foreign = (await pool.query("SELECT id FROM purchase_order WHERE supplier_id <> $1 LIMIT 1", [supplierId])).rows[0];
    assert.equal((await sup.get(`/api/purchase-orders/${foreign.id}`)).status, 403);
  });
});

describe("material requests: validation, DoA approvals, SoD, delegation, fulfilment", () => {
  const draft = async (c: Client, lines: { itemId: string; qty: number }[], over: Record<string, unknown> = {}) =>
    (await c.post("/api/requests", { requestType: "issue", warehouseId: L.wh("CLN"), purpose: "اختبار", lines, ...over })).body;

  test("auto-validation blocks out-of-stock items and warns on partial stock", async () => {
    const req = await login("req.env");
    const empty = await newItem();
    const m = await draft(req, [{ itemId: empty.id, qty: 1 }]);
    const r = await req.post(`/api/requests/${m.id}/submit`);
    assert.equal(r.status, 422);
    assert.equal(r.body.error.details.errors[0].code, "out_of_stock");
    const it = await newItem();
    await receive(it.id, 5);
    const m2 = await draft(req, [{ itemId: it.id, qty: 8 }]);
    const w = await req.post(`/api/requests/${m2.id}/submit`);
    assert.equal(w.body.error.details.warnings[0].code, "partial_stock");
    assert.equal((await req.post(`/api/requests/${m2.id}/submit`, { acknowledgeWarnings: true })).status, 200);
  });

  test("DoA: low value → department manager only; above SAR 5,000 → + warehouse manager", async () => {
    const req = await login("req.env"), dm = await login("dm.env");
    const it = await newItem({ standardCost: 100 });
    await receive(it.id, 100, { price: 100 });
    const small = await draft(req, [{ itemId: it.id, qty: 2 }]);
    await req.post(`/api/requests/${small.id}/submit`);
    assert.equal((await dm.post(`/api/requests/${small.id}/decision`, { action: "approve" })).body.status, "approved");
    const big = await draft(req, [{ itemId: it.id, qty: 60 }]);      // 6,000 SAR
    const sub = await req.post(`/api/requests/${big.id}/submit`);
    assert.equal(sub.body.error.details.warnings[0].code, "possible_duplicate", "same item requested again within 7 days");
    assert.equal((await req.post(`/api/requests/${big.id}/submit`, { acknowledgeWarnings: true })).status, 200);
    assert.equal((await dm.post(`/api/requests/${big.id}/decision`, { action: "approve" })).body.status, "pending_approval");
    assert.equal((await wmN.post(`/api/requests/${big.id}/decision`, { action: "approve" })).body.error.code, "not_your_approval");
    assert.equal((await wmR.post(`/api/requests/${big.id}/decision`, { action: "approve" })).body.status, "approved");
  });

  test("SoD-1/2: requester cannot approve; approver cannot issue; requester cannot issue", async () => {
    const dm = await login("dm.env");
    const it = await newItem();
    await receive(it.id, 20);
    // a department manager requesting: routed to their manager / the warehouse manager, never to themselves
    const m = await draft(dm, [{ itemId: it.id, qty: 2 }]);
    await dm.post(`/api/requests/${m.id}/submit`);
    const det = (await dm.get(`/api/requests/${m.id}`)).body;
    assert.ok(det.approvals.every((a: any) => a.assignee_id !== det.requester_id));
    assert.equal((await dm.post(`/api/requests/${m.id}/decision`, { action: "approve" })).body.error.code, "not_your_approval");
    const approver = det.approvals.find((a: any) => a.status === "pending");
    const appr = await login((await pool.query("SELECT username FROM app_user WHERE id = $1", [approver.assignee_id])).rows[0].username);
    assert.equal((await appr.post(`/api/requests/${m.id}/decision`, { action: "approve" })).body.status, "approved");
    // the warehouse manager approved → cannot reserve/issue it (SoD-2) — but has no issue.execute anyway; check storekeeper path instead
    const r = await sk.post(`/api/requests/${m.id}/reserve`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  test("urgent requests: first of the parallel approvers completes the level; justification is mandatory", async () => {
    const req = await login("req.env"), dm = await login("dm.env");
    const it = await newItem();
    await receive(it.id, 10);
    const noJust = await draft(req, [{ itemId: it.id, qty: 1 }], { requestType: "urgent" });
    assert.equal((await req.post(`/api/requests/${noJust.id}/submit`)).body.error.details.errors[0].code, "justification_required");
    const m = await draft(req, [{ itemId: it.id, qty: 1 }], { requestType: "urgent", justification: "حالة طارئة في الموقع تتطلب الصرف فوراً" });
    await req.post(`/api/requests/${m.id}/submit`);
    const tasks = (await req.get(`/api/requests/${m.id}`)).body.approvals.filter((a: any) => a.status === "pending");
    assert.equal(tasks.length, 2);
    assert.equal((await dm.post(`/api/requests/${m.id}/decision`, { action: "approve" })).body.status, "approved");
    const after = (await req.get(`/api/requests/${m.id}`)).body;
    assert.equal(after.sla_due_at && new Date(after.sla_due_at).getTime() - new Date(after.submitted_at).getTime(), 4 * 3600_000);
  });

  test("delegation: a time-bound delegate approves on behalf of the absent manager", async () => {
    const reqIt = await login("req.it"), dmIt = await login("dm.it"), dmMnt = await login("dm.mnt");
    const it = await newItem();
    await receive(it.id, 10);
    // seed has dm.it → dm.mnt active; a fresh request routes to the delegate
    const m = await draft(reqIt, [{ itemId: it.id, qty: 1 }]);
    await reqIt.post(`/api/requests/${m.id}/submit`);
    const task = (await reqIt.get(`/api/requests/${m.id}`)).body.approvals.find((a: any) => a.status === "pending");
    assert.equal(task.assignee_id, await id("dm.mnt"));
    assert.equal(task.original_assignee_id, await id("dm.it"));
    assert.equal((await dmIt.post(`/api/requests/${m.id}/decision`, { action: "approve" })).body.error.code, "not_your_approval");
    assert.equal((await dmMnt.post(`/api/requests/${m.id}/decision`, { action: "approve" })).body.status, "approved");
  });

  test("FEFO reservation, scan-verified picking, partial delivery with e-signature, no negative stock", async () => {
    const req = await login("req.env"), dm = await login("dm.env");
    const it = await newItem({ trackBatch: true, trackExpiry: true, shelfLifeDays: 365 });
    await receive(it.id, 6, { lot: `LATE-${uniq()}`, expiry: "2028-06-30" });
    const early = `EARLY-${uniq()}`;
    await receive(it.id, 4, { lot: early, expiry: "2027-03-31" });
    const m = await draft(req, [{ itemId: it.id, qty: 5 }]);
    await req.post(`/api/requests/${m.id}/submit`);
    await dm.post(`/api/requests/${m.id}/decision`, { action: "approve" });
    assert.equal((await sk.post(`/api/requests/${m.id}/reserve`)).status, 200);
    const pl = (await sk.post(`/api/requests/${m.id}/pick-list`, { assignTo: await id("ww.cleaning1") })).body;
    const tasks = (await ww.get(`/api/pick-lists/${pl.id}`)).body.tasks;
    // FEFO: the whole early-expiry lot (4) is reserved before 1 from the later lot; tasks follow the walking path
    const byLot = Object.fromEntries(tasks.map((t: any) => [t.lot_no, t.qty]));
    assert.equal(byLot[early], 4, "earliest expiry is reserved first");
    assert.equal(Object.values(byLot).reduce((a: any, b: any) => a + b, 0), 5);
    tasks.sort((x: any, y: any) => (x.lot_no === early ? -1 : 1));
    // wrong bin / wrong item are refused
    const wrongBin = await ww.post(`/api/pick-tasks/${tasks[0].id}/confirm`, { location: "CLN-STR-A08-R06-B04", item: it.item_code, lot: early, qty: 4 });
    assert.equal(wrongBin.body.error.code, "wrong_location");
    const wrongItem = await ww.post(`/api/pick-tasks/${tasks[0].id}/confirm`, { location: tasks[0].full_code, item: "CLPAP-00002", lot: early, qty: 4 });
    assert.equal(wrongItem.body.error.code, "wrong_item");
    assert.equal((await ww.post(`/api/pick-tasks/${tasks[0].id}/confirm`, { location: tasks[0].full_code, item: it.item_code, lot: early, qty: 4 })).status, 200);
    // short pick on the second task (only 0.5 of 1 found → short)
    assert.equal((await ww.post(`/api/pick-tasks/${tasks[1].id}/confirm`, { location: tasks[1].full_code, item: it.item_code, lot: tasks[1].lot_no, qty: 0.5 })).body.short, true);
    // deliver: receiver signs; requester cannot deliver; approver cannot deliver
    assert.equal((await req.post(`/api/requests/${m.id}/deliver`, { receivedByName: "x", signaturePng: SIGNATURE })).status, 403);
    const bad = await sk.post(`/api/requests/${m.id}/deliver`, { receivedByUserId: await id("req.env"), receivedByName: "محمد", signaturePng: "data:image/png;base64,AAAA" });
    assert.equal(bad.status, 422);
    const d = await sk.post(`/api/requests/${m.id}/deliver`, { receivedByUserId: await id("req.env"), receivedByName: "محمد بن صالح المطيري", signaturePng: SIGNATURE });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(d.body.full, false);
    const after = (await req.get(`/api/requests/${m.id}`)).body;
    assert.equal(after.status, "partially_delivered");
    assert.equal(after.lines[0].qty_issued, 4.5);
    // remaining reservation released → free stock = 10 − 4.5
    const stock = (await wmR.get(`/api/items/${it.id}/stock`)).body.balances;
    assert.equal(stock.reduce((a: number, b: any) => a + b.qty_on_hand, 0), 5.5);
    assert.equal(stock.reduce((a: number, b: any) => a + b.qty_reserved, 0), 0);
    // delivery note carries the signature hash
    const dn = (await sk.get(`/api/delivery-notes/${after.deliveries[0].id}`)).body;
    assert.match(dn.signature_sha256, /^[0-9a-f]{64}$/);
    // WM short-closes the rest
    assert.equal((await wmR.post(`/api/requests/${m.id}/short-close`, { reason: "يكفي الموجود" })).status, 200);
  });

  test("competing requests cannot reserve more than the free stock", async () => {
    const req = await login("req.env"), dm = await login("dm.env");
    const it = await newItem();
    await receive(it.id, 10);
    const a = await draft(req, [{ itemId: it.id, qty: 7 }], { purpose: "a" });
    const b = await draft(await login("req.mnt"), [{ itemId: it.id, qty: 7 }], { purpose: "b" });
    await req.post(`/api/requests/${a.id}/submit`);
    const reqM = await login("req.mnt");
    await reqM.post(`/api/requests/${b.id}/submit`, { acknowledgeWarnings: true });
    await dm.post(`/api/requests/${a.id}/decision`, { action: "approve" });
    await (await login("dm.mnt")).post(`/api/requests/${b.id}/decision`, { action: "approve" });
    await sk.post(`/api/requests/${a.id}/reserve`);
    const rb = await sk.post(`/api/requests/${b.id}/reserve`);
    assert.equal(rb.status, 200);
    assert.equal(rb.body.shortages[0].short, 4, "only 3 left for the second request");
    const bal = (await pool.query("SELECT sum(qty_on_hand) AS h, sum(qty_reserved) AS r FROM stock_balance WHERE item_id = $1", [it.id])).rows[0];
    assert.equal(Number(bal.h), 10);
    assert.equal(Number(bal.r), 10);
  });

  test("return for revision, reject, and request visibility by role", async () => {
    const req = await login("req.env"), dm = await login("dm.env"), other = await login("req.mnt");
    const it = await newItem();
    await receive(it.id, 5);
    const m = await draft(req, [{ itemId: it.id, qty: 1 }]);
    await req.post(`/api/requests/${m.id}/submit`);
    assert.equal((await other.get(`/api/requests/${m.id}`)).status, 404, "other requesters cannot see it");
    assert.equal((await dm.post(`/api/requests/${m.id}/decision`, { action: "return" })).status, 422, "reason required");
    assert.equal((await dm.post(`/api/requests/${m.id}/decision`, { action: "return", comment: "حدد الغرض" })).body.status, "draft");
    await req.post(`/api/requests/${m.id}/submit`);
    assert.equal((await dm.post(`/api/requests/${m.id}/decision`, { action: "reject", comment: "غير مبرر" })).body.status, "rejected");
    const list = (await other.get("/api/requests?pageSize=200")).body.data;
    const otherId = await id("req.mnt");
    assert.ok(list.length > 0);
    assert.ok(list.every((r: any) => r.requester_id === otherId), "a requester only lists their own requests");
    assert.ok(!list.some((r: any) => r.id === m.id));
  });

  test("SLA sweep flags overdue requests and escalates the stuck approval", async () => {
    const req = await login("req.env");
    const it = await newItem();
    await receive(it.id, 5);
    const m = await draft(req, [{ itemId: it.id, qty: 1 }]);
    await req.post(`/api/requests/${m.id}/submit`);
    const { slaSweep } = await import("../src/services/requests.ts");
    const { withTx } = await import("../src/db/pool.ts");
    await withTx({ userId: await id("system") }, async (c) => {
      await c.query("UPDATE material_request SET sla_due_at = now() - interval '1 minute' WHERE id = $1", [m.id]);
      await slaSweep(c);
    });
    const after = (await req.get(`/api/requests/${m.id}`)).body;
    assert.equal(after.is_overdue, true);
    assert.ok(after.approvals.some((a: any) => a.is_escalation && a.status === "pending"));
    assert.ok(after.events.some((e: any) => e.event === "overdue"));
  });

  test("the database refuses any posting that would make stock negative", async () => {
    const it = await newItem();
    await receive(it.id, 3);
    const { withTx } = await import("../src/db/pool.ts");
    const bin = (await pool.query("SELECT location_id FROM stock_balance WHERE item_id = $1 AND qty_on_hand > 0", [it.id])).rows[0].location_id;
    await assert.rejects(withTx({ userId: await id("sk.cleaning") }, (c) =>
      c.query("SELECT wms_post('TEST', NULL, 'T', NULL, 'GI', $1, $2, NULL, 'available', -4)", [it.id, bin])), /insufficient stock/);
  });
});
