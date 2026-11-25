import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import { app, pool, login, lookups, type Client } from "./helpers.ts";
import { PDF, multipart, newItem, receive, id } from "./flows.ts";

after(async () => { await app.close(); await pool.end(); });
const L = await lookups();

let planner: Client, wmR: Client, wmN: Client, skR: Client, skN: Client, wwR1: Client, wwR2: Client, wwN: Client,
  cdc1: Client, cdc2: Client, fin: Client, reqEnv: Client, proc: Client;
before(async () => {
  [planner, wmR, wmN, skR, skN, wwR1, wwR2, wwN, cdc1, cdc2, fin, reqEnv, proc] = await Promise.all(
    ["planner", "wm.riyadh", "wm.north", "sk.riyadh", "sk.north", "ww.riyadh1", "ww.riyadh2", "ww.north", "cdc1", "cdc2", "fin", "req.env", "proc"].map((u) => login(u)));
});

const qty = async (itemId: string, wh: string, status = "available") =>
  Number((await pool.query(`SELECT coalesce(sum(qty_on_hand),0) AS q FROM stock_balance WHERE item_id = $1 AND warehouse_id = $2 AND stock_status = $3`,
    [itemId, L.wh(wh), status])).rows[0].q);
const ok = (r: { status: number; body: any }, code = 200) => assert.equal(r.status, code, JSON.stringify(r.body));
const balanceOf = async (itemId: string, status: string) =>
  (await pool.query("SELECT id, qty_on_hand FROM stock_balance WHERE item_id = $1 AND stock_status = $2 AND qty_on_hand > 0 LIMIT 1", [itemId, status])).rows[0];

/** Walks every pending approval of a document with whichever assignee holds it. */
async function approveAll(docType: string, docId: string, clients: Record<string, Client>) {
  for (let i = 0; i < 5; i++) {
    const t = (await pool.query(`SELECT u.username FROM approval_task t JOIN app_user u ON u.id = t.assignee_id WHERE t.doc_type = $1 AND t.doc_id = $2 AND t.status = 'pending' LIMIT 1`,
      [docType, docId])).rows[0];
    if (!t) return;
    const c = clients[t.username] ?? (clients[t.username] = await login(t.username));
    ok(await c.post(`/api/approvals/${docType}/${docId}/decision`, { action: "approve" }));
  }
}

let moveItem: any; // shared stock for the move / return tests

describe("inter-warehouse transfers (in transit)", () => {
  test("approve → ship (in transit) → partial receipt → transit adjustment → closed", async () => {
    const it = await newItem();
    await receive(it.id, 20, { price: 10 });
    moveItem = it;
    const tr = await planner.post("/api/transfers", { fromWarehouseId: L.wh("RYD"), toWarehouseId: L.wh("NTH"), reason: "اختبار", lines: [{ itemId: it.id, qty: 8 }] });
    ok(tr, 201);
    assert.match(tr.body.tr_no, /^TR-\d{4}-\d{6}$/);
    ok(await planner.post(`/api/transfers/${tr.body.id}/submit`));
    assert.equal((await skR.post(`/api/transfers/${tr.body.id}/ship`)).status, 409, "cannot ship before approval");
    const inbox = (await wmR.get("/api/approvals/inbox")).body.data;
    assert.ok(inbox.some((t: any) => t.doc_type === "TR" && t.doc_id === tr.body.id), "source WM sees it in the unified inbox");
    assert.equal((await wmN.post(`/api/approvals/TR/${tr.body.id}/decision`, { action: "approve" })).status, 403, "only the assigned approver");
    ok(await wmR.post(`/api/approvals/TR/${tr.body.id}/decision`, { action: "approve" }));
    assert.equal((await wmR.post(`/api/transfers/${tr.body.id}/ship`)).status, 403, "approver lacks issue permission");
    ok(await skR.post(`/api/transfers/${tr.body.id}/ship`));
    assert.equal(await qty(it.id, "RYD"), 12);
    assert.equal(await qty(it.id, "NTH", "in_transit"), 8, "booked in transit at the destination");
    assert.equal((await skR.post(`/api/transfers/${tr.body.id}/receive`)).status, 403, "source storekeeper is out of scope at the destination");

    const det = (await skN.get(`/api/transfers/${tr.body.id}`)).body;
    assert.equal(det.status, "in_transit");
    assert.ok(det.actions.receive);
    const rec = await skN.post(`/api/transfers/${tr.body.id}/receive`, { lines: [{ shipmentId: det.shipments[0].id, qty: 7 }] });
    ok(rec);
    assert.equal(rec.body.status, "received");
    assert.equal(await qty(it.id, "NTH"), 7);
    assert.equal(await qty(it.id, "NTH", "in_transit"), 1, "shortfall stays in transit until adjusted");
    const tasks = (await pool.query("SELECT count(*)::int AS n FROM putaway_task WHERE transfer_id = $1", [tr.body.id])).rows[0].n;
    assert.equal(tasks, 1, "put-away task created at the destination");

    const adjId = rec.body.adjustmentId;
    ok(await skN.post(`/api/adjustments/${adjId}/submit`));
    ok(await wmN.post(`/api/approvals/ADJ/${adjId}/decision`, { action: "approve" }));
    const selfPost = await skN.post(`/api/adjustments/${adjId}/post`);
    assert.equal(selfPost.status, 409);
    assert.equal(selfPost.body.error.details.rule, "SoD-3", "creator cannot post");
    ok(await cdc1.post(`/api/adjustments/${adjId}/post`));
    assert.equal(await qty(it.id, "NTH", "in_transit"), 0);
    assert.equal((await skN.get(`/api/transfers/${tr.body.id}`)).body.status, "closed");
  });
});

describe("bin-to-bin moves", () => {
  test("validates scans, quantity, warehouse and scope", async () => {
    const src = (await pool.query(`SELECT l.full_code FROM stock_balance b JOIN location l ON l.id = b.location_id
                                   WHERE b.item_id = $1 AND b.warehouse_id = $2 AND b.stock_status = 'available' AND b.qty_on_hand > 0 LIMIT 1`, [moveItem.id, L.wh("RYD")])).rows[0].full_code;
    const dst = (await pool.query(`SELECT l.full_code FROM location l JOIN location r ON r.id = l.parent_id JOIN location a ON a.id = r.parent_id JOIN location z ON z.id = a.parent_id
                                   WHERE l.warehouse_id = $1 AND l.level = 'bin' AND z.zone_type = 'storage' AND NOT l.is_blocked AND l.full_code <> $2
                                     AND NOT EXISTS (SELECT 1 FROM stock_balance b WHERE b.location_id = l.id AND b.qty_on_hand > 0) ORDER BY l.full_code LIMIT 1`, [L.wh("RYD"), src])).rows[0].full_code;
    const nthBin = (await pool.query(`SELECT full_code FROM location WHERE warehouse_id = $1 AND level = 'bin' LIMIT 1`, [L.wh("NTH")])).rows[0].full_code;
    const before = await qty(moveItem.id, "RYD");
    ok(await skR.post("/api/moves", { from: src, to: dst, item: moveItem.item_code, qty: 2 }));
    assert.equal(await qty(moveItem.id, "RYD"), before, "moves never change the warehouse total");
    assert.equal((await skR.post("/api/moves", { from: src, to: dst, item: moveItem.item_code, qty: 999 })).status, 409);
    assert.equal((await skR.post("/api/moves", { from: dst, to: nthBin, item: moveItem.item_code, qty: 1 })).status, 422);
    assert.equal((await skR.post("/api/moves", { from: dst, to: dst, item: moveItem.item_code, qty: 1 })).status, 422);
    assert.equal((await wwN.post("/api/moves", { from: dst, to: src, item: moveItem.item_code, qty: 1 })).status, 403, "out of warehouse scope");
    assert.equal((await reqEnv.post("/api/moves", { from: dst, to: src, item: moveItem.item_code, qty: 1 })).status, 403, "requester cannot move stock");
  });
});

describe("returns, quarantine and returns to vendor", () => {
  test("return to warehouse is routed by condition; quarantine release is a WM decision", async () => {
    const r = await reqEnv.post("/api/returns", { warehouseId: L.wh("RYD"), reason: "مواد غير مستخدمة", lines: [
      { itemId: moveItem.id, qty: 2, condition: "good" }, { itemId: moveItem.id, qty: 2, condition: "quarantine" }, { itemId: moveItem.id, qty: 1, condition: "damaged" }] });
    ok(r, 201);
    const avail = await qty(moveItem.id, "RYD");
    assert.equal((await reqEnv.post(`/api/returns/${r.body.id}/receive`)).status, 403, "requester cannot book the return");
    ok(await skR.post(`/api/returns/${r.body.id}/receive`));
    assert.equal(await qty(moveItem.id, "RYD"), avail + 2);
    assert.equal(await qty(moveItem.id, "RYD", "quarantine"), 2);
    assert.equal(await qty(moveItem.id, "RYD", "damaged"), 1);
    const zones = (await pool.query(`SELECT z.zone_type FROM return_line rl JOIN location l ON l.id = rl.to_location_id JOIN location r ON r.id = l.parent_id
                                     JOIN location a ON a.id = r.parent_id JOIN location z ON z.id = a.parent_id WHERE rl.return_id = $1 ORDER BY rl.line_no`, [r.body.id])).rows.map((x) => x.zone_type);
    assert.deepEqual(zones, ["returns", "quarantine", "damaged"]);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM putaway_task WHERE return_id = $1", [r.body.id])).rows[0].n, 1, "good stock gets a put-away task");
    assert.equal((await skR.post(`/api/returns/${r.body.id}/receive`)).status, 409, "booked once only");

    const qList = (await wmR.get("/api/quarantine")).body.data;
    const qb = qList.find((b: any) => b.item_id === moveItem.id && b.stock_status === "quarantine");
    assert.ok(qb);
    assert.equal((await skR.post(`/api/quarantine/${qb.id}/status`, { to: "available", qty: 1, reason: "سليم" })).status, 403);
    ok(await wmR.post(`/api/quarantine/${qb.id}/status`, { to: "available", qty: 1, reason: "سليم بعد الفحص" }));
    assert.equal(await qty(moveItem.id, "RYD", "quarantine"), 1);
    assert.equal(await qty(moveItem.id, "RYD"), avail + 3);
  });

  test("return against a request cannot exceed what was issued", async () => {
    const m = (await pool.query(`SELECT m.id, m.warehouse_id, l.item_id, l.qty_issued FROM material_request m JOIN mr_line l ON l.mr_id = m.id
                                 WHERE m.status = 'closed' AND l.qty_issued > 0 LIMIT 1`)).rows[0];
    const r = await reqEnv.post("/api/returns", { warehouseId: m.warehouse_id, mrId: m.id, reason: "اختبار الحد", lines: [{ itemId: m.item_id, qty: Number(m.qty_issued) + 1 }] });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, "exceeds_issued");
  });

  test("RTV: approval → shipment by the storekeeper → credit note", async () => {
    const dmg = await balanceOf(moveItem.id, "damaged");
    const sup = (await pool.query("SELECT id FROM supplier WHERE code = 'SUP-001'")).rows[0].id;
    const rtv = await skR.post("/api/rtv", { warehouseId: L.wh("RYD"), supplierId: sup, reason: "عيب مصنعي", lines: [{ balanceId: dmg.id, qty: 1 }] });
    ok(rtv, 201);
    assert.match(rtv.body.ret_no, /^RTV-/);
    ok(await skR.post(`/api/rtv/${rtv.body.id}/submit`));
    ok(await wmR.post(`/api/approvals/RTV/${rtv.body.id}/decision`, { action: "approve" }));
    assert.equal((await wmR.post(`/api/rtv/${rtv.body.id}/ship`)).status, 403);
    ok(await skR.post(`/api/rtv/${rtv.body.id}/ship`));
    assert.equal(await qty(moveItem.id, "RYD", "damaged"), 0);
    ok(await proc.post(`/api/rtv/${rtv.body.id}/credit-note`, { creditNoteRef: "CN-T-1" }));
    assert.equal((await skR.get(`/api/returns/${rtv.body.id}`)).body.status, "closed");
  });
});

describe("stock counting", () => {
  test("blind count, recount by a different counter, review → adjustment with SoD-3", async () => {
    const it = await newItem();
    await receive(it.id, 10, { price: 20 });
    const bad = await planner.post("/api/counts", { warehouseId: L.wh("RYD"), countType: "annual", itemIds: [it.id], counterIds: [await id("req.env")] });
    assert.equal(bad.status, 422, "counters need the count permission");
    const plan = await planner.post("/api/counts", { warehouseId: L.wh("RYD"), countType: "annual", itemIds: [it.id], counterIds: [await id("ww.riyadh1"), await id("ww.riyadh2")] });
    ok(plan, 201);
    assert.equal(plan.body.blind, true, "blind by default");
    ok(await wmR.post(`/api/counts/${plan.body.id}/release`));

    const counterView = (await wwR1.get(`/api/counts/${plan.body.id}`)).body;
    assert.equal(counterView.blindHidden, true);
    assert.equal(counterView.lines.length, 1);
    assert.equal(counterView.lines[0].qty_snapshot, undefined, "counter never sees the system quantity");
    assert.equal((await wmR.get(`/api/counts/${plan.body.id}`)).body.lines[0].qty_snapshot, 10, "planner/reviewer sees it");
    const lineId = counterView.lines[0].id;

    assert.equal((await reqEnv.post(`/api/count-lines/${lineId}`, { qty: 9 })).status, 403);
    const c1 = await wwR1.post(`/api/count-lines/${lineId}`, { qty: 9 });
    ok(c1);
    assert.equal(c1.body.status, "recount", "out of tolerance → recount");
    assert.equal((await wmR.post(`/api/counts/${plan.body.id}/finish`)).status, 409, "cannot finish with a pending recount");
    const same = await wwR1.post(`/api/count-lines/${lineId}`, { qty: 9 });
    assert.equal(same.status, 409);
    assert.equal(same.body.error.details.rule, "COUNT-2");
    ok(await wwR2.post(`/api/count-lines/${lineId}`, { qty: 9, reason: "تأكيد" }));

    const fin1 = await wmR.post(`/api/counts/${plan.body.id}/finish`);
    ok(fin1);
    assert.equal(fin1.body.variances, 1);
    const adjId = fin1.body.adjustmentId;
    const adj = (await wmR.get(`/api/adjustments/${adjId}`)).body;
    assert.equal(adj.status, "pending_approval");
    assert.equal(adj.lines[0].qty_delta, -1);
    assert.equal(adj.value_abs, 20);
    // reviewer raised it → routed to another warehouse manager (requester ≠ approver)
    assert.equal(adj.approvals[0].assignee_id, await id("wm.north"));
    ok(await wmN.post(`/api/approvals/ADJ/${adjId}/decision`, { action: "approve" }));
    const p1 = await wmR.post(`/api/adjustments/${adjId}/post`);
    assert.equal(p1.status, 409, "creator cannot post (SoD-3)");
    ok(await skR.post(`/api/adjustments/${adjId}/post`));
    assert.equal(await qty(it.id, "RYD"), 9);
    assert.equal((await wmR.get(`/api/counts/${plan.body.id}`)).body.status, "closed");
  });

  test("within tolerance closes without adjustment; ABC classification runs", async () => {
    const it = await newItem();
    await receive(it.id, 5, { price: 3 });
    const plan = (await planner.post("/api/counts", { warehouseId: L.wh("RYD"), countType: "annual", blind: false, itemIds: [it.id], counterIds: [await id("ww.riyadh1")] })).body;
    ok(await planner.post(`/api/counts/${plan.id}/release`));
    const v = (await wwR1.get(`/api/counts/${plan.id}`)).body;
    assert.equal(v.blindHidden, false);
    assert.equal(v.lines[0].qty_snapshot, 5);
    ok(await wwR1.post(`/api/count-lines/${v.lines[0].id}`, { qty: 5 }));
    const f = await wmR.post(`/api/counts/${plan.id}/finish`);
    ok(f);
    assert.equal(f.body.variances, 0);
    assert.equal((await wmR.get(`/api/counts/${plan.id}`)).body.status, "closed");
    const abc = await planner.post("/api/classification/abc");
    ok(abc);
    assert.ok(abc.body.a > 0 && abc.body.c > 0);
  });
});

describe("adjustments", () => {
  test("DoA levels by value, SoD-3 and no negative stock", async () => {
    const it = await newItem({ standardCost: 5000 });
    await receive(it.id, 3, { price: 5000 });
    const bin = (await pool.query("SELECT location_id FROM stock_balance WHERE item_id = $1 AND qty_on_hand > 0 LIMIT 1", [it.id])).rows[0].location_id;
    const a = await skR.post("/api/adjustments", { warehouseId: L.wh("RYD"), reason: "فقد مثبت بمحضر", lines: [{ locationId: bin, itemId: it.id, qtyDelta: -3 }] });
    ok(a, 201);
    assert.equal(a.body.value_abs, 15000);
    ok(await skR.post(`/api/adjustments/${a.body.id}/submit`));
    ok(await wmR.post(`/api/approvals/ADJ/${a.body.id}/decision`, { action: "approve" }));
    assert.equal((await skR.get(`/api/adjustments/${a.body.id}`)).body.status, "pending_approval", "above SAR 10,000 → Finance");
    assert.ok((await fin.get("/api/approvals/inbox")).body.data.some((t: any) => t.doc_id === a.body.id));
    ok(await fin.post(`/api/approvals/ADJ/${a.body.id}/decision`, { action: "approve" }));
    assert.equal((await skR.post(`/api/adjustments/${a.body.id}/post`)).status, 409, "creator cannot post");
    assert.equal((await fin.post(`/api/adjustments/${a.body.id}/post`)).status, 403, "finance cannot post stock");
    ok(await cdc1.post(`/api/adjustments/${a.body.id}/post`));
    assert.equal(await qty(it.id, "RYD"), 0);

    // an approved adjustment that would drive stock negative is refused by the posting engine
    const it2 = await newItem();
    await receive(it2.id, 2, { price: 4 });
    const bin2 = (await pool.query("SELECT location_id FROM stock_balance WHERE item_id = $1 AND qty_on_hand > 0 LIMIT 1", [it2.id])).rows[0].location_id;
    const neg = (await skR.post("/api/adjustments", { warehouseId: L.wh("RYD"), reason: "اختبار السالب", lines: [{ locationId: bin2, itemId: it2.id, qtyDelta: -5 }] })).body;
    ok(await skR.post(`/api/adjustments/${neg.id}/submit`));
    await approveAll("ADJ", neg.id, { "wm.riyadh": wmR, fin });
    const p = await cdc1.post(`/api/adjustments/${neg.id}/post`);
    assert.ok(p.status >= 400 && p.status < 500, JSON.stringify(p.body));
    assert.equal(await qty(it2.id, "RYD"), 2, "nothing posted");
    assert.equal((await skR.get(`/api/adjustments/${neg.id}`)).body.status, "approved");
  });

  test("reject/return need a reason", async () => {
    const it = await newItem();
    await receive(it.id, 4, { price: 5 });
    const bin = (await pool.query("SELECT location_id FROM stock_balance WHERE item_id = $1 AND qty_on_hand > 0 LIMIT 1", [it.id])).rows[0].location_id;
    const a = (await skR.post("/api/adjustments", { warehouseId: L.wh("RYD"), reason: "زيادة", lines: [{ locationId: bin, itemId: it.id, qtyDelta: 1 }] })).body;
    ok(await skR.post(`/api/adjustments/${a.id}/submit`));
    assert.equal((await wmR.post(`/api/approvals/ADJ/${a.id}/decision`, { action: "reject" })).status, 422);
    ok(await wmR.post(`/api/approvals/ADJ/${a.id}/decision`, { action: "return", comment: "أرفق محضر الواقعة" }));
    assert.equal((await skR.get(`/api/adjustments/${a.id}`)).body.status, "draft");
  });
});

describe("disposals / write-offs", () => {
  test("committee minutes required, SoD-5, posting removes the stock", async () => {
    const it = await newItem();
    await receive(it.id, 6, { price: 15 });
    const r = (await reqEnv.post("/api/returns", { warehouseId: L.wh("RYD"), reason: "تالف", lines: [{ itemId: it.id, qty: 4, condition: "damaged" }] })).body;
    ok(await skR.post(`/api/returns/${r.id}/receive`));
    const dmg = await balanceOf(it.id, "damaged");
    assert.equal((await cdc1.post("/api/disposals", { warehouseId: L.wh("RYD"), method: "scrap", reason: "تالف", committeeIds: [], lines: [{ balanceId: dmg.id, qty: 4 }] })).status, 422,
      "at least two committee members");
    assert.equal((await skR.post("/api/disposals", { warehouseId: L.wh("RYD"), method: "scrap", reason: "تالف", committeeIds: [await id("cdc1")], lines: [{ balanceId: dmg.id, qty: 4 }] })).status, 403);
    const d = await cdc1.post("/api/disposals", { warehouseId: L.wh("RYD"), method: "scrap", reason: "تالف غير قابل للإصلاح", committeeIds: [await id("cdc2")], lines: [{ balanceId: dmg.id, qty: 4 }] });
    ok(d, 201);
    assert.equal(d.body.total_value, 60);
    const noMin = await cdc1.post(`/api/disposals/${d.body.id}/recommend`);
    assert.equal(noMin.status, 409);
    assert.equal(noMin.body.error.code, "minutes_required");
    const mp = multipart({ ownerType: "disposal", ownerId: d.body.id, category: "minutes" }, { name: "minutes.pdf", type: "application/pdf", data: PDF });
    assert.equal((await skR.req("POST", "/api/attachments", mp.body, { "content-type": mp.type })).status, 403, "only the committee uploads minutes");
    ok(await cdc2.req("POST", "/api/attachments", mp.body, { "content-type": mp.type }), 201);
    ok(await cdc1.post(`/api/disposals/${d.body.id}/recommend`));
    ok(await wmR.post(`/api/approvals/DSP/${d.body.id}/decision`, { action: "approve" }));
    assert.equal((await cdc1.post(`/api/disposals/${d.body.id}/post`)).status, 409, "not approved yet");
    ok(await fin.post(`/api/approvals/DSP/${d.body.id}/decision`, { action: "approve" }));
    const det = (await skR.get(`/api/disposals/${d.body.id}`)).body;
    assert.equal(det.status, "approved");
    assert.equal(det.attachments.length, 1);
    const byCommittee = await cdc1.post(`/api/disposals/${d.body.id}/post`);
    assert.equal(byCommittee.status, 409);
    assert.equal(byCommittee.body.error.details.rule, "SoD-5");
    ok(await skR.post(`/api/disposals/${d.body.id}/post`));
    assert.equal(await qty(it.id, "RYD", "damaged"), 0);
    const mv = (await pool.query("SELECT movement_type, qty FROM stock_ledger WHERE doc_type = 'DSP' AND doc_id = $1", [d.body.id])).rows;
    assert.deepEqual(mv.map((m) => [m.movement_type, Number(m.qty)]), [["SCRAP", -4]]);
  });
});

describe("integrity", () => {
  test("ledger equals balances and the audit chain verifies", async () => {
    const q = (await pool.query(`SELECT (SELECT coalesce(sum(qty),0) FROM stock_ledger) AS l, (SELECT coalesce(sum(qty_on_hand),0) FROM stock_balance) AS b,
                                        (SELECT count(*) FROM stock_balance WHERE qty_on_hand < 0) AS neg`)).rows[0];
    assert.equal(Number(q.l), Number(q.b));
    assert.equal(Number(q.neg), 0);
    const v = (await pool.query("SELECT * FROM audit_verify()")).rows[0];
    assert.equal(Object.values(v)[1], null, "no broken link in the audit chain");
  });
});
