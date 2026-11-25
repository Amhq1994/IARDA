// Demo "server": the same route modules, session hook and error handling as apps/api/src/server.ts,
// mounted on the in-browser router. Background jobs run on a timer instead of the PostgreSQL-locked scheduler.
import { createApp } from "./app.ts";
import { config } from "../../../api/src/config.ts";
import { ApiError, fromPg } from "../../../api/src/lib/errors.ts";
import { loadUserFromSession } from "../../../api/src/auth/context.ts";
import { authRoutes } from "../../../api/src/auth/routes.ts";
import { itemRoutes } from "../../../api/src/modules/items.ts";
import { catalogRoutes } from "../../../api/src/modules/catalog.ts";
import { warehouseRoutes } from "../../../api/src/modules/warehouses.ts";
import { adminRoutes } from "../../../api/src/modules/admin.ts";
import { auditRoutes } from "../../../api/src/modules/audit.ts";
import { attachmentRoutes } from "../../../api/src/modules/attachments.ts";
import { dashboardRoutes } from "../../../api/src/modules/dashboard.ts";
import { inventoryRoutes } from "../../../api/src/modules/inventory.ts";
import { inboundRoutes } from "../../../api/src/modules/inbound.ts";
import { requestRoutes } from "../../../api/src/modules/requests.ts";
import { phase3Routes } from "../../../api/src/modules/phase3.ts";
import { phase4Routes } from "../../../api/src/modules/phase4.ts";
import { phase5Routes } from "../../../api/src/modules/phase5.ts";
import { integrationRoutes } from "../../../api/src/modules/integration.ts";
import { runJob } from "../../../api/src/jobs.ts";
import { slaSweep } from "../../../api/src/services/requests.ts";
import { dispatchEmails } from "../../../api/src/services/mailer.ts";
import { dispatchOutbox } from "../../../api/src/services/integrations.ts";
import { runAlerts } from "../../../api/src/services/alerts.ts";
import { snapshotKpis } from "../../../api/src/services/kpis.ts";
import { runPlanning } from "../../../api/src/services/planning.ts";
import { generateJournals } from "../../../api/src/services/valuation.ts";
import { runDueSchedules } from "../../../api/src/modules/phase5.ts";
import { pool } from "../../../api/src/db/pool.ts";

export async function buildDemoServer() {
  const { app, dispatch } = createApp();
  app.addHook("onRequest", async (req: any) => {
    req.user = (await loadUserFromSession(req.cookies[config.session.cookieName])) ?? undefined;
  });
  app.setErrorHandler((err: any, req: any, rep: any) => {
    const e = err instanceof ApiError ? err : fromPg(err);
    if (e) return rep.status(e.status).send({ error: { code: e.code, message_ar: e.messageAr, message_en: e.messageEn, details: e.details } });
    console.error(err);
    return rep.status(500).send({ error: { code: "internal", message_ar: "حدث خطأ غير متوقع", message_en: String(err?.message ?? "Unexpected error"), requestId: req.id } });
  });
  for (const r of [authRoutes, itemRoutes, catalogRoutes, warehouseRoutes, adminRoutes, auditRoutes, attachmentRoutes, dashboardRoutes, inventoryRoutes,
    inboundRoutes, requestRoutes, phase3Routes, phase4Routes, phase5Routes, integrationRoutes]) await app.register(r as any);
  app.get("/api/health", async () => ({ ok: true, demo: true }));

  const sys = async () => (await pool.query("SELECT id FROM app_user WHERE username = 'system'")).rows[0]?.id as string;
  const minute = async () => {
    const s = await sys();
    for (const [n, j] of [["sla", slaSweep], ["email", dispatchEmails], ["outbox", dispatchOutbox], ["reports", runDueSchedules]] as const) await runJob(null, n, j as any, s);
  };
  const nightly = async () => {
    const s = await sys();
    await runJob(null, "alerts", (c) => runAlerts(c), s);
    await runJob(null, "kpi_snapshot", (c) => snapshotKpis(c), s);
    await runJob(null, "planning", (c, u) => runPlanning(c, u, null), s);
    await runJob(null, "journals", (c, u) => generateJournals(c, u), s);
  };
  return { dispatch, minute, nightly };
}
