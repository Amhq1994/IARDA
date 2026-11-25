// Integrations: machine clients authenticate with API keys (scoped, SHA-256 hashed, shown once), every call is logged,
// and outbound events (ERP journals, Etimad requisitions, CMMS issues) go through a transactional outbox.
// The dispatcher POSTs each event (HMAC-SHA256 signed) to INTEGRATION_<SYSTEM>_URL; with no URL configured the
// event is kept as "stub" — recorded for audit and visible in the admin console, nothing leaves the server.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { one, many, pool } from "../db/pool.ts";
import { E } from "../lib/errors.ts";
import type { Tx } from "./common.ts";

export const SCOPES = ["erp.stock", "erp.journals", "erp.po", "etimad.pr", "etimad.po", "cmms.mr", "hr.clearance"] as const;
export type Scope = (typeof SCOPES)[number];

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export async function createClient(c: Tx, actorId: string, b: { name: string; system: "erp" | "etimad" | "cmms" | "hr" | "other"; scopes: Scope[]; allowedIps?: string[] | null }) {
  const prefix = randomBytes(4).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  const key = `iwk_${prefix}_${secret}`;
  // each client acts through its own non-interactive service user, so audit rows name the integration
  const user = await one(c, `INSERT INTO app_user (username, name_ar, name_en, auth_provider, status) VALUES ($1,$2,$3,'local','inactive') RETURNING id`,
    [`integration.${b.system}.${prefix}`, `تكامل: ${b.name}`, `Integration: ${b.name}`]);
  const cl = await one(c, `INSERT INTO integration_client (name, system, key_prefix, key_hash, scopes, service_user_id, allowed_ips) VALUES ($1,$2,$3,$4,$5,$6,$7)
                           RETURNING id, name, system, key_prefix, scopes, allowed_ips, is_active, created_at`,
    [b.name, b.system, prefix, sha(key), b.scopes, user.id, b.allowedIps?.length ? b.allowedIps : null]);
  return { ...cl, apiKey: key };
}

export interface IntegrationAuth { clientId: string; userId: string; scopes: string[]; name: string; system: string }

export async function authenticateKey(key: string | undefined, ip: string): Promise<IntegrationAuth | null> {
  const m = /^iwk_([0-9a-f]{8})_[A-Za-z0-9_-]{20,}$/.exec(key ?? "");
  if (!m) return null;
  const cl = await one(pool, "SELECT * FROM integration_client WHERE key_prefix = $1 AND is_active", [m[1]]);
  if (!cl) return null;
  const a = Buffer.from(cl.key_hash, "hex"), b = Buffer.from(sha(key!), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (cl.allowed_ips?.length && !cl.allowed_ips.includes(ip)) return null;
  await pool.query("UPDATE integration_client SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [cl.id]);
  return { clientId: cl.id, userId: cl.service_user_id, scopes: cl.scopes, name: cl.name, system: cl.system };
}

export async function logCall(a: { clientId?: string | null; method: string; path: string; status: number; requestId: string; ip: string; ms: number }) {
  await pool.query("INSERT INTO integration_call (client_id, method, path, status_code, request_id, ip, duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [a.clientId ?? null, a.method, a.path.slice(0, 300), a.status, a.requestId, a.ip, a.ms]).catch(() => {});
}

export async function enqueue(c: Tx, system: "erp" | "etimad" | "cmms" | "hr", event: string, doc: { type: string; id: string; no: string }, payload: unknown) {
  await c.query("INSERT INTO integration_outbox (system, event, doc_type, doc_id, doc_no, payload) VALUES ($1,$2,$3,$4,$5,$6)",
    [system, event, doc.type, doc.id, doc.no, JSON.stringify(payload)]);
}

export async function dispatchOutbox(c: Tx, limit = 50) {
  const rows = await many(c, "SELECT * FROM integration_outbox WHERE status = 'pending' OR (status = 'failed' AND attempts < 8) ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED", [limit]);
  const out = { delivered: 0, stub: 0, failed: 0 };
  for (const e of rows) {
    const url = process.env[`INTEGRATION_${String(e.system).toUpperCase()}_URL`];
    if (!url) {
      await c.query("UPDATE integration_outbox SET status = 'stub', attempts = attempts + 1 WHERE id = $1", [e.id]);
      out.stub++;
      continue;
    }
    const body = JSON.stringify({ id: Number(e.id), event: e.event, docType: e.doc_type, docNo: e.doc_no, occurredAt: e.created_at, data: e.payload });
    const sig = createHmac("sha256", process.env.INTEGRATION_SECRET ?? "").update(body).digest("hex");
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-iarda-event": e.event, "x-iarda-signature": `sha256=${sig}` },
        body, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await c.query("UPDATE integration_outbox SET status = 'delivered', delivered_at = now(), attempts = attempts + 1 WHERE id = $1", [e.id]);
      out.delivered++;
    } catch (err: any) {
      await c.query("UPDATE integration_outbox SET status = 'failed', attempts = attempts + 1, last_error = $2 WHERE id = $1", [e.id, String(err?.message ?? err).slice(0, 500)]);
      out.failed++;
    }
  }
  return out;
}

export function requireScope(a: IntegrationAuth | undefined, scope: Scope) {
  if (!a) throw E.unauthenticated();
  if (!a.scopes.includes(scope)) throw E.forbidden(`scope ${scope}`);
}
