import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { readFileSync, readdirSync } from "node:fs";
const db = await PGlite.create({ extensions: { pgcrypto, pg_trgm, citext } });
console.log((await db.query("select version(), current_user, session_user")).rows[0]);
await db.exec("CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS citext;");
const dir = "../api/src/db/migrations";
for (const f of readdirSync(dir).sort()) {
  const t = Date.now();
  try { await db.exec(readFileSync(`${dir}/${f}`, "utf8")); console.log("ok", f, Date.now() - t, "ms"); }
  catch (e) { console.log("FAIL", f, e.message); break; }
}
console.log((await db.query("select count(*) from pg_tables where schemaname='public'")).rows);
