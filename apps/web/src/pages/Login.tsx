import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { useAuth, setLanguage } from "../auth";
import { Alert, Icon } from "../components/ui";
import { errorText } from "../util";

// Shown only in demo builds (VITE_DEMO=1) — never in production.
const DEMO = import.meta.env.VITE_DEMO === "1";
const DEMO_USERS: [string, string, string][] = [
  ["admin", "مدير النظام", "System Admin"], ["wm.cons", "مدير المستودع", "Warehouse Manager"],
  ["sk.cleaning", "أمين المستودع", "Storekeeper"], ["ww.cleaning1", "عامل المستودع", "Warehouse Worker"],
  ["mdo", "مسؤول البيانات الرئيسية", "Master Data Officer"], ["planner", "مخطط المخزون", "Inventory Planner"],
  ["req.env", "طالب مواد", "Requester"], ["dm.env", "مدير إدارة", "Department Manager"],
  ["irc1", "لجنة الفحص والاستلام", "Inspection Committee"], ["cdc1", "لجنة الجرد والإتلاف", "Count & Disposal Committee"],
  ["proc", "المشتريات", "Procurement"], ["fin", "المالية", "Finance"], ["auditor", "المراجع الداخلي", "Internal Auditor"],
  ["supplier.rowad", "مورد (بوابة)", "Supplier (portal)"],
];

export function LoginPage() {
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lang = i18n.language as "ar" | "en";

  if (me) return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await api.post("/api/auth/login", { username, password, ...(needTotp ? { totp } : {}) });
      qc.setQueryData(["me"], r.user);
      setLanguage(r.user.lang, false);
      nav("/", { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.code === "mfa_required") setNeedTotp(true);
      setErr(errorText(e, lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login login--solo">
      <section className="login__panel" aria-labelledby="login-title">
        <img className="iarda-logo iarda-logo--lg" src="/brand/assets/logo/iarda-logo.png" alt={t("app.org")} />
        <h1 id="login-title" className="login__hello">{t("login.hello")}</h1>
        <p className="login__sub">{t("login.sub")}</p>

        <form onSubmit={submit} noValidate>
          {err && <div style={{ marginBottom: 16 }}><Alert kind={needTotp && !totp ? "info" : "error"}>{err}</Alert></div>}
          <div className="field">
            <label htmlFor="u">{t("login.username")}</label>
            <div className="input-wrap">
              <Icon name="user" />
              <input id="u" className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required dir="ltr" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="p">{t("login.password")}</label>
            <div className="input-wrap">
              <Icon name="lock" />
              <input id="p" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required dir="ltr" />
            </div>
          </div>
          {needTotp && (
            <div className="field">
              <label htmlFor="t">{t("login.totp")}</label>
              <div className="input-wrap">
                <Icon name="shield" />
                <input id="t" className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totp}
                  onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))} autoFocus dir="ltr" />
              </div>
            </div>
          )}
          <button className="btn btn--primary btn--block" type="submit" disabled={busy || !username || !password}>{t("login.submit")}</button>
        </form>

        <div className="login__or">{t("login.or")}</div>
        <a className="btn btn--secondary btn--block" href="/api/auth/oidc/login"><Icon name="shield" /><span>{t("login.sso")}</span></a>

        {DEMO && (
          <details className="demo-accounts">
            <summary>{t("login.demo")} — {t("login.demoHint")}: <span className="mono">Iarda@2026!</span></summary>
            <div className="demo-grid">
              {DEMO_USERS.map(([u, ar, en]) => (
                <button key={u} type="button" onClick={() => { setUsername(u); setPassword("Iarda@2026!"); }}>
                  <b>{lang === "ar" ? ar : en}</b><span className="mono">{u}</span>
                </button>
              ))}
            </div>
          </details>
        )}

        <p className="login__legal">
          {t("app.copyright", { year: new Date().getFullYear() })} — {t("app.org")} ·{" "}
          <button className="btn btn--ghost btn--sm" type="button" onClick={() => setLanguage(lang === "ar" ? "en" : "ar", false)}>{t("app.switchLang")}</button>
        </p>
      </section>
    </main>
  );
}
