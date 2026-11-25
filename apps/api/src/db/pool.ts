import pg from "pg";
import { config } from "../config.ts";

// numeric → string by default in pg; parse numerics as JS numbers for quantities/money
// (values are bounded by numeric(18,x); amounts stay well within double precision).
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // bigint (counts, audit ids)

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20, idleTimeoutMillis: 30_000 });

export type Db = pg.Pool | pg.PoolClient;

export interface TxContext {
  userId?: string | null;
  onBehalfOf?: string | null;
  requestId?: string;
  ip?: string;
}

/**
 * Runs `fn` in a transaction with the request context set via SET LOCAL, so database
 * triggers can attribute every audit-trail row to the acting user.
 */
export async function withTx<T>(ctx: TxContext, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.user_id', $1, true), set_config('app.on_behalf_of', $2, true),
              set_config('app.request_id', $3, true), set_config('app.ip', $4, true)`,
      [ctx.userId ?? "", ctx.onBehalfOf ?? "", ctx.requestId ?? "", ctx.ip ?? ""]
    );
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function one<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await db.query(sql, params);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query(sql, params);
  return r.rows as T[];
}
