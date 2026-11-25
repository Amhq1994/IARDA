import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { useAuth } from "../auth";
import { Field, Icon, Loading, Modal, PageHead, Tabs, toast } from "../components/ui";
import { errorText, useL } from "../util";

export function CatalogPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const L = useL();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState("categories");
  const [modal, setModal] = useState<null | { kind: "category" | "uom"; parent?: any }>(null);
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => api.get("/api/categories") });
  const uoms = useQuery({ queryKey: ["uoms"], queryFn: () => api.get("/api/uoms") });
  const editable = can("category.manage");

  async function save(url: string, body: any) {
    try { await api.post(url, body); toast.success(t("common.saved")); qc.invalidateQueries({ queryKey: ["categories"] }); qc.invalidateQueries({ queryKey: ["uoms"] }); setModal(null); }
    catch (e) { toast.error(errorText(e, lang)); }
  }

  return (
    <>
      <PageHead icon="leaf" title={t("nav.catalog")} />
      <section className="card">
        <Tabs value={tab} onChange={setTab} tabs={[{ id: "categories", label: `${t("item.category")} / ${t("item.group")}`, count: cats.data?.data.length },
          { id: "uoms", label: t("item.uom"), count: uoms.data?.data.length }]} />
        {tab === "categories" && (cats.isLoading ? <Loading /> : (
          <>
            {editable && <div className="toolbar" style={{ justifyContent: "flex-end" }}>
              <button className="btn btn--primary btn--sm" onClick={() => setModal({ kind: "category" })}><Icon name="plus" className="icon icon-sm" />{t("item.category")}</button></div>}
            <div className="table-wrap"><table className="table"><thead><tr>
              <th>{t("common.code")}</th><th>{t("common.name")}</th><th className="c">{t("common.total")}</th><th>GL</th><th></th>
            </tr></thead><tbody>
              {cats.data.data.map((c: any) => [
                <tr key={c.id} className="is-highlight"><td className="mono"><b>{c.code}</b></td><td><b>{L(c)}</b>{c.is_critical && <span className="badge badge--warning" style={{ marginInlineStart: 8 }}>{lang === "ar" ? "حرج" : "Critical"}</span>}</td>
                  <td className="n">{c.item_count}</td><td className="mono">{c.gl_inventory_account ?? "—"}</td>
                  <td className="actions">{editable && <button className="btn btn--ghost btn--sm" onClick={() => setModal({ kind: "category", parent: c })}><Icon name="plus" className="icon icon-sm" />{t("item.group")}</button>}</td></tr>,
                ...c.groups.map((g: any) => (
                  <tr key={g.id}><td className="mono" style={{ paddingInlineStart: 32 }}>{g.code}</td><td style={{ paddingInlineStart: 32 }}>{L(g)}</td>
                    <td className="n">{g.item_count}</td><td></td><td></td></tr>
                )),
              ])}
            </tbody></table></div>
          </>
        ))}
        {tab === "uoms" && (uoms.isLoading ? <Loading /> : (
          <>
            {editable && <div className="toolbar" style={{ justifyContent: "flex-end" }}>
              <button className="btn btn--primary btn--sm" onClick={() => setModal({ kind: "uom" })}><Icon name="plus" className="icon icon-sm" />{t("common.add")}</button></div>}
            <div className="table-wrap"><table className="table"><thead><tr><th>{t("common.code")}</th><th>{t("common.nameAr")}</th><th>{t("common.nameEn")}</th><th>{t("common.type")}</th></tr></thead>
              <tbody>{uoms.data.data.map((u: any) => <tr key={u.id}><td className="mono">{u.code}</td><td>{u.name_ar}</td><td>{u.name_en}</td><td>{u.dimension}</td></tr>)}</tbody></table></div>
          </>
        ))}
      </section>
      {modal && <CodeNameModal title={modal.kind === "uom" ? t("item.uom") : modal.parent ? `${t("item.group")} — ${L(modal.parent)}` : t("item.category")}
        onClose={() => setModal(null)}
        onSubmit={(b) => modal.kind === "uom" ? save("/api/uoms", b)
          : save("/api/categories", { ...b, level: modal.parent ? "group" : "category", parentId: modal.parent?.id })} />}
    </>
  );
}

function CodeNameModal({ title, onClose, onSubmit }: { title: string; onClose: () => void; onSubmit: (b: any) => void }) {
  const { t } = useTranslation();
  const [b, setB] = useState({ code: "", nameAr: "", nameEn: "" });
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn--primary" disabled={!b.code || !b.nameAr || !b.nameEn} onClick={() => onSubmit(b)}>{t("common.create")}</button></>}>
      <Field label={t("common.code")} required hint="A–Z, 0–9"><input className="input mono" dir="ltr" value={b.code} onChange={(e) => setB({ ...b, code: e.target.value.toUpperCase() })} autoFocus /></Field>
      <Field label={t("common.nameAr")} required><input className="input" value={b.nameAr} onChange={(e) => setB({ ...b, nameAr: e.target.value })} /></Field>
      <Field label={t("common.nameEn")} required><input className="input" dir="ltr" value={b.nameEn} onChange={(e) => setB({ ...b, nameEn: e.target.value })} /></Field>
    </Modal>
  );
}

