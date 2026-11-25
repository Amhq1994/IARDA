import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { Loading, PageHead, toast } from "../components/ui";
import { errorText, fmtDate, useL } from "../util";

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const L = useL();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api.get("/api/settings") });
  const [edit, setEdit] = useState<Record<string, string>>({});
  if (q.isLoading) return <Loading />;
  return (
    <>
      <PageHead icon="settings" title={t("admin.settings")} />
      <section className="card">
        <div className="table-wrap"><table className="table"><thead><tr><th>{t("common.name")}</th><th>{t("admin.value")}</th><th>{t("common.updatedAt")}</th><th></th></tr></thead>
          <tbody>{q.data.data.map((s: any) => {
            const val = edit[s.key] ?? JSON.stringify(s.value);
            const dirty = edit[s.key] !== undefined && edit[s.key] !== JSON.stringify(s.value);
            return (
              <tr key={s.key}>
                <td>{L(s, "description")}<br /><small className="mono muted">{s.key}</small></td>
                <td><input className="input mono" dir="ltr" value={val} onChange={(e) => setEdit({ ...edit, [s.key]: e.target.value })} /></td>
                <td>{fmtDate(s.updated_at, i18n.language)}</td>
                <td className="actions"><button className="btn btn--primary btn--sm" disabled={!dirty} onClick={async () => {
                  try {
                    await api.put(`/api/settings/${s.key}`, { value: JSON.parse(val), version: s.version });
                    toast.success(t("common.saved")); setEdit(({ [s.key]: _, ...rest }) => rest); qc.invalidateQueries({ queryKey: ["settings"] });
                  } catch (e) { toast.error(e instanceof SyntaxError ? "JSON" : errorText(e, i18n.language)); }
                }}>{t("common.save")}</button></td>
              </tr>
            );
          })}</tbody></table></div>
      </section>
    </>
  );
}
