// Entry of the in-browser demo: Node globals first (the API code reads them at import time), then the database
// and API, then the real web app.
import { Buffer } from "buffer";

// buffer@6 lacks "base64url" (Node ≥ 15): add it on top of base64
const toStr = Buffer.prototype.toString;
Buffer.prototype.toString = function (this: Buffer, enc?: any, ...rest: any[]) {
  if (enc === "base64url") return toStr.call(this, "base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return toStr.call(this, enc, ...rest);
} as any;
const from = Buffer.from as any;
(Buffer as any).from = function (v: any, enc?: any, ...rest: any[]) {
  if (enc === "base64url" && typeof v === "string") return from.call(Buffer, v.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return from.call(Buffer, v, enc, ...rest);
};
(globalThis as any).Buffer = Buffer;
(globalThis as any).process ??= { env: {}, argv: [], nextTick: (fn: () => void) => queueMicrotask(fn) };

// The artifact host serves only web file types, so binary assets (database snapshot, PGlite data, extension bundles)
// are published as base64 text next to their original names; requests for the originals are answered from those.
{
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url, location.href);
    if (u.origin === location.origin && /\.(gz|data)$/.test(u.pathname)) {
      const res = await realFetch(u.pathname.replace(/^.*\/assets\//, "./assets/") + ".b64.txt");
      if (!res.ok) return res;
      const bin = atob((await res.text()).trim());
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    return realFetch(input as any, init);
  };
}

const status = document.getElementById("boot-status")!;
const setStatus = (m: string) => { status.textContent = m; };

(async () => {
  try {
    const { boot } = await import("./runtime/boot.ts");
    const { persistent } = await boot(setStatus);
    setStatus("فتح الواجهة… / Opening the app…");
    await import("../../web/src/main.tsx");
    document.getElementById("boot")?.remove();
    const bar = document.getElementById("demo-bar")!;
    bar.hidden = false;
    bar.querySelector<HTMLElement>("[data-persist]")!.textContent = persistent
      ? "تُحفظ تغييراتك في هذا المتصفح · Changes are saved in this browser"
      : "التغييرات مؤقتة حتى تحديث الصفحة · Changes last until you reload";
    const { panel } = await import("./runtime/panel.ts");
    bar.querySelector<HTMLButtonElement>("[data-reset]")!.onclick = () => panel("إعادة ضبط البيانات · Reset demo data",
      "<p>تعود البيانات التجريبية إلى حالتها الأولى، وتُحذف كل التغييرات التي أجريتها في هذا المتصفح.</p><p>The demo data returns to its initial state and every change you made in this browser is removed.</p>",
      [{ label: "إلغاء / Cancel" }, { label: "إعادة الضبط / Reset", primary: true, onClick: () => (window as any).iardaDemo.reset() }]);
    bar.querySelector<HTMLButtonElement>("[data-close]")!.onclick = () => bar.classList.toggle("is-min");
  } catch (e: any) {
    console.error(e);
    setStatus(`تعذّر تشغيل نسخة العرض / The demo could not start: ${e?.message ?? e}`);
  }
})();
