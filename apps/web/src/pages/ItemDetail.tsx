import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ITEM_TYPES, VED, IDENTIFIER_TYPES, PICKING_RULES } from "@iarda/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { Alert, Empty, Field, Icon, Loading, Modal, PageHead, Section, StatusBadge, Tabs, toast } from "../components/ui";
import { AuditTimeline } from "./Audit";
import { errorText, fmtDate, fmtNum, fmtSar, useL } from "../util";

export function ItemDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language as "ar" | "en";
  const L = useL();
  const { me, can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState("details");
  const [modal, setModal] = useState<null | { kind: string; payload?: any }>(null);
  const q = useQuery({ queryKey: ["item", id], queryFn: () => api.get(`/api/items/${id}`) });
  const it: any = q.data;

  const refresh = () => { qc.invalidateQueries({ queryKey: ["item", id] }); qc.invalidateQueries({ queryKey: ["items"] }); qc.invalidateQueries({ queryKey: ["dashboard"] }); };
  async function act(fn: () => Promise<any>, ok = t("common.saved")) {
    try { await fn(); toast.success(ok); refresh(); setModal(null); } catch (e) { toast.error(errorText(e, lang)); }
  }

  if (q.isLoading) return <Loading />;
  if (!it) return <Empty text={t("errors.notFound")} />;

  const isMdo = can("item.manage");
  const actions = (
    <>
      {isMdo && it.status !== "obsolete" && <Link className="btn btn--secondary" to={`/items/${id}/edit`}><Icon name="settings" />{t("common.edit")}</Link>}
      {isMdo && ["requested", "draft"].includes(it.status) && <button className="btn btn--primary" onClick={() => act(() => api.post(`/api/items/${id}/submit`))}><Icon name="check" />{t("item.submit")}</button>}
      {can("item.approve") && it.status === "pending_approval" && <>
        <button className="btn btn--primary" onClick={() => act(() => api.post(`/api/items/${id}/approve`))}><Icon name="check" />{t("item.approve")}</button>
        <button className="btn btn--secondary" onClick={() => setModal({ kind: "reason", payload: "reject" })}>{t("item.reject")}</button>
      </>}
      {isMdo && it.status === "active" && <button className="btn btn--secondary" onClick={() => setModal({ kind: "reason", payload: "block" })}><Icon name="lock" />{t("item.block")}</button>}
      {isMdo && it.status === "blocked" && <button className="btn btn--secondary" onClick={() => act(() => api.post(`/api/items/${id}/unblock`))}>{t("item.unblock")}</button>}
      {isMdo && ["active", "blocked"].includes(it.status) && <button className="btn btn--ghost" onClick={() => setModal({ kind: "reason", payload: "obsolete" })}>{t("item.obsolete")}</button>}
      {isMdo && ["requested", "draft"].includes(it.status) && <button className="btn btn--ghost" onClick={() => {
        if (confirm(lang === "ar" ? "حذف هذا الصنف؟" : "Delete this item?")) act(async () => { await api.del(`/api/items/${id}`); nav("/items"); });
      }}>{t("common.delete")}</button>}
    </>
  );

  const tabs = [
    { id: "details", label: t("common.details") },
    { id: "identifiers", label: t("item.identifiers"), count: it.identifiers.length },
    { id: "uom", label: t("item.conversions"), count: it.conversions.length },
    { id: "subs", label: t("item.substitutes"), count: it.substitutes.length },
    { id: "policies", label: t("item.policies"), count: it.policies.length },
    { id: "images", label: t("item.images"), count: it.images.length },
    ...(can("audit.read") ? [{ id: "history", label: t("common.history") }] : []),
  ];
  const sodBlocked = it.status === "pending_approval" && [it.requested_by, it.created_by, it.submitted_by].includes(me?.id);

  return (
    <>
      <PageHead icon="table" title={L(it)} lead={<><span className="mono">{it.item_code}</span> · {lang === "ar" ? it.name_en : it.name_ar} · <StatusBadge status={it.status} /></>}
        crumbs={<><Link to="/items">{t("item.title")}</Link><Icon name="chevron" className="icon icon-sm" flip={lang === "ar"} /><span className="mono">{it.item_code}</span></>}
        actions={actions} />
      {it.status_reason && <div className="section"><Alert kind="warning">{t("common.reason")}: {it.status_reason}</Alert></div>}
      {sodBlocked && can("item.approve") && <div className="section"><Alert kind="info">{lang === "ar" ? "فصل المهام: لا يمكنك اعتماد صنف طلبته أو أنشأته أو رفعته للاعتماد." : "Segregation of duties: you cannot approve an item you requested, created or submitted."}</Alert></div>}

      <section className="card">
        <Tabs tabs={tabs} value={tab} onChange={setTab} />

        {tab === "details" && (
          <dl className="dl">
            <div><dt>{t("item.category")}</dt><dd>{L(it, "category_name")}</dd></div>
            <div><dt>{t("item.group")}</dt><dd>{L(it, "group_name")} <span className="mono">({it.group_code})</span></dd></div>
            <div><dt>{t("item.type")}</dt><dd>{(ITEM_TYPES as any)[it.item_type][lang]}</dd></div>
            <div><dt>{t("item.uom")}</dt><dd>{L(it, "uom_name")} ({it.uom_code})</dd></div>
            <div><dt>{t("item.tracking")}</dt><dd><div className="chips">
              {it.track_batch && <span className="chip">{t("item.batch")}</span>}{it.track_serial && <span className="chip">{t("item.serial")}</span>}
              {it.track_expiry && <span className="chip">{t("item.expiry")}</span>}{!it.track_batch && !it.track_serial && "—"}</div></dd></div>
            <div><dt>{t("item.shelfLife")}</dt><dd>{it.shelf_life_days ?? "—"}</dd></div>
            <div><dt>{t("item.ved")}</dt><dd>{it.ved_class ? `${it.ved_class} — ${(VED as any)[it.ved_class][lang]}` : "—"}</dd></div>
            <div><dt>{t("item.abc")} / {t("item.xyz")}</dt><dd>{it.abc_class ?? "—"} / {it.xyz_class ?? "—"}</dd></div>
            <div><dt>{t("item.weight")}</dt><dd>{fmtNum(it.unit_weight_kg, 4)}</dd></div>
            <div><dt>{t("item.volume")}</dt><dd>{fmtNum(it.unit_volume_m3, 6)}</dd></div>
            <div><dt>{t("item.cost")}</dt><dd>{fmtSar(it.standard_cost)}</dd></div>
            <div><dt>{t("item.hazard")}</dt><dd>{it.hazard_class ?? "—"}</dd></div>
            <div><dt>{t("item.storage")}</dt><dd>{it.storage_conditions ?? "—"}</dd></div>
            <div><dt>{t("common.createdBy")}</dt><dd>{L(it, "created_by_name")} · {fmtDate(it.created_at, lang)}</dd></div>
            <div><dt>{t("item.approvedBy")}</dt><dd>{it.approved_by ? `${L(it, "approved_by_name")} · ${fmtDate(it.approved_at, lang)}` : "—"}</dd></div>
            {Object.keys(it.specs ?? {}).length > 0 && <div style={{ gridColumn: "1 / -1" }}><dt>{t("item.specs")}</dt><dd>
              {Object.entries(it.specs).map(([k, v]) => <div key={k}><span className="muted">{k}:</span> {String(v)}</div>)}</dd></div>}
          </dl>
        )}

        {tab === "identifiers" && (
          <SubTable rows={it.identifiers} canEdit={isMdo} onAdd={() => setModal({ kind: "identifier" })} addLabel={t("item.addIdentifier")}
            cols={[[t("item.idType"), (r) => (IDENTIFIER_TYPES as any)[r.id_type][lang]], [t("item.value"), (r) => <span className="mono">{r.value}</span>],
              [t("item.manufacturer"), (r) => r.manufacturer ?? "—"], [t("item.primary"), (r) => (r.is_primary ? "✓" : "")]]}
            onDelete={(r) => act(() => api.del(`/api/items/${id}/identifiers/${r.id}`))} />
        )}
        {tab === "uom" && (
          <SubTable rows={it.conversions} canEdit={isMdo} onAdd={() => setModal({ kind: "conversion" })} addLabel={t("item.addConversion")}
            cols={[[t("common.name"), (r) => `${L(r, "uom_name")} (${r.uom_code})`], [t("item.factor"), (r) => `1 = ${fmtNum(r.factor_to_base, 4)} ${it.uom_code}`],
              [t("common.type"), (r) => [r.is_purchase_default && (lang === "ar" ? "شراء" : "Purchase"), r.is_issue_default && (lang === "ar" ? "صرف" : "Issue")].filter(Boolean).join("، ") || "—"]]}
            onDelete={(r) => act(() => api.del(`/api/items/${id}/conversions/${r.id}`))} />
        )}
        {tab === "subs" && (
          <SubTable rows={it.substitutes} canEdit={isMdo} onAdd={() => setModal({ kind: "substitute" })} addLabel={t("item.addSubstitute")}
            cols={[[t("item.code"), (r) => <Link className="mono" to={`/items/${r.substitute_item_id}`}>{r.item_code}</Link>], [t("common.name"), (r) => L(r)],
              [t("item.ratio"), (r) => fmtNum(r.ratio)], [t("item.priority"), (r) => r.priority], [t("common.status"), (r) => <StatusBadge status={r.status} />]]}
            onDelete={(r) => act(() => api.del(`/api/items/${id}/substitutes/${r.id}`))} />
        )}
        {tab === "policies" && (
          <SubTable rows={it.policies} canEdit={can("item.policy")} onAdd={() => setModal({ kind: "policy" })} addLabel={t("item.setPolicy")}
            cols={[[t("common.warehouse"), (r) => L(r, "warehouse_name")], [t("item.min"), (r) => fmtNum(r.min_qty)], [t("item.max"), (r) => fmtNum(r.max_qty)],
              [t("item.rop"), (r) => fmtNum(r.reorder_point)], [t("item.safety"), (r) => fmtNum(r.safety_stock)], [t("item.leadTime"), (r) => r.lead_time_days ?? "—"],
              [t("item.pickingRule"), (r) => r.picking_rule ?? "—"]]}
            onEdit={can("item.policy") ? (r) => setModal({ kind: "policy", payload: r }) : undefined} />
        )}
        {tab === "images" && (
          <>
            {isMdo && <ImageUpload itemId={id!} onDone={refresh} />}
            {it.images.length === 0 ? <Empty /> : (
              <div className="gallery">{it.images.map((im: any) => (
                <figure key={im.id}><a href={`/api/attachments/${im.id}/content`} target="_blank" rel="noreferrer"><img src={`/api/attachments/${im.id}/content`} alt={im.file_name} /></a>
                  <figcaption><span>{im.is_primary ? t("item.primary") : ""}</span>
                    {isMdo && <button className="btn btn--ghost btn--sm" onClick={() => act(() => api.del(`/api/attachments/${im.id}`))}>{t("common.delete")}</button>}</figcaption></figure>
              ))}</div>
            )}
          </>
        )}
        {tab === "history" && <AuditTimeline table="item" id={id!} />}
      </section>

      {modal?.kind === "reason" && <ReasonModal action={modal.payload} onClose={() => setModal(null)}
        onSubmit={(reason) => act(() => api.post(`/api/items/${id}/${modal.payload}`, { reason }))} />}
      {modal?.kind === "identifier" && <IdentifierModal onClose={() => setModal(null)} onSubmit={(b) => act(() => api.post(`/api/items/${id}/identifiers`, b))} />}
      {modal?.kind === "conversion" && <ConversionModal baseUom={it.base_uom_id} onClose={() => setModal(null)} onSubmit={(b) => act(() => api.post(`/api/items/${id}/conversions`, b))} />}
      {modal?.kind === "substitute" && <SubstituteModal selfId={id!} onClose={() => setModal(null)} onSubmit={(b) => act(() => api.post(`/api/items/${id}/substitutes`, b))} />}
      {modal?.kind === "policy" && <PolicyModal current={modal.payload} onClose={() => setModal(null)}
        onSubmit={(whId, b) => act(() => api.put(`/api/items/${id}/policies/${whId}`, b))} />}
    </>
  );
}

function SubTable({ rows, cols, canEdit, onAdd, addLabel, onDelete, onEdit }: {
  rows: any[]; cols: [string, (r: any) => any][]; canEdit: boolean; onAdd: () => void; addLabel: string; onDelete?: (r: any) => void; onEdit?: (r: any) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {canEdit && <div className="toolbar" style={{ justifyContent: "flex-end" }}><button className="btn btn--secondary btn--sm" onClick={onAdd}><Icon name="plus" className="icon icon-sm" />{addLabel}</button></div>}
      {rows.length === 0 ? <Empty /> : (
        <div className="table-wrap"><table className="table"><thead><tr>{cols.map(([h]) => <th key={h}>{h}</th>)}{canEdit && (onDelete || onEdit) && <th></th>}</tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>{cols.map(([h, f]) => <td key={h}>{f(r)}</td>)}
              {canEdit && (onDelete || onEdit) && <td className="actions">
                {onEdit && <button className="btn btn--ghost btn--sm" onClick={() => onEdit(r)}>{t("common.edit")}</button>}
                {onDelete && <button className="btn btn--ghost btn--sm" onClick={() => onDelete(r)}>{t("common.delete")}</button>}
              </td>}</tr>
          ))}</tbody></table></div>
      )}
    </>
  );
}

function ReasonModal({ action, onClose, onSubmit }: { action: string; onClose: () => void; onSubmit: (r: string) => void }) {
  const { t } = useTranslation();
  const [r, setR] = useState("");
  return (
    <Modal title={t(`item.${action}`)} onClose={onClose}
      footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
        <button className="btn btn--primary" disabled={r.trim().length < 3} onClick={() => onSubmit(r)}>{t("common.confirm")}</button></>}>
      <Field label={t("common.reason")} required><textarea className="input" value={r} onChange={(e) => setR(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}

function IdentifierModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (b: any) => void }) {
  const { t, i18n } = useTranslation();
  const [b, setB] = useState({ idType: "barcode", value: "", manufacturer: "", isPrimary: false });
  return (
    <Modal title={t("item.addIdentifier")} onClose={onClose}
      footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
        <button className="btn btn--primary" disabled={!b.value.trim()} onClick={() => onSubmit({ ...b, manufacturer: b.manufacturer || undefined })}>{t("common.add")}</button></>}>
      <Field label={t("item.idType")}><select className="select" value={b.idType} onChange={(e) => setB({ ...b, idType: e.target.value })}>
        {Object.entries(IDENTIFIER_TYPES).map(([k, v]) => <option key={k} value={k}>{(v as any)[i18n.language]}</option>)}</select></Field>
      <Field label={t("item.value")} required><input className="input mono" dir="ltr" value={b.value} onChange={(e) => setB({ ...b, value: e.target.value })} autoFocus /></Field>
      <Field label={t("item.manufacturer")}><input className="input" value={b.manufacturer} onChange={(e) => setB({ ...b, manufacturer: e.target.value })} /></Field>
      <label className="check"><input type="checkbox" checked={b.isPrimary} onChange={(e) => setB({ ...b, isPrimary: e.target.checked })} />{t("item.primary")}</label>
    </Modal>
  );
}

function ConversionModal({ baseUom, onClose, onSubmit }: { baseUom: string; onClose: () => void; onSubmit: (b: any) => void }) {
  const { t } = useTranslation();
  const L = useL();
  const uoms = useQuery({ queryKey: ["uoms"], queryFn: () => api.get("/api/uoms") });
  const [b, setB] = useState({ uomId: "", factorToBase: "", isPurchaseDefault: false, isIssueDefault: false });
  return (
    <Modal title={t("item.addConversion")} onClose={onClose}
      footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
        <button className="btn btn--primary" disabled={!b.uomId || !(Number(b.factorToBase) > 0)} onClick={() => onSubmit({ ...b, factorToBase: Number(b.factorToBase) })}>{t("common.add")}</button></>}>
      <Field label={t("item.uom")} required><select className="select" value={b.uomId} onChange={(e) => setB({ ...b, uomId: e.target.value })}>
        <option value=""></option>{(uoms.data?.data ?? []).filter((u: any) => u.id !== baseUom).map((u: any) => <option key={u.id} value={u.id}>{L(u)} ({u.code})</option>)}</select></Field>
      <Field label={t("item.factor")} required><input className="input" type="number" min={0} step="any" value={b.factorToBase} onChange={(e) => setB({ ...b, factorToBase: e.target.value })} /></Field>
      <div className="checks">
        <label className="check"><input type="checkbox" checked={b.isPurchaseDefault} onChange={(e) => setB({ ...b, isPurchaseDefault: e.target.checked })} />{t("common.type")}: {t("nav.inbound")}</label>
        <label className="check"><input type="checkbox" checked={b.isIssueDefault} onChange={(e) => setB({ ...b, isIssueDefault: e.target.checked })} />{t("nav.outbound")}</label>
      </div>
    </Modal>
  );
}

function SubstituteModal({ selfId, onClose, onSubmit }: { selfId: string; onClose: () => void; onSubmit: (b: any) => void }) {
  const { t } = useTranslation();
  const L = useL();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<any>(null);
  const [ratio, setRatio] = useState("1");
  const res = useQuery({ queryKey: ["items-pick", q], queryFn: () => api.get("/api/items", { q, pageSize: 8, status: "active" }), enabled: q.length >= 2 });
  return (
    <Modal title={t("item.addSubstitute")} onClose={onClose}
      footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
        <button className="btn btn--primary" disabled={!sel} onClick={() => onSubmit({ substituteItemId: sel.id, ratio: Number(ratio) || 1 })}>{t("common.add")}</button></>}>
      <Field label={t("common.search")}><input className="input" value={q} onChange={(e) => { setQ(e.target.value); setSel(null); }} autoFocus /></Field>
      <div className="dup-list">{(res.data?.data ?? []).filter((r: any) => r.id !== selfId).map((r: any) => (
        <button key={r.id} type="button" className={`dup${sel?.id === r.id ? " is-blocking" : ""}`} onClick={() => setSel(r)} style={{ cursor: "pointer", font: "inherit", textAlign: "start" }}>
          <span><span className="mono">{r.item_code}</span> · {L(r)}</span></button>
      ))}</div>
      <Field label={t("item.ratio")}><input className="input" type="number" min={0} step="any" value={ratio} onChange={(e) => setRatio(e.target.value)} /></Field>
    </Modal>
  );
}

function PolicyModal({ current, onClose, onSubmit }: { current?: any; onClose: () => void; onSubmit: (wh: string, b: any) => void }) {
  const { t } = useTranslation();
  const L = useL();
  const whs = useQuery({ queryKey: ["warehouses"], queryFn: () => api.get("/api/warehouses") });
  const [wh, setWh] = useState(current?.warehouse_id ?? "");
  const [b, setB] = useState({ minQty: current?.min_qty ?? 0, maxQty: current?.max_qty ?? "", reorderPoint: current?.reorder_point ?? "",
    safetyStock: current?.safety_stock ?? 0, leadTimeDays: current?.lead_time_days ?? "", pickingRule: current?.picking_rule ?? "" });
  const n = (v: any) => (v === "" || v === null ? null : Number(v));
  return (
    <Modal title={t("item.setPolicy")} onClose={onClose}
      footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
        <button className="btn btn--primary" disabled={!wh} onClick={() => onSubmit(wh, { minQty: Number(b.minQty) || 0, maxQty: n(b.maxQty), reorderPoint: n(b.reorderPoint),
          safetyStock: Number(b.safetyStock) || 0, leadTimeDays: n(b.leadTimeDays), pickingRule: b.pickingRule || null })}>{t("common.save")}</button></>}>
      <Field label={t("common.warehouse")} required><select className="select" value={wh} disabled={!!current} onChange={(e) => setWh(e.target.value)}>
        <option value=""></option>{(whs.data?.data ?? []).map((w: any) => <option key={w.id} value={w.id}>{L(w)}</option>)}</select></Field>
      <div className="form-grid">
        {([["minQty", "item.min"], ["maxQty", "item.max"], ["reorderPoint", "item.rop"], ["safetyStock", "item.safety"], ["leadTimeDays", "item.leadTime"]] as const).map(([k, l]) => (
          <Field key={k} label={t(l)}><input className="input" type="number" min={0} step="any" value={(b as any)[k]} onChange={(e) => setB({ ...b, [k]: e.target.value })} /></Field>
        ))}
        <Field label={t("item.pickingRule")}><select className="select" value={b.pickingRule} onChange={(e) => setB({ ...b, pickingRule: e.target.value })}>
          <option value="">—</option>{PICKING_RULES.map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>
      </div>
    </Modal>
  );
}

function ImageUpload({ itemId, onDone }: { itemId: string; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  return (
    <div className="toolbar" style={{ justifyContent: "flex-end" }}>
      <label className="btn btn--secondary btn--sm" style={{ cursor: "pointer" }}>
        <Icon name="plus" className="icon icon-sm" />{busy ? t("common.loading") : t("item.uploadImage")}
        <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={async (e) => {
          const file = e.target.files?.[0]; if (!file) return;
          const fd = new FormData();
          fd.append("ownerType", "item"); fd.append("ownerId", itemId); fd.append("category", "image"); fd.append("isPrimary", "true"); fd.append("file", file);
          setBusy(true);
          try { await api.post("/api/attachments", fd); toast.success(t("common.saved")); onDone(); }
          catch (err) { toast.error(errorText(err, i18n.language)); } finally { setBusy(false); e.target.value = ""; }
        }} />
      </label>
    </div>
  );
}
