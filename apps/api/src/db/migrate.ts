// Applies SQL migrations in order as the schema owner, then (re)applies least-privilege
// grants for the runtime role. Idempotent: applied files are tracked in schema_migrations.
//   npm run db:migrate
import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "../config.ts";

const dir = fileURLToPath(new URL("./migrations/", import.meta.url));

export async function migrate(ownerUrl = config.ownerDatabaseUrl, appRole = config.appDbRole, log = console.log) {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map((await client.query("SELECT name, checksum FROM schema_migrations")).rows.map((r) => [r.name, r.checksum]));
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = readFileSync(dir + file, "utf8");
      const sum = createHash("sha256").update(sql).digest("hex");
      if (applied.has(file)) {
        if (applied.get(file) !== sum) throw new Error(`Migration ${file} was modified after being applied`);
        continue;
      }
      log(`migrate: applying ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, sum]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
      }
    }
    await applyGrants(client, appRole);
    log("migrate: up to date");
  } finally {
    await client.end();
  }
}

/** Runtime role: read/insert/update only. No DELETE/TRUNCATE anywhere; no writes to audit tables. */
async function applyGrants(client: pg.Client, role: string) {
  const exists = (await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount;
  if (!exists) return;
  const r = pg.escapeIdentifier(role);
  await client.query(`
    GRANT USAGE ON SCHEMA public TO ${r};
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${r};
    REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM ${r};
    REVOKE INSERT, UPDATE ON audit_log, schema_migrations FROM ${r};
    REVOKE UPDATE ON security_event FROM ${r};
    -- I-1: quantities change only through the SECURITY DEFINER posting functions
    DO $g$ BEGIN
      IF to_regclass('public.stock_ledger') IS NOT NULL THEN
        EXECUTE 'REVOKE INSERT, UPDATE ON stock_balance, stock_ledger, item_valuation, reservation FROM ${r}';
      END IF;
    END $g$;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${r};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${r};
  `);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().catch((e) => { console.error(e.message); process.exit(1); });
}
