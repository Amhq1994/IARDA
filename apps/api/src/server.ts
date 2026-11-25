import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { config } from "./config.ts";
import { ApiError, fromPg } from "./lib/errors.ts";
import { loadUserFromSession } from "./auth/context.ts";
import { authRoutes } from "./auth/routes.ts";
import { itemRoutes } from "./modules/items.ts";
import { catalogRoutes } from "./modules/catalog.ts";
import { warehouseRoutes } from "./modules/warehouses.ts";
import { adminRoutes } from "./modules/admin.ts";
import { auditRoutes } from "./modules/audit.ts";
import { attachmentRoutes } from "./modules/attachments.ts";
import { dashboardRoutes } from "./modules/dashboard.ts";
import { inventoryRoutes } from "./modules/inventory.ts";
import { inboundRoutes } from "./modules/inbound.ts";
import { requestRoutes } from "./modules/requests.ts";
import { startScheduler } from "./jobs.ts";
import { phase3Routes } from "./modules/phase3.ts";
import { phase4Routes } from "./modules/phase4.ts";
import { phase5Routes } from "./modules/phase5.ts";
import { integrationRoutes } from "./modules/integration.ts";

export async function buildServer(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? (config.isProd ? { level: "info" } : { level: "warn" }),
    genReqId: () => randomUUID(),
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    ajv: { customOptions: { strict: false } },
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], imgSrc: ["'self'", "data:", "blob:"], styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"], connectSrc: ["'self'"], fontSrc: ["'self'", "data:"], frameAncestors: ["'none'"],
      },
    },
    hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: "1 minute" });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
  await app.register(swagger, {
    openapi: {
      info: { title: "IARDA WMS API", version: "1.0.0", description: "Warehouse Management & Inventory Control System — REST API" },
      tags: [{ name: "auth" }, { name: "items" }, { name: "catalog" }, { name: "warehouses" }, { name: "inventory" }, { name: "inbound" }, { name: "requests" }, { name: "transfers" }, { name: "returns" }, { name: "counting" }, { name: "approvals" },
        { name: "planning" }, { name: "valuation" }, { name: "custody" }, { name: "reports" }, { name: "integration", description: "Machine-to-machine API (x-api-key)" },
        { name: "admin" }, { name: "audit" }],
      components: { securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "x-api-key" }, session: { type: "apiKey", in: "cookie", name: "wms_session" } } },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/api/docs" });

  // session → req.user
  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/api/")) return;
    req.user = (await loadUserFromSession(req.cookies[config.session.cookieName])) ?? undefined;
  });

  // CSRF defence in depth (cookie is SameSite=Strict): state-changing calls must carry the API header.
  app.addHook("preHandler", async (req) => {
    if (!req.url.startsWith("/api/") || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    if (req.url.startsWith("/api/integration/")) return; // machine clients: API key, no cookie (CSRF does not apply)
    if (req.headers["x-requested-with"] !== "iarda-wms") {
      throw new ApiError(403, "csrf", "طلب غير موثوق", "Missing X-Requested-With header");
    }
  });

  app.setErrorHandler((err: any, req, rep) => {
    const e = err instanceof ApiError ? err : fromPg(err);
    if (e) {
      return rep.status(e.status).send({ error: { code: e.code, message_ar: e.messageAr, message_en: e.messageEn, details: e.details } });
    }
    if (err.statusCode === 429) {
      return rep.status(429).send({ error: { code: "rate_limited", message_ar: "طلبات كثيرة، حاول لاحقاً", message_en: "Too many requests" } });
    }
    if (err.validation) {
      return rep.status(422).send({ error: { code: "validation_failed", message_ar: "البيانات المدخلة غير صحيحة", message_en: err.message } });
    }
    req.log.error({ err }, "unhandled error");
    return rep.status(500).send({ error: { code: "internal", message_ar: "حدث خطأ غير متوقع", message_en: "Unexpected error", requestId: req.id } });
  });

  await app.register(authRoutes);
  await app.register(itemRoutes);
  await app.register(catalogRoutes);
  await app.register(warehouseRoutes);
  await app.register(adminRoutes);
  await app.register(auditRoutes);
  await app.register(attachmentRoutes);
  await app.register(dashboardRoutes);
  await app.register(inventoryRoutes);
  await app.register(inboundRoutes);
  await app.register(requestRoutes);
  await app.register(phase3Routes);
  await app.register(phase4Routes);
  await app.register(phase5Routes);
  await app.register(integrationRoutes);
  startScheduler(app);

  app.get("/api/health", { schema: { hide: true } }, async () => ({ ok: true }));

  // Serve the built web app (SPA) and brand assets from the same origin.
  const brandDir = new URL("../../../brand/", import.meta.url).pathname;
  await app.register(fastifyStatic, { root: brandDir, prefix: "/brand/", decorateReply: false });
  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: "/", wildcard: true, index: false });
    app.get("/", { schema: { hide: true } }, (_req, rep) => rep.header("cache-control", "no-cache").sendFile("index.html"));
    app.setNotFoundHandler((req, rep) => {
      // API calls and missing files (anything with an extension) get a real 404; app routes get the SPA shell
      if (req.url.startsWith("/api/") || /\.[a-z0-9]{2,5}(\?|$)/i.test(req.url)) {
        return rep.status(404).send({ error: { code: "not_found", message_ar: "غير موجود", message_en: "Not found" } });
      }
      return rep.header("cache-control", "no-cache").sendFile("index.html");
    });
  }
  return app;
}
