// node-postgres compatible facade over a single PGlite instance (Pool / Client / types).
// Requests are serialised by the demo dispatcher, so one connection is enough.
type Parser = (v: string) => unknown;
const parsers: Record<number, Parser> = {
  1082: (v) => new Date(`${v}T00:00:00`), // date → JS Date, like node-postgres
};
let db: any = null;

export function setDatabase(d: any) { db = d; }
export function getDatabase() { return db; }
export const pgParsers = () => parsers;

const ser = (v: unknown): unknown => {
  if (v === undefined) return null;
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(ser);
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
};

async function run(sql: string, params?: unknown[]) {
  if (!db) throw new Error("database not ready");
  if (params && params.length) {
    const r = await db.query(sql, params.map(ser));
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length, fields: r.fields };
  }
  const rs = await db.exec(sql);
  const last = rs[rs.length - 1] ?? { rows: [], affectedRows: 0 };
  return { rows: last.rows, rowCount: last.affectedRows ?? last.rows.length, fields: last.fields };
}

class PoolClient {
  query(sql: string, params?: unknown[]) { return run(sql, params); }
  release() {}
}

export class Pool {
  constructor(_opts?: unknown) {}
  query(sql: string, params?: unknown[]) { return run(sql, params); }
  async connect() { return new PoolClient(); }
  async end() {}
  on() { return this; }
}

export class Client extends PoolClient {
  constructor(_opts?: unknown) { super(); }
  async connect() {}
  async end() {}
}

export const types = { setTypeParser(oid: number, fn: Parser) { parsers[oid] = fn; } };
export const escapeIdentifier = (s: string) => `"${s.replace(/"/g, '""')}"`;
const pg = { Pool, Client, types, escapeIdentifier };
export default pg;
