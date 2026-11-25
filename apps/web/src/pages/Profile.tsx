import { useState } from "react";
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
