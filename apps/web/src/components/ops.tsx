// Operational UI building blocks: barcode scanner (camera + keyboard wedge), signature pad,
// document timeline, status badges for requests / receipts.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./ui";
import { fmtDate } from "../util";

const MR_TONE: Record<string, string> = {
  draft: "badge--neutral", pending_approval: "badge--warning", approved: "badge--success", rejected: "badge--error", reserved: "badge--success",
  picking: "badge--warning", ready_for_delivery: "badge--success", partially_delivered: "badge--warning", delivered: "badge--success", closed: "badge--neutral", cancelled: "badge--neutral",
  arrived: "badge--warning", qty_checked: "badge--warning", in_inspection: "badge--warning", inspected: "badge--success", grn_posted: "badge--warning", putaway_done: "badge--success",
  open: "badge--warning", partially_received: "badge--warning", received: "badge--success", waiting: "badge--neutral", pending: "badge--warning", returned: "badge--warning",
  skipped: "badge--neutral", ready_for_payment: "badge--success", exception: "badge--error", matched: "badge--success",
};

export function DocBadge({ status, dict = "mrStatus" }: { status: string; dict?: "mrStatus" | "rcvStatus" | "poStatus" | "approvalStatus" }) {
  const { t } = useTranslation();
  const label = t(`${dict}.${status}`, { defaultValue: status });
  return <span className={`badge ${MR_TONE[status] ?? "badge--neutral"}`}>{label}</span>;
}

/** Scan input: works with hardware (keyboard-wedge) scanners, typing, and the device camera. */
export function ScanInput({ label, onScan, autoFocus, placeholder }: { label: string; onScan: (code: string) => void; autoFocus?: boolean; placeholder?: string }) {
  const { t } = useTranslation();
  const [v, setV] = useState("");
  const [cam, setCam] = useState(false);
  const submit = (e: FormEvent) => { e.preventDefault(); const c = v.trim(); if (c) { onScan(c); setV(""); } };
  return (
    <form onSubmit={submit} className="scan">
      <label>{label}</label>
      <div className="scan__row">
        <div className="input-wrap" style={{ flex: 1 }}><Icon name="search" />
          <input className="input mono scan__input" dir="ltr" value={v} onChange={(e) => setV(e.target.value)} autoFocus={autoFocus} placeholder={placeholder}
            autoComplete="off" autoCapitalize="characters" inputMode="text" />
        </div>
        <button type="button" className="btn btn--secondary" onClick={() => setCam(true)} aria-label={t("ops.camera")}><Icon name="slides" /></button>
        <button type="submit" className="btn btn--primary">{t("ops.confirm")}</button>
      </div>
      {cam && <CameraScanner onClose={() => setCam(false)} onCode={(c) => { setCam(false); onScan(c); }} />}
    </form>
  );
}

function CameraScanner({ onCode, onClose }: { onCode: (c: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stop = () => {};
    let cancelled = false;
    (async () => {
      try {
        const BD = (window as any).BarcodeDetector;
        if (BD) {
          const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
          if (cancelled) { stream.getTracks().forEach((tr) => tr.stop()); return; }
          video.current!.srcObject = stream;
          await video.current!.play();
          const det = new BD({ formats: ["ean_13", "ean_8", "code_128", "code_39", "qr_code", "data_matrix", "upc_a"] });
          let raf = 0;
          const loop = async () => {
            try { const r = await det.detect(video.current!); if (r[0]?.rawValue) { onCode(r[0].rawValue); return; } } catch { /* frame not ready */ }
            raf = requestAnimationFrame(loop);
          };
          loop();
          stop = () => { cancelAnimationFrame(raf); stream.getTracks().forEach((tr) => tr.stop()); };
        } else {
          // iOS Safari and others: ZXing fallback, loaded on demand
          const { BrowserMultiFormatReader } = await import("@zxing/browser");
          const reader = new BrowserMultiFormatReader();
          const controls = await reader.decodeFromVideoDevice(undefined, video.current!, (res) => { if (res) { controls.stop(); onCode(res.getText()); } });
          stop = () => controls.stop();
        }
      } catch (e: any) {
        setErr(e?.message ?? "camera unavailable");
      }
    })();
    return () => { cancelled = true; stop(); };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: "min(480px, 100%)" }}>
        <div className="modal__head"><b>{t("ops.camera")}</b><button className="icon-btn" type="button" onClick={onClose}><Icon name="error" /></button></div>
        <div className="modal__body">
          {err ? <div className="alert alert--error"><Icon name="error" /><span>{err}</span></div>
            : <video ref={video} className="scan__video" playsInline muted />}
        </div>
      </div>
    </div>
  );
}

/** Finger / mouse signature capture → PNG data URL. */
export function SignaturePad({ onChange }: { onChange: (png: string | null) => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  useEffect(() => {
    const c = ref.current!;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio; c.height = c.clientHeight * ratio;
    const ctx = c.getContext("2d")!;
    ctx.scale(ratio, ratio); ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.strokeStyle = "#014F37";
  }, []);
  const pos = (e: React.PointerEvent) => { const r = ref.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  return (
    <div className="sigpad">
      <canvas ref={ref} aria-label={t("ops.signHere")}
        onPointerDown={(e) => { drawing.current = true; ref.current!.setPointerCapture(e.pointerId); const [x, y] = pos(e); const ctx = ref.current!.getContext("2d")!; ctx.beginPath(); ctx.moveTo(x, y); }}
        onPointerMove={(e) => { if (!drawing.current) return; const [x, y] = pos(e); const ctx = ref.current!.getContext("2d")!; ctx.lineTo(x, y); ctx.stroke(); dirty.current = true; }}
        onPointerUp={() => { drawing.current = false; if (dirty.current) onChange(ref.current!.toDataURL("image/png")); }} />
      <div className="sigpad__foot"><span className="muted">{t("ops.signHere")}</span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => {
          const c = ref.current!; c.getContext("2d")!.clearRect(0, 0, c.width, c.height); dirty.current = false; onChange(null);
        }}>{t("ops.clear")}</button></div>
    </div>
  );
}

export function Timeline({ events }: { events: any[] }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  return (
    <ol className="timeline">
      {events.map((e) => (
        <li key={e.id}>
          <span className="timeline__dot" />
          <div>
            <b>{t(`events.${e.event}`, { defaultValue: e.event.replace(/_/g, " ") })}</b>
            {e.to_status && e.to_status !== e.from_status && <> → {t(`mrStatus.${e.to_status}`, { defaultValue: t(`rcvStatus.${e.to_status}`, { defaultValue: t(`docStatus.${e.to_status}`, { defaultValue: e.to_status }) }) })}</>}
            <div className="muted" style={{ fontSize: 12.5 }}>{(lang === "ar" ? e.actor_ar : e.actor_en) ?? (lang === "ar" ? "النظام" : "System")} · {fmtDate(e.at, lang, true)}</div>
            {e.comment && <div style={{ fontSize: 13.5 }}>{e.comment}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
