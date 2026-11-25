import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ITEM_STATUSES } from "@iarda/shared";

export function Icon({ name, className = "icon", flip }: { name: string; className?: string; flip?: boolean }) {
  return (
    <svg className={`${className}${flip ? " icon-flip" : ""}`} aria-hidden="true">
      <use href={`/brand/assets/icons/iarda-icons.svg#i-${name}`} />
    </svg>
  );
}

export function PageHead({ icon, title, lead, crumbs, actions }: { icon: string; title: string; lead?: ReactNode; crumbs?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {crumbs && <div className="breadcrumb">{crumbs}</div>}
        <h1 className="page-title"><Icon name={icon} /><span>{title}</span></h1>
        {lead && <p className="lead">{lead}</p>}
      </div>
      {actions && <div className="btn-group">{actions}</div>}
    </div>
  );
}

export function Section({ icon, title, actions, children, className = "card" }: { icon: string; title: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`${className} section`}>
      <div className="card__head">
        <h2 className="section-title"><Icon name={icon} /><span>{title}</span></h2>
        {actions && <div className="btn-group">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

const STATUS_CLASS: Record<string, string> = {
  active: "badge--success", pending_approval: "badge--warning", requested: "badge--neutral", draft: "badge--neutral",
  blocked: "badge--error", obsolete: "badge--neutral", inactive: "badge--neutral", suspended: "badge--error",
};

export function StatusBadge({ status }: { status: string }) {
  const { i18n } = useTranslation();
  const label = (ITEM_STATUSES as any)[status]?.[i18n.language] ?? status;
  return <span className={`badge ${STATUS_CLASS[status] ?? "badge--neutral"}`}>{label}</span>;
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager">
      <span className="muted">{total.toLocaleString("en-US")} {t("common.results")}</span>
      <div className="btn-group">
        <button className="btn btn--secondary btn--sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="previous">
          <Icon name="chevron" className="icon icon-sm" flip />
        </button>
        <span className="pager__label">{t("common.page")} {page} {t("common.of")} {pages}</span>
        <button className="btn btn--secondary btn--sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="next">
          <Icon name="chevron" className="icon icon-sm" />
        </button>
      </div>
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " modal--wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal__head">
          <h2 className="section-title" style={{ marginBottom: 0 }}><span>{title}</span></h2>
          <button className="icon-btn" onClick={onClose} aria-label="close"><Icon name="error" /></button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: string; count?: number }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={`tab${value === t.id ? " is-active" : ""}`} onClick={() => onChange(t.id)}>
          {t.label}{t.count !== undefined && <span className="tab__count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children, hint, error, required }: { label: string; children: ReactNode; hint?: string; error?: string; required?: boolean }) {
  return (
    <div className={`field${error ? " field--error" : ""}`}>
      <label>{label}{required && <span className="text-gold"> *</span>}</label>
      {children}
      {(error || hint) && <div className="field__hint">{error || hint}</div>}
    </div>
  );
}

export function Empty({ text }: { text?: string }) {
  const { t } = useTranslation();
  return <div className="empty"><Icon name="info" /><span>{text ?? t("common.empty")}</span></div>;
}

export function Loading() {
  const { t } = useTranslation();
  return <div className="empty"><span className="spinner" />{t("common.loading")}</div>;
}

export function Alert({ kind = "info", children }: { kind?: "info" | "success" | "warning" | "error"; children: ReactNode }) {
  const icon = { info: "info", success: "check", warning: "alert", error: "error" }[kind];
  return <div className={`alert alert--${kind}`}><Icon name={icon} /><div>{children}</div></div>;
}

/** Tiny toast store */
let pushToast: (t: { kind: "success" | "error"; text: string }) => void = () => {};
export const toast = { success: (text: string) => pushToast({ kind: "success", text }), error: (text: string) => pushToast({ kind: "error", text }) };
export function Toaster() {
  const [items, setItems] = useState<{ id: number; kind: "success" | "error"; text: string }[]>([]);
  useEffect(() => {
    pushToast = (t) => {
      const id = Date.now() + Math.random();
      setItems((x) => [...x, { id, ...t }]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 4500);
    };
  }, []);
  return (
    <div className="toaster" aria-live="polite">
      {items.map((i) => <div key={i.id} className={`alert alert--${i.kind}`}><Icon name={i.kind === "success" ? "check" : "error"} /><div>{i.text}</div></div>)}
    </div>
  );
}

export function Meter({ value, max }: { value: number; max: number }) {
  const p = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const tone = p > 85 ? "var(--iarda-error)" : p >= 75 ? "var(--iarda-gold)" : "var(--iarda-primary)";
  return (
    <div className="meter" title={`${p}%`}>
      <div className="meter__track"><div className="meter__fill" style={{ width: `${p}%`, background: tone }} /></div>
      <span className="meter__val">{p}%</span>
    </div>
  );
}
