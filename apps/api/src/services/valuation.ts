// Valuation: weighted-average book value (maintained by the posting engine) with a FIFO comparison,
// obsolescence / expiry / damage provisions, and GL journals generated from the stock ledger.
//
// Journal rule, per ledger row with signed value v (positive = stock in):
//   inventory account (by stock status)  Dr v   /  offset account (by movement type)  Cr v      (reversed when v < 0)
// Internal movements (put-away, bin moves, status changes, transfers) use the clearing account 1390, which nets to zero
// across each pair, so Σ inventory accounts = Σ item_valuation.total_value at all times (reconciliation).
import { one, many } from "../db/pool.ts";
import { E, ApiError } from "../lib/errors.ts";
import { docEvent, nextDocNo, setting, type Tx } from "./common.ts";
import { deadStock } from "./planning.ts";
import { enqueue } from "./integrations.ts";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Journalises every not-yet-journalised ledger row posted before `upTo` — one draft entry per calendar month. */
export async function generateJournals(c: Tx, actorId: string, upTo?: string) {
  await c.query("SELECT pg_advisory_xact_lock(814210)"); // one generator at a time
  const rows = await many(c, `SELECT l.id, l.posted_at, to_char(l.posted_at AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM') AS period, l.movement_type, l.stock_status,
        l.value, l.warehouse_id, m.offset_account, m.use_cost_center, s.inventory_account, mr.org_unit_id
      FROM stock_ledger l
      LEFT JOIN journal_source j ON j.ledger_id = l.id
      LEFT JOIN movement_gl_map m ON m.movement_type = l.movement_type
      LEFT JOIN status_gl_map s ON s.stock_status = l.stock_status
      LEFT JOIN material_request mr ON l.doc_type = 'MR' AND mr.id = l.doc_id
     WHERE j.ledger_id IS NULL AND l.posted_at < coalesce($1::timestamptz, now())
     ORDER BY l.id`, [upTo ?? null]);
  const missing = rows.find((r) => !r.offset_account || !r.inventory_account);
  if (missing) throw new ApiError(409, "gl_mapping_missing", `لا يوجد ربط محاسبي للحركة ${missing.movement_type} / ${missing.stock_status}`,
    `No GL mapping for movement ${missing.movement_type} / status ${missing.stock_status}`);
  const periods = new Map<string, any[]>();
  for (const r of rows) periods.set(r.period, [...(periods.get(r.period) ?? []), r]);
  const out: any[] = [];
  for (const [period, rs] of [...periods].sort()) {
    const agg = new Map<string, { account: string; wh: string; ou: string | null; net: number }>();
    const bump = (account: string, wh: string, ou: string | null, v: number) => {
      const k = `${account}|${wh}|${ou ?? ""}`;
      const a = agg.get(k) ?? { account, wh, ou, net: 0 };
      a.net = r2(a.net + v);
      agg.set(k, a);
    };
    for (const r of rs) {
      const v = Number(r.value);
      if (v === 0) continue;
      bump(r.inventory_account, r.warehouse_id, null, v);
      bump(r.offset_account, r.warehouse_id, r.use_cost_center ? r.org_unit_id : null, -v);
    }
    const lines = [...agg.values()].filter((a) => a.net !== 0).sort((a, b) => a.account.localeCompare(b.account));
    const dr = r2(lines.filter((l) => l.net > 0).reduce((s, l) => s + l.net, 0));
    const cr = r2(-lines.filter((l) => l.net < 0).reduce((s, l) => s + l.net, 0));
    if (dr !== cr) throw new ApiError(500, "unbalanced_journal", "قيد غير متوازن", `Unbalanced journal for ${period}: ${dr} ≠ ${cr}`);
    const lastDay = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const je = await one(c, `INSERT INTO journal_entry (je_no, period, je_date, source, description, total_debit, total_credit, ledger_rows)
                             VALUES ($1,$2,$3,'ledger',$4,$5,$5,$6) RETURNING *`,
      [await nextDocNo(c, "JE"), period, lastDay < today ? lastDay : today, `قيود حركات المخزون ${period} / inventory movements ${period}`, dr, rs.length]);
    let n = 0;
    for (const l of lines) {
      await c.query(`INSERT INTO journal_line (je_id, line_no, account_code, warehouse_id, org_unit_id, debit, credit) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [je.id, ++n, l.account, l.wh, l.ou, l.net > 0 ? l.net : 0, l.net < 0 ? -l.net : 0]);
    }
    await c.query("INSERT INTO journal_source (ledger_id, je_id) SELECT unnest($1::bigint[]), $2", [rs.map((r) => r.id), je.id]);
    await docEvent(c, "JE", je.id, "created", { to: "draft", actorId, data: { rows: rs.length } });
    out.push({ id: je.id, je_no: je.je_no, period, total: dr, rows: rs.length });
  }
  return out;
}

/** Finance posts a draft journal (frozen afterwards by trigger). */
export async function postJournal(c: Tx, actorId: string, id: string) {
  const je = await one(c, "SELECT * FROM journal_entry WHERE id = $1 FOR UPDATE", [id]);
  if (!je) throw E.notFound("journal");
  if (je.status !== "draft") throw E.state(je.status, "post");
  await c.query("UPDATE journal_entry SET status = 'posted', posted_at = now(), posted_by = $2 WHERE id = $1", [id, actorId]);
  await docEvent(c, "JE", id, "posted", { from: "draft", to: "posted", actorId });
  const lines = await many(c, `SELECT l.account_code, w.code AS warehouse, o.code AS cost_center, l.debit, l.credit, l.memo FROM journal_line l
    LEFT JOIN warehouse w ON w.id = l.warehouse_id LEFT JOIN org_unit o ON o.id = l.org_unit_id WHERE l.je_id = $1 ORDER BY l.line_no`, [id]);
  await enqueue(c, "erp", "journal.posted", { type: "JE", id, no: je.je_no }, { jeNo: je.je_no, period: je.period, date: je.je_date, source: je.source,
    total: Number(je.total_debit), lines: lines.map((l) => ({ ...l, debit: Number(l.debit), credit: Number(l.credit) })) });
}

/** Marks a posted journal as transferred to the ERP (manually, or by the ERP integration acknowledging it). */
export async function markExported(c: Tx, actorId: string | null, id: string, erpRef: string) {
  const je = await one(c, "SELECT * FROM journal_entry WHERE id = $1 FOR UPDATE", [id]);
  if (!je) throw E.notFound("journal");
  if (je.status !== "posted") throw E.state(je.status, "export");
  await c.query("UPDATE journal_entry SET status = 'exported', exported_at = now(), erp_ref = $2 WHERE id = $1", [id, erpRef]);
  await docEvent(c, "JE", id, "exported", { from: "posted", to: "exported", actorId, comment: erpRef });
}

// ------------------------------------------------------------------ provisions
export async function runProvision(c: Tx, actorId: string, asOf?: string) {
  const rates = await setting<Record<string, number>>(c, "valuation.provision_rates", { expired: 1, damaged: 1, quarantine: 0.25, near_expiry: 0.5, dead_stock: 0.5, slow_moving: 0.1 });
  const date = asOf ?? new Date().toISOString().slice(0, 10);
  const lines: { item_id: string; warehouse_id: string; lot_id: string | null; category: string; qty: number; value: number }[] = [];
  const taken = new Set<string>();
  // lot-level categories first (most specific): expired, near expiry (≤ 90 days), damaged, quarantine
  for (const b of await many(c, `SELECT b.item_id, b.warehouse_id, b.lot_id, b.stock_status, b.qty_on_hand AS qty, round(b.qty_on_hand * coalesce(v.avg_cost, 0), 2) AS value,
        sl.expiry_date FROM stock_balance b LEFT JOIN stock_lot sl ON sl.id = b.lot_id LEFT JOIN item_valuation v ON v.item_id = b.item_id AND v.warehouse_id = b.warehouse_id
       WHERE b.qty_on_hand > 0 AND b.stock_status <> 'in_transit'
         AND (b.stock_status IN ('damaged','quarantine') OR sl.expiry_date <= $1::date + 90)`, [date])) {
    const cat = b.expiry_date && b.expiry_date <= new Date(date) ? "expired" : b.stock_status === "damaged" ? "damaged"
      : b.stock_status === "quarantine" ? "quarantine" : "near_expiry";
    lines.push({ item_id: b.item_id, warehouse_id: b.warehouse_id, lot_id: b.lot_id, category: cat, qty: Number(b.qty), value: Number(b.value) });
    taken.add(`${b.item_id}|${b.warehouse_id}`);
  }
  // item-level: dead / slow-moving stock not already provided for
  for (const d of await deadStock(c, "all")) {
    if (taken.has(`${d.item_id}|${d.warehouse_id}`)) continue;
    lines.push({ item_id: d.item_id, warehouse_id: d.warehouse_id, lot_id: null, category: d.class === "dead" ? "dead_stock" : "slow_moving", qty: Number(d.qty), value: Number(d.value) });
  }
  const required = r2(lines.reduce((s, l) => s + l.value * Number(rates[l.category] ?? 0), 0));
  const prev = Number((await one(c, `SELECT coalesce(sum(credit - debit), 0) AS b FROM journal_line l JOIN journal_entry e ON e.id = l.je_id
                                      WHERE l.account_code = '1319'`)).b);
  const delta = r2(required - prev);
  const run = await one(c, `INSERT INTO provision_run (run_no, as_of, rates, required, previous, delta) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [await nextDocNo(c, "PRV"), date, JSON.stringify(rates), required, prev, delta]);
  for (const l of lines) {
    const rate = Number(rates[l.category] ?? 0);
    await c.query(`INSERT INTO provision_line (run_id, item_id, warehouse_id, lot_id, category, qty, value, rate, provision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [run.id, l.item_id, l.warehouse_id, l.lot_id, l.category, l.qty, l.value, rate, r2(l.value * rate)]);
  }
  if (delta !== 0) {
    const je = await one(c, `INSERT INTO journal_entry (je_no, period, je_date, source, description, total_debit, total_credit) VALUES ($1,$2,$3,'provision',$4,$5,$5) RETURNING *`,
      [await nextDocNo(c, "JE"), date.slice(0, 7), date, `مخصص تقادم المخزون ${run.run_no} / inventory provision`, Math.abs(delta)]);
    // increase: Dr 5930 expense / Cr 1319 provision — release: the reverse
    await c.query(`INSERT INTO journal_line (je_id, line_no, account_code, debit, credit, memo) VALUES ($1,1,$2,$3,0,$5), ($1,2,$4,0,$3,$5)`,
      [je.id, delta > 0 ? "5930" : "1319", Math.abs(delta), delta > 0 ? "1319" : "5930", run.run_no]);
    await c.query("UPDATE provision_run SET je_id = $2 WHERE id = $1", [run.id, je.id]);
  }
  return { ...run, lines: lines.length, je: delta !== 0 };
}

// ------------------------------------------------------------------ valuation & reconciliation
export async function valuationSummary(c: Tx, scope: "all" | string[]) {
  const args = scope === "all" ? [] : [scope];
  const f = (col: string) => (scope === "all" ? "" : `AND ${col} = ANY($1)`);
  const rows = await many(c, `SELECT w.id AS warehouse_id, w.code, w.name_ar, w.name_en,
        coalesce((SELECT sum(qty) FROM item_valuation v WHERE v.warehouse_id = w.id), 0) AS qty,
        coalesce((SELECT sum(total_value) FROM item_valuation v WHERE v.warehouse_id = w.id), 0) AS wavg_value,
        coalesce((SELECT sum(fifo_value(v.item_id, v.warehouse_id)) FROM item_valuation v WHERE v.warehouse_id = w.id AND v.qty > 0), 0) AS fifo_value,
        coalesce((SELECT sum(value) FROM stock_ledger l WHERE l.warehouse_id = w.id), 0) AS ledger_value,
        coalesce((SELECT sum(jl.debit - jl.credit) FROM journal_line jl JOIN gl_account a ON a.code = jl.account_code AND a.is_inventory WHERE jl.warehouse_id = w.id), 0) AS gl_value,
        coalesce((SELECT sum(l.value) FROM stock_ledger l LEFT JOIN journal_source j ON j.ledger_id = l.id WHERE l.warehouse_id = w.id AND j.ledger_id IS NULL), 0) AS unjournalised
      FROM warehouse w WHERE w.deleted_at IS NULL ${f("w.id")} ORDER BY w.code`, args);
  const provision = Number((await one(c, "SELECT coalesce(sum(credit - debit), 0) AS b FROM journal_line WHERE account_code = '1319'")).b);
  const out = rows.map((r) => {
    const n = (x: unknown) => Number(x);
    return { ...r, qty: n(r.qty), wavg_value: n(r.wavg_value), fifo_value: n(r.fifo_value), ledger_value: n(r.ledger_value), gl_value: n(r.gl_value),
      unjournalised: n(r.unjournalised),
      // book (WAVG) must equal ledger; GL + not-yet-journalised must equal ledger
      diff_ledger: r2(n(r.wavg_value) - n(r.ledger_value)), diff_gl: r2(n(r.gl_value) + n(r.unjournalised) - n(r.ledger_value)) };
  });
  return { warehouses: out, provision, method: await setting(c, "valuation.method", "WAVG"),
    reconciled: out.every((w) => Math.abs(w.diff_ledger) < 0.01 && Math.abs(w.diff_gl) < 0.01) };
}

export async function valuationItems(c: Tx, warehouseId: string, q?: string, page = 1, pageSize = 50) {
  const args: unknown[] = [warehouseId];
  let f = "";
  if (q) { args.push(`%${q}%`); f = `AND (i.item_code ILIKE $${args.length} OR i.name_ar ILIKE $${args.length} OR i.name_en ILIKE $${args.length})`; }
  const total = Number((await one(c, `SELECT count(*) AS n FROM item_valuation v JOIN item i ON i.id = v.item_id WHERE v.warehouse_id = $1 AND v.qty > 0 ${f}`, args)).n);
  args.push(pageSize, (page - 1) * pageSize);
  const data = await many(c, `SELECT v.item_id, i.item_code, i.name_ar, i.name_en, i.abc_class, v.qty AS qty_on_hand, v.avg_cost, v.total_value,
        fifo_value(v.item_id, v.warehouse_id) AS fifo_value
      FROM item_valuation v JOIN item i ON i.id = v.item_id WHERE v.warehouse_id = $1 AND v.qty > 0 ${f}
      ORDER BY v.total_value DESC LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
  return { data, total, page, pageSize };
}
