import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ITEM_TYPES, VED, IDENTIFIER_TYPES } from "@iarda/shared";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { Alert, Field, Icon, Loading, PageHead, Section, toast } from "../components/ui";
import { errorText, useL } from "../util";

interface Form {
  nameAr: string; nameEn: string; groupId: string; itemType: string; baseUomId: string; descriptionAr: string; descriptionEn: string;
  trackBatch: boolean; trackSerial: boolean; trackExpiry: boolean; shelfLifeDays: string; unitWeightKg: string; unitVolumeM3: string;
  hazardClass: string; storageConditions: string; vedClass: string; standardCost: string;
  barcode: string; mpn: string; cartonFactor: string;
}
const EMPTY: Form = { nameAr: "", nameEn: "", groupId: "", itemType: "consumable", baseUomId: "", descriptionAr: "", descriptionEn: "",
  trackBatch: false, trackSerial: false, trackExpiry: false, shelfLifeDays: "", unitWeightKg: "", unitVolumeM3: "", hazardClass: "",
  storageConditions: "", vedClass: "", standardCost: "", barcode: "", mpn: "", cartonFactor: "" };

const num = (s: string) => (s.trim() === "" ? null : Number(s));
const str = (s: string) => (s.trim() === "" ? null : s.trim());

export function ItemFormPage() {
  const { id } = useParams();
  const isEdit = !!id;
  const { t, i18n } = useTranslation();
  const lang = i18n.language as "ar" | "en";
  const L = useL();
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState<Form>(EMPTY);
  const [ack, setAck] = useState(false);
  const [dups, setDups] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const cats = useQuery({ queryKey: ["categories"], queryFn: () => api.get("/api/categories") });
  const uoms = useQuery({ queryKey: ["uoms"], queryFn: () => api.get("/api/uoms") });
  const item = useQuery({ queryKey: ["item", id], queryFn: () => api.get(`/api/items/${id}`), enabled: isEdit });

  useEffect(() => {
    const it: any = item.data;
    if (!it) return;
    setF({ ...EMPTY, nameAr: it.name_ar, nameEn: it.name_en, groupId: it.group_id, itemType: it.item_type, baseUomId: it.base_uom_id,
      descriptionAr: it.description_ar ?? "", descriptionEn: it.description_en ?? "", trackBatch: it.track_batch, trackSerial: it.track_serial,
      trackExpiry: it.track_expiry, shelfLifeDays: it.shelf_life_days?.toString() ?? "", unitWeightKg: it.unit_weight_kg?.toString() ?? "",
      unitVolumeM3: it.unit_volume_m3?.toString() ?? "", hazardClass: it.hazard_class ?? "", storageConditions: it.storage_conditions ?? "",
      vedClass: it.ved_class ?? "", standardCost: it.standard_cost?.toString() ?? "" });
  }, [item.data]);

  // live duplicate check while typing names / barcode (create only)
  useEffect(() => {
    if (isEdit || f.nameAr.trim().length < 3) { setDups(null); return; }
    const h = setTimeout(async () => {
      const identifiers = [f.barcode && { idType: "barcode", value: f.barcode.trim() }, f.mpn && { idType: "mpn", value: f.mpn.trim() }].filter(Boolean);
      try { setDups(await api.post("/api/items/duplicate-check", { nameAr: f.nameAr, nameEn: f.nameEn || undefined, identifiers })); } catch { /* ignore */ }
    }, 400);
    return () => clearTimeout(h);
  }, [f.nameAr, f.nameEn, f.barcode, f.mpn, isEdit]);

  const groups = useMemo(() => (cats.data?.data ?? []).flatMap((c: any) => c.groups.map((g: any) => ({ ...g, cat: c }))), [cats.data]);
  const blocking = dups?.similar?.some((s: any) => s.blocking);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const isRequest = !isEdit && !can("item.manage");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const payload: any = {
      nameAr: f.nameAr.trim(), nameEn: f.nameEn.trim(), groupId: f.groupId, itemType: f.itemType, baseUomId: f.baseUomId,
      descriptionAr: str(f.descriptionAr), descriptionEn: str(f.descriptionEn), trackBatch: f.trackBatch, trackSerial: f.trackSerial,
      trackExpiry: f.trackExpiry, shelfLifeDays: num(f.shelfLifeDays), unitWeightKg: num(f.unitWeightKg), unitVolumeM3: num(f.unitVolumeM3),
      hazardClass: str(f.hazardClass), storageConditions: str(f.storageConditions), vedClass: f.vedClass || null, standardCost: num(f.standardCost),
    };
    try {
      let saved: any;
      if (isEdit) {
        saved = await api.patch(`/api/items/${id}`, { ...payload, version: (item.data as any).version });
      } else {
        const identifiers = [f.barcode && { idType: "barcode", value: f.barcode.trim(), isPrimary: true }, f.mpn && { idType: "mpn", value: f.mpn.trim() }].filter(Boolean);
        const cartonUom = uoms.data?.data.find((u: any) => u.code === "CTN");
        const conversions = f.cartonFactor && cartonUom ? [{ uomId: cartonUom.id, factorToBase: Number(f.cartonFactor), isPurchaseDefault: true }] : [];
        saved = await api.post("/api/items", { ...payload, identifiers, conversions, acknowledgeDuplicates: ack });
      }
      qc.invalidateQueries({ queryKey: ["items"] });
      qc.invalidateQueries({ queryKey: ["item", saved.id] });
      toast.success(`${t("common.saved")} — ${saved.item_code}`);
      nav(`/items/${saved.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "possible_duplicates") setDups(e.body.details);
      setErr(errorText(e, lang));
    } finally { setBusy(false); }
  }

  if (isEdit && item.isLoading) return <Loading />;
  const title = isEdit ? `${t("item.editTitle")} — ${(item.data as any)?.item_code ?? ""}` : isRequest ? t("item.requestTitle") : t("item.newTitle");

  return (
    <form onSubmit={submit}>
      <PageHead icon={isEdit ? "settings" : "plus"} title={title}
        crumbs={<><Link to="/items">{t("item.title")}</Link><Icon name="chevron" className="icon icon-sm" flip={lang === "ar"} /><span>{title}</span></>} />
      {err && <div className="section"><Alert kind="error">{err}</Alert></div>}

      <div className="grid grid--2-1">
        <div>
          <Section icon="report" title={t("common.details")}>
            <div className="form-grid">
              <Field label={t("common.nameAr")} required><input className="input" value={f.nameAr} onChange={(e) => set("nameAr", e.target.value)} required dir="rtl" /></Field>
              <Field label={t("common.nameEn")} required><input className="input" value={f.nameEn} onChange={(e) => set("nameEn", e.target.value)} required dir="ltr" /></Field>
              <Field label={t("item.group")} required>
                <select className="select" value={f.groupId} onChange={(e) => set("groupId", e.target.value)} required>
                  <option value=""></option>
                  {(cats.data?.data ?? []).map((c: any) => (
                    <optgroup key={c.id} label={L(c)}>{c.groups.map((g: any) => <option key={g.id} value={g.id}>{L(g)} ({g.code})</option>)}</optgroup>
                  ))}
                </select>
              </Field>
              <Field label={t("item.type")} required>
                <select className="select" value={f.itemType} onChange={(e) => set("itemType", e.target.value)}>
                  {Object.entries(ITEM_TYPES).map(([k, v]) => <option key={k} value={k}>{v[lang]}</option>)}
                </select>
              </Field>
              <Field label={t("item.uom")} required>
                <select className="select" value={f.baseUomId} onChange={(e) => set("baseUomId", e.target.value)} required>
                  <option value=""></option>
                  {(uoms.data?.data ?? []).map((u: any) => <option key={u.id} value={u.id}>{L(u)} ({u.code})</option>)}
                </select>
              </Field>
              <Field label={t("item.ved")}>
                <select className="select" value={f.vedClass} onChange={(e) => set("vedClass", e.target.value)}>
                  <option value="">—</option>
                  {Object.entries(VED).map(([k, v]) => <option key={k} value={k}>{k} — {v[lang]}</option>)}
                </select>
              </Field>
              <Field label={t("item.description")}><textarea className="input" value={lang === "ar" ? f.descriptionAr : f.descriptionEn}
                onChange={(e) => set(lang === "ar" ? "descriptionAr" : "descriptionEn", e.target.value)} /></Field>
              <Field label={t("item.storage")}><textarea className="input" value={f.storageConditions} onChange={(e) => set("storageConditions", e.target.value)} /></Field>
            </div>
          </Section>

          <Section icon="settings" title={`${t("item.tracking")} · ${t("item.weight")}`}>
            <div className="checks" style={{ marginBottom: 16 }}>
              <label className="check"><input type="checkbox" checked={f.trackBatch} onChange={(e) => setF((x) => ({ ...x, trackBatch: e.target.checked, trackSerial: e.target.checked ? false : x.trackSerial }))} />{t("item.batch")}</label>
              <label className="check"><input type="checkbox" checked={f.trackSerial} onChange={(e) => setF((x) => ({ ...x, trackSerial: e.target.checked, trackBatch: e.target.checked ? false : x.trackBatch }))} />{t("item.serial")}</label>
              <label className="check"><input type="checkbox" checked={f.trackExpiry} disabled={!f.trackBatch && !f.trackSerial} onChange={(e) => set("trackExpiry", e.target.checked)} />{t("item.expiry")}</label>
            </div>
            <div className="form-grid">
              <Field label={t("item.shelfLife")}><input className="input" type="number" min={1} value={f.shelfLifeDays} disabled={!f.trackExpiry} onChange={(e) => set("shelfLifeDays", e.target.value)} /></Field>
              <Field label={t("item.weight")}><input className="input" type="number" step="0.001" min={0} value={f.unitWeightKg} onChange={(e) => set("unitWeightKg", e.target.value)} /></Field>
              <Field label={t("item.volume")}><input className="input" type="number" step="0.0001" min={0} value={f.unitVolumeM3} onChange={(e) => set("unitVolumeM3", e.target.value)} /></Field>
              <Field label={t("item.hazard")}><input className="input" value={f.hazardClass} onChange={(e) => set("hazardClass", e.target.value)} /></Field>
              <Field label={t("item.cost")}><input className="input" type="number" step="0.01" min={0} value={f.standardCost} onChange={(e) => set("standardCost", e.target.value)} /></Field>
            </div>
          </Section>

          {!isEdit && (
            <Section icon="search" title={t("item.identifiers")}>
              <div className="form-grid">
                <Field label={IDENTIFIER_TYPES.barcode[lang]}><input className="input mono" value={f.barcode} onChange={(e) => set("barcode", e.target.value)} dir="ltr" /></Field>
                <Field label={IDENTIFIER_TYPES.mpn[lang]}><input className="input mono" value={f.mpn} onChange={(e) => set("mpn", e.target.value)} dir="ltr" /></Field>
                <Field label={`${t("item.factor")} — ${lang === "ar" ? "كرتون" : "Carton"}`} hint={t("common.optional")}>
                  <input className="input" type="number" min={1} value={f.cartonFactor} onChange={(e) => set("cartonFactor", e.target.value)} />
                </Field>
              </div>
            </Section>
          )}
        </div>

        <div>
          {!isEdit && (
            <Section icon="alert" title={t("item.duplicatesTitle")} className="card card--cream">
              <p className="muted" style={{ fontSize: 14 }}>{t("item.duplicatesHint")}</p>
              {dups?.identifierMatches?.length > 0 && <Alert kind="error">{lang === "ar" ? "المعرّف مستخدم لصنف آخر:" : "Identifier already used by:"} {dups.identifierMatches.map((m: any) => m.item_code).join(", ")}</Alert>}
              <div className="dup-list">
                {(dups?.similar ?? []).map((s: any) => (
                  <Link key={s.id} to={`/items/${s.id}`} target="_blank" className={`dup${s.blocking ? " is-blocking" : ""}`} style={{ textDecoration: "none" }}>
                    <span><span className="mono">{s.item_code}</span> · {L(s)}</span><span className="score">{Math.round(s.score * 100)}%</span>
                  </Link>
                ))}
                {dups && !dups.similar?.length && <span className="muted">✓ {t("common.empty")}</span>}
              </div>
              {blocking && <label className="check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />{t("item.acknowledge")}</label>}
            </Section>
          )}
          <div className="form-actions">
            <Link className="btn btn--secondary" to={isEdit ? `/items/${id}` : "/items"}>{t("common.cancel")}</Link>
            <button className="btn btn--primary" type="submit" disabled={busy || (!isEdit && blocking && !ack)}>
              <Icon name="check" />{isEdit ? t("common.save") : t("common.create")}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
