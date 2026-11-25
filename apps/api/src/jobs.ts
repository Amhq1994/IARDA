// In-process scheduler (single active runner across instances via a PostgreSQL advisory lock).
//   every minute : request SLA sweep · e-mail dispatch · integration outbox dispatch · due scheduled reports
//   nightly      : stock alerts · KPI snapshot · planning run (+ auto requisitions when enabled) · journal generation
// Disable with JOBS=off (tests). Each job runs in its own transaction, as the "system" user, so one failure never blocks the others.
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { pool } from "./db/pool.ts";
import { slaSweep } from "./services/requests.ts";
import { dispatchEmails } from "./services/mailer.ts";
import { dispatchOutbox } from "./services/integrations.ts";
import { runAlerts } from "./services/alerts.ts";
import { snapshotKpis } from "./services/kpis.ts";
import { runPlanning, prsFromRun } from "./services/planning.ts";
import { generateJournals } from "./services/valuation.ts";
import { runDueSchedules } from "./modules/phase5.ts";
import { setting } from "./services/common.ts";

type Job = (c: pg.PoolClient, systemUserId: string) => Promise<unknown>;

const MINUTE: [string, Job][] = [
  ["sla", (c) => slaSweep(c)],
  ["email", (c) => dispatchEmails(c)],
  ["outbox", (c) => dispatchOutbox(c)],
  ["reports", (c) => runDueSchedules(c)],
];
const NIGHTLY: [string, Job][] = [
  ["alerts", (c) => runAlerts(c)],
  ["kpi_snapshot", (c) => snapshotKpis(c)],
  ["planning", async (c, sys) => {
    const run = await runPlanning(c, sys, null);
    if ((await setting(c, "planning.auto_pr", false)) === true) return prsFromRun(c, sys, run.id);
    return run.run_no;
  }],
  ["journals", (c, sys) => generateJournals(c, sys, new Date(new Date().toISOString().slice(0, 10) + "T00:00:00+03:00").toISOString())],
];

export async function runJob(app: FastifyInstance | null, name: string, job: Job, sys: string) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.user_id', $1, true), set_config('app.request_id', $2, true)", [sys, `job:${name}`]);
    const out = await job(c, sys);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    app?.log.error({ err: e, job: name }, "scheduled job failed");
    return null;
  } finally {
    c.release();
  }
}

export function startScheduler(app: FastifyInstance) {
  if (process.env.JOBS === "off") return;
  let sys: string | null = null;
  const tick = async () => {
    const c = await pool.connect();
    let locked = false;
    try {
      locked = (await c.query("SELECT pg_try_advisory_lock(814202) AS ok")).rows[0].ok;
      if (!locked) return;
      sys ??= (await c.query("SELECT id FROM app_user WHERE username = 'system'")).rows[0]?.id ?? null;
      if (!sys) return;
      for (const [name, job] of MINUTE) await runJob(app, name, job, sys);
      // nightly jobs: once per Riyadh day, after 01:00
      const riyadh = new Date(Date.now() + 3 * 3600e3);
      if (riyadh.getUTCHours() >= 1) {
        const day = riyadh.toISOString().slice(0, 10);
        const first = (await c.query("INSERT INTO alert_log (alert_key, alert_date) VALUES ('nightly_jobs', $1) ON CONFLICT DO NOTHING", [day])).rowCount === 1;
        if (first) for (const [name, job] of NIGHTLY) await runJob(app, name, job, sys);
      }
    } catch (e) {
      app.log.error({ err: e }, "scheduler tick failed");
    } finally {
      if (locked) await c.query("SELECT pg_advisory_unlock(814202)").catch(() => {});
      c.release();
    }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
}
