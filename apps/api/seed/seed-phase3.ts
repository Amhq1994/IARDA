// Phase 3 demo data, created through the real services (posting engine, DoA, SoD):
// DoA rules for transfers / adjustments / disposals / returns to vendor, ABC classes, transfers in every state,
// returns by condition, quarantine, RTV, count plans (cycle closed with variances, surprise in progress, annual draft),
// adjustments and disposals with committee minutes. Idempotent: skipped when transfer DoA rules exist.
import pg from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { encryptBlob, sha256 } from "../src/lib/crypto.ts";
import * as tr from "../src/services/transfers.ts";
import * as rt from "../src/services/returns.ts";
import * as cnt from "../src/services/counting.ts";
import { decideDoc } from "../src/services/approvals.ts";

type C = pg.Client;
async function as<T>(c: C, userId: string, fn: () => Promise<T>): Promise<T> {
  await c.query("BEGIN");
  try {
    await c.query("SELECT set_config('app.user_id', $1, true), set_config('app.request_id', 'seed:phase3', true)", [userId]);
    const r = await fn();
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  }
}

const MINUTES_PDF = Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 96>>stream
BT /F1 16 Tf 60 780 Td (IARDA - Count & Disposal Committee Minutes \\(demo\\)) Tj 0 -24 Td (Recommendation: dispose) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`);

async function attachMinutes(c: C, disposalId: string) {
  const digest = sha256(MINUTES_PDF);
  const key = `disposal/${digest.slice(0, 2)}/${digest}-${disposalId}.bin`;
  await mkdir(join(config.storageDir, "disposal", digest.slice(0, 2)), { recursive: true });
  await writeFile(join(config.storageDir, key), encryptBlob(MINUTES_PDF));
  await c.query(`INSERT INTO attachment (owner_type, owner_id, category, file_name, mime_type, size_bytes, sha256, storage_key)
                 VALUES ('disposal',$1,'minutes','محضر-لجنة-الإتلاف.pdf','application/pdf',$2,$3,$4)`, [disposalId, MINUTES_PDF.length, digest, key]);
}

export async function seedPhase3(databaseUrl = config.databaseUrl, log = console.log) {
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  const q = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows;
  try {
    if ((await q("SELECT count(*)::int AS n FROM doa_rule WHERE doc_type = 'TR'"))[0].n > 0) { log("seed: phase 3 data present — skipping"); return; }
    const U: Record<string, string> = Object.fromEntries((await q("SELECT username, id FROM app_user")).map((r) => [r.username, r.id]));
    const W: Record<string, string> = Object.fromEntries((await q("SELECT code, id FROM warehouse")).map((r) => [r.code, r.id]));
    const S: Record<string, string> = Object.fromEntries((await q("SELECT code, id FROM supplier")).map((r) => [r.code, r.id]));
    const sys = U.system;
    const cc = c as any;

    // ---------------------------------------------------------------- DoA matrix for phase 3 documents + settings + ABC
    await as(c, sys, async () => {
      const rules: [string, number, number, string, string | null, string | null, number, string, string][] = [
        ["TR", 1, 0, "warehouse_manager", null, null, 24, "مدير المستودع المصدر — جميع طلبات النقل", "Source warehouse manager — all transfers"],
        ["ADJ", 1, 0, "warehouse_manager", null, null, 24, "مدير المستودع — اعتماد فروقات الجرد والاستلام", "Warehouse manager — all adjustments"],
        ["ADJ", 2, 10000.01, "role", "FIN", null, 48, "المالية — فروقات أكثر من 10,000 ر.س", "Finance — adjustments above SAR 10,000"],
        ["DSP", 1, 0, "warehouse_manager", null, null, 48, "مدير المستودع — جميع محاضر الإتلاف", "Warehouse manager — all disposals"],
        ["DSP", 2, 0, "role", "FIN", null, 48, "المالية — جميع محاضر الإتلاف", "Finance — all disposals"],
        ["DSP", 3, 25000.01, "user", null, U.exec, 72, "المعتمد التنفيذي — إتلاف أكثر من 25,000 ر.س", "Executive approver — disposals above SAR 25,000"],
        ["RTV", 1, 0, "warehouse_manager", null, null, 24, "مدير المستودع — الإرجاع للمورد", "Warehouse manager — returns to vendor"],
      ];
      for (const [doc, level, min, kind, role, user, sla, ar, en] of rules) {
        await c.query(`INSERT INTO doa_rule (doc_type, level, min_value, approver_kind, approver_role, approver_user_id, sla_hours, description_ar, description_en)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [doc, level, min, kind, role, user, sla, ar, en]);
      }
      await c.query(`INSERT INTO setting (key, value, description_ar, description_en) VALUES ('count.tolerance_pct', '{"A":0,"B":2,"C":2}',
                     'نسبة التسامح في فروقات الجرد حسب فئة ABC', 'Count variance tolerance % by ABC class') ON CONFLICT (key) DO NOTHING`);
      await c.query("SELECT classify_abc()");
    });

    /** Free, untracked, available stock in a warehouse (largest first). */
    const freeStock = (wh: string, n: number, skip = 0) => q(`SELECT v.item_id, v.location_id, v.qty_free, v.id AS balance_id, i.item_code, v.full_code, l.barcode
        FROM v_pickable_stock v JOIN item i ON i.id = v.item_id JOIN location l ON l.id = v.location_id
       WHERE v.warehouse_id = $1 AND v.lot_id IS NULL AND v.qty_free >= 6 ORDER BY v.qty_free DESC, i.item_code OFFSET $2 LIMIT $3`, [W[wh], skip, n]);

    // ---------------------------------------------------------------- inter-warehouse transfers
    const mkTr = async (from: string, to: string, lines: { item_id: string; qty: number }[], reason: string) =>
      as(c, U.planner, () => tr.createTransfer(cc, U.planner, { fromWarehouseId: W[from], toWarehouseId: W[to], reason, lines: lines.map((l) => ({ itemId: l.item_id, qty: l.qty })) }));
    const wmOf: Record<string, string> = { CLN: U["wm.cons"], HSP: U["wm.cons"], AST: U["wm.assets"], SPR: U["wm.assets"], SCR: U["wm.assets"] };
        const approveTr = async (id: string, from: string) => {
      await as(c, U.planner, () => tr.submitTransfer(cc, U.planner, id));
      await as(c, wmOf[from], () => decideDoc(cc, wmOf[from], "TR", id, "approve"));
    };
    const cln = await freeStock("CLN", 12);
    const ast = await freeStock("AST", 4);
    // closed (fully received): cleaning materials for the hospitality kitchen
    const t1 = await mkTr("CLN", "HSP", [{ item_id: cln[0].item_id, qty: 4 }, { item_id: cln[1].item_id, qty: 3 }], "مواد تنظيف لمطبخ الضيافة");
    await approveTr(t1.id, "CLN");
    await as(c, U["sk.cleaning"], () => tr.shipTransfer(cc, U["sk.cleaning"], t1.id));
    await as(c, U["sk.hosp"], () => tr.receiveTransfer(cc, U["sk.hosp"], t1.id));
    // received with a shortfall → transit variance routed for approval (retired assets moved to the scrap store)
    const t2 = await mkTr("AST", "SCR", [{ item_id: (ast[0] ?? cln[2]).item_id, qty: 2 }], "نقل أصول مستبعدة إلى مستودع الهالك");
    await approveTr(t2.id, "AST");
    await as(c, U["sk.assets"], () => tr.shipTransfer(cc, U["sk.assets"], t2.id));
    const ship2 = (await q(`SELECT s.id, s.qty FROM transfer_shipment s JOIN transfer_line l ON l.id = s.transfer_line_id WHERE l.transfer_id = $1`, [t2.id]));
    const r2 = await as(c, U["ww.assets"], () => tr.receiveTransfer(cc, U["ww.assets"], t2.id, ship2.map((s, k) => ({ shipmentId: s.id, qty: k === 0 ? Number(s.qty) - 1 : Number(s.qty) }))));
    if (r2.adjustmentId) await as(c, U["sk.assets"], () => cnt.submitAdjustment(cc, U["sk.assets"], r2.adjustmentId!));
    // in transit
    const t3 = await mkTr("CLN", "HSP", [{ item_id: cln[3].item_id, qty: 2 }, { item_id: cln[4].item_id, qty: 2 }], "تزويد مستودع الضيافة بمواد التنظيف");
    await approveTr(t3.id, "CLN");
    await as(c, U["sk.cleaning"], () => tr.shipTransfer(cc, U["sk.cleaning"], t3.id));
    // approved, awaiting shipment; pending approval; draft
    const t4 = await mkTr("AST", "SCR", [{ item_id: (ast[1] ?? cln[5]).item_id, qty: 1 }], "أصل مستبعد بانتظار الإتلاف");
    await approveTr(t4.id, "AST");
    const t5 = await mkTr("CLN", "HSP", [{ item_id: cln[6].item_id, qty: 3 }], "احتياج تشغيلي لمستودع الضيافة");
    await as(c, U.planner, () => tr.submitTransfer(cc, U.planner, t5.id));
    await mkTr("HSP", "CLN", [{ item_id: cln[0].item_id, qty: 1 }], "إعادة فائض إلى مستودع النظافة");

    // ---------------------------------------------------------------- bin-to-bin moves
    const storageBins = await q(`SELECT l.full_code FROM location l JOIN location r ON r.id = l.parent_id JOIN location a ON a.id = r.parent_id JOIN location z ON z.id = a.parent_id
                                 WHERE l.warehouse_id = $1 AND l.level = 'bin' AND z.zone_type = 'storage' AND NOT l.is_blocked ORDER BY l.full_code DESC LIMIT 6`, [W.CLN]);
    let moves = 0;
    for (const [k, s] of cln.slice(7, 10).entries()) {
      for (const b of storageBins.slice(k * 2, k * 2 + 2)) {
        if (b.full_code === s.full_code) continue;
        try {
          await as(c, U["sk.cleaning"], () => tr.moveBin(cc, U["sk.cleaning"], { from: s.full_code, to: b.full_code, item: s.item_code, qty: 1, warehouseScope: "all" }));
          moves++; break;
        } catch { /* bin not suitable — try the next */ }
      }
    }

    // ---------------------------------------------------------------- returns to warehouse (by condition) + quarantine
    const mkRet = (user: string, wh: string, reason: string, lines: { item_id: string; qty: number; condition?: "good" | "quarantine" | "damaged" }[]) =>
      as(c, U[user], async () => {
        const org = (await q("SELECT org_unit_id FROM app_user WHERE id = $1", [U[user]]))[0].org_unit_id;
        return rt.createReturn(cc, { id: U[user], orgUnitId: org }, { warehouseId: W[wh], reason, lines: lines.map((l) => ({ itemId: l.item_id, qty: l.qty, condition: l.condition })) });
      });
    const rr = await freeStock("CLN", 4, 12);
    const ret1 = await mkRet("req.env", "CLN", "انتهاء أعمال التعقيم — مواد غير مستخدمة", [{ item_id: rr[0].item_id, qty: 2, condition: "good" }, { item_id: rr[1].item_id, qty: 1, condition: "good" }]);
    await as(c, U["sk.cleaning"], () => rt.receiveReturn(cc, U["sk.cleaning"], ret1.id, []));
    const ret2 = await mkRet("req.mnt", "CLN", "أصناف مشكوك في جودتها بعد الاستخدام", [{ item_id: rr[2].item_id, qty: 3, condition: "quarantine" }, { item_id: rr[3].item_id, qty: 2, condition: "damaged" }]);
    await as(c, U["sk.cleaning"], () => rt.receiveReturn(cc, U["sk.cleaning"], ret2.id, []));
    const ret3 = await mkRet("req.it", "CLN", "فائض مواد تنظيف بعد إغلاق المشروع", [{ item_id: rr[0].item_id, qty: 1 }]);
    void ret3; // awaiting inspection by the storekeeper
    // WM releases part of the quarantine back to available
    const qBal = (await q(`SELECT id FROM stock_balance WHERE warehouse_id = $1 AND item_id = $2 AND stock_status = 'quarantine' AND qty_on_hand > 0`, [W.CLN, rr[2].item_id]))[0];
    await as(c, U["wm.cons"], () => rt.changeStatus(cc, U["wm.cons"], qBal.id, 1, "available", "سليمة بعد الفحص الفني"));

    // ---------------------------------------------------------------- returns to vendor
    const dmgBal = (await q(`SELECT id FROM stock_balance WHERE warehouse_id = $1 AND item_id = $2 AND stock_status = 'damaged' AND qty_on_hand > 0`, [W.CLN, rr[3].item_id]))[0];
    const rtv1 = await as(c, U["sk.cleaning"], () => rt.createRtv(cc, U["sk.cleaning"], { warehouseId: W.CLN, supplierId: S["SUP-001"], reason: "عيب مصنعي — ضمن فترة الضمان", lines: [{ balanceId: dmgBal.id, qty: 1 }] }));
    await as(c, U["sk.cleaning"], () => rt.submitRtv(cc, U["sk.cleaning"], rtv1.id));
    await as(c, U["wm.cons"], () => decideDoc(cc, U["wm.cons"], "RTV", rtv1.id, "approve"));
    await as(c, U["sk.cleaning"], () => rt.shipRtv(cc, U["sk.cleaning"], rtv1.id));
    await as(c, U.proc, () => rt.closeRtv(cc, U.proc, rtv1.id, "CN-2026-0418"));
    const qBal2 = (await q(`SELECT id FROM stock_balance WHERE warehouse_id = $1 AND item_id = $2 AND stock_status = 'quarantine' AND qty_on_hand > 0`, [W.CLN, rr[2].item_id]))[0];
    const rtv2 = await as(c, U["sk.cleaning"], () => rt.createRtv(cc, U["sk.cleaning"], { warehouseId: W.CLN, supplierId: S["SUP-002"], reason: "عدم مطابقة المواصفات بعد الفحص", lines: [{ balanceId: qBal2.id, qty: 1 }] }));
    await as(c, U["sk.cleaning"], () => rt.submitRtv(cc, U["sk.cleaning"], rtv2.id));

    // ---------------------------------------------------------------- counting
    // 1) cycle count (class A, cleaning) — counted, recounts by a different counter, variances → adjustment approved & posted
    const p1 = await as(c, U["wm.cons"], () => cnt.createPlan(cc, U["wm.cons"], { warehouseId: W.CLN, countType: "cycle", abcClasses: ["A"],
      counterIds: [U["ww.cleaning1"], U["ww.cleaning2"]], notes: "جرد دوري للفئة A — الربع الرابع" }));
    await as(c, U["wm.cons"], () => cnt.releasePlan(cc, U["wm.cons"], p1.id));
    const l1 = await q(`SELECT id, qty_snapshot FROM count_line WHERE plan_id = $1 ORDER BY id`, [p1.id]);
    for (const [k, l] of l1.entries()) {
      const sysQ = Number(l.qty_snapshot);
      const off = k === 1 ? -1 : k === 4 ? 1 : k === 7 ? -2 : 0;
      const counted = Math.max(0, sysQ + off);
      const counter = k % 2 ? U["ww.cleaning2"] : U["ww.cleaning1"];
      const other = k % 2 ? U["ww.cleaning1"] : U["ww.cleaning2"];
      const r = await as(c, counter, () => cnt.recordCount(cc, counter, l.id, counted, off ? "فرق عند العد" : undefined));
      if (r.status === "recount") await as(c, other, () => cnt.recordCount(cc, other, l.id, counted, "تأكيد الفرق بعد إعادة العد"));
    }
    const f1 = await as(c, U["wm.cons"], () => cnt.finishCount(cc, U["wm.cons"], p1.id));
    if (f1.adjustmentId) {
      // count reviewer (wm.cons) raised it → routed to the other warehouse manager (SoD fallback), Finance above SAR 10,000
      for (let guard = 0; guard < 4; guard++) {
        const t = (await q(`SELECT assignee_id FROM approval_task WHERE doc_type = 'ADJ' AND doc_id = $1 AND status = 'pending' LIMIT 1`, [f1.adjustmentId]))[0];
        if (!t) break;
        await as(c, t.assignee_id, () => cnt.decideAdjustment(cc, t.assignee_id, f1.adjustmentId!, "approve", "تمت مراجعة محضر الجرد"));
      }
      await as(c, U["sk.cleaning"], () => cnt.postAdjustment(cc, U["sk.cleaning"], f1.adjustmentId!));
    }
    // 2) surprise count (hospitality, blind) — in progress
    const p2 = await as(c, U["wm.cons"], () => cnt.createPlan(cc, U["wm.cons"], { warehouseId: W.HSP, countType: "surprise", sampleSize: 12,
      counterIds: [U["ww.hosp"], U.cdc1], notes: "جرد مفاجئ بتكليف من المراجعة الداخلية" }));
    await as(c, U["wm.cons"], () => cnt.releasePlan(cc, U["wm.cons"], p2.id));
    const l2 = await q(`SELECT id, qty_snapshot FROM count_line WHERE plan_id = $1 ORDER BY id LIMIT 5`, [p2.id]);
    for (const [k, l] of l2.entries()) {
      const qty = k === 2 ? Number(l.qty_snapshot) + 2 : Number(l.qty_snapshot);
      await as(c, U["ww.hosp"], () => cnt.recordCount(cc, U["ww.hosp"], l.id, qty));
    }
    // 3) annual count (SPR) — planned
    await as(c, U["wm.assets"], () => cnt.createPlan(cc, U["wm.assets"], { warehouseId: W.SPR, countType: "annual", counterIds: [U.cdc1, U.cdc2],
      scheduledFor: new Date(Date.now() + 20 * 86400e3).toISOString().slice(0, 10), notes: "الجرد السنوي لنهاية السنة المالية" }));

    // ---------------------------------------------------------------- disposals (committee minutes, SoD-5)
    const dmg = (await q(`SELECT id, qty_on_hand FROM stock_balance WHERE warehouse_id = $1 AND stock_status = 'damaged' AND qty_on_hand > 0 LIMIT 1`, [W.CLN]))[0];
    if (dmg) {
      const d1 = await as(c, U.cdc1, () => cnt.createDisposal(cc, U.cdc1, { warehouseId: W.CLN, method: "scrap", reason: "أصناف تالفة غير قابلة للإصلاح أو الإرجاع",
        committeeIds: [U.cdc2], lines: [{ balanceId: dmg.id, qty: Number(dmg.qty_on_hand) }] }));
      await as(c, U.cdc1, async () => { await attachMinutes(c, d1.id); await cnt.recommendDisposal(cc, U.cdc1, d1.id); });
      for (let guard = 0; guard < 4; guard++) {
        const t = (await q(`SELECT assignee_id FROM approval_task WHERE doc_type = 'DSP' AND doc_id = $1 AND status = 'pending' LIMIT 1`, [d1.id]))[0];
        if (!t) break;
        await as(c, t.assignee_id, () => cnt.decideDisposal(cc, t.assignee_id, d1.id, "approve", "معتمد وفق محضر اللجنة"));
      }
      await as(c, U["sk.cleaning"], () => cnt.postDisposal(cc, U["sk.cleaning"], d1.id));
    }
    // expired / near-expiry hospitality lot → disposal awaiting approval
    const exp = (await q(`SELECT b.id, b.qty_on_hand - b.qty_reserved AS q FROM stock_balance b JOIN stock_lot sl ON sl.id = b.lot_id
                          WHERE b.warehouse_id = $1 AND b.qty_on_hand - b.qty_reserved > 0 AND sl.expiry_date IS NOT NULL ORDER BY sl.expiry_date LIMIT 1`, [W.HSP]))[0];
    if (exp) {
      const d2 = await as(c, U.cdc2, () => cnt.createDisposal(cc, U.cdc2, { warehouseId: W.HSP, method: "scrap", reason: "دفعة قريبة الانتهاء/منتهية — إتلاف آمن",
        committeeIds: [U.cdc1], lines: [{ balanceId: exp.id, qty: Math.min(2, Number(exp.q)) }] }));
      await as(c, U.cdc2, async () => { await attachMinutes(c, d2.id); await cnt.recommendDisposal(cc, U.cdc2, d2.id); });
    }
    log(`seed: phase 3 — 6 transfers (closed, discrepancy, in transit, approved, pending, draft), ${moves} bin moves, 3 rejects, 2 RTV, 3 count plans with variance approval, 2 disposals`);
  } finally {
    await c.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedPhase3().catch((e) => { console.error(e); process.exit(1); });
}
