// Boots the in-browser WMS: PostgreSQL (PGlite, persisted in IndexedDB when available) from the seeded snapshot,
// the attachment store, the API routes, then routes every /api/* request (fetch, links, images) to them.
import { Buffer } from "buffer";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { setDatabase, pgParsers } from "../shims/pg.ts";
import { files } from "../shims/fs.ts";
import "../../../api/src/db/pool.ts"; // registers numeric / bigint parsers before PGlite starts
import { config } from "../../../api/src/config.ts";
import { panel, serverOnly, showFile } from "./panel.ts";
import snapshotUrl from "../../dist-snapshot/db.tar.gz?url";
import filesUrl from "../../dist-snapshot/files.json?url";

export const DEMO_VERSION = "v1";
const IDB_DB = `iarda-wms-demo-${DEMO_VERSION}`;
const FLAG = `iarda-demo-ready-${DEMO_VERSION}`;
const COOKIE = `iarda-demo-session-${DEMO_VERSION}`;
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

// ---------------------------------------------------------------- tiny IndexedDB key/value for uploaded files
function kv() {
  let dbp: Promise<IDBDatabase> | null = null;
  const open = () => (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(`${IDB_DB}-files`, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("f");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (mode: IDBTransactionMode) => (await open()).transaction("f", mode).objectStore("f");
  return {
    async all(): Promise<[string, Uint8Array][]> {
      const s = await tx("readonly");
      return new Promise((res, rej) => {
        const out: [string, Uint8Array][] = []; const c = s.openCursor();
        c.onsuccess = () => { const cur = c.result; if (!cur) return res(out); out.push([String(cur.key), cur.value]); cur.continue(); };
        c.onerror = () => rej(c.error);
      });
    },
    async put(k: string, v: Uint8Array) { const s = await tx("readwrite"); s.put(v, k); },
  };
}

export async function boot(onStatus: (msg: string) => void) {
  const store = config.storageDir.replace(/\/+$/, "") + "/";
  const ext = { pgcrypto, pg_trgm, citext };
  const fresh = !ls.get(FLAG);
  let db: PGlite;
  let persistent = true;
  onStatus(fresh ? "تحميل قاعدة البيانات التجريبية… / Loading demo database…" : "فتح بياناتك المحفوظة… / Opening your saved data…");
  const snapshot = async () => new Blob([await (await fetch(snapshotUrl)).arrayBuffer()], { type: "application/x-gzip" });
  try {
    db = fresh
      ? await PGlite.create(`idb://${IDB_DB}`, { extensions: ext, parsers: pgParsers(), loadDataDir: await snapshot() })
      : await PGlite.create(`idb://${IDB_DB}`, { extensions: ext, parsers: pgParsers() });
    await db.query("SELECT 1 FROM app_user LIMIT 1");
    ls.set(FLAG, "1");
  } catch (e) {
    console.warn("IndexedDB unavailable — running in memory", e);
    persistent = false;
    db = await PGlite.create({ extensions: ext, parsers: pgParsers(), loadDataDir: await snapshot() });
  }
  setDatabase(db);

  // attachment store: seeded files + anything uploaded in this browser
  const seeded: Record<string, string> = await (await fetch(filesUrl)).json();
  for (const [k, v] of Object.entries(seeded)) files.set(store + k, Buffer.from(v, "base64"));
  const fkv = persistent ? kv() : null;
  if (fkv) { try { for (const [k, v] of await fkv.all()) files.set(k, v); } catch { /* ignore */ } }
  const origSet = files.set.bind(files);
  files.set = (k: string, v: Uint8Array) => { if (fkv && !k.startsWith("/tmp")) fkv.put(k, v).catch(() => {}); return origSet(k, v); };

  onStatus("تشغيل الخادم داخل المتصفح… / Starting the in-browser server…");
  const { buildDemoServer } = await import("./server.ts");
  const server = await buildDemoServer();

  // one request at a time — PostgreSQL in the browser has a single connection
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

  const call = (method: string, url: string, headers: Record<string, string>, body?: unknown) => serial(async () => {
    const token = ls.get(COOKIE) ?? (window as any).__demoToken;
    const res = await server.dispatch({ method, url, headers, body, cookies: token ? { [config.session.cookieName]: token } : {} });
    for (const c of res.setCookies) {
      if (c.name !== config.session.cookieName) continue;
      if (c.value) { ls.set(COOKIE, c.value); (window as any).__demoToken = c.value; } else { ls.del(COOKIE); (window as any).__demoToken = null; }
    }
    return res;
  });

  const toResponse = (res: Awaited<ReturnType<typeof call>>) => {
    let body: BodyInit | null = null;
    const h = new Headers(res.headers);
    if (res.body instanceof Uint8Array) body = res.body as unknown as BodyInit;
    else if (typeof res.body === "string") body = res.body;
    else if (res.body !== undefined) { body = JSON.stringify(res.body); if (!h.has("content-type")) h.set("content-type", "application/json"); }
    return new Response(res.status === 204 ? null : body, { status: res.status, headers: h });
  };

  const isApi = (u: string) => { try { const x = new URL(u, location.href); return x.origin === location.origin && x.pathname.startsWith("/api/") || u.startsWith("/api/"); } catch { return false; } };
  const apiPath = (u: string) => (u.startsWith("/api/") ? u : (() => { const x = new URL(u, location.href); return x.pathname + x.search; })());

  // fetch(/api/*) → in-browser server
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!isApi(url)) return realFetch(input as any, init);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    let body: unknown = init?.body;
    if (typeof body === "string" && (headers["content-type"] ?? "").includes("json")) body = JSON.parse(body);
    return toResponse(await call((init?.method ?? "GET").toUpperCase(), apiPath(url), headers, body));
  };

  // <a href="/api/..."> (attachments, labels, reports): the frame allows no downloads → show the file in a panel
  const fetchFile = async (u: string) => {
    const res = await call("GET", apiPath(u), {});
    if (res.status >= 400) throw res;
    const bytes = res.body instanceof Uint8Array ? res.body : new TextEncoder().encode(typeof res.body === "string" ? res.body : JSON.stringify(res.body, null, 2));
    const name = /filename\*=UTF-8''([^;]+)/.exec(res.headers["content-disposition"] ?? "")?.[1] ?? /filename=([^;]+)/.exec(res.headers["content-disposition"] ?? "")?.[1];
    return { bytes, type: (res.headers["content-type"] ?? "application/octet-stream").split(";")[0], name: name ? decodeURIComponent(name) : u.split("/").pop()!.split("?")[0] };
  };
  const blobFor = async (u: string) => { const f = await fetchFile(u); return { url: URL.createObjectURL(new Blob([f.bytes as BlobPart], { type: f.type })) }; };
  document.addEventListener("click", async (e) => {
    const a = (e.target as HTMLElement)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || !isApi(a.getAttribute("href") ?? "")) return;
    e.preventDefault();
    const href = a.getAttribute("href")!;
    if (href.startsWith("/api/docs")) return serverOnly("توثيق الواجهات البرمجية (OpenAPI) يُنشر مع الخادم على /api/docs · The OpenAPI documentation is served by the server at /api/docs.");
    try {
      const f = await fetchFile(href);
      showFile(f.name, f.type, f.bytes);
    } catch (err: any) {
      const e2 = err?.body?.error;
      if (e2?.code === "demo_unavailable") return serverOnly("تصدير التقارير إلى PDF وExcel وPowerPoint بقالب الهوية · Report export to PDF, Excel and PowerPoint in the brand template.");
      panel("تعذّر فتح الملف · Could not open the file", e2 ? `<p>${e2.message_ar}</p><p>${e2.message_en}</p>` : "<p>—</p>");
    }
  }, true);
  window.print = () => serverOnly("الطباعة (سند التسليم، شهادة إخلاء الطرف، ورقة الملصقات) · Printing (delivery notes, clearance certificates, label sheets).");
  const fixImg = async (img: HTMLImageElement) => {
    const src = img.getAttribute("src") ?? "";
    if (!isApi(src) || img.dataset.demoSrc === src) return;
    img.dataset.demoSrc = src;
    try { img.src = (await blobFor(src)).url; } catch { /* leave broken */ }
  };
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === "attributes" && m.target instanceof HTMLImageElement) fixImg(m.target);
      m.addedNodes.forEach((n) => { if (n instanceof HTMLElement) (n.tagName === "IMG" ? [n] : [...n.querySelectorAll("img")]).forEach((i) => fixImg(i as HTMLImageElement)); });
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });

  // background jobs: every minute, and the nightly set once per day on first open
  setInterval(() => serial(server.minute).catch(() => {}), 60_000);
  const today = new Date().toISOString().slice(0, 10);
  if (ls.get(`${FLAG}-nightly`) !== today) { serial(server.nightly).catch(() => {}); ls.set(`${FLAG}-nightly`, today); }

  (window as any).iardaDemo = {
    persistent,
    async reset() {
      ls.del(FLAG); ls.del(COOKIE); ls.del(`${FLAG}-nightly`);
      try { await db.close(); } catch { /* ignore */ }
      for (const name of [`/pglite/${IDB_DB}`, IDB_DB, `${IDB_DB}-files`]) { try { indexedDB.deleteDatabase(name); } catch { /* ignore */ } }
      location.reload();
    },
  };
  return { persistent };
}
