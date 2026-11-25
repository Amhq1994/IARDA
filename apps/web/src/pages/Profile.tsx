import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fmtDate } from "../util";
import { useTranslation } from "react-i18next";
import { PERMISSIONS, ROLES } from "@iarda/shared";
import { api } from "../api";
import { useAuth, setLanguage } from "../auth";
import { Alert, Field, PageHead, Section, toast } from "../components/ui";
import { errorText } from "../util";

export function ProfilePage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language as "ar" | "en";
  const { me, refresh } = useAuth();
  const [pw, setPw] = useState({ currentPassword: "", newPassword: "" });
  const [mfa, setMfa] = useState<any>(null);
  const [code, setCode] = useState("");
  if (!me) return null;
  return (
    <>
      <PageHead icon="user" title={t("profile.title")} lead={`${lang === "ar" ? me.nameAr : me.nameEn} · ${me.username}`} />
      {me.mustChangePassword && <div className="section"><Alert kind="warning">{t("profile.policy")}</Alert></div>}
      <div className="grid grid--2-1">
        <div>
          <Section icon="lock" title={t("profile.changePassword")}>
            <div className="form-grid">
              <Field label={t("profile.current")}><input className="input" type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
              <Field label={t("profile.newPw")} hint={t("profile.policy")}><input className="input" type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
            </div>
            <div className="form-actions"><button className="btn btn--primary" disabled={!pw.currentPassword || !pw.newPassword} onClick={async () => {
              try { await api.post("/api/auth/change-password", pw); toast.success(t("common.saved")); setPw({ currentPassword: "", newPassword: "" }); refresh(); }
              catch (e) { toast.error(errorText(e, lang)); }
            }}>{t("common.save")}</button></div>
          </Section>

          <Section icon="shield" title={t("profile.mfaTitle")}>
            {me.mfaEnabled ? <Alert kind="success">{t("profile.mfaOn")}</Alert> : mfa ? (
              <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
                <img src={mfa.qrDataUrl} alt="QR" width={180} height={180} style={{ border: "1px solid var(--iarda-sand)", borderRadius: 8 }} />
                <div style={{ flex: 1, minWidth: 220 }}>
                  <p className="muted">{t("profile.mfaScan")}</p>
                  <p className="mono" style={{ fontSize: 12 }}>{mfa.secret}</p>
                  <Field label={t("login.totp")}><input className="input mono" dir="ltr" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></Field>
                  <button className="btn btn--primary" disabled={code.length !== 6} onClick={async () => {
                    try { await api.post("/api/auth/mfa/enable", { code }); toast.success(t("profile.mfaOn")); setMfa(null); refresh(); }
                    catch (e) { toast.error(errorText(e, lang)); }
                  }}>{t("profile.mfaEnable")}</button>
                </div>
              </div>
            ) : (
              <><p className="muted">{t("profile.mfaOff")}</p>
                <button className="btn btn--secondary" onClick={async () => { try { setMfa(await api.post("/api/auth/mfa/setup")); } catch (e) { toast.error(errorText(e, lang)); } }}>{t("profile.mfaSetup")}</button></>
            )}
          </Section>
        </div>
        <div>
          {(me.permissions.includes("delegation.own")) && <Delegations />}
          <Section icon="globe" title={t("profile.language")}>
            <div className="btn-group">
              <button className={`btn ${lang === "ar" ? "btn--primary" : "btn--secondary"}`} onClick={() => setLanguage("ar", true)}>العربية</button>
              <button className={`btn ${lang === "en" ? "btn--primary" : "btn--secondary"}`} onClick={() => setLanguage("en", true)}>English</button>
            </div>
          </Section>
          <Section icon="users" title={t("profile.myRoles")}>
            <div className="chips" style={{ marginBottom: 12 }}>{me.roles.map((r) => <span key={r.code} className="chip">{(ROLES as any)[r.code]?.[lang] ?? r.code}</span>)}</div>
            <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 13.5 }}>
              {me.permissions.map((p) => <li key={p}>{(PERMISSIONS as any)[p]?.[lang] ?? p}</li>)}
            </ul>
          </Section>
        </div>
      </div>
    </>
  );
}

function Delegations() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { me } = useAuth();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["delegations"], queryFn: () => api.get("/api/delegations") });
  const users = useQuery({ queryKey: ["deleg-users"], queryFn: () => api.get("/api/delegates").catch(() => ({ data: [] })) });
  const [b, setB] = useState({ toUserId: "", from: new Date().toISOString().slice(0, 10), to: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10), reason: "" });
  return (
    <Section icon="users" title={t("ops.delegation")}>
      {(list.data?.data ?? []).filter((d: any) => d.from_user_id === me!.id || d.to_user_id === me!.id).map((d: any) => (
        <div className="kpi-target" key={d.id}>
          <span>{lang === "ar" ? d.from_name_ar : d.from_name_en} → <b>{lang === "ar" ? d.to_name_ar : d.to_name_en}</b><br />
            <small className="muted">{fmtDate(d.valid_from, lang)} – {fmtDate(d.valid_to, lang)} · {d.reason} · {d.status}</small></span>
          {d.status === "active" && d.from_user_id === me!.id && <button className="btn btn--ghost btn--sm" onClick={async () => {
            try { await api.post(`/api/delegations/${d.id}/revoke`, {}); qc.invalidateQueries({ queryKey: ["delegations"] }); } catch (e) { toast.error(errorText(e, lang)); }
          }}>{t("ops.revoke")}</button>}
        </div>
      ))}
      <div className="form-grid" style={{ marginTop: 12 }}>
        <Field label={t("ops.delegateTo")}><select className="select" value={b.toUserId} onChange={(e) => setB({ ...b, toUserId: e.target.value })}>
          <option value=""></option>{(users.data?.data ?? []).filter((u: any) => u.id !== me!.id).map((u: any) => <option key={u.id} value={u.id}>{lang === "ar" ? u.name_ar : u.name_en}</option>)}</select></Field>
        <Field label={t("ops.from")}><input className="input" type="date" value={b.from} onChange={(e) => setB({ ...b, from: e.target.value })} /></Field>
        <Field label={t("ops.to")}><input className="input" type="date" value={b.to} onChange={(e) => setB({ ...b, to: e.target.value })} /></Field>
        <Field label={t("common.reason")}><input className="input" value={b.reason} onChange={(e) => setB({ ...b, reason: e.target.value })} /></Field>
      </div>
      <div className="form-actions"><button className="btn btn--primary btn--sm" disabled={!b.toUserId || b.reason.trim().length < 3} onClick={async () => {
        try {
          await api.post("/api/delegations", { toUserId: b.toUserId, validFrom: new Date(b.from + "T00:00:00").toISOString(), validTo: new Date(b.to + "T23:59:59").toISOString(), reason: b.reason, docTypes: ["MR"] });
          toast.success(t("common.saved")); qc.invalidateQueries({ queryKey: ["delegations"] });
        } catch (e) { toast.error(errorText(e, lang)); }
      }}>{t("ops.newDelegation")}</button></div>
    </Section>
  );
}
