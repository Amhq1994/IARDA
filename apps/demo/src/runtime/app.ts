// A minimal Fastify-compatible router so the WMS route modules run unchanged in the browser:
// app.get/post/put/patch/delete, register (scoped hooks), addHook, preHandler, req/rep subset, cookies, multipart.
type Handler = (req: any, rep: any) => any;
type Hook = (req: any, rep: any) => any;
interface Route { method: string; re: RegExp; keys: string[]; opts: any; handler: Handler; hooks: Scope }
interface Scope { onRequest: Hook[]; preHandler: Hook[]; onResponse: Hook[] }

export interface DemoRequest { method: string; url: string; headers: Record<string, string>; body?: unknown; cookies: Record<string, string> }
export interface DemoResponse { status: number; headers: Record<string, string>; body: unknown; setCookies: { name: string; value: string | null }[] }

const compile = (path: string) => {
  const keys: string[] = [];
  const re = new RegExp("^" + path.replace(/[.+*?^$()[\]{}|\\]/g, "\\$&").replace(/:([A-Za-z_]+)/g, (_m, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  return { re, keys };
};

export function createApp() {
  const routes: Route[] = [];
  let errorHandler: ((err: any, req: any, rep: any) => any) | null = null;
  const log = { info: () => {}, warn: console.warn, error: console.error, debug: () => {} };

  const make = (scope: Scope): any => {
    const add = (method: string) => (path: string, a: any, b?: Handler) => {
      const opts = typeof a === "function" ? {} : a ?? {};
      const handler = (typeof a === "function" ? a : b) as Handler;
      routes.push({ method, ...compile(path), opts, handler, hooks: scope });
    };
    const self: any = {
      log,
      get: add("GET"), post: add("POST"), put: add("PUT"), patch: add("PATCH"), delete: add("DELETE"),
      addHook(name: keyof Scope, fn: Hook) { (scope[name] ??= []).push(fn); },
      async register(fn: (app: any) => Promise<void> | void) {
        // child scope inherits the parent's hooks; hooks added inside apply to the child only
        await fn(make({ onRequest: [...scope.onRequest], preHandler: [...scope.preHandler], onResponse: [...scope.onResponse] }));
      },
      setErrorHandler(fn: any) { errorHandler = fn; },
      setNotFoundHandler() {},
      decorateRequest() {}, decorateReply() {}, decorate() {},
    };
    return self;
  };
  const root: Scope = { onRequest: [], preHandler: [], onResponse: [] };
  const app = make(root);

  async function dispatch(r: DemoRequest): Promise<DemoResponse> {
    const u = new URL(r.url, "http://demo.local");
    const path = u.pathname;
    const query: Record<string, string | string[]> = {};
    for (const [k, v] of u.searchParams) query[k] = k in query ? ([] as string[]).concat(query[k], v) : v;
    const res: DemoResponse = { status: 200, headers: {}, body: undefined, setCookies: [] };
    let sent = false;
    const rep: any = {
      get statusCode() { return res.status; },
      status(n: number) { res.status = n; return rep; },
      code(n: number) { res.status = n; return rep; },
      header(k: string, v: string) { res.headers[k.toLowerCase()] = String(v); return rep; },
      type(v: string) { res.headers["content-type"] = v; return rep; },
      send(payload?: unknown) { res.body = payload; sent = true; return rep; },
      setCookie(name: string, value: string) { res.setCookies.push({ name, value }); return rep; },
      clearCookie(name: string) { res.setCookies.push({ name, value: null }); return rep; },
    };
    const route = routes.find((x) => x.method === r.method && x.re.test(path));
    const params: Record<string, string> = {};
    if (route) { const m = route.re.exec(path)!; route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]))); }
    const form = r.body instanceof FormData ? r.body : null;
    const req: any = {
      id: crypto.randomUUID(), method: r.method, url: path + u.search, headers: r.headers, cookies: r.cookies, ip: "127.0.0.1",
      params, query, body: form ? undefined : r.body, log,
      async file() {
        if (!form) return undefined;
        const f = [...form.entries()].find(([, v]) => v instanceof Blob);
        if (!f) return undefined;
        const blob = f[1] as File;
        const fields: Record<string, { value: string }> = {};
        for (const [k, v] of form.entries()) if (typeof v === "string") fields[k] = { value: v };
        const { Buffer } = await import("buffer");
        const buf = Buffer.from(await blob.arrayBuffer());
        return { fields, mimetype: blob.type || "application/octet-stream", filename: blob.name || "file", toBuffer: async () => buf };
      },
    };
    const scope = route?.hooks ?? root;
    try {
      for (const h of scope.onRequest) { await h(req, rep); if (sent) return res; }
      if (!route) { res.status = 404; res.body = { error: { code: "not_found", message_ar: "غير موجود", message_en: "Not found" } }; return res; }
      for (const h of scope.preHandler) { await h(req, rep); if (sent) return res; }
      const pre = route.opts.preHandler;
      for (const h of Array.isArray(pre) ? pre : pre ? [pre] : []) { await h(req, rep); if (sent) return res; }
      const out = await route.handler(req, rep);
      if (!sent && out !== rep) res.body = out;
    } catch (err) {
      if (!errorHandler) throw err;
      await errorHandler(err, req, rep);
    } finally {
      for (const h of scope.onResponse) { try { await h(req, rep); } catch { /* ignore */ } }
    }
    return res;
  }

  return { app, dispatch };
}
