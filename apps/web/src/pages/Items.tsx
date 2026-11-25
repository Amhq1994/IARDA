import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ITEM_STATUSES, ITEM_TYPES, VED } from "@iarda/shared";
import { api, type Page } from "../api";
import { useAuth } from "../auth";
import { Empty, Icon, Loading, PageHead, Pagination, StatusBadge, toast } from "../components/ui";
import { errorText, useL } from "../util";

export function ItemsPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language as "ar" | "en";
  const L = useL();
  const { can } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [text, setText] = useState(sp.get("q") ?? "");
  const params = {
    q: sp.get("q") ?? "", status: sp.get("status") ?? "", categoryId: sp.get("categoryId") ?? "", itemType: sp.get("itemType") ?? "",
    ved: sp.get("ved") ?? "", page: Number(sp.get("page") ?? 1), pageSize: 25, sort: sp.get("sort") ?? "code", dir: sp.get("dir") ?? "asc",
  };
  const set = (patch: Record<string, string | number>) => {
    const n = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) v === "" ? n.delete(k) : n.set(k, String(v));
    if (!("page" in patch)) n.delete("page");
    setSp(n, { replace: true });
  };
  useEffect(() => {
    const h = setTimeout(() => text !== params.q && set({ q: text }), 300);
    return () => clearTimeout(h);
  }, [text]);

  const cats = useQuery({ queryKey: ["categories"], queryFn: () => api.get("/api/categories") });
  const q = useQuery({ queryKey: ["items", params], queryFn: () => api.get<Page<any>>("/api/items", params), placeholderData: (p) => p });

  const sortBy = (k: string) => set({ sort: k, dir: params.sort === k && params.dir === "asc" ? "desc" : "asc" });
  const sortMark = (k: string) => (params.sort === k ? (params.dir === "asc" ? " ↑" : " ↓") : "");

  async function lookup(code: string) {
    try { const r = await api.get("/api/items/lookup", { code }); nav(`/items/${r.id}`); }
    catch (e) { toast.error(errorText(e, lang)); }
  }

  return (
    <>
      <PageHead icon="table" title={t("item.title")}
        actions={can("item.manage", "item.request") && (
          <Link className="btn btn--primary" to="/items/new"><Icon name="plus" />{can("item.manage") ? t("item.newTitle") : t("item.requestTitle")}</Link>
        )} />

      <section className="card">
        <div className="toolbar">
          <div className="field grow">
            <label>{t("common.search")}</label>
            <div className="input-wrap"><Icon name="search" />
              <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("item.lookupHint")}
                onKeyDown={(e) => { if (e.key === "Enter" && /^[\d-A-Z]{6,}$/i.test(text.trim())) lookup(text.trim()); }} />
            </div>
          </div>
          <div className="field">
            <label>{t("item.category")}</label>
            <select className="select" value={params.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
              <option value="">{t("common.all")}</option>
              {cats.data?.data.map((c: any) => <option key={c.id} value={c.id}>{L(c)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>{t("common.status")}</label>
            <select className="select" value={params.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">{t("common.all")}</option>
              {Object.entries(ITEM_STATUSES).map(([k, v]) => <option key={k} value={k}>{v[lang]}</option>)}
            </select>
          </div>
          <div className="field">
            <label>{t("item.type")}</label>
            <select className="select" value={params.itemType} onChange={(e) => set({ itemType: e.target.value })}>
              <option value="">{t("common.all")}</option>
              {Object.entries(ITEM_TYPES).map(([k, v]) => <option key={k} value={k}>{v[lang]}</option>)}
            </select>
          </div>
          <div className="field" style={{ minWidth: 120 }}>
            <label>{t("item.ved")}</label>
            <select className="select" value={params.ved} onChange={(e) => set({ ved: e.target.value })}>
              <option value="">{t("common.all")}</option>
              {Object.entries(VED).map(([k, v]) => <option key={k} value={k}>{k} — {v[lang]}</option>)}
            </select>
          </div>
        </div>

        {q.isLoading ? <Loading /> : !q.data?.data.length ? <Empty /> : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead><tr>
                  <th className="col-opt" style={{ width: 52 }}></th>
                  <th role="button" onClick={() => sortBy("code")}>{t("item.code")}{sortMark("code")}</th>
                  <th role="button" onClick={() => sortBy(lang === "ar" ? "nameAr" : "nameEn")}>{t("common.name")}{sortMark(lang === "ar" ? "nameAr" : "nameEn")}</th>
                  <th className="col-opt">{t("item.group")}</th>
                  <th className="c col-opt">{t("item.type")}</th>
                  <th className="c col-opt">{t("item.uom")}</th>
                  <th className="c col-opt">{t("item.tracking")}</th>
                  <th className="c col-opt">{t("item.ved")}</th>
                  <th className="c" role="button" onClick={() => sortBy("status")}>{t("common.status")}{sortMark("status")}</th>
                </tr></thead>
                <tbody>
                  {q.data.data.map((r) => (
                    <tr key={r.id} className="is-clickable" onClick={() => nav(`/items/${r.id}`)}>
                      <td className="col-opt">{r.image_id ? <img className="thumb" src={`/api/attachments/${r.image_id}/content`} alt="" loading="lazy" />
                        : <span className="thumb thumb--empty"><Icon name="table" className="icon icon-sm" /></span>}</td>
                      <td className="mono"><Link to={`/items/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.item_code}</Link></td>
                      <td><b style={{ color: "var(--iarda-primary-dark)", fontWeight: 500 }}>{L(r)}</b><br /><small className="muted">{lang === "ar" ? r.name_en : r.name_ar}</small></td>
                      <td className="col-opt"><small>{L(r, "category_name")}</small><br />{L(r, "group_name")}</td>
                      <td className="c col-opt">{(ITEM_TYPES as any)[r.item_type]?.[lang]}</td>
                      <td className="c col-opt">{L(r, "uom_name")}</td>
                      <td className="c col-opt"><div className="chips" style={{ justifyContent: "center" }}>
                        {r.track_batch && <span className="chip">{t("item.batch")}</span>}
                        {r.track_serial && <span className="chip">{t("item.serial")}</span>}
                        {r.track_expiry && <span className="chip">{t("item.expiry")}</span>}
                      </div></td>
                      <td className="c col-opt">{r.ved_class ?? "—"}</td>
                      <td className="c"><StatusBadge status={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => set({ page: p })} />
          </>
        )}
      </section>
    </>
  );
}
