// Test harness: points the API at the test database, migrates + seeds it once, and offers
// a tiny cookie-aware client on top of fastify.inject (no network needed).
process.env.DATABASE_URL ??= "postgres://wms_app:wms_app_dev@localhost:5432/iarda_wms_test";
process.env.DATABASE_OWNER_URL ??= "postgres://wms_owner:wms_owner_dev@localhost:5432/iarda_wms_test";
process.env.LOGIN_RATE_LIMIT ??= "100000";
process.env.JOBS ??= "off";
process.env.STORAGE_DIR ??= new URL("../../../storage-test/", import.meta.url).pathname;

const { migrate } = await import("../src/db/migrate.ts");
const { seed, DEMO_PASSWORD } = await import("../seed/seed.ts");
const { buildServer } = await import("../src/server.ts");
const { pool } = await import("../src/db/pool.ts");

await migrate(process.env.DATABASE_OWNER_URL, "wms_app", () => {});
await seed(process.env.DATABASE_URL, () => {});

export const app = await buildServer({ logger: false });
export { pool, DEMO_PASSWORD };

export const uniq = () => Math.random().toString(36).slice(2, 8);

export interface Res { status: number; body: any }

export class Client {
  cookie = "";
  constructor(public username?: string) {}
  async req(method: string, url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const r = await app.inject({
      method: method as any, url, payload: payload as any,
      headers: { "x-requested-with": "iarda-wms", ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
    });
    const set = r.headers["set-cookie"];
    if (set) this.cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0];
    let body: any = r.body;
    try { body = r.json(); } catch { /* not json */ }
    return { status: r.statusCode, body };
  }
  get = (url: string) => this.req("GET", url);
  post = (url: string, body: unknown = {}) => this.req("POST", url, body);
  patch = (url: string, body: unknown) => this.req("PATCH", url, body);
  put = (url: string, body: unknown) => this.req("PUT", url, body);
  del = (url: string) => this.req("DELETE", url);
}

export async function login(username: string, password = DEMO_PASSWORD): Promise<Client> {
  const c = new Client(username);
  const r = await c.post("/api/auth/login", { username, password });
  if (r.status !== 200) throw new Error(`login ${username} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return c;
}

export async function lookups() {
  const q = (sql: string, p: unknown[] = []) => pool.query(sql, p).then((r) => r.rows);
  const groups = await q("SELECT id, code FROM item_category WHERE level = 'group'");
  const uoms = await q("SELECT id, code FROM uom");
  const whs = await q("SELECT id, code FROM warehouse");
  return {
    group: (code: string) => groups.find((g) => g.code === code)!.id as string,
    uom: (code: string) => uoms.find((u) => u.code === code)!.id as string,
    wh: (code: string) => whs.find((w) => w.code === code)!.id as string,
  };
}
