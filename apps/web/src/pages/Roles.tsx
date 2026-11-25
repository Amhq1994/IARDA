import { Fragment } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { useAuth } from "../auth";
import { Alert, Loading, PageHead, toast } from "../components/ui";
import { errorText, useL } from "../util";

const MODULES: Record<string, [string, string]> = {
  admin: ["الإدارة", "Administration"], delegation: ["التفويض", "Delegation"], audit: ["التدقيق", "Audit"], item: ["الأصناف", "Items"],
  category: ["التصنيفات", "Categories"], warehouse: ["المستودعات", "Warehouses"], supplier: ["الموردون", "Suppliers"], po: ["أوامر الشراء", "Purchase orders"],
  asn: ["إشعارات الشحن", "ASN"], receipt: ["الاستلام", "Receiving"], inspection: ["الفحص", "Inspection"], grn: ["سند الاستلام", "GRN"],
  putaway: ["التخزين", "Put-away"], invoice: ["الفواتير", "Invoices"], request: ["الطلبات", "Requests"], issue: ["الصرف", "Issue"], pick: ["التجهيز", "Picking"],
  delivery: ["التسليم", "Delivery"], transfer: ["النقل", "Transfers"], return: ["المرتجعات", "Returns"], count: ["الجرد", "Counting"],
  adjustment: ["التسويات", "Adjustments"], disposal: ["الإتلاف", "Disposal"], planning: ["التخطيط", "Planning"], pr: ["طلبات الشراء", "Requisitions"],
  valuation: ["التقييم", "Valuation"], journal: ["القيود", "Journals"], custody: ["العهد", "Custody"], clearance: ["إخلاء الطرف", "Clearance"],
  dashboard: ["لوحة المعلومات", "Dashboard"], report: ["التقارير", "Reports"], mobile: ["الجوال", "Mobile"],
};

export function RolesPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language as "ar" | "en";
  const L = useL();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["roles"], queryFn: () => api.get("/api/roles") });
  const editable = can("admin.roles");
  if (q.isLoading) return <Loading />;
  const { roles, permissions } = q.data;
  const modules = [...new Set<string>(permissions.map((p: any) => p.module))];

  async function toggle(role: string, key: string, granted: boolean) {
    try { await api.put(`/api/roles/${role}/permissions/${key}`, { granted }); qc.invalidateQueries({ queryKey: ["roles"] }); toast.success(t("common.saved")); }
    catch (e) { toast.error(errorText(e, lang)); }
  }

  return (
    <>
      <PageHead icon="shield" title={t("admin.matrix")} lead={`${roles.length} ${lang === "ar" ? "دوراً" : "roles"} · ${permissions.length} ${lang === "ar" ? "صلاحية" : "permissions"}`} />
      <div className="section"><Alert>{t("admin.sodNote")}</Alert></div>
      <section className="card" style={{ padding: 0 }}>
        <div className="table-wrap" style={{ maxHeight: "70vh", border: 0 }}>
          <table className="table matrix">
            <thead><tr>
              <th style={{ minWidth: 240 }}>{t("admin.permission")}</th>
              {roles.map((r: any) => <th key={r.code} className="rot" title={L(r)}>{r.code} · {L(r)} ({r.user_count})</th>)}
            </tr></thead>
            <tbody>
              {modules.map((m) => (
                <Fragment key={m}>
                  <tr className="module-row"><td colSpan={roles.length + 1}>{MODULES[m]?.[lang === "ar" ? 0 : 1] ?? m}</td></tr>
                  {permissions.filter((p: any) => p.module === m).map((p: any) => (
                    <tr key={p.key}>
                      <td>{L(p)}<br /><small className="mono muted">{p.key}</small></td>
                      {roles.map((r: any) => {
                        const on = r.permissions.includes(p.key);
                        return (
                          <td key={r.code} className="cell">
                            {editable ? <input type="checkbox" checked={on} aria-label={`${r.code} ${p.key}`} onChange={(e) => toggle(r.code, p.key, e.target.checked)} />
                              : on ? <span className="text-green">●</span> : <span className="muted">·</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
