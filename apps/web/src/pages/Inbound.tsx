import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, type Page } from "../api";
import { useAuth } from "../auth";
import { Alert, Empty, Field, Icon, Loading, Modal, PageHead, Pagination, Section, Tabs, toast } from "../components/ui";
import { DocBadge, Timeline } from "../components/ops";
import { errorText, fmtDate, fmtNum, fmtSar, useL } from "../util";

// ============================================================ receipts list
export function ReceiptsPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const { can } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState(can("inspection.execute") && !can("receipt.execute") ? "mine" : "active");
  const [page, setPage] = useState(1);
  const [arrive, setArrive] = useState(false);
  const status = tab === "active" ? "arrived,qty_checked,in_inspection,inspected,grn_posted" : tab === "done" ? "putaway_done" : "";
  const r = useQuery({ queryKey: ["receipts", tab, page], queryFn: () => api.get<Page<any>>("/api/receipts", { status, mine: tab === "mine" ? 1 : "", page }), placeholderData: (p) => p });
  return (
    <>
      <PageHead icon="download" title={t("ops.receipts")} actions={can("receipt.execute") && <button className="btn btn--primary" onClick={() => setArrive(true)}><Icon name="plus" />{t("ops.arrival")}</button>} />
      <section className="card">
        <Tabs value={tab} onChange={(v) => { setTab(v); setPage(1); }} tabs={[
          { id: "active", label: lang === "ar" ? "قيد المعالجة" : "In progress" },
          ...(can("inspection.execute") ? [{ id: "mine", label: lang === "ar" ? "لجاني" : "My committees" }] : []),
          { id: "done", label: lang === "ar" ? "مكتملة" : "Completed" }, { id: "all", label: t("ops.all") }]} />
        {r.isLoading ? <Loading /> : !r.data?.data.length ? <Empty /> : (
          <>
            <div className="table-wrap"><table className="table"><thead><tr>
              <th>{t("common.code")}</th><th>{t("ops.po")}</th><th className="col-opt">{t("ops.supplier")}</th><th className="c col-opt">{t("ops.warehouse")}</th>
              <th className="c">{t("common.status")}</th><th className="col-opt">{t("audit.at")}</th>
            </tr></thead><tbody>{r.data.data.map((x) => (
              <tr key={x.id} className="is-clickable" onClick={() => nav(`/inbound/receipts/${x.id}`)}>
                <td className="mono"><Link to={`/inbound/receipts/${x.id}`} onClick={(e) => e.stopPropagation()}>{x.receipt_no}</Link>{x.grn_no && <div className="muted mono">{x.grn_no}</div>}</td>
                <td className="mono">{x.po_no}<div className="muted">{x.etimad_ref}</div></td><td className="col-opt">{L(x, "supplier_name")}</td>
                <td className="c col-opt mono">{x.warehouse_code}</td><td className="c"><DocBadge status={x.status} dict="rcvStatus" />{x.open_putaway > 0 && <div className="muted" style={{ fontSize: 12 }}>{x.open_putaway} {t("ops.putaway")}</div>}</td>
                <td className="col-opt"><small>{fmtDate(x.arrived_at, lang, true)}</small></td>
              </tr>
            ))}</tbody></table></div>
            <Pagination page={r.data.page} pageSize={r.data.pageSize} total={r.data.total} onPage={setPage} />
          </>
        )}
      </section>
      {arrive && <ArrivalModal onClose={() => setArrive(false)} onDone={(id) => nav(`/inbound/receipts/${id}`)} />}
    </>
  );
}

function ArrivalModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const L = useL();
  const asns = useQuery({ queryKey: ["asns-open"], queryFn: () => api.get("/api/asns", { status: "submitted" }) });
  const pos = useQuery({ queryKey: ["pos-open"], queryFn: () => api.get("/api/purchase-orders", { status: "open,partially_received", pageSize: 100 }) });
  const [src, setSrc] = useState<"asn" | "po">("asn");
  const [sel, setSel] = useState("");
  const [ref, setRef] = useState("");
  return (
    <Modal title={t("ops.arrival")} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn--primary" disabled={!sel} onClick={async () => {
        try { const r = await api.post("/api/receipts", src === "asn" ? { asnId: sel, supplierDeliveryRef: ref || undefined } : { poId: sel, supplierDeliveryRef: ref || undefined }); onDone(r.id); }
        catch (e) { toast.error(errorText(e, i18n.language)); }
      }}>{t("common.create")}</button></>}>
      <div className="btn-group" style={{ marginBottom: 14 }}>
        <button className={`btn btn--sm ${src === "asn" ? "btn--primary" : "btn--secondary"}`} onClick={() => { setSrc("asn"); setSel(""); }}>{t("ops.fromAsn")}</button>
        <button className={`btn btn--sm ${src === "po" ? "btn--primary" : "btn--secondary"}`} onClick={() => { setSrc("po"); setSel(""); }}>{t("ops.fromPo")}</button>
      </div>
      <Field label={src === "asn" ? t("ops.asn") : t("ops.po")} required>
        <select className="select" value={sel} onChange={(e) => setSel(e.target.value)}>
          <option value=""></option>
          {src === "asn" ? (asns.data?.data ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.asn_no} · {a.po_no} · {L(a, "supplier_name")}</option>)
            : (pos.data?.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.po_no} · {L(p, "supplier_name")} · {p.warehouse_code}</option>)}
        </select>
      </Field>
      <Field label={i18n.language === "ar" ? "رقم بوليصة/إشعار تسليم المورد" : "Supplier delivery note no."}><input className="input mono" dir="ltr" value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
    </Modal>
  );
}

// ============================================================ receipt workflow
const RSTEPS = ["arrived", "qty_checked", "in_inspection", "inspected", "grn_posted", "putaway_done"];

export function ReceiptDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["receipt", id], queryFn: () => api.get(`/api/receipts/${id}`) });
  const r: any = q.data;
  const [qty, setQty] = useState<Record<string, any>>({});
  const [res, setRes] = useState<Record<string, any>>({});
  const [committee, setCommittee] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["receipt", id] }); qc.invalidateQueries({ queryKey: ["receipts"] }); qc.invalidateQueries({ queryKey: ["dashboard"] }); };
  async function act(fn: () => Promise<any>) { try { const x = await fn(); toast.success(t("common.saved")); refresh(); return x; } catch (e) { toast.error(errorText(e, lang)); } }
  if (q.isLoading) return <Loading />;
  if (!r) return <Empty />;
  const stepIdx = RSTEPS.indexOf(r.status);
  const myMember = r.members.find((m: any) => m.user_id === me?.id);
  const report = r.attachments.find((a: any) => a.category === "inspection_report");
  const v = (lid: string, k: string, d: any) => qty[lid]?.[k] ?? d;
  const setV = (lid: string, k: string, val: any) => setQty({ ...qty, [lid]: { ...qty[lid], [k]: val } });

  return (
    <>
      <PageHead icon="download" title={`${t("ops.receipts")} — ${r.receipt_no}`}
        lead={<><span className="mono">{r.po_no}</span> · {L(r, "supplier_name")} · {r.etimad_ref && <>{t("ops.etimad")}: <span className="mono">{r.etimad_ref}</span> · </>}<DocBadge status={r.status} dict="rcvStatus" /></>}
        crumbs={<Link to="/inbound/receipts">{t("ops.receipts")}</Link>} />
      <section className="card section">
        <div className="steps">{RSTEPS.map((s, i) => <div key={s} className={`step${i < stepIdx || r.status === "putaway_done" ? " is-done" : ""}${i === stepIdx && r.status !== "putaway_done" ? " is-current" : ""}`}>{t(`rcvStatus.${s}`)}</div>)}</div>
        <dl className="dl">
          <div><dt>{t("ops.warehouse")}</dt><dd>{L(r, "warehouse_name")}</dd></div>
          <div><dt>{t("ops.dock")}</dt><dd className="mono">{r.dock_code}</dd></div>
          <div><dt>{t("ops.asn")}</dt><dd className="mono">{r.asn_no ?? "—"}</dd></div>
          <div><dt>{t("ops.received")}</dt><dd>{lang === "ar" ? r.received_by_ar : r.received_by_en} · {fmtDate(r.arrived_at, lang, true)}</dd></div>
          {r.grn_no && <div><dt>{t("ops.grn")}</dt><dd className="mono">{r.grn_no} · {fmtSar(r.grn_value)}</dd></div>}
          {r.putaway_completed_at && <div><dt>{t("ops.dockToStock")}</dt><dd>{fmtNum((new Date(r.putaway_completed_at).getTime() - new Date(r.arrived_at).getTime()) / 3600000, 1)} h</dd></div>}
        </dl>
      </section>

      <div className="grid grid--2-1">
        <div>
          <Section icon="table" title={r.status === "arrived" ? t("ops.qtyCheck") : r.status === "in_inspection" ? t("ops.inspection") : t("ops.lines")}>
            <div className="table-wrap"><table className="table"><thead><tr>
              <th>{t("ops.item")}</th><th className="c">{t("ops.ordered")}</th><th className="c">{t("ops.received")}</th><th className="c">{t("ops.damaged")}</th>
              <th className="c">{t("ops.accepted")}</th><th className="c">{t("ops.rejected")}</th><th>{t("ops.lot")}</th>
            </tr></thead><tbody>{r.lines.map((l: any) => (
              <tr key={l.id}>
                <td><span className="mono">{l.item_code}</span><br />{L(l)}<div className="chips">{l.track_batch && <span className="chip">{t("item.batch")}</span>}{l.track_serial && <span className="chip">{t("item.serial")}</span>}{l.track_expiry && <span className="chip">{t("item.expiry")}</span>}</div></td>
                <td className="n">{fmtNum(l.qty_expected)} <small className="muted">{l.uom_code}</small></td>
                {["arrived", "qty_checked"].includes(r.status) && can("receipt.execute") ? <>
                  <td className="c"><input className="input qty-input" type="number" min={0} value={v(l.id, "qtyReceived", l.qty_received || l.qty_expected)} onChange={(e) => setV(l.id, "qtyReceived", e.target.value)} /></td>
                  <td className="c"><input className="input qty-input" type="number" min={0} value={v(l.id, "qtyDamaged", l.qty_damaged)} onChange={(e) => setV(l.id, "qtyDamaged", e.target.value)} /></td>
                  <td></td><td></td>
                  <td>{(l.track_batch || l.track_expiry) && <>
                    {l.track_batch && <input className="input mono" dir="ltr" placeholder="LOT" style={{ height: 34, marginBottom: 4 }} value={v(l.id, "lotNo", l.lot_no ?? "")} onChange={(e) => setV(l.id, "lotNo", e.target.value)} />}
                    {l.track_expiry && <input className="input" type="date" style={{ height: 34 }} value={v(l.id, "expiryDate", l.expiry_date?.slice(0, 10) ?? "")} onChange={(e) => setV(l.id, "expiryDate", e.target.value)} />}</>}
                    {l.track_serial && <textarea className="input mono" dir="ltr" placeholder={t("ops.serials")} style={{ minHeight: 60, marginTop: 4 }}
                      value={v(l.id, "serialNos", (l.serial_nos ?? []).join("\n"))} onChange={(e) => setV(l.id, "serialNos", e.target.value)} />}</td>
                </> : r.status === "in_inspection" && myMember ? <>
                  <td className="n">{fmtNum(l.qty_received)}</td><td className="n">{fmtNum(l.qty_damaged)}</td>
                  <td className="c"><input className="input qty-input" type="number" min={0} max={l.qty_received} value={res[l.id]?.qtyAccepted ?? l.qty_accepted ?? (l.qty_received - l.qty_damaged)}
                    onChange={(e) => setRes({ ...res, [l.id]: { ...res[l.id], qtyAccepted: e.target.value } })} /></td>
                  <td className="n">{fmtNum(l.qty_received - Number(res[l.id]?.qtyAccepted ?? l.qty_accepted ?? (l.qty_received - l.qty_damaged)))}</td>
                  <td><input className="input" placeholder={t("ops.rejectReason")} style={{ height: 34 }} value={res[l.id]?.rejectReason ?? l.reject_reason ?? ""}
                    onChange={(e) => setRes({ ...res, [l.id]: { ...res[l.id], rejectReason: e.target.value } })} /></td>
                </> : <>
                  <td className="n">{fmtNum(l.qty_received)}</td><td className="n">{fmtNum(l.qty_damaged)}</td><td className="n"><b>{fmtNum(l.qty_accepted)}</b></td>
                  <td className="n">{fmtNum(l.qty_rejected)}{l.reject_reason && <div className="muted" style={{ fontSize: 12 }}>{l.reject_reason}</div>}</td>
                  <td className="mono">{l.lot_no ?? (l.serial_nos?.length ? `${l.serial_nos.length} SN` : "—")}{l.expiry_date && <div className="muted">{fmtDate(l.expiry_date, lang)}</div>}</td>
                </>}
              </tr>
            ))}</tbody></table></div>
            <div className="form-actions">
              {["arrived", "qty_checked"].includes(r.status) && can("receipt.execute") && <button className="btn btn--primary" onClick={() => act(() => api.post(`/api/receipts/${id}/quantity-check`, {
                lines: r.lines.map((l: any) => {
                  const x = qty[l.id] ?? {};
                  const serials = typeof x.serialNos === "string" ? x.serialNos.split(/\s+/).filter(Boolean) : l.serial_nos ?? undefined;
                  return { lineId: l.id, qtyReceived: Number(x.qtyReceived ?? (l.qty_received || l.qty_expected)), qtyDamaged: Number(x.qtyDamaged ?? l.qty_damaged ?? 0),
                    lotNo: x.lotNo ?? l.lot_no ?? undefined, expiryDate: x.expiryDate || l.expiry_date?.slice(0, 10) || undefined, serialNos: l.track_serial ? serials : undefined };
                }) }))}><Icon name="check" />{t("ops.qtyCheck")}</button>}
              {r.status === "qty_checked" && can("receipt.execute") && <button className="btn btn--primary" onClick={() => setCommittee(true)}><Icon name="users" />{t("ops.startInspection")}</button>}
              {r.status === "in_inspection" && myMember && <button className="btn btn--secondary" onClick={() => act(() => api.post(`/api/receipts/${id}/inspection/results`, {
                lines: r.lines.map((l: any) => ({ lineId: l.id, qtyAccepted: Number(res[l.id]?.qtyAccepted ?? l.qty_accepted ?? (l.qty_received - l.qty_damaged)),
                  rejectReason: res[l.id]?.rejectReason ?? l.reject_reason ?? null })) }))}>{t("ops.saveResults")}</button>}
              {r.status === "inspected" && can("grn.post") && <button className="btn btn--primary" onClick={() => act(() => api.post(`/api/receipts/${id}/grn`))}><Icon name="check" />{t("ops.postGrn")}</button>}
            </div>
          </Section>

          {r.putawayTasks.length > 0 && (
            <Section icon="map" title={t("ops.putawayTasks")} actions={r.status === "grn_posted" && <Link className="btn btn--secondary btn--sm" to="/m/putaway">{t("ops.openOnPhone")}</Link>}>
              <div className="table-wrap"><table className="table"><thead><tr><th>{t("common.code")}</th><th>{t("ops.item")}</th><th>{t("ops.lot")}</th><th className="c">{t("ops.qty")}</th>
                <th>{t("ops.suggested")}</th><th>{t("ops.placedAt")}</th></tr></thead>
                <tbody>{r.putawayTasks.map((p: any) => (
                  <tr key={p.id}><td className="mono">{p.task_no}</td><td className="mono">{p.item_code}</td><td className="mono">{p.serial_no ?? p.lot_no ?? "—"}</td><td className="n">{fmtNum(p.qty)}</td>
                    <td className="mono">{p.suggested_code ?? "—"}</td><td className="mono">{p.to_code ? <span className="m-ok">✓ {p.to_code}</span> : <span className="chip">{p.status}</span>}
                      {p.override_reason && <div className="muted" style={{ fontSize: 12 }}>{p.override_reason}</div>}</td></tr>
                ))}</tbody></table></div>
            </Section>
          )}
        </div>
        <div>
          {r.members.length > 0 && (
            <Section icon="users" title={t("ops.committee")}>
              {r.members.map((m: any) => (
                <div className="kpi-target" key={m.id}><span>{L(m)}{m.is_chair && <> · <span className="chip">{t("ops.chair")}</span></>}</span>
                  <span>{m.decision ? <DocBadge status={m.decision === "agree" ? "approved" : "rejected"} dict="approvalStatus" /> : <span className="muted">—</span>}</span></div>
              ))}
              <div style={{ marginTop: 12 }}>
                {report ? <a className="btn btn--ghost btn--sm" href={`/api/attachments/${report.id}/content`} target="_blank" rel="noreferrer"><Icon name="pdf" className="icon icon-sm" />{t("ops.report")}</a>
                  : r.status === "in_inspection" && myMember && <ReportUpload receiptId={id!} onDone={refresh} />}
              </div>
              {r.status === "in_inspection" && myMember && (
                <div className="btn-group" style={{ marginTop: 12 }}>
                  <button className="btn btn--primary btn--sm" onClick={() => act(() => api.post(`/api/receipts/${id}/inspection/sign`, { decision: "agree" }))}><Icon name="check" className="icon icon-sm" />{t("ops.sign")}</button>
                  <button className="btn btn--secondary btn--sm" onClick={() => { const c = prompt(t("ops.comment")); if (c) act(() => api.post(`/api/receipts/${id}/inspection/sign`, { decision: "object", comment: c })); }}>{t("ops.object")}</button>
                </div>
              )}
            </Section>
          )}
          <Section icon="calendar" title={t("ops.timeline")}><Timeline events={r.events} /></Section>
        </div>
      </div>
      {committee && <CommitteeModal receivedBy={r.received_by} onClose={() => setCommittee(false)} onSubmit={(memberIds, chairId) => act(async () => {
        await api.post(`/api/receipts/${id}/inspection`, { memberIds, chairId }); setCommittee(false);
      })} />}
    </>
  );
}

function ReportUpload({ receiptId, onDone }: { receiptId: string; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  return (
    <label className="btn btn--secondary btn--sm" style={{ cursor: "pointer" }}>
      <Icon name="pdf" className="icon icon-sm" />{t("ops.uploadReport")}
      <input type="file" accept="application/pdf" hidden onChange={async (e) => {
        const f = e.target.files?.[0]; if (!f) return;
        const fd = new FormData();
        fd.append("ownerType", "receipt"); fd.append("ownerId", receiptId); fd.append("category", "inspection_report"); fd.append("file", f);
        try { await api.post("/api/attachments", fd); toast.success(t("common.saved")); onDone(); } catch (err) { toast.error(errorText(err, i18n.language)); }
      }} />
    </label>
  );
}

function CommitteeModal({ receivedBy, onClose, onSubmit }: { receivedBy: string; onClose: () => void; onSubmit: (ids: string[], chair: string) => void }) {
  const { t } = useTranslation();
  const L = useL();
  const users = useQuery({ queryKey: ["irc-users"], queryFn: () => api.get("/api/committee-members") });
  const [sel, setSel] = useState<string[]>([]);
  const [chair, setChair] = useState("");
  return (
    <Modal title={t("ops.startInspection")} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn--primary" disabled={sel.length < 2 || !sel.includes(chair)} onClick={() => onSubmit(sel, chair)}>{t("common.confirm")}</button></>}>
      <Alert>{t("ops.committee")} — SoD-4</Alert>
      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        {(users.data?.data ?? []).filter((u: any) => u.id !== receivedBy).map((u: any) => (
          <div key={u.id} className="kpi-target">
            <label className="check"><input type="checkbox" checked={sel.includes(u.id)} onChange={(e) => setSel(e.target.checked ? [...sel, u.id] : sel.filter((x) => x !== u.id))} />{L(u)}</label>
            <label className="check"><input type="radio" name="chair" checked={chair === u.id} disabled={!sel.includes(u.id)} onChange={() => setChair(u.id)} />{t("ops.chair")}</label>
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ============================================================ purchase orders (+ supplier portal ASN, invoices)
export function PurchaseOrdersPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const nav = useNavigate();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const r = useQuery({ queryKey: ["pos", page, q], queryFn: () => api.get<Page<any>>("/api/purchase-orders", { page, q }), placeholderData: (p) => p });
  return (
    <>
      <PageHead icon="report" title={t("ops.purchaseOrders")} />
      <section className="card">
        <div className="toolbar"><div className="field grow"><div className="input-wrap"><Icon name="search" /><input className="input" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="PO / Etimad" /></div></div></div>
        {r.isLoading ? <Loading /> : !r.data?.data.length ? <Empty /> : (
          <>
            <div className="table-wrap"><table className="table"><thead><tr><th>{t("ops.po")}</th><th className="col-opt">{t("ops.etimad")}</th><th>{t("ops.supplier")}</th>
              <th className="c col-opt">{t("ops.warehouse")}</th><th className="c col-opt">{t("ops.expected")}</th><th className="c">{t("common.total")}</th><th className="c">{t("common.status")}</th></tr></thead>
              <tbody>{r.data.data.map((p) => (
                <tr key={p.id} className="is-clickable" onClick={() => nav(`/inbound/pos/${p.id}`)}>
                  <td className="mono"><Link to={`/inbound/pos/${p.id}`} onClick={(e) => e.stopPropagation()}>{p.po_no}</Link></td><td className="mono col-opt">{p.etimad_ref ?? "—"}</td>
                  <td>{L(p, "supplier_name")}</td><td className="c mono col-opt">{p.warehouse_code}</td><td className="c col-opt">{p.expected_date ? fmtDate(p.expected_date, lang) : "—"}</td>
                  <td className="n">{fmtSar(p.total_amount)}</td><td className="c"><DocBadge status={p.status} dict="poStatus" /></td>
                </tr>
              ))}</tbody></table></div>
            <Pagination page={r.data.page} pageSize={r.data.pageSize} total={r.data.total} onPage={setPage} />
          </>
        )}
      </section>
    </>
  );
}

export function PurchaseOrderDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [modal, setModal] = useState<null | "asn" | "invoice">(null);
  const q = useQuery({ queryKey: ["po", id], queryFn: () => api.get(`/api/purchase-orders/${id}`) });
  const p: any = q.data;
  if (q.isLoading) return <Loading />;
  if (!p) return <Empty />;
  const refresh = () => { qc.invalidateQueries({ queryKey: ["po", id] }); setModal(null); };
  return (
    <>
      <PageHead icon="report" title={`${t("ops.po")} — ${p.po_no}`} lead={<>{L(p, "supplier_name")} · {t("ops.etimad")}: <span className="mono">{p.etimad_ref ?? "—"}</span> · <DocBadge status={p.status} dict="poStatus" /></>}
        crumbs={<Link to="/inbound/pos">{t("ops.purchaseOrders")}</Link>}
        actions={<>
          {can("asn.submit") && ["open", "partially_received"].includes(p.status) && <button className="btn btn--primary" onClick={() => setModal("asn")}><Icon name="plus" />{t("ops.submitAsn")}</button>}
          {can("invoice.manage") && p.lines.some((l: any) => l.qty_received > 0) && <button className="btn btn--secondary" onClick={() => setModal("invoice")}><Icon name="plus" />{t("ops.newInvoice")}</button>}
        </>} />
      <div className="grid grid--2-1">
        <div>
          <Section icon="table" title={t("ops.lines")}>
            <div className="table-wrap"><table className="table"><thead><tr><th>#</th><th>{t("ops.item")}</th><th className="c">{t("ops.ordered")}</th><th className="c">{t("ops.received")}</th>
              <th className="c">{lang === "ar" ? "المفوتر" : "Invoiced"}</th><th className="c">{t("ops.unitPrice")}</th></tr></thead>
              <tbody>{p.lines.map((l: any) => (
                <tr key={l.id}><td>{l.line_no}</td><td><span className="mono">{l.item_code}</span><br />{L(l)}</td><td className="n">{fmtNum(l.qty_ordered)} <small className="muted">{l.uom_code}</small></td>
                  <td className="n">{fmtNum(l.qty_received)}</td><td className="n">{fmtNum(l.qty_invoiced)}</td><td className="n">{fmtNum(l.unit_price, 2)}</td></tr>
              ))}</tbody>
              <tfoot><tr><td colSpan={5}>{t("common.total")}</td><td className="n">{fmtSar(p.total_amount)}</td></tr></tfoot></table></div>
          </Section>
          {p.invoices?.length > 0 && (
            <Section icon="sheet" title={t("ops.invoices")}>
              {p.invoices.map((inv: any) => (
                <div key={inv.id} style={{ marginBottom: 12 }}>
                  <div className="kpi-target"><span className="mono">{inv.invoice_no} · {fmtDate(inv.invoice_date, lang)}</span><span>{fmtSar(inv.amount_excl_vat + inv.vat_amount)} <DocBadge status={inv.status} /></span></div>
                  {inv.match_result && <div className="table-wrap"><table className="table"><thead><tr><th>#</th><th className="c">{t("ops.ordered")}</th><th className="c">{t("ops.received")}</th>
                    <th className="c">{lang === "ar" ? "المفوتر" : "Invoiced"}</th><th className="c">{lang === "ar" ? "انحراف السعر" : "Price dev."}</th><th className="c">{t("ops.match")}</th></tr></thead>
                    <tbody>{inv.match_result.map((m: any) => <tr key={m.line}><td>{m.line} <span className="mono">{m.item}</span></td><td className="n">{fmtNum(m.ordered)}</td><td className="n">{fmtNum(m.received)}</td>
                      <td className="n">{fmtNum(m.invoiced)}</td><td className="n">{m.priceDeviationPct}%</td><td className="c"><DocBadge status={m.result === "matched" ? "matched" : "exception"} /></td></tr>)}</tbody></table></div>}
                </div>
              ))}
            </Section>
          )}
        </div>
        <div>
          <Section icon="download" title={t("ops.asn")}>
            {p.asns.length === 0 ? <p className="muted">—</p> : p.asns.map((a: any) => <div className="kpi-target" key={a.id}><span className="mono">{a.asn_no}</span><span>{fmtDate(a.expected_at, lang)} · <span className="chip">{a.status}</span></span></div>)}
          </Section>
          {p.receipts.length > 0 && <Section icon="check" title={t("ops.receipts")}>
            {p.receipts.map((r: any) => <div className="kpi-target" key={r.id}><Link className="mono" to={`/inbound/receipts/${r.id}`}>{r.receipt_no}</Link><DocBadge status={r.status} dict="rcvStatus" /></div>)}
          </Section>}
        </div>
      </div>
      {modal === "asn" && <AsnModal po={p} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === "invoice" && <InvoiceModal po={p} onClose={() => setModal(null)} onDone={refresh} />}
    </>
  );
}

function AsnModal({ po, onClose, onDone }: { po: any; onClose: () => void; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const [b, setB] = useState({ expectedAt: new Date(Date.now() + 86400000).toISOString().slice(0, 16), vehicleNo: "", driverName: "" });
  const [lines, setLines] = useState<Record<string, any>>(Object.fromEntries(po.lines.map((l: any) => [l.id, { qty: Math.max(0, l.qty_ordered - l.qty_received), lotNo: "", expiryDate: "" }])));
  return (
    <Modal wide title={t("ops.submitAsn")} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn--primary" onClick={async () => {
        try {
          await api.post("/api/asns", { poId: po.id, expectedAt: new Date(b.expectedAt).toISOString(), vehicleNo: b.vehicleNo || undefined, driverName: b.driverName || undefined,
            lines: Object.entries(lines).filter(([, v]) => Number(v.qty) > 0).map(([k, v]) => ({ poLineId: k, qty: Number(v.qty), lotNo: v.lotNo || undefined, expiryDate: v.expiryDate || undefined })) });
          toast.success(t("common.saved")); onDone();
        } catch (e) { toast.error(errorText(e, i18n.language)); }
      }}>{t("common.create")}</button></>}>
      <div className="form-grid">
        <Field label={t("ops.expected")}><input className="input" type="datetime-local" value={b.expectedAt} onChange={(e) => setB({ ...b, expectedAt: e.target.value })} /></Field>
        <Field label={i18n.language === "ar" ? "رقم اللوحة" : "Vehicle plate"}><input className="input" value={b.vehicleNo} onChange={(e) => setB({ ...b, vehicleNo: e.target.value })} /></Field>
        <Field label={i18n.language === "ar" ? "اسم السائق" : "Driver"}><input className="input" value={b.driverName} onChange={(e) => setB({ ...b, driverName: e.target.value })} /></Field>
      </div>
      <div className="table-wrap"><table className="table"><thead><tr><th>{t("ops.item")}</th><th className="c">{t("ops.qty")}</th><th>{t("ops.lot")}</th><th>{t("ops.expiry")}</th></tr></thead>
        <tbody>{po.lines.map((l: any) => (
          <tr key={l.id}><td className="mono">{l.item_code}</td>
            <td className="c"><input className="input qty-input" type="number" min={0} max={l.qty_ordered - l.qty_received} value={lines[l.id].qty} onChange={(e) => setLines({ ...lines, [l.id]: { ...lines[l.id], qty: e.target.value } })} /></td>
            <td>{l.track_batch && <input className="input mono" dir="ltr" style={{ height: 34 }} value={lines[l.id].lotNo} onChange={(e) => setLines({ ...lines, [l.id]: { ...lines[l.id], lotNo: e.target.value } })} />}</td>
            <td>{l.track_expiry && <input className="input" type="date" style={{ height: 34 }} value={lines[l.id].expiryDate} onChange={(e) => setLines({ ...lines, [l.id]: { ...lines[l.id], expiryDate: e.target.value } })} />}</td></tr>
        ))}</tbody></table></div>
    </Modal>
  );
}

function InvoiceModal({ po, onClose, onDone }: { po: any; onClose: () => void; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const [b, setB] = useState({ invoiceNo: "", invoiceDate: new Date().toISOString().slice(0, 10) });
  const [lines, setLines] = useState<Record<string, any>>(Object.fromEntries(po.lines.map((l: any) => [l.id, { qty: Math.max(0, l.qty_received - l.qty_invoiced), unitPrice: l.unit_price }])));
  return (
    <Modal wide title={t("ops.newInvoice")} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn--primary" disabled={!b.invoiceNo} onClick={async () => {
        try {
          const r = await api.post("/api/invoices", { poId: po.id, ...b, lines: Object.entries(lines).filter(([, v]) => Number(v.qty) > 0).map(([k, v]) => ({ poLineId: k, qty: Number(v.qty), unitPrice: Number(v.unitPrice) })) });
          (r.status === "ready_for_payment" ? toast.success : toast.error)(`${t("ops.match")}: ${r.status}`); onDone();
        } catch (e) { toast.error(errorText(e, i18n.language)); }
      }}>{t("common.create")}</button></>}>
      <div className="form-grid">
        <Field label={t("ops.invoiceNo")} required><input className="input mono" dir="ltr" value={b.invoiceNo} onChange={(e) => setB({ ...b, invoiceNo: e.target.value })} /></Field>
        <Field label={t("ops.invoiceDate")}><input className="input" type="date" value={b.invoiceDate} onChange={(e) => setB({ ...b, invoiceDate: e.target.value })} /></Field>
      </div>
      <div className="table-wrap"><table className="table"><thead><tr><th>{t("ops.item")}</th><th className="c">{t("ops.received")}</th><th className="c">{t("ops.qty")}</th><th className="c">{t("ops.unitPrice")}</th></tr></thead>
        <tbody>{po.lines.map((l: any) => (
          <tr key={l.id}><td className="mono">{l.item_code}</td><td className="n">{fmtNum(l.qty_received)}</td>
            <td className="c"><input className="input qty-input" type="number" min={0} value={lines[l.id].qty} onChange={(e) => setLines({ ...lines, [l.id]: { ...lines[l.id], qty: e.target.value } })} /></td>
            <td className="c"><input className="input qty-input" type="number" min={0} step="0.01" value={lines[l.id].unitPrice} onChange={(e) => setLines({ ...lines, [l.id]: { ...lines[l.id], unitPrice: e.target.value } })} /></td></tr>
        ))}</tbody></table></div>
    </Modal>
  );
}
