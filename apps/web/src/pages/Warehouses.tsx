import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { WAREHOUSE_TYPES, ZONE_TYPES, LOCATION_LEVELS } from "@iarda/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { Alert, Empty, Field, Icon, Loading, Meter, Modal, PageHead, Section, toast } from "../components/ui";
import { errorText, fmtNum, useL } from "../util";

export function WarehousesPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language as "ar" | "en";
  const L = useL();
  const q = useQuery({ queryKey: ["warehouses"], queryFn: () => api.get("/api/warehouses") });
  return (
    <>
      <PageHead icon="map" title={t("wh.title")} />
      {q.isLoading ? <Loading /> : (
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
          {q.data.data.map((w: any) => (
            <Link key={w.id} to={`/warehouses/${w.id}`} className="card" style={{ textDecoration: "none", color: "inherit" }}>
              <div className="card__head">
                <h2 className="section-title" style={{ marginBottom: 0 }}><Icon name="map" /><span>{L(w)}</span></h2>
                <span className="chip mono">{w.code}</span>
              </div>
              <dl className="dl" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <div><dt>{t("wh.type")}</dt><dd>{(WAREHOUSE_TYPES as any)[w.warehouse_type][lang]}</dd></div>
                <div><dt>{t("wh.city")}</dt><dd>{w.city ?? "—"}</dd></div>
                <div><dt>{t("wh.manager")}</dt><dd>{L(w, "manager_name")}</dd></div>
                <div><dt>{t("wh.pickingRule")}</dt><dd>{w.default_picking_rule}</dd></div>
                <div><dt>{t("wh.zones")} / {t("wh.bins")}</dt><dd>{w.zones} / {fmtNum(w.bins)}</dd></div>
                <div><dt>{t("wh.blocked")}</dt><dd>{w.blocked_bins}</dd></div>
              </dl>
              <div style={{ marginTop: 14 }}><small className="muted">{t("wh.utilization")} ({fmtNum(w.capacity_m3)} m³)</small><Meter value={w.used_m3} max={w.capacity_m3} /></div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

export function WarehouseDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language as "ar" | "en";
  const L = useL();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [sel, setSel] = useState<any>(null);
  const [gen, setGen] = useState<any>(null);
  const [find, setFind] = useState("");
  const q = useQuery({ queryKey: ["warehouse", id], queryFn: () => api.get(`/api/warehouses/${id}`) });
  const w: any = q.data;
  const manage = can("warehouse.manage");
  const refresh = () => { qc.invalidateQueries({ queryKey: ["warehouse", id] }); qc.invalidateQueries({ queryKey: ["locations"] }); qc.invalidateQueries({ queryKey: ["warehouses"] }); };

  async function locate() {
    if (!find.trim()) return;
    try { setSel(await api.get("/api/locations/lookup", { code: find.trim() })); } catch (e) { toast.error(errorText(e, lang)); }
  }

  if (q.isLoading) return <Loading />;
  if (!w) return <Empty />;
  return (
    <>
      <PageHead icon="map" title={L(w)} lead={<><span className="mono">{w.code}</span> · {(WAREHOUSE_TYPES as any)[w.warehouse_type][lang]} · {w.city}</>}
        crumbs={<><Link to="/warehouses">{t("wh.title")}</Link><Icon name="chevron" className="icon icon-sm" flip={lang === "ar"} /><span>{w.code}</span></>} />

      <Section icon="chart" title={t("wh.zones")}>
        <div className="table-wrap"><table className="table"><thead><tr>
          <th>{t("wh.fullCode")}</th><th>{t("common.name")}</th><th className="c">{t("wh.aisles")}</th><th className="c">{t("wh.racks")}</th><th className="c">{t("wh.bins")}</th>
          <th>{t("wh.capacity")}</th><th>{t("wh.utilization")}</th>{manage && <th></th>}
        </tr></thead><tbody>
          {w.zones.map((z: any) => (
            <tr key={z.id} className={sel?.id === z.id ? "is-highlight" : ""}>
              <td className="mono">{z.full_code}</td><td>{(ZONE_TYPES as any)[z.zone_type][lang]}</td>
              <td className="n">{z.aisles}</td><td className="n">{z.racks}</td><td className="n">{z.bins}</td>
              <td className="n"><span className="ltr">{fmtNum(z.capacity_m3)} m³ / {fmtNum(z.capacity_kg)} kg</span></td><td><Meter value={z.used_m3} max={z.capacity_m3} /></td>
              {manage && <td className="actions"><button className="btn btn--ghost btn--sm" onClick={() => setGen(z)}><Icon name="plus" className="icon icon-sm" />{t("wh.generate")}</button></td>}
            </tr>
          ))}
        </tbody></table></div>
      </Section>

      <div className="split">
        <Section icon="map" title={t("wh.structure")}>
          <div className="toolbar">
            <div className="field grow"><div className="input-wrap"><Icon name="search" />
              <input className="input mono" dir="ltr" placeholder={`${w.code}-STR-A01-R01-B01`} value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => e.key === "Enter" && locate()} /></div></div>
            <button className="btn btn--secondary" onClick={locate}>{t("wh.locate")}</button>
          </div>
          <ul className="tree">{w.zones.map((z: any) => <TreeNode key={z.id} whId={id!} node={{ ...z, level: "zone", child_count: z.aisles }} sel={sel} onSelect={setSel} />)}</ul>
        </Section>
        <Section icon="info" title={t("common.details")}>
          {sel ? <LocationPanel key={sel.id} loc={sel} manage={manage} onChanged={(l) => { setSel(l); refresh(); }} /> : <Empty text={lang === "ar" ? "اختر موقعاً من الشجرة" : "Select a location in the tree"} />}
        </Section>
      </div>

      {gen && <GenerateModal zone={gen} onClose={() => setGen(null)} onDone={() => { setGen(null); refresh(); }} />}
    </>
  );
}

function TreeNode({ whId, node, sel, onSelect }: { whId: string; node: any; sel: any; onSelect: (n: any) => void }) {
  const { i18n } = useTranslation();
  const lang = i18n.language as "ar" | "en";
  const [open, setOpen] = useState(false);
  const kids = useQuery({ queryKey: ["locations", node.id], queryFn: () => api.get(`/api/warehouses/${whId}/locations`, { parentId: node.id }), enabled: open });
  const hasKids = node.level !== "bin" && (node.child_count ?? 1) > 0;
  const label = node.level === "zone" ? (ZONE_TYPES as any)[node.zone_type][lang] : (LOCATION_LEVELS as any)[node.level][lang];
  return (
    <li>
      <div className={`tree-row${open ? " is-open" : ""}${sel?.id === node.id ? " is-selected" : ""}`} onClick={() => { onSelect(node); if (hasKids) setOpen((o) => !o); }}>
        {hasKids ? <Icon name="chevron" className="caret" /> : <span style={{ width: 16 }} />}
        <span className="mono">{node.code}</span><span className="muted" style={{ fontSize: 12.5 }}>{label}</span>
        {node.is_blocked && <span className="badge badge--error">{lang === "ar" ? "موقوف" : "Blocked"}</span>}
        {node.level !== "bin" && <span className="count">{node.child_count}</span>}
      </div>
      {open && kids.data && <ul>{kids.data.data.map((k: any) => <TreeNode key={k.id} whId={whId} node={k} sel={sel} onSelect={onSelect} />)}</ul>}
    </li>
  );
}

function LocationPanel({ loc, manage, onChanged }: { loc: any; manage: boolean; onChanged: (l: any) => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language as "ar" | "en";
  const [b, setB] = useState({ maxWeightKg: loc.max_weight_kg ?? "", maxVolumeM3: loc.max_volume_m3 ?? "", velocityClass: loc.velocity_class ?? "",
    hazmatAllowed: !!loc.hazmat_allowed, temperatureControlled: !!loc.temperature_controlled });
  const [reason, setReason] = useState("");
  const full = loc.full_code && loc.max_weight_kg !== undefined;
  async function run(fn: () => Promise<any>) { try { onChanged(await fn()); toast.success(t("common.saved")); } catch (e) { toast.error(errorText(e, lang)); } }
  return (
    <>
      <dl className="dl" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div><dt>{t("wh.fullCode")}</dt><dd className="mono">{loc.full_code}</dd></div>
        <div><dt>{t("wh.level")}</dt><dd>{(LOCATION_LEVELS as any)[loc.level]?.[lang]}</dd></div>
        {loc.level === "bin" && <>
          <div><dt>{t("wh.capacity")}</dt><dd className="ltr">{fmtNum(loc.max_volume_m3)} m³ · {fmtNum(loc.max_weight_kg)} kg</dd></div>
          <div><dt>{t("wh.used")}</dt><dd className="ltr">{fmtNum(loc.current_volume_m3)} m³ · {fmtNum(loc.current_weight_kg)} kg</dd></div>
          <div><dt>{t("wh.velocity")}</dt><dd>{loc.velocity_class ?? "—"}</dd></div>
          <div><dt>{t("common.status")}</dt><dd>{loc.is_blocked ? `${t("wh.blocked")} — ${loc.block_reason ?? ""}` : "✓"}</dd></div>
        </>}
      </dl>
      {manage && full && loc.level === "bin" && (
        <div style={{ marginTop: 20 }}>
          <div className="form-grid">
            <Field label={t("wh.maxWeight")}><input className="input" type="number" min={0} value={b.maxWeightKg} onChange={(e) => setB({ ...b, maxWeightKg: e.target.value })} /></Field>
            <Field label={t("wh.maxVolume")}><input className="input" type="number" min={0} step="0.01" value={b.maxVolumeM3} onChange={(e) => setB({ ...b, maxVolumeM3: e.target.value })} /></Field>
            <Field label={t("wh.velocity")}><select className="select" value={b.velocityClass} onChange={(e) => setB({ ...b, velocityClass: e.target.value })}>
              <option value="">—</option><option value="fast">fast</option><option value="medium">medium</option><option value="slow">slow</option></select></Field>
          </div>
          <div className="checks">
            <label className="check"><input type="checkbox" checked={b.hazmatAllowed} onChange={(e) => setB({ ...b, hazmatAllowed: e.target.checked })} />{t("wh.hazmat")}</label>
            <label className="check"><input type="checkbox" checked={b.temperatureControlled} onChange={(e) => setB({ ...b, temperatureControlled: e.target.checked })} />{t("wh.temp")}</label>
          </div>
          <div className="form-actions">
            <button className="btn btn--primary btn--sm" onClick={() => run(() => api.patch(`/api/locations/${loc.id}`, {
              maxWeightKg: b.maxWeightKg === "" ? null : Number(b.maxWeightKg), maxVolumeM3: b.maxVolumeM3 === "" ? null : Number(b.maxVolumeM3),
              velocityClass: b.velocityClass || null, hazmatAllowed: b.hazmatAllowed, temperatureControlled: b.temperatureControlled, version: loc.version }))}>{t("common.save")}</button>
          </div>
        </div>
      )}
      {manage && full && (
        <div style={{ marginTop: 16, borderTop: "1px solid var(--iarda-sand)", paddingTop: 16 }}>
          {loc.is_blocked
            ? <button className="btn btn--secondary btn--sm" onClick={() => run(() => api.post(`/api/locations/${loc.id}/unblock`))}>{t("wh.unblock")}</button>
            : <div className="toolbar" style={{ marginBottom: 0 }}><div className="field grow"><input className="input" placeholder={t("common.reason")} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
                <button className="btn btn--secondary btn--sm" disabled={reason.trim().length < 3} onClick={() => run(() => api.post(`/api/locations/${loc.id}/block`, { reason }))}><Icon name="lock" className="icon icon-sm" />{t("wh.block")}</button></div>}
        </div>
      )}
    </>
  );
}

function GenerateModal({ zone, onClose, onDone }: { zone: any; onClose: () => void; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const [b, setB] = useState({ aisles: 2, racksPerAisle: 4, binsPerRack: 5, startAisle: (zone.aisles ?? 0) + 1, binMaxWeightKg: 600, binMaxVolumeM3: 1.2 });
  const [busy, setBusy] = useState(false);
  const total = b.aisles * b.racksPerAisle * b.binsPerRack;
  return (
    <Modal title={`${t("wh.generate")} — ${zone.full_code}`} onClose={onClose}
      footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
        <button className="btn btn--primary" disabled={busy || total < 1 || total > 5000} onClick={async () => {
          setBusy(true);
          try { const r = await api.post(`/api/locations/${zone.id}/generate`, b); toast.success(t("wh.generated", { n: r.created })); onDone(); }
          catch (e) { toast.error(errorText(e, i18n.language)); } finally { setBusy(false); }
        }}>{t("common.create")} ({total} {t("wh.bins")})</button></>}>
      <div className="form-grid">
        {([["aisles", "wh.aislesN"], ["racksPerAisle", "wh.racksN"], ["binsPerRack", "wh.binsN"], ["startAisle", "wh.startAisle"], ["binMaxWeightKg", "wh.binWeight"], ["binMaxVolumeM3", "wh.binVolume"]] as const).map(([k, l]) => (
          <Field key={k} label={t(l)}><input className="input" type="number" min={k === "binMaxVolumeM3" ? 0.01 : 1} step={k === "binMaxVolumeM3" ? 0.1 : 1}
            value={(b as any)[k]} onChange={(e) => setB({ ...b, [k]: Number(e.target.value) })} /></Field>
        ))}
      </div>
      <Alert>{`${zone.full_code}-A${String(b.startAisle).padStart(2, "0")}-R01-B01 …`}</Alert>
    </Modal>
  );
}
