import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth, setLanguage } from "../auth";
import { Icon, Toaster } from "./ui";
import { NotificationBell } from "./NotificationBell";

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
    { to: "/requests", icon: "report", key: "ops.requests", perms: ["request.create", "request.approve", "issue.execute", "delegation.own"] },
    { to: "/inbound/receipts", icon: "download", key: "ops.receipts", perms: ["receipt.execute", "inspection.execute", "grn.post"] },
    { to: "/inbound/pos", icon: "sheet", key: "ops.purchaseOrders", perms: ["po.read"] },
    { to: "/stock", icon: "chart", key: "ops.stock", perms: ["warehouse.read"] },
    { to: "/m", icon: "slides", key: "ops.mobile", perms: ["mobile.tasks"] },
    { to: "/approvals", icon: "check", key: "inv.approvals", perms: ["request.approve", "transfer.approve", "adjustment.approve", "disposal.approve", "return.vendor.approve", "delegation.own"] },
    { to: "/transfers", icon: "slides", key: "inv.transfers", perms: ["transfer.request", "transfer.approve", "issue.execute", "receipt.execute", "audit.read"] },
    { to: "/returns", icon: "download", key: "inv.returns", perms: ["return.warehouse", "return.vendor", "return.vendor.approve", "issue.execute", "audit.read"] },
    { to: "/counts", icon: "table", key: "nav.counting", perms: ["count.plan", "count.execute", "count.review", "audit.read"] },
    { to: "/adjustments", icon: "sheet", key: "inv.adjustments", perms: ["adjustment.request", "adjustment.approve", "count.review", "valuation.manage", "audit.read"] },
    { to: "/disposals", icon: "alert", key: "inv.disposals", perms: ["disposal.recommend", "disposal.approve", "adjustment.request", "audit.read"] },
  ] },
  { key: "nav.planning", items: [
    { to: "/planning", icon: "chart", key: "pl.planning", perms: ["planning.manage", "pr.create", "pr.approve", "audit.read"] },
    { to: "/planning/prs", icon: "sheet", key: "pl.prs", perms: ["pr.create", "pr.approve", "pr.process"] },
    { to: "/valuation", icon: "report", key: "val.valuation", perms: ["valuation.manage", "journal.manage", "audit.read"] },
    { to: "/custody", icon: "users", key: "cus.custody" },
    { to: "/clearances", icon: "shield", key: "cus.clearances", perms: ["clearance.request", "admin.users"] },
  ] },
  { key: "rep.reports", items: [
    { to: "/kpis", icon: "star", key: "kpi.kpis", perms: ["dashboard.view", "report.view"] },
    { to: "/reports", icon: "pdf", key: "rep.reports", perms: ["report.view", "report.export"] },
    { to: "/portal", icon: "download", key: "portal.portal", perms: ["asn.read", "po.read"] },
    { to: "/labels", icon: "table", key: "lbl.labels", perms: ["warehouse.manage", "receipt.execute"] },
  ] },
  { key: "nav.admin", items: [
    { to: "/users", icon: "users", key: "nav.users", perms: ["admin.users"] },
    { to: "/roles", icon: "shield", key: "nav.roles", perms: ["admin.roles", "admin.users", "audit.read"] },
    { to: "/settings", icon: "settings", key: "nav.settings", perms: ["admin.settings"] },
    { to: "/audit", icon: "lock", key: "nav.audit", perms: ["audit.read"] },
    { to: "/admin/integrations", icon: "globe", key: "integ.integrations", perms: ["admin.settings", "audit.read"] },
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
          <NotificationBell />
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
