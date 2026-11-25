import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { app, pool, Client, login, lookups, uniq } from "./helpers.ts";

after(async () => { await app.close(); await pool.end(); });

const L = await lookups();
const newItem = (over: Record<string, unknown> = {}) => ({
  nameAr: `صنف اختبار ${uniq()} ${uniq()}`, nameEn: `Test item ${uniq()}`, groupId: L.group("OFDSK"),
  itemType: "consumable", baseUomId: L.uom("EA"), ...over,
});

describe("authentication & sessions", () => {
  test("login returns the user with role permissions", async () => {
    const c = new Client();
    const r = await c.post("/api/auth/login", { username: "mdo", password: "Iarda@2026!" });
    assert.equal(r.status, 200);
    assert.ok(r.body.user.permissions.includes("item.manage"));
    assert.ok(c.cookie.startsWith("wms_session="));
    assert.equal((await c.get("/api/auth/me")).status, 200);
  });

  test("wrong password → 401 and lockout after 5 failures → 423", async () => {
    const c = new Client();
    for (let i = 0; i < 5; i++) assert.equal((await c.post("/api/auth/login", { username: "ww.north", password: "nope" })).status, 401);
    const r = await c.post("/api/auth/login", { username: "ww.north", password: "Iarda@2026!" });
    assert.equal(r.status, 423);
    assert.equal(r.body.error.code, "account_locked");
    // admin unlocks
    const adm = await login("admin");
    const id = (await pool.query("SELECT id FROM app_user WHERE username = 'ww.north'")).rows[0].id;
    assert.equal((await adm.post(`/api/users/${id}/unlock`)).status, 200);
    assert.equal((await c.post("/api/auth/login", { username: "ww.north", password: "Iarda@2026!" })).status, 200);
  });

  test("unauthenticated → 401; state change without CSRF header → 403", async () => {
    assert.equal((await new Client().get("/api/items")).status, 401);
    const c = await login("mdo");
    const r = await c.req("POST", "/api/items", newItem(), { "x-requested-with": "" });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, "csrf");
  });

  test("logout revokes the session", async () => {
    const c = await login("planner");
    await c.post("/api/auth/logout");
    assert.equal((await c.get("/api/auth/me")).status, 401);
  });
});

describe("RBAC & segregation of duties", () => {
  test("permission matrix is enforced per role", async () => {
    const adm = await login("admin"), req = await login("req.env"), ww = await login("ww.riyadh1"), mdo = await login("mdo"), aud = await login("auditor");
    assert.equal((await adm.post("/api/items", newItem())).status, 403, "System Admin cannot create items");
    assert.equal((await ww.get("/api/users")).status, 403, "worker cannot list users");
    assert.equal((await mdo.get("/api/audit")).status, 403, "MDO has no audit access");
    assert.equal((await aud.get("/api/audit")).status, 200, "auditor reads the audit trail");
    const it = (await mdo.post("/api/items", newItem())).body;
    assert.equal((await req.patch(`/api/items/${it.id}`, { nameEn: "hack", version: it.version })).status, 403, "requester cannot edit items");
  });

  test("requesters create item *requests*; MDO creates drafts", async () => {
    const req = await login("req.mnt"), mdo = await login("mdo");
    assert.equal((await req.post("/api/items", newItem())).body.status, "requested");
    assert.equal((await mdo.post("/api/items", newItem())).body.status, "draft");
  });

  test("SoD-6: requester/creator/submitter cannot approve; another manager can", async () => {
    const wmR = await login("wm.riyadh"), wmN = await login("wm.north"), mdo = await login("mdo");
    const it = (await wmR.post("/api/items", newItem())).body;            // WM requests the item
    assert.equal((await mdo.post(`/api/items/${it.id}/submit`)).status, 200);
    const self = await wmR.post(`/api/items/${it.id}/approve`);
    assert.equal(self.status, 409);
    assert.equal(self.body.error.code, "segregation_of_duties");
    assert.equal((await mdo.post(`/api/items/${it.id}/approve`)).status, 403, "MDO lacks item.approve");
    const ok = await wmN.post(`/api/items/${it.id}/approve`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, "active");
  });

  test("invalid lifecycle transitions are refused", async () => {
    const mdo = await login("mdo");
    const it = (await mdo.post("/api/items", newItem())).body;
    const r = await mdo.post(`/api/items/${it.id}/unblock`);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "invalid_state");
  });

  test("System Admin cannot grant stock-transaction permissions to no-transaction roles", async () => {
    const adm = await login("admin");
    const r = await adm.put("/api/roles/AUD/permissions/receipt.execute", { granted: true });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "segregation_of_duties");
  });
});

describe("item master", () => {
  test("duplicate detection blocks near-identical names until acknowledged", async () => {
    const mdo = await login("mdo");
    const body = newItem({ nameAr: "ورق تصوير A4 80 جرام ابيض", groupId: L.group("OFPAP"), baseUomId: L.uom("REAM") });
    const r1 = await mdo.post("/api/items", body);
    assert.equal(r1.status, 409);
    assert.equal(r1.body.error.code, "possible_duplicates");
    assert.ok(r1.body.error.details.similar[0].score >= 0.6);
    const r2 = await mdo.post("/api/items", { ...body, acknowledgeDuplicates: true });
    assert.equal(r2.status, 201);
    assert.ok(Array.isArray(r2.body.duplicate_ack));
  });

  test("barcodes are unique across items", async () => {
    const mdo = await login("mdo");
    const code = `6280000${Date.now().toString().slice(-6)}`;
    assert.equal((await mdo.post("/api/items", newItem({ identifiers: [{ idType: "barcode", value: code }] }))).status, 201);
    const r = await mdo.post("/api/items", newItem({ identifiers: [{ idType: "barcode", value: code }] }));
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "identifier_exists");
  });

  test("item codes follow GROUP-00000 and are unique", async () => {
    const mdo = await login("mdo");
    const a = (await mdo.post("/api/items", newItem())).body, b = (await mdo.post("/api/items", newItem())).body;
    assert.match(a.item_code, /^OFDSK-\d{5}$/);
    assert.notEqual(a.item_code, b.item_code);
  });

  test("optimistic locking rejects stale updates", async () => {
    const mdo = await login("mdo");
    const it = (await mdo.post("/api/items", newItem())).body;
    assert.equal((await mdo.patch(`/api/items/${it.id}`, { nameEn: "First edit", version: it.version })).status, 200);
    const r = await mdo.patch(`/api/items/${it.id}`, { nameEn: "Stale edit", version: it.version });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "stale_version");
  });

  test("lookup by barcode, UoM conversion and policies", async () => {
    const mdo = await login("mdo"), pln = await login("planner");
    const bc = `628${Date.now().toString().slice(-10)}`;
    const it = (await mdo.post("/api/items", newItem({ identifiers: [{ idType: "barcode", value: bc }],
      conversions: [{ uomId: L.uom("BOX"), factorToBase: 12 }] }))).body;
    assert.equal((await mdo.get(`/api/items/lookup?code=${bc}`)).body.id, it.id);
    const pol = await pln.put(`/api/items/${it.id}/policies/${L.wh("RYD")}`, { minQty: 10, maxQty: 100, reorderPoint: 20, safetyStock: 5 });
    assert.equal(pol.status, 200);
    const bad = await pln.put(`/api/items/${it.id}/policies/${L.wh("RYD")}`, { minQty: 50, maxQty: 10 });
    assert.equal(bad.status, 422, "max < min violates a DB constraint");
    const detail = (await mdo.get(`/api/items/${it.id}`)).body;
    assert.equal(detail.conversions[0].factor_to_base, 12);
    assert.equal(detail.policies[0].reorder_point, 20);
  });
});

describe("audit trail & soft delete", () => {
  test("every change is recorded with actor, old and new values; chain verifies", async () => {
    const mdo = await login("mdo"), aud = await login("auditor");
    const it = (await mdo.post("/api/items", newItem())).body;
    await mdo.patch(`/api/items/${it.id}`, { nameEn: "Renamed for audit", version: it.version });
    const hist = (await aud.get(`/api/audit/record/item/${it.id}`)).body.data;
    const upd = hist.find((h: any) => h.action === "UPDATE" && h.changed_fields?.includes("name_en"));
    assert.ok(upd, "update recorded");
    assert.equal(upd.new_values.name_en, "Renamed for audit");
    assert.equal(upd.old_values.name_en, it.name_en);
    assert.equal(upd.actor_username, "mdo");
    const v = (await aud.get("/api/audit/verify")).body;
    assert.equal(v.intact, true);
  });

  test("passwords never reach the audit trail", async () => {
    const rows = (await pool.query(`SELECT new_values FROM audit_log WHERE table_name = 'app_user' AND new_values ? 'password_hash' LIMIT 5`)).rows;
    assert.ok(rows.length > 0);
    for (const r of rows) assert.equal(r.new_values.password_hash, "***");
  });

  test("the app role cannot delete rows or tamper with the audit log", async () => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    await assert.rejects(c.query("DELETE FROM item WHERE false"), /permission denied/);
    await assert.rejects(c.query("UPDATE audit_log SET action = 'X' WHERE false"), /permission denied/);
    await c.end();
  });

  test("only unapproved items can be soft-deleted; active items must be blocked instead", async () => {
    const mdo = await login("mdo");
    const active = (await pool.query("SELECT id FROM item WHERE status = 'active' LIMIT 1")).rows[0].id;
    assert.equal((await mdo.del(`/api/items/${active}`)).status, 409);
    const it = (await mdo.post("/api/items", newItem())).body;
    assert.equal((await mdo.del(`/api/items/${it.id}`)).status, 200);
    assert.equal((await mdo.get(`/api/items/${it.id}`)).status, 404);
    const row = (await pool.query("SELECT deleted_at FROM item WHERE id = $1", [it.id])).rows[0];
    assert.ok(row.deleted_at, "row still exists, flagged deleted");
  });
});

describe("warehouse structure & data scope", () => {
  test("storekeepers only see their own warehouse", async () => {
    const sk = await login("sk.riyadh");
    const list = (await sk.get("/api/warehouses")).body.data;
    assert.deepEqual(list.map((w: any) => w.code), ["RYD"]);
    const r = await sk.get(`/api/warehouses/${L.wh("NTH")}`);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, "out_of_scope");
  });

  test("bin generator builds Aisle > Rack > Bin under a zone, within scope only", async () => {
    const wmN = await login("wm.north"), wmR = await login("wm.riyadh");
    const zone = (await pool.query(`SELECT id FROM location WHERE full_code = 'NTH-RTN'`)).rows[0].id;
    // use a fresh aisle number so reruns do not collide
    const start = 10 + Math.floor(Math.random() * 80);
    const denied = await wmR.post(`/api/locations/${zone}/generate`, { aisles: 1, racksPerAisle: 1, binsPerRack: 1, startAisle: start });
    assert.equal(denied.status, 403);
    const r = await wmN.post(`/api/locations/${zone}/generate`, { aisles: 1, racksPerAisle: 2, binsPerRack: 3, startAisle: start });
    assert.equal(r.status, 201);
    assert.equal(r.body.bins, 6);
    const bin = (await wmN.get(`/api/locations/lookup?code=NTH-RTN-A${String(start).padStart(2, "0")}-R02-B03`)).body;
    assert.equal(bin.level, "bin");
  });

  test("hierarchy is enforced by the database (no bin directly under a zone)", async () => {
    const wm = await login("wm.riyadh");
    const zone = (await pool.query(`SELECT id FROM location WHERE full_code = 'RYD-QRN'`)).rows[0].id;
    const r = await wm.post("/api/locations", { warehouseId: L.wh("RYD"), parentId: zone, level: "bin", code: `X${uniq().slice(0, 4).toUpperCase()}` });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "location_hierarchy");
  });
});
