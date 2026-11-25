// Phase 2 demo data, created through the same domain services the API uses (so every
// quantity goes through the posting engine and every request through the workflow):
//   DoA matrix, executive approver, opening balances (lots, serials, near-expiry), POs/ASNs/receipts in
//   every stage, material requests in every state, an active delegation and an overdue escalation.
import pg from "pg";
import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { encryptBlob, sha256 } from "../src/lib/crypto.ts";
import { hashPassword } from "../src/auth/routes.ts";
import { post } from "../src/services/common.ts";
import { suggestBins } from "../src/services/putaway.ts";
import * as inbound from "../src/services/inbound.ts";
import * as mr from "../src/services/requests.ts";

type C = pg.Client;

// deterministic pseudo-random numbers so every reseed looks the same
let seedState = 20261125;
const rnd = () => ((seedState = (seedState * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const days = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

async function as<T>(c: C, userId: string, fn: () => Promise<T>): Promise<T> {
  await c.query("BEGIN");
  try {
    await c.query("SELECT set_config('app.user_id', $1, true), set_config('app.request_id', 'seed:phase2', true)", [userId]);
    const r = await fn();
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  }
}

/** Minimal PNG encoder for a hand-drawn-looking signature (demo e-signatures). */
function signaturePng(seed: number): string {
  const w = 240, h = 80;
  const px = Buffer.alloc((w * 4 + 1) * h, 0);
  for (let y = 0; y < h; y++) px[y * (w * 4 + 1)] = 0;
  const dot = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.round(x + dx), yy = Math.round(y + dy);
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const o = yy * (w * 4 + 1) + 1 + xx * 4;
      px[o] = 1; px[o + 1] = 79; px[o + 2] = 55; px[o + 3] = 255;
    }
  };
  for (let t = 0; t < 1; t += 0.0015) {
    const x = 20 + t * 200;
    const y = 40 + Math.sin(t * (9 + seed % 5)) * 18 * Math.cos(t * 3) + Math.sin(t * 31) * 4;
    dot(x, y);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, cr]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(px)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

const MINI_PDF = Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 88>>stream
BT /F1 16 Tf 60 780 Td (IARDA - Technical Inspection Report \\(demo\\)) Tj 0 -24 Td (Committee: accepted) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`);

async function attachReport(c: C, receiptId: string) {
  const digest = sha256(MINI_PDF);
  const key = `receipt/${digest.slice(0, 2)}/${digest}-${receiptId}.bin`;
  await mkdir(join(config.storageDir, "receipt", digest.slice(0, 2)), { recursive: true });
  await writeFile(join(config.storageDir, key), encryptBlob(MINI_PDF));
  await c.query(`INSERT INTO attachment (owner_type, owner_id, category, file_name, mime_type, size_bytes, sha256, storage_key)
                 VALUES ('receipt',$1,'inspection_report','محضر-الفحص.pdf','application/pdf',$2,$3,$4)`, [receiptId, MINI_PDF.length, digest, key]);
}

export async function seedPhase2(databaseUrl = config.databaseUrl, log = console.log) {
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  const q = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows;
  try {
    if ((await q("SELECT count(*)::int AS n FROM doa_rule"))[0].n > 0) { log("seed: phase 2 data present — skipping"); return; }
    const U: Record<string, string> = Object.fromEntries((await q("SELECT username, id FROM app_user")).map((r) => [r.username, r.id]));
    const W: Record<string, string> = Object.fromEntries((await q("SELECT code, id FROM warehouse")).map((r) => [r.code, r.id]));
    const S: Record<string, string> = Object.fromEntries((await q("SELECT code, id FROM supplier")).map((r) => [r.code, r.id]));
    const sys = U.system;

    // ---------------------------------------------------------------- executive approver + DoA matrix + settings
    await as(c, sys, async () => {
      const exe = (await q("SELECT id FROM org_unit WHERE code = 'EXE'"))[0].id;
      const u = (await q(`INSERT INTO app_user (username, employee_no, name_ar, name_en, email, org_unit_id, position_ar, position_en, password_hash, password_changed_at)
        VALUES ('exec','E1100','م. عبدالمحسن بن سعد الفايز','Eng. Abdulmohsen S. Al-Fayez','exec@iarda.example.sa',$1,'نائب الرئيس التنفيذي للخدمات المشتركة','VP Shared Services',$2, now()) RETURNING id`,
        [exe, await hashPassword("Iarda@2026!")]))[0].id;
      U.exec = u;
      const dm = (await q("SELECT id FROM role WHERE code = 'DM'"))[0].id;
      await c.query("INSERT INTO user_role (user_id, role_id) VALUES ($1,$2)", [u, dm]);
      const std = ["issue", "work_order", "custody", "reservation"];
      const rules: [number, number, number | null, boolean, string, string | null, string | null, string[] | null, number, string, string][] = [
        [1, 0, null, false, "department_manager", null, null, std, 24, "مدير الإدارة — جميع القيم", "Department manager — any value"],
        [2, 5000.01, null, false, "warehouse_manager", null, null, std, 24, "مدير المستودع — أكثر من 5,000 ر.س", "Warehouse manager — above SAR 5,000"],
        [2, 0, null, true, "warehouse_manager", null, null, std, 24, "مدير المستودع — الأصناف الحرجة بأي قيمة", "Warehouse manager — critical categories, any value"],
        [3, 50000.01, null, false, "user", u, null, std, 48, "المعتمد التنفيذي — أكثر من 50,000 ر.س", "Executive approver — above SAR 50,000"],
        [1, 0, null, false, "department_manager", null, "URG", ["urgent"], 4, "طلب عاجل — مدير الإدارة أو مدير المستودع (أيهما أسبق)", "Urgent — department or warehouse manager (first to act)"],
        [1, 0, null, false, "warehouse_manager", null, "URG", ["urgent"], 4, "طلب عاجل — مدير الإدارة أو مدير المستودع (أيهما أسبق)", "Urgent — department or warehouse manager (first to act)"],
      ];
      for (const [level, min, max, crit, kind, user, group, types, sla, ar, en] of rules) {
        await c.query(`INSERT INTO doa_rule (doc_type, request_types, level, min_value, max_value, critical_only, approver_kind, approver_user_id, parallel_group, sla_hours, description_ar, description_en)
                       VALUES ('MR',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [types, level, min, max, crit, kind, user, group, sla, ar, en]);
      }
      await c.query(`INSERT INTO setting (key, value, description_ar, description_en) VALUES ('inspection.min_members', '2', 'الحد الأدنى لأعضاء لجنة الفحص', 'Minimum inspection committee members')
                     ON CONFLICT (key) DO NOTHING`);
    });

    // ---------------------------------------------------------------- opening balances (through the posting engine)
    const policies = await q(`SELECT p.item_id, p.warehouse_id, p.min_qty, p.max_qty, p.reorder_point, i.item_code, i.track_batch, i.track_serial, i.track_expiry,
                                     i.shelf_life_days, i.standard_cost, i.unit_weight_kg, i.unit_volume_m3, i.status, i.item_type, i.group_id, w.code AS wh
                                FROM item_warehouse_policy p JOIN item i ON i.id = p.item_id JOIN warehouse w ON w.id = p.warehouse_id
                               WHERE i.status = 'active' AND i.item_type <> 'non_stock' ORDER BY w.code, i.item_code`);
    let posts = 0, lotsN = 0;
    await as(c, sys, async () => {
      for (const p of policies) {
        const max = Number(p.max_qty ?? 20), rop = Number(p.reorder_point ?? 5);
        const roll = rnd();
        // ~8% out of stock, ~15% below reorder point, rest healthy
        let qty = roll < 0.08 ? 0 : roll < 0.23 ? Math.max(1, Math.floor(rop * 0.6)) : Math.round(rop + (max - rop) * (0.3 + rnd() * 0.6));
        if (p.track_serial) qty = Math.min(qty, 4);
        if (qty <= 0) continue;
        const cost = Number(p.standard_cost ?? 10) * (0.92 + rnd() * 0.16);
        const parts: { lotId: string | null; qty: number }[] = [];
        if (p.track_serial) {
          for (let k = 0; k < qty; k++) {
            const exp = p.track_expiry ? days(200 + Math.floor(rnd() * 500)) : null;
            const lot = (await q(`INSERT INTO stock_lot (item_id, serial_no, expiry_date, source_doc) VALUES ($1,$2,$3,'OPENING') RETURNING id`,
              [p.item_id, `SN-${p.item_code.replace(/-/g, "")}-${p.wh}-${String(k + 1).padStart(3, "0")}`, exp]))[0].id;
            parts.push({ lotId: lot, qty: 1 }); lotsN++;
          }
        } else if (p.track_batch) {
          const nLots = qty >= 6 ? 2 : 1;
          let left = qty;
          for (let k = 0; k < nLots; k++) {
            const part = k === nLots - 1 ? left : Math.ceil(qty * 0.4);
            left -= part;
            const shelf = Number(p.shelf_life_days ?? 365);
            // first lot sometimes close to expiry (for FEFO and expiry alerts)
            const exp = p.track_expiry ? days(k === 0 && rnd() < 0.35 ? 10 + Math.floor(rnd() * 40) : Math.floor(shelf * (0.4 + rnd() * 0.5))) : null;
            const lot = (await q(`INSERT INTO stock_lot (item_id, lot_no, mfg_date, expiry_date, source_doc) VALUES ($1,$2,$3,$4,'OPENING')
                                  ON CONFLICT (item_id, lot_no) WHERE serial_no IS NULL DO UPDATE SET source_doc = 'OPENING' RETURNING id`,
              [p.item_id, `L${(2600 + k * 7 + Math.floor(rnd() * 90)).toString()}-${p.wh}`, days(-60 - Math.floor(rnd() * 200)), exp]))[0].id;
            parts.push({ lotId: lot, qty: part }); lotsN++;
          }
        } else parts.push({ lotId: null, qty });
        for (const part of parts) {
          let remaining = part.qty;
          while (remaining > 0) {
            const perBin = Math.max(1, Math.floor(Math.min(
              Number(p.unit_weight_kg) > 0 ? 550 / Number(p.unit_weight_kg) : Infinity,
              Number(p.unit_volume_m3) > 0 ? 1.1 / Number(p.unit_volume_m3) : Infinity, remaining)));
            const chunk = Math.min(remaining, perBin);
            const bins = await suggestBins(c as any, { itemId: p.item_id, warehouseId: p.warehouse_id, qty: chunk, limit: 1 });
            if (!bins.length) { remaining = 0; break; }
            await post(c as any, { docType: "OPENING", docNo: "OB-1448", movement: "OPENING", itemId: p.item_id, locationId: bins[0].locationId,
              lotId: part.lotId, qty: chunk, unitCost: Math.round(cost * 100) / 100 });
            posts++; remaining -= chunk;
          }
        }
      }
    });
    log(`seed: opening balances — ${posts} postings, ${lotsN} lots/serials`);

    // ---------------------------------------------------------------- purchase orders, ASN, receipts in every stage
    const item = async (code: string) => (await q("SELECT id, base_uom_id, standard_cost FROM item WHERE item_code = $1", [code]))[0];
    const mkPo = (supplier: string, wh: string, etimad: string, lines: [string, number, number?][], expected = 5) => as(c, U.proc, async () => {
      const ls: { itemId: string; qty: number; unitPrice: number }[] = [];
      for (const [code, qty, price] of lines) { const it = await item(code); ls.push({ itemId: it.id, qty, unitPrice: price ?? Number(it.standard_cost) }); }
      return inbound.createPo(c as any, U.proc, { supplierId: S[supplier], warehouseId: W[wh], etimadRef: etimad, expectedDate: days(expected), source: "erp", lines: ls });
    });

    // 1) fully received, put away and invoiced (3-way matched)
    const po1 = await mkPo("SUP-001", "RYD", "ETM-1448-004512", [["OFPAP-00001", 120, 17.5], ["OFWRT-00001", 40, 11.5], ["OFDSK-00002", 60]], -12);
    const r1 = await as(c, U["sk.riyadh"], () => inbound.arrive(c as any, U["sk.riyadh"], { poId: po1.id, supplierDeliveryRef: "DN-88421" }));
    const r1Lines = await q("SELECT id, qty_expected FROM receipt_line WHERE receipt_id = $1", [r1.id]);
    await as(c, U["sk.riyadh"], () => inbound.quantityCheck(c as any, U["sk.riyadh"], r1.id, r1Lines.map((l) => ({ lineId: l.id, qtyReceived: Number(l.qty_expected) }))));
    await as(c, U["sk.riyadh"], () => inbound.startInspection(c as any, U["sk.riyadh"], r1.id, [U.irc1, U.irc2], U.irc1));
    await as(c, U.irc1, async () => { await attachReport(c, r1.id); await inbound.recordInspection(c as any, U.irc1, r1.id, r1Lines.map((l) => ({ lineId: l.id, qtyAccepted: Number(l.qty_expected) }))); });
    await as(c, U.irc1, () => inbound.signInspection(c as any, U.irc1, r1.id, "agree"));
    await as(c, U.irc2, () => inbound.signInspection(c as any, U.irc2, r1.id, "agree"));
    await as(c, U["sk.riyadh"], () => inbound.postGrn(c as any, U["sk.riyadh"], r1.id));
    for (const t of await q("SELECT id, suggested_location_id FROM putaway_task WHERE receipt_id = $1", [r1.id])) {
      const code = (await q("SELECT full_code FROM location WHERE id = $1", [t.suggested_location_id]))[0].full_code;
      await as(c, U["ww.riyadh1"], () => inbound.completePutaway(c as any, U["ww.riyadh1"], t.id, code));
    }
    const pl1 = await q("SELECT id, qty_received, unit_price FROM po_line WHERE po_id = $1 ORDER BY line_no", [po1.id]);
    await as(c, U.fin, () => inbound.createInvoice(c as any, U.fin, { poId: po1.id, invoiceNo: "INV-55120", invoiceDate: days(-2),
      lines: pl1.map((l) => ({ poLineId: l.id, qty: Number(l.qty_received), unitPrice: Number(l.unit_price) })) }));

    // 2) GRN posted, put-away pending (mobile demo) — veterinary batch items with expiry, partly rejected
    const po2 = await mkPo("SUP-008", "NTH", "ETM-1448-004633", [["VTMED-00001", 30], ["VTMED-00002", 25], ["VTSUP-00001", 20]], -3);
    const r2 = await as(c, U["sk.north"], () => inbound.arrive(c as any, U["sk.north"], { poId: po2.id }));
    const r2Lines = await q("SELECT rl.id, rl.qty_expected, i.item_code FROM receipt_line rl JOIN item i ON i.id = rl.item_id WHERE receipt_id = $1", [r2.id]);
    await as(c, U["sk.north"], () => inbound.quantityCheck(c as any, U["sk.north"], r2.id, r2Lines.map((l, k) => ({
      lineId: l.id, qtyReceived: Number(l.qty_expected), qtyDamaged: k === 1 ? 2 : 0, lotNo: `VB-${2611 + k}`, expiryDate: days(420 + k * 30), mfgDate: days(-30) }))));
    await as(c, U["sk.north"], () => inbound.startInspection(c as any, U["sk.north"], r2.id, [U.irc2, U.irc3], U.irc2));
    await as(c, U.irc2, async () => { await attachReport(c, r2.id); await inbound.recordInspection(c as any, U.irc2, r2.id, r2Lines.map((l, k) => ({
      lineId: l.id, qtyAccepted: Number(l.qty_expected) - (k === 1 ? 2 : 0), rejectReason: k === 1 ? "عبوات تالفة أثناء النقل" : null }))); });
    await as(c, U.irc2, () => inbound.signInspection(c as any, U.irc2, r2.id, "agree"));
    await as(c, U.irc3, () => inbound.signInspection(c as any, U.irc3, r2.id, "agree"));
    await as(c, U["sk.north"], () => inbound.postGrn(c as any, U["sk.north"], r2.id));

    // 3) in technical inspection (awaiting committee)
    const po3 = await mkPo("SUP-004", "RYD", "ETM-1448-004701", [["SFPPE-00002", 40], ["SFFIR-00001", 15], ["SFPPE-00006", 30]], 0);
    const r3 = await as(c, U["sk.riyadh"], () => inbound.arrive(c as any, U["sk.riyadh"], { poId: po3.id, supplierDeliveryRef: "SF-2231" }));
    const r3Lines = await q("SELECT rl.id, rl.qty_expected, i.item_code, i.track_serial, i.track_batch, i.track_expiry FROM receipt_line rl JOIN item i ON i.id = rl.item_id WHERE receipt_id = $1", [r3.id]);
    await as(c, U["sk.riyadh"], () => inbound.quantityCheck(c as any, U["sk.riyadh"], r3.id, r3Lines.map((l) => ({
      lineId: l.id, qtyReceived: Number(l.qty_expected),
      serialNos: l.track_serial ? Array.from({ length: Number(l.qty_expected) }, (_, k) => `FX-${70100 + k}`) : undefined,
      lotNo: l.track_batch ? "N95-2611" : undefined, expiryDate: l.track_expiry ? days(700) : undefined }))));
    await as(c, U["sk.riyadh"], () => inbound.startInspection(c as any, U["sk.riyadh"], r3.id, [U.irc1, U.irc3], U.irc1));

    // 4) arrived at the dock (quantity check pending), from a supplier-portal ASN
    const po4 = await mkPo("SUP-001", "RYD", "ETM-1448-004755", [["OFFIL-00001", 80], ["OFWRT-00002", 50], ["OFPAP-00005", 30]], 1);
    const pl4 = await q("SELECT id, qty_ordered FROM po_line WHERE po_id = $1 ORDER BY line_no", [po4.id]);
    const asn4 = await as(c, U["supplier.rowad"], () => inbound.createAsn(c as any, U["supplier.rowad"], { poId: po4.id, expectedAt: new Date().toISOString(),
      vehicleNo: "ر ح ط 4821", driverName: "سالم العتيبي", lines: pl4.map((l) => ({ poLineId: l.id, qty: Number(l.qty_ordered) })) }, S["SUP-001"]));
    await as(c, U["sk.riyadh"], () => inbound.arrive(c as any, U["sk.riyadh"], { asnId: asn4.id }));

    // 5) open POs with an ASN expected later (supplier portal) and one without ASN
    const po5 = await mkPo("SUP-001", "RYD", "ETM-1448-004790", [["OFPAP-00002", 40], ["OFDSK-00001", 25]], 4);
    const pl5 = await q("SELECT id, qty_ordered FROM po_line WHERE po_id = $1 ORDER BY line_no", [po5.id]);
    await as(c, U["supplier.rowad"], () => inbound.createAsn(c as any, U["supplier.rowad"], { poId: po5.id, expectedAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
      vehicleNo: "ب د ن 1177", lines: pl5.map((l) => ({ poLineId: l.id, qty: Number(l.qty_ordered) })) }, S["SUP-001"]));
    await mkPo("SUP-006", "NTH", "ETM-1448-004802", [["FDFED-00001", 200], ["FDFED-00003", 120]], 6);
    await mkPo("SUP-003", "SPR", "ETM-1448-004815", [["VHENG-00001", 24], ["VHBRK-00001", 10], ["VHTYR-00001", 8]], 9);
    log("seed: inbound — 7 POs, 2 ASNs, 4 receipts (put away & invoiced / put-away pending / in inspection / at dock)");

    // ---------------------------------------------------------------- material requests in every state
    const avail = async (code: string, wh: string) => (await q(
      `SELECT coalesce(sum(qty_free),0) AS q FROM v_pickable_stock s JOIN item i ON i.id = s.item_id WHERE i.item_code = $1 AND s.warehouse_id = $2`, [code, W[wh]]))[0].q;
    const lineFor = async (code: string, wh: string, want: number) => {
      const it = await item(code);
      const a = Number(await avail(code, wh));
      return a > 0 ? { itemId: it.id, qty: Math.max(1, Math.min(want, Math.floor(a * 0.5) || 1)) } : null;
    };
    const mkMr = async (user: string, wh: string, type: any, wants: [string, number][], extra: any = {}) => {
      const lines = (await Promise.all(wants.map(([code, n]) => lineFor(code, wh, n)))).filter(Boolean) as any[];
      if (!lines.length) {   // all wanted items happen to be out of stock → take an in-stock item of that warehouse
        const alt = (await q(`SELECT s.item_id, sum(s.qty_free) AS f FROM v_pickable_stock s JOIN item i ON i.id = s.item_id
                               WHERE s.warehouse_id = $1 AND i.item_type IN ('consumable','stock') GROUP BY s.item_id ORDER BY f DESC LIMIT 1`, [W[wh]]))[0];
        lines.push({ itemId: alt.item_id, qty: Math.max(1, Math.floor(Number(alt.f) * 0.2)) });
      }
      const u = (await q("SELECT id, org_unit_id FROM app_user WHERE username = $1", [user]))[0];
      return as(c, u.id, () => mr.createDraft(c as any, { id: u.id, orgUnitId: u.org_unit_id }, { requestType: type, warehouseId: W[wh], lines, ...extra }));
    };
    const submit = (user: string, id: string) => as(c, U[user], () => mr.submit(c as any, U[user], id, true));
    const decide = (user: string, id: string, action: any, comment?: string) => as(c, U[user], () => mr.decide(c as any, U[user], id, action, comment));
    const fulfilTo = async (id: string, keeper: string, picker: string, stage: "reserved" | "picking" | "ready" | "delivered", receiver?: string) => {
      await as(c, U[keeper], () => mr.reserveStock(c as any, U[keeper], id));
      if (stage === "reserved") return;
      const pl = await as(c, U[keeper], () => mr.releasePickList(c as any, U[keeper], id, U[picker]));
      if (stage === "picking") return;
      const tasks = await q(`SELECT t.id, t.qty, l.full_code, i.item_code, sl.lot_no, sl.serial_no FROM pick_task t JOIN location l ON l.id = t.location_id
                              JOIN item i ON i.id = t.item_id LEFT JOIN stock_lot sl ON sl.id = t.lot_id WHERE t.pick_list_id = $1 ORDER BY t.seq`, [pl.id]);
      for (const t of tasks) await as(c, U[picker], () => mr.confirmPick(c as any, U[picker], t.id, { location: t.full_code, item: t.item_code, lot: t.serial_no ?? t.lot_no, qty: Number(t.qty) }));
      if (stage === "ready") return;
      const rc = (await q("SELECT id, name_ar FROM app_user WHERE username = $1", [receiver]))[0];
      await as(c, U[keeper], () => mr.deliver(c as any, U[keeper], id, { receivedByUserId: rc.id, receivedByName: rc.name_ar, signaturePng: signaturePng(id.charCodeAt(0)) }));
    };

    // delegation: IT director on annual leave → Maintenance director approves IT requests
    await as(c, U["dm.it"], () => c.query(`INSERT INTO delegation (from_user_id, to_user_id, doc_types, valid_from, valid_to, reason)
      VALUES ($1,$2,'{MR}', now() - interval '1 day', now() + interval '6 days', 'إجازة سنوية')`, [U["dm.it"], U["dm.mnt"]]));

    let n = 0;
    // closed (fully delivered) — several, for history and KPIs
    for (const [user, wh, wants, keeper, picker] of [
      ["req.env", "NTH", [["SFPPE-00003", 6], ["CPRNG-00005", 2], ["CLPAP-00004", 4]], "sk.north", "ww.north"],
      ["req.mnt", "SPR", [["VHENG-00001", 2], ["FLOIL-00001", 8]], "sk.spare", "sk.spare"],
      ["req.it", "RYD", [["ITCMP-00005", 3], ["ITPRN-00004", 4]], "sk.riyadh", "ww.riyadh2"],
      ["req.env", "RYD", [["OFPAP-00001", 10], ["OFWRT-00001", 5]], "sk.riyadh", "ww.riyadh1"],
    ] as [string, string, [string, number][], string, string][]) {
      const m = await mkMr(user, wh, "issue", wants, { purpose: "احتياج تشغيلي شهري" });
      await submit(user, m.id);
      for (const t of await q("SELECT assignee_id FROM approval_task WHERE doc_id = $1 AND status = 'pending' ORDER BY level", [m.id])) {
        const un = Object.entries(U).find(([, v]) => v === t.assignee_id)![0];
        await decide(un, m.id, "approve");
      }
      for (let guard = 0; guard < 3; guard++) {
        const pend = await q("SELECT assignee_id FROM approval_task WHERE doc_id = $1 AND status = 'pending' ORDER BY level LIMIT 1", [m.id]);
        if (!pend.length) break;
        await decide(Object.entries(U).find(([, v]) => v === pend[0].assignee_id)![0], m.id, "approve");
      }
      await fulfilTo(m.id, keeper, picker, "delivered", user);
      n++;
    }
    // ready for delivery
    const mReady = await mkMr("req.env", "RYD", "issue", [["CLCHM-00002", 6], ["CLTOL-00004", 10]], { purpose: "تجهيز مخيم الرصد الميداني" });
    await submit("req.env", mReady.id); await decide("dm.env", mReady.id, "approve");
    await fulfilTo(mReady.id, "sk.riyadh", "ww.riyadh1", "ready");
    // picking (assigned to a worker — mobile demo)
    const mPick = await mkMr("req.mnt", "RYD", "work_order", [["ELLMP-00001", 20], ["ELACC-00005", 6], ["ELCBL-00001", 2]], { workOrderRef: "WO-1448-0791", purpose: "صيانة إنارة مبنى الإدارة" });
    await submit("req.mnt", mPick.id); await decide("dm.mnt", mPick.id, "approve");
    await fulfilTo(mPick.id, "sk.riyadh", "ww.riyadh1", "picking");
    // approved, awaiting reservation — IT request approved by the delegate (dm.mnt on behalf of dm.it)
    const mAppr = await mkMr("req.it", "RYD", "issue", [["ITCMP-00004", 4], ["ITCMP-00005", 4]], { purpose: "تجهيز موظفين جدد" });
    await submit("req.it", mAppr.id); await decide("dm.mnt", mAppr.id, "approve", "معتمد بالنيابة عن مدير تقنية المعلومات");
    // pending level 1 (department manager)
    const mL1 = await mkMr("req.env", "NTH", "issue", [["CPRNG-00005", 3], ["CPFLD-00002", 4]], { purpose: "جولات رقابية — الربع الرابع", neededBy: days(5) });
    await submit("req.env", mL1.id);
    // pending level 2 (critical category → warehouse manager), after department approval
    const mL2 = await mkMr("req.mnt", "SPR", "work_order", [["VHBRK-00001", 2], ["VHTYR-00003", 2]], { workOrderRef: "WO-1448-0802", purpose: "صيانة دورية لمركبات الدوريات" });
    await submit("req.mnt", mL2.id); await decide("dm.mnt", mL2.id, "approve");
    // urgent (first of DM / WM to act)
    const mUrg = await mkMr("req.env", "NTH", "urgent", [["SFFIR-00005", 4], ["SFFAK-00001", 2]],
      { justification: "حريق أعشاب قرب منطقة السناف ويتطلب تجهيز فرق الاستجابة فوراً", purpose: "استجابة طارئة" });
    await submit("req.env", mUrg.id);
    // overdue (SLA breached) → escalation
    const mLate = await mkMr("req.it", "RYD", "issue", [["ITNET-00002", 1], ["OFDSK-00005", 2]], { purpose: "تمديد شبكة مكتب الإدارة" });
    await submit("req.it", mLate.id);
    await as(c, sys, async () => {
      await c.query("UPDATE material_request SET sla_due_at = now() - interval '3 hours', submitted_at = now() - interval '27 hours' WHERE id = $1", [mLate.id]);
      await mr.slaSweep(c as any);
    });
    // returned for revision, rejected, draft
    const mRet = await mkMr("req.mnt", "NTH", "issue", [["FLFUL-00002", 10]], { purpose: "وقود مولدات" });
    await submit("req.mnt", mRet.id); await decide("dm.mnt", mRet.id, "return", "يرجى تحديد المولدات المستفيدة وأرقامها");
    const mRej = await mkMr("req.env", "RYD", "issue", [["FRCHR-00001", 2]], { purpose: "كراسي إضافية" });
    await submit("req.env", mRej.id); await decide("dm.env", mRej.id, "reject", "يتوفر أثاث فائض في المبنى، يرجى التنسيق مع الخدمات");
    await mkMr("req.it", "RYD", "custody", [["ITCMP-00001", 1]], { purpose: "عهدة حاسب محمول لموظف جديد" });
    // demo realism: spread seeded lifecycles over plausible durations (instant seeding would show 0 h KPIs)
    await as(c, sys, async () => {
      await c.query(`UPDATE material_request SET submitted_at = delivered_at - make_interval(hours => 6 + (abs(hashtext(mr_no)) % 30)),
                       approved_at = delivered_at - make_interval(hours => 3 + (abs(hashtext(mr_no)) % 6))
                     WHERE status = 'closed' AND delivered_at IS NOT NULL`);
      await c.query(`UPDATE receipt SET arrived_at = coalesce(putaway_completed_at, grn_posted_at, now()) - make_interval(hours => 20 + (abs(hashtext(receipt_no)) % 30))
                     WHERE status IN ('putaway_done','grn_posted')`);
    });
    log(`seed: requests — ${n} closed, 1 ready for delivery, 1 picking, 1 approved (delegate), 2 pending, 1 urgent, 1 overdue/escalated, 1 returned, 1 rejected, 1 draft`);
  } finally {
    await c.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedPhase2().catch((e) => { console.error(e); process.exit(1); });
}
