// In-process scheduler (single active runner across instances via a PostgreSQL advisory lock).
// Runs the material-request SLA sweep every minute. Disable with JOBS=off (tests).
import type { FastifyInstance } from "fastify";
import { pool } from "./db/pool.ts";
import { slaSweep } from "./services/requests.ts";

export function startScheduler(app: FastifyInstance) {
  if (process.env.JOBS === "off") return;
  const tick = async () => {
    const c = await pool.connect();
    try {
      const { rows } = await c.query("SELECT pg_try_advisory_lock(814202) AS ok");
      if (!rows[0].ok) return;
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.request_id', 'job:sla', true)");
        const n = await slaSweep(c);
        await c.query("COMMIT");
        if (n) app.log.info({ overdue: n }, "SLA sweep escalated requests");
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        app.log.error({ err: e }, "SLA sweep failed");
      } finally {
        await c.query("SELECT pg_advisory_unlock(814202)");
      }
    } finally {
      c.release();
    }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
}
