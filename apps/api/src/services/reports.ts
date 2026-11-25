// Report catalogue: each report gathers live WMS data and renders it through the IARDA report exporter
// (reports/src — brand template, Arabic RTL / English, PDF · Excel · PowerPoint, Hijri + Gregorian dates).
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { many, one } from "../db/pool.ts";
import { ApiError, E } from "../lib/errors.ts";
import type { AuthUser } from "../auth/context.ts";
import type { Permission } from "@iarda/shared";
import type { Tx } from "./common.ts";
import { deadStock } from "./planning.ts";
import { valuationSummary } from "./valuation.ts";
import { kpiBoard } from "./kpis.ts";

const require = createRequire(import.meta.url);
const exporter = require("../../../../reports/src/index.js") as {
  exportPdf: (spec: any, o: { lang: string; out: string }) => Promise<void>;
  exportXlsx: (spec: any, o: { lang: string; out: string }) => Promise<void>;
  exportPptx: (spec: any, o: { lang: string; out: string }) => Promise<void>;
};

type L = { ar: string; en: string };
const L = (ar: string, en: string): L => ({ ar, en });
type Scope = "all" | string[];
export type Format = "pdf" | "xlsx" | "pptx";

interface ReportDef {
  code: string; title: L; description: L; perms: Permission[]; params: ("warehouseId" | "planId" | "runId" | "period" | "days")[];
  build: (c: Tx, p: Record<string, any>, scope: Scope) => Promise<{ subtitle?: L; sections: any[]; classification?: string }>;
}

const whF = (scope: Scope, col: string, args: unknown[], wh?: string) => {
  let f = "";
  if (wh) { args.push(wh); f += ` AND ${col} = $${args.length}`; }
  if (scope !== "all") { args.push(scope); f += ` AND ${col} = ANY($${args.length})`; }
  return f;
};
const col = (key: string, ar: string, en: string, extra: Record<string, unknown> = {}) => ({ key, label: L(ar, en), ...extra });
const num = (x: unknown) => (x == null ? 0 : Number(x));
const name = (r: any) => L(r.name_ar, r.name_en);

export const REPORTS: ReportDef[] = [
  {
    code: "stock-on-hand", title: L("تقرير المخزون المتوفر", "Stock on hand"), description: L("الأرصدة والقيم حسب المستودع والفئة", "Balances and values by warehouse and category"),
    perms: ["report.view"], params: ["warehouseId"],
    async build(c, p, scope) {
      const a: unknown[] = [];
      const f = whF(scope, "v.warehouse_id", a, p.warehouseId);
      const rows = await many(c, `SELECT i.item_code, i.name_ar, i.name_en, i.abc_class, w.code AS wh, v.qty, v.avg_cost, v.total_value, g.name_ar AS cat_ar, g.name_en AS cat_en
        FROM item_valuation v JOIN item i ON i.id = v.item_id JOIN warehouse w ON w.id = v.warehouse_id JOIN item_category gr ON gr.id = i.group_id JOIN item_category g ON g.id = gr.parent_id
        WHERE v.qty > 0 ${f} ORDER BY v.total_value DESC`, a);
      const byCat = new Map<string, { l: L; v: number }>();
      for (const r of rows) { const k = r.cat_en; const x = byCat.get(k) ?? { l: L(r.cat_ar, r.cat_en), v: 0 }; x.v += num(r.total_value); byCat.set(k, x); }
      const cats = [...byCat.values()].sort((x, y) => y.v - x.v).slice(0, 7);
      const total = rows.reduce((s, r) => s + num(r.total_value), 0);
      return { sections: [
        { type: "kpis", title: L("المؤشرات الرئيسية", "Key figures"), icon: "chart", items: [
          { label: L("أصناف متوفرة", "Items in stock"), value: new Set(rows.map((r) => r.item_code)).size, icon: "table" },
          { label: L("قيمة المخزون (ر.س)", "Stock value (SAR)"), value: Math.round(total), icon: "chart" },
          { label: L("أرصدة (صنف × مستودع)", "Item × warehouse balances"), value: rows.length, icon: "map" }] },
        { type: "chart", title: L("قيمة المخزون حسب الفئة", "Stock value by category"), icon: "chart", chart: "bar", categories: cats.map((x) => x.l),
          series: [{ name: L("القيمة", "Value"), values: cats.map((x) => Math.round(x.v)) }] },
        { type: "table", title: L("الأرصدة حسب الصنف", "Balances by item"), icon: "table", totals: true,
          columns: [col("code", "الرمز", "Code"), col("name", "الصنف", "Item", { width: 3 }), col("wh", "المستودع", "Warehouse"), col("abc", "ABC", "ABC", { sum: false }),
            col("qty", "الكمية", "Qty"), col("cost", "متوسط التكلفة", "Avg cost", { format: "currency", sum: false }), col("value", "القيمة", "Value", { format: "currency" })],
          rows: rows.slice(0, 1000).map((r) => ({ code: r.item_code, name: name(r), wh: r.wh, abc: r.abc_class ?? "—", qty: num(r.qty), cost: num(r.avg_cost), value: num(r.total_value) })) }] };
    },
  },
  {
    code: "valuation", title: L("تقرير تقييم المخزون والمطابقة", "Inventory valuation & reconciliation"), description: L("المتوسط المرجح مقابل FIFO والمطابقة مع الأستاذ العام", "WAVG vs FIFO and GL reconciliation"),
    perms: ["valuation.manage", "journal.manage", "audit.read"], params: [],
    async build(c, _p, scope) {
      const s = await valuationSummary(c, scope);
      const tw = s.warehouses.reduce((a, w) => a + w.wavg_value, 0), tf = s.warehouses.reduce((a, w) => a + w.fifo_value, 0);
      return { classification: "restricted", sections: [
        { type: "kpis", title: L("الملخص", "Summary"), icon: "chart", items: [
          { label: L("القيمة الدفترية (متوسط مرجح)", "Book value (WAVG)"), value: Math.round(tw), icon: "chart" },
          { label: L("القيمة حسب FIFO", "FIFO value"), value: Math.round(tf), icon: "table" },
          { label: L("مخصص التقادم", "Obsolescence provision"), value: Math.round(s.provision), icon: "shield" },
          { label: L("المطابقة", "Reconciliation"), value: s.reconciled ? L("مطابق", "Reconciled") : L("يوجد فرق", "Difference"), icon: "check" }] },
        { type: "table", title: L("التقييم حسب المستودع", "Valuation by warehouse"), icon: "table", totals: true,
          columns: [col("wh", "المستودع", "Warehouse", { width: 2 }), col("wavg", "متوسط مرجح", "WAVG", { format: "currency" }), col("fifo", "FIFO", "FIFO", { format: "currency" }),
            col("ledger", "سجل الحركات", "Ledger", { format: "currency" }), col("gl", "الأستاذ العام", "GL", { format: "currency" }), col("unj", "غير مرحّل للقيود", "Not journalised", { format: "currency" })],
          rows: s.warehouses.map((w) => ({ wh: L(`${w.code} — ${w.name_ar}`, `${w.code} — ${w.name_en}`), wavg: w.wavg_value, fifo: w.fifo_value, ledger: w.ledger_value, gl: w.gl_value, unj: w.unjournalised })) },
        { type: "chart", title: L("متوسط مرجح مقابل FIFO", "WAVG vs FIFO"), icon: "chart", chart: "bar", categories: s.warehouses.map((w) => L(w.code, w.code)),
          series: [{ name: L("متوسط مرجح", "WAVG"), values: s.warehouses.map((w) => Math.round(w.wavg_value)) }, { name: L("FIFO", "FIFO"), values: s.warehouses.map((w) => Math.round(w.fifo_value)) }] }] };
    },
  },
  {
    code: "count-sheet", title: L("ورقة الجرد", "Count sheet"), description: L("ورقة عد للطباعة (دون الرصيد الدفتري في الجرد الأعمى)", "Printable count sheet (no book qty for blind counts)"),
    perms: ["count.plan", "count.review"], params: ["planId"],
    async build(c, p) {
      const pl = await one(c, "SELECT cp.*, w.code AS wh FROM count_plan cp JOIN warehouse w ON w.id = cp.warehouse_id WHERE cp.id = $1", [p.planId]);
      if (!pl) throw E.notFound("count plan");
      const rows = await many(c, `SELECT loc.full_code, i.item_code, i.name_ar, i.name_en, u.code AS uom, sl.lot_no, sl.serial_no, l.qty_snapshot FROM count_line l
        JOIN item i ON i.id = l.item_id JOIN location loc ON loc.id = l.location_id JOIN uom u ON u.id = i.base_uom_id LEFT JOIN stock_lot sl ON sl.id = l.lot_id
        WHERE l.plan_id = $1 ORDER BY loc.pick_sequence, loc.full_code`, [p.planId]);
      const cols = [col("loc", "الموقع", "Location"), col("code", "الرمز", "Code"), col("name", "الصنف", "Item", { width: 3 }), col("lot", "الدفعة/التسلسلي", "Lot/serial"),
        col("uom", "الوحدة", "UoM"), ...(pl.blind ? [] : [col("book", "الرصيد الدفتري", "Book qty")]), col("count", "الكمية المعدودة", "Counted", { sum: false }), col("sign", "توقيع العاد", "Counter", { sum: false })];
      return { subtitle: L(`${pl.plan_no} · ${pl.wh}${pl.blind ? " · جرد أعمى" : ""}`, `${pl.plan_no} · ${pl.wh}${pl.blind ? " · blind" : ""}`), sections: [
        { type: "table", title: L("بنود الجرد", "Count lines"), icon: "table", columns: cols,
          rows: rows.map((r) => ({ loc: r.full_code, code: r.item_code, name: name(r), lot: r.serial_no ?? r.lot_no ?? "—", uom: r.uom, book: num(r.qty_snapshot), count: "", sign: "" })) }] };
    },
  },
  {
    code: "count-variance", title: L("تقرير فروقات الجرد", "Count variance report"), description: L("الفروقات وقيمتها والتسوية الناتجة", "Variances, values and resulting adjustment"),
    perms: ["count.review", "adjustment.approve", "audit.read"], params: ["planId"],
    async build(c, p) {
      const pl = await one(c, `SELECT cp.*, w.code AS wh, a.adj_no, a.status AS adj_status FROM count_plan cp JOIN warehouse w ON w.id = cp.warehouse_id
                               LEFT JOIN adjustment a ON a.count_plan_id = cp.id WHERE cp.id = $1`, [p.planId]);
      if (!pl) throw E.notFound("count plan");
      if (!["review", "closed"].includes(pl.status)) throw new ApiError(409, "count_not_finished", "لم يكتمل الجرد بعد", "The count is not finished yet");
      const rows = await many(c, `SELECT loc.full_code, i.item_code, i.name_ar, i.name_en, coalesce(l.qty_system2, l.qty_system1) AS book, l.qty_count1, l.qty_count2, l.final_qty,
          l.variance_qty, l.variance_value FROM count_line l JOIN item i ON i.id = l.item_id JOIN location loc ON loc.id = l.location_id WHERE l.plan_id = $1 ORDER BY abs(l.variance_value) DESC NULLS LAST`, [p.planId]);
      const v = rows.filter((r) => num(r.variance_qty) !== 0);
      return { subtitle: L(`${pl.plan_no} · ${pl.wh}`, `${pl.plan_no} · ${pl.wh}`), sections: [
        { type: "kpis", title: L("الملخص", "Summary"), icon: "chart", items: [
          { label: L("بنود مجرودة", "Lines counted"), value: rows.length, icon: "table" },
          { label: L("بنود بفروقات", "Lines with variance"), value: v.length, icon: "alert" },
          { label: L("صافي قيمة الفروقات (ر.س)", "Net variance (SAR)"), value: Math.round(v.reduce((s, r) => s + num(r.variance_value), 0) * 100) / 100, icon: "chart" },
          { label: L("دقة الجرد", "Count accuracy"), value: rows.length ? `${Math.round((1000 * (rows.length - v.length)) / rows.length) / 10}%` : "—", icon: "check" }] },
        { type: "table", title: L("البنود ذات الفروقات", "Lines with variances"), icon: "table", totals: true,
          columns: [col("loc", "الموقع", "Location"), col("code", "الرمز", "Code"), col("name", "الصنف", "Item", { width: 3 }), col("book", "الدفتري", "Book", { sum: false }),
            col("c1", "العد الأول", "1st count", { sum: false }), col("c2", "إعادة العد", "Recount", { sum: false }), col("var", "الفرق", "Variance"), col("val", "القيمة", "Value", { format: "currency" })],
          rows: v.map((r) => ({ loc: r.full_code, code: r.item_code, name: name(r), book: num(r.book), c1: num(r.qty_count1), c2: r.qty_count2 == null ? "—" : num(r.qty_count2),
            var: num(r.variance_qty), val: num(r.variance_value) })) },
        { type: "text", title: L("التسوية", "Adjustment"), icon: "report", paragraphs: [pl.adj_no
          ? L(`نتج عن الجرد طلب التسوية ${pl.adj_no} (الحالة: ${pl.adj_status}) ويُعتمد وفق مصفوفة الصلاحيات مع فصل المهام.`, `The count raised adjustment ${pl.adj_no} (status: ${pl.adj_status}), approved under the DoA with segregation of duties.`)
          : L("لم ينتج عن الجرد أي فروقات.", "The count produced no variances.")] }] };
    },
  },
  {
    code: "dead-stock", title: L("المخزون الراكد وبطيء الحركة", "Dead & slow-moving stock"), description: L("الأصناف دون صرف خلال المدة المحددة مع القيمة", "Items with no issue in the period, with value"),
    perms: ["planning.manage", "valuation.manage", "report.view"], params: ["warehouseId"],
    async build(c, p, scope) {
      const rows = await deadStock(c, scope, p.warehouseId);
      const dead = rows.filter((r) => r.class === "dead"), slow = rows.filter((r) => r.class === "slow");
      return { sections: [
        { type: "kpis", title: L("الملخص", "Summary"), icon: "chart", items: [
          { label: L("أصناف راكدة", "Dead items"), value: dead.length, icon: "alert" },
          { label: L("قيمة الراكد (ر.س)", "Dead stock value (SAR)"), value: Math.round(dead.reduce((s, r) => s + num(r.value), 0)), icon: "chart" },
          { label: L("بطيء الحركة", "Slow-moving"), value: slow.length, icon: "info" }] },
        { type: "table", title: L("التفاصيل", "Details"), icon: "table", totals: true,
          columns: [col("code", "الرمز", "Code"), col("name", "الصنف", "Item", { width: 3 }), col("wh", "المستودع", "Warehouse"), col("cls", "التصنيف", "Class", { sum: false }),
            col("days", "أيام دون صرف", "Idle days", { sum: false }), col("qty", "الكمية", "Qty"), col("value", "القيمة", "Value", { format: "currency" })],
          rows: rows.slice(0, 1000).map((r) => ({ code: r.item_code, name: name(r), wh: r.warehouse_code, cls: r.class === "dead" ? L("راكد", "Dead") : L("بطيء", "Slow"),
            days: num(r.idle_days), qty: num(r.qty), value: num(r.value) })) }] };
    },
  },
  {
    code: "reorder", title: L("اقتراحات إعادة الطلب", "Reorder suggestions"), description: L("من آخر تشغيل للتخطيط: نقطة إعادة الطلب والكمية الاقتصادية", "From the latest planning run: ROP and EOQ"),
    perms: ["planning.manage", "pr.create", "pr.approve"], params: ["runId"],
    async build(c, p, scope) {
      const run = p.runId ? await one(c, "SELECT * FROM planning_run WHERE id = $1", [p.runId]) : await one(c, "SELECT * FROM planning_run ORDER BY created_at DESC LIMIT 1");
      if (!run) throw new ApiError(409, "no_planning_run", "لا يوجد تشغيل للتخطيط بعد", "No planning run yet");
      const a: unknown[] = [run.id];
      const f = whF(scope, "l.warehouse_id", a);
      const rows = await many(c, `SELECT l.*, i.item_code, i.name_ar, i.name_en, w.code AS wh FROM planning_line l JOIN item i ON i.id = l.item_id JOIN warehouse w ON w.id = l.warehouse_id
        WHERE l.run_id = $1 AND l.action = 'reorder' ${f} ORDER BY l.suggested_value DESC`, a);
      return { subtitle: L(run.run_no, run.run_no), sections: [
        { type: "table", title: L("الأصناف المقترح طلبها", "Items to reorder"), icon: "table", totals: true,
          columns: [col("code", "الرمز", "Code"), col("name", "الصنف", "Item", { width: 3 }), col("wh", "المستودع", "Wh"), col("free", "المتاح", "Free", { sum: false }),
            col("oo", "تحت الطلب", "On order", { sum: false }), col("ss", "مخزون الأمان", "Safety", { sum: false }), col("rop", "نقطة الطلب", "ROP", { sum: false }),
            col("eoq", "EOQ", "EOQ", { sum: false }), col("qty", "المقترح", "Suggested", { sum: false }), col("val", "القيمة", "Value", { format: "currency" })],
          rows: rows.map((r) => ({ code: r.item_code, name: name(r), wh: r.wh, free: num(r.free_qty), oo: num(r.on_order), ss: num(r.safety_stock), rop: num(r.reorder_point),
            eoq: r.eoq == null ? "—" : num(r.eoq), qty: num(r.suggested_qty), val: num(r.suggested_value) })) }] };
    },
  },
  {
    code: "expiry", title: L("تقرير الصلاحية", "Expiry report"), description: L("الدفعات المنتهية والقريبة من الانتهاء", "Expired and near-expiry lots"),
    perms: ["report.view"], params: ["warehouseId", "days"],
    async build(c, p, scope) {
      const a: unknown[] = [Number(p.days ?? 90)];
      const f = whF(scope, "b.warehouse_id", a, p.warehouseId);
      const rows = await many(c, `SELECT i.item_code, i.name_ar, i.name_en, w.code AS wh, sl.lot_no, sl.serial_no, sl.expiry_date, sum(b.qty_on_hand) AS qty,
          round(sum(b.qty_on_hand) * max(coalesce(v.avg_cost, 0)), 2) AS value, (sl.expiry_date - current_date) AS days
        FROM stock_balance b JOIN stock_lot sl ON sl.id = b.lot_id JOIN item i ON i.id = b.item_id JOIN warehouse w ON w.id = b.warehouse_id
        LEFT JOIN item_valuation v ON v.item_id = b.item_id AND v.warehouse_id = b.warehouse_id
        WHERE b.qty_on_hand > 0 AND sl.expiry_date <= current_date + $1::int ${f} GROUP BY 1, 2, 3, 4, 5, 6, 7 ORDER BY sl.expiry_date`, a);
      return { subtitle: L(`خلال ${a[0]} يوماً`, `Within ${a[0]} days`), sections: [
        { type: "table", title: L("الدفعات", "Lots"), icon: "calendar", totals: true,
          columns: [col("code", "الرمز", "Code"), col("name", "الصنف", "Item", { width: 3 }), col("wh", "المستودع", "Wh"), col("lot", "الدفعة", "Lot"),
            col("exp", "تاريخ الانتهاء", "Expiry"), col("days", "الأيام المتبقية", "Days left", { sum: false }), col("qty", "الكمية", "Qty"), col("val", "القيمة", "Value", { format: "currency" })],
          rows: rows.map((r) => ({ code: r.item_code, name: name(r), wh: r.wh, lot: r.serial_no ?? r.lot_no, exp: new Date(r.expiry_date).toISOString().slice(0, 10), days: num(r.days),
            qty: num(r.qty), val: num(r.value), _highlight: num(r.days) <= 0 })) }] };
    },
  },
  {
    code: "requests", title: L("أداء طلبات المواد", "Material request performance"), description: L("الطلبات ومعدل التلبية وزمن الدورة حسب الإدارة (90 يوماً)", "Requests, fill rate and cycle time by department (90 days)"),
    perms: ["report.view"], params: ["warehouseId"],
    async build(c, p, scope) {
      const a: unknown[] = [];
      const f = whF(scope, "m.warehouse_id", a, p.warehouseId);
      const rows = await many(c, `SELECT o.name_ar, o.name_en, count(*)::int AS n, count(*) FILTER (WHERE m.status = 'closed')::int AS closed,
          round(100.0 * sum(l.issued) / nullif(sum(l.req), 0), 1) AS fill, round((extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY m.delivered_at - m.submitted_at)) / 3600)::numeric, 1) AS cycle,
          coalesce(sum(m.issued_value), 0) AS value
        FROM material_request m JOIN org_unit o ON o.id = m.org_unit_id
        LEFT JOIN LATERAL (SELECT sum(qty_issued) AS issued, sum(coalesce(qty_approved, qty_requested)) AS req FROM mr_line WHERE mr_id = m.id AND deleted_at IS NULL) l ON true
        WHERE m.created_at > now() - interval '90 days' ${f} GROUP BY o.id ORDER BY n DESC`, a);
      return { sections: [
        { type: "chart", title: L("عدد الطلبات حسب الإدارة", "Requests by department"), icon: "chart", chart: "bar", categories: rows.slice(0, 7).map(name),
          series: [{ name: L("الطلبات", "Requests"), values: rows.slice(0, 7).map((r) => r.n) }] },
        { type: "table", title: L("حسب الإدارة", "By department"), icon: "table", totals: true,
          columns: [col("org", "الإدارة", "Department", { width: 3 }), col("n", "الطلبات", "Requests"), col("closed", "المغلقة", "Closed"),
            col("fill", "معدل التلبية", "Fill rate", { sum: false }), col("cycle", "زمن الدورة (ساعة)", "Cycle time (h)", { sum: false }), col("value", "قيمة المصروف", "Issued value", { format: "currency" })],
          rows: rows.map((r) => ({ org: name(r), n: r.n, closed: r.closed, fill: r.fill == null ? "—" : `${r.fill}%`, cycle: r.cycle == null ? "—" : num(r.cycle), value: num(r.value) })) }] };
    },
  },
  {
    code: "journal", title: L("قيود المخزون المحاسبية", "Inventory journal"), description: L("القيود المولدة من حركات المخزون حسب الحساب", "Journal lines generated from stock movements by account"),
    perms: ["journal.manage", "valuation.manage", "audit.read"], params: ["period"],
    async build(c, p) {
      const period = p.period ?? new Date().toISOString().slice(0, 7);
      const rows = await many(c, `SELECT l.account_code, a.name_ar, a.name_en, sum(l.debit) AS dr, sum(l.credit) AS cr, string_agg(DISTINCT e.je_no, ', ') AS jes
        FROM journal_line l JOIN journal_entry e ON e.id = l.je_id JOIN gl_account a ON a.code = l.account_code WHERE e.period = $1 GROUP BY 1, 2, 3 ORDER BY 1`, [period]);
      return { classification: "restricted", subtitle: L(`الفترة ${period}`, `Period ${period}`), sections: [
        { type: "table", title: L("ميزان الحسابات", "Account summary"), icon: "table", totals: true,
          columns: [col("acc", "الحساب", "Account"), col("name", "الاسم", "Name", { width: 3 }), col("dr", "مدين", "Debit", { format: "currency" }), col("cr", "دائن", "Credit", { format: "currency" }), col("je", "القيود", "Entries", { sum: false })],
          rows: rows.map((r) => ({ acc: r.account_code, name: name(r), dr: num(r.dr), cr: num(r.cr), je: r.jes })) }] };
    },
  },
  {
    code: "custody", title: L("سجل العهد", "Custody register"), description: L("العهد القائمة حسب الموظف والإدارة", "Active custody by employee and department"),
    perms: ["custody.manage", "custody.approve", "audit.read"], params: [],
    async build(c) {
      const rows = await many(c, `SELECT cu.custody_no, i.item_code, i.name_ar, i.name_en, sl.serial_no, h.name_ar AS h_ar, h.name_en AS h_en, h.employee_no, o.name_ar AS o_ar, o.name_en AS o_en,
          cu.issued_at, cu.acknowledged_at, cu.value FROM custody cu JOIN item i ON i.id = cu.item_id JOIN app_user h ON h.id = cu.holder_id LEFT JOIN org_unit o ON o.id = cu.org_unit_id
          LEFT JOIN stock_lot sl ON sl.id = cu.lot_id WHERE cu.status IN ('active','return_pending') ORDER BY o.name_ar, h.name_ar`);
      return { classification: "restricted", sections: [
        { type: "table", title: L("العهد القائمة", "Active custody"), icon: "users", totals: true,
          columns: [col("no", "رقم العهدة", "Custody no."), col("holder", "الموظف", "Employee", { width: 2 }), col("org", "الإدارة", "Department", { width: 2 }), col("code", "الصنف", "Item"),
            col("name", "الوصف", "Description", { width: 2 }), col("sn", "الرقم التسلسلي", "Serial"), col("ack", "الإقرار", "Acknowledged", { sum: false }), col("value", "القيمة", "Value", { format: "currency" })],
          rows: rows.map((r) => ({ no: r.custody_no, holder: L(`${r.h_ar} (${r.employee_no ?? "—"})`, `${r.h_en} (${r.employee_no ?? "—"})`), org: L(r.o_ar ?? "—", r.o_en ?? "—"), code: r.item_code,
            name: name(r), sn: r.serial_no ?? "—", ack: r.acknowledged_at ? L("نعم", "Yes") : L("لا", "No"), value: num(r.value) })) }] };
    },
  },
  {
    code: "kpi-scorecard", title: L("بطاقة مؤشرات الأداء", "KPI scorecard"), description: L("المؤشرات الفعلية مقابل المستهدف مع الاتجاه", "Actual vs target with trend"),
    perms: ["report.view"], params: [],
    async build(c, _p, scope) {
      const board = await kpiBoard(c, scope);
      const st = { good: L("محقق", "On target"), warn: L("قريب", "Near"), bad: L("غير محقق", "Off target"), na: L("لا توجد بيانات", "No data") };
      const fmtT = (k: any) => (k.target == null ? "—" : Array.isArray(k.target) ? `${k.target[0]}–${k.target[1]}${k.unit}` : `${k.dir === "ge" ? "≥" : "≤"} ${k.target}${k.unit}`);
      const acc = board.find((k) => k.key === "accuracy_pct")!;
      const fill = board.find((k) => k.key === "fill_rate_pct")!;
      const months = [...new Set([...acc.trend, ...fill.trend].map((t) => t.month))].sort();
      return { sections: [
        { type: "kpis", title: L("أبرز المؤشرات", "Headline KPIs"), icon: "star", items: board.slice(0, 4).map((k) => ({ label: L(k.label_ar, k.label_en),
          value: k.value == null ? "—" : `${k.value}${k.unit}`, icon: k.status === "good" ? "check" : "alert" })) },
        { type: "table", title: L("المؤشرات مقابل المستهدف", "KPIs vs targets"), icon: "table",
          columns: [col("kpi", "المؤشر", "KPI", { width: 3 }), col("actual", "الفعلي", "Actual", { sum: false }), col("target", "المستهدف", "Target", { sum: false }), col("status", "الحالة", "Status", { sum: false })],
          rows: board.map((k) => ({ kpi: L(k.label_ar, k.label_en), actual: k.value == null ? "—" : `${k.value}${k.unit}`, target: fmtT(k), status: st[k.status], _highlight: k.status === "bad" })) },
        ...(months.length > 1 ? [{ type: "chart", title: L("الاتجاه الشهري", "Monthly trend"), icon: "chart", chart: "line", categories: months.map((m) => L(m, m)),
          series: [acc, fill].map((k) => ({ name: L(k.label_ar, k.label_en), values: months.map((m) => k.trend.find((t) => t.month === m)?.value ?? 0) })) }] : [])] };
    },
  },
];

export const reportDef = (code: string) => REPORTS.find((r) => r.code === code);
export const canRun = (u: AuthUser, r: ReportDef) => r.perms.some((p) => u.permissions.has(p));

/** Builds the spec and renders it; returns the file bytes. */
export async function renderReport(c: Tx, code: string, params: Record<string, any>, scope: Scope, format: Format, lang: "ar" | "en", by?: L) {
  const def = reportDef(code);
  if (!def) throw E.notFound("report");
  const body = await def.build(c, params, scope);
  const spec = { id: code, title: def.title, subtitle: body.subtitle ?? def.description, year: new Date().getFullYear(), classification: body.classification ?? "internal",
    generatedBy: by ?? L("نظام إدارة المستودعات", "Warehouse Management System"), sections: body.sections };
  const dir = await mkdtemp(join(tmpdir(), "iarda-report-"));
  const out = join(dir, `${code}.${format}`);
  try {
    const fn = format === "pdf" ? exporter.exportPdf : format === "pptx" ? exporter.exportPptx : exporter.exportXlsx;
    try { await fn(spec, { lang, out }); }
    catch (e: any) {
      if (format === "pdf" && /Playwright|chromium|Executable/i.test(String(e?.message))) {
        throw new ApiError(501, "pdf_unavailable", "تصدير PDF غير متاح على هذا الخادم (يتطلب Chromium) — استخدم Excel", "PDF export needs Chromium on the server — use Excel");
      }
      throw e;
    }
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const MIME: Record<Format, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Next run time (UTC) for a schedule expressed in Riyadh time (UTC+3, no DST). */
export function nextRun(s: { frequency: string; weekday?: number | null; monthday?: number | null; hour: number }, from = new Date()) {
  const riyadh = new Date(from.getTime() + 3 * 3600e3);
  const d = new Date(Date.UTC(riyadh.getUTCFullYear(), riyadh.getUTCMonth(), riyadh.getUTCDate(), s.hour, 0, 0));
  const ok = (x: Date) => (s.frequency === "daily" || (s.frequency === "weekly" && x.getUTCDay() === (s.weekday ?? 0))
    || (s.frequency === "monthly" && x.getUTCDate() === (s.monthday ?? 1))) && x.getTime() > riyadh.getTime();
  for (let i = 0; i < 400 && !ok(d); i++) d.setUTCDate(d.getUTCDate() + 1);
  return new Date(d.getTime() - 3 * 3600e3);
}
