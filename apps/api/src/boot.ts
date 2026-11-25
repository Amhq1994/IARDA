// Production entrypoint (Docker image, Render, internal server): prepare the database, migrate, optionally seed,
// then start the HTTP server. Safe to run on every start: every step is idempotent.
//
//   DATABASE_OWNER_URL  schema owner connection (on Render: the database's connection string)
//   DATABASE_URL        runtime connection. If unset, a least-privilege role (APP_DB_ROLE, default wms_app) is
//                       created with APP_DB_PASSWORD and used; if the database refuses CREATE ROLE, the owner
//                       connection is used and a warning is logged.
//   SEED_MODE           "demo" loads the demonstration data set once (testing only); anything else seeds nothing.
import pg from "pg";

const env = process.env;
const log = (m: string) => console.log(`boot: ${m}`);
const owner = env.DATABASE_OWNER_URL || env.DATABASE_URL;
if (!owner) {
  console.error("boot: set DATABASE_OWNER_URL (or DATABASE_URL) to the PostgreSQL connection string");
  process.exit(1);
}
env.DATABASE_OWNER_URL = owner;
const role = env.APP_DB_ROLE || "wms_app";

async function prepare() {
  const c = new pg.Client({ connectionString: owner });
  await c.connect();
  try {
    for (const ext of ["pgcrypto", "pg_trgm", "citext"]) {
      try { await c.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`); }
      catch (e) { log(`extension ${ext}: ${(e as Error).message}`); }
    }
    if (env.DATABASE_URL && env.DATABASE_URL !== owner) return;
    const pw = env.APP_DB_PASSWORD;
    if (pw) {
      try {
        const id = pg.escapeIdentifier(role), lit = c.escapeLiteral(pw);
        const exists = (await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount;
        await c.query(exists ? `ALTER ROLE ${id} WITH LOGIN PASSWORD ${lit}` : `CREATE ROLE ${id} LOGIN PASSWORD ${lit}`);
        const db = (await c.query("SELECT current_database() AS d")).rows[0].d;
        await c.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(db)} TO ${id}`);
        const u = new URL(owner!);
        u.username = role; u.password = encodeURIComponent(pw);
        env.DATABASE_URL = u.toString();
        log(`runtime connects as least-privilege role ${role}`);
        return;
      } catch (e) {
        log(`could not create role ${role} (${(e as Error).message})`);
      }
    }
    env.DATABASE_URL = owner;
    log("WARNING: runtime uses the owner connection; least-privilege grants are not enforced on this database");
  } finally {
    await c.end();
  }
}

await prepare();
const { migrate } = await import("./db/migrate.ts");
await migrate(owner, role, (m) => console.log(m));
if (env.SEED_MODE === "demo") {
  const { seed } = await import("../seed/seed.ts");
  await seed(env.DATABASE_URL!, (m) => console.log(m));
}
await import("./index.ts");
