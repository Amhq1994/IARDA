import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, type Page } from "../api";
import { useAuth } from "../auth";
import { Alert, Empty, Field, Icon, Loading, Modal, PageHead, Pagination, Section, Tabs, toast } from "../components/ui";
import { DocBadge, SignaturePad, Timeline } from "../components/ops";
import { errorText, fmtDate, fmtNum, fmtSar, useL } from "../util";

const TYPES = ["issue", "urgent", "work_order", "custody", "reservation"] as const;

// ============================================================ list
export function RequestsPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const { can } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const view = sp.get("view") ?? (can("request.approve") ? "approvals" : can("issue.execute") ? "fulfil" : "mine");
  const page = Number(sp.get("page") ?? 1);
  const [q, setQ] = useState("");
  const r = useQuery({ queryKey: ["requests", view, page, q], queryFn: () => api.get<Page<any>>("/api/requests", { view, page, q, pageSize: 25 }), placeholderData: (p) => p });
  const tabs = [
    ...(can("request.create") ? [{ id: "mine", label: t("ops.myRequests") }] : []),
    ...(can("request.approve") || can("delegation.own") ? [{ id: "approvals", label: t("ops.approvals") }] : []),
    ...(can("issue.execute") ? [{ id: "fulfil", label: t("ops.fulfil") }] : []),
    { id: "all", label: t("ops.all") },
  ];
  return (
    <>
      <PageHead icon="report" title={t("ops.requests")} actions={can("request.create") && <Link className="btn btn--primary" to="/requests/new"><Icon name="plus" />{t("ops.newRequest")}</Link>} />
      <section className="card">
        <Tabs tabs={tabs} value={view} onChange={(v) => setSp({ view: v })} />
        <div className="toolbar"><div className="field grow"><div className="input-wrap"><Icon name="search" />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="MR-1448-…" /></div></div></div>
        {r.isLoading ? <Loading /> : !r.data?.data.length ? <Empty /> : (
          <>
            <div className="table-wrap"><table className="table"><thead><tr>
              <th>{t("common.code")}</th><th>{t("ops.requestType")}</th><th className="col-opt">{t("ops.requester")}</th><th className="col-opt">{t("ops.warehouse")}</th>
              <th className="c">{t("ops.lines")}</th><th className="c col-opt">{t("ops.value")}</th><th className="c">{t("common.status")}</th><th className="col-opt">{t("common.updatedAt")}</th>
            </tr></thead><tbody>
              {r.data.data.map((m) => (
                <tr key={m.id} className="is-clickable" onClick={() => nav(`/requests/${m.id}`)}>
                  <td className="mono"><Link to={`/requests/${m.id}`} onClick={(e) => e.stopPropagation()}>{m.mr_no}</Link>{m.is_overdue && <div className="overdue">⏱ {t("ops.overdue")}</div>}</td>
                  <td>{t(`mrType.${m.request_type}`)}{m.request_type === "urgent" && " ⚡"}</td>
                  <td className="col-opt">{lang === "ar" ? m.requester_ar : m.requester_en}<br /><small className="muted">{lang === "ar" ? m.org_ar : m.org_en}</small></td>
                  <td className="col-opt">{L(m, "warehouse_name")}</td>
                  <td className="n">{m.lines}</td><td className="n col-opt">{fmtSar(m.estimated_value)}</td>
                  <td className="c"><DocBadge status={m.status} /></td><td className="col-opt"><small>{fmtDate(m.updated_at, lang, true)}</small></td>
                </tr>
              ))}
            </tbody></table></div>
            <Pagination page={r.data.page} pageSize={r.data.pageSize} total={r.data.total} onPage={(p) => setSp({ view, page: String(p) })} />
          </>
        )}
      </section>
    </>
  );
}

// ============================================================ create / edit
interface Line { itemId: string; code: string; name: string; uom: string; qty: string; available?: number }

export function RequestFormPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const nav = useNavigate();
  const qc = useQueryClient();
  const whs = useQuery({ queryKey: ["warehouses"], queryFn: () => api.get("/api/warehouses") });
  const existing = useQuery({ queryKey: ["request", id], queryFn: () => api.get(`/api/requests/${id}`), enabled: !!id });
  const [f, setF] = useState({ requestType: "issue", warehouseId: "", neededBy: "", purpose: "", justification: "", workOrderRef: "" });
  const [lines, setLines] = useState<Line[]>([]);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState<any>(null);
  const [ack, setAck] = useState(false);

  useEffect(() => {
    const m: any = existing.data;
    if (!m) return;
    setF({ requestType: m.request_type, warehouseId: m.warehouse_id, neededBy: m.needed_by?.slice(0, 10) ?? "", purpose: m.purpose ?? "", justification: m.justification ?? "", workOrderRef: m.work_order_ref ?? "" });
    setLines(m.lines.map((l: any) => ({ itemId: l.item_id, code: l.item_code, name: L(l), uom: L(l, "uom_name"), qty: String(l.qty_requested), available: Number(l.available) })));
    if (m.validation) setValidation(m.validation);
  }, [existing.data]);
  useEffect(() => { if (!f.warehouseId && whs.data?.data[0]) setF((x) => ({ ...x, warehouseId: whs.data.data[0].id })); }, [whs.data]);

  const items = useQuery({ queryKey: ["items-mr", search], queryFn: () => api.get("/api/items", { q: search, status: "active", pageSize: 8 }), enabled: search.length >= 2 });
  // refresh availability whenever the warehouse changes
  useEffect(() => {
    if (!f.warehouseId) return;
    Promise.all(lines.map((l) => api.get("/api/stock/available", { itemId: l.itemId, warehouseId: f.warehouseId }).then((r) => r.available).catch(() => undefined)))
      .then((av) => setLines((ls) => ls.map((l, i) => ({ ...l, available: av[i] }))));
  }, [f.warehouseId, lines.length]);

  const body = useMemo(() => ({
    requestType: f.requestType, warehouseId: f.warehouseId, neededBy: f.neededBy || null, purpose: f.purpose || null,
    justification: f.justification || null, workOrderRef: f.workOrderRef || null,
    lines: lines.map((l) => ({ itemId: l.itemId, qty: Number(l.qty) })),
  }), [f, lines]);

  async function save(andSubmit: boolean) {
    setBusy(true);
    try {
      let mrId = id;
      if (id) await api.put(`/api/requests/${id}`, { ...body, version: (existing.data as any).version });
      else mrId = (await api.post("/api/requests", body)).id;
      if (andSubmit) {
        try {
          await api.post(`/api/requests/${mrId}/submit`, { acknowledgeWarnings: ack });
          toast.success(t("common.saved"));
        } catch (e) {
          if (e instanceof ApiError && e.code === "validation_failed") {
            setValidation(e.body.details);
            qc.invalidateQueries({ queryKey: ["request", mrId] });
            if (!id) nav(`/requests/${mrId}/edit`, { replace: true });
            return;
          }
          throw e;
        }
      }
      qc.invalidateQueries({ queryKey: ["requests"] });
      nav(`/requests/${mrId}`);
    } catch (e) { toast.error(errorText(e, lang)); } finally { setBusy(false); }
  }

  const total = lines.length > 0 && lines.every((l) => Number(l.qty) > 0);
  const warnOnly = validation && !validation.errors?.length && validation.warnings?.length;
  return (
    <>
      <PageHead icon="plus" title={id ? `${t("common.edit")} — ${(existing.data as any)?.mr_no ?? ""}` : t("ops.newRequest")}
        crumbs={<><Link to="/requests">{t("ops.requests")}</Link></>} />
      {validation && (validation.errors?.length > 0 || validation.warnings?.length > 0) && (
        <div className="section">
          <Alert kind={validation.errors?.length ? "error" : "warning"}>
            <b>{t("ops.validationFailed")}</b>
            <ul style={{ margin: "6px 0 0", paddingInlineStart: 18 }}>
              {[...(validation.errors ?? []), ...(validation.warnings ?? [])].map((v: any, i: number) => (
                <li key={i}>{t(`vcode.${v.code}`, { defaultValue: v.code })}{v.item && <> — <span className="mono">{v.item}</span></>}
                  {v.available !== undefined && <> ({t("ops.available")}: {fmtNum(v.available)})</>}{v.mr && <> — <span className="mono">{v.mr}</span></>}
                  {v.remaining !== undefined && <> ({fmtSar(v.remaining)})</>}</li>
              ))}
            </ul>
            {warnOnly && <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />{t("ops.warningsAck")}</label>}
          </Alert>
        </div>
      )}
      <div className="grid grid--2-1">
        <div>
          <Section icon="report" title={t("common.details")}>
            <div className="form-grid">
              <Field label={t("ops.requestType")} required><select className="select" value={f.requestType} onChange={(e) => setF({ ...f, requestType: e.target.value })}>
                {TYPES.map((x) => <option key={x} value={x}>{t(`mrType.${x}`)}</option>)}</select></Field>
              <Field label={t("ops.warehouse")} required><select className="select" value={f.warehouseId} onChange={(e) => setF({ ...f, warehouseId: e.target.value })}>
                {(whs.data?.data ?? []).map((w: any) => <option key={w.id} value={w.id}>{L(w)}</option>)}</select></Field>
              <Field label={t("ops.neededBy")}><input className="input" type="date" value={f.neededBy} onChange={(e) => setF({ ...f, neededBy: e.target.value })} /></Field>
              {f.requestType === "work_order" && <Field label={t("ops.workOrder")} required><input className="input mono" dir="ltr" value={f.workOrderRef} onChange={(e) => setF({ ...f, workOrderRef: e.target.value })} placeholder="WO-1448-0000" /></Field>}
              <Field label={t("ops.purpose")}><input className="input" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></Field>
            </div>
            {f.requestType === "urgent" && <Field label={t("ops.justification")} required hint="≥ 10"><textarea className="input" value={f.justification} onChange={(e) => setF({ ...f, justification: e.target.value })} /></Field>}
          </Section>
          <Section icon="table" title={t("ops.lines")}>
            <div className="field" style={{ position: "relative" }}>
              <label>{t("ops.addLine")}</label>
              <div className="input-wrap"><Icon name="search" /><input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("item.lookupHint")} /></div>
              {search.length >= 2 && items.data?.data.length > 0 && (
                <div className="dup-list">{items.data.data.filter((x: any) => !lines.some((l) => l.itemId === x.id)).map((x: any) => (
                  <button key={x.id} type="button" className="dup" style={{ cursor: "pointer", font: "inherit", textAlign: "start" }}
                    onClick={() => { setLines([...lines, { itemId: x.id, code: x.item_code, name: L(x), uom: L(x, "uom_name"), qty: "1" }]); setSearch(""); }}>
                    <span><span className="mono">{x.item_code}</span> · {L(x)}</span><span className="muted">{L(x, "uom_name")}</span></button>
                ))}</div>
              )}
            </div>
            {lines.length === 0 ? <Empty /> : (
              <div className="table-wrap"><table className="table"><thead><tr><th>{t("ops.item")}</th><th className="c">{t("ops.available")}</th><th className="c">{t("ops.qty")}</th><th></th></tr></thead>
                <tbody>{lines.map((l, i) => (
                  <tr key={l.itemId}>
                    <td><span className="mono">{l.code}</span><br />{l.name}</td>
                    <td className="n">{l.available === undefined ? "…" : <span style={{ color: (l.available ?? 0) < Number(l.qty) ? "var(--iarda-error)" : undefined }}>{fmtNum(l.available)}</span>}</td>
                    <td className="c"><input className="input qty-input" type="number" min={0} step="any" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} /> <small className="muted">{l.uom}</small></td>
                    <td className="actions"><button className="btn btn--ghost btn--sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}>{t("common.delete")}</button></td>
                  </tr>
                ))}</tbody></table></div>
            )}
          </Section>
        </div>
        <div>
          <div className="form-actions" style={{ justifyContent: "stretch", flexDirection: "column" }}>
            <button className="btn btn--primary btn--block" disabled={busy || !total || (warnOnly && !ack)} onClick={() => save(true)}><Icon name="check" />{t("ops.submit")}</button>
            <button className="btn btn--secondary btn--block" disabled={busy || !total} onClick={() => save(false)}>{t("ops.saveDraft")}</button>
          </div>
        </div>
      </div>
    </>
  );
}

// ============================================================ detail
const STEPS = ["draft", "pending_approval", "approved", "reserved", "picking", "ready_for_delivery", "closed"];

export function RequestDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [modal, setModal] = useState<null | string>(null);
  const q = useQuery({ queryKey: ["request", id], queryFn: () => api.get(`/api/requests/${id}`) });
  const m: any = q.data;
  const refresh = () => { qc.invalidateQueries({ queryKey: ["request", id] }); qc.invalidateQueries({ queryKey: ["requests"] }); qc.invalidateQueries({ queryKey: ["dashboard"] }); qc.invalidateQueries({ queryKey: ["notifications"] }); };
  async function act(fn: () => Promise<any>, msg?: string) {
    try { const r = await fn(); toast.success(msg ?? t("common.saved")); refresh(); setModal(null); return r; } catch (e) { toast.error(errorText(e, lang)); }
  }
  if (q.isLoading) return <Loading />;
  if (!m) return <Empty text={t("errors.notFound")} />;
  const a = m.actions;
  const stepIdx = Math.max(0, STEPS.indexOf(m.status === "partially_delivered" ? "ready_for_delivery" : m.status === "delivered" ? "closed" : m.status));
  const revTasks = m.approvals.filter((x: any) => x.revision === m.revision);

  return (
    <>
      <PageHead icon="report" title={`${t(`mrType.${m.request_type}`)} — ${m.mr_no}`}
        lead={<>{lang === "ar" ? m.requester_ar : m.requester_en} · {lang === "ar" ? m.org_ar : m.org_en} · <DocBadge status={m.status} />
          {m.is_overdue && <span className="overdue"> ⏱ {t("ops.overdue")}</span>}</>}
        crumbs={<Link to="/requests">{t("ops.requests")}</Link>}
        actions={<>
          {a.edit && <Link className="btn btn--secondary" to={`/requests/${id}/edit`}><Icon name="settings" />{t("common.edit")}</Link>}
          {a.submit && <button className="btn btn--primary" onClick={() => nav(`/requests/${id}/edit`)}><Icon name="check" />{t("ops.submit")}</button>}
          {a.decide && <>
            <button className="btn btn--primary" onClick={() => act(() => api.post(`/api/requests/${id}/decision`, { action: "approve" }))}><Icon name="check" />{t("ops.approve")}</button>
            <button className="btn btn--secondary" onClick={() => setModal("return")}>{t("ops.returnForRevision")}</button>
            <button className="btn btn--secondary" onClick={() => setModal("reject")}>{t("ops.reject")}</button>
          </>}
          {a.reserve && <button className="btn btn--primary" onClick={() => act(async () => {
            const r = await api.post(`/api/requests/${id}/reserve`);
            if (r.shortages?.length) toast.error(r.shortages.map((s: any) => `${s.item}: −${fmtNum(s.short)}`).join(" · "));
          })}><Icon name="lock" />{t("ops.reserve")}</button>}
          {a.releasePicks && <button className="btn btn--primary" onClick={() => setModal("picks")}><Icon name="table" />{t("ops.releasePicks")}</button>}
          {a.deliver && <button className="btn btn--primary" onClick={() => setModal("deliver")}><Icon name="check" />{t("ops.deliver")}</button>}
          {a.shortClose && <button className="btn btn--secondary" onClick={() => setModal("shortClose")}>{t("ops.shortClose")}</button>}
          {a.cancel && <button className="btn btn--ghost" onClick={() => setModal("cancel")}>{t("ops.cancel")}</button>}
        </>} />

      {m.status_reason && <div className="section"><Alert kind="warning">{t("common.reason")}: {m.status_reason}</Alert></div>}

      <section className="card section">
        <div className="steps">{STEPS.map((s, i) => (
          <div key={s} className={`step${i < stepIdx || m.status === "closed" ? " is-done" : ""}${i === stepIdx && m.status !== "closed" ? " is-current" : ""}`}>{t(`mrStatus.${s}`)}</div>
        ))}</div>
        <dl className="dl">
          <div><dt>{t("ops.warehouse")}</dt><dd>{L(m, "warehouse_name")}</dd></div>
          <div><dt>{t("ops.costCenter")}</dt><dd className="mono">{m.cost_center_code ?? "—"}</dd></div>
          <div><dt>{t("ops.value")}</dt><dd>{fmtSar(m.estimated_value)}</dd></div>
          <div><dt>{t("ops.neededBy")}</dt><dd>{m.needed_by ? fmtDate(m.needed_by, lang) : "—"}</dd></div>
          <div><dt>{t("ops.sla")}</dt><dd>{m.sla_due_at ? fmtDate(m.sla_due_at, lang, true) : "—"}</dd></div>
          {m.work_order_ref && <div><dt>{t("ops.workOrder")}</dt><dd className="mono">{m.work_order_ref}</dd></div>}
          {m.purpose && <div><dt>{t("ops.purpose")}</dt><dd>{m.purpose}</dd></div>}
          {m.justification && <div style={{ gridColumn: "1 / -1" }}><dt>{t("ops.justification")}</dt><dd>{m.justification}</dd></div>}
        </dl>
      </section>

      <div className="grid grid--2-1">
        <div>
          <Section icon="table" title={t("ops.lines")}>
            <div className="table-wrap"><table className="table"><thead><tr>
              <th>{t("ops.item")}</th><th className="c">{t("ops.requested")}</th><th className="c">{t("ops.approved")}</th><th className="c">{t("ops.reserved")}</th>
              <th className="c">{t("ops.picked")}</th><th className="c">{t("ops.issued")}</th><th className="c col-opt">{t("ops.available")}</th>
            </tr></thead><tbody>{m.lines.map((l: any) => (
              <tr key={l.id}><td><Link className="mono" to={`/items/${l.item_id}`}>{l.item_code}</Link><br />{L(l)}</td>
                <td className="n">{fmtNum(l.qty_requested)} <small className="muted">{l.uom_code}</small></td><td className="n">{fmtNum(l.qty_approved)}</td>
                <td className="n">{fmtNum(l.qty_reserved)}</td><td className="n">{fmtNum(l.qty_picked)}</td><td className="n"><b>{fmtNum(l.qty_issued)}</b></td>
                <td className="n col-opt">{fmtNum(l.available)}</td></tr>
            ))}</tbody></table></div>
          </Section>
          {m.pickTasks.length > 0 && (
            <Section icon="map" title={t("ops.pickList")}>
              <div className="table-wrap"><table className="table"><thead><tr><th>#</th><th>{t("ops.location")}</th><th>{t("ops.item")}</th><th>{t("ops.lot")}</th>
                <th className="c">{t("ops.qty")}</th><th className="c">{t("ops.picked")}</th><th className="c">{t("common.status")}</th></tr></thead>
                <tbody>{m.pickTasks.map((p: any) => (
                  <tr key={p.id}><td className="mono">{p.pick_no.slice(-4)}·{p.seq}</td><td className="mono">{p.full_code}</td><td className="mono">{p.item_code}</td>
                    <td className="mono">{p.serial_no ?? p.lot_no ?? "—"}{p.expiry_date && <><br /><small className="muted">{fmtDate(p.expiry_date, lang)}</small></>}</td>
                    <td className="n">{fmtNum(p.qty)}</td><td className="n">{fmtNum(p.qty_picked)}</td><td className="c"><span className="chip">{p.status}</span></td></tr>
                ))}</tbody></table></div>
              {m.status === "picking" && <p className="muted" style={{ marginTop: 10 }}><Icon name="info" className="icon icon-sm" /> <Link to={`/m/pick/${m.pickTasks[m.pickTasks.length - 1].pick_list_id}`}>{t("ops.openOnPhone")}</Link></p>}
            </Section>
          )}
          {m.deliveries.length > 0 && (
            <Section icon="check" title={t("ops.deliveryNote")}>
              {m.deliveries.map((d: any) => (
                <div className="kpi-target" key={d.id}><span><span className="mono">{d.dn_no}</span> · {d.received_by_name} · {fmtDate(d.signed_at, lang, true)}{d.is_partial && <> · <span className="badge badge--warning">{t("mrStatus.partially_delivered")}</span></>}</span>
                  <Link className="btn btn--ghost btn--sm" to={`/delivery-notes/${d.id}`}><Icon name="report" className="icon icon-sm" />{t("ops.print")}</Link></div>
              ))}
            </Section>
          )}
        </div>
        <div>
          <Section icon="shield" title={t("ops.chain")}>
            {revTasks.length === 0 ? <p className="muted">—</p> : (
              <div className="chain">{revTasks.map((x: any) => (
                <div key={x.id} className={`chain__step${x.status === "pending" ? " is-pending" : ""}`}>
                  <span className="chain__lvl">{x.level}</span>
                  <div style={{ flex: 1 }}>
                    <b style={{ color: "var(--iarda-primary-dark)", fontWeight: 500 }}>{lang === "ar" ? x.assignee_ar : x.assignee_en}</b>
                    {x.original_assignee_id && <div className="muted" style={{ fontSize: 12.5 }}>{t("ops.onBehalf")} {lang === "ar" ? x.original_ar : x.original_en}</div>}
                    {x.is_escalation && <div className="overdue">{t("ops.escalation")}</div>}
                    {x.comment && <div style={{ fontSize: 13 }}>“{x.comment}”</div>}
                    {x.acted_at && <div className="muted" style={{ fontSize: 12 }}>{fmtDate(x.acted_at, lang, true)}</div>}
                  </div>
                  <DocBadge status={x.status} dict="approvalStatus" />
                </div>
              ))}</div>
            )}
          </Section>
          <Section icon="calendar" title={t("ops.timeline")}><Timeline events={m.events} /></Section>
        </div>
      </div>

      {(modal === "reject" || modal === "return" || modal === "cancel" || modal === "shortClose") && (
        <ReasonModal title={t(modal === "reject" ? "ops.reject" : modal === "return" ? "ops.returnForRevision" : modal === "cancel" ? "ops.cancel" : "ops.shortClose")}
          onClose={() => setModal(null)}
          onSubmit={(reason) => act(() => modal === "cancel" ? api.post(`/api/requests/${id}/cancel`, { reason })
            : modal === "shortClose" ? api.post(`/api/requests/${id}/short-close`, { reason })
            : api.post(`/api/requests/${id}/decision`, { action: modal, comment: reason }))} />
      )}
      {modal === "picks" && <PickListModal warehouseId={m.warehouse_id} onClose={() => setModal(null)}
        onSubmit={(assignTo) => act(() => api.post(`/api/requests/${id}/pick-list`, { assignTo }))} />}
      {modal === "deliver" && <DeliverModal m={m} onClose={() => setModal(null)} onSubmit={(b) => act(async () => {
        const r = await api.post(`/api/requests/${id}/deliver`, b);
        nav(`/delivery-notes/${r.deliveryNoteId}`);
      })} />}
    </>
  );
}

function ReasonModal({ title, onClose, onSubmit }: { title: string; onClose: () => void; onSubmit: (r: string) => void }) {
  const { t } = useTranslation();
  const [r, setR] = useState("");
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn--primary" disabled={r.trim().length < 3} onClick={() => onSubmit(r)}>{t("common.confirm")}</button></>}>
      <Field label={t("ops.comment")} required><textarea className="input" value={r} onChange={(e) => setR(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}

function PickListModal({ warehouseId, onClose, onSubmit }: { warehouseId: string; onClose: () => void; onSubmit: (assignTo: string | null) => void }) {
  const { t } = useTranslation();
  const L = useL();
  const users = useQuery({ queryKey: ["pickers", warehouseId], queryFn: () => api.get("/api/pickers", { warehouseId }).catch(() => ({ data: [] })) });
  const [u, setU] = useState("");
  return (
    <Modal title={t("ops.releasePicks")} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn--primary" onClick={() => onSubmit(u || null)}>{t("common.confirm")}</button></>}>
      <Field label={t("ops.assignee")}><select className="select" value={u} onChange={(e) => setU(e.target.value)}>
        <option value="">—</option>{(users.data?.data ?? []).map((x: any) => <option key={x.id} value={x.id}>{L(x)}</option>)}</select></Field>
    </Modal>
  );
}

function DeliverModal({ m, onClose, onSubmit }: { m: any; onClose: () => void; onSubmit: (b: any) => void }) {
  const { t, i18n } = useTranslation();
  const [receiver, setReceiver] = useState(i18n.language === "ar" ? m.requester_ar : m.requester_en);
  const [self, setSelf] = useState(true);
  const [sig, setSig] = useState<string | null>(null);
  const toDeliver = m.pickTasks.filter((p: any) => ["picked", "short"].includes(p.status) && p.qty_picked > p.qty_delivered);
  return (
    <Modal wide title={t("ops.deliver")} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn--primary" disabled={!sig || receiver.trim().length < 3}
        onClick={() => onSubmit({ receivedByUserId: self ? m.requester_id : null, receivedByName: receiver, signaturePng: sig })}>{t("common.confirm")}</button></>}>
      <div className="table-wrap" style={{ marginBottom: 16 }}><table className="table"><thead><tr><th>{t("ops.item")}</th><th>{t("ops.lot")}</th><th className="c">{t("ops.qty")}</th></tr></thead>
        <tbody>{toDeliver.map((p: any) => <tr key={p.id}><td className="mono">{p.item_code}</td><td className="mono">{p.serial_no ?? p.lot_no ?? "—"}</td>
          <td className="n">{fmtNum(p.qty_picked - p.qty_delivered)}</td></tr>)}</tbody></table></div>
      <label className="check" style={{ marginBottom: 10 }}><input type="checkbox" checked={self} onChange={(e) => setSelf(e.target.checked)} />{t("ops.requester")}</label>
      <Field label={t("ops.receiverName")} required><input className="input" value={receiver} onChange={(e) => setReceiver(e.target.value)} /></Field>
      <SignaturePad onChange={setSig} />
    </Modal>
  );
}

// ============================================================ delivery note (print)
export function DeliveryNotePage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const q = useQuery({ queryKey: ["dn", id], queryFn: () => api.get(`/api/delivery-notes/${id}`) });
  const d: any = q.data;
  if (q.isLoading) return <Loading />;
  if (!d) return <Empty />;
  return (
    <div className="print-page card">
      <div className="no-print" style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <Link to={`/requests/${d.mr_id}`} className="btn btn--ghost btn--sm">{t("common.back")}</Link>
        <button className="btn btn--primary btn--sm" onClick={() => window.print()}><Icon name="report" className="icon icon-sm" />{t("ops.print")}</button>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "2px solid var(--iarda-primary)", paddingBottom: 12, marginBottom: 16 }}>
        <div><h1 className="page-title" style={{ fontSize: 22 }}>{t("ops.deliveryNote")}</h1><div className="mono">{d.dn_no}</div></div>
        <img className="iarda-logo" src="/brand/assets/logo/iarda-logo.png" alt={t("app.org")} style={{ height: 64 }} />
      </div>
      <dl className="dl" style={{ marginBottom: 16 }}>
        <div><dt>{t("ops.requests")}</dt><dd className="mono">{d.mr_no}</dd></div>
        <div><dt>{t("ops.requestType")}</dt><dd>{t(`mrType.${d.request_type}`)}</dd></div>
        <div><dt>{t("ops.warehouse")}</dt><dd>{L(d, "warehouse_name")}</dd></div>
        <div><dt>{t("ops.department")}</dt><dd>{lang === "ar" ? d.org_ar : d.org_en} <span className="mono">({d.cost_center_code})</span></dd></div>
        <div><dt>{t("ops.requester")}</dt><dd>{lang === "ar" ? d.requester_ar : d.requester_en}</dd></div>
        <div><dt>{t("ops.issuedBy")}</dt><dd>{lang === "ar" ? d.issued_by_ar : d.issued_by_en}</dd></div>
        {d.work_order_ref && <div><dt>{t("ops.workOrder")}</dt><dd className="mono">{d.work_order_ref}</dd></div>}
        <div><dt>{t("audit.at")}</dt><dd>{fmtDate(d.signed_at, lang, true)}</dd></div>
      </dl>
      <div className="table-wrap"><table className="table"><thead><tr><th>{t("ops.item")}</th><th>{t("ops.lot")}</th><th>{t("ops.location")}</th>
        <th className="c">{t("ops.qty")}</th><th className="c">{t("ops.avgCost")}</th><th className="c">{t("common.total")}</th></tr></thead>
        <tbody>{d.lines.map((l: any) => (
          <tr key={l.id}><td><span className="mono">{l.item_code}</span><br />{L(l)}</td><td className="mono">{l.serial_no ?? l.lot_no ?? "—"}</td><td className="mono">{l.full_code}</td>
            <td className="n"><span className="ltr">{fmtNum(l.qty)} {l.uom_code}</span></td><td className="n">{fmtNum(l.unit_cost, 2)}</td><td className="n">{fmtNum(l.value, 2)}</td></tr>
        ))}</tbody>
        <tfoot><tr><td colSpan={5}>{t("common.total")}</td><td className="n">{fmtSar(d.total_value)}</td></tr></tfoot></table></div>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 24 }}>
        <div><div className="muted">{t("ops.receiver")}</div><b>{d.received_by_name}</b>
          {d.signature_attachment_id && <img src={`/api/attachments/${d.signature_attachment_id}/content`} alt="signature" style={{ display: "block", height: 80, marginTop: 6 }} />}
          <div className="mono muted" style={{ fontSize: 10 }}>SHA-256 {d.signature_sha256.slice(0, 32)}…</div></div>
        <div><div className="muted">{t("ops.issuedBy")}</div><b>{lang === "ar" ? d.issued_by_ar : d.issued_by_en}</b></div>
      </div>
    </div>
  );
}
