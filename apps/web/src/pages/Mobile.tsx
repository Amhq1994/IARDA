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
  const { can, me } = useAuth();
  const counts = useQuery({ queryKey: ["m-counts"], queryFn: () => api.get("/api/counts"), enabled: can("count.execute") });
  const put = useQuery({ queryKey: ["m-put"], queryFn: () => api.get("/api/putaway-tasks"), enabled: can("putaway.execute") });
  const picks = useQuery({ queryKey: ["m-picks"], queryFn: () => api.get("/api/pick-lists"), enabled: can("pick.execute") });
  return (
    <Shell title={t("ops.tasks")}>
      {can("pick.execute") && <Link className="m-card" to="/m/pick"><h3><Icon name="table" /> {t("ops.picking")}</h3><div className="m-big">{picks.data?.data.length ?? "…"}</div></Link>}
      {can("putaway.execute") && <Link className="m-card" to="/m/putaway"><h3><Icon name="map" /> {t("ops.putaway")}</h3><div className="m-big">{put.data?.data.length ?? "…"}</div></Link>}
      {can("count.execute") && <Link className="m-card" to="/m/count"><h3><Icon name="check" /> {t("nav.counting")}</h3><div className="m-big">{counts.data ? counts.data.data.filter((c: any) => c.status === "counting" && c.counter_ids.includes(me?.id)).length : "…"}</div></Link>}
      {can("transfer.bin") && <Link className="m-card" to="/m/move"><h3><Icon name="slides" /> {t("inv.moveStock")}</h3><div className="muted">{t("inv.fromBin")} → {t("inv.toBin")}</div></Link>}
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

// ------------------------------------------------------------------ blind counting
export function MobileCountList() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const q = useQuery({ queryKey: ["m-counts"], queryFn: () => api.get("/api/counts") });
  const mine = (q.data?.data ?? []).filter((c: any) => c.status === "counting" && c.counter_ids.includes(me?.id));
  return (
    <Shell title={t("nav.counting")} back="/m">
      {q.isLoading ? <Loading /> : !mine.length ? <div className="m-card">{t("ops.noTasks")}</div> : mine.map((c: any) => (
        <Link key={c.id} className="m-card" to={`/m/count/${c.id}`}>
          <h3 className="mono">{c.plan_no} · {c.warehouse_code}</h3>
          <div>{t(`inv.${c.count_type}`)}</div>
          <div className="m-big">{c.counted}/{c.lines}{c.recount > 0 && <small className="overdue"> · {t("inv.recount")} {c.recount}</small>}</div>
        </Link>
      ))}
    </Shell>
  );
}

export function MobileCount() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const L = useL();
  const { me } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["m-count", id], queryFn: () => api.get(`/api/counts/${id}`) });
  const [loc, setLoc] = useState<string | null>(null);
  const [qty, setQty] = useState("");
  const [extra, setExtra] = useState({ location: "", item: "", lot: "", qty: "" });
  const p: any = q.data;
  if (!p) return <Shell title={t("nav.counting")} back="/m/count"><Loading /></Shell>;
  const mineToDo = (l: any) => l.status === "open" || (l.status === "recount" && l.counted1_by !== me?.id);
  const todo = p.lines.filter(mineToDo);
  const line = todo[0];
  const refresh = () => { qc.invalidateQueries({ queryKey: ["m-count", id] }); qc.invalidateQueries({ queryKey: ["m-counts"] }); };
  async function record() {
    try {
      const r = await api.post(`/api/count-lines/${line.id}`, { qty: Number(qty) });
      // blind count: the counter only learns that a recount is needed, never the book quantity
      if (r.status === "recount") toast.error(i18n.language === "ar" ? "يلزم إعادة عد بواسطة زميل آخر" : "A colleague must recount this line");
      else toast.success("✓");
      setLoc(null); setQty(""); refresh();
    } catch (e) { toast.error(errorText(e, i18n.language)); }
  }
  async function unplanned() {
    try {
      await api.post(`/api/counts/${id}/unplanned`, { location: extra.location, item: extra.item, lot: extra.lot || null, qty: Number(extra.qty) });
      toast.success("✓"); setExtra({ location: "", item: "", lot: "", qty: "" }); refresh();
    } catch (e) { toast.error(errorText(e, i18n.language)); }
  }
  const counted = p.lines.filter((l: any) => l.status !== "open").length;
  return (
    <Shell title={`${p.plan_no} · ${counted}/${p.lines.length}`} back="/m/count">
      {p.blind && <Alert>{t("inv.blindHidden")}</Alert>}
      {p.status !== "counting" ? <div className="m-card"><h3>{t(`docStatus.${p.status}`)}</h3></div>
        : !line ? <div className="m-card"><h3 className="m-ok">✓ {t("ops.done")}</h3></div> : <>
        <div className="m-target"><div className="muted">{t("ops.location")}</div><div className="mono">{line.full_code}</div></div>
        <div className="m-card">
          <h3 className="mono">{line.item_code}</h3><div>{L(line)}</div>
          {(line.lot_no || line.serial_no) && <div className="mono">{t("ops.lot")}: {line.serial_no ?? line.lot_no}</div>}
          {line.status === "recount" && <div className="overdue">{t("inv.recount")}</div>}
          {line.qty_snapshot !== undefined && <div className="muted">{t("inv.snapshot")}: {fmtNum(line.qty_snapshot)} {line.uom_code}</div>}
        </div>
        <div className="m-card">
          {!loc ? <ScanInput key={`loc-${line.id}`} label={`1 · ${t("ops.scanLocation")}`} autoFocus onScan={(c) => {
            if (c.toUpperCase() !== line.full_code && c !== line.location_barcode) toast.error(i18n.language === "ar" ? "موقع غير صحيح" : "Wrong location"); else setLoc(c);
          }} /> : <>
            <div className="m-ok">✓ {loc}</div>
            <label style={{ display: "block", marginTop: 10, fontWeight: 500, color: "var(--iarda-primary)" }}>2 · {t("inv.counted")} ({line.uom_code})</label>
            <input className="input" type="number" inputMode="decimal" min={0} step="any" value={qty} autoFocus onChange={(e) => setQty(e.target.value)} style={{ fontSize: 22, marginBottom: 10 }} />
            <button className="btn btn--primary btn--block" disabled={qty === "" || Number(qty) < 0} onClick={record}>{t("ops.confirm")}</button>
          </>}
        </div>
      </>}
      {p.status === "counting" && (
        <details className="m-card"><summary style={{ fontWeight: 500, color: "var(--iarda-primary)" }}>{t("inv.unplanned")}</summary>
          <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
            <input className="input mono" placeholder={t("ops.location")} value={extra.location} onChange={(e) => setExtra({ ...extra, location: e.target.value })} />
            <input className="input mono" placeholder={t("ops.item")} value={extra.item} onChange={(e) => setExtra({ ...extra, item: e.target.value })} />
            <input className="input mono" placeholder={t("ops.lot")} value={extra.lot} onChange={(e) => setExtra({ ...extra, lot: e.target.value })} />
            <input className="input" type="number" min={0} placeholder={t("ops.qty")} value={extra.qty} onChange={(e) => setExtra({ ...extra, qty: e.target.value })} />
            <button className="btn btn--secondary" disabled={!extra.location || !extra.item || extra.qty === ""} onClick={unplanned}>{t("ops.confirm")}</button>
          </div>
        </details>
      )}
      <div className="m-card">{p.lines.map((x: any) => (
        <div key={x.id} className="kpi-target"><span className="mono">{x.full_code}</span><span className="mono">{x.item_code} {x.status === "recount" ? <span className="overdue">↻</span> : x.status !== "open" && <span className="m-ok">✓</span>}</span></div>
      ))}</div>
    </Shell>
  );
}

// ------------------------------------------------------------------ bin-to-bin move
export function MobileMove() {
  const { t, i18n } = useTranslation();
  const L = useL();
  const [from, setFrom] = useState<any>(null);
  const [stock, setStock] = useState<any[]>([]);
  const [pick, setPick] = useState<any>(null);
  const [qty, setQty] = useState("");
  const reset = () => { setFrom(null); setStock([]); setPick(null); setQty(""); };
  async function scanFrom(code: string) {
    try {
      const l = await api.get("/api/locations/lookup", { code });
      const s = (await api.get(`/api/locations/${l.id}/stock`)).data.filter((b: any) => b.stock_status === "available" && Number(b.qty_on_hand) - Number(b.qty_reserved) > 0);
      if (!s.length) { toast.error(i18n.language === "ar" ? "لا يوجد رصيد متاح في هذه الخانة" : "No free stock in this bin"); return; }
      setFrom(l); setStock(s); if (s.length === 1) setPick(s[0]);
    } catch (e) { toast.error(errorText(e, i18n.language)); }
  }
  async function scanTo(code: string) {
    try {
      const r = await api.post("/api/moves", { from: from.full_code, to: code, item: pick.item_code, lot: pick.serial_no ?? pick.lot_no ?? null, qty: Number(qty || Number(pick.qty_on_hand) - Number(pick.qty_reserved)) });
      toast.success(`✓ ${r.from} → ${r.to}`); reset();
    } catch (e) { toast.error(errorText(e, i18n.language)); }
  }
  return (
    <Shell title={t("inv.moveStock")} back="/m">
      <div className="m-card">
        {!from ? <ScanInput key="from" label={`1 · ${t("inv.fromBin")}`} autoFocus onScan={scanFrom} /> : <div className="m-ok">✓ {from.full_code} <button className="btn btn--ghost btn--sm" onClick={reset}>{t("ops.clear")}</button></div>}
      </div>
      {from && !pick && <div className="m-card">{stock.map((b: any) => (
        <button key={b.id} className="kpi-target" style={{ width: "100%", background: "none", border: 0, cursor: "pointer" }} onClick={() => setPick(b)}>
          <span><span className="mono">{b.item_code}</span> {L(b)}{(b.lot_no || b.serial_no) && <small className="mono muted"> · {b.serial_no ?? b.lot_no}</small>}</span><b>{fmtNum(Number(b.qty_on_hand) - Number(b.qty_reserved))}</b>
        </button>
      ))}</div>}
      {pick && <div className="m-card">
        <h3 className="mono">{pick.item_code}</h3><div>{L(pick)}</div>
        <label style={{ display: "block", marginTop: 10, fontWeight: 500, color: "var(--iarda-primary)" }}>2 · {t("ops.qty")} (≤ {fmtNum(Number(pick.qty_on_hand) - Number(pick.qty_reserved))})</label>
        <input className="input" type="number" min={0} step="any" value={qty} placeholder={String(Number(pick.qty_on_hand) - Number(pick.qty_reserved))} onChange={(e) => setQty(e.target.value)} style={{ marginBottom: 10 }} />
        <ScanInput key="to" label={`3 · ${t("inv.toBin")}`} onScan={scanTo} />
      </div>}
    </Shell>
  );
}
