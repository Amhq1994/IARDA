import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { useAuth } from "../auth";
import { Field, Icon, Loading, Modal, PageHead, Pagination, toast } from "../components/ui";
import { errorText, useL } from "../util";

export function SuppliersPage() {
  const { t, i18n } = useTranslation();
  const L = useL();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const r = useQuery({ queryKey: ["suppliers", q, page], queryFn: () => api.get("/api/suppliers", { q, page }) });
  return (
    <>
      <PageHead icon="users" title={t("nav.suppliers")} actions={can("supplier.manage") && <button className="btn btn--primary" onClick={() => setOpen(true)}><Icon name="plus" />{t("common.add")}</button>} />
      <section className="card">
        <div className="toolbar"><div className="field grow"><div className="input-wrap"><Icon name="search" />
          <input className="input" placeholder={t("common.search")} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div></div></div>
        {r.isLoading ? <Loading /> : (
          <>
            <div className="table-wrap"><table className="table"><thead><tr>
              <th>{t("common.code")}</th><th>{t("common.name")}</th><th>{i18n.language === "ar" ? "السجل التجاري" : "CR no."}</th>
              <th>{i18n.language === "ar" ? "الرقم الضريبي" : "VAT no."}</th><th>{i18n.language === "ar" ? "رقم المورد في اعتماد" : "Etimad vendor ID"}</th><th>{t("wh.city")}</th>
            </tr></thead><tbody>
              {r.data.data.map((s: any) => <tr key={s.id}><td className="mono">{s.code}</td><td>{L(s)}</td><td className="mono">{s.cr_number}</td>
                <td className="mono">{s.vat_number}</td><td className="mono">{s.etimad_vendor_id}</td><td>{s.city}</td></tr>)}
            </tbody></table></div>
            <Pagination page={r.data.page} pageSize={r.data.pageSize} total={r.data.total} onPage={setPage} />
          </>
        )}
      </section>
      {open && <SupplierModal onClose={() => setOpen(false)} onSaved={() => { setOpen(false); qc.invalidateQueries({ queryKey: ["suppliers"] }); }} />}
    </>
  );
}

function SupplierModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === "ar";
  const [b, setB] = useState({ code: "", nameAr: "", nameEn: "", crNumber: "", vatNumber: "", etimadVendorId: "", city: "" });
  const f = (k: keyof typeof b, label: string, ltr = false) => (
    <Field label={label}><input className={`input${ltr ? " mono" : ""}`} dir={ltr ? "ltr" : undefined} value={b[k]} onChange={(e) => setB({ ...b, [k]: e.target.value })} /></Field>
  );
  return (
    <Modal title={t("nav.suppliers")} onClose={onClose} footer={<><button className="btn btn--secondary" onClick={onClose}>{t("common.cancel")}</button>
      <button className="btn btn--primary" onClick={async () => {
        try { await api.post("/api/suppliers", Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v || null]))); toast.success(t("common.saved")); onSaved(); }
        catch (e) { toast.error(errorText(e, i18n.language)); }
      }}>{t("common.create")}</button></>}>
      <div className="form-grid">
        {f("code", t("common.code"), true)}{f("city", t("wh.city"))}{f("nameAr", t("common.nameAr"))}{f("nameEn", t("common.nameEn"))}
        {f("crNumber", ar ? "السجل التجاري" : "CR no.", true)}{f("vatNumber", ar ? "الرقم الضريبي (15 رقماً)" : "VAT no. (15 digits)", true)}{f("etimadVendorId", ar ? "رقم المورد في اعتماد" : "Etimad vendor ID", true)}
      </div>
    </Modal>
  );
}
