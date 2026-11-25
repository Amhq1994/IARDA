// E-mail notifications: every in-app notification is also queued as a branded e-mail (IARDA template, recipient's
// language) when e-mail is enabled and the user has not opted out. The dispatcher sends through SMTP_URL when
// configured; otherwise messages are marked "logged" (kept in the outbox for audit, nothing leaves the server).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { many, one } from "../db/pool.ts";
import type { Tx, Note } from "./common.ts";

let TEMPLATE: string | null = null;
function template() {
  if (TEMPLATE == null) {
    try { TEMPLATE = readFileSync(fileURLToPath(new URL("../../../../email/notification.html", import.meta.url)), "utf8"); }
    catch { TEMPLATE = "<html dir=\"{{dir}}\"><body><h1>{{title}}</h1><p>{{greeting}}</p>{{body_html}}<p><a href=\"{{action_url}}\">{{action_label}}</a></p></body></html>"; }
  }
  return TEMPLATE;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export function renderEmail(n: Note, u: { name_ar: string; name_en: string }, lang: "ar" | "en", baseUrl: string) {
  const ar = lang === "ar";
  const title = ar ? n.titleAr : n.titleEn;
  const body = ar ? n.bodyAr : n.bodyEn;
  const d = new Date();
  const fmt = (cal: string) => new Intl.DateTimeFormat(`${ar ? "ar-SA" : "en-GB"}-u-ca-${cal}-nu-latn`, { day: "numeric", month: "long", year: "numeric" }).format(d);
  const vars: Record<string, string> = {
    lang, dir: ar ? "rtl" : "ltr", start: ar ? "right" : "left", title: esc(title), preheader: esc(title),
    greeting: esc(ar ? `السلام عليكم ${u.name_ar}،` : `Dear ${u.name_en},`),
    body_html: body ? `<p style="margin:0 0 12px;">${esc(body)}</p>` : "",
    detail_label: esc(ar ? "المرجع" : "Reference"), detail_value: esc(n.docType ? `${n.docType}` : "—"),
    action_url: esc(`${baseUrl.replace(/\/$/, "")}${n.link ?? "/"}`), action_label: esc(ar ? "فتح في النظام" : "Open in WMS"),
    sent_date: esc(`${fmt("islamic-umalqura")} · ${fmt("gregory")}`), year: String(d.getFullYear()),
    logo_url: `${baseUrl.replace(/\/$/, "")}/brand/assets/raster/iarda-logo-600.png`, vision2030_url: "",
  };
  return template().replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

export async function queueEmails(c: Tx, userIds: string[], n: Note) {
  const enabled = await one(c, "SELECT value FROM setting WHERE key = 'email.enabled'");
  if (enabled && enabled.value === false) return;
  const base = (await one(c, "SELECT value FROM setting WHERE key = 'app.public_url'"))?.value ?? "http://localhost:3000";
  for (const u of await many(c, `SELECT id, email, name_ar, name_en, preferred_lang FROM app_user
                                 WHERE id = ANY($1) AND notify_email AND email IS NOT NULL AND status = 'active' AND deleted_at IS NULL`, [userIds])) {
    const lang = u.preferred_lang === "en" ? "en" : "ar";
    await c.query("INSERT INTO email_outbox (user_id, to_email, subject, html, kind) VALUES ($1,$2,$3,$4,$5)",
      [u.id, u.email, lang === "ar" ? n.titleAr : n.titleEn, renderEmail(n, u, lang, String(base)), n.kind]);
  }
}

/** Dispatcher (scheduler): sends queued mail through SMTP, or records it as logged when no SMTP server is configured. */
export async function dispatchEmails(c: Tx, limit = 50) {
  const rows = await many(c, "SELECT * FROM email_outbox WHERE status = 'queued' OR (status = 'failed' AND attempts < 5) ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED", [limit]);
  if (!rows.length) return { sent: 0, logged: 0, failed: 0 };
  const url = process.env.SMTP_URL;
  let transport: any = null;
  if (url) {
    const nodemailer = await import("nodemailer");
    transport = nodemailer.createTransport(url);
  }
  const out = { sent: 0, logged: 0, failed: 0 };
  for (const m of rows) {
    if (!transport) {
      await c.query("UPDATE email_outbox SET status = 'logged', attempts = attempts + 1 WHERE id = $1", [m.id]);
      out.logged++;
      continue;
    }
    try {
      await transport.sendMail({ from: process.env.SMTP_FROM ?? "IARDA WMS <no-reply@iarda.gov.sa>", to: m.to_email, subject: m.subject, html: m.html });
      await c.query("UPDATE email_outbox SET status = 'sent', sent_at = now(), attempts = attempts + 1 WHERE id = $1", [m.id]);
      out.sent++;
    } catch (e: any) {
      await c.query("UPDATE email_outbox SET status = 'failed', attempts = attempts + 1, last_error = $2 WHERE id = $1", [m.id, String(e?.message ?? e).slice(0, 500)]);
      out.failed++;
    }
  }
  return out;
}
