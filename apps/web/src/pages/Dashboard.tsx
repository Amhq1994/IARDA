import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { useAuth } from "../auth";
import { Alert, Icon, Loading, Meter, PageHead, Section, StatusBadge } from "../components/ui";
import { fmtDate, fmtNum, useL } from "../util";

function Kpi({ icon, label, value, to, tone }: { icon: string; label: string; value: number | string; to?: string; tone?: "gold" }) {
  const body = (
    <div className="card kpi">
      <div className="kpi__top"><span className="kpi__label">{label}</span><span className="kpi__icon"><Icon name={icon} /></span></div>
      <div className="kpi__value" style={tone === "gold" ? { color: "var(--iarda-gold)" } : undefined}>{typeof value === "number" ? fmtNum(value) : value}</div>
    </div>
  );
  return to ? <Link to={to} style={{ textDecoration: "none" }}>{body}</Link> : body;
}

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const { me, can } = useAuth();
  const L = useL();
  const lang = i18n.language;
  const q = useQuery({ queryKey: ["dashboard"], queryFn: () => api.get("/api/dashboard"), enabled: can("dashboard.view", "mobile.tasks") });
  const d: any = q.data ?? {};
  const name = lang === "ar" ? me?.nameAr : me?.nameEn;

  return (
    <>
      <PageHead icon="dashboard" title={t("dash.welcome", { name })} lead={`${t("app.name")} · ${fmtDate(new Date().toISOString(), lang)}`} />
      {q.isLoading && <Loading />}
      {d.items && (
        <section className="grid grid--kpi section">
          <Kpi icon="table" label={t("dash.activeItems")} value={d.items.active} to="/items?status=active" />
          <Kpi icon="star" label={t("dash.pending")} value={d.items.pending_approval} to="/items?status=pending_approval" tone="gold" />
          <Kpi icon="report" label={t("dash.drafts")} value={d.items.drafts} to="/items?status=requested,draft" />
          {d.warehouses
            ? <Kpi icon="map" label={t("dash.bins")} value={d.warehouses.reduce((a: number, w: any) => a + w.bins, 0)} to="/warehouses" />
            : <Kpi icon="alert" label={t("dash.blocked")} value={d.items.blocked} to="/items?status=blocked" />}
        </section>
      )}

      {(d.operations || d.myApprovals > 0 || d.myRequests) && (
        <section className="grid grid--kpi section">
          {d.myApprovals > 0 && <Kpi icon="check" label={t("ops.approvals")} value={d.myApprovals} to="/approvals" tone="gold" />}
          {d.myRequests && !d.operations && <>
            <Kpi icon="report" label={t("ops.myRequests")} value={d.myRequests.open} to="/requests?view=mine" />
            <Kpi icon="download" label={t("mrStatus.ready_for_delivery")} value={d.myRequests.ready} to="/requests?view=mine" tone="gold" />
          </>}
          {d.operations && <>
            <Kpi icon="report" label={t("ops.fulfil")} value={d.operations.to_fulfil} to="/requests?view=fulfil" />
            <Kpi icon="alert" label={t("ops.overdue")} value={d.operations.overdue} to="/requests?view=all" tone={d.operations.overdue ? "gold" : undefined} />
            <Kpi icon="download" label={`${t("rcvStatus.in_inspection")} / ${t("ops.grn")}`} value={`${d.operations.in_inspection} / ${d.operations.awaiting_grn}`} to="/inbound/receipts" />
            <Kpi icon="map" label={`${t("ops.putaway")} / ${t("ops.picking")}`} value={`${d.operations.putaway_open} / ${d.operations.picks_open}`} to="/m" />
          </>}
        </section>
      )}
      {d.control && (
        <section className="grid grid--kpi section">
          <Kpi icon="slides" label={t("inv.inTransit")} value={d.control.in_transit} to="/transfers" />
          <Kpi icon="table" label={t("inv.counts")} value={d.control.counts_open} to="/counts" />
          <Kpi icon="sheet" label={t("inv.adjustments")} value={d.control.adjustments_open} to="/adjustments" tone={d.control.adjustments_open ? "gold" : undefined} />
          <Kpi icon="alert" label={t("inv.quarantineStock")} value={d.control.quarantine_lines} to="/returns?tab=quarantine" />
        </section>
      )}
      {d.stock && (
        <section className="grid grid--kpi section">
          <Kpi icon="chart" label={t("ops.stockValue")} value={`${fmtNum(Math.round(d.stock.value))} ر.س`} to="/stock" />
          <Kpi icon="alert" label={t("ops.belowRop")} value={d.stock.below_rop} to="/stock" tone="gold" />
          <Kpi icon="shield" label={lang === "ar" ? "نفاد أصناف حرجة (V)" : "Critical stock-outs (V)"} value={d.stock.critical_stockouts} to="/stock" tone={d.stock.critical_stockouts ? "gold" : undefined} />
          <Kpi icon="calendar" label={lang === "ar" ? "دفعات تنتهي خلال 30 يوماً" : "Lots expiring in 30 days"} value={d.stock.expiring_30d} />
        </section>
      )}

      <div className="grid grid--2-1">
        <div>
          {d.expiringLots?.length > 0 && (
            <Section icon="calendar" title={lang === "ar" ? "دفعات قاربت على الانتهاء" : "Lots nearing expiry"}>
              <div className="table-wrap"><table className="table"><thead><tr><th>{t("ops.item")}</th><th>{t("ops.lot")}</th><th className="c">{t("ops.warehouse")}</th><th className="c">{t("ops.qty")}</th><th>{t("ops.expiry")}</th></tr></thead>
                <tbody>{d.expiringLots.map((x: any, i: number) => (
                  <tr key={i}><td><Link className="mono" to={`/items/${x.item_id}?tab=stock`}>{x.item_code}</Link><br />{L(x)}</td><td className="mono">{x.lot_no}</td>
                    <td className="c mono">{x.warehouse_code}</td><td className="n">{fmtNum(x.qty)}</td><td style={{ color: "var(--iarda-error)" }}>{fmtDate(x.expiry_date, lang)}</td></tr>
                ))}</tbody></table></div>
            </Section>
          )}
          {d.pendingApprovals && (
            <Section icon="check" title={t("item.pendingMine")}>
              {d.pendingApprovals.length === 0 ? <p className="muted">{t("common.empty")}</p> : (
                <div className="table-wrap"><table className="table"><thead><tr>
                  <th>{t("item.code")}</th><th>{t("common.name")}</th><th>{t("item.requestedBy")}</th><th>{t("common.updatedAt")}</th>
                </tr></thead><tbody>
                  {d.pendingApprovals.map((r: any) => (
                    <tr key={r.id}><td className="mono"><Link to={`/items/${r.id}`}>{r.item_code}</Link></td><td>{L(r)}</td>
                      <td>{lang === "ar" ? r.submitted_by_ar : r.submitted_by_en}</td><td>{fmtDate(r.updated_at, lang)}</td></tr>
                  ))}
                </tbody></table></div>
              )}
            </Section>
          )}

          {d.warehouses && (
            <Section icon="map" title={t("wh.title")}>
              <div className="table-wrap"><table className="table"><thead><tr>
                <th>{t("common.warehouse")}</th><th className="c">{t("wh.bins")}</th><th className="c">{t("wh.blocked")}</th><th>{t("wh.utilization")}</th>
              </tr></thead><tbody>
                {d.warehouses.map((w: any) => (
                  <tr key={w.id}><td><Link to={`/warehouses/${w.id}`}>{L(w)}</Link></td><td className="n">{fmtNum(w.bins)}</td>
                    <td className="n">{w.blocked_bins}</td><td><Meter value={w.used_m3} max={w.capacity_m3} /></td></tr>
                ))}
              </tbody></table></div>
            </Section>
          )}

          {d.itemsByCategory && (
            <Section icon="chart" title={t("dash.byCategory")}>
              <div className="bar-chart">
                {d.itemsByCategory.map((c: any) => (
                  <div className="bar-row" key={c.code} style={{ gridTemplateColumns: "minmax(110px, 200px) 1fr 44px" }}>
                    <span>{L(c)}</span>
                    <div className="bar-row__track"><div className="bar-row__fill" style={{ width: `${(c.n / Math.max(...d.itemsByCategory.map((x: any) => x.n))) * 100}%` }} /></div>
                    <span className="bar-row__val">{c.n}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {d.myItemRequests && d.myItemRequests.length > 0 && (
            <Section icon="report" title={t("dash.myRequests")}>
              <div className="table-wrap"><table className="table"><tbody>
                {d.myItemRequests.map((r: any) => (
                  <tr key={r.id}><td className="mono"><Link to={`/items/${r.id}`}>{r.item_code}</Link></td><td>{L(r)}</td><td><StatusBadge status={r.status} /></td></tr>
                ))}
              </tbody></table></div>
            </Section>
          )}
        </div>

        <div>
          {d.dataQuality && (
            <Section icon="shield" title={t("dash.dataQuality")}>
              {[["noBarcode", d.dataQuality.no_barcode], ["noImage", d.dataQuality.no_image], ["noDims", d.dataQuality.no_dimensions], ["noVed", d.dataQuality.no_ved]].map(([k, v]) => (
                <div className="kpi-target" key={k as string}><span>{t(`dash.${k}`)}</span><b className="ltr">{fmtNum(v as number)} / {fmtNum(d.dataQuality.total)}</b></div>
              ))}
            </Section>
          )}
          {d.security && (
            <Section icon="lock" title={t("dash.security")}>
              <div className="kpi-target"><span>{t("dash.activeUsers")}</span><b>{d.security.active_users}</b></div>
              <div className="kpi-target"><span>{t("dash.lockedUsers")}</span><b>{d.security.locked_users}</b></div>
              <div className="kpi-target"><span>{t("dash.failed24")}</span><b>{d.security.failed_logins_24h}</b></div>
              <div className="kpi-target"><span>{t("dash.withoutMfa")}</span><b className="text-gold">{d.security.without_mfa}</b></div>
            </Section>
          )}
          {d.recentActivity && (
            <Section icon="calendar" title={t("dash.recent")}>
              {d.recentActivity.map((a: any) => (
                <div className="kpi-target" key={a.id}>
                  <span>{t(`audit.${a.action}`)} · <span className="mono">{a.table_name}</span><br /><small className="muted">{lang === "ar" ? a.actor_name_ar : a.actor_name_en}</small></span>
                  <small className="muted">{fmtDate(a.at, lang, true)}</small>
                </div>
              ))}
            </Section>
          )}
          <Section icon="star" title={t("dash.kpis")} className="card card--cream">
            {(lang === "ar"
              ? [["دقة المخزون", "≥ 98%"], ["معدل التلبية", "≥ 95%"], ["زمن دورة الطلب", "≤ 24 ساعة"], ["من الرصيف إلى التخزين", "≤ 48 ساعة"], ["المخزون الراكد", "≤ 10%"], ["نفاد الأصناف الحرجة", "= 0"], ["إشغال المساحات", "75–85%"]]
              : [["Inventory accuracy", "≥ 98%"], ["Fill rate", "≥ 95%"], ["Request cycle time", "≤ 24 h"], ["Dock-to-stock", "≤ 48 h"], ["Dead stock", "≤ 10%"], ["Critical stock-outs", "= 0"], ["Space utilisation", "75–85%"]]
            ).map(([k, v], i) => {
              const actual = d.kpis ? [d.kpis.accuracy_pct != null ? `${d.kpis.accuracy_pct}%` : null, d.kpis.fill_rate_pct != null ? `${d.kpis.fill_rate_pct}%` : null, d.kpis.cycle_time_h != null ? `${d.kpis.cycle_time_h} h` : null,
                d.kpis.dock_to_stock_h != null ? `${d.kpis.dock_to_stock_h} h` : null, null, d.stock ? String(d.stock.critical_stockouts) : null, null][i] : null;
              return <div className="kpi-target" key={k}><span>{k}</span><span>{actual && <b className="ltr">{actual}</b>}<span className="ltr muted">{actual ? `(${v})` : v}</span></span></div>;
            })}
            <div style={{ marginTop: 12 }}><Alert>{lang === "ar" ? "دقة المخزون = بنود الجرد المطابقة للرصيد ضمن نسبة التسامح ÷ البنود المجرودة (آخر 90 يوماً). المخزون الراكد وإشغال المساحات يُحتسبان مع التخطيط (المرحلة الرابعة)." : "Inventory accuracy = count lines matching the book within tolerance ÷ lines counted (last 90 days). Dead stock and space utilisation arrive with planning (phase 4)."}</Alert></div>
          </Section>
        </div>
      </div>
    </>
  );
}
