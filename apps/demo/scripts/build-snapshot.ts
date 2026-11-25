// Builds the demo database snapshot: real migrations + real seeds (all phases) on PGlite, then dumps the
// PostgreSQL data directory (gzip) and the attachment store, for the browser demo to load instantly.
//   node --import tsx --import ./scripts/alias-register.mjs scripts/build-snapshot.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { setDatabase, pgParsers } from "../src/shims/pg.ts";
import { files } from "../src/shims/fs.ts";

process.env.JOBS = "off";
const t0 = Date.now();
await import("../../api/src/db/pool.ts"); // registers the numeric / bigint type parsers first
const db = await PGlite.create({ extensions: { pgcrypto, pg_trgm, citext }, parsers: pgParsers() });
setDatabase(db);
await db.exec("CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS citext;");

const { migrate } = await import("../../api/src/db/migrate.ts");
await migrate("pglite", "wms_app", console.log);
const { seed } = await import("../../api/seed/seed.ts");
await seed("pglite", console.log);

const check = (await db.query(`SELECT (SELECT sum(qty) FROM stock_ledger) = (SELECT sum(qty_on_hand) FROM stock_balance) AS qty_ok,
  (SELECT sum(value) FROM stock_ledger) = (SELECT sum(total_value) FROM item_valuation) AS value_ok,
  (SELECT first_broken_id FROM audit_verify()) IS NULL AS audit_ok, (SELECT count(*) FROM item)::int AS items`)).rows[0];
console.log("snapshot: integrity", check);
await db.exec("VACUUM ANALYZE");

const { config } = await import("../../api/src/config.ts");
const out = new URL("../dist-snapshot/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const dump = await db.dumpDataDir("gzip");
writeFileSync(out + "db.tar.gz", Buffer.from(await dump.arrayBuffer()));
const prefix = config.storageDir.replace(/\/+$/, "") + "/";
const store: Record<string, string> = {};
for (const [k, v] of files) store[k.startsWith(prefix) ? k.slice(prefix.length) : k] = Buffer.from(v).toString("base64");
writeFileSync(out + "files.json", JSON.stringify(store));
console.log(`snapshot: ${(dump.size / 1e6).toFixed(1)} MB database, ${files.size} files, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
await db.close();
