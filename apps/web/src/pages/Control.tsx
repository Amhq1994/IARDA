// Phase 3 — inventory control screens: unified approvals inbox, inter-warehouse transfers, returns / quarantine / RTV,
// stock counting with variance review, adjustments, and disposals with committee minutes.
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { useAuth } from "../auth";
import { Alert, Empty, Field, Icon, Loading, Modal, PageHead, Section, Tabs, toast } from "../components/ui";
import { DocBadge, Timeline } from "../components/ops";
import { errorText, fmtDate, fmtNum, fmtSar, useL } from "../util";

const DOC_ROUTE: Record<string, string> = { MR: "/requests", TR: "/transfers", ADJ: "/adjustments", DSP: "/disposals", RTV: "/returns" };
const TONE: Record<string, string> = {
  draft: "badge--neutral", pending_approval: "badge--warning", approved: "badge--success", rejected: "badge--error", in_transit: "badge--warning",
  received: "badge--warning", closed: "badge--neutral", cancelled: "badge--neutral", shipped: "badge--warning", posted: "badge--success",
  counting: "badge--warning", review: "badge--warning", available: "badge--success", quarantine: "badge--warning", damaged: "badge--error",
  open: "badge--neutral", counted: "badge--success", recount: "badge--warning", final: "badge--neutral",
};

function St({ s, dict = "docStatus" }: { s: string; dict?: string }) {
  const { t } = useTranslation();
  return <span className={`badge ${TONE[s] ?? "badge--neutral"}`}>{t(`${dict}.${s}`, { defaultValue: t(`inv.${s}`, { defaultValue: s }) })}</span>;
}

/** Runs an action with a toast and refreshes the given queries. */
function useAct(keys: string[][]) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  return {
    busy,
    run: async (fn: () => Promise<unknown>, after?: (r: any) => void) => {
      setBusy(true);
      try {
        const r = await fn();
        toast.success(t("common.saved"));
        keys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
        after?.(r);
      } catch (e) { toast.error(errorText(e, i18n.language)); } finally { setBusy(false); }
    },
  };
}

function ReasonModal({ title, onClose, onSubmit, label }: { title: string; onClose: () => void; onSubmit: (r: string) => void; label?: string }) {
  const { t } = useTranslation();
  const [r, setR] = useState("");
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn--primary" disabled={r.trim().length < 2} onClick={() => onSubmit(r)}>{t("common.confirm")}</button></>}>
      <Field label={label ?? t("ops.comment")} required><textarea className="input" value={r} onChange={(e) => setR(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}

/** Approve / reject / return buttons for the assigned approver (or delegate). */
function DecisionBar({ docType, id, keys }: { docType: string; id: string; keys: string[][] }) {
  const { t } = useTranslation();
  const a = useAct(keys);
  const [modal, setModal] = useState<"reject" | "return" | null>(null);
  const decide = (action: string, comment?: string) => a.run(() => api.post(`/api/approvals/${docType}/${id}/decision`, { action, comment }), () => setModal(null));
  return (
    <>
      <button className="btn btn--primary" disabled={a.busy} onClick={() => decide("approve")}><Icon name="check" />{t("ops.approve")}</button>
      <button className="btn btn--secondary" disabled={a.busy} onClick={() => setModal("return")}>{t("ops.returnForRevision")}</button>
      <button className="btn btn--ghost" disabled={a.busy} onClick={() => setModal("reject")}>{t("ops.reject")}</button>
      {modal && <ReasonModal title={t(modal === "reject" ? "ops.reject" : "ops.returnForRevision")} onClose={() => setModal(null)} onSubmit={(c) => decide(modal, c)} />}
    </>
  );
}

function Chain({ tasks, revision }: { tasks: any[]; revision: number }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const rev = tasks.filter((x) => x.revision === revision);
  return (
    <Section icon="shield" title={t("ops.chain")}>
      {rev.length === 0 ? <p className="muted">—</p> : (
        <div className="chain">{rev.map((x) => (
          <div key={x.id} className={`chain__step${x.status === "pending" ? " is-pending" : ""}`}>
            <span className="chain__lvl">{x.level}</span>
            <div style={{ flex: 1 }}>
              <b style={{ color: "var(--iarda-primary-dark)", fontWeight: 500 }}>{lang === "ar" ? x.assignee_ar : x.assignee_en}</b>
              {x.original_assignee_id && <div className="muted" style={{ fontSize: 12.5 }}>{t("ops.onBehalf")} {lang === "ar" ? x.original_ar : x.original_en}</div>}
              {x.comment && <div style={{ fontSize: 13 }}>“{x.comment}”</div>}
              {x.acted_at && <div className="muted" style={{ fontSize: 12 }}>{fmtDate(x.acted_at, lang, true)}</div>}
            </div>
            <DocBadge status={x.status} dict="approvalStatus" />
          </div>
        ))}</div>
      )}
    </Section>
  );
}

function Side({ d }: { d: any }) {
  const { t } = useTranslation();
  return (
    <div>
      {d.approvals && <Chain tasks={d.approvals} revision={d.revision ?? 1} />}
      <Section icon="calendar" title={t("ops.timeline")}><Timeline events={d.events ?? []} /></Section>
    </div>
  );
}

function ItemPicker({ onPick }: { onPick: (it: any) => void }) {
  const { t } = useTranslation();
  const L = useL();
  const [q, setQ] = useState("");
  const r = useQuery({ queryKey: ["item-pick", q], queryFn: () => api.get("/api/items", { q, status: "active", pageSize: 6 }), enabled: q.length >= 2 });
  return (
    <div>
      <div className="input-wrap"><Icon name="search" /><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("ops.addLine")} /></div>
      {q.length >= 2 && (r.data?.data ?? []).length > 0 && (
        <div className="chain" style={{ marginTop: 6 }}>{r.data.data.map((it: any) => (
          <button type="button" key={it.id} className="chain__step" style={{ cursor: "pointer", textAlign: "start" }} onClick={() => { onPick(it); setQ(""); }}>
            <span className="mono">{it.item_code}</span><span style={{ flex: 1 }}>{L(it)}</span><Icon name="plus" className="icon icon-sm" />
          </button>
        ))}</div>
      )}
    </div>
  );
}

const useWarehouses = () => useQuery({ queryKey: ["warehouses"], queryFn: () => api.get("/api/warehouses") });

function WhSelect({ value, onChange, label, exclude }: { value: string; onChange: (v: string) => void; label: string; exclude?: string }) {
  const L = useL();
  const w = useWarehouses();
  return (
    <Field label={label} required><select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>{(w.data?.data ?? []).filter((x: any) => x.id !== exclude).map((x: any) => <option key={x.id} value={x.id}>{x.code} — {L(x)}</option>)}
    </select></Field>
  );
}

function ListCard({ head, rows, empty }: { head: ReactNode; rows: ReactNode; empty: boolean }) {
  return empty ? <Empty /> : <div className="table-wrap"><table className="table"><thead><tr>{head}</tr></thead><tbody>{rows}</tbody></table></div>;
}

// ============================================================ approvals inbox
export function ApprovalsPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const nav = useNavigate();
  const r = useQuery({ queryKey: ["approvals-inbox"], queryFn: () => api.get("/api/approvals/inbox") });
  return (
    <>
      <PageHead icon="check" title={t("inv.approvals")} lead={t("inv.approvalsLead")} />
      <section className="card">
        {r.isLoading ? <Loading /> : (
          <ListCard empty={!r.data.data.length}
            head={<><th>{t("inv.docType")}</th><th>{t("common.code")}</th><th className="c">{t("ops.level")}</th><th className="c">{t("ops.value")}</th><th>{t("ops.sla")}</th></>}
            rows={r.data.data.map((x: any) => (
              <tr key={x.id} className="is-clickable" onClick={() => nav(`${DOC_ROUTE[x.doc_type]}/${x.doc_id}`)}>
                <td>{t(`docType.${x.doc_type}`)}{x.is_escalation && <div className="overdue">{t("ops.escalation")}</div>}{x.original_assignee_id && <div className="muted" style={{ fontSize: 12 }}>{t("ops.onBehalf")}</div>}</td>
                <td className="mono"><Link to={`${DOC_ROUTE[x.doc_type]}/${x.doc_id}`}>{x.doc_no}</Link></td>
                <td className="n">{x.level}</td><td className="n">{fmtSar(x.value)}</td>
                <td><small className={x.due_at && new Date(x.due_at) < new Date() ? "overdue" : "muted"}>{x.due_at ? fmtDate(x.due_at, lang, true) : "—"}</small></td>
              </tr>
            ))} />
        )}
      </section>
    </>
  );
}

// ============================================================ transfers
export function TransfersPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { can } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const r = useQuery({ queryKey: ["transfers"], queryFn: () => api.get("/api/transfers") });
  return (
    <>
      <PageHead icon="slides" title={t("inv.transfers")} actions={<>
        {can("transfer.bin") && <Link className="btn btn--secondary" to="/m/move"><Icon name="map" />{t("inv.moves")}</Link>}
        {can("transfer.request") && <button className="btn btn--primary" onClick={() => setOpen(true)}><Icon name="plus" />{t("inv.newTransfer")}</button>}
      </>} />
      <section className="card">
        {r.isLoading ? <Loading /> : (
          <ListCard empty={!r.data.data.length}
            head={<><th>{t("common.code")}</th><th>{t("inv.fromWh")}</th><th>{t("inv.toWh")}</th><th className="col-opt">{t("ops.requester")}</th><th className="c">{t("ops.lines")}</th>
              <th className="c col-opt">{t("ops.value")}</th><th className="c">{t("common.status")}</th><th className="col-opt">{t("common.updatedAt")}</th></>}
            rows={r.data.data.map((x: any) => (
              <tr key={x.id} className="is-clickable" onClick={() => nav(`/transfers/${x.id}`)}>
                <td className="mono"><Link to={`/transfers/${x.id}`} onClick={(e) => e.stopPropagation()}>{x.tr_no}</Link>{x.has_discrepancy && <div className="overdue">{t("inv.discrepancy")}</div>}</td>
                <td className="mono">{x.from_code}</td><td className="mono">{x.to_code}</td>
                <td className="col-opt">{lang === "ar" ? x.requester_ar : x.requester_en}</td><td className="n">{x.lines}</td>
                <td className="n col-opt">{fmtSar(x.estimated_value)}</td><td className="c"><St s={x.status} /></td><td className="col-opt"><small>{fmtDate(x.updated_at, lang, true)}</small></td>
              </tr>
            ))} />
        )}
      </section>
      {open && <TransferModal onClose={() => setOpen(false)} />}
    </>
  );
}

function TransferModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const L = useL();
  const nav = useNavigate();
  const a = useAct([["transfers"]]);
  const [f, setF] = useState({ fromWarehouseId: "", toWarehouseId: "", reason: "", neededBy: "" });
  const [lines, setLines] = useState<{ item: any; qty: string; available?: number }[]>([]);
  useEffect(() => {
    if (!f.fromWarehouseId) return;
    Promise.all(lines.map((l) => api.get("/api/stock/available", { itemId: l.item.id, warehouseId: f.fromWarehouseId }).then((r) => r.available).catch(() => undefined)))
      .then((av) => setLines((ls) => ls.map((l, i) => ({ ...l, available: av[i] }))));
  }, [f.fromWarehouseId, lines.length]);
  const valid = f.fromWarehouseId && f.toWarehouseId && lines.length > 0 && lines.every((l) => Number(l.qty) > 0);
  const save = (submit: boolean) => a.run(async () => {
    const tr = await api.post("/api/transfers", { ...f, neededBy: f.neededBy || null, lines: lines.map((l) => ({ itemId: l.item.id, qty: Number(l.qty) })) });
    if (submit) await api.post(`/api/transfers/${tr.id}/submit`);
    return tr;
  }, (tr) => nav(`/transfers/${tr.id}`));
  return (
    <Modal wide title={t("inv.newTransfer")} onClose={onClose} footer={<>
      <button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn--secondary" disabled={!valid || a.busy} onClick={() => save(false)}>{t("ops.saveDraft")}</button>
      <button className="btn btn--primary" disabled={!valid || a.busy} onClick={() => save(true)}>{t("ops.submit")}</button></>}>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <WhSelect label={t("inv.fromWh")} value={f.fromWarehouseId} onChange={(v) => setF({ ...f, fromWarehouseId: v })} />
        <WhSelect label={t("inv.toWh")} value={f.toWarehouseId} exclude={f.fromWarehouseId} onChange={(v) => setF({ ...f, toWarehouseId: v })} />
        <Field label={t("inv.reason")}><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        <Field label={t("ops.neededBy")}><input className="input" type="date" value={f.neededBy} onChange={(e) => setF({ ...f, neededBy: e.target.value })} /></Field>
      </div>
      <ItemPicker onPick={(it) => !lines.some((l) => l.item.id === it.id) && setLines([...lines, { item: it, qty: "1" }])} />
      {lines.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 10 }}><table className="table"><thead><tr><th>{t("ops.item")}</th><th className="c">{t("ops.available")}</th><th className="c">{t("ops.qty")}</th><th /></tr></thead>
          <tbody>{lines.map((l, i) => (
            <tr key={l.item.id}><td><span className="mono">{l.item.item_code}</span><br />{L(l.item)}</td><td className="n">{fmtNum(l.available)}</td>
              <td className="n"><input className="input" style={{ width: 90 }} type="number" min="0" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} /></td>
              <td><button className="btn btn--ghost btn--sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}>{t("common.delete")}</button></td></tr>
          ))}</tbody></table></div>
      )}
    </Modal>
  );
}

export function TransferDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const r = useQuery({ queryKey: ["transfer", id], queryFn: () => api.get(`/api/transfers/${id}`) });
  const a = useAct([["transfer", id!], ["transfers"], ["approvals-inbox"]]);
  const [recv, setRecv] = useState<Record<string, string>>({});
  if (r.isLoading) return <Loading />;
  const d = r.data;
  const steps = ["draft", "pending_approval", "approved", "in_transit", "closed"];
  const idx = steps.indexOf(d.status === "received" ? "in_transit" : d.status);
  return (
    <>
      <PageHead icon="slides" title={d.tr_no} crumbs={<Link to="/transfers">{t("inv.transfers")}</Link>} actions={<>
        <St s={d.status} />
        {d.actions.submit && <button className="btn btn--primary" disabled={a.busy} onClick={() => a.run(() => api.post(`/api/transfers/${id}/submit`))}>{t("ops.submit")}</button>}
        {d.actions.decide && <DecisionBar docType="TR" id={id!} keys={[["transfer", id!], ["approvals-inbox"]]} />}
        {d.actions.ship && <button className="btn btn--primary" disabled={a.busy} onClick={() => a.run(() => api.post(`/api/transfers/${id}/ship`))}><Icon name="slides" />{t("inv.ship")}</button>}
        {d.actions.receive && <button className="btn btn--primary" disabled={a.busy} onClick={() => a.run(() => api.post(`/api/transfers/${id}/receive`,
          Object.keys(recv).length ? { lines: d.shipments.map((s: any) => ({ shipmentId: s.id, qty: Number(recv[s.id] ?? s.qty) })) } : {}))}><Icon name="download" />{t("inv.receive")}</button>}
      </>} />
      <section className="card section">
        <div className="steps">{steps.map((s, i) => <div key={s} className={`step${i < idx || d.status === "closed" ? " is-done" : ""}${i === idx && d.status !== "closed" ? " is-current" : ""}`}>{t(`docStatus.${s}`)}</div>)}</div>
        <dl className="dl">
          <div><dt>{t("inv.fromWh")}</dt><dd>{d.from_code} — {L(d, "from")}</dd></div>
          <div><dt>{t("inv.toWh")}</dt><dd>{d.to_code} — {L(d, "to")}</dd></div>
          <div><dt>{t("ops.requester")}</dt><dd>{lang === "ar" ? d.requester_ar : d.requester_en}</dd></div>
          <div><dt>{t("ops.value")}</dt><dd>{fmtSar(d.estimated_value)}</dd></div>
          {d.reason && <div><dt>{t("inv.reason")}</dt><dd>{d.reason}</dd></div>}
          {d.shipped_at && <div><dt>{t("inv.shipped")}</dt><dd>{fmtDate(d.shipped_at, lang, true)}</dd></div>}
          {d.received_at && <div><dt>{t("inv.receivedQty")}</dt><dd>{fmtDate(d.received_at, lang, true)}</dd></div>}
        </dl>
        {d.has_discrepancy && <div style={{ marginTop: 12 }}><Alert kind="warning">{t("inv.discrepancy")} — <Link to="/adjustments">{t("inv.adjustments")}</Link></Alert></div>}
      </section>
      <div className="grid grid--2-1">
        <div>
          <Section icon="table" title={t("ops.lines")}>
            <div className="table-wrap"><table className="table"><thead><tr><th>{t("ops.item")}</th><th className="c">{t("ops.requested")}</th><th className="c">{t("inv.shipped")}</th><th className="c">{t("inv.receivedQty")}</th></tr></thead>
              <tbody>{d.lines.map((l: any) => (
                <tr key={l.id}><td><Link className="mono" to={`/items/${l.item_id}`}>{l.item_code}</Link><br />{L(l)}</td>
                  <td className="n">{fmtNum(l.qty_requested)} <small className="muted">{l.uom_code}</small></td><td className="n">{fmtNum(l.qty_shipped)}</td><td className="n"><b>{fmtNum(l.qty_received)}</b></td></tr>
              ))}</tbody></table></div>
          </Section>
          {d.shipments.length > 0 && (
            <Section icon="map" title={t("inv.shipments")}>
              <div className="table-wrap"><table className="table"><thead><tr><th>{t("ops.item")}</th><th>{t("inv.fromBin")}</th><th>{t("ops.lot")}</th><th className="c">{t("inv.shipped")}</th>
                <th className="c">{t("inv.receivedQty")}</th></tr></thead>
                <tbody>{d.shipments.map((s: any) => (
                  <tr key={s.id}><td className="mono">{s.item_code}</td><td className="mono">{s.from_code}<br /><small className="muted">→ {s.transit_code}</small></td>
                    <td className="mono">{s.serial_no ?? s.lot_no ?? "—"}</td><td className="n">{fmtNum(s.qty)}</td>
                    <td className="n">{d.actions.receive
                      ? <input className="input" type="number" min="0" max={s.qty} style={{ width: 90 }} value={recv[s.id] ?? String(s.qty)} onChange={(e) => setRecv({ ...recv, [s.id]: e.target.value })} />
                      : fmtNum(s.qty_received)}</td></tr>
                ))}</tbody></table></div>
            </Section>
          )}
        </div>
        <Side d={d} />
      </div>
    </>
  );
}

// ============================================================ returns, quarantine, RTV
export function ReturnsPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const { can } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") ?? "returns";
  const [open, setOpen] = useState(false);
  const [act, setAct] = useState<{ kind: "release" | "damaged" | "rtv" | "disposal"; b: any } | null>(null);
  const r = useQuery({ queryKey: ["returns"], queryFn: () => api.get("/api/returns") });
  const q = useQuery({ queryKey: ["quarantine"], queryFn: () => api.get("/api/quarantine"), enabled: can("warehouse.read") });
  return (
    <>
      <PageHead icon="download" title={t("inv.returns")} actions={can("return.warehouse") && <button className="btn btn--primary" onClick={() => setOpen(true)}><Icon name="plus" />{t("inv.newReturn")}</button>} />
      <section className="card">
        <Tabs tabs={[{ id: "returns", label: t("inv.returns") }, ...(can("warehouse.read") ? [{ id: "quarantine", label: t("inv.quarantineStock"), count: q.data?.data.length }] : [])]}
          value={tab} onChange={(v) => setSp({ tab: v })} />
        {tab === "returns" ? (r.isLoading ? <Loading /> : (
          <ListCard empty={!r.data.data.length}
            head={<><th>{t("common.code")}</th><th>{t("inv.returnType")}</th><th>{t("ops.warehouse")}</th><th className="col-opt">{t("ops.supplier")} / {t("ops.requester")}</th>
              <th className="c">{t("ops.lines")}</th><th className="c col-opt">{t("ops.value")}</th><th className="c">{t("common.status")}</th></>}
            rows={r.data.data.map((x: any) => (
              <tr key={x.id} className="is-clickable" onClick={() => nav(`/returns/${x.id}`)}>
                <td className="mono"><Link to={`/returns/${x.id}`} onClick={(e) => e.stopPropagation()}>{x.ret_no}</Link></td>
                <td>{t(x.return_type === "to_vendor" ? "inv.toVendor" : "inv.toWarehouse")}</td><td className="mono">{x.warehouse_code}</td>
                <td className="col-opt">{x.return_type === "to_vendor" ? L(x, "supplier") : lang === "ar" ? x.returned_by_ar : x.returned_by_en}</td>
                <td className="n">{x.lines}</td><td className="n col-opt">{fmtSar(x.estimated_value)}</td><td className="c"><St s={x.status} /></td>
              </tr>
            ))} />
        )) : (q.isLoading ? <Loading /> : (
          <ListCard empty={!q.data.data.length}
            head={<><th>{t("ops.item")}</th><th>{t("ops.location")}</th><th>{t("ops.lot")}</th><th className="c">{t("common.status")}</th><th className="c">{t("ops.free")}</th><th /></>}
            rows={q.data.data.map((b: any) => (
              <tr key={b.id}>
                <td><Link className="mono" to={`/items/${b.item_id}`}>{b.item_code}</Link><br />{L(b)}</td>
                <td className="mono">{b.full_code}</td>
                <td className="mono">{b.serial_no ?? b.lot_no ?? "—"}{b.expiry_date && <><br /><small className={new Date(b.expiry_date) <= new Date() ? "overdue" : "muted"}>{fmtDate(b.expiry_date, lang)}</small></>}</td>
                <td className="c"><St s={b.stock_status} dict="stockStatus" /></td><td className="n">{fmtNum(b.qty_free)}</td>
                <td><div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  {can("adjustment.approve") && b.stock_status === "quarantine" && <button className="btn btn--secondary btn--sm" onClick={() => setAct({ kind: "release", b })}>{t("inv.release")}</button>}
                  {can("adjustment.approve") && b.stock_status === "quarantine" && <button className="btn btn--ghost btn--sm" onClick={() => setAct({ kind: "damaged", b })}>{t("inv.toDamaged")}</button>}
                  {can("return.vendor") && <button className="btn btn--ghost btn--sm" onClick={() => setAct({ kind: "rtv", b })}>{t("inv.rtv")}</button>}
                  {can("disposal.recommend") && <button className="btn btn--ghost btn--sm" onClick={() => setAct({ kind: "disposal", b })}>{t("inv.newDisposal")}</button>}
                </div></td>
              </tr>
            ))} />
        ))}
      </section>
      {open && <ReturnModal onClose={() => setOpen(false)} />}
      {act && <StockActionModal kind={act.kind} b={act.b} onClose={() => setAct(null)} />}
    </>
  );
}

function ReturnModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const L = useL();
  const nav = useNavigate();
  const a = useAct([["returns"]]);
  const [f, setF] = useState({ warehouseId: "", reason: "" });
  const [lines, setLines] = useState<{ item: any; qty: string; lotNo: string; condition: string }[]>([]);
  const valid = f.warehouseId && f.reason.trim().length >= 3 && lines.length > 0 && lines.every((l) => Number(l.qty) > 0);
  return (
    <Modal wide title={t("inv.newReturn")} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn--primary" disabled={!valid || a.busy} onClick={() => a.run(() => api.post("/api/returns", { ...f, lines: lines.map((l) => ({ itemId: l.item.id, qty: Number(l.qty),
        lotNo: l.lotNo || null, serialNo: l.item.track_serial ? l.lotNo || null : null, condition: l.condition || undefined })) }), (r) => nav(`/returns/${r.id}`))}>{t("common.save")}</button></>}>
      <div className="grid" style={{ gridTemplateColumns: "1fr 2fr", gap: 12 }}>
        <WhSelect label={t("ops.warehouse")} value={f.warehouseId} onChange={(v) => setF({ ...f, warehouseId: v })} />
        <Field label={t("inv.reason")} required><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      </div>
      <ItemPicker onPick={(it) => setLines([...lines, { item: it, qty: "1", lotNo: "", condition: "" }])} />
      {lines.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 10 }}><table className="table"><thead><tr><th>{t("ops.item")}</th><th className="c">{t("ops.qty")}</th><th>{t("ops.lot")}</th><th>{t("inv.condition")}</th><th /></tr></thead>
          <tbody>{lines.map((l, i) => {
            const set = (p: any) => setLines(lines.map((x, j) => (j === i ? { ...x, ...p } : x)));
            return (
              <tr key={i}><td><span className="mono">{l.item.item_code}</span><br />{L(l.item)}</td>
                <td><input className="input" style={{ width: 80 }} type="number" min="0" value={l.qty} onChange={(e) => set({ qty: e.target.value })} /></td>
                <td><input className="input" style={{ width: 130 }} value={l.lotNo} onChange={(e) => set({ lotNo: e.target.value })} disabled={!l.item.track_batch && !l.item.track_serial} /></td>
                <td><select className="select" value={l.condition} onChange={(e) => set({ condition: e.target.value })}><option value="">—</option>
                  {["good", "quarantine", "damaged"].map((c) => <option key={c} value={c}>{t(`inv.${c}`)}</option>)}</select></td>
                <td><button className="btn btn--ghost btn--sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}>{t("common.delete")}</button></td></tr>
            );
          })}</tbody></table></div>
      )}
    </Modal>
  );
}

function StockActionModal({ kind, b, onClose }: { kind: "release" | "damaged" | "rtv" | "disposal"; b: any; onClose: () => void }) {
  const { t } = useTranslation();
  const L = useL();
  const nav = useNavigate();
  const a = useAct([["quarantine"], ["returns"], ["disposals"]]);
  const [qty, setQty] = useState(String(b.qty_free));
  const [reason, setReason] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [method, setMethod] = useState("scrap");
  const [committee, setCommittee] = useState<string[]>([]);
  const sup = useQuery({ queryKey: ["suppliers-all"], queryFn: () => api.get("/api/suppliers", { pageSize: 100 }), enabled: kind === "rtv" });
  const cdc = useQuery({ queryKey: ["cdc"], queryFn: () => api.get("/api/disposal-committee"), enabled: kind === "disposal" });
  const title = t(kind === "release" ? "inv.release" : kind === "damaged" ? "inv.toDamaged" : kind === "rtv" ? "inv.newRtv" : "inv.newDisposal");
  const go = () => a.run(() => {
    const body = { qty: Number(qty), reason };
    if (kind === "release" || kind === "damaged") return api.post(`/api/quarantine/${b.id}/status`, { ...body, to: kind === "release" ? "available" : "damaged" });
    if (kind === "rtv") return api.post("/api/rtv", { warehouseId: b.warehouse_id, supplierId, reason, lines: [{ balanceId: b.id, qty: Number(qty) }] });
    return api.post("/api/disposals", { warehouseId: b.warehouse_id, method, reason, committeeIds: committee, lines: [{ balanceId: b.id, qty: Number(qty) }] });
  }, (r) => { onClose(); if (kind === "rtv") nav(`/returns/${r.id}`); if (kind === "disposal") nav(`/disposals/${r.id}`); });
  const valid = Number(qty) > 0 && Number(qty) <= Number(b.qty_free) && reason.trim().length >= 3 && (kind !== "rtv" || supplierId) && (kind !== "disposal" || committee.length > 0);
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn--primary" disabled={!valid || a.busy} onClick={go}>{t("common.confirm")}</button></>}>
      <p><span className="mono">{b.item_code}</span> · {L(b)} · <span className="mono">{b.full_code}</span></p>
      <Field label={`${t("ops.qty")} (≤ ${fmtNum(b.qty_free)})`} required><input className="input" type="number" min="0" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
      {kind === "rtv" && <Field label={t("ops.supplier")} required><select className="select" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
        <option value="">—</option>{(sup.data?.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.code} — {L(s)}</option>)}</select></Field>}
      {kind === "disposal" && <>
        <Field label={t("inv.method")}><select className="select" value={method} onChange={(e) => setMethod(e.target.value)}>
          {["scrap", "sell", "donate", "recycle"].map((m) => <option key={m} value={m}>{t(`inv.${m}`)}</option>)}</select></Field>
        <Field label={t("inv.committee")} required hint={t("inv.sodNote")}>
          <div style={{ display: "grid", gap: 4 }}>{(cdc.data?.data ?? []).map((u: any) => (
            <label key={u.id} style={{ display: "flex", gap: 8 }}><input type="checkbox" checked={committee.includes(u.id)}
              onChange={(e) => setCommittee(e.target.checked ? [...committee, u.id] : committee.filter((x) => x !== u.id))} />{L(u)}</label>
          ))}</div>
        </Field>
      </>}
      <Field label={t("inv.reason")} required><textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
}

export function ReturnDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const r = useQuery({ queryKey: ["return", id], queryFn: () => api.get(`/api/returns/${id}`) });
  const a = useAct([["return", id!], ["returns"], ["quarantine"], ["approvals-inbox"]]);
  const [cond, setCond] = useState<Record<string, string>>({});
  const [credit, setCredit] = useState(false);
  if (r.isLoading) return <Loading />;
  const d = r.data;
  const rtv = d.return_type === "to_vendor";
  return (
    <>
      <PageHead icon="download" title={d.ret_no} crumbs={<Link to="/returns">{t("inv.returns")}</Link>} actions={<>
        <St s={d.status} />
        {d.actions.receive && <button className="btn btn--primary" disabled={a.busy || d.lines.some((l: any) => !(cond[l.id] ?? l.condition))}
          onClick={() => a.run(() => api.post(`/api/returns/${id}/receive`, { lines: d.lines.map((l: any) => ({ lineId: l.id, condition: cond[l.id] ?? l.condition })) }))}>
          <Icon name="check" />{t("inv.inspectReturn")}</button>}
        {d.actions.submit && <button className="btn btn--primary" disabled={a.busy} onClick={() => a.run(() => api.post(`/api/rtv/${id}/submit`))}>{t("ops.submit")}</button>}
        {d.actions.decide && <DecisionBar docType="RTV" id={id!} keys={[["return", id!], ["approvals-inbox"]]} />}
        {d.actions.ship && <button className="btn btn--primary" disabled={a.busy} onClick={() => a.run(() => api.post(`/api/rtv/${id}/ship`))}>{t("inv.ship")}</button>}
        {d.actions.creditNote && <button className="btn btn--primary" onClick={() => setCredit(true)}>{t("inv.creditNote")}</button>}
      </>} />
      <section className="card section">
        <dl className="dl">
          <div><dt>{t("inv.returnType")}</dt><dd>{t(rtv ? "inv.toVendor" : "inv.toWarehouse")}</dd></div>
          <div><dt>{t("ops.warehouse")}</dt><dd>{d.warehouse_code} — {L(d, "warehouse")}</dd></div>
          {rtv && <div><dt>{t("ops.supplier")}</dt><dd>{L(d, "supplier")}</dd></div>}
          {d.mr_no && <div><dt>{t("ops.requests")}</dt><dd className="mono">{d.mr_no}</dd></div>}
          <div><dt>{t("ops.value")}</dt><dd>{fmtSar(d.estimated_value)}</dd></div>
          {d.credit_note_ref && <div><dt>{t("inv.creditNoteRef")}</dt><dd className="mono">{d.credit_note_ref}</dd></div>}
          <div style={{ gridColumn: "1 / -1" }}><dt>{t("inv.reason")}</dt><dd>{d.reason}</dd></div>
        </dl>
      </section>
      <div className="grid grid--2-1">
        <Section icon="table" title={t("ops.lines")}>
          <div className="table-wrap"><table className="table"><thead><tr><th>{t("ops.item")}</th><th className="c">{t("ops.qty")}</th><th>{t("ops.lot")}</th>
            <th>{t("inv.condition")}</th><th>{t("ops.location")}</th></tr></thead>
            <tbody>{d.lines.map((l: any) => (
              <tr key={l.id}><td><Link className="mono" to={`/items/${l.item_id}`}>{l.item_code}</Link><br />{L(l)}</td>
                <td className="n">{fmtNum(l.qty)} <small className="muted">{l.uom_code}</small></td>
                <td className="mono">{l.stock_serial_no ?? l.stock_lot_no ?? l.serial_no ?? l.lot_no ?? "—"}</td>
                <td>{d.actions.receive
                  ? <select className="select" value={cond[l.id] ?? l.condition ?? ""} onChange={(e) => setCond({ ...cond, [l.id]: e.target.value })}><option value="">—</option>
                    {["good", "quarantine", "damaged"].map((c) => <option key={c} value={c}>{t(`inv.${c}`)}</option>)}</select>
                  : rtv ? <St s={l.from_status} dict="stockStatus" /> : l.condition ? t(`inv.${l.condition}`) : "—"}</td>
                <td className="mono">{rtv ? l.from_code : l.to_code ?? "—"}</td></tr>
            ))}</tbody></table></div>
        </Section>
        <Side d={{ ...d, approvals: rtv ? d.approvals : null }} />
      </div>
      {credit && <ReasonModal title={t("inv.creditNote")} label={t("inv.creditNoteRef")} onClose={() => setCredit(false)}
        onSubmit={(ref) => a.run(() => api.post(`/api/rtv/${id}/credit-note`, { creditNoteRef: ref }), () => setCredit(false))} />}
    </>
  );
}

// ============================================================ counting
export function CountsPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const { can } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const r = useQuery({ queryKey: ["counts"], queryFn: () => api.get("/api/counts") });
  const a = useAct([["counts"]]);
  return (
    <>
      <PageHead icon="table" title={t("inv.counts")} actions={<>
        {can("count.plan") && <button className="btn btn--secondary" disabled={a.busy} onClick={() => a.run(() => api.post("/api/classification/abc"))}><Icon name="chart" />{t("inv.classify")}</button>}
        {can("count.plan") && <button className="btn btn--primary" onClick={() => setOpen(true)}><Icon name="plus" />{t("inv.newCount")}</button>}
      </>} />
      <section className="card">
        {r.isLoading ? <Loading /> : (
          <ListCard empty={!r.data.data.length}
            head={<><th>{t("common.code")}</th><th>{t("inv.countType")}</th><th>{t("ops.warehouse")}</th><th className="col-opt">{t("inv.scheduledFor")}</th>
              <th style={{ minWidth: 140 }}>{t("inv.progress")}</th><th className="c">{t("common.status")}</th></>}
            rows={r.data.data.map((x: any) => (
              <tr key={x.id} className="is-clickable" onClick={() => nav(`/counts/${x.id}`)}>
                <td className="mono"><Link to={`/counts/${x.id}`} onClick={(e) => e.stopPropagation()}>{x.plan_no}</Link></td>
                <td>{t(`inv.${x.count_type}`)}{x.blind && <> · <small className="muted">{lang === "ar" ? "أعمى" : "blind"}</small></>}{x.abc_classes && <><br /><small className="muted ltr">{x.abc_classes.join(" ")}</small></>}</td>
                <td>{x.warehouse_code} <small className="muted">{L(x, "warehouse")}</small></td>
                <td className="col-opt"><small>{fmtDate(x.scheduled_for, lang)}</small></td>
                <td>{x.lines ? <><div className="meter"><div className="meter__track"><div className="meter__fill" style={{ width: `${Math.round((x.counted / x.lines) * 100)}%`, background: "var(--iarda-primary)" }} /></div>
                  <span className="meter__val">{x.counted}/{x.lines}</span></div>{x.recount > 0 && <small className="overdue">{t("inv.recount")} {x.recount}</small>}</> : "—"}</td>
                <td className="c"><St s={x.status} /></td>
              </tr>
            ))} />
        )}
      </section>
      {open && <CountPlanModal onClose={() => setOpen(false)} />}
    </>
  );
}

function CountPlanModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const L = useL();
  const nav = useNavigate();
  const a = useAct([["counts"]]);
  const [f, setF] = useState({ warehouseId: "", countType: "cycle", blind: true, abcClasses: ["A", "B", "C"], sampleSize: "15", scheduledFor: "", notes: "" });
  const [counters, setCounters] = useState<string[]>([]);
  const users = useQuery({ queryKey: ["counters", f.warehouseId], queryFn: () => api.get("/api/counters", { warehouseId: f.warehouseId }), enabled: !!f.warehouseId });
  const valid = f.warehouseId && counters.length > 0 && (f.countType !== "cycle" || f.abcClasses.length > 0);
  return (
    <Modal title={t("inv.newCount")} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn--primary" disabled={!valid || a.busy} onClick={() => a.run(() => api.post("/api/counts", {
        warehouseId: f.warehouseId, countType: f.countType, blind: f.blind, counterIds: counters, notes: f.notes || undefined, scheduledFor: f.scheduledFor || undefined,
        abcClasses: f.countType === "cycle" ? f.abcClasses : null, sampleSize: f.countType === "surprise" ? Number(f.sampleSize) : null,
      }), (p) => nav(`/counts/${p.id}`))}>{t("common.save")}</button></>}>
      <WhSelect label={t("ops.warehouse")} value={f.warehouseId} onChange={(v) => { setF({ ...f, warehouseId: v }); setCounters([]); }} />
      <Field label={t("inv.countType")}><select className="select" value={f.countType} onChange={(e) => setF({ ...f, countType: e.target.value })}>
        {["cycle", "annual", "surprise"].map((c) => <option key={c} value={c}>{t(`inv.${c}`)}</option>)}</select></Field>
      {f.countType === "cycle" && <Field label={t("inv.abc")}><div style={{ display: "flex", gap: 16 }}>{["A", "B", "C"].map((c) => (
        <label key={c} style={{ display: "flex", gap: 6 }}><input type="checkbox" checked={f.abcClasses.includes(c)}
          onChange={(e) => setF({ ...f, abcClasses: e.target.checked ? [...f.abcClasses, c].sort() : f.abcClasses.filter((x) => x !== c) })} />{c}</label>))}</div></Field>}
      {f.countType === "surprise" && <Field label={t("inv.sampleSize")}><input className="input" type="number" min="1" value={f.sampleSize} onChange={(e) => setF({ ...f, sampleSize: e.target.value })} /></Field>}
      <label style={{ display: "flex", gap: 8, margin: "6px 0 12px" }}><input type="checkbox" checked={f.blind} onChange={(e) => setF({ ...f, blind: e.target.checked })} />{t("inv.blind")}</label>
      <Field label={t("inv.counters")} required>
        <div style={{ display: "grid", gap: 4 }}>{(users.data?.data ?? []).map((u: any) => (
          <label key={u.id} style={{ display: "flex", gap: 8 }}><input type="checkbox" checked={counters.includes(u.id)}
            onChange={(e) => setCounters(e.target.checked ? [...counters, u.id] : counters.filter((x) => x !== u.id))} />{L(u)} <small className="muted">{u.role}</small></label>
        ))}</div>
      </Field>
      <Field label={t("inv.scheduledFor")}><input className="input" type="date" value={f.scheduledFor} onChange={(e) => setF({ ...f, scheduledFor: e.target.value })} /></Field>
      <Field label={t("common.notes")}><input className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
    </Modal>
  );
}

export function CountDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const r = useQuery({ queryKey: ["count", id], queryFn: () => api.get(`/api/counts/${id}`) });
  const a = useAct([["count", id!], ["counts"]]);
  const [filter, setFilter] = useState("all");
  if (r.isLoading) return <Loading />;
  const d = r.data;
  const lines = d.lines.filter((l: any) => filter === "all" || (filter === "variance" ? Number(l.variance_qty ?? (l.qty_count2 ?? l.qty_count1) - (l.qty_system2 ?? l.qty_system1)) !== 0 && l.qty_count1 != null : l.status === filter));
  const counted = d.lines.filter((l: any) => l.status !== "open").length;
  const varLines = d.lines.filter((l: any) => Number(l.variance_qty) !== 0 && l.variance_qty != null);
  const varValue = varLines.reduce((s: number, l: any) => s + Number(l.variance_value), 0);
  return (
    <>
      <PageHead icon="table" title={d.plan_no} crumbs={<Link to="/counts">{t("inv.counts")}</Link>} actions={<>
        <St s={d.status} />
        {d.actions.release && <button className="btn btn--primary" disabled={a.busy} onClick={() => a.run(() => api.post(`/api/counts/${id}/release`))}>{t("inv.releaseCount")}</button>}
        {d.actions.count && <Link className="btn btn--primary" to={`/m/count/${id}`}><Icon name="slides" />{t("inv.countOnPhone")}</Link>}
        {d.actions.finish && <button className="btn btn--primary" disabled={a.busy} onClick={() => a.run(() => api.post(`/api/counts/${id}/finish`))}>{t("inv.finishCount")}</button>}
      </>} />
      <section className="card section">
        <dl className="dl">
          <div><dt>{t("inv.countType")}</dt><dd>{t(`inv.${d.count_type}`)}{d.abc_classes ? ` · ${d.abc_classes.join(" ")}` : ""}</dd></div>
          <div><dt>{t("ops.warehouse")}</dt><dd>{d.warehouse_code} — {L(d, "warehouse")}</dd></div>
          <div><dt>{t("inv.scheduledFor")}</dt><dd>{fmtDate(d.scheduled_for, lang)}</dd></div>
          <div><dt>{t("inv.counters")}</dt><dd>{d.counters.map((c: any) => L(c)).join("، ")}</dd></div>
          <div><dt>{t("inv.progress")}</dt><dd className="ltr">{counted} / {d.lines.length}</dd></div>
          {!d.blindHidden && d.status !== "draft" && <div><dt>{t("inv.varianceValue")}</dt><dd>{fmtSar(varValue)} <small className="muted">({varLines.length})</small></dd></div>}
          {d.adjustment && <div><dt>{t("inv.adjustments")}</dt><dd><Link className="mono" to={`/adjustments/${d.adjustment.id}`}>{d.adjustment.adj_no}</Link> <St s={d.adjustment.status} /></dd></div>}
          {d.notes && <div style={{ gridColumn: "1 / -1" }}><dt>{t("common.notes")}</dt><dd>{d.notes}</dd></div>}
        </dl>
        {d.blindHidden && <div style={{ marginTop: 12 }}><Alert>{t("inv.blindHidden")}</Alert></div>}
      </section>
      <div>
        <Section icon="sheet" title={t("inv.varianceReport")} actions={<select className="select" style={{ width: "auto" }} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">{t("ops.all")}</option>{!d.blindHidden && <option value="variance">{t("inv.variance")}</option>}
          {["open", "recount", "counted", "final"].map((s) => <option key={s} value={s}>{t(`inv.${s}`)}</option>)}</select>}>
          {!lines.length ? <Empty /> : (
            <div className="table-wrap"><table className="table"><thead><tr>
              <th>{t("ops.location")}</th><th>{t("ops.item")}</th><th>{t("ops.lot")}</th>{!d.blindHidden && <th className="c">{t("inv.snapshot")}</th>}
              <th className="c">{t("inv.count1")}</th><th className="c">{t("inv.count2")}</th>{!d.blindHidden && <><th className="c">{t("inv.variance")}</th><th className="c col-opt">{t("inv.varianceValue")}</th></>}
              <th className="c">{t("common.status")}</th></tr></thead>
              <tbody>{lines.map((l: any) => {
                const v = l.variance_qty != null ? Number(l.variance_qty) : l.qty_count1 != null && !d.blindHidden ? Number(l.qty_count2 ?? l.qty_count1) - Number(l.qty_system2 ?? l.qty_system1) : null;
                return (
                  <tr key={l.id}><td className="mono">{l.full_code}</td>
                    <td><Link className="mono" to={`/items/${l.item_id}`}>{l.item_code}</Link> {l.abc_class && <span className="chip">{l.abc_class}</span>}{l.is_unplanned && <span className="badge badge--warning">{t("inv.unplanned")}</span>}<br /><small>{L(l)}</small></td>
                    <td className="mono">{l.serial_no ?? l.lot_no ?? "—"}</td>
                    {!d.blindHidden && <td className="n">{fmtNum(l.qty_snapshot)}</td>}
                    <td className="n">{fmtNum(l.qty_count1)}{l.c1_ar && <><br /><small className="muted">{lang === "ar" ? l.c1_ar : l.c1_en}</small></>}</td>
                    <td className="n">{fmtNum(l.qty_count2)}{l.c2_ar && <><br /><small className="muted">{lang === "ar" ? l.c2_ar : l.c2_en}</small></>}</td>
                    {!d.blindHidden && <><td className="n"><b style={{ color: v ? (v < 0 ? "var(--iarda-error, #B42318)" : "var(--iarda-gold)") : undefined }}>{v == null ? "—" : v > 0 ? `+${fmtNum(v)}` : fmtNum(v)}</b></td>
                      <td className="n col-opt">{l.variance_value != null ? fmtSar(l.variance_value) : "—"}</td></>}
                    <td className="c"><St s={l.status} /></td></tr>
                );
              })}</tbody></table></div>
          )}
        </Section>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 20 }}><Side d={d} /></div>
      </div>
    </>
  );
}

// ============================================================ adjustments
export function AdjustmentsPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { can } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const r = useQuery({ queryKey: ["adjustments"], queryFn: () => api.get("/api/adjustments") });
  const SRC: Record<string, string> = { count: "inv.srcCount", manual: "inv.srcManual", transit: "inv.srcTransit", quarantine: "inv.srcQuarantine" };
  return (
    <>
      <PageHead icon="sheet" title={t("inv.adjustments")} actions={can("adjustment.request") && <button className="btn btn--primary" onClick={() => setOpen(true)}><Icon name="plus" />{t("inv.newAdjustment")}</button>} />
      <section className="card">
        {r.isLoading ? <Loading /> : (
          <ListCard empty={!r.data.data.length}
            head={<><th>{t("common.code")}</th><th>{t("inv.source")}</th><th>{t("ops.warehouse")}</th><th className="c">{t("ops.lines")}</th>
              <th className="c">{t("inv.valueAbs")}</th><th className="c col-opt">{t("inv.valueNet")}</th><th className="c">{t("common.status")}</th><th className="col-opt">{t("common.updatedAt")}</th></>}
            rows={r.data.data.map((x: any) => (
              <tr key={x.id} className="is-clickable" onClick={() => nav(`/adjustments/${x.id}`)}>
                <td className="mono"><Link to={`/adjustments/${x.id}`} onClick={(e) => e.stopPropagation()}>{x.adj_no}</Link></td>
                <td>{t(SRC[x.source])}{(x.plan_no || x.tr_no) && <><br /><small className="mono muted">{x.plan_no ?? x.tr_no}</small></>}</td>
                <td className="mono">{x.warehouse_code}</td><td className="n">{x.lines}</td><td className="n">{fmtSar(x.value_abs)}</td>
                <td className="n col-opt">{fmtSar(x.value_net)}</td><td className="c"><St s={x.status} /></td><td className="col-opt"><small>{fmtDate(x.updated_at, lang, true)}</small></td>
              </tr>
            ))} />
        )}
      </section>
      {open && <AdjustmentModal onClose={() => setOpen(false)} />}
    </>
  );
}

function AdjustmentModal({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const L = useL();
  const nav = useNavigate();
  const a = useAct([["adjustments"]]);
  const [f, setF] = useState({ warehouseId: "", reason: "" });
  const [loc, setLoc] = useState("");
  const [lines, setLines] = useState<{ item: any; location: any; delta: string }[]>([]);
  const valid = f.warehouseId && f.reason.trim().length >= 3 && lines.length > 0 && lines.every((l) => Number(l.delta) !== 0 && !Number.isNaN(Number(l.delta)));
  async function addItem(it: any) {
    try {
      const l = await api.get("/api/locations/lookup", { code: loc });
      if (l.warehouse_id !== f.warehouseId || l.level !== "bin") throw new Error(i18n.language === "ar" ? "الخانة ليست في المستودع المحدد" : "Bin is not in the selected warehouse");
      setLines([...lines, { item: it, location: l, delta: "-1" }]);
    } catch (e) { toast.error(errorText(e, i18n.language)); }
  }
  return (
    <Modal wide title={t("inv.newAdjustment")} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn--primary" disabled={!valid || a.busy} onClick={() => a.run(async () => {
        const adj = await api.post("/api/adjustments", { ...f, lines: lines.map((l) => ({ locationId: l.location.id, itemId: l.item.id, qtyDelta: Number(l.delta) })) });
        await api.post(`/api/adjustments/${adj.id}/submit`);
        return adj;
      }, (adj) => nav(`/adjustments/${adj.id}`))}>{t("ops.submit")}</button></>}>
      <div className="grid" style={{ gridTemplateColumns: "1fr 2fr", gap: 12 }}>
        <WhSelect label={t("ops.warehouse")} value={f.warehouseId} onChange={(v) => setF({ ...f, warehouseId: v })} />
        <Field label={t("inv.reason")} required><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "1fr 2fr", gap: 12, alignItems: "end" }}>
        <Field label={t("ops.location")}><input className="input mono" value={loc} onChange={(e) => setLoc(e.target.value)} placeholder="RYD-A-01-01-A" /></Field>
        <div>{loc.length >= 3 && f.warehouseId ? <ItemPicker onPick={addItem} /> : <small className="muted">{t("ops.scanLocation")}</small>}</div>
      </div>
      {lines.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 10 }}><table className="table"><thead><tr><th>{t("ops.location")}</th><th>{t("ops.item")}</th><th className="c">{t("inv.delta")}</th><th /></tr></thead>
          <tbody>{lines.map((l, i) => (
            <tr key={i}><td className="mono">{l.location.full_code}</td><td><span className="mono">{l.item.item_code}</span><br />{L(l.item)}</td>
              <td><input className="input" type="number" style={{ width: 90 }} value={l.delta} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, delta: e.target.value } : x)))} /></td>
              <td><button className="btn btn--ghost btn--sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}>{t("common.delete")}</button></td></tr>
          ))}</tbody></table></div>
      )}
    </Modal>
  );
}

export function AdjustmentDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const r = useQuery({ queryKey: ["adjustment", id], queryFn: () => api.get(`/api/adjustments/${id}`) });
  const a = useAct([["adjustment", id!], ["adjustments"], ["approvals-inbox"]]);
  if (r.isLoading) return <Loading />;
  const d = r.data;
  const SRC: Record<string, string> = { count: "inv.srcCount", manual: "inv.srcManual", transit: "inv.srcTransit", quarantine: "inv.srcQuarantine" };
  return (
    <>
      <PageHead icon="sheet" title={d.adj_no} crumbs={<Link to="/adjustments">{t("inv.adjustments")}</Link>} actions={<>
        <St s={d.status} />
        {d.actions.submit && <button className="btn btn--primary" disabled={a.busy} onClick={() => a.run(() => api.post(`/api/adjustments/${id}/submit`))}>{t("ops.submit")}</button>}
        {d.actions.decide && <DecisionBar docType="ADJ" id={id!} keys={[["adjustment", id!], ["approvals-inbox"]]} />}
        {d.actions.post && <button className="btn btn--primary" disabled={a.busy} onClick={() => a.run(() => api.post(`/api/adjustments/${id}/post`))}><Icon name="check" />{t("inv.post")}</button>}
      </>} />
      <section className="card section">
        <dl className="dl">
          <div><dt>{t("inv.source")}</dt><dd>{t(SRC[d.source])}{d.plan_no && <> · <span className="mono">{d.plan_no}</span></>}{d.tr_no && <> · <span className="mono">{d.tr_no}</span></>}</dd></div>
          <div><dt>{t("ops.warehouse")}</dt><dd>{d.warehouse_code} — {L(d, "warehouse")}</dd></div>
          <div><dt>{t("inv.valueAbs")}</dt><dd>{fmtSar(d.value_abs)}</dd></div>
          <div><dt>{t("inv.valueNet")}</dt><dd>{fmtSar(d.value_net)}</dd></div>
          <div><dt>{t("common.createdBy")}</dt><dd>{lang === "ar" ? d.created_by_ar : d.created_by_en}</dd></div>
          {d.posted_at && <div><dt>{t("inv.post")}</dt><dd>{fmtDate(d.posted_at, lang, true)}</dd></div>}
          <div style={{ gridColumn: "1 / -1" }}><dt>{t("inv.reason")}</dt><dd>{d.reason}</dd></div>
        </dl>
        {d.status === "approved" && !d.actions.post && <div style={{ marginTop: 12 }}><Alert>{lang === "ar" ? "فصل المهام: يرحّل التسوية مستخدم غير منشئها ومعتمديها والقائمين بالجرد." : "SoD: the adjustment is posted by someone other than its creator, approvers and counters."}</Alert></div>}
      </section>
      <div className="grid grid--2-1">
        <Section icon="table" title={t("ops.lines")}>
          <div className="table-wrap"><table className="table"><thead><tr><th>{t("ops.location")}</th><th>{t("ops.item")}</th><th>{t("ops.lot")}</th><th className="c">{t("common.status")}</th>
            <th className="c">{t("inv.delta")}</th><th className="c">{t("ops.avgCost")}</th><th className="c">{t("ops.value")}</th></tr></thead>
            <tbody>{d.lines.map((l: any) => (
              <tr key={l.id}><td className="mono">{l.full_code}</td><td><Link className="mono" to={`/items/${l.item_id}`}>{l.item_code}</Link><br /><small>{L(l)}</small></td>
                <td className="mono">{l.serial_no ?? l.lot_no ?? "—"}</td><td className="c"><St s={l.stock_status} dict="stockStatus" /></td>
                <td className="n"><b>{Number(l.qty_delta) > 0 ? "+" : ""}{fmtNum(l.qty_delta)}</b></td><td className="n">{fmtNum(l.unit_cost, 4)}</td><td className="n">{fmtSar(l.value)}</td></tr>
            ))}</tbody></table></div>
        </Section>
        <Side d={d} />
      </div>
    </>
  );
}

// ============================================================ disposals
export function DisposalsPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { can } = useAuth();
  const nav = useNavigate();
  const r = useQuery({ queryKey: ["disposals"], queryFn: () => api.get("/api/disposals") });
  return (
    <>
      <PageHead icon="alert" title={t("inv.disposals")} lead={t("inv.sodNote")}
        actions={can("disposal.recommend") && <Link className="btn btn--primary" to="/returns?tab=quarantine"><Icon name="plus" />{t("inv.newDisposal")}</Link>} />
      <section className="card">
        {r.isLoading ? <Loading /> : (
          <ListCard empty={!r.data.data.length}
            head={<><th>{t("common.code")}</th><th>{t("inv.method")}</th><th>{t("ops.warehouse")}</th><th className="c">{t("ops.lines")}</th>
              <th className="c">{t("inv.totalValue")}</th><th className="c">{t("common.status")}</th><th className="col-opt">{t("common.updatedAt")}</th></>}
            rows={r.data.data.map((x: any) => (
              <tr key={x.id} className="is-clickable" onClick={() => nav(`/disposals/${x.id}`)}>
                <td className="mono"><Link to={`/disposals/${x.id}`} onClick={(e) => e.stopPropagation()}>{x.dsp_no}</Link></td>
                <td>{t(`inv.${x.method}`)}</td><td className="mono">{x.warehouse_code}</td><td className="n">{x.lines}</td>
                <td className="n">{fmtSar(x.total_value)}</td><td className="c"><St s={x.status} /></td><td className="col-opt"><small>{fmtDate(x.updated_at, lang, true)}</small></td>
              </tr>
            ))} />
        )}
      </section>
    </>
  );
}

export function DisposalDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const r = useQuery({ queryKey: ["disposal", id], queryFn: () => api.get(`/api/disposals/${id}`) });
  const a = useAct([["disposal", id!], ["disposals"], ["approvals-inbox"]]);
  if (r.isLoading) return <Loading />;
  const d = r.data;
  const minutes = d.attachments.filter((x: any) => x.category === "minutes");
  return (
    <>
      <PageHead icon="alert" title={d.dsp_no} crumbs={<Link to="/disposals">{t("inv.disposals")}</Link>} actions={<>
        <St s={d.status} />
        {d.actions.recommend && (
          <label className="btn btn--secondary" style={{ cursor: "pointer" }}><Icon name="pdf" />{t("inv.uploadMinutes")}
            <input type="file" accept="application/pdf" hidden onChange={(e) => {
              const f = e.target.files?.[0]; if (!f) return;
              const fd = new FormData();
              fd.append("ownerType", "disposal"); fd.append("ownerId", id!); fd.append("category", "minutes"); fd.append("file", f);
              a.run(() => api.post("/api/attachments", fd));
            }} /></label>
        )}
        {d.actions.recommend && <button className="btn btn--primary" disabled={a.busy || !minutes.length} onClick={() => a.run(() => api.post(`/api/disposals/${id}/recommend`))}>{t("inv.recommend")}</button>}
        {d.actions.decide && <DecisionBar docType="DSP" id={id!} keys={[["disposal", id!], ["approvals-inbox"]]} />}
        {d.actions.post && <button className="btn btn--primary" disabled={a.busy} onClick={() => a.run(() => api.post(`/api/disposals/${id}/post`))}><Icon name="check" />{t("inv.post")}</button>}
      </>} />
      <section className="card section">
        <dl className="dl">
          <div><dt>{t("inv.method")}</dt><dd>{t(`inv.${d.method}`)}</dd></div>
          <div><dt>{t("ops.warehouse")}</dt><dd>{d.warehouse_code} — {L(d, "warehouse")}</dd></div>
          <div><dt>{t("inv.totalValue")}</dt><dd>{fmtSar(d.total_value)}</dd></div>
          <div><dt>{t("inv.committee")}</dt><dd>{d.committee.map((c: any) => L(c)).join("، ")}</dd></div>
          <div><dt>{t("inv.minutes")}</dt><dd>{minutes.length ? minutes.map((m: any) => (
            <a key={m.id} href={`/api/attachments/${m.id}/content`} target="_blank" rel="noreferrer" style={{ display: "block" }}><Icon name="pdf" className="icon icon-sm" /> {m.file_name}</a>
          )) : <span className="overdue">{t("inv.none")}</span>}</dd></div>
          {d.posted_at && <div><dt>{t("inv.post")}</dt><dd>{fmtDate(d.posted_at, lang, true)}</dd></div>}
          <div style={{ gridColumn: "1 / -1" }}><dt>{t("inv.reason")}</dt><dd>{d.reason}</dd></div>
        </dl>
        <div style={{ marginTop: 12 }}><Alert>{t("inv.sodNote")}</Alert></div>
      </section>
      <div className="grid grid--2-1">
        <Section icon="table" title={t("ops.lines")}>
          <div className="table-wrap"><table className="table"><thead><tr><th>{t("ops.location")}</th><th>{t("ops.item")}</th><th>{t("ops.lot")}</th><th className="c">{t("common.status")}</th>
            <th className="c">{t("ops.qty")}</th><th className="c">{t("ops.value")}</th></tr></thead>
            <tbody>{d.lines.map((l: any) => (
              <tr key={l.id}><td className="mono">{l.full_code}</td><td><Link className="mono" to={`/items/${l.item_id}`}>{l.item_code}</Link><br /><small>{L(l)}</small></td>
                <td className="mono">{l.serial_no ?? l.lot_no ?? "—"}{l.expiry_date && <><br /><small className="muted">{fmtDate(l.expiry_date, lang)}</small></>}</td>
                <td className="c"><St s={l.stock_status} dict="stockStatus" /></td><td className="n">{fmtNum(l.qty)} <small className="muted">{l.uom_code}</small></td><td className="n">{fmtSar(l.value)}</td></tr>
            ))}</tbody></table></div>
        </Section>
        <Side d={d} />
      </div>
    </>
  );
}
