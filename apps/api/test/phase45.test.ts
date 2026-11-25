import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import { app, pool, login, lookups, uniq, type Client } from "./helpers.ts";
import { SIGNATURE, newItem, receive, id } from "./flows.ts";
import { computeLine } from "../src/services/planning.ts";

after(async () => { await app.close(); await pool.end(); });
const L = await lookups();
const ok = (r: { status: number; body: any }, code = 200) => assert.equal(r.status, code, JSON.stringify(r.body));

let planner: Client, wmR: Client, wmN: Client, skR: Client, wwR: Client, proc: Client, fin: Client, admin: Client, reqEnv: Client, dmEnv: Client, cdc1: Client, sup: Client;
before(async () => {
  [planner, wmR, wmN, skR, wwR, proc, fin, admin, reqEnv, dmEnv, cdc1, sup] = await Promise.all(
    ["planner", "wm.cons", "wm.assets", "sk.cleaning", "ww.cleaning1", "proc", "fin", "admin", "req.env", "dm.env", "cdc1", "supplier.rowad"].map((u) => login(u)));
});

/** Approves every pending task of a document with whoever holds it. */
async function approveAll(docType: string, docId: string) {
  for (let i = 0; i < 5; i++) {
    const t = (await pool.query(`SELECT u.username FROM approval_task t JOIN app_user u ON u.id = t.assignee_id WHERE t.doc_type = $1 AND t.doc_id = $2 AND t.status = 'pending' LIMIT 1`,
      [docType, docId])).rows[0];
    if (!t) return;
    const c = await login(t.username);
    const url = docType === "MR" ? `/api/requests/${docId}/decision` : `/api/approvals/${docType}/${docId}/decision`;
    ok(await c.post(url, { action: "approve" }));
  }
}

/** Full material-request lifecycle through the API, delivered to the requester. */
async function issue(requester: Client, requesterUser: string, type: string, lines: { itemId: string; qty: number }[]) {
  const m = await requester.post("/api/requests", { requestType: type, warehouseId: L.wh("CLN"), purpose: "اختبار", lines });
  ok(m, 201);
  ok(await requester.post(`/api/requests/${m.body.id}/submit`, { acknowledgeWarnings: true }));
  await approveAll("MR", m.body.id);
  ok(await skR.post(`/api/requests/${m.body.id}/reserve`));
  const pl = (await skR.post(`/api/requests/${m.body.id}/pick-list`, { assignTo: await id("ww.cleaning1") })).body;
  for (const t of (await wwR.get(`/api/pick-lists/${pl.id}`)).body.tasks) {
    ok(await wwR.post(`/api/pick-tasks/${t.id}/confirm`, { location: t.full_code, item: t.item_code, lot: t.serial_no ?? t.lot_no, qty: t.qty }));
  }
  ok(await skR.post(`/api/requests/${m.body.id}/deliver`, { receivedByUserId: await id(requesterUser), receivedByName: "مستلم", signaturePng: SIGNATURE }));
  return m.body;
}

describe("planning", () => {
  test("safety stock, ROP, EOQ and min/max follow the formulas", () => {
    // 30-day demand 60 ± σ → d = 2/day; LT 10 d; z = 1.65
    const buckets = [70, 50, 60, 60, 70, 50];
    const x = computeLine(buckets, { z: 1.65, orderCost: 150, holdingRate: 0.2, months: 6, defaultLeadTime: 14, deadDays: 180, slowDays: 90, leadTime: 10, unitCost: 30 });
    const sd30 = Math.sqrt(buckets.reduce((a, b) => a + (b - 60) ** 2, 0) / 5);
    assert.equal(x.d, 2);
    assert.equal(x.ss, Math.ceil(1.65 * (sd30 / Math.sqrt(30)) * Math.sqrt(10)));
    assert.equal(x.rop, Math.ceil(2 * 10 + 1.65 * (sd30 / Math.sqrt(30)) * Math.sqrt(10)));
    assert.equal(x.eoq, Math.ceil(Math.sqrt((2 * 730 * 150) / (0.2 * 30))));
    assert.equal(x.max, x.rop + x.eoq!);
    const none = computeLine([0, 0, 0], { z: 1.65, orderCost: 150, holdingRate: 0.2, months: 3, defaultLeadTime: 14, deadDays: 180, slowDays: 90, leadTime: 14, unitCost: 5 });
    assert.equal(none.d, 0);
    assert.equal(none.eoq, null);
  });

  test("run → apply → auto requisition → WM approval → procurement converts to PO (SoD)", async () => {
    const it = await newItem({ standardCost: 40 });
    await receive(it.id, 2, { price: 40 });
    // legacy demand: ~45/month → reorder needed with only 2 on hand
    const months = [1, 2, 3, 4, 5, 6].map((m) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - m); return d.toISOString().slice(0, 10); });
    for (const [i, p] of months.entries()) {
      await pool.query(`INSERT INTO consumption_history (item_id, warehouse_id, period, qty, value) VALUES ($1,$2,$3,$4,$5)`, [it.id, L.wh("CLN"), p, 40 + i * 2, (40 + i * 2) * 40]);
    }
    await pool.query("INSERT INTO item_warehouse_policy (item_id, warehouse_id, lead_time_days) VALUES ($1,$2,7) ON CONFLICT DO NOTHING", [it.id, L.wh("CLN")]).catch(() => {});
    assert.equal((await reqEnv.post("/api/planning/runs", { warehouseId: L.wh("CLN") })).status, 403);
    const run = await planner.post("/api/planning/runs", { warehouseId: L.wh("CLN") });
    ok(run, 201);
    const lines = (await planner.get(`/api/planning/runs/${run.body.id}?q=${it.item_code}`)).body.lines.data;
    assert.equal(lines.length, 1, "policy exists for the received item");
    const l = lines[0];
    assert.equal(l.action, "reorder");
    assert.ok(l.reorder_point > 2 && l.suggested_qty >= (l.eoq ?? 1));
    ok(await planner.post(`/api/planning/runs/${run.body.id}/apply`, { lineIds: [l.id] }));
    const pol = (await pool.query("SELECT reorder_point, max_qty, safety_stock FROM item_warehouse_policy WHERE item_id = $1 AND warehouse_id = $2", [it.id, L.wh("CLN")])).rows[0];
    assert.equal(Number(pol.reorder_point), l.reorder_point);
    assert.equal(Number(pol.max_qty), l.max_qty);

    const prs = await planner.post(`/api/planning/runs/${run.body.id}/prs`, { lineIds: [l.id] });
    ok(prs);
    const prId = prs.body.data[0].id;
    let pr = (await planner.get(`/api/prs/${prId}`)).body;
    assert.equal(pr.status, "pending_approval");
    assert.equal(pr.source, "auto");
    assert.equal(pr.lines[0].qty, l.suggested_qty);
    assert.equal((await proc.post(`/api/prs/${prId}/convert`, { supplierId: (await pool.query("SELECT id FROM supplier WHERE code='SUP-002'")).rows[0].id })).status, 409, "not approved yet");
    ok(await wmR.post(`/api/approvals/PR/${prId}/decision`, { action: "approve" }));
    const outbox = (await pool.query("SELECT count(*)::int AS n FROM integration_outbox WHERE doc_type = 'PR' AND doc_id = $1 AND event = 'requisition.approved'", [prId])).rows[0].n;
    assert.equal(outbox, 1, "approved requisition queued for Etimad");
    assert.equal((await planner.post(`/api/prs/${prId}/convert`, { supplierId: L.wh("CLN") })).status, 403, "planner cannot place POs");
    const po = await proc.post(`/api/prs/${prId}/convert`, { supplierId: (await pool.query("SELECT id FROM supplier WHERE code='SUP-002'")).rows[0].id, etimadRef: `ETM-${uniq()}` });
    ok(po, 201);
    pr = (await planner.get(`/api/prs/${prId}`)).body;
    assert.equal(pr.status, "converted");
    assert.equal(pr.po.po_no, po.body.po_no);
    // the next run counts the PO as on order → no second suggestion
    const run2 = (await planner.post("/api/planning/runs", { warehouseId: L.wh("CLN") })).body;
    const l2 = (await planner.get(`/api/planning/runs/${run2.id}?q=${it.item_code}`)).body.lines.data[0];
    assert.equal(l2.on_order, l.suggested_qty);
    assert.notEqual(l2.action, "reorder");
  });
});

describe("valuation & journals", () => {
  test("FIFO vs weighted average", async () => {
    const it = await newItem();
    await receive(it.id, 5, { price: 10 });
    await receive(it.id, 5, { price: 20 });
    const bin = (await pool.query("SELECT location_id FROM stock_balance WHERE item_id = $1 AND qty_on_hand > 0 LIMIT 1", [it.id])).rows[0].location_id;
    const a = (await skR.post("/api/adjustments", { warehouseId: L.wh("CLN"), reason: "اختبار FIFO", lines: [{ locationId: bin, itemId: it.id, qtyDelta: -5 }] })).body;
    ok(await skR.post(`/api/adjustments/${a.id}/submit`));
    await approveAll("ADJ", a.id);
    ok(await cdc1.post(`/api/adjustments/${a.id}/post`));
    const v = (await fin.get(`/api/valuation/items?warehouseId=${L.wh("CLN")}&q=${it.item_code}`)).body.data[0];
    assert.equal(v.qty_on_hand, 5);
    assert.equal(v.total_value, 75, "WAVG: 5 × 15");
    assert.equal(v.fifo_value, 100, "FIFO: the newest layer (5 × 20) remains");
  });

  test("journals: balanced, each ledger row once, frozen after posting, reconciled to the ledger", async () => {
    assert.equal((await wmR.post("/api/journals/generate")).status, 403);
    const g = await fin.post("/api/journals/generate");
    ok(g);
    const again = await fin.post("/api/journals/generate");
    assert.equal(again.body.data.length, 0, "nothing left to journalise");
    const q = (await pool.query(`SELECT (SELECT count(*) FROM stock_ledger)::int AS ledger, (SELECT count(*) FROM journal_source)::int AS src,
      (SELECT sum(debit) - sum(credit) FROM journal_line)::numeric AS diff`)).rows[0];
    assert.equal(q.src, q.ledger, "every ledger row journalised exactly once");
    assert.equal(Number(q.diff), 0, "debits = credits");
    const summary = (await fin.get("/api/valuation/summary")).body;
    assert.equal(summary.reconciled, true, JSON.stringify(summary.warehouses));
    for (const w of summary.warehouses) assert.equal(Math.round(w.gl_value * 100), Math.round(w.wavg_value * 100), "GL inventory = book value");

    const je = g.body.data[0] ?? (await fin.get("/api/journals?status=draft")).body.data[0];
    if (je) {
      const detail = (await fin.get(`/api/journals/${je.id}`)).body;
      assert.ok(detail.lines.length > 0);
      ok(await fin.post(`/api/journals/${je.id}/post`));
      await assert.rejects(pool.query("UPDATE journal_line SET debit = debit + 1 WHERE je_id = $1 AND debit > 0", [je.id]), /posted|frozen/);
      assert.equal((await fin.post(`/api/journals/${je.id}/post`)).status, 409);
      ok(await fin.post(`/api/journals/${je.id}/export`, { erpRef: `ERP-${uniq()}` }));
      assert.equal((await fin.get(`/api/journals/${je.id}`)).body.status, "exported");
    }
  });

  test("provision books only the change in the required balance", async () => {
    const p1 = await fin.post("/api/provisions", {});
    ok(p1, 201);
    const p2 = (await fin.post("/api/provisions", {})).body;
    assert.equal(p2.delta, 0, "unchanged stock → no new journal");
    assert.equal(p2.je, false);
    const bal = (await pool.query("SELECT coalesce(sum(credit - debit), 0) AS b FROM journal_line WHERE account_code = '1319'")).rows[0].b;
    assert.equal(Number(bal), p2.required);
  });
});

describe("custody & clearance", () => {
  test("custody request → asset registered → acknowledge → return; clearance blocked until returned", async () => {
    const it = await newItem({ itemType: "asset", trackSerial: true, standardCost: 3200 });
    const sn = [`SN-${uniq()}`, `SN-${uniq()}`];
    await receive(it.id, 2, { price: 3200, serials: sn });
    const m = await issue(reqEnv, "req.env", "custody", [{ itemId: it.id, qty: 1 }]);
    const mine = (await reqEnv.get("/api/custody?view=mine")).body.data.filter((x: any) => x.mr_id === m.id);
    assert.equal(mine.length, 1, "one custody per serial unit");
    const cu = mine[0];
    assert.ok(sn.includes(cu.serial_no));
    assert.equal(cu.value, 3200);
    assert.equal((await (await login("req.it")).get(`/api/custody/${cu.id}`)).status, 403, "another employee without custody rights cannot see it");
    assert.equal((await dmEnv.get(`/api/custody/${cu.id}`)).status, 200, "custody approvers see the register");
    assert.equal((await skR.post(`/api/custody/${cu.id}/acknowledge`)).status, 403);
    ok(await reqEnv.post(`/api/custody/${cu.id}/acknowledge`));

    // clearance blocked by the active custody; the employee cannot clear themselves
    const self = await skR.post("/api/clearances", { employeeId: await id("sk.cleaning"), reason: "transfer" });
    assert.equal(self.status, 409);
    const existing = (await pool.query("SELECT id FROM clearance WHERE employee_id = $1 AND status = 'blocked'", [await id("req.env")])).rows[0];
    const cl = existing ? (await skR.post(`/api/clearances/${existing.id}/recheck`)).body : (await skR.post("/api/clearances", { employeeId: await id("req.env"), reason: "resignation" })).body;
    assert.equal(cl.status, "blocked");
    assert.ok(cl.blockers.some((b: any) => b.ref === cu.custody_no));

    assert.equal((await reqEnv.post(`/api/custody/${cu.id}/lost`, { reason: "فقدت أثناء الرحلة" })).status, 403, "holder cannot declare loss");
    const ret = await reqEnv.post(`/api/custody/${cu.id}/return`, { reason: "انتهاء المهمة", condition: "good" });
    ok(ret, 201);
    assert.equal((await reqEnv.get(`/api/custody/${cu.id}`)).body.status, "return_pending");
    ok(await skR.post(`/api/returns/${ret.body.id}/receive`));
    assert.equal((await reqEnv.get(`/api/custody/${cu.id}`)).body.status, "returned");
    const free = (await pool.query("SELECT coalesce(sum(qty_free),0) AS f FROM v_pickable_stock WHERE item_id = $1", [it.id])).rows[0].f;
    assert.equal(Number(free), 1, "returned to stock is pending put-away (returns zone)") ;
  });

  test("custody transfer and loss (manager decision)", async () => {
    const it = await newItem({ itemType: "asset", trackSerial: true, standardCost: 900 });
    await receive(it.id, 1, { price: 900, serials: [`SN-${uniq()}`] });
    const m = await issue(reqEnv, "req.env", "custody", [{ itemId: it.id, qty: 1 }]);
    const cu = (await reqEnv.get("/api/custody?view=mine")).body.data.find((x: any) => x.mr_id === m.id);
    assert.equal((await reqEnv.post(`/api/custody/${cu.id}/transfer`, { toUserId: await id("req.mnt"), reason: "x" })).status, 403);
    ok(await skR.post(`/api/custody/${cu.id}/transfer`, { toUserId: await id("req.mnt"), reason: "انتقال المهمة" }));
    const reqMnt = await login("req.mnt");
    const t = (await reqMnt.get(`/api/custody/${cu.id}`)).body;
    assert.equal(t.holder_id, await id("req.mnt"));
    assert.equal(t.acknowledged_at, null, "new holder must acknowledge");
    ok(await wmR.post(`/api/custody/${cu.id}/lost`, { reason: "مفقودة بموجب محضر الواقعة" }));
    assert.equal((await reqMnt.get(`/api/custody/${cu.id}`)).body.status, "lost");
  });
});

describe("KPIs, reports, schedules", () => {
  test("KPI board with targets", async () => {
    const k = (await wmR.get("/api/kpis")).body.data;
    assert.equal(k.length, 9);
    for (const x of k) assert.ok(["good", "warn", "bad", "na"].includes(x.status));
    assert.ok(k.find((x: any) => x.key === "accuracy_pct").target === 98);
    assert.equal((await sup.get("/api/kpis")).status, 403);
  });

  test("reports render in the brand template; export rights enforced", async () => {
    const cat = (await wmR.get("/api/reports")).body.data.map((r: any) => r.code);
    assert.ok(cat.includes("stock-on-hand") && cat.includes("kpi-scorecard"));
    assert.ok(!(await planner.get("/api/reports")).body.data.some((r: any) => r.code === "journal"), "journal report needs finance / audit rights");
    assert.ok((await fin.get("/api/reports")).body.data.some((r: any) => r.code === "journal"));
    const x = await wmR.req("GET", "/api/reports/stock-on-hand/download?format=xlsx&lang=ar");
    assert.equal(x.status, 200);
    const raw = await app.inject({ method: "GET", url: "/api/reports/dead-stock/download?format=xlsx&lang=en", headers: { cookie: wmR.cookie } });
    assert.equal(raw.headers["content-type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.equal(raw.rawPayload.subarray(0, 2).toString(), "PK");
    const dm = await login("dm.env");
    assert.equal((await dm.req("GET", "/api/reports/requests/download?format=xlsx")).status, 403, "report.view only → no data export");
    assert.equal((await reqEnv.req("GET", "/api/reports/requests/download?format=pdf")).status, 403);
    assert.equal((await planner.req("GET", "/api/reports/journal/download?format=xlsx")).status, 403);
    const runs = (await wmR.get("/api/report-runs")).body.data;
    assert.ok(runs.some((r: any) => r.report_code === "stock-on-hand" && r.status === "ok"));
  });

  test("PDF export (Chromium) of the KPI scorecard", { skip: process.env.SKIP_PDF === "1" }, async () => {
    const r = await app.inject({ method: "GET", url: "/api/reports/kpi-scorecard/download?format=pdf&lang=ar", headers: { cookie: wmR.cookie } });
    if (r.statusCode === 501) return; // no Chromium on this host
    assert.equal(r.statusCode, 200, r.body.slice(0, 300));
    assert.equal(r.rawPayload.subarray(0, 4).toString(), "%PDF");
  });

  test("schedules: create, run now, recipients notified with a download link", async () => {
    const s = await wmR.post("/api/report-schedules", { name: `اختبار ${uniq()}`, reportCode: "expiry", format: "xlsx", frequency: "weekly", weekday: 2, hour: 7,
      recipientIds: [await id("sk.cleaning")] });
    ok(s, 201);
    assert.ok(new Date(s.body.next_run_at) > new Date());
    const run = await wmR.post(`/api/report-schedules/${s.body.id}/run`);
    ok(run);
    const n = (await skR.get("/api/notifications")).body.data.find((x: any) => x.kind === "report_ready" && x.link?.includes(run.body.attachment_id));
    assert.ok(n, "recipient notified");
    const file = await app.inject({ method: "GET", url: `/api/attachments/${run.body.attachment_id}/content`, headers: { cookie: skR.cookie } });
    assert.equal(file.statusCode, 200);
    assert.equal(file.rawPayload.subarray(0, 2).toString(), "PK");
    assert.equal((await reqEnv.post("/api/report-schedules", {})).status, 403);
  });
});

describe("integrations", () => {
  let erpKey = "", cmmsKey = "", hrKey = "";
  test("API keys: created once, scoped, logged", async () => {
    assert.equal((await wmR.post("/api/admin/integrations", { name: "x", system: "erp", scopes: ["erp.stock"] })).status, 403);
    const erp = await admin.post("/api/admin/integrations", { name: `ERP ${uniq()}`, system: "erp", scopes: ["erp.stock", "erp.journals", "erp.po"] });
    ok(erp, 201);
    erpKey = erp.body.apiKey;
    assert.match(erpKey, /^iwk_[0-9a-f]{8}_/);
    const list = (await admin.get("/api/admin/integrations")).body.clients;
    assert.ok(list.every((c: any) => !("key_hash" in c) && !("apiKey" in c)), "keys are never listed");
    cmmsKey = (await admin.post("/api/admin/integrations", { name: `CMMS ${uniq()}`, system: "cmms", scopes: ["cmms.mr"] })).body.apiKey;
    hrKey = (await admin.post("/api/admin/integrations", { name: `HR ${uniq()}`, system: "hr", scopes: ["hr.clearance"] })).body.apiKey;
    const call = (key: string | null, method: string, url: string, payload?: unknown) =>
      app.inject({ method: method as any, url, payload: payload as any, headers: key ? { "x-api-key": key } : {} });
    assert.equal((await call(null, "GET", "/api/integration/v1/ping")).statusCode, 401);
    assert.equal((await call("iwk_00000000_xxxxxxxxxxxxxxxxxxxxxxxx", "GET", "/api/integration/v1/ping")).statusCode, 401);
    assert.equal((await call(erpKey, "GET", "/api/integration/v1/ping")).statusCode, 200);
    assert.equal((await call(erpKey, "POST", "/api/integration/v1/cmms/material-requests", {})).statusCode, 403, "scope enforced");
    const stock = (await call(erpKey, "GET", "/api/integration/v1/stock?warehouseCode=CLN")).json();
    assert.ok(stock.data.length > 10);
    const logged = (await pool.query("SELECT count(*)::int AS n FROM integration_call WHERE path LIKE '/api/integration/v1/%'")).rows[0].n;
    assert.ok(logged >= 4);
  });

  test("ERP: purchase order in (idempotent), journals out and acknowledged", async () => {
    const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { "x-api-key": erpKey } });
    const poNo = `ERP-PO-${uniq()}`;
    const body = { poNo, etimadRef: "ETM-1", supplierCode: "SUP-001", warehouseCode: "CLN", lines: [{ itemCode: "CLPAP-00002", qty: 10, unitPrice: 12.5 }] };
    const r1 = await call("POST", "/api/integration/v1/purchase-orders", body);
    assert.equal(r1.statusCode, 201, r1.body);
    const r2 = await call("POST", "/api/integration/v1/purchase-orders", body);
    assert.equal(r2.json().idempotent, true);
    const po = (await pool.query("SELECT source, created_by FROM purchase_order WHERE po_no = $1", [poNo])).rows[0];
    assert.equal(po.source, "erp");
    // journals: generate + post one, ERP pulls and acknowledges
    await fin.post("/api/journals/generate");
    const draft = (await fin.get("/api/journals?status=draft")).body.data[0];
    if (draft) ok(await fin.post(`/api/journals/${draft.id}/post`));
    const jes = (await call("GET", "/api/integration/v1/journals?status=posted")).json().data;
    if (jes.length) {
      const j = jes[0];
      assert.ok(Math.abs(j.lines.reduce((s: number, l: any) => s + Number(l.debit) - Number(l.credit), 0)) < 0.005);
      assert.equal((await call("POST", `/api/integration/v1/journals/${j.je_no}/ack`, { erpRef: "SAP-4711" })).statusCode, 200);
      assert.equal((await call("POST", `/api/integration/v1/journals/${j.je_no}/ack`, { erpRef: "SAP-4711" })).json().idempotent, true);
    }
  });

  test("CMMS creates a work-order request in the requester's name; HR exit opens a clearance", async () => {
    const cm = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { "x-api-key": cmmsKey } });
    const wo = `WO-${uniq()}`;
    const emp = (await pool.query("SELECT employee_no FROM app_user WHERE username = 'req.mnt'")).rows[0].employee_no;
    const r = await cm("POST", "/api/integration/v1/cmms/material-requests", { workOrderRef: wo, requesterEmployeeNo: emp, warehouseCode: "CLN", lines: [{ itemCode: "CLPAP-00002", qty: 1 }] });
    assert.equal(r.statusCode, 201, r.body);
    const m = (await pool.query("SELECT request_type, requester_id, status FROM material_request WHERE work_order_ref = $1", [wo])).rows[0];
    assert.equal(m.request_type, "work_order");
    assert.equal(m.requester_id, await id("req.mnt"));
    assert.equal((await cm("POST", "/api/integration/v1/cmms/material-requests", { workOrderRef: wo, requesterEmployeeNo: emp, warehouseCode: "CLN", lines: [{ itemCode: "CLPAP-00002", qty: 1 }] })).json().idempotent, true);
    assert.equal((await cm("GET", `/api/integration/v1/cmms/material-requests/${wo}`)).json().work_order_ref, wo);

    const hr = await app.inject({ method: "POST", url: "/api/integration/v1/hr/exits", headers: { "x-api-key": hrKey },
      payload: { employeeNo: (await pool.query("SELECT employee_no FROM app_user WHERE username = 'irc2'")).rows[0].employee_no, reason: "retirement" } });
    assert.ok([201, 409].includes(hr.statusCode), hr.body);
    if (hr.statusCode === 201) assert.ok(["cleared", "blocked"].includes(hr.json().status));
  });
});

describe("portal, labels, alerts, health", () => {
  test("supplier sees only own deliveries and invoices", async () => {
    const d = (await sup.get("/api/portal/deliveries")).body.data;
    const own = (await pool.query("SELECT name_en FROM supplier WHERE id = (SELECT supplier_id FROM app_user WHERE username = 'supplier.rowad')")).rows[0].name_en;
    assert.ok(d.length > 0 && d.every((x: any) => x.supplier_en === own));
    ok(await sup.get("/api/portal/invoices"));
    assert.equal((await reqEnv.get("/api/portal/deliveries")).status, 403);
  });

  test("bin labels as ZPL", async () => {
    const r = await app.inject({ method: "GET", url: `/api/labels/bins.zpl?warehouseId=${L.wh("CLN")}&codes=CLN-STR-A01-R01-B01,CLN-STR-A01-R01-B02`, headers: { cookie: skR.cookie } });
    assert.equal(r.statusCode, 200);
    assert.equal((r.body.match(/\^XA/g) ?? []).length, 2);
    assert.match(r.body, /\^BC/);
  });

  test("alerts are de-duplicated per day and e-mailed (logged without SMTP)", async () => {
    const { runAlerts } = await import("../src/services/alerts.ts");
    const { dispatchEmails } = await import("../src/services/mailer.ts");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.user_id', (SELECT id::text FROM app_user WHERE username = 'system'), true)");
      await runAlerts(c);
      const second = await runAlerts(c);
      assert.equal(second.sent, 0, "same alerts are not repeated the same day");
      const out = await dispatchEmails(c, 1000);
      assert.equal(out.sent, 0);
      await c.query("COMMIT");
    } finally { c.release(); }
    const m = (await pool.query("SELECT html FROM email_outbox ORDER BY created_at DESC LIMIT 1")).rows[0];
    assert.match(m.html, /هيئة تطوير محمية الإمام عبدالعزيز بن محمد الملكية/);
  });

  test("readiness and integrity", async () => {
    const r = await app.inject({ method: "GET", url: "/api/ready" });
    assert.equal(r.statusCode, 200);
    const q = (await pool.query(`SELECT (SELECT coalesce(sum(qty),0) FROM stock_ledger) AS l, (SELECT coalesce(sum(qty_on_hand),0) FROM stock_balance) AS b,
      (SELECT coalesce(sum(value),0) FROM stock_ledger) AS lv, (SELECT coalesce(sum(total_value),0) FROM item_valuation) AS vv`)).rows[0];
    assert.equal(Number(q.l), Number(q.b));
    assert.equal(Number(q.lv), Number(q.vv));
    assert.equal(Object.values((await pool.query("SELECT * FROM audit_verify()")).rows[0])[1], null);
  });
});
