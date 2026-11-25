import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, type Page } from "../api";
import { useAuth } from "../auth";
import { Empty, Icon, Loading, PageHead, Pagination, Tabs } from "../components/ui";
import { fmtDate, fmtNum, fmtSar, useL } from "../util";

export function StockPage() {
  const { t } = useTranslation();
  const L = useL();
  const whs = useQuery({ queryKey: ["warehouses"], queryFn: () => api.get("/api/warehouses") });
  const [wh, setWh] = useState("");
  const [below, setBelow] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const r = useQuery({ queryKey: ["stock", wh, below, q, page], queryFn: () => api.get<Page<any>>("/api/stock", { warehouseId: wh, below, q, page }), placeholderData: (p) => p });
  return (
    <>
      <PageHead icon="chart" title={t("ops.stock")} />
      <section className="card">
        <Tabs value={below} onChange={(v) => { setBelow(v); setPage(1); }} tabs={[{ id: "", label: t("ops.all") }, { id: "rop", label: t("ops.belowRop") }, { id: "zero", label: t("ops.outOfStock") }]} />
        <div className="toolbar">
          <div className="field grow"><div className="input-wrap"><Icon name="search" /><input className="input" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder={t("item.lookupHint")} /></div></div>
          <div className="field"><select className="select" value={wh} onChange={(e) => { setWh(e.target.value); setPage(1); }}>
            <option value="">{t("common.all")}</option>{(whs.data?.data ?? []).map((w: any) => <option key={w.id} value={w.id}>{L(w)}</option>)}</select></div>
        </div>
        {r.isLoading ? <Loading /> : !r.data?.data.length ? <Empty /> : (
          <>
            <div className="table-wrap"><table className="table"><thead><tr>
              <th>{t("ops.item")}</th><th className="c">{t("ops.warehouse")}</th><th className="c">{t("ops.onHand")}</th><th className="c">{t("ops.reserved")}</th><th className="c">{t("ops.free")}</th>
              <th className="c col-opt">{t("ops.min")}</th><th className="c col-opt">{t("ops.rop")}</th><th className="c col-opt">{t("ops.avgCost")}</th><th className="c col-opt">{t("ops.stockValue")}</th>
            </tr></thead><tbody>{r.data.data.map((s) => {
              const low = s.free <= (s.reorder_point ?? s.min_qty);
              return (
                <tr key={s.item_id + s.warehouse_id} className={low ? "is-highlight" : ""}>
                  <td><Link className="mono" to={`/items/${s.item_id}?tab=stock`}>{s.item_code}</Link><br />{L(s)}{s.ved_class === "V" && <span className="badge badge--warning" style={{ marginInlineStart: 6 }}>V</span>}</td>
                  <td className="c mono">{s.warehouse_code}</td><td className="n">{fmtNum(s.on_hand)}</td><td className="n">{fmtNum(s.reserved)}</td>
                  <td className="n"><b style={{ color: s.free <= 0 ? "var(--iarda-error)" : low ? "var(--iarda-gold)" : undefined }}>{fmtNum(s.free)}</b></td>
                  <td className="n col-opt">{fmtNum(s.min_qty)}</td><td className="n col-opt">{fmtNum(s.reorder_point)}</td><td className="n col-opt">{fmtNum(s.avg_cost, 2)}</td><td className="n col-opt">{fmtSar(s.total_value)}</td>
                </tr>
              );
            })}</tbody></table></div>
            <Pagination page={r.data.page} pageSize={r.data.pageSize} total={r.data.total} onPage={setPage} />
          </>
        )}
      </section>
    </>
  );
}

/** Stock & item-card tabs embedded in the item detail page. */
export function ItemStockTab({ itemId }: { itemId: string }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const s = useQuery({ queryKey: ["item-stock", itemId], queryFn: () => api.get(`/api/items/${itemId}/stock`) });
  if (s.isLoading) return <Loading />;
  const d: any = s.data;
  return (
    <>
      <div className="grid grid--kpi section">
        {d.valuation.map((v: any) => (
          <div className="card card--cream kpi" key={v.warehouse_id}>
            <div className="kpi__label">{L(v, "warehouse_name")}</div>
            <div className="kpi__value">{fmtNum(v.qty)}</div>
            {v.avg_cost !== undefined && <div className="kpi__trend">{t("ops.avgCost")}: <b>{fmtNum(v.avg_cost, 2)}</b> · {fmtSar(v.total_value)}</div>}
          </div>
        ))}
      </div>
      {d.balances.length === 0 ? <Empty /> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>{t("ops.warehouse")}</th><th>{t("ops.location")}</th><th>{t("ops.lot")}</th><th>{t("ops.expiry")}</th>
          <th className="c">{t("common.status")}</th><th className="c">{t("ops.onHand")}</th><th className="c">{t("ops.reserved")}</th><th className="c">{t("ops.free")}</th></tr></thead>
          <tbody>{d.balances.map((b: any) => (
            <tr key={b.id}><td className="mono">{b.warehouse_code}</td><td className="mono">{b.full_code}<div className="muted" style={{ fontSize: 12 }}>{b.zone_type}</div></td>
              <td className="mono">{b.serial_no ?? b.lot_no ?? "—"}</td>
              <td>{b.expiry_date ? <span style={{ color: new Date(b.expiry_date).getTime() - Date.now() < 30 * 864e5 ? "var(--iarda-error)" : undefined }}>{fmtDate(b.expiry_date, lang)}</span> : "—"}</td>
              <td className="c"><span className="chip">{b.stock_status}</span></td><td className="n">{fmtNum(b.qty_on_hand)}</td><td className="n">{fmtNum(b.qty_reserved)}</td><td className="n"><b>{fmtNum(b.qty_free)}</b></td></tr>
          ))}</tbody></table></div>
      )}
    </>
  );
}

export function ItemLedgerTab({ itemId }: { itemId: string }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [page, setPage] = useState(1);
  const r = useQuery({ queryKey: ["item-ledger", itemId, page], queryFn: () => api.get(`/api/items/${itemId}/ledger`, { page }) });
  const { can } = useAuth();
  if (r.isLoading) return <Loading />;
  if (!r.data?.data.length) return <Empty />;
  return (
    <>
      <div className="table-wrap"><table className="table"><thead><tr><th>{t("audit.at")}</th><th>{t("ops.movement")}</th><th>{t("common.code")}</th><th>{t("ops.location")}</th><th>{t("ops.lot")}</th>
        <th className="c">{t("ops.qty")}</th>{can("valuation.manage", "warehouse.read") && <th className="c">{t("ops.avgCost")}</th>}<th className="c">{t("ops.balance")}</th><th className="col-opt">{t("audit.actor")}</th></tr></thead>
        <tbody>{r.data.data.map((l: any) => (
          <tr key={l.id}><td><small>{fmtDate(l.posted_at, lang, true)}</small></td><td><span className={`badge ${l.qty > 0 ? "badge--success" : "badge--warning"}`}>{l.movement_type}</span></td>
            <td className="mono">{l.doc_no ?? "—"}</td><td className="mono">{l.full_code}</td><td className="mono">{l.serial_no ?? l.lot_no ?? "—"}</td>
            <td className="n"><b style={{ color: l.qty < 0 ? "var(--iarda-error)" : "var(--iarda-primary)" }}>{l.qty > 0 ? "+" : ""}{fmtNum(l.qty)}</b></td>
            {can("valuation.manage", "warehouse.read") && <td className="n">{fmtNum(l.unit_cost, 2)}</td>}
            <td className="n">{fmtNum(l.wh_qty_after)}</td><td className="col-opt"><small>{lang === "ar" ? l.posted_by_ar : l.posted_by_en}</small></td></tr>
        ))}</tbody></table></div>
      <Pagination page={r.data.page} pageSize={r.data.pageSize} total={r.data.total} onPage={setPage} />
    </>
  );
}
