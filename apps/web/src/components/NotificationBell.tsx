import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { Icon } from "./ui";
import { fmtDate } from "../util";

export function NotificationBell() {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  const nav = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ["notifications"], queryFn: () => api.get("/api/notifications"), refetchInterval: 60_000 });
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const unread = q.data?.unread ?? 0;
  return (
    <div className="bell" ref={ref}>
      <button className="icon-btn" type="button" aria-label={lang === "ar" ? "الإشعارات" : "Notifications"} onClick={() => setOpen((o) => !o)}>
        <Icon name="bell" />{unread > 0 && <span className="dot" />}
      </button>
      {open && (
        <div className="bell__panel" role="menu">
          <div className="kpi-target" style={{ padding: "10px 14px" }}>
            <b>{lang === "ar" ? "الإشعارات" : "Notifications"} ({unread})</b>
            {unread > 0 && <button className="btn btn--ghost btn--sm" onClick={async () => { await api.post("/api/notifications/read", {}); qc.invalidateQueries({ queryKey: ["notifications"] }); }}>
              {lang === "ar" ? "تعليم الكل كمقروء" : "Mark all read"}</button>}
          </div>
          {(q.data?.data ?? []).length === 0 && <div className="bell__item">—</div>}
          {(q.data?.data ?? []).map((n: any) => (
            <a key={n.id} href={n.link ?? "#"} className={`bell__item${n.read_at ? "" : " is-unread"}`} onClick={async (e) => {
              e.preventDefault(); setOpen(false);
              if (!n.read_at) { await api.post("/api/notifications/read", { ids: [n.id] }); qc.invalidateQueries({ queryKey: ["notifications"] }); }
              if (n.link) nav(n.link);
            }}>
              <b>{lang === "ar" ? n.title_ar : n.title_en}</b>
              {(lang === "ar" ? n.body_ar : n.body_en) && <div>{lang === "ar" ? n.body_ar : n.body_en}</div>}
              <small className="muted">{fmtDate(n.created_at, lang, true)}</small>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
