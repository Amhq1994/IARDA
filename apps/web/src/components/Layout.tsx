import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth, setLanguage } from "../auth";
import { Icon, Toaster } from "./ui";

interface NavItem { to: string; icon: string; key: string; perms?: string[]; soon?: boolean }
interface NavGroup { key: string; items: NavItem[] }

const NAV: NavGroup[] = [
  { key: "nav.main", items: [{ to: "/", icon: "dashboard", key: "nav.dashboard" }] },
  { key: "nav.masterData", items: [
    { to: "/items", icon: "table", key: "nav.items", perms: ["item.read"] },
    { to: "/catalog", icon: "leaf", key: "nav.catalog", perms: ["category.manage", "item.manage"] },
    { to: "/warehouses", icon: "map", key: "nav.warehouses", perms: ["warehouse.read"] },
    { to: "/suppliers", icon: "users", key: "nav.suppliers", perms: ["supplier.read", "supplier.manage"] },
  ] },
  { key: "nav.operations", items: [
    { to: "#inbound", icon: "download", key: "nav.inbound", perms: ["receipt.execute", "inspection.execute", "grn.post", "asn.submit"], soon: true },
    { to: "#outbound", icon: "report", key: "nav.outbound", perms: ["request.create", "request.approve", "issue.execute"], soon: true },
    { to: "#counting", icon: "check", key: "nav.counting", perms: ["count.plan", "count.execute", "adjustment.approve"], soon: true },
    { to: "#planning", icon: "chart", key: "nav.planning", perms: ["planning.manage", "valuation.manage"], soon: true },
  ] },
  { key: "nav.admin", items: [
    { to: "/users", icon: "users", key: "nav.users", perms: ["admin.users"] },
    { to: "/roles", icon: "shield", key: "nav.roles", perms: ["admin.roles", "admin.users", "audit.read"] },
    { to: "/settings", icon: "settings", key: "nav.settings", perms: ["admin.settings"] },
    { to: "/audit", icon: "lock", key: "nav.audit", perms: ["audit.read"] },
  ] },
];

export function Layout() {
  const { t, i18n } = useTranslation();
  const { me, can, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const lang = i18n.language as "ar" | "en";
  const name = lang === "ar" ? me?.nameAr : me?.nameEn;
  const initial = (name ?? "?").trim().charAt(0);

  return (
    <div className="app">
      <header className="app-header">
        <button className="icon-btn menu-toggle" type="button" aria-label={t("nav.menu")} onClick={() => setOpen((o) => !o)}><Icon name="menu" /></button>
        <a href="/" onClick={(e) => { e.preventDefault(); nav("/"); }} className="iarda-logo-wrap">
          <img className="iarda-logo" src="/brand/assets/logo/iarda-logo.png" alt={t("app.org")} />
        </a>
        <span className="app-header__title">{t("app.short")}</span>
        <span className="app-header__spacer" />
        <div className="app-header__actions">
          <button className="btn btn--ghost btn--sm" type="button" onClick={() => setLanguage(lang === "ar" ? "en" : "ar", true)}>{t("app.switchLang")}</button>
          <button className="user-chip" type="button" onClick={() => nav("/profile")} title={t("nav.profile")}>
            <span className="user-chip__avatar">{initial}</span>
            <span>{name}</span>
          </button>
          <button className="icon-btn" type="button" title={t("nav.logout")} aria-label={t("nav.logout")}
            onClick={async () => { await logout(); nav("/login"); }}>
            <Icon name="logout" flip={lang === "ar"} />
          </button>
        </div>
      </header>

      <nav className={`app-sidebar${open ? " is-open" : ""}`} aria-label={t("nav.menu")} onClick={() => setOpen(false)}>
        {NAV.map((g) => {
          const items = g.items.filter((i) => !i.perms || can(...i.perms));
          if (!items.length) return null;
          return (
            <div key={g.key}>
              <div className="nav-label">{t(g.key)}</div>
              <ul className="nav">
                {items.map((i) => (
                  <li key={i.to}>
                    {i.soon ? (
                      <a aria-disabled="true" className="is-soon" title={t("nav.comingSoon")}>
                        <Icon name={i.icon} /><span>{t(i.key)}</span><span className="badge badge--soon">{t("nav.comingSoon")}</span>
                      </a>
                    ) : (
                      <NavLink to={i.to} end={i.to === "/"} aria-current={undefined}
                        className={({ isActive }) => (isActive || (i.to !== "/" && loc.pathname.startsWith(i.to)) ? "is-active" : "")}>
                        <Icon name={i.icon} /><span>{t(i.key)}</span>
                      </NavLink>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
      {open && <div className="sidebar-scrim" onClick={() => setOpen(false)} />}

      <main className="app-main">
        <Outlet />
      </main>

      <footer className="app-footer">
        <span className="app-footer__org">{t("app.org")}</span>
        <span>{t("app.copyright", { year: new Date().getFullYear() })}</span>
        <span className="app-footer__spacer" />
        <img className="vision2030" src="/brand/assets/partners/vision2030.svg" alt={lang === "ar" ? "رؤية المملكة 2030" : "Saudi Vision 2030"}
          onError={(e) => e.currentTarget.remove()} />
      </footer>
      <Toaster />
    </div>
  );
}
