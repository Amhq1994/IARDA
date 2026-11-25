// Warehouse-floor task screens (/m): large touch targets, scan-first, one task at a time.
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api";
import { useAuth, setLanguage } from "../auth";
import { Alert, Icon, Loading, Toaster, toast } from "../components/ui";
import { ScanInput } from "../components/ops";
import { errorText, fmtDate, fmtNum, useL } from "../util";

function Shell({ title, back, children }: { title: string; back?: string; children: React.ReactNode }) {
  const { t, i18n } = useTranslation();
  const nav = useNavigate();
  return (
    <div className="m-shell">
      <div className="m-top">
        {back ? <button className="icon-btn" onClick={() => nav(back)} aria-label={t("common.back")}><Icon name="chevron" flip={i18n.language === "en"} /></button>
          : <Link className="icon-btn" to="/" aria-label={t("nav.dashboard")}><Icon name="dashboard" /></Link>}
        <b>{title}</b>
        <button className="btn btn--ghost btn--sm" style={{ color: "#fff" }} onClick={() => setLanguage(i18n.language === "ar" ? "en" : "ar", true)}>{t("app.switchLang")}</button>
      </div>
      <div className="m-body">{children}</div>
      <Toaster />
    </div>
  );
}

export function MobileHome() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const put = useQuery({ queryKey: ["m-put"], queryFn: () => api.get("/api/putaway-tasks"), enabled: can("putaway.execute") });
  const picks = useQuery({ queryKey: ["m-picks"], queryFn: () => api.get("/api/pick-lists"), enabled: can("pick.execute") });
  return (
    <Shell title={t("ops.tasks")}>
      {can("pick.execute") && <Link className="m-card" to="/m/pick"><h3><Icon name="table" /> {t("ops.picking")}</h3><div className="m-big">{picks.data?.data.length ?? "…"}</div></Link>}
      {can("putaway.execute") && <Link className="m-card" to="/m/putaway"><h3><Icon name="map" /> {t("ops.putaway")}</h3><div className="m-big">{put.data?.data.length ?? "…"}</div></Link>}
      <Link className="m-card" to="/m/lookup"><h3><Icon name="search" /> {t("ops.scan")}</h3><div className="muted">{t("item.lookupHint")}</div></Link>
    </Shell>
  );
}

// ------------------------------------------------------------------ put-away
export function MobilePutawayList() {
  const { t } = useTranslation();
  const L = useL();
  const q = useQuery({ queryKey: ["m-put"], queryFn: () => api.get("/api/putaway-tasks") });
  return (
    <Shell title={t("ops.putaway")} back="/m">
      {q.isLoading ? <Loading /> : !q.data.data.length ? <div className="m-card">{t("ops.noTasks")}</div> : q.data.data.map((x: any) => (
        <Link key={x.id} className="m-card" to={`/m/putaway/${x.id}`}>
          <h3 className="mono">{x.item_code} · {fmtNum(x.qty)} {x.uom_code}</h3>
          <div>{L(x)}</div>
          <div className="muted mono">{x.from_code} → {x.suggested_code ?? "?"}</div>
        </Link>
      ))}
    </Shell>
  );
}

export function MobilePutawayTask() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const L = useL();
  const nav = useNavigate();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["m-put"], queryFn: () => api.get("/api/putaway-tasks") });
  const sug = useQuery({ queryKey: ["m-put-sug", id], queryFn: () => api.get(`/api/putaway-tasks/${id}/suggestions`) });
  const [needReason, setNeedReason] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const task = list.data?.data.find((x: any) => x.id === id);
  async function place(code: string, why?: string) {
    try {
      const r = await api.post(`/api/putaway-tasks/${id}/complete`, { scannedLocation: code, overrideReason: why });
      toast.success(`✓ ${r.fullCode}`);
      qc.invalidateQueries({ queryKey: ["m-put"] });
      nav("/m/putaway");
    } catch (e) {
      if (e instanceof ApiError && e.code === "override_reason_required") setNeedReason(code);
      else toast.error(errorText(e, i18n.language));
    }
  }
  if (!task) return <Shell title={t("ops.putaway")} back="/m/putaway"><Loading /></Shell>;
  return (
    <Shell title={task.task_no} back="/m/putaway">
      <div className="m-card">
        <h3 className="mono">{task.item_code}</h3><div>{L(task)}</div>
        <div className="m-big">{fmtNum(task.qty)} <small>{task.uom_code}</small></div>
        {(task.lot_no || task.serial_no) && <div className="mono muted">{task.serial_no ?? task.lot_no}{task.expiry_date && ` · ${fmtDate(task.expiry_date, i18n.language)}`}</div>}
        <div className="muted">{t("ops.from")}: <span className="mono">{task.from_code}</span></div>
      </div>
      <div className="m-target"><div className="muted">{t("ops.suggested")}</div><div className="mono">{task.suggested_code ?? "—"}</div>
        {sug.data?.data[0] && <div className="muted" style={{ fontSize: 12 }}>{sug.data.data[0].reasons.map((r: any) => r.key).join(" · ")}</div>}</div>
      <div className="m-card">
        <ScanInput label={t("ops.scanLocation")} autoFocus onScan={(c) => place(c)} placeholder={task.suggested_code} />
        {needReason && <>
          <Alert kind="warning">{t("ops.overrideReason")}: <span className="mono">{needReason}</span></Alert>
          <input className="input" style={{ marginTop: 8 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("ops.overrideReason")} />
          <button className="btn btn--primary btn--block" style={{ marginTop: 8 }} disabled={reason.trim().length < 3} onClick={() => place(needReason, reason)}>{t("ops.confirm")}</button>
        </>}
      </div>
      {sug.data?.data.length > 1 && <div className="m-card"><div className="muted">{i18n.language === "ar" ? "مواقع بديلة مناسبة" : "Other suitable bins"}</div>
        {sug.data.data.slice(1).map((s: any) => <div key={s.locationId} className="mono">{s.fullCode} <small className="muted">({s.score})</small></div>)}</div>}
    </Shell>
  );
}

// ------------------------------------------------------------------ picking
export function MobilePickLists() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["m-picks"], queryFn: () => api.get("/api/pick-lists") });
  return (
    <Shell title={t("ops.picking")} back="/m">
      {q.isLoading ? <Loading /> : !q.data.data.length ? <div className="m-card">{t("ops.noTasks")}</div> : q.data.data.map((p: any) => (
        <Link key={p.id} className="m-card" to={`/m/pick/${p.id}`}>
          <h3 className="mono">{p.pick_no}</h3>
          <div className="mono muted">{p.mr_no} · {t(`mrType.${p.request_type}`)}{p.priority === "urgent" && " ⚡"}{p.is_overdue && " ⏱"}</div>
          <div className="m-big">{p.tasks - p.open_tasks} / {p.tasks}</div>
        </Link>
      ))}
    </Shell>
  );
}

export function MobilePickList() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const L = useL();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["m-pick", id], queryFn: () => api.get(`/api/pick-lists/${id}`) });
  const [loc, setLoc] = useState<string | null>(null);
  const [qty, setQty] = useState<string>("");
  const pl: any = q.data;
  if (!pl) return <Shell title={t("ops.picking")} back="/m/pick"><Loading /></Shell>;
  const task = pl.tasks.find((x: any) => x.status === "open");
  const done = pl.tasks.filter((x: any) => x.status !== "open").length;
  async function confirm(itemCode: string) {
    try {
      const r = await api.post(`/api/pick-tasks/${task.id}/confirm`, { location: loc, item: itemCode, lot: task.serial_no ?? task.lot_no, qty: Number(qty || task.qty) });
      toast.success(r.short ? "⚠ short" : "✓");
      setLoc(null); setQty("");
      qc.invalidateQueries({ queryKey: ["m-pick", id] }); qc.invalidateQueries({ queryKey: ["m-picks"] });
    } catch (e) { toast.error(errorText(e, i18n.language)); }
  }
  return (
    <Shell title={`${pl.pick_no} · ${done}/${pl.tasks.length}`} back="/m/pick">
      {!task ? <div className="m-card"><h3 className="m-ok">✓ {t("ops.done")}</h3><div className="mono">{pl.mr_no}</div></div> : <>
        <div className="m-target"><div className="muted">{t("ops.location")}</div><div className="mono">{task.full_code}</div></div>
        <div className="m-card">
          <h3 className="mono">{task.item_code}</h3><div>{L(task)}</div>
          <div className="m-big">{fmtNum(task.qty)} <small>{task.uom_code}</small></div>
          {(task.lot_no || task.serial_no) && <div className="mono">{t("ops.lot")}: {task.serial_no ?? task.lot_no}{task.expiry_date && ` · ${fmtDate(task.expiry_date, i18n.language)}`}</div>}
        </div>
        <div className="m-card">
          {!loc ? <ScanInput key="loc" label={`1 · ${t("ops.scanLocation")}`} autoFocus onScan={(c) => {
            if (c.toUpperCase() !== task.full_code && c !== task.location_barcode) toast.error(i18n.language === "ar" ? "موقع غير صحيح" : "Wrong location"); else setLoc(c);
          }} /> : <>
            <div className="m-ok">✓ {loc}</div>
            <label style={{ display: "block", marginTop: 10, fontWeight: 500, color: "var(--iarda-primary)" }}>{t("ops.qty")}</label>
            <input className="input" type="number" min={0} max={task.qty} step="any" value={qty} placeholder={String(task.qty)} onChange={(e) => setQty(e.target.value)} style={{ marginBottom: 10 }} />
            <ScanInput key="item" label={`2 · ${t("ops.scanItem")}`} autoFocus onScan={confirm} placeholder={task.item_barcode ?? task.item_code} />
          </>}
        </div>
      </>}
      <div className="m-card">{pl.tasks.map((x: any) => (
        <div key={x.id} className="kpi-target"><span className="mono">{x.seq}. {x.full_code}</span><span className="mono">{x.item_code} × {fmtNum(x.qty)} {x.status !== "open" && <span className="m-ok">✓</span>}</span></div>
      ))}</div>
    </Shell>
  );
}

export function MobileLookup() {
  const { t, i18n } = useTranslation();
  const L = useL();
  const [res, setRes] = useState<any>(null);
  async function look(code: string) {
    try {
      const l = await api.get("/api/locations/lookup", { code }).catch(() => null);
      if (l) { setRes({ kind: "bin", loc: l, stock: (await api.get(`/api/locations/${l.id}/stock`)).data }); return; }
      const it = await api.get("/api/items/lookup", { code });
      setRes({ kind: "item", item: await api.get(`/api/items/${it.id}`), stock: await api.get(`/api/items/${it.id}/stock`) });
    } catch (e) { toast.error(errorText(e, i18n.language)); setRes(null); }
  }
  return (
    <Shell title={t("ops.scan")} back="/m">
      <div className="m-card"><ScanInput label={t("item.lookupHint")} autoFocus onScan={look} /></div>
      {res?.kind === "bin" && <div className="m-card"><h3 className="mono">{res.loc.full_code}</h3>
        {res.stock.length === 0 ? <div className="muted">—</div> : res.stock.map((s: any) => <div className="kpi-target" key={s.id}><span><span className="mono">{s.item_code}</span> {L(s)}</span><b>{fmtNum(s.qty_on_hand)}</b></div>)}</div>}
      {res?.kind === "item" && <div className="m-card"><h3 className="mono">{res.item.item_code}</h3><div>{L(res.item)}</div>
        {res.stock.balances.map((b: any) => <div className="kpi-target" key={b.id}><span className="mono">{b.full_code}{b.lot_no && ` · ${b.lot_no}`}</span><b>{fmtNum(b.qty_free)}</b></div>)}</div>}
    </Shell>
  );
}
