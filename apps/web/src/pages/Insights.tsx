// Phase 5 screens: KPI scorecard with trends, report catalogue / schedules / history, integration console
// (API keys, outbound events, e-mail outbox, call log), bin labels (print sheet + ZPL), supplier portal status.
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { useAuth } from "../auth";
import { Alert, Empty, Field, Icon, Loading, Modal, PageHead, Section, Tabs } from "../components/ui";
import { fmtDate, fmtNum, fmtSar, useL } from "../util";
import { ListCard, St, useAct, useWarehouses } from "./Control";
import { code128Svg } from "../barcode";

// ============================================================ KPIs
function Spark({ points, target, dir }: { points: { month: string; value: number }[]; target: any; dir: string | null }) {
  if (points.length < 2) return <span className="muted">—</span>;
  const w = 180, h = 46, pad = 4;
  const vals = points.map((p) => p.value);
  const tg = typeof target === "number" ? target : Array.isArray(target) ? target[0] : null;
  const lo = Math.min(...vals, tg ?? Infinity), hi = Math.max(...vals, tg ?? -Infinity);
  const y = (v: number) => (hi === lo ? h / 2 : h - pad - ((v - lo) / (hi - lo)) * (h - 2 * pad));
  const x = (i: number) => pad + (i * (w - 2 * pad)) / (points.length - 1);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={points.map((p) => `${p.month}: ${p.value}`).join(", ")} style={{ direction: "ltr" }}>
      {tg != null && <line x1={pad} x2={w - pad} y1={y(tg)} y2={y(tg)} stroke="var(--iarda-gold)" strokeDasharray="3 3" strokeWidth="1" />}
      <path d={d} fill="none" stroke="var(--iarda-primary)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(points.length - 1)} cy={y(vals[vals.length - 1])} r="3" fill="var(--iarda-primary)" />
      {dir && null}
    </svg>
  );
}

export function KpisPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const whs = useWarehouses();
  const [wh, setWh] = useState("");
  const r = useQuery({ queryKey: ["kpis", wh], queryFn: () => api.get("/api/kpis", { warehouseId: wh || undefined }) });
  const fmtT = (k: any) => (k.target == null ? "—" : Array.isArray(k.target) ? `${k.target[0]}–${k.target[1]}${k.unit}` : `${k.dir === "ge" ? "≥" : "≤"} ${k.target}${k.unit}`);
  return (
    <>
      <PageHead icon="star" title={t("kpi.kpis")} actions={<>
        <select className="select" style={{ width: "auto" }} value={wh} onChange={(e) => setWh(e.target.value)}>
          <option value="">{t("ops.all")}</option>{(whs.data?.data ?? []).map((w: any) => <option key={w.id} value={w.id}>{w.code} — {L(w)}</option>)}</select>
        <Link className="btn btn--secondary" to="/reports"><Icon name="report" />{t("rep.reports")}</Link>
      </>} />
      {r.isLoading ? <Loading /> : (
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
          {r.data.data.map((k: any) => (
            <div key={k.key} className="card" style={{ borderTop: `4px solid ${k.status === "good" ? "var(--iarda-primary)" : k.status === "bad" ? "var(--iarda-error, #B42318)" : k.status === "warn" ? "var(--iarda-gold)" : "var(--iarda-sand)"}` }}>
              <div className="kpi__top"><span className="kpi__label">{lang === "ar" ? k.label_ar : k.label_en}</span><St s={k.status} /></div>
              <div className="kpi__value ltr" style={{ margin: "6px 0" }}>{k.value == null ? "—" : `${fmtNum(k.value, 1)}${k.unit === "%" ? "%" : k.unit === "h" ? " h" : k.unit === "×" ? "×" : ""}`}</div>
              <div className="muted" style={{ fontSize: 13 }}>{t("kpi.target")}: <span className="ltr">{fmtT(k)}</span></div>
              <div style={{ marginTop: 8 }}><Spark points={k.trend} target={k.target} dir={k.dir} /></div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ============================================================ reports
const FREQ = ["daily", "weekly", "monthly"] as const;
const DAYS_AR = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const DAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function ReportsPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") ?? "catalog";
  const cat = useQuery({ queryKey: ["reports"], queryFn: () => api.get("/api/reports") });
  const runs = useQuery({ queryKey: ["report-runs"], queryFn: () => api.get("/api/report-runs"), enabled: tab === "history" });
  const sch = useQuery({ queryKey: ["report-schedules"], queryFn: () => api.get("/api/report-schedules"), enabled: tab === "schedules" && can("report.export") });
  const whs = useWarehouses();
  const counts = useQuery({ queryKey: ["counts"], queryFn: () => api.get("/api/counts").catch(() => ({ data: [] })) });
  const [params, setParams] = useState<Record<string, Record<string, string>>>({});
  const [rlang, setRlang] = useState(lang);
  const [open, setOpen] = useState(false);
  const a = useAct([["report-schedules"], ["report-runs"]]);
  const titleOf = (code: string) => { const r = cat.data?.data.find((x: any) => x.code === code); return r ? L({ name_ar: r.title.ar, name_en: r.title.en }) : code; };
  const url = (code: string, format: string) => {
    const p = new URLSearchParams({ format, lang: rlang, ...(params[code] ?? {}) });
    for (const [k, v] of [...p]) if (!v) p.delete(k);
    return `/api/reports/${code}/download?${p}`;
  };
  return (
    <>
      <PageHead icon="report" title={t("rep.reports")} actions={<>
        <select className="select" style={{ width: "auto" }} value={rlang} onChange={(e) => setRlang(e.target.value)} aria-label={t("rep.lang")}>
          <option value="ar">العربية</option><option value="en">English</option></select>
        {can("report.export") && <button className="btn btn--primary" onClick={() => setOpen(true)}><Icon name="calendar" />{t("rep.newSchedule")}</button>}
      </>} />
      <section className="card">
        <Tabs value={tab} onChange={(v) => setSp({ tab: v })} tabs={[{ id: "catalog", label: t("rep.catalog") }, ...(can("report.export") ? [{ id: "schedules", label: t("rep.schedules") }] : []),
          { id: "history", label: t("rep.history") }]} />
        {tab === "catalog" && (cat.isLoading ? <Loading /> : (<>
          {!cat.data.canExport && <div style={{ marginBottom: 12 }}><Alert>{t("rep.exportNote")}</Alert></div>}
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
            {cat.data.data.map((r: any) => (
              <div key={r.code} className="card card--cream" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div><h3 style={{ margin: 0, color: "var(--iarda-primary-dark)", fontSize: 16 }}>{lang === "ar" ? r.title.ar : r.title.en}</h3>
                  <div className="muted" style={{ fontSize: 13 }}>{lang === "ar" ? r.description.ar : r.description.en}</div></div>
                {r.params.includes("warehouseId") && <select className="select" value={params[r.code]?.warehouseId ?? ""} onChange={(e) => setParams({ ...params, [r.code]: { ...params[r.code], warehouseId: e.target.value } })}>
                  <option value="">{t("ops.all")}</option>{(whs.data?.data ?? []).map((w: any) => <option key={w.id} value={w.id}>{w.code} — {L(w)}</option>)}</select>}
                {r.params.includes("planId") && <select className="select" value={params[r.code]?.planId ?? ""} onChange={(e) => setParams({ ...params, [r.code]: { ...params[r.code], planId: e.target.value } })}>
                  <option value="">{t("rep.plan")} …</option>{(counts.data?.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.plan_no} · {p.warehouse_code} · {t(`docStatus.${p.status}`)}</option>)}</select>}
                {r.params.includes("period") && <input className="input" type="month" value={params[r.code]?.period ?? ""} onChange={(e) => setParams({ ...params, [r.code]: { ...params[r.code], period: e.target.value } })} />}
                {r.params.includes("days") && <input className="input" type="number" min="1" placeholder={`${t("rep.days")} (90)`} value={params[r.code]?.days ?? ""}
                  onChange={(e) => setParams({ ...params, [r.code]: { ...params[r.code], days: e.target.value } })} />}
                <div style={{ display: "flex", gap: 8, marginTop: "auto", flexWrap: "wrap" }}>
                  {(r.params.includes("planId") && !params[r.code]?.planId) ? <small className="muted">{t("rep.plan")}</small> : <>
                    <a className="btn btn--primary btn--sm" href={url(r.code, "pdf")}><Icon name="pdf" className="icon icon-sm" />PDF</a>
                    {cat.data.canExport && <a className="btn btn--secondary btn--sm" href={url(r.code, "xlsx")}><Icon name="sheet" className="icon icon-sm" />Excel</a>}
                    {cat.data.canExport && <a className="btn btn--secondary btn--sm" href={url(r.code, "pptx")}><Icon name="slides" className="icon icon-sm" />PowerPoint</a>}
                  </>}
                </div>
              </div>
            ))}
          </div>
        </>))}
        {tab === "schedules" && (sch.isLoading ? <Loading /> : (
          <ListCard empty={!sch.data?.data.length}
            head={<><th>{t("common.name", { defaultValue: "Name" })}</th><th>{t("rep.reports")}</th><th>{t("rep.frequency")}</th><th>{t("rep.recipients")}</th><th>{t("rep.nextRun")}</th><th className="c">{t("common.status")}</th><th /></>}
            rows={sch.data.data.map((s: any) => (
              <tr key={s.id}><td>{s.name}<br /><small className="muted">{s.runs} · {s.last_run_at ? fmtDate(s.last_run_at, lang, true) : "—"}</small></td>
                <td>{titleOf(s.report_code)} <span className="chip">{s.format.toUpperCase()}</span></td>
                <td>{t(`rep.${s.frequency}`)}{s.frequency === "weekly" && ` · ${(lang === "ar" ? DAYS_AR : DAYS_EN)[s.weekday]}`}{s.frequency === "monthly" && ` · ${s.monthday}`} · <span className="ltr">{String(s.hour).padStart(2, "0")}:00</span></td>
                <td><small>{(lang === "ar" ? s.recipients_ar : s.recipients_en)?.join("، ")}</small></td>
                <td><small>{fmtDate(s.next_run_at, lang, true)}</small></td>
                <td className="c"><span className={`badge ${s.is_active ? "badge--success" : "badge--neutral"}`}>{t(s.is_active ? "rep.active" : "rep.paused")}</span></td>
                <td><div style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn--secondary btn--sm" disabled={a.busy} onClick={() => a.run(() => api.post(`/api/report-schedules/${s.id}/run`))}>{t("rep.runNow")}</button>
                  <button className="btn btn--ghost btn--sm" disabled={a.busy} onClick={() => a.run(() => api.post(`/api/report-schedules/${s.id}/toggle`))}>{t("rep.toggle")}</button>
                  <button className="btn btn--ghost btn--sm" disabled={a.busy} onClick={() => a.run(() => api.post(`/api/report-schedules/${s.id}/delete`))}>{t("common.delete")}</button></div></td>
              </tr>
            ))} />
        ))}
        {tab === "history" && (runs.isLoading ? <Loading /> : (
          <ListCard empty={!runs.data.data.length}
            head={<><th>{t("rep.reports")}</th><th>{t("common.date", { defaultValue: "Date" })}</th><th>{t("common.createdBy")}</th><th className="c">{t("common.status")}</th><th /></>}
            rows={runs.data.data.map((r: any) => (
              <tr key={r.id}><td>{titleOf(r.report_code)} <span className="chip">{r.format.toUpperCase()}</span>{r.schedule_name && <div><small className="muted">{r.schedule_name}</small></div>}</td>
                <td><small>{fmtDate(r.created_at, lang, true)}</small></td><td>{lang === "ar" ? r.by_ar : r.by_en}</td>
                <td className="c"><St s={r.status === "ok" ? "sent" : "failed"} /></td>
                <td>{r.attachment_id && <a className="btn btn--ghost btn--sm" href={`/api/attachments/${r.attachment_id}/content`}><Icon name="download" className="icon icon-sm" />{t("rep.download")}</a>}</td></tr>
            ))} />
        ))}
      </section>
      {open && <ScheduleModal reports={cat.data?.data ?? []} onClose={() => setOpen(false)} />}
    </>
  );
}

function ScheduleModal({ reports, onClose }: { reports: any[]; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const a = useAct([["report-schedules"]]);
  const [, setSp] = useSearchParams();
  const users = useQuery({ queryKey: ["recipients"], queryFn: () => api.get("/api/recipients") });
  const usable = reports.filter((r) => !r.params.includes("planId"));
  const [f, setF] = useState({ name: "", reportCode: usable[0]?.code ?? "", format: "pdf", lang, frequency: "weekly", weekday: 0, monthday: 1, hour: 7 });
  const [rec, setRec] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const valid = f.name.trim().length >= 3 && f.reportCode && rec.length > 0;
  return (
    <Modal title={t("rep.newSchedule")} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn--primary" disabled={!valid || a.busy} onClick={() => a.run(() => api.post("/api/report-schedules", { ...f, recipientIds: rec,
        weekday: f.frequency === "weekly" ? f.weekday : null, monthday: f.frequency === "monthly" ? f.monthday : null }), () => { onClose(); setSp({ tab: "schedules" }); })}>{t("common.save")}</button></>}>
      <Field label={t("common.name", { defaultValue: "Name" })} required><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <div className="grid" style={{ gridTemplateColumns: "2fr 1fr 1fr", gap: 12 }}>
        <Field label={t("rep.reports")}><select className="select" value={f.reportCode} onChange={(e) => setF({ ...f, reportCode: e.target.value })}>
          {usable.map((r) => <option key={r.code} value={r.code}>{lang === "ar" ? r.title.ar : r.title.en}</option>)}</select></Field>
        <Field label="Format"><select className="select" value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })}>{["pdf", "xlsx", "pptx"].map((x) => <option key={x}>{x}</option>)}</select></Field>
        <Field label={t("rep.lang")}><select className="select" value={f.lang} onChange={(e) => setF({ ...f, lang: e.target.value })}><option value="ar">العربية</option><option value="en">English</option></select></Field>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <Field label={t("rep.frequency")}><select className="select" value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}>{FREQ.map((x) => <option key={x} value={x}>{t(`rep.${x}`)}</option>)}</select></Field>
        {f.frequency === "weekly" && <Field label={t("rep.weekday")}><select className="select" value={f.weekday} onChange={(e) => setF({ ...f, weekday: Number(e.target.value) })}>
          {(lang === "ar" ? DAYS_AR : DAYS_EN).map((d, i) => <option key={i} value={i}>{d}</option>)}</select></Field>}
        {f.frequency === "monthly" && <Field label={t("rep.monthday")}><input className="input" type="number" min="1" max="28" value={f.monthday} onChange={(e) => setF({ ...f, monthday: Number(e.target.value) })} /></Field>}
        <Field label={t("rep.hour")}><input className="input" type="number" min="0" max="23" value={f.hour} onChange={(e) => setF({ ...f, hour: Number(e.target.value) })} /></Field>
      </div>
      <Field label={t("rep.recipients")} required>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="…" style={{ marginBottom: 6 }} />
        <div style={{ maxHeight: 180, overflow: "auto", display: "grid", gap: 4 }}>
          {(users.data?.data ?? []).filter((u: any) => !q || `${u.name_ar} ${u.name_en}`.toLowerCase().includes(q.toLowerCase())).map((u: any) => (
            <label key={u.id} style={{ display: "flex", gap: 8 }}><input type="checkbox" checked={rec.includes(u.id)} onChange={(e) => setRec(e.target.checked ? [...rec, u.id] : rec.filter((x) => x !== u.id))} />
              {L(u)} <small className="muted">{L(u, "org")}</small></label>))}
        </div>
      </Field>
    </Modal>
  );
}

// ============================================================ integrations console
export function IntegrationsPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") ?? "clients";
  const r = useQuery({ queryKey: ["integrations"], queryFn: () => api.get("/api/admin/integrations") });
  const out = useQuery({ queryKey: ["outbox"], queryFn: () => api.get("/api/admin/integrations/outbox"), enabled: tab === "outbox" });
  const mails = useQuery({ queryKey: ["emails"], queryFn: () => api.get("/api/admin/emails"), enabled: tab === "emails" });
  const calls = useQuery({ queryKey: ["int-calls"], queryFn: () => api.get("/api/admin/integrations/calls"), enabled: tab === "calls" });
  const a = useAct([["integrations"], ["outbox"]]);
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState<any>(null);
  return (
    <>
      <PageHead icon="globe" title={t("integ.integrations")} actions={<>
        <a className="btn btn--secondary" href="/api/docs" target="_blank" rel="noreferrer"><Icon name="report" />{t("integ.docs")}</a>
        {can("admin.settings") && <button className="btn btn--primary" onClick={() => setOpen(true)}><Icon name="plus" />{t("integ.newClient")}</button>}
      </>} />
      <section className="card">
        <Tabs value={tab} onChange={(v) => setSp({ tab: v })} tabs={[{ id: "clients", label: t("integ.clients") }, { id: "outbox", label: t("integ.outbox") },
          { id: "emails", label: t("integ.emails") }, { id: "calls", label: t("integ.callLog") }]} />
        {tab === "clients" && (r.isLoading ? <Loading /> : (<>
          <div className="chips" style={{ marginBottom: 12 }}>{r.data.outbox.map((o: any) => <span key={`${o.system}${o.status}`} className="chip">{o.system} · {o.status}: {o.n}</span>)}</div>
          <ListCard empty={!r.data.clients.length}
            head={<><th>{t("common.name", { defaultValue: "Name" })}</th><th>{t("integ.system")}</th><th>{t("integ.scopes")}</th><th>{t("integ.lastUsed")}</th><th className="c">{t("integ.calls")}</th><th className="c">{t("common.status")}</th><th /></>}
            rows={r.data.clients.map((c: any) => (
              <tr key={c.id}><td>{c.name}<br /><small className="mono muted">iwk_{c.key_prefix}_••••</small></td><td className="mono">{c.system}</td>
                <td><div className="chips">{c.scopes.map((s: string) => <span key={s} className="chip mono">{s}</span>)}</div></td>
                <td><small>{c.last_used_at ? fmtDate(c.last_used_at, lang, true) : "—"}</small></td><td className="n">{c.calls_24h}</td>
                <td className="c"><span className={`badge ${c.is_active ? "badge--success" : "badge--neutral"}`}>{t(c.is_active ? "rep.active" : "rep.paused")}</span></td>
                <td>{can("admin.settings") && <button className="btn btn--ghost btn--sm" disabled={a.busy} onClick={() => a.run(() => api.post(`/api/admin/integrations/${c.id}/toggle`))}>{t("rep.toggle")}</button>}</td></tr>
            ))} />
        </>))}
        {tab === "outbox" && (out.isLoading ? <Loading /> : (<>
          <div style={{ marginBottom: 12 }}><Alert>{t("integ.stubNote")}</Alert></div>
          <ListCard empty={!out.data.data.length}
            head={<><th>#</th><th>{t("integ.system")}</th><th>{t("integ.event")}</th><th>{t("inv.docType")}</th><th>{t("common.date", { defaultValue: "Date" })}</th><th className="c">{t("common.status")}</th><th /></>}
            rows={out.data.data.map((e: any) => (
              <tr key={e.id}><td className="mono">{e.id}</td><td className="mono">{e.system}</td><td className="mono">{e.event}</td><td className="mono">{e.doc_no}</td>
                <td><small>{fmtDate(e.created_at, lang, true)}</small></td><td className="c"><St s={e.status} />{e.last_error && <div className="overdue" style={{ fontSize: 12 }}>{e.last_error}</div>}</td>
                <td><div style={{ display: "flex", gap: 6 }}><button className="btn btn--ghost btn--sm" onClick={() => setPayload(e)}>JSON</button>
                  {can("admin.settings") && ["failed", "stub"].includes(e.status) && <button className="btn btn--ghost btn--sm" onClick={() => a.run(() => api.post(`/api/admin/integrations/outbox/${e.id}/retry`))}>{t("integ.retry")}</button>}</div></td></tr>
            ))} />
        </>))}
        {tab === "emails" && (mails.isLoading ? <Loading /> : (<>
          {!mails.data.smtp && <div style={{ marginBottom: 12 }}><Alert kind="warning">{t("integ.smtpOff")}</Alert></div>}
          <div className="chips" style={{ marginBottom: 12 }}>{mails.data.summary.map((s: any) => <span key={s.status} className="chip">{t(`docStatus.${s.status}`)}: {s.n}</span>)}</div>
          <ListCard empty={!mails.data.data.length}
            head={<><th>{t("common.date", { defaultValue: "Date" })}</th><th>{lang === "ar" ? "إلى" : "To"}</th><th>{lang === "ar" ? "الموضوع" : "Subject"}</th><th className="c">{t("common.status")}</th><th /></>}
            rows={mails.data.data.map((m: any) => (
              <tr key={m.id}><td><small>{fmtDate(m.created_at, lang, true)}</small></td><td className="mono"><small>{m.to_email}</small></td><td>{m.subject}</td>
                <td className="c"><St s={m.status} /></td><td>{can("admin.settings") && <a className="btn btn--ghost btn--sm" href={`/api/admin/emails/${m.id}/preview`} target="_blank" rel="noreferrer">{t("integ.preview")}</a>}</td></tr>
            ))} />
        </>))}
        {tab === "calls" && (calls.isLoading ? <Loading /> : (
          <ListCard empty={!calls.data.data.length}
            head={<><th>{t("common.date", { defaultValue: "Date" })}</th><th>{t("common.name", { defaultValue: "Client" })}</th><th>Method</th><th>Path</th><th className="c">HTTP</th><th className="c">ms</th></>}
            rows={calls.data.data.map((k: any) => (
              <tr key={k.id}><td><small>{fmtDate(k.at, lang, true)}</small></td><td>{k.name ?? "—"}</td><td className="mono">{k.method}</td><td className="mono"><small>{k.path}</small></td>
                <td className="c"><span className={`badge ${k.status_code < 300 ? "badge--success" : k.status_code < 500 ? "badge--warning" : "badge--error"}`}>{k.status_code}</span></td><td className="n">{k.duration_ms}</td></tr>
            ))} />
        ))}
      </section>
      {open && <ClientModal scopes={r.data?.scopes ?? []} onClose={() => setOpen(false)} />}
      {payload && <Modal wide title={`${payload.event} · ${payload.doc_no}`} onClose={() => setPayload(null)}>
        <pre className="mono" style={{ direction: "ltr", textAlign: "left", fontSize: 12, maxHeight: 420, overflow: "auto", background: "var(--iarda-bg-light)", padding: 12, borderRadius: 8 }}>{JSON.stringify(payload.payload, null, 2)}</pre>
      </Modal>}
    </>
  );
}

function ClientModal({ scopes, onClose }: { scopes: string[]; onClose: () => void }) {
  const { t } = useTranslation();
  const a = useAct([["integrations"]]);
  const [f, setF] = useState({ name: "", system: "erp", ips: "" });
  const [sel, setSel] = useState<string[]>([]);
  const [key, setKey] = useState<string | null>(null);
  return (
    <Modal title={t("integ.newClient")} onClose={onClose} footer={key ? <button className="btn btn--primary" onClick={onClose}>{t("common.close", { defaultValue: "Close" })}</button> : <>
      <button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn--primary" disabled={f.name.trim().length < 3 || !sel.length || a.busy} onClick={() => a.run(() => api.post("/api/admin/integrations", {
        name: f.name, system: f.system, scopes: sel, allowedIps: f.ips ? f.ips.split(/[\s,]+/).filter(Boolean) : null }), (r) => setKey(r.apiKey))}>{t("common.save")}</button></>}>
      {key ? <>
        <Alert kind="warning">{t("integ.keyOnce")}</Alert>
        <pre className="mono" style={{ direction: "ltr", userSelect: "all", background: "var(--iarda-bg-light)", padding: 12, borderRadius: 8, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{key}</pre>
        <small className="muted ltr">curl -H "x-api-key: {key.slice(0, 13)}…" /api/integration/v1/ping</small>
      </> : <>
        <Field label={t("common.name", { defaultValue: "Name" })} required><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={t("integ.system")}><select className="select" value={f.system} onChange={(e) => setF({ ...f, system: e.target.value })}>
          {["erp", "etimad", "cmms", "hr", "other"].map((s) => <option key={s} value={s}>{s.toUpperCase()}</option>)}</select></Field>
        <Field label={t("integ.scopes")} required><div style={{ display: "grid", gap: 4 }}>{scopes.map((s) => (
          <label key={s} style={{ display: "flex", gap: 8 }}><input type="checkbox" checked={sel.includes(s)} onChange={(e) => setSel(e.target.checked ? [...sel, s] : sel.filter((x) => x !== s))} />
            <span className="mono">{s}</span></label>))}</div></Field>
        <Field label="IP allow-list" hint="10.0.0.5, 10.0.0.6"><input className="input mono" value={f.ips} onChange={(e) => setF({ ...f, ips: e.target.value })} /></Field>
      </>}
    </Modal>
  );
}

// ============================================================ labels
export function LabelsPage() {
  const { t } = useTranslation();
  const L = useL();
  const whs = useWarehouses();
  const [wh, setWh] = useState("");
  const [zone, setZone] = useState("");
  const whId = wh || whs.data?.data[0]?.id;
  const zones = useQuery({ queryKey: ["zones", whId], queryFn: () => api.get(`/api/warehouses/${whId}/locations`, { level: "zone" }), enabled: !!whId });
  const bins = useQuery({ queryKey: ["label-bins", whId, zone], queryFn: () => api.get("/api/labels/bins", { warehouseId: whId, zoneId: zone || undefined }), enabled: !!whId });
  const zpl = `/api/labels/bins.zpl?warehouseId=${whId ?? ""}${zone ? `&zoneId=${zone}` : ""}`;
  return (
    <>
      <PageHead icon="table" title={t("lbl.labels")} actions={<>
        <a className="btn btn--secondary" href={zpl}><Icon name="download" />{t("lbl.zpl")}</a>
        <button className="btn btn--primary" onClick={() => window.print()}><Icon name="report" />{t("lbl.printSheet")}</button>
      </>} />
      <section className="card section no-print">
        <div className="toolbar">
          <select className="select" style={{ width: "auto" }} value={whId} onChange={(e) => { setWh(e.target.value); setZone(""); }}>
            {(whs.data?.data ?? []).map((w: any) => <option key={w.id} value={w.id}>{w.code} — {L(w)}</option>)}</select>
          <select className="select" style={{ width: "auto" }} value={zone} onChange={(e) => setZone(e.target.value)}>
            <option value="">{t("lbl.zone")}: {t("lbl.all")}</option>{(zones.data?.data ?? []).map((z: any) => <option key={z.id} value={z.id}>{z.code ?? z.full_code} — {L(z)}</option>)}</select>
          <span className="muted">{bins.data?.data.length ?? "…"} {t("lbl.bins")}</span>
        </div>
      </section>
      {bins.isLoading ? <Loading /> : !bins.data?.data.length ? <Empty /> : (
        <div className="label-sheet">
          {bins.data.data.slice(0, 300).map((b: any) => (
            <div key={b.id} className="label">
              <div className="label__top"><b>{b.warehouse_code}</b><span>{L(b, "zone")}</span></div>
              <div className="label__bars" dangerouslySetInnerHTML={{ __html: code128Svg(b.barcode ?? b.full_code, 46) }} />
              <div className="label__code mono">{b.full_code}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ============================================================ supplier portal
export function PortalPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") ?? "deliveries";
  const d = useQuery({ queryKey: ["portal-del"], queryFn: () => api.get("/api/portal/deliveries"), enabled: tab === "deliveries" });
  const inv = useQuery({ queryKey: ["portal-inv"], queryFn: () => api.get("/api/portal/invoices"), enabled: tab === "invoices" });
  return (
    <>
      <PageHead icon="users" title={t("portal.portal")} />
      <section className="card">
        <Tabs value={tab} onChange={(v) => setSp({ tab: v })} tabs={[{ id: "deliveries", label: t("portal.deliveries") }, { id: "invoices", label: t("portal.invoices") }]} />
        {tab === "deliveries" && (d.isLoading ? <Loading /> : (
          <ListCard empty={!d.data.data.length}
            head={<><th>{t("ops.po")}</th><th>{t("ops.asn")}</th><th>{t("ops.receipts")}</th><th>{t("ops.warehouse")}</th><th className="c">{t("portal.accepted")}</th><th className="c">{t("portal.rejected")}</th><th>{t("ops.grn")}</th></>}
            rows={d.data.data.map((x: any, i: number) => (
              <tr key={i}><td className="mono">{x.po_no}<br /><small className="muted">{L(x, "supplier")}</small></td>
                <td>{x.asn_no ? <><span className="mono">{x.asn_no}</span><br /><small className="muted">{fmtDate(x.expected_at, lang)}</small></> : "—"}</td>
                <td>{x.receipt_no ? <><span className="mono">{x.receipt_no}</span> <St s={x.receipt_status} dict="rcvStatus" /></> : "—"}</td>
                <td className="mono">{x.warehouse_code}</td><td className="n">{fmtNum(x.qty_accepted)}</td><td className="n">{Number(x.qty_rejected) ? <span className="overdue">{fmtNum(x.qty_rejected)}</span> : "0"}</td>
                <td>{x.grn_no ? <><span className="mono">{x.grn_no}</span><br /><small className="muted">{fmtDate(x.grn_posted_at, lang)}</small></> : "—"}</td></tr>
            ))} />
        ))}
        {tab === "invoices" && (inv.isLoading ? <Loading /> : (
          <ListCard empty={!inv.data.data.length}
            head={<><th>{t("ops.invoiceNo")}</th><th>{t("ops.po")}</th><th>{t("ops.invoiceDate")}</th><th className="c">{t("ops.value")}</th><th className="c">{t("ops.match")}</th><th className="c">{t("common.status")}</th></>}
            rows={inv.data.data.map((x: any, i: number) => (
              <tr key={i}><td className="mono">{x.invoice_no}</td><td className="mono">{x.po_no}</td><td>{fmtDate(x.invoice_date, lang)}</td><td className="n">{fmtSar(x.total_amount)}</td>
                <td className="c">{x.match_result ? <St s={x.match_result} dict="mrStatus" /> : "—"}</td><td className="c"><St s={x.status} dict="mrStatus" /></td></tr>
            ))} />
        ))}
      </section>
    </>
  );
}

