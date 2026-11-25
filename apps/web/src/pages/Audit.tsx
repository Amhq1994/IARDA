import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { Alert, Empty, Icon, Loading, PageHead, Pagination, Tabs } from "../components/ui";
import { fmtDate } from "../util";

const HIDDEN = new Set(["created_at", "updated_at", "created_by", "updated_by", "version", "normalized_name"]);
const show = (v: unknown) => (v === null || v === undefined ? "∅" : typeof v === "object" ? JSON.stringify(v) : String(v));

function Diff({ row }: { row: any }) {
  const { t } = useTranslation();
  const vals = row.new_values ?? row.old_values ?? {};
  // on creation, only show fields that were actually set
  const keys = row.action === "UPDATE" ? row.changed_fields ?? []
    : Object.keys(vals).filter((k) => !HIDDEN.has(k) && vals[k] !== null && !(typeof vals[k] === "object" && Object.keys(vals[k]).length === 0));
  if (!keys.length) return null;
  return (
    <div className="diff">
      {row.action === "UPDATE" && <><span /><b className="muted">{t("audit.before")}</b><b className="muted">{t("audit.after")}</b></>}
      {keys.map((k: string) => (
        <span key={k} style={{ display: "contents" }}>
          <span className="k mono">{k}</span>
          {row.action === "UPDATE" ? <><span className="o">{show(row.old_values?.[k])}</span><span className="n">{show(row.new_values?.[k])}</span></>
            : <span className="n" style={{ gridColumn: "span 2" }}>{show((row.new_values ?? row.old_values)?.[k])}</span>}
        </span>
      ))}
    </div>
  );
}

function AuditRows({ rows }: { rows: any[] }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  if (!rows.length) return <Empty />;
  return (
    <div className="table-wrap"><table className="table"><thead><tr>
      <th style={{ width: 170 }}>{t("audit.at")}</th><th>{t("audit.actor")}</th><th>{t("audit.action")}</th><th>{t("audit.table")}</th><th>{t("audit.fields")}</th>
    </tr></thead><tbody>
      {rows.map((r) => (
        <tr key={r.id}>
          <td><small>{fmtDate(r.at, lang, true)}</small><br /><small className="mono muted">#{r.id}</small></td>
          <td>{(lang === "ar" ? r.actor_name_ar : r.actor_name_en) ?? "—"}<br /><small className="mono muted">{r.actor_username}</small></td>
          <td><span className={`badge ${r.action === "INSERT" ? "badge--success" : r.action === "UPDATE" ? "badge--warning" : "badge--error"}`}>{t(`audit.${r.action}`)}</span></td>
          <td className="mono">{r.table_name}</td>
          <td><Diff row={r} /></td>
        </tr>
      ))}
    </tbody></table></div>
  );
}

/** Embedded record history (item detail, user detail…) */
export function AuditTimeline({ table, id }: { table: string; id: string }) {
  const q = useQuery({ queryKey: ["audit-record", table, id], queryFn: () => api.get(`/api/audit/record/${table}/${id}`) });
  return q.isLoading ? <Loading /> : <AuditRows rows={q.data?.data ?? []} />;
}

export function AuditPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [tab, setTab] = useState("log");
  const [table, setTable] = useState("");
  const [action, setAction] = useState("");
  const [page, setPage] = useState(1);
  const [verify, setVerify] = useState<any>(null);
  const log = useQuery({ queryKey: ["audit", table, action, page], queryFn: () => api.get("/api/audit", { table, action, page, pageSize: 30 }), enabled: tab === "log", placeholderData: (p) => p });
  const sec = useQuery({ queryKey: ["security", page], queryFn: () => api.get("/api/audit/security-events", { page, pageSize: 30 }), enabled: tab === "security" });
  return (
    <>
      <PageHead icon="lock" title={t("audit.title")} actions={
        <button className="btn btn--secondary" onClick={async () => setVerify(await api.get("/api/audit/verify"))}><Icon name="shield" />{t("audit.verify")}</button>} />
      {verify && <div className="section"><Alert kind={verify.intact ? "success" : "error"}>
        {verify.intact ? t("audit.intact", { n: verify.checked.toLocaleString("en-US") }) : t("audit.broken", { id: verify.firstBrokenId })}</Alert></div>}
      <section className="card">
        <Tabs value={tab} onChange={(v) => { setTab(v); setPage(1); }} tabs={[{ id: "log", label: t("audit.title") }, { id: "security", label: t("audit.security") }]} />
        {tab === "log" && (
          <>
            <div className="toolbar">
              <div className="field"><label>{t("audit.table")}</label><select className="select" value={table} onChange={(e) => { setTable(e.target.value); setPage(1); }}>
                <option value="">{t("common.all")}</option>{(log.data?.tables ?? []).map((x: string) => <option key={x} value={x}>{x}</option>)}</select></div>
              <div className="field"><label>{t("audit.action")}</label><select className="select" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}>
                <option value="">{t("common.all")}</option>{["INSERT", "UPDATE"].map((x) => <option key={x} value={x}>{t(`audit.${x}`)}</option>)}</select></div>
            </div>
            {log.isLoading ? <Loading /> : <><AuditRows rows={log.data.data} /><Pagination page={page} pageSize={30} total={log.data.total} onPage={setPage} /></>}
          </>
        )}
        {tab === "security" && (sec.isLoading ? <Loading /> : (
          <>
            <div className="table-wrap"><table className="table"><thead><tr><th>{t("audit.at")}</th><th>{t("audit.event")}</th><th>{t("admin.username")}</th><th>{t("audit.ip")}</th></tr></thead>
              <tbody>{sec.data.data.map((e: any) => (
                <tr key={e.id}><td>{fmtDate(e.at, lang, true)}</td>
                  <td><span className={`badge ${e.event.includes("fail") || e.event.includes("lock") ? "badge--error" : "badge--success"}`}>{e.event}</span></td>
                  <td className="mono">{e.username}</td><td className="mono">{e.ip}</td></tr>
              ))}</tbody></table></div>
            <Pagination page={page} pageSize={30} total={sec.data.total} onPage={setPage} />
          </>
        ))}
      </section>
    </>
  );
}
