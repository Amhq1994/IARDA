// Phase 4 screens: planning runs & reorder suggestions, purchase requisitions, valuation (WAVG vs FIFO, reconciliation),
// provisions, GL journals, custody register and employee clearance (with printable certificate).
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { useAuth } from "../auth";
import { Alert, Empty, Field, Icon, Loading, Modal, PageHead, Pagination, Section, Tabs } from "../components/ui";
import { Timeline } from "../components/ops";
import { fmtDate, fmtNum, fmtSar, useL } from "../util";
import { DecisionBar, ItemPicker, ListCard, ReasonModal, Side, St, useAct, useWarehouses, WhSelect } from "./Control";

const n = (v: unknown, d = 2) => fmtNum(v == null ? null : Number(v), d);

// ============================================================ planning
export function PlanningPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const runs = useQuery({ queryKey: ["plan-runs"], queryFn: () => api.get("/api/planning/runs") });
  const runId = sp.get("run") ?? runs.data?.data[0]?.id;
  const action = sp.get("action") ?? "reorder";
  const page = Number(sp.get("page") ?? 1);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const nav = useNavigate();
  const detail = useQuery({ queryKey: ["plan-run", runId, action, page, q], enabled: !!runId && action !== "deadstock",
    queryFn: () => api.get(`/api/planning/runs/${runId}`, { action, page, q: q || undefined, pageSize: 50 }), placeholderData: (p) => p });
  const dead = useQuery({ queryKey: ["dead-stock"], queryFn: () => api.get("/api/planning/dead-stock"), enabled: action === "deadstock" });
  const a = useAct([["plan-runs"], ["plan-run"], ["prs"]]);
  const counts = Object.fromEntries((detail.data?.counts ?? []).map((c: any) => [c.action, c]));
  const set = (p: Record<string, string>) => { setSel([]); setSp({ ...(runId ? { run: runId } : {}), action, ...p }); };
  const run = runs.data?.data.find((r: any) => r.id === runId);
  return (
    <>
      <PageHead icon="chart" title={t("pl.planning")} lead={t("pl.formula")} actions={<>
        {can("pr.create", "pr.approve", "pr.process") && <Link className="btn btn--secondary" to="/planning/prs"><Icon name="sheet" />{t("pl.prs")}</Link>}
        {can("planning.manage") && <button className="btn btn--primary" disabled={a.busy} onClick={() => a.run(() => api.post("/api/planning/runs", {}), (r) => setSp({ run: r.id, action: "reorder" }))}>
          <Icon name="chart" />{t("pl.newRun")}</button>}
      </>} />
      {runs.isLoading ? <Loading /> : !runs.data.data.length ? <Empty /> : (
        <section className="card section">
          <div className="toolbar" style={{ flexWrap: "wrap", gap: 12 }}>
            <Field label={t("pl.run")}><select className="select" value={runId} onChange={(e) => setSp({ run: e.target.value, action })}>
              {runs.data.data.map((r: any) => <option key={r.id} value={r.id}>{r.run_no} · {fmtDate(r.created_at, lang, true)}</option>)}</select></Field>
            {run && <dl className="dl" style={{ flex: 1 }}>
              <div><dt>{t("pl.lines")}</dt><dd>{run.lines}</dd></div>
              <div><dt>{t("pl.reorder")}</dt><dd>{run.reorder_lines}</dd></div>
              <div><dt>{t("pl.reorderValue")}</dt><dd>{fmtSar(run.reorder_value)}</dd></div>
              <div><dt>{t("pl.dead")}</dt><dd>{run.dead_lines}</dd></div>
            </dl>}
          </div>
        </section>
      )}
      {runId && (
        <section className="card">
          <Tabs value={action} onChange={(v) => set({ action: v })} tabs={[
            ...["reorder", "excess", "ok", "no_demand", "dead"].map((k) => ({ id: k, label: t(`pl.${k}`), count: counts[k]?.n })),
            { id: "deadstock", label: t("pl.deadStock") }]} />
          {action === "deadstock" ? (dead.isLoading ? <Loading /> : (
            <ListCard empty={!dead.data.data.length}
              head={<><th>{t("ops.item")}</th><th>{t("ops.warehouse")}</th><th className="c">{t("pl.action")}</th><th className="c">{t("pl.idleDays")}</th><th className="c">{t("ops.qty")}</th><th className="c">{t("ops.value")}</th></>}
              rows={dead.data.data.map((r: any) => (
                <tr key={`${r.item_id}${r.warehouse_id}`}><td><Link className="mono" to={`/items/${r.item_id}`}>{r.item_code}</Link><br /><small>{L(r)}</small></td>
                  <td className="mono">{r.warehouse_code}</td><td className="c"><St s={r.class === "dead" ? "dead" : "excess"} /></td>
                  <td className="n">{r.idle_days ?? "—"}</td><td className="n">{n(r.qty)}</td><td className="n">{fmtSar(r.value)}</td></tr>
              ))} />
          )) : (<>
            <div className="toolbar">
              <div className="field grow"><div className="input-wrap"><Icon name="search" /><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("ops.item")} /></div></div>
              {sel.length > 0 && can("planning.manage") && action !== "dead" && action !== "no_demand" &&
                <button className="btn btn--secondary" disabled={a.busy} onClick={() => a.run(() => api.post(`/api/planning/runs/${runId}/apply`, { lineIds: sel }), () => setSel([]))}>
                  {t("pl.apply")} ({sel.length})</button>}
              {sel.length > 0 && can("pr.create") && action === "reorder" &&
                <button className="btn btn--primary" disabled={a.busy} onClick={() => a.run(() => api.post(`/api/planning/runs/${runId}/prs`, { lineIds: sel }), () => nav("/planning/prs"))}>
                  <Icon name="plus" />{t("pl.createPrs")} ({sel.length})</button>}
            </div>
            {detail.isLoading ? <Loading /> : !detail.data?.lines.data.length ? <Empty /> : (<>
              <div className="table-wrap"><table className="table"><thead><tr>
                <th style={{ width: 30 }}><input type="checkbox" checked={sel.length > 0 && sel.length === detail.data.lines.data.filter((l: any) => !l.pr_id).length}
                  onChange={(e) => setSel(e.target.checked ? detail.data.lines.data.filter((l: any) => !l.pr_id).map((l: any) => l.id) : [])} /></th>
                <th>{t("ops.item")}</th><th className="c">{t("pl.demand")}</th><th className="c col-opt">{t("pl.forecast")}</th><th className="c col-opt">{t("pl.lt")}</th>
                <th className="c">{t("pl.ss")}</th><th className="c">{t("pl.rop")}</th><th className="c">{t("pl.eoq")}</th><th className="c">{t("pl.minmax")}</th>
                <th className="c">{t("pl.free")}</th><th className="c">{t("pl.onOrder")}</th><th className="c">{t("pl.suggested")}</th>
              </tr></thead><tbody>{detail.data.lines.data.map((l: any) => (
                <tr key={l.id}>
                  <td><input type="checkbox" disabled={!!l.pr_id} checked={sel.includes(l.id)} onChange={(e) => setSel(e.target.checked ? [...sel, l.id] : sel.filter((x) => x !== l.id))} /></td>
                  <td><Link className="mono" to={`/items/${l.item_id}`}>{l.item_code}</Link> <span className="chip">{l.warehouse_code}</span>{l.abc_class && <span className="chip">{l.abc_class}</span>}
                    <br /><small>{L(l)}</small>{l.pr_no && <div><small className="mono">{l.pr_no}</small></div>}{l.applied_at && <div className="m-ok" style={{ fontSize: 12 }}>✓ {t("pl.proposed")}</div>}</td>
                  <td className="n">{n(l.avg_daily_demand, 2)}</td><td className="n col-opt">{n(l.forecast_30d, 1)}</td><td className="n col-opt">{l.lead_time_days}</td>
                  <td className="n">{n(l.safety_stock)}</td>
                  <td className="n"><b>{n(l.reorder_point)}</b>{l.cur_rop != null && Number(l.cur_rop) !== Number(l.reorder_point) && <><br /><small className="muted">{t("pl.current")} {n(l.cur_rop)}</small></>}</td>
                  <td className="n">{l.eoq == null ? "—" : n(l.eoq)}</td>
                  <td className="n">{n(l.min_qty)} / {n(l.max_qty)}{l.cur_max != null && <><br /><small className="muted">{n(l.cur_min)} / {n(l.cur_max)}</small></>}</td>
                  <td className="n">{n(l.free_qty)}</td><td className="n">{n(l.on_order)}</td>
                  <td className="n">{Number(l.suggested_qty) > 0 ? <><b>{n(l.suggested_qty)}</b> <small className="muted">{l.uom_code}</small><br /><small>{fmtSar(l.suggested_value)}</small></> : "—"}</td>
                </tr>
              ))}</tbody></table></div>
              <Pagination page={detail.data.lines.page} pageSize={detail.data.lines.pageSize} total={detail.data.lines.total} onPage={(p) => set({ page: String(p) })} />
            </>)}
          </>)}
        </section>
      )}
    </>
  );
}

// ============================================================ purchase requisitions
export function PrsPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { can } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const r = useQuery({ queryKey: ["prs"], queryFn: () => api.get("/api/prs") });
  return (
    <>
      <PageHead icon="sheet" title={t("pl.prs")} crumbs={<Link to="/planning">{t("pl.planning")}</Link>}
        actions={can("pr.create") && <button className="btn btn--primary" onClick={() => setOpen(true)}><Icon name="plus" />{t("pl.newPr")}</button>} />
      <section className="card">
        {r.isLoading ? <Loading /> : (
          <ListCard empty={!r.data.data.length}
            head={<><th>{t("common.code")}</th><th>{t("pl.source")}</th><th>{t("ops.warehouse")}</th><th className="col-opt">{t("ops.requester")}</th><th className="c">{t("ops.lines")}</th>
              <th className="c">{t("ops.value")}</th><th className="c">{t("common.status")}</th><th className="col-opt">{t("pl.po")}</th></>}
            rows={r.data.data.map((x: any) => (
              <tr key={x.id} className="is-clickable" onClick={() => nav(`/planning/prs/${x.id}`)}>
                <td className="mono"><Link to={`/planning/prs/${x.id}`} onClick={(e) => e.stopPropagation()}>{x.pr_no}</Link></td>
                <td>{t(`pl.${x.source}`)}</td><td className="mono">{x.warehouse_code}</td><td className="col-opt">{lang === "ar" ? x.requester_ar : x.requester_en}</td>
                <td className="n">{x.lines}</td><td className="n">{fmtSar(x.estimated_value)}</td><td className="c"><St s={x.status} /></td><td className="mono col-opt">{x.po_no ?? "—"}</td>
              </tr>
            ))} />
        )}
      </section>
      {open && <PrModal onClose={() => setOpen(false)} />}
    </>
  );
}

function PrModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const L = useL();
  const nav = useNavigate();
  const a = useAct([["prs"]]);
  const [f, setF] = useState({ warehouseId: "", neededBy: "", notes: "" });
  const [lines, setLines] = useState<{ item: any; qty: string }[]>([]);
  const valid = f.warehouseId && lines.length > 0 && lines.every((l) => Number(l.qty) > 0);
  const save = (submit: boolean) => a.run(async () => {
    const pr = await api.post("/api/prs", { warehouseId: f.warehouseId, neededBy: f.neededBy || null, notes: f.notes || null, lines: lines.map((l) => ({ itemId: l.item.id, qty: Number(l.qty) })) });
    if (submit) await api.post(`/api/prs/${pr.id}/submit`);
    return pr;
  }, (pr) => nav(`/planning/prs/${pr.id}`));
  return (
    <Modal wide title={t("pl.newPr")} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn--secondary" disabled={!valid || a.busy} onClick={() => save(false)}>{t("ops.saveDraft")}</button>
      <button className="btn btn--primary" disabled={!valid || a.busy} onClick={() => save(true)}>{t("ops.submit")}</button></>}>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <WhSelect label={t("ops.warehouse")} value={f.warehouseId} onChange={(v) => setF({ ...f, warehouseId: v })} />
        <Field label={t("ops.neededBy")}><input className="input" type="date" value={f.neededBy} onChange={(e) => setF({ ...f, neededBy: e.target.value })} /></Field>
      </div>
      <Field label={t("common.notes")}><input className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <ItemPicker onPick={(it) => !lines.some((l) => l.item.id === it.id) && setLines([...lines, { item: it, qty: "1" }])} />
      {lines.length > 0 && <div className="table-wrap" style={{ marginTop: 10 }}><table className="table"><thead><tr><th>{t("ops.item")}</th><th className="c">{t("ops.qty")}</th><th /></tr></thead>
        <tbody>{lines.map((l, i) => (
          <tr key={l.item.id}><td><span className="mono">{l.item.item_code}</span><br />{L(l.item)}</td>
            <td><input className="input" type="number" min="0" style={{ width: 90 }} value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} /></td>
            <td><button className="btn btn--ghost btn--sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}>{t("common.delete")}</button></td></tr>
        ))}</tbody></table></div>}
    </Modal>
  );
}

export function PrDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const r = useQuery({ queryKey: ["pr", id], queryFn: () => api.get(`/api/prs/${id}`) });
  const a = useAct([["pr", id!], ["prs"], ["approvals-inbox"]]);
  const [conv, setConv] = useState(false);
  const [cancel, setCancel] = useState(false);
  if (r.isLoading) return <Loading />;
  const d = r.data;
  return (
    <>
      <PageHead icon="sheet" title={d.pr_no} crumbs={<Link to="/planning/prs">{t("pl.prs")}</Link>} actions={<>
        <St s={d.status} />
        {d.actions.submit && <button className="btn btn--primary" disabled={a.busy} onClick={() => a.run(() => api.post(`/api/prs/${id}/submit`))}>{t("ops.submit")}</button>}
        {d.actions.decide && <DecisionBar docType="PR" id={id!} keys={[["pr", id!], ["approvals-inbox"]]} />}
        {d.actions.convert && <button className="btn btn--primary" onClick={() => setConv(true)}><Icon name="sheet" />{t("pl.convert")}</button>}
        {d.actions.cancel && <button className="btn btn--ghost" onClick={() => setCancel(true)}>{t("pl.cancel")}</button>}
      </>} />
      <section className="card section"><dl className="dl">
        <div><dt>{t("pl.source")}</dt><dd>{t(`pl.${d.source}`)}{d.run_no && <> · <span className="mono">{d.run_no}</span></>}</dd></div>
        <div><dt>{t("ops.warehouse")}</dt><dd>{d.warehouse_code} — {L(d, "warehouse")}</dd></div>
        <div><dt>{t("ops.requester")}</dt><dd>{lang === "ar" ? d.requester_ar : d.requester_en}</dd></div>
        <div><dt>{t("ops.value")}</dt><dd>{fmtSar(d.estimated_value)}</dd></div>
        {d.needed_by && <div><dt>{t("ops.neededBy")}</dt><dd>{fmtDate(d.needed_by, lang)}</dd></div>}
        {d.po && <div><dt>{t("pl.po")}</dt><dd><Link className="mono" to={`/inbound/pos/${d.po.id}`}>{d.po.po_no}</Link> <St s={d.po.status} /></dd></div>}
        {d.notes && <div style={{ gridColumn: "1 / -1" }}><dt>{t("common.notes")}</dt><dd>{d.notes}</dd></div>}
        {d.status_reason && <div style={{ gridColumn: "1 / -1" }}><dt>{t("ops.comment")}</dt><dd>{d.status_reason}</dd></div>}
      </dl></section>
      <div className="grid grid--2-1">
        <Section icon="table" title={t("ops.lines")}>
          <div className="table-wrap"><table className="table"><thead><tr><th>{t("ops.item")}</th><th className="c">{t("ops.qty")}</th><th className="c">{t("pl.estCost")}</th><th className="c">{t("ops.value")}</th></tr></thead>
            <tbody>{d.lines.map((l: any) => (
              <tr key={l.id}><td><Link className="mono" to={`/items/${l.item_id}`}>{l.item_code}</Link><br /><small>{L(l)}</small></td>
                <td className="n">{n(l.qty)} <small className="muted">{l.uom_code}</small></td><td className="n">{n(l.est_unit_cost, 4)}</td><td className="n">{fmtSar(l.value)}</td></tr>
            ))}</tbody></table></div>
        </Section>
        <Side d={d} />
      </div>
      {conv && <ConvertModal pr={d} onClose={() => setConv(false)} />}
      {cancel && <ReasonModal title={t("pl.cancel")} onClose={() => setCancel(false)} onSubmit={(reason) => a.run(() => api.post(`/api/prs/${id}/cancel`, { reason }), () => setCancel(false))} />}
    </>
  );
}

function ConvertModal({ pr, onClose }: { pr: any; onClose: () => void }) {
  const { t } = useTranslation();
  const L = useL();
  const nav = useNavigate();
  const a = useAct([["pr", pr.id], ["prs"]]);
  const sup = useQuery({ queryKey: ["suppliers-all"], queryFn: () => api.get("/api/suppliers", { pageSize: 100 }) });
  const [f, setF] = useState({ supplierId: "", etimadRef: "", expectedDate: "" });
  const [prices, setPrices] = useState<Record<string, string>>(Object.fromEntries(pr.lines.map((l: any) => [l.id, String(Number(l.est_unit_cost))])));
  return (
    <Modal wide title={t("pl.convert")} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn--primary" disabled={!f.supplierId || a.busy} onClick={() => a.run(() => api.post(`/api/prs/${pr.id}/convert`, {
        supplierId: f.supplierId, etimadRef: f.etimadRef || null, expectedDate: f.expectedDate || null, prices: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, Number(v)])) }),
        (po) => nav(`/inbound/pos/${po.id}`))}>{t("common.confirm")}</button></>}>
      <div className="grid" style={{ gridTemplateColumns: "2fr 1fr 1fr", gap: 12 }}>
        <Field label={t("ops.supplier")} required><select className="select" value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}>
          <option value="">—</option>{(sup.data?.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.code} — {L(s)}</option>)}</select></Field>
        <Field label={t("pl.etimadRef")}><input className="input mono" value={f.etimadRef} onChange={(e) => setF({ ...f, etimadRef: e.target.value })} /></Field>
        <Field label={t("pl.expected")}><input className="input" type="date" value={f.expectedDate} onChange={(e) => setF({ ...f, expectedDate: e.target.value })} /></Field>
      </div>
      <div className="table-wrap"><table className="table"><thead><tr><th>{t("ops.item")}</th><th className="c">{t("ops.qty")}</th><th className="c">{t("pl.unitPrice")}</th></tr></thead>
        <tbody>{pr.lines.map((l: any) => (
          <tr key={l.id}><td><span className="mono">{l.item_code}</span><br /><small>{L(l)}</small></td><td className="n">{n(l.qty)}</td>
            <td><input className="input" type="number" min="0" step="0.01" style={{ width: 110 }} value={prices[l.id]} onChange={(e) => setPrices({ ...prices, [l.id]: e.target.value })} /></td></tr>
        ))}</tbody></table></div>
    </Modal>
  );
}

// ============================================================ valuation, provisions, journals
export function ValuationPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const { can } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") ?? "summary";
  const whs = useWarehouses();
  const [wh, setWh] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const sum = useQuery({ queryKey: ["val-summary"], queryFn: () => api.get("/api/valuation/summary"), enabled: tab === "summary" });
  const whId = wh || whs.data?.data[0]?.id;
  const items = useQuery({ queryKey: ["val-items", whId, q, page], queryFn: () => api.get("/api/valuation/items", { warehouseId: whId, q: q || undefined, page }), enabled: tab === "items" && !!whId, placeholderData: (p) => p });
  const prov = useQuery({ queryKey: ["provisions"], queryFn: () => api.get("/api/provisions"), enabled: tab === "provisions" });
  const jes = useQuery({ queryKey: ["journals"], queryFn: () => api.get("/api/journals"), enabled: tab === "journals" });
  const gl = useQuery({ queryKey: ["gl"], queryFn: () => api.get("/api/gl/accounts"), enabled: tab === "accounts" });
  const a = useAct([["val-summary"], ["journals"], ["provisions"]]);
  return (
    <>
      <PageHead icon="report" title={t("val.valuation")} actions={<>
        {can("valuation.manage", "journal.manage") && <button className="btn btn--secondary" disabled={a.busy} onClick={() => a.run(() => api.post("/api/journals/generate"), () => setSp({ tab: "journals" }))}>{t("val.generate")}</button>}
        {can("valuation.manage") && <button className="btn btn--primary" disabled={a.busy} onClick={() => a.run(() => api.post("/api/provisions", {}), () => setSp({ tab: "provisions" }))}>{t("val.runProvision")}</button>}
      </>} />
      <section className="card">
        <Tabs value={tab} onChange={(v) => setSp({ tab: v })} tabs={[{ id: "summary", label: t("val.summary") }, { id: "items", label: t("val.items") },
          { id: "journals", label: t("val.journals") }, { id: "provisions", label: t("val.provisions") }, { id: "accounts", label: t("val.accounts") }]} />
        {tab === "summary" && (sum.isLoading ? <Loading /> : (<>
          <div style={{ margin: "4px 0 14px" }}><Alert kind={sum.data.reconciled ? "success" : "warning"}>
            {t("val.method")}: <b>{sum.data.method === "WAVG" ? t("val.wavg") : sum.data.method}</b> · {sum.data.reconciled ? `✓ ${t("val.reconciled")}` : t("val.notReconciled")}
            {" · "}{t("val.provision")}: <b>{fmtSar(sum.data.provision)}</b></Alert></div>
          <ListCard empty={false}
            head={<><th>{t("ops.warehouse")}</th><th className="c">{t("ops.qty")}</th><th className="c">{t("val.wavg")}</th><th className="c">{t("val.fifo")}</th>
              <th className="c">{t("val.ledger")}</th><th className="c">{t("val.gl")}</th><th className="c">{t("val.unjournalised")}</th><th className="c">{t("common.status")}</th></>}
            rows={sum.data.warehouses.map((w: any) => (
              <tr key={w.warehouse_id}><td>{w.code} <small className="muted">{L(w)}</small></td><td className="n">{n(w.qty, 0)}</td><td className="n"><b>{fmtSar(w.wavg_value)}</b></td>
                <td className="n">{fmtSar(w.fifo_value)}<br /><small className="muted ltr">{w.fifo_value - w.wavg_value >= 0 ? "+" : ""}{n(w.fifo_value - w.wavg_value)}</small></td>
                <td className="n">{fmtSar(w.ledger_value)}</td><td className="n">{fmtSar(w.gl_value)}</td><td className="n">{fmtSar(w.unjournalised)}</td>
                <td className="c"><St s={w.diff_ledger === 0 && w.diff_gl === 0 ? "good" : "bad"} /></td></tr>
            ))} />
        </>))}
        {tab === "items" && (<>
          <div className="toolbar">
            <select className="select" style={{ width: "auto" }} value={whId} onChange={(e) => { setWh(e.target.value); setPage(1); }}>
              {(whs.data?.data ?? []).map((w: any) => <option key={w.id} value={w.id}>{w.code} — {L(w)}</option>)}</select>
            <div className="field grow"><div className="input-wrap"><Icon name="search" /><input className="input" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div></div>
          </div>
          {items.isLoading || !items.data ? <Loading /> : (<>
            <ListCard empty={!items.data.data.length}
              head={<><th>{t("ops.item")}</th><th className="c">{t("ops.qty")}</th><th className="c">{t("ops.avgCost")}</th><th className="c">{t("val.wavg")}</th><th className="c">{t("val.fifo")}</th><th className="c">Δ</th></>}
              rows={items.data.data.map((r: any) => (
                <tr key={r.item_id}><td><Link className="mono" to={`/items/${r.item_id}`}>{r.item_code}</Link> {r.abc_class && <span className="chip">{r.abc_class}</span>}<br /><small>{L(r)}</small></td>
                  <td className="n">{n(r.qty_on_hand)}</td><td className="n">{n(r.avg_cost, 4)}</td><td className="n">{fmtSar(r.total_value)}</td><td className="n">{fmtSar(r.fifo_value)}</td>
                  <td className="n"><small className="ltr">{n(Number(r.fifo_value) - Number(r.total_value))}</small></td></tr>
              ))} />
            <Pagination page={items.data.page} pageSize={items.data.pageSize} total={items.data.total} onPage={setPage} />
          </>)}
        </>)}
        {tab === "journals" && (jes.isLoading ? <Loading /> : (
          <ListCard empty={!jes.data.data.length}
            head={<><th>{t("common.code")}</th><th>{t("val.period")}</th><th>{t("pl.source")}</th><th className="c">{t("val.debit")}</th><th className="c">{t("ops.lines")}</th><th className="c">{t("common.status")}</th><th>ERP</th></>}
            rows={jes.data.data.map((j: any) => (
              <tr key={j.id} className="is-clickable" onClick={() => nav(`/valuation/journals/${j.id}`)}>
                <td className="mono"><Link to={`/valuation/journals/${j.id}`} onClick={(e) => e.stopPropagation()}>{j.je_no}</Link></td><td className="mono">{j.period}</td>
                <td>{j.source === "ledger" ? t("val.ledger") : t("val.provision")}{j.ledger_rows > 0 && <small className="muted"> · {j.ledger_rows} {t("val.rows")}</small>}</td>
                <td className="n">{fmtSar(j.total_debit)}</td><td className="n">{j.lines}</td><td className="c"><St s={j.status} /></td><td className="mono">{j.erp_ref ?? "—"}</td></tr>
            ))} />
        ))}
        {tab === "provisions" && (prov.isLoading ? <Loading /> : (
          <ListCard empty={!prov.data.data.length}
            head={<><th>{t("common.code")}</th><th>{t("common.date", { defaultValue: "Date" })}</th><th className="c">{t("val.required")}</th><th className="c">{t("val.previous")}</th><th className="c">{t("val.delta")}</th><th>JE</th></>}
            rows={prov.data.data.map((p: any) => (
              <tr key={p.id} className="is-clickable" onClick={() => nav(`/valuation/provisions/${p.id}`)}>
                <td className="mono"><Link to={`/valuation/provisions/${p.id}`} onClick={(e) => e.stopPropagation()}>{p.run_no}</Link></td><td>{fmtDate(p.as_of, lang)}</td>
                <td className="n">{fmtSar(p.required)}</td><td className="n">{fmtSar(p.previous)}</td><td className="n"><b>{fmtSar(p.delta)}</b></td>
                <td>{p.je_no ? <><span className="mono">{p.je_no}</span> <St s={p.je_status} /></> : "—"}</td></tr>
            ))} />
        ))}
        {tab === "accounts" && (gl.isLoading ? <Loading /> : (<div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 20 }}>
          <ListCard empty={false} head={<><th>{t("val.account")}</th><th>{t("common.name", { defaultValue: "Name" })}</th><th className="c">{t("val.gl")}</th></>}
            rows={gl.data.accounts.map((x: any) => <tr key={x.code}><td className="mono">{x.code}</td><td>{L(x)}<br /><small className="muted">{x.account_type}</small></td><td className="n">{fmtSar(x.posted_balance)}</td></tr>)} />
          <ListCard empty={false} head={<><th>{t("ops.movement")}</th><th>{t("val.account")}</th></>}
            rows={gl.data.movements.map((m: any) => <tr key={m.movement_type}><td className="mono">{m.movement_type}<br /><small className="muted">{lang === "ar" ? m.description_ar : m.description_en}</small></td>
              <td className="mono">{m.offset_account}{m.use_cost_center && <small className="muted"> · {t("val.costCenter")}</small>}</td></tr>)} />
        </div>))}
      </section>
    </>
  );
}

export function JournalDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const r = useQuery({ queryKey: ["journal", id], queryFn: () => api.get(`/api/journals/${id}`) });
  const a = useAct([["journal", id!], ["journals"], ["val-summary"]]);
  const [exp, setExp] = useState(false);
  if (r.isLoading) return <Loading />;
  const d = r.data;
  return (
    <>
      <PageHead icon="sheet" title={d.je_no} crumbs={<Link to="/valuation?tab=journals">{t("val.journals")}</Link>} actions={<>
        <St s={d.status} />
        {d.actions.post && <button className="btn btn--primary" disabled={a.busy} onClick={() => a.run(() => api.post(`/api/journals/${id}/post`))}>{t("val.post")}</button>}
        {d.actions.export && <button className="btn btn--secondary" onClick={() => setExp(true)}>{t("val.export")}</button>}
      </>} />
      <section className="card section"><dl className="dl">
        <div><dt>{t("val.period")}</dt><dd className="mono">{d.period}</dd></div>
        <div><dt>{t("common.date", { defaultValue: "Date" })}</dt><dd>{fmtDate(d.je_date, lang)}</dd></div>
        <div><dt>{t("val.debit")} = {t("val.credit")}</dt><dd>{fmtSar(d.total_debit)}</dd></div>
        {d.erp_ref && <div><dt>{t("val.erpRef")}</dt><dd className="mono">{d.erp_ref}</dd></div>}
        <div style={{ gridColumn: "1 / -1" }}><dt>{t("common.description", { defaultValue: "Description" })}</dt><dd>{d.description}</dd></div>
      </dl>{d.status !== "draft" && <div style={{ marginTop: 12 }}><Alert>{t("val.frozen")}</Alert></div>}</section>
      <div className="grid grid--2-1">
        <Section icon="table" title={t("ops.lines")}>
          <div className="table-wrap"><table className="table"><thead><tr><th>#</th><th>{t("val.account")}</th><th>{t("ops.warehouse")}</th><th>{t("val.costCenter")}</th><th className="c">{t("val.debit")}</th><th className="c">{t("val.credit")}</th></tr></thead>
            <tbody>{d.lines.map((l: any) => (
              <tr key={l.id}><td>{l.line_no}</td><td><span className="mono">{l.account_code}</span> {L(l, "account")}</td><td className="mono">{l.warehouse_code ?? "—"}</td>
                <td>{l.org_code ? <><span className="mono">{l.org_code}</span> <small>{L(l, "org")}</small></> : "—"}</td>
                <td className="n">{Number(l.debit) ? n(l.debit) : ""}</td><td className="n">{Number(l.credit) ? n(l.credit) : ""}</td></tr>
            ))}
            <tr><td /><td colSpan={3}><b>{t("rep.total", { defaultValue: lang === "ar" ? "المجموع" : "Total" })}</b></td>
              <td className="n"><b>{n(d.lines.reduce((s: number, l: any) => s + Number(l.debit), 0))}</b></td><td className="n"><b>{n(d.lines.reduce((s: number, l: any) => s + Number(l.credit), 0))}</b></td></tr>
            </tbody></table></div>
        </Section>
        <Section icon="calendar" title={t("ops.timeline")}><Timeline events={d.events} /></Section>
      </div>
      {exp && <ReasonModal title={t("val.export")} label={t("val.erpRef")} onClose={() => setExp(false)} onSubmit={(erpRef) => a.run(() => api.post(`/api/journals/${id}/export`, { erpRef }), () => setExp(false))} />}
    </>
  );
}

export function ProvisionDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const r = useQuery({ queryKey: ["provision", id], queryFn: () => api.get(`/api/provisions/${id}`) });
  if (r.isLoading) return <Loading />;
  const d = r.data;
  return (
    <>
      <PageHead icon="shield" title={d.run_no} crumbs={<Link to="/valuation?tab=provisions">{t("val.provisions")}</Link>} />
      <section className="card section"><dl className="dl">
        <div><dt>{t("common.date", { defaultValue: "Date" })}</dt><dd>{fmtDate(d.as_of, lang)}</dd></div>
        <div><dt>{t("val.required")}</dt><dd>{fmtSar(d.required)}</dd></div>
        <div><dt>{t("val.previous")}</dt><dd>{fmtSar(d.previous)}</dd></div>
        <div><dt>{t("val.delta")}</dt><dd>{fmtSar(d.delta)}{d.je_no && <> · <span className="mono">{d.je_no}</span></>}</dd></div>
      </dl></section>
      <div className="grid grid--2-1">
        <Section icon="table" title={t("ops.lines")}>
          <ListCard empty={!d.lines.length} head={<><th>{t("ops.item")}</th><th>{t("ops.warehouse")}</th><th>{t("val.category")}</th><th className="c">{t("ops.value")}</th><th className="c">{t("val.rate")}</th><th className="c">{t("val.provision")}</th></>}
            rows={d.lines.map((l: any) => (
              <tr key={l.id}><td><span className="mono">{l.item_code}</span><br /><small>{L(l)}</small>{(l.lot_no || l.serial_no) && <div className="mono muted" style={{ fontSize: 12 }}>{l.serial_no ?? l.lot_no}</div>}</td>
                <td className="mono">{l.warehouse_code}</td><td>{t(`val.${l.category}`)}</td><td className="n">{fmtSar(l.value)}</td><td className="n">{Math.round(Number(l.rate) * 100)}%</td><td className="n"><b>{fmtSar(l.provision)}</b></td></tr>
            ))} />
        </Section>
        <Section icon="chart" title={t("val.category")}>
          {d.byCategory.map((c: any) => <div key={c.category} className="kpi-target"><span>{t(`val.${c.category}`)} <small className="muted">({c.n})</small></span><b>{fmtSar(c.provision)}</b></div>)}
        </Section>
      </div>
    </>
  );
}

// ============================================================ custody
export function CustodyPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const staff = can("custody.manage", "custody.approve", "audit.read");
  const view = sp.get("view") ?? (staff ? "all" : "mine");
  const [status, setStatus] = useState("active");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const r = useQuery({ queryKey: ["custody", view, status, q], queryFn: () => api.get("/api/custody", { view, status: status || undefined, q: q || undefined }), placeholderData: (p) => p });
  return (
    <>
      <PageHead icon="users" title={t("cus.custody")} actions={can("clearance.request", "admin.users") && <Link className="btn btn--secondary" to="/clearances"><Icon name="shield" />{t("cus.clearances")}</Link>} />
      <section className="card">
        <Tabs value={view} onChange={(v) => setSp({ view: v })} tabs={[{ id: "mine", label: t("cus.mine") }, ...(staff ? [{ id: "all", label: t("cus.register") }] : [])]} />
        <div className="toolbar">
          <select className="select" style={{ width: "auto" }} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t("ops.all")}</option>{["active", "return_pending", "returned", "lost"].map((s) => <option key={s} value={s}>{t(`docStatus.${s}`)}</option>)}</select>
          {view === "all" && <div className="field grow"><div className="input-wrap"><Icon name="search" /><input className="input" value={q} onChange={(e) => setQ(e.target.value)} /></div></div>}
        </div>
        {r.isLoading || !r.data ? <Loading /> : (
          <ListCard empty={!r.data.data.length}
            head={<><th>{t("common.code")}</th><th>{t("ops.item")}</th><th>{t("cus.serial")}</th>{view === "all" && <th>{t("cus.holder")}</th>}<th>{t("cus.issued")}</th>
              <th className="c">{t("ops.value")}</th><th className="c">{t("common.status")}</th></>}
            rows={r.data.data.map((x: any) => (
              <tr key={x.id} className="is-clickable" onClick={() => setOpen(x.id)}>
                <td className="mono">{x.custody_no}{x.status === "active" && !x.acknowledged_at && <div className="overdue">{t("cus.notAck")}</div>}</td>
                <td><span className="mono">{x.item_code}</span><br /><small>{L(x)}</small></td><td className="mono">{x.serial_no ?? "—"}</td>
                {view === "all" && <td>{lang === "ar" ? x.holder_ar : x.holder_en}<br /><small className="muted">{L(x, "org")}</small></td>}
                <td><small>{fmtDate(x.issued_at, lang)}</small>{x.mr_no && <div className="mono muted" style={{ fontSize: 12 }}>{x.mr_no}</div>}</td>
                <td className="n">{fmtSar(x.value)}</td><td className="c"><St s={x.status} /></td></tr>
            ))} />
        )}
      </section>
      {open && <CustodyModal id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function CustodyModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const r = useQuery({ queryKey: ["custody-one", id], queryFn: () => api.get(`/api/custody/${id}`) });
  const a = useAct([["custody-one", id], ["custody"]]);
  const [mode, setMode] = useState<"transfer" | "return" | "lost" | null>(null);
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [cond, setCond] = useState("good");
  const [reason, setReason] = useState("");
  const emps = useQuery({ queryKey: ["employees", q], queryFn: () => api.get("/api/employees", { q: q || undefined }), enabled: mode === "transfer" });
  const d = r.data;
  return (
    <Modal wide title={d ? `${d.custody_no} · ${d.item_code}` : "…"} onClose={onClose} footer={d && <>
      {mode ? <>
        <button className="btn btn--secondary" onClick={() => setMode(null)}>{t("common.cancel")}</button>
        <button className="btn btn--primary" disabled={a.busy || reason.trim().length < 3 || (mode === "transfer" && !to)} onClick={() => a.run(() =>
          mode === "transfer" ? api.post(`/api/custody/${id}/transfer`, { toUserId: to, reason }) : mode === "return" ? api.post(`/api/custody/${id}/return`, { condition: cond, reason })
            : api.post(`/api/custody/${id}/lost`, { reason }), () => { setMode(null); setReason(""); })}>{t("common.confirm")}</button>
      </> : <>
        {d.actions.acknowledge && <button className="btn btn--primary" disabled={a.busy} onClick={() => a.run(() => api.post(`/api/custody/${id}/acknowledge`))}><Icon name="check" />{t("cus.acknowledge")}</button>}
        {d.actions.transfer && <button className="btn btn--secondary" onClick={() => setMode("transfer")}>{t("cus.transfer")}</button>}
        {d.actions.return && <button className="btn btn--secondary" onClick={() => setMode("return")}>{t("cus.returnIt")}</button>}
        {d.actions.lost && <button className="btn btn--ghost" onClick={() => setMode("lost")}>{t("cus.lost")}</button>}
      </>}</>}>
      {!d ? <Loading /> : <>
        <dl className="dl">
          <div><dt>{t("ops.item")}</dt><dd>{L(d)}</dd></div><div><dt>{t("cus.serial")}</dt><dd className="mono">{d.serial_no ?? d.lot_no ?? "—"}</dd></div>
          <div><dt>{t("cus.holder")}</dt><dd>{lang === "ar" ? d.holder_ar : d.holder_en} <small className="muted">{d.employee_no}</small></dd></div>
          <div><dt>{t("ops.department")}</dt><dd>{L(d, "org")}</dd></div>
          <div><dt>{t("cus.issued")}</dt><dd>{fmtDate(d.issued_at, lang)}{d.mr_no && <> · <span className="mono">{d.mr_no}</span></>}</dd></div>
          <div><dt>{t("cus.acknowledged")}</dt><dd>{d.acknowledged_at ? fmtDate(d.acknowledged_at, lang, true) : <span className="overdue">{t("cus.notAck")}</span>}</dd></div>
          <div><dt>{t("ops.value")}</dt><dd>{fmtSar(d.value)}</dd></div><div><dt>{t("common.status")}</dt><dd><St s={d.status} />{d.ret_no && <> · <span className="mono">{d.ret_no}</span></>}</dd></div>
          {d.lost_reason && <div style={{ gridColumn: "1 / -1" }}><dt>{t("cus.lost")}</dt><dd>{d.lost_reason}</dd></div>}
        </dl>
        {mode && <div style={{ marginTop: 16 }}>
          {mode === "transfer" && <Field label={t("cus.toUser")} required>
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="…" style={{ marginBottom: 6 }} />
            <select className="select" value={to} onChange={(e) => setTo(e.target.value)} size={5}>
              {(emps.data?.data ?? []).filter((u: any) => u.id !== d.holder_id).map((u: any) => <option key={u.id} value={u.id}>{L(u)} · {u.employee_no ?? u.username} · {L(u, "org")}</option>)}</select></Field>}
          {mode === "return" && <Field label={t("inv.condition")}><select className="select" value={cond} onChange={(e) => setCond(e.target.value)}>
            {["good", "quarantine", "damaged"].map((c) => <option key={c} value={c}>{t(`inv.${c}`)}</option>)}</select></Field>}
          <Field label={t("cus.reason")} required><textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </div>}
        <div style={{ marginTop: 16 }}><Timeline events={d.events} /></div>
      </>}
    </Modal>
  );
}

// ============================================================ clearance
export function ClearancesPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { can } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const r = useQuery({ queryKey: ["clearances"], queryFn: () => api.get("/api/clearances") });
  return (
    <>
      <PageHead icon="shield" title={t("cus.clearances")} crumbs={<Link to="/custody">{t("cus.custody")}</Link>}
        actions={can("clearance.request") && <button className="btn btn--primary" onClick={() => setOpen(true)}><Icon name="plus" />{t("cus.newClearance")}</button>} />
      <section className="card">
        {r.isLoading ? <Loading /> : (
          <ListCard empty={!r.data.data.length}
            head={<><th>{t("common.code")}</th><th>{t("cus.employee")}</th><th>{t("cus.reason")}</th><th className="c">{t("cus.blockers")}</th><th className="c">{t("common.status")}</th><th>{t("cus.certNo")}</th></>}
            rows={r.data.data.map((x: any) => (
              <tr key={x.id} className="is-clickable" onClick={() => nav(`/clearances/${x.id}`)}>
                <td className="mono"><Link to={`/clearances/${x.id}`} onClick={(e) => e.stopPropagation()}>{x.cl_no}</Link>{x.source === "hr" && <span className="chip">HR</span>}</td>
                <td>{lang === "ar" ? x.employee_ar : x.employee_en} <small className="muted">{x.employee_no}</small></td><td>{t(`cus.${x.reason}`)}</td>
                <td className="n">{x.blockers.length}</td><td className="c"><St s={x.status} /></td><td className="mono">{x.certificate_no ?? "—"}</td></tr>
            ))} />
        )}
      </section>
      {open && <ClearanceModal onClose={() => setOpen(false)} />}
    </>
  );
}

function ClearanceModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const L = useL();
  const nav = useNavigate();
  const a = useAct([["clearances"]]);
  const [q, setQ] = useState("");
  const [f, setF] = useState({ employeeId: "", reason: "resignation", notes: "" });
  const emps = useQuery({ queryKey: ["employees", q], queryFn: () => api.get("/api/employees", { q: q || undefined }) });
  return (
    <Modal title={t("cus.newClearance")} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn--primary" disabled={!f.employeeId || a.busy} onClick={() => a.run(() => api.post("/api/clearances", { ...f, notes: f.notes || undefined }), (r) => nav(`/clearances/${r.id}`))}>{t("common.confirm")}</button></>}>
      <Field label={t("cus.employee")} required>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="…" style={{ marginBottom: 6 }} />
        <select className="select" size={6} value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}>
          {(emps.data?.data ?? []).map((u: any) => <option key={u.id} value={u.id}>{L(u)} · {u.employee_no ?? u.username} · {L(u, "org")}</option>)}</select></Field>
      <Field label={t("cus.reason")}><select className="select" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>
        {["resignation", "transfer", "retirement", "end_of_contract", "other"].map((r) => <option key={r} value={r}>{t(r === "transfer" ? "cus.transfer" : `cus.${r}`)}</option>)}</select></Field>
      <Field label={t("common.notes")}><input className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
    </Modal>
  );
}

export function ClearanceDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const r = useQuery({ queryKey: ["clearance", id], queryFn: () => api.get(`/api/clearances/${id}`) });
  const a = useAct([["clearance", id!], ["clearances"]]);
  if (r.isLoading) return <Loading />;
  const d = r.data;
  return (
    <>
      <PageHead icon="shield" title={d.cl_no} crumbs={<Link to="/clearances">{t("cus.clearances")}</Link>} actions={<>
        <St s={d.status} />
        {d.actions.recheck && <button className="btn btn--primary" disabled={a.busy} onClick={() => a.run(() => api.post(`/api/clearances/${id}/recheck`))}>{t("cus.recheck")}</button>}
        {d.status === "cleared" && <button className="btn btn--secondary" onClick={() => window.print()}><Icon name="report" />{t("cus.print")}</button>}
      </>} />
      {d.status === "cleared" ? (
        <section className="card section print-sheet">
          <div style={{ textAlign: "center", marginBottom: 18 }}>
            <img src="/brand/assets/logo/iarda-logo.svg" alt="" style={{ height: 70 }} onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
            <h2 style={{ color: "var(--iarda-gold)", margin: "10px 0 4px" }}>{t("cus.certificate")}</h2>
            <div className="mono">{d.certificate_no}</div>
          </div>
          <dl className="dl">
            <div><dt>{t("cus.employee")}</dt><dd>{lang === "ar" ? d.employee_ar : d.employee_en}</dd></div>
            <div><dt>{lang === "ar" ? "الرقم الوظيفي" : "Employee no."}</dt><dd className="mono">{d.employee_no ?? "—"}</dd></div>
            <div><dt>{t("ops.department")}</dt><dd>{L(d, "org")}</dd></div>
            <div><dt>{lang === "ar" ? "المسمى" : "Position"}</dt><dd>{L(d, "position")}</dd></div>
            <div><dt>{t("cus.reason")}</dt><dd>{t(d.reason === "transfer" ? "cus.transfer" : `cus.${d.reason}`)}</dd></div>
            <div><dt>{t("common.date", { defaultValue: "Date" })}</dt><dd>{fmtDate(d.cleared_at, lang)}</dd></div>
          </dl>
          <p style={{ marginTop: 20, lineHeight: 1.9 }}>{t("cus.certText")}</p>
          <p className="muted">{lang === "ar" ? "اعتمده" : "Issued by"}: {lang === "ar" ? d.cleared_by_ar : d.cleared_by_en}</p>
        </section>
      ) : (
        <section className="card section">
          <dl className="dl" style={{ marginBottom: 14 }}>
            <div><dt>{t("cus.employee")}</dt><dd>{lang === "ar" ? d.employee_ar : d.employee_en} <small className="muted">{d.employee_no}</small></dd></div>
            <div><dt>{t("cus.reason")}</dt><dd>{t(d.reason === "transfer" ? "cus.transfer" : `cus.${d.reason}`)}</dd></div>
            <div><dt>{lang === "ar" ? "آخر فحص" : "Last checked"}</dt><dd>{fmtDate(d.checked_at, lang, true)}</dd></div>
          </dl>
          <Alert kind="warning"><b>{t("cus.blockers")}</b>
            <ul style={{ margin: "6px 0 0", paddingInlineStart: 18 }}>{d.blockers.map((b: any, i: number) => <li key={i}><span className="mono">{b.ref}</span> — {lang === "ar" ? b.ar : b.en}</li>)}</ul></Alert>
        </section>
      )}
      <Section icon="calendar" title={t("ops.timeline")}><Timeline events={d.events} /></Section>
    </>
  );
}

