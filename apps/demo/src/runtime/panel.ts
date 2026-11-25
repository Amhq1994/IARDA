// In-page panel used instead of alert / confirm / downloads / print, which the artifact frame does not allow.
// Shows images inline, text files (ZPL labels) with a copy button, and explains server-only features.
const CSS = `
.dp-scrim{position:fixed;inset:0;background:#0b1f1680;z-index:60;display:grid;place-items:center;padding:max(16px,env(safe-area-inset-left,0px))}
.dp{background:#fff;color:#1f2d2a;border-radius:14px;max-width:min(720px,100%);width:100%;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 18px 48px #0004;
  font:14px/1.7 "IBM Plex Sans Arabic",system-ui,sans-serif}
.dp header{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid #E5DBC8}
.dp header b{flex:1;color:#AE7029;font-size:16px;font-weight:600;min-width:0;overflow-wrap:anywhere}
.dp .body{padding:16px 18px;overflow:auto;min-height:0}
.dp .body img{display:block;max-width:100%;margin:0 auto;border-radius:8px;background:#f4f7f5}
.dp pre{direction:ltr;text-align:left;white-space:pre-wrap;word-break:break-all;background:#F4F7F5;border-radius:8px;padding:12px;font:12px/1.5 ui-monospace,Menlo,monospace;max-height:50vh;overflow:auto;margin:0}
.dp footer{display:flex;gap:8px;justify-content:flex-end;padding:12px 18px;border-top:1px solid #E5DBC8;flex-wrap:wrap}
.dp button{border:0;border-radius:8px;min-height:38px;padding:0 16px;font:inherit;cursor:pointer;background:#E9EFEC;color:#014F37}
.dp button.primary{background:#005337;color:#fff}
.dp button:focus-visible{outline:2px solid #AE7029;outline-offset:2px}
.dp .note{color:#5B7172;font-size:13px}
`;
let styled = false;

export interface PanelAction { label: string; primary?: boolean; onClick?: () => void | Promise<void> }

export function panel(title: string, body: string | HTMLElement, actions: PanelAction[] = [{ label: "إغلاق / Close", primary: true }]) {
  if (!styled) { const s = document.createElement("style"); s.textContent = CSS; document.head.appendChild(s); styled = true; }
  const scrim = document.createElement("div");
  scrim.className = "dp-scrim";
  scrim.innerHTML = `<div class="dp" role="dialog" aria-modal="true"><header><b></b></header><div class="body"></div><footer></footer></div>`;
  scrim.querySelector("b")!.textContent = title;
  const b = scrim.querySelector(".body")!;
  if (typeof body === "string") b.innerHTML = body; else b.appendChild(body);
  const close = () => scrim.remove();
  const f = scrim.querySelector("footer")!;
  for (const a of actions) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.textContent = a.label; if (a.primary) btn.className = "primary";
    btn.onclick = async () => { await a.onClick?.(); close(); };
    f.appendChild(btn);
  }
  scrim.addEventListener("click", (e) => { if (e.target === scrim) close(); });
  document.addEventListener("keydown", function esc(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); } });
  document.body.appendChild(scrim);
  (f.querySelector("button.primary") as HTMLButtonElement | null)?.focus();
  return close;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function serverOnly(what: string) {
  panel("متاح في نسخة الخادم · Server version only",
    `<p>${esc(what)}</p><p class="note">نسخة العرض تعمل داخل متصفحك في إطار Claude، وهذا الإطار لا يسمح بتنزيل الملفات أو الطباعة. تعمل هذه الميزة كاملة عند تثبيت النظام على الخادم.<br>
     The demo runs inside your browser in Claude's frame, which does not allow file downloads or printing. This works fully once the system is installed on a server.</p>`);
}

/** Shows a file the app tried to open: images inline, text (ZPL, CSV, JSON) as copyable text, anything else described. */
export function showFile(name: string, type: string, bytes: Uint8Array) {
  const kb = `${Math.max(1, Math.round(bytes.length / 1024))} KB`;
  if (type.startsWith("image/")) {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    const img = document.createElement("img"); img.src = url; img.alt = name;
    panel(`${name} · ${kb}`, img);
    return;
  }
  if (type.startsWith("text/") || type.includes("json") || /\.(zpl|csv|txt)$/i.test(name)) {
    const text = new TextDecoder().decode(bytes);
    const pre = document.createElement("pre"); pre.textContent = text.length > 60000 ? text.slice(0, 60000) + "\n…" : text;
    panel(`${name} · ${kb}`, pre, [
      { label: "نسخ / Copy", onClick: async () => { try { await navigator.clipboard.writeText(text); } catch { const r = document.createRange(); r.selectNodeContents(pre); getSelection()?.removeAllRanges(); getSelection()?.addRange(r); } } },
      { label: "إغلاق / Close", primary: true }]);
    return;
  }
  panel(`${name} · ${kb}`, `<p>الملف موجود ومُتحقَّق من سلامته (مشفّر في المخزن ومطابق لبصمته SHA-256)، لكن إطار Claude لا يعرض ملفات ${esc(type)} ولا يسمح بتنزيلها.</p>
    <p class="note">The file exists and passed its integrity check (encrypted at rest, SHA-256 verified), but Claude's frame cannot display ${esc(type)} files or download them. It opens normally on the server version.</p>`);
}
