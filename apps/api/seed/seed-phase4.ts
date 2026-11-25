// Phase 4–5 demo data, through the real services:
// legacy consumption history (12 months) → planning run → applied policies → auto requisitions (one approved and converted to a PO);
// custody requests delivered with e-signature (acknowledged, returned); clearances (blocked / cleared);
// journals generated and posted (ERP outbox event); obsolescence provision; KPI history; report schedules; alerts & e-mails.
// Idempotent: skipped when purchase-requisition DoA rules exist.
import pg from "pg";
import { config } from "../src/config.ts";
import { as, signaturePng } from "./seed-phase2.ts";
import * as plan from "../src/services/planning.ts";
import * as val from "../src/services/valuation.ts";
import * as cus from "../src/services/custody.ts";
import * as mr from "../src/services/requests.ts";
import * as rt from "../src/services/returns.ts";
import { decideDoc } from "../src/services/approvals.ts";
import { runAlerts } from "../src/services/alerts.ts";
import { snapshotKpis, KPI_KEYS } from "../src/services/kpis.ts";
import { dispatchEmails } from "../src/services/mailer.ts";
import { dispatchOutbox } from "../src/services/integrations.ts";
import { nextRun } from "../src/services/reports.ts";

let seedN = 20260415;
const rnd = () => ((seedN = (seedN * 1103515245 + 12345) % 2147483648) / 2147483648);

export async function seedPhase4(databaseUrl = config.databaseUrl, log = console.log) {
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  const q = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows;
  const cc = c as any;
  try {
    if ((await q("SELECT count(*)::int AS n FROM doa_rule WHERE doc_type = 'PR'"))[0].n > 0) { log("seed: phase 4–5 data present — skipping"); return; }
    const U: Record<string, string> = Object.fromEntries((await q("SELECT username, id FROM app_user")).map((r) => [r.username, r.id]));
    const W: Record<string, string> = Object.fromEntries((await q("SELECT code, id FROM warehouse")).map((r) => [r.code, r.id]));
    const S: Record<string, string> = Object.fromEntries((await q("SELECT code, id FROM supplier")).map((r) => [r.code, r.id]));
    const sys = U.system;

    // ---------------------------------------------------------------- DoA for purchase requisitions
    await as(c, sys, async () => {
      await c.query(`INSERT INTO doa_rule (doc_type, level, min_value, approver_kind, approver_role, sla_hours, description_ar, description_en) VALUES
        ('PR', 1, 0, 'warehouse_manager', NULL, 48, 'مدير المستودع — جميع طلبات الشراء', 'Warehouse manager — all requisitions'),
        ('PR', 2, 100000.01, 'role', 'FIN', 72, 'المالية — طلبات شراء أكثر من 100,000 ر.س', 'Finance — requisitions above SAR 100,000')`);
    });

    // ---------------------------------------------------------------- legacy consumption history (12 months before go-live)
    const pols = await q(`SELECT p.item_id, p.warehouse_id, p.max_qty, p.reorder_point, i.standard_cost, i.abc_class, i.track_serial FROM item_warehouse_policy p
                          JOIN item i ON i.id = p.item_id WHERE p.deleted_at IS NULL AND i.status = 'active' AND i.item_type <> 'non_stock' ORDER BY i.item_code, p.warehouse_id`);
    const rows: [string, string, string, number, number][] = [];
    const month0 = new Date(); month0.setUTCDate(1);
    for (const p of pols) {
      const roll = rnd();
      const kind = roll < 0.72 ? "active" : roll < 0.86 ? "stopped" : "none";
      if (kind === "none") continue;
      const base = Math.max(1, Math.round(Number(p.max_qty ?? 10) * (p.track_serial ? 0.08 : 0.22) * (0.5 + rnd())));
      for (let m = 1; m <= 12; m++) {
        if (kind === "stopped" && m < 8) continue;   // consumption ended 8+ months ago → dead stock candidates
        const season = 1 + 0.25 * Math.sin((m / 12) * 2 * Math.PI);
        const qty = Math.max(0, Math.round(base * season * (0.6 + rnd() * 0.8)));
        if (!qty) continue;
        const d = new Date(Date.UTC(month0.getUTCFullYear(), month0.getUTCMonth() - m, 1));
        rows.push([p.item_id, p.warehouse_id, d.toISOString().slice(0, 10), qty, Math.round(qty * Number(p.standard_cost ?? 10) * 100) / 100]);
      }
    }
    await as(c, sys, () => c.query(`INSERT INTO consumption_history (item_id, warehouse_id, period, qty, value, source)
      SELECT * , 'legacy' FROM unnest($1::uuid[], $2::uuid[], $3::date[], $4::numeric[], $5::numeric[])`,
      [rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2]), rows.map((r) => r[3]), rows.map((r) => r[4])]));

    // ---------------------------------------------------------------- planning → policies → requisitions → PO
    const run = await as(c, U.planner, () => plan.runPlanning(cc, U.planner, null));
    await as(c, U.planner, () => plan.applyPlan(cc, U.planner, run.id));
    const pick = async (wh: string, n: number) => (await q(`SELECT id FROM planning_line WHERE run_id = $1 AND warehouse_id = $2 AND action = 'reorder' ORDER BY suggested_value DESC LIMIT $3`,
      [run.id, W[wh], n])).map((r) => r.id);
    const prs = await as(c, U.planner, async () => plan.prsFromRun(cc, U.planner, run.id, [...(await pick("CLN", 6)), ...(await pick("HSP", 4))]));
    for (const p of prs) {
      const pr = (await q("SELECT warehouse_id, estimated_value FROM purchase_requisition WHERE id = $1", [p.id]))[0];
      if (pr.warehouse_id !== W.CLN) continue;
      for (let i = 0; i < 3; i++) {
        const t = (await q("SELECT assignee_id FROM approval_task WHERE doc_type = 'PR' AND doc_id = $1 AND status = 'pending' LIMIT 1", [p.id]))[0];
        if (!t) break;
        await as(c, t.assignee_id, () => decideDoc(cc, t.assignee_id, "PR", p.id, "approve", "معتمد وفق خطة إعادة الطلب"));
      }
      await as(c, U.proc, () => plan.convertPr(cc, U.proc, p.id, { supplierId: S["SUP-005"], etimadRef: "ETM-2026-77310", expectedDate: new Date(Date.now() + 14 * 86400e3).toISOString().slice(0, 10) }));
    }
    const freeItem = (await q(`SELECT item_id FROM planning_line WHERE run_id = $1 AND warehouse_id = $2 AND action = 'ok' LIMIT 2`, [run.id, W.SPR]));
    if (freeItem.length) {
      await as(c, U.planner, () => plan.createPr(cc, U.planner, { warehouseId: W.SPR, notes: "احتياج مشروع صيانة المولدات والمكيفات (يدوي)", lines: freeItem.map((f) => ({ itemId: f.item_id, qty: 5 })) }));
    }
    // a second, later planning run (what the nightly job does) so the screen shows a fresh run after the PRs
    await as(c, U.planner, () => plan.runPlanning(cc, U.planner, null));

    // ---------------------------------------------------------------- custody (asset requests delivered with signature)
    const custodyFor = async (user: string, wh: string, itemCode: string, qty: number) => {
      const u = (await q("SELECT id, org_unit_id, name_ar FROM app_user WHERE username = $1", [user]))[0];
      const it = (await q("SELECT id FROM item WHERE item_code = $1", [itemCode]))[0];
      if (!it) return null;
      const free = Number((await q("SELECT coalesce(sum(qty_free), 0) AS f FROM v_pickable_stock WHERE item_id = $1 AND warehouse_id = $2", [it.id, W[wh]]))[0].f);
      if (free < qty) return null;
      const d = await as(c, u.id, () => mr.createDraft(cc, { id: u.id, orgUnitId: u.org_unit_id }, { requestType: "custody", warehouseId: W[wh], purpose: "عهدة شخصية لأداء المهام الميدانية",
        lines: [{ itemId: it.id, qty }] }));
      await as(c, u.id, () => mr.submit(cc, u.id, d.id, true));
      for (let i = 0; i < 4; i++) {
        const t = (await q("SELECT assignee_id FROM approval_task WHERE doc_type = 'MR' AND doc_id = $1 AND status = 'pending' LIMIT 1", [d.id]))[0];
        if (!t) break;
        await as(c, t.assignee_id, () => mr.decide(cc, t.assignee_id, d.id, "approve"));
      }
      await as(c, U["sk.assets"], () => mr.reserveStock(cc, U["sk.assets"], d.id));
      const pl = await as(c, U["sk.assets"], () => mr.releasePickList(cc, U["sk.assets"], d.id, U["ww.assets"]));
      const tasks = await q(`SELECT t.id, t.qty, l.full_code, i.item_code, sl.lot_no, sl.serial_no FROM pick_task t JOIN location l ON l.id = t.location_id
                             JOIN item i ON i.id = t.item_id LEFT JOIN stock_lot sl ON sl.id = t.lot_id WHERE t.pick_list_id = $1 ORDER BY t.seq`, [pl.id]);
      for (const t of tasks) await as(c, U["ww.assets"], () => mr.confirmPick(cc, U["ww.assets"], t.id, { location: t.full_code, item: t.item_code, lot: t.serial_no ?? t.lot_no, qty: Number(t.qty) }));
      await as(c, U["sk.assets"], () => mr.deliver(cc, U["sk.assets"], d.id, { receivedByUserId: u.id, receivedByName: u.name_ar, signaturePng: signaturePng(itemCode.charCodeAt(2)) }));
      return (await q("SELECT id FROM custody WHERE mr_id = $1 ORDER BY custody_no", [d.id])).map((r) => r.id);
    };
    const c1 = await custodyFor("req.it", "AST", "CPRNG-00004", 2) ?? [];
    const c2 = await custodyFor("req.env", "AST", "CPFLD-00004", 1) ?? [];
    const c3 = await custodyFor("req.mnt", "AST", "FRCHR-00002", 1) ?? [];
    if (c1[0]) await as(c, U["req.it"], () => cus.acknowledge(cc, U["req.it"], c1[0]));
    if (c3[0]) await as(c, U["req.mnt"], () => cus.acknowledge(cc, U["req.mnt"], c3[0]));
    if (c2[0]) {
      await as(c, U["req.env"], () => cus.acknowledge(cc, U["req.env"], c2[0]));
      const ret = await as(c, U["req.env"], () => cus.returnCustody(cc, U["req.env"], c2[0], { condition: "good", reason: "انتهاء المهمة الميدانية" }));
      await as(c, U["sk.assets"], () => rt.receiveReturn(cc, U["sk.assets"], ret.id, []));
    }
    // demo realism: give the seeded custody requests plausible approval / delivery durations (instant seeding reads as 0 h)
    await as(c, sys, () => c.query(`UPDATE material_request SET submitted_at = delivered_at - make_interval(hours => 8 + (abs(hashtext(mr_no)) % 28)),
      approved_at = delivered_at - make_interval(hours => 2 + (abs(hashtext(mr_no)) % 6)) WHERE request_type = 'custody' AND status = 'closed'`));
    // backdate issue times a little so the custody register looks lived-in
    await as(c, sys, () => c.query("UPDATE custody SET issued_at = issued_at - make_interval(days => 3 + (abs(hashtext(custody_no)) % 40))"));

    // ---------------------------------------------------------------- clearances
    await as(c, U["sk.assets"], () => cus.requestClearance(cc, U["sk.assets"], { employeeId: U["req.it"], reason: "transfer", notes: "انتقال إلى فرع الهيئة في حائل" }));
    await as(c, U["sk.assets"], () => cus.requestClearance(cc, U["sk.assets"], { employeeId: U.irc3, reason: "end_of_contract" }));

    // ---------------------------------------------------------------- journals, provision, ERP outbox
    const jes = await as(c, U.fin, () => val.generateJournals(cc, U.fin));
    if (jes[0]) await as(c, U.fin, () => val.postJournal(cc, U.fin, jes[0].id));
    await as(c, U.fin, () => val.runProvision(cc, U.fin));

    // ---------------------------------------------------------------- KPI history (6 months, trending toward today's actuals)
    await as(c, sys, () => snapshotKpis(cc));
    const today = Object.fromEntries((await q("SELECT kpi, value FROM kpi_snapshot WHERE snap_date = current_date AND warehouse_id IS NULL")).map((r) => [r.kpi, r.value == null ? null : Number(r.value)]));
    const start: Record<string, number> = { accuracy_pct: 93.5, fill_rate_pct: 88, cycle_time_h: 34, dock_to_stock_h: 58, dead_stock_pct: 16, critical_stockouts: 4,
      space_utilisation_pct: 68, turnover: 2.9, approvals_on_time_pct: 79 };
    const hist: [string, string, number][] = [];
    for (let m = 6; m >= 1; m--) {
      for (const day of [3, 17]) {
        const d = new Date(Date.UTC(month0.getUTCFullYear(), month0.getUTCMonth() - m, day)).toISOString().slice(0, 10);
        for (const k of KPI_KEYS) {
          const end = today[k] ?? start[k];
          const f = (6 - m + (day > 10 ? 0.5 : 0)) / 6;
          const v = start[k] + (end - start[k]) * f + (rnd() - 0.5) * Math.abs(end - start[k]) * 0.15;
          hist.push([d, k, k === "critical_stockouts" ? Math.max(0, Math.round(v)) : Math.round(v * 10) / 10]);
        }
      }
    }
    await as(c, sys, () => c.query(`INSERT INTO kpi_snapshot (snap_date, kpi, value) SELECT * FROM unnest($1::date[], $2::text[], $3::numeric[]) ON CONFLICT DO NOTHING`,
      [hist.map((h) => h[0]), hist.map((h) => h[1]), hist.map((h) => h[2])]));

    // ---------------------------------------------------------------- report schedules
    await as(c, U["wm.cons"], async () => {
      const ins = (name: string, code: string, format: string, frequency: string, extra: any, recipients: string[]) =>
        c.query(`INSERT INTO report_schedule (name, report_code, params, format, lang, frequency, weekday, monthday, hour, recipient_ids, next_run_at)
                 VALUES ($1,$2,'{}',$3,'ar',$4,$5,$6,7,$7,$8)`, [name, code, format, frequency, extra.weekday ?? null, extra.monthday ?? null, recipients,
          nextRun({ frequency, weekday: extra.weekday, monthday: extra.monthday, hour: 7 })]);
      await ins("بطاقة مؤشرات الأداء الأسبوعية", "kpi-scorecard", "pdf", "weekly", { weekday: 0 }, [U["wm.cons"], U["wm.assets"], U.exec]);
      await ins("تقرير التقييم الشهري للمالية", "valuation", "xlsx", "monthly", { monthday: 1 }, [U.fin]);
      await ins("تقرير الصلاحية اليومي", "expiry", "xlsx", "daily", {}, [U["sk.cleaning"], U["wm.cons"]]);
    });

    // ---------------------------------------------------------------- alerts → notifications → e-mail (logged without SMTP), outbox (stub without endpoints)
    await as(c, sys, () => runAlerts(cc));
    await as(c, sys, () => dispatchEmails(cc, 500));
    await as(c, sys, () => dispatchOutbox(cc, 500));
    const n = (await q(`SELECT (SELECT count(*) FROM consumption_history)::int AS hist, (SELECT count(*) FROM purchase_requisition)::int AS prs,
                               (SELECT count(*) FROM custody)::int AS custody, (SELECT count(*) FROM journal_entry)::int AS jes, (SELECT count(*) FROM email_outbox)::int AS mails`))[0];
    log(`seed: phase 4–5 — ${n.hist} consumption months, 2 planning runs, ${n.prs} requisitions (1 converted to PO), ${n.custody} custody records, 2 clearances, ${n.jes} journals, ${n.mails} e-mails`);
  } finally {
    await c.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedPhase4().catch((e) => { console.error(e); process.exit(1); });
}
