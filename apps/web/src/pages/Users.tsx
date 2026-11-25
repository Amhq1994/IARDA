import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ROLES } from "@iarda/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { Alert, Empty, Field, Icon, Loading, Modal, PageHead, Pagination, Section, StatusBadge, toast } from "../components/ui";
import { errorText, fmtDate, useL } from "../util";
import { AuditTimeline } from "./Audit";

export function UsersPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language as "ar" | "en";
  const L = useL();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const r = useQuery({ queryKey: ["users", q, role, page], queryFn: () => api.get("/api/users", { q, role, page }), placeholderData: (p) => p });
  return (
    <>
      <PageHead icon="users" title={t("admin.users")} actions={<button className="btn btn--primary" onClick={() => setOpen(true)}><Icon name="plus" />{t("admin.newUser")}</button>} />
      <section className="card">
        <div className="toolbar">
          <div className="field grow"><label>{t("common.search")}</label><div className="input-wrap"><Icon name="search" />
            <input className="input" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div></div>
          <div className="field"><label>{t("admin.roles")}</label><select className="select" value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }}>
            <option value="">{t("common.all")}</option>{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v[lang]}</option>)}</select></div>
        </div>
        {r.isLoading ? <Loading /> : (
          <>
            <div className="table-wrap"><table className="table"><thead><tr>
              <th>{t("admin.username")}</th><th>{t("common.name")}</th><th>{t("admin.department")}</th><th>{t("admin.roles")}</th>
              <th className="c">{t("admin.mfa")}</th><th>{t("admin.lastLogin")}</th><th className="c">{t("common.status")}</th>
            </tr></thead><tbody>
              {r.data.data.map((u: any) => (
                <tr key={u.id} className="is-clickable" onClick={() => nav(`/users/${u.id}`)}>
                  <td className="mono"><Link to={`/users/${u.id}`} onClick={(e) => e.stopPropagation()}>{u.username}</Link></td><td>{L(u)}</td><td>{L(u, "org_name")}</td>
                  <td><div className="chips">{(u.role_codes ?? []).map((c: string) => <span key={c} className="chip" title={(ROLES as any)[c]?.[lang]}>{c}</span>)}</div></td>
                  <td className="c">{u.mfa_enabled ? "✓" : "—"}</td><td>{fmtDate(u.last_login_at, lang, true)}</td>
                  <td className="c">{u.locked_until && new Date(u.locked_until) > new Date() ? <span className="badge badge--error">{t("admin.locked")}</span> : <StatusBadge status={u.status} />}</td>
                </tr>
              ))}
            </tbody></table></div>
            <Pagination page={r.data.page} pageSize={r.data.pageSize} total={r.data.total} onPage={setPage} />
          </>
        )}
      </section>
      {open && <NewUserModal onClose={() => setOpen(false)} />}
    </>
  );
}

function NewUserModal({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const L = useL();
  const qc = useQueryClient();
  const nav = useNavigate();
  const orgs = useQuery({ queryKey: ["org-units"], queryFn: () => api.get("/api/org-units") });
  const [b, setB] = useState({ username: "", nameAr: "", nameEn: "", employeeNo: "", email: "", mobile: "", orgUnitId: "" });
  const [temp, setTemp] = useState<{ id: string; pw: string } | null>(null);
  return (
    <Modal title={t("admin.newUser")} onClose={onClose}
      footer={temp ? <button className="btn btn--primary" onClick={() => nav(`/users/${temp.id}`)}>{t("common.view")}</button>
        : <><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn--primary" onClick={async () => {
            try {
              const r = await api.post("/api/users", Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v || null])));
              qc.invalidateQueries({ queryKey: ["users"] }); setTemp({ id: r.id, pw: r.temporaryPassword });
            } catch (e) { toast.error(errorText(e, i18n.language)); }
          }}>{t("common.create")}</button></>}>
      {temp ? <Alert kind="success">{t("admin.tempPassword")}: <b className="mono">{temp.pw}</b></Alert> : (
        <div className="form-grid">
          <Field label={t("admin.username")} required><input className="input mono" dir="ltr" value={b.username} onChange={(e) => setB({ ...b, username: e.target.value })} /></Field>
          <Field label={t("admin.employeeNo")}><input className="input mono" dir="ltr" value={b.employeeNo} onChange={(e) => setB({ ...b, employeeNo: e.target.value })} /></Field>
          <Field label={t("common.nameAr")} required><input className="input" value={b.nameAr} onChange={(e) => setB({ ...b, nameAr: e.target.value })} /></Field>
          <Field label={t("common.nameEn")} required><input className="input" dir="ltr" value={b.nameEn} onChange={(e) => setB({ ...b, nameEn: e.target.value })} /></Field>
          <Field label={t("admin.email")}><input className="input" dir="ltr" type="email" value={b.email} onChange={(e) => setB({ ...b, email: e.target.value })} /></Field>
          <Field label={t("admin.mobile")}><input className="input" dir="ltr" value={b.mobile} placeholder="+9665XXXXXXXX" onChange={(e) => setB({ ...b, mobile: e.target.value })} /></Field>
          <Field label={t("admin.department")}><select className="select" value={b.orgUnitId} onChange={(e) => setB({ ...b, orgUnitId: e.target.value })}>
            <option value=""></option>{(orgs.data?.data ?? []).map((o: any) => <option key={o.id} value={o.id}>{L(o)}</option>)}</select></Field>
        </div>
      )}
    </Modal>
  );
}

export function UserDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language as "ar" | "en";
  const L = useL();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [assign, setAssign] = useState(false);
  const [temp, setTemp] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["user", id], queryFn: () => api.get(`/api/users/${id}`) });
  const whs = useQuery({ queryKey: ["warehouses"], queryFn: () => api.get("/api/warehouses") });
  const u: any = q.data;
  const admin = can("admin.users");
  const refresh = () => { qc.invalidateQueries({ queryKey: ["user", id] }); qc.invalidateQueries({ queryKey: ["users"] }); };
  async function act(fn: () => Promise<any>) { try { const r = await fn(); toast.success(t("common.saved")); refresh(); return r; } catch (e) { toast.error(errorText(e, lang)); } }
  if (q.isLoading) return <Loading />;
  if (!u) return <Empty />;
  const whName = (wid: string) => L((whs.data?.data ?? []).find((w: any) => w.id === wid)) || wid.slice(0, 8);
  return (
    <>
      <PageHead icon="user" title={L(u)} lead={<><span className="mono">{u.username}</span> · {L(u, "org_name")} · <StatusBadge status={u.status} /></>}
        crumbs={<><Link to="/users">{t("admin.users")}</Link><Icon name="chevron" className="icon icon-sm" flip={lang === "ar"} /><span className="mono">{u.username}</span></>}
        actions={admin && <>
          {u.locked_until && new Date(u.locked_until) > new Date() && <button className="btn btn--secondary" onClick={() => act(() => api.post(`/api/users/${id}/unlock`))}>{t("admin.unlock")}</button>}
          {u.auth_provider === "local" && <button className="btn btn--secondary" onClick={async () => { const r = await act(() => api.post(`/api/users/${id}/reset-password`)); if (r) setTemp(r.temporaryPassword); }}>{t("admin.resetPassword")}</button>}
          <button className="btn btn--secondary" onClick={() => act(() => api.patch(`/api/users/${id}`, { status: u.status === "active" ? "inactive" : "active", version: u.version }))}>
            {u.status === "active" ? (lang === "ar" ? "تعطيل" : "Deactivate") : (lang === "ar" ? "تفعيل" : "Activate")}</button>
        </>} />
      {temp && <div className="section"><Alert kind="success">{t("admin.tempPassword")}: <b className="mono">{temp}</b></Alert></div>}
      <div className="grid grid--2-1">
        <div>
          <Section icon="shield" title={t("admin.roles")} actions={admin && <button className="btn btn--primary btn--sm" onClick={() => setAssign(true)}><Icon name="plus" className="icon icon-sm" />{t("admin.assignRole")}</button>}>
            {u.roles.length === 0 ? <Empty /> : (
              <div className="table-wrap"><table className="table"><thead><tr><th>{t("admin.roles")}</th><th>{t("common.warehouse")}</th><th>{t("common.status")}</th>{admin && <th></th>}</tr></thead>
                <tbody>{u.roles.map((r: any) => (
                  <tr key={r.id}><td><span className="chip">{r.code}</span> {L(r)}</td>
                    <td>{r.warehouse_ids?.length ? r.warehouse_ids.map(whName).join("، ") : <span className="muted">{t("common.all")}</span>}</td>
                    <td>{r.is_active ? "✓" : <span className="muted">{fmtDate(r.valid_to, lang)}</span>}</td>
                    {admin && <td className="actions">{r.is_active && <button className="btn btn--ghost btn--sm" onClick={() => act(() => api.del(`/api/users/${id}/roles/${r.code}`))}>{t("admin.revoke")}</button>}</td>}</tr>
                ))}</tbody></table></div>
            )}
          </Section>
          {can("audit.read") && <Section icon="lock" title={t("common.history")}><AuditTimeline table="app_user" id={id!} /></Section>}
        </div>
        <Section icon="user" title={t("common.details")}>
          <dl className="dl" style={{ gridTemplateColumns: "1fr" }}>
            <div><dt>{t("admin.employeeNo")}</dt><dd className="mono">{u.employee_no ?? "—"}</dd></div>
            <div><dt>{t("admin.email")}</dt><dd className="mono">{u.email ?? "—"}</dd></div>
            <div><dt>{t("admin.mobile")}</dt><dd className="mono">{u.mobile ?? "—"}</dd></div>
            <div><dt>{t("admin.position")}</dt><dd>{L(u, "position")}</dd></div>
            <div><dt>{t("admin.mfa")}</dt><dd>{u.mfa_enabled ? "✓" : "—"}</dd></div>
            <div><dt>{t("admin.lastLogin")}</dt><dd>{fmtDate(u.last_login_at, lang, true)}</dd></div>
          </dl>
        </Section>
      </div>
      {assign && <AssignRoleModal userId={id!} warehouses={whs.data?.data ?? []} onClose={() => setAssign(false)} onDone={() => { setAssign(false); refresh(); }} />}
    </>
  );
}

function AssignRoleModal({ userId, warehouses, onClose, onDone }: { userId: string; warehouses: any[]; onClose: () => void; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language as "ar" | "en";
  const L = useL();
  const [role, setRole] = useState("");
  const [whs, setWhs] = useState<string[]>([]);
  const scope = role ? (ROLES as any)[role].scope : "";
  return (
    <Modal title={t("admin.assignRole")} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn--primary" disabled={!role} onClick={async () => {
        try { await api.post(`/api/users/${userId}/roles`, { roleCode: role, warehouseIds: whs.length ? whs : null }); toast.success(t("common.saved")); onDone(); }
        catch (e) { toast.error(errorText(e, lang)); }
      }}>{t("common.save")}</button></>}>
      <Field label={t("admin.roles")} required><select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
        <option value=""></option>{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{k} — {v[lang]}</option>)}</select></Field>
      {["warehouse", "tasks"].includes(scope) && (
        <Field label={t("admin.scopeWarehouses")}>
          <div className="checks">{warehouses.map((w) => (
            <label key={w.id} className="check"><input type="checkbox" checked={whs.includes(w.id)} onChange={(e) => setWhs(e.target.checked ? [...whs, w.id] : whs.filter((x) => x !== w.id))} />{L(w)}</label>
          ))}</div>
        </Field>
      )}
    </Modal>
  );
}
