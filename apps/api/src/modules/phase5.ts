// KPIs, reports & schedules, notification preferences, admin consoles (integrations, outbox, e-mail),
// supplier portal status pages, bin / lot labels (print + ZPL), readiness probe.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pool, one, many, withTx } from "../db/pool.ts";
import { E } from "../lib/errors.ts";
import { parse, uuid, idParam } from "../lib/http.ts";
import { requirePerm, requireAuth, txCtx, warehouseScope, can, hasRole, type AuthUser } from "../auth/context.ts";
import type { Permission } from "@iarda/shared";
import { config } from "../config.ts";
import { encryptBlob, sha256 } from "../lib/crypto.ts";
import { kpiBoard, snapshotKpis } from "../services/kpis.ts";
import { REPORTS, reportDef, canRun, renderReport, nextRun, MIME, type Format } from "../services/reports.ts";
import { createClient, SCOPES } from "../services/integrations.ts";
import { notify, type Tx } from "../services/common.ts";

function scopeFor(u: AuthUser, perms: Permission[]): "all" | string[] {
  let acc: string[] = [];
  for (const p of perms) {
    if (!u.permissions.has(p)) continue;
    const s = warehouseScope(u, p);
    if (s === "all") return "all";
    acc = [...acc, ...s];
  }
  return acc.length ? acc : "all";
}
const reportScope = (u: AuthUser) => (u.permissions.has("warehouse.read") ? scopeFor(u, ["warehouse.read"]) : "all");

const reportParams = z.object({ warehouseId: uuid.optional(), planId: uuid.optional(), runId: uuid.optional(),
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(), days: z.coerce.number().int().min(1).max(730).optional() });

/** Generates a report, stores it (encrypted) as an attachment of a report_run, and returns the run. */
export async function runAndStore(c: Tx, b: { code: string; params: Record<string, unknown>; format: Format; lang: "ar" | "en"; scope: "all" | string[];
  userId: string | null; scheduleId?: string | null }) {
  const t0 = Date.now();
  try {
    const buf = await renderReport(c, b.code, b.params as any, b.scope, b.format, b.lang);
    const run = await one(c, `INSERT INTO report_run (schedule_id, report_code, params, format, lang, status, size_bytes, duration_ms, created_by)
                              VALUES ($1,$2,$3,$4,$5,'ok',$6,$7,$8) RETURNING *`,
      [b.scheduleId ?? null, b.code, JSON.stringify(b.params), b.format, b.lang, buf.length, Date.now() - t0, b.userId]);
    const digest = sha256(buf);
    const key = `report_run/${digest.slice(0, 2)}/${digest}-${run.id}.bin`;
    await mkdir(join(config.storageDir, "report_run", digest.slice(0, 2)), { recursive: true });
    await writeFile(join(config.storageDir, key), encryptBlob(buf));
    const att = await one(c, `INSERT INTO attachment (owner_type, owner_id, category, file_name, mime_type, size_bytes, sha256, storage_key)
                              VALUES ('report_run',$1,'report',$2,$3,$4,$5,$6) RETURNING id`,
      [run.id, `${b.code}-${new Date().toISOString().slice(0, 10)}.${b.format}`, MIME[b.format], buf.length, digest, key]);
    await c.query("UPDATE report_run SET attachment_id = $2 WHERE id = $1", [run.id, att.id]);
    return { ...run, attachment_id: att.id };
  } catch (e: any) {
    await c.query(`INSERT INTO report_run (schedule_id, report_code, params, format, lang, status, error, duration_ms, created_by) VALUES ($1,$2,$3,$4,$5,'failed',$6,$7,$8)`,
      [b.scheduleId ?? null, b.code, JSON.stringify(b.params), b.format, b.lang, String(e?.message ?? e).slice(0, 500), Date.now() - t0, b.userId]);
    throw e;
  }
}

/** Scheduler: runs every due schedule, notifies recipients with a download link. */
export async function runDueSchedules(c: Tx) {
  let n = 0;
  for (const s of await many(c, "SELECT * FROM report_schedule WHERE is_active AND deleted_at IS NULL AND next_run_at <= now() FOR UPDATE SKIP LOCKED LIMIT 10")) {
    const def = reportDef(s.report_code);
    await c.query("UPDATE report_schedule SET last_run_at = now(), next_run_at = $2 WHERE id = $1", [s.id, nextRun(s)]);
    if (!def) continue;
    await c.query("SAVEPOINT rs");
    try {
      const run = await runAndStore(c, { code: s.report_code, params: s.params, format: s.format, lang: s.lang, scope: "all", userId: s.created_by, scheduleId: s.id });
      await notify(c, s.recipient_ids, { kind: "report_ready", titleAr: `تقرير مجدول جاهز: ${def.title.ar}`, titleEn: `Scheduled report ready: ${def.title.en}`,
        bodyAr: s.name, bodyEn: s.name, link: `/api/attachments/${run.attachment_id}/content` });
      await c.query("RELEASE SAVEPOINT rs");
      n++;
    } catch {
      await c.query("ROLLBACK TO SAVEPOINT rs");
    }
  }
  return n;
}

export async function phase5Routes(app: FastifyInstance) {
  app.get("/api/ready", { schema: { tags: ["admin"], summary: "Readiness: database reachable and migrated" } }, async (_req, rep) => {
    try {
      const r = await one(pool, "SELECT count(*)::int AS migrations, now() AS db_time FROM schema_migrations");
      return { ok: true, ...r };
    } catch {
      return rep.status(503).send({ ok: false });
    }
  });

  // ================================================================ KPIs
  app.get("/api/kpis", { preHandler: requirePerm("dashboard.view", "report.view"), schema: { tags: ["reports"], summary: "KPI board with targets and 6-month trend" } }, async (req) => {
    const q = parse(z.object({ warehouseId: uuid.optional() }), req.query);
    const s = reportScope(req.user!);
    if (q.warehouseId && s !== "all" && !s.includes(q.warehouseId)) throw E.outOfScope();
    return { data: await kpiBoard(pool, q.warehouseId ? [q.warehouseId] : s) };
  });
  app.post("/api/kpis/snapshot", { preHandler: requirePerm("admin.settings"), schema: { tags: ["reports"] } }, async (req) => {
    await withTx(txCtx(req), (c) => snapshotKpis(c));
    return { ok: true };
  });

  // ================================================================ reports
  app.get("/api/reports", { preHandler: requirePerm("report.view", "report.export"), schema: { tags: ["reports"] } }, async (req) => ({
    data: REPORTS.filter((r) => canRun(req.user!, r)).map((r) => ({ code: r.code, title: r.title, description: r.description, params: r.params })),
    canExport: can(req.user!, "report.export"),
  }));
  app.get("/api/reports/:code/download", { preHandler: requirePerm("report.view", "report.export"), schema: { tags: ["reports"], summary: "Render a report (PDF / Excel / PowerPoint)" } },
    async (req, rep) => {
      const { code } = parse(z.object({ code: z.string().max(40) }), req.params);
      const q = parse(reportParams.extend({ format: z.enum(["pdf", "xlsx", "pptx"]).default("pdf"), lang: z.enum(["ar", "en"]).default("ar") }), req.query);
      const def = reportDef(code);
      if (!def) throw E.notFound("report");
      if (!canRun(req.user!, def)) throw E.forbidden(def.perms.join("|"));
      // editable data exports need report.export; PDF reading needs report.view
      if (q.format !== "pdf" && !can(req.user!, "report.export")) throw E.forbidden("report.export");
      const { format, lang, ...params } = q;
      const run = await withTx(txCtx(req), (c) => runAndStore(c, { code, params, format, lang, scope: reportScope(req.user!), userId: req.user!.id }));
      const att = await one(pool, "SELECT * FROM attachment WHERE id = $1", [run.attachment_id]);
      const { readFile } = await import("node:fs/promises");
      const { decryptBlob } = await import("../lib/crypto.ts");
      const data = decryptBlob(await readFile(join(config.storageDir, att.storage_key)));
      rep.header("content-type", MIME[format]).header("cache-control", "no-store")
        .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(att.file_name)}`);
      return rep.send(data);
    });
  app.get("/api/report-runs", { preHandler: requirePerm("report.view", "report.export"), schema: { tags: ["reports"] } }, async (req) => ({
    data: await many(pool, `SELECT r.*, s.name AS schedule_name, u.name_ar AS by_ar, u.name_en AS by_en FROM report_run r LEFT JOIN report_schedule s ON s.id = r.schedule_id
      LEFT JOIN app_user u ON u.id = r.created_by WHERE r.created_by = $1 OR $1 = ANY(s.recipient_ids) OR $2 ORDER BY r.created_at DESC LIMIT 100`,
      [req.user!.id, can(req.user!, "audit.read")]),
  }));
  const schedBody = z.object({ name: z.string().trim().min(3).max(120), reportCode: z.string().max(40), params: reportParams.default({}),
    format: z.enum(["pdf", "xlsx", "pptx"]), lang: z.enum(["ar", "en"]).default("ar"), frequency: z.enum(["daily", "weekly", "monthly"]),
    weekday: z.number().int().min(0).max(6).nullable().optional(), monthday: z.number().int().min(1).max(28).nullable().optional(),
    hour: z.number().int().min(0).max(23).default(6), recipientIds: z.array(uuid).min(1).max(50) });
  app.get("/api/report-schedules", { preHandler: requirePerm("report.export"), schema: { tags: ["reports"] } }, async () => ({
    data: await many(pool, `SELECT s.*, (SELECT count(*)::int FROM report_run r WHERE r.schedule_id = s.id) AS runs,
        (SELECT array_agg(coalesce(u.name_ar, '')) FROM app_user u WHERE u.id = ANY(s.recipient_ids)) AS recipients_ar,
        (SELECT array_agg(coalesce(u.name_en, '')) FROM app_user u WHERE u.id = ANY(s.recipient_ids)) AS recipients_en
      FROM report_schedule s WHERE s.deleted_at IS NULL ORDER BY s.created_at DESC`),
  }));
  app.post("/api/report-schedules", { preHandler: requirePerm("report.export"), schema: { tags: ["reports"] } }, async (req, rep) => {
    const b = parse(schedBody, req.body);
    const def = reportDef(b.reportCode);
    if (!def || !canRun(req.user!, def)) throw E.invalid([{ path: "reportCode", message: "unknown_or_forbidden" }]);
    const s = { frequency: b.frequency, weekday: b.weekday ?? 0, monthday: b.monthday ?? 1, hour: b.hour };
    const out = await withTx(txCtx(req), (c) => one(c, `INSERT INTO report_schedule (name, report_code, params, format, lang, frequency, weekday, monthday, hour, recipient_ids, next_run_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [b.name, b.reportCode, JSON.stringify(b.params), b.format, b.lang, b.frequency,
      b.frequency === "weekly" ? s.weekday : null, b.frequency === "monthly" ? s.monthday : null, b.hour, b.recipientIds, nextRun(s)]));
    rep.status(201); return out;
  });
  app.post("/api/report-schedules/:id/toggle", { preHandler: requirePerm("report.export"), schema: { tags: ["reports"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return withTx(txCtx(req), (c) => one(c, "UPDATE report_schedule SET is_active = NOT is_active WHERE id = $1 AND deleted_at IS NULL RETURNING id, is_active", [id]));
  });
  app.post("/api/report-schedules/:id/delete", { preHandler: requirePerm("report.export"), schema: { tags: ["reports"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    await withTx(txCtx(req), (c) => c.query("UPDATE report_schedule SET deleted_at = now(), deleted_by = $2, is_active = false WHERE id = $1", [id, req.user!.id]));
    return { ok: true };
  });
  app.post("/api/report-schedules/:id/run", { preHandler: requirePerm("report.export"), schema: { tags: ["reports"], summary: "Run a schedule now" } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return withTx(txCtx(req), async (c) => {
      const s = await one(c, "SELECT * FROM report_schedule WHERE id = $1 AND deleted_at IS NULL", [id]);
      if (!s) throw E.notFound("schedule");
      const run = await runAndStore(c, { code: s.report_code, params: s.params, format: s.format, lang: s.lang, scope: "all", userId: req.user!.id, scheduleId: s.id });
      const def = reportDef(s.report_code)!;
      await notify(c, s.recipient_ids, { kind: "report_ready", titleAr: `تقرير جاهز: ${def.title.ar}`, titleEn: `Report ready: ${def.title.en}`, bodyAr: s.name, bodyEn: s.name,
        link: `/api/attachments/${run.attachment_id}/content` });
      return run;
    });
  });
  app.get("/api/recipients", { preHandler: requirePerm("report.export"), schema: { tags: ["reports"] } }, async () => ({
    data: await many(pool, `SELECT u.id, u.name_ar, u.name_en, o.name_ar AS org_ar, o.name_en AS org_en FROM app_user u LEFT JOIN org_unit o ON o.id = u.org_unit_id
      WHERE u.status = 'active' AND u.deleted_at IS NULL AND u.supplier_id IS NULL AND u.username NOT LIKE 'integration.%' ORDER BY u.name_ar`),
  }));

  // ================================================================ my notification preferences
  app.get("/api/me/preferences", { preHandler: requireAuth, schema: { tags: ["auth"] } }, async (req) =>
    one(pool, "SELECT notify_email, email FROM app_user WHERE id = $1", [req.user!.id]));
  app.post("/api/me/preferences", { preHandler: requireAuth, schema: { tags: ["auth"] } }, async (req) => {
    const b = parse(z.object({ notifyEmail: z.boolean() }), req.body);
    await withTx(txCtx(req), (c) => c.query("UPDATE app_user SET notify_email = $2 WHERE id = $1", [req.user!.id, b.notifyEmail]));
    return { ok: true };
  });

  // ================================================================ admin: integrations, outbox, e-mail
  app.get("/api/admin/integrations", { preHandler: requirePerm("admin.settings", "audit.read"), schema: { tags: ["integration"] } }, async () => ({
    scopes: SCOPES,
    clients: await many(pool, `SELECT c.id, c.name, c.system, c.key_prefix, c.scopes, c.allowed_ips, c.is_active, c.last_used_at, c.created_at,
        (SELECT count(*)::int FROM integration_call k WHERE k.client_id = c.id AND k.at > now() - interval '24 hours') AS calls_24h
      FROM integration_client c ORDER BY c.created_at DESC`),
    outbox: await many(pool, "SELECT system, status, count(*)::int AS n FROM integration_outbox GROUP BY 1, 2 ORDER BY 1, 2"),
  }));
  app.post("/api/admin/integrations", { preHandler: requirePerm("admin.settings"), schema: { tags: ["integration"], summary: "Create an API client (key shown once)" } }, async (req, rep) => {
    const b = parse(z.object({ name: z.string().trim().min(3).max(80), system: z.enum(["erp", "etimad", "cmms", "hr", "other"]), scopes: z.array(z.enum(SCOPES)).min(1),
      allowedIps: z.array(z.string().max(45)).max(20).nullable().optional() }), req.body);
    const out = await withTx(txCtx(req), (c) => createClient(c, req.user!.id, b));
    rep.status(201); return out;
  });
  app.post("/api/admin/integrations/:id/toggle", { preHandler: requirePerm("admin.settings"), schema: { tags: ["integration"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return withTx(txCtx(req), (c) => one(c, "UPDATE integration_client SET is_active = NOT is_active WHERE id = $1 RETURNING id, is_active", [id]));
  });
  app.get("/api/admin/integrations/outbox", { preHandler: requirePerm("admin.settings", "audit.read"), schema: { tags: ["integration"] } }, async (req) => {
    const q = parse(z.object({ status: z.enum(["pending", "delivered", "failed", "stub"]).optional(), system: z.string().max(20).optional() }), req.query);
    return { data: await many(pool, `SELECT id, system, event, doc_type, doc_no, status, attempts, last_error, created_at, delivered_at, payload FROM integration_outbox
      WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR system = $2) ORDER BY id DESC LIMIT 200`, [q.status ?? null, q.system ?? null]) };
  });
  app.post("/api/admin/integrations/outbox/:id/retry", { preHandler: requirePerm("admin.settings"), schema: { tags: ["integration"] } }, async (req) => {
    const { id } = parse(z.object({ id: z.coerce.number().int() }), req.params);
    await withTx(txCtx(req), (c) => c.query("UPDATE integration_outbox SET status = 'pending', attempts = 0, last_error = NULL WHERE id = $1 AND status IN ('failed','stub')", [id]));
    return { ok: true };
  });
  app.get("/api/admin/integrations/calls", { preHandler: requirePerm("admin.settings", "audit.read"), schema: { tags: ["integration"] } }, async () => ({
    data: await many(pool, `SELECT k.*, c.name FROM integration_call k LEFT JOIN integration_client c ON c.id = k.client_id ORDER BY k.id DESC LIMIT 200`),
  }));
  app.get("/api/admin/emails", { preHandler: requirePerm("admin.settings", "audit.read"), schema: { tags: ["admin"] } }, async () => ({
    smtp: !!process.env.SMTP_URL,
    summary: await many(pool, "SELECT status, count(*)::int AS n FROM email_outbox GROUP BY 1"),
    data: await many(pool, "SELECT id, to_email, subject, kind, status, attempts, last_error, created_at, sent_at FROM email_outbox ORDER BY created_at DESC LIMIT 100"),
  }));
  app.get("/api/admin/emails/:id/preview", { preHandler: requirePerm("admin.settings"), schema: { tags: ["admin"] } }, async (req, rep) => {
    const { id } = parse(idParam, req.params);
    const m = await one(pool, "SELECT html FROM email_outbox WHERE id = $1", [id]);
    if (!m) throw E.notFound("email");
    rep.header("content-type", "text/html; charset=utf-8").header("content-security-policy", "default-src 'none'; img-src * data:; style-src 'unsafe-inline'");
    return rep.send(m.html);
  });

  // ================================================================ supplier portal: deliveries & invoices
  const portalSupplier = (u: AuthUser, supplierId?: string) => {
    if (hasRole(u, "SUP")) return u.supplierId;
    if (!can(u, "po.read")) throw E.forbidden("po.read");
    return supplierId ?? null;
  };
  app.get("/api/portal/deliveries", { preHandler: requirePerm("asn.read", "po.read"), schema: { tags: ["inbound"], summary: "Supplier portal: ASN and receiving status" } }, async (req) => {
    const q = parse(z.object({ supplierId: uuid.optional() }), req.query);
    const sid = portalSupplier(req.user!, q.supplierId);
    return { data: await many(pool, `SELECT po.po_no, po.etimad_ref, po.status AS po_status, a.asn_no, a.status AS asn_status, a.expected_at, r.receipt_no, r.status AS receipt_status,
        r.arrived_at, r.grn_no, r.grn_posted_at, r.putaway_completed_at, w.code AS warehouse_code, s.name_ar AS supplier_ar, s.name_en AS supplier_en,
        (SELECT coalesce(sum(rl.qty_accepted), 0) FROM receipt_line rl WHERE rl.receipt_id = r.id) AS qty_accepted,
        (SELECT coalesce(sum(rl.qty_rejected), 0) FROM receipt_line rl WHERE rl.receipt_id = r.id) AS qty_rejected
      FROM purchase_order po JOIN supplier s ON s.id = po.supplier_id JOIN warehouse w ON w.id = po.warehouse_id
      LEFT JOIN asn a ON a.po_id = po.id LEFT JOIN receipt r ON r.po_id = po.id AND (a.id IS NULL OR r.asn_id IS NULL OR r.asn_id = a.id)
      WHERE ($1::uuid IS NULL OR po.supplier_id = $1) ORDER BY coalesce(r.arrived_at, a.expected_at, po.created_at) DESC LIMIT 200`, [sid]) };
  });
  app.get("/api/portal/invoices", { preHandler: requirePerm("asn.read", "po.read", "invoice.manage"), schema: { tags: ["inbound"], summary: "Supplier portal: invoice and payment status" } }, async (req) => {
    const q = parse(z.object({ supplierId: uuid.optional() }), req.query);
    const sid = portalSupplier(req.user!, q.supplierId);
    return { data: await many(pool, `SELECT i.invoice_no, i.invoice_date, i.amount_excl_vat, i.vat_amount, i.amount_excl_vat + i.vat_amount AS total_amount, i.status, i.match_result, po.po_no, s.name_ar AS supplier_ar, s.name_en AS supplier_en, i.created_at
      FROM supplier_invoice i JOIN purchase_order po ON po.id = i.po_id JOIN supplier s ON s.id = po.supplier_id
      WHERE ($1::uuid IS NULL OR po.supplier_id = $1) ORDER BY i.created_at DESC LIMIT 200`, [sid]) };
  });

  // ================================================================ labels (bins, lots) — printable sheet data + Zebra ZPL
  const binsQ = z.object({ warehouseId: uuid, zoneId: uuid.optional(), codes: z.string().max(4000).optional() });
  async function bins(req: any) {
    const q = parse(binsQ, req.query);
    const s = scopeFor(req.user!, ["warehouse.read"]);
    if (s !== "all" && !s.includes(q.warehouseId)) throw E.outOfScope();
    return many(pool, `SELECT l.id, l.full_code, l.barcode, l.name_ar, l.name_en, z.name_ar AS zone_ar, z.name_en AS zone_en, w.code AS warehouse_code
      FROM location l JOIN location r ON r.id = l.parent_id JOIN location a ON a.id = r.parent_id JOIN location z ON z.id = a.parent_id JOIN warehouse w ON w.id = l.warehouse_id
      WHERE l.warehouse_id = $1 AND l.level = 'bin' AND l.deleted_at IS NULL AND ($2::uuid IS NULL OR z.id = $2)
        AND ($3::text[] IS NULL OR l.full_code = ANY($3)) ORDER BY l.full_code LIMIT 2000`,
      [q.warehouseId, q.zoneId ?? null, q.codes ? q.codes.split(",").map((x) => x.trim().toUpperCase()) : null]);
  }
  app.get("/api/labels/bins", { preHandler: requirePerm("warehouse.read"), schema: { tags: ["warehouses"], summary: "Bin labels (for the print sheet)" } }, async (req) => ({ data: await bins(req) }));
  const zplEsc = (s: string) => s.replace(/[\^~\\]/g, " ");
  app.get("/api/labels/bins.zpl", { preHandler: requirePerm("warehouse.read"), schema: { tags: ["warehouses"], summary: "Bin labels as Zebra ZPL (4×2 in, 203 dpi)" } }, async (req, rep) => {
    const zpl = (await bins(req)).map((b) => `^XA^CI28^PW812^LL406
^FO30,25^A0N,34,34^FD${zplEsc(b.warehouse_code)}  ${zplEsc(b.full_code)}^FS
^FO30,80^BY3,3,170^BCN,170,Y,N,N^FD${zplEsc(b.barcode ?? b.full_code)}^FS
^FO620,40^BQN,2,6^FDLA,${zplEsc(b.barcode ?? b.full_code)}^FS
^XZ`).join("\n");
    rep.header("content-type", "text/plain; charset=utf-8").header("content-disposition", "attachment; filename=bin-labels.zpl");
    return rep.send(zpl);
  });
  const lotsQ = z.object({ receiptId: uuid.optional(), itemId: uuid.optional() });
  async function lots(req: any) {
    const q = parse(lotsQ, req.query);
    if (!q.receiptId && !q.itemId) throw E.invalid([{ path: "receiptId", message: "receiptId_or_itemId" }]);
    return many(pool, `SELECT DISTINCT sl.id, sl.lot_no, sl.serial_no, sl.expiry_date, sl.mfg_date, i.item_code, i.name_ar, i.name_en, coalesce(ii.value, i.item_code) AS barcode
      FROM stock_lot sl JOIN item i ON i.id = sl.item_id LEFT JOIN item_identifier ii ON ii.item_id = i.id AND ii.is_primary AND ii.deleted_at IS NULL
      WHERE ($1::uuid IS NULL OR sl.id IN (SELECT rl.lot_id FROM receipt_line rl WHERE rl.receipt_id = $1 AND rl.lot_id IS NOT NULL)
                               OR sl.source_doc = (SELECT grn_no FROM receipt WHERE id = $1))
        AND ($2::uuid IS NULL OR sl.item_id = $2) ORDER BY i.item_code, sl.lot_no NULLS LAST, sl.serial_no LIMIT 2000`, [q.receiptId ?? null, q.itemId ?? null]);
  }
  app.get("/api/labels/lots", { preHandler: requirePerm("item.read"), schema: { tags: ["inventory"], summary: "Lot / serial labels" } }, async (req) => ({ data: await lots(req) }));
  app.get("/api/labels/lots.zpl", { preHandler: requirePerm("item.read"), schema: { tags: ["inventory"] } }, async (req, rep) => {
    const zpl = (await lots(req)).map((l) => {
      const code = l.serial_no ?? l.lot_no ?? l.item_code;
      return `^XA^CI28^PW812^LL406
^FO30,20^A0N,32,32^FD${zplEsc(l.item_code)}^FS
^FO30,60^A0N,26,26^FD${zplEsc((l.name_en ?? "").slice(0, 40))}^FS
^FO30,100^BY2,3,120^BCN,120,Y,N,N^FD${zplEsc(code)}^FS
^FO30,270^A0N,26,26^FD${l.serial_no ? "S/N" : "LOT"} ${zplEsc(code)}${l.expiry_date ? `   EXP ${new Date(l.expiry_date).toISOString().slice(0, 10)}` : ""}^FS
^FO600,100^BQN,2,5^FDLA,${zplEsc(l.item_code)}|${zplEsc(code)}^FS
^XZ`;
    }).join("\n");
    rep.header("content-type", "text/plain; charset=utf-8").header("content-disposition", "attachment; filename=lot-labels.zpl");
    return rep.send(zpl);
  });
}

