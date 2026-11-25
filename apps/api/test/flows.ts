// Shared end-to-end flows for API tests (item creation, inbound receiving through the real API).
import assert from "node:assert/strict";
import { pool, login, lookups, uniq } from "./helpers.ts";

const L = await lookups();
const [mdo, wmN, proc, sk, irc1, irc2, ww] = await Promise.all(["mdo", "wm.assets", "proc", "sk.cleaning", "irc1", "irc2", "ww.cleaning1"].map((u) => login(u)));

// 1×1 PNG signature (valid header, enough bytes)
export const SIGNATURE = "data:image/png;base64," + Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(400, 7)]).toString("base64");
export const PDF = Buffer.from("%PDF-1.4\n% demo inspection report\n%%EOF");

export function multipart(fields: Record<string, string>, file: { name: string; type: string; data: Buffer }) {
  const b = "----iarda" + uniq();
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
}

/** Creates an active item (MDO creates, WM approves). */
export async function newItem(over: Record<string, unknown> = {}) {
  const it = (await mdo.post("/api/items", { nameAr: `صنف مرحلة ثانية ${uniq()} ${uniq()}`, nameEn: `Phase2 item ${uniq()}`, groupId: L.group("CLTOL"),
    itemType: "consumable", baseUomId: L.uom("EA"), unitWeightKg: 0.2, unitVolumeM3: 0.0005, standardCost: 10, acknowledgeDuplicates: true, ...over })).body;
  assert.equal((await mdo.post(`/api/items/${it.id}/submit`)).status, 200);
  assert.equal((await wmN.post(`/api/items/${it.id}/approve`)).status, 200);
  return it;
}

/** Runs the full inbound flow through the API and returns the receipt. */
export async function receive(itemId: string, qty: number, opts: { price?: number; lot?: string; expiry?: string; serials?: string[]; accept?: number; putaway?: boolean } = {}) {
  const po = (await proc.post("/api/purchase-orders", { supplierId: (await pool.query("SELECT id FROM supplier WHERE code = 'SUP-001'")).rows[0].id,
    warehouseId: L.wh("CLN"), etimadRef: `ETM-T-${uniq()}`, lines: [{ itemId, qty, unitPrice: opts.price ?? 10 }] })).body;
  const r = (await sk.post("/api/receipts", { poId: po.id })).body;
  const det = (await sk.get(`/api/receipts/${r.id}`)).body;
  const line = det.lines[0];
  const qc = await sk.post(`/api/receipts/${r.id}/quantity-check`, { lines: [{ lineId: line.id, qtyReceived: qty, lotNo: opts.lot, expiryDate: opts.expiry, serialNos: opts.serials }] });
  assert.equal(qc.status, 200, JSON.stringify(qc.body));
  assert.equal((await sk.post(`/api/receipts/${r.id}/inspection`, { memberIds: [(await id("irc1")), (await id("irc2"))], chairId: await id("irc1") })).status, 200);
  const mp = multipart({ ownerType: "receipt", ownerId: r.id, category: "inspection_report" }, { name: "report.pdf", type: "application/pdf", data: PDF });
  assert.equal((await irc1.req("POST", "/api/attachments", mp.body, { "content-type": mp.type })).status, 201);
  const acc = opts.accept ?? qty;
  assert.equal((await irc1.post(`/api/receipts/${r.id}/inspection/results`, { lines: [{ lineId: line.id, qtyAccepted: acc, rejectReason: acc < qty ? "تلف" : null }] })).status, 200);
  assert.equal((await irc1.post(`/api/receipts/${r.id}/inspection/sign`, { decision: "agree" })).status, 200);
  assert.equal((await irc2.post(`/api/receipts/${r.id}/inspection/sign`, { decision: "agree" })).status, 200);
  const grn = await sk.post(`/api/receipts/${r.id}/grn`);
  assert.equal(grn.status, 200, JSON.stringify(grn.body));
  if (opts.putaway !== false) {
    for (const t of (await sk.get(`/api/putaway-tasks?receiptId=${r.id}`)).body.data) {
      const done = await ww.post(`/api/putaway-tasks/${t.id}/complete`, { scannedLocation: t.suggested_code });
      assert.equal(done.status, 200, JSON.stringify(done.body));
    }
  }
  return { po, receipt: r, grn: grn.body };
}
const ids: Record<string, string> = {};
export async function id(username: string) {
  ids[username] ??= (await pool.query("SELECT id FROM app_user WHERE username = $1", [username])).rows[0].id;
  return ids[username];
}

