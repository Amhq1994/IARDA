// Authentication: local login (argon2id + optional TOTP MFA), sessions, password change,
// MFA enrolment, language preference, and the SSO (OIDC) entry point.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { hash, verify } from "@node-rs/argon2";
import QRCode from "qrcode";
import { pool, one, withTx } from "../db/pool.ts";
import { config } from "../config.ts";
import { E, ApiError } from "../lib/errors.ts";
import { parse } from "../lib/http.ts";
import { base32, decrypt, encrypt, randomToken, sha256, verifyTotp } from "../lib/crypto.ts";
import { buildUser, requireAuth, txCtx, type AuthUser } from "./context.ts";
import { randomBytes } from "node:crypto";

export const hashPassword = (pw: string) => hash(pw, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

export const passwordPolicy = z.string()
  .min(config.security.passwordMinLength, "min_length")
  .regex(/[a-z]/, "needs_lowercase").regex(/[A-Z]/, "needs_uppercase")
  .regex(/\d/, "needs_digit").regex(/[^A-Za-z0-9]/, "needs_symbol");

async function securityEvent(event: string, data: { username?: string; userId?: string; ip?: string; ua?: string; details?: unknown }) {
  await pool.query(
    "INSERT INTO security_event (event, username, user_id, ip, user_agent, details) VALUES ($1,$2,$3,$4,$5,$6)",
    [event, data.username ?? null, data.userId ?? null, data.ip ?? null, data.ua ?? null, data.details ? JSON.stringify(data.details) : null]
  );
}

export function serializeUser(u: AuthUser) {
  return {
    id: u.id, username: u.username, nameAr: u.nameAr, nameEn: u.nameEn, orgUnitId: u.orgUnitId, supplierId: u.supplierId,
    lang: u.lang, mfaEnabled: u.mfaEnabled, mustChangePassword: u.mustChangePassword,
    roles: u.roles.map((r) => ({ code: r.code, scope: r.scope, warehouseIds: r.warehouseIds, orgUnitIds: r.orgUnitIds })),
    permissions: [...u.permissions].sort(),
  };
}

function setSessionCookie(rep: FastifyReply, token: string) {
  rep.setCookie(config.session.cookieName, token, {
    path: "/", httpOnly: true, sameSite: "strict", secure: config.session.secureCookie,
    maxAge: config.session.absoluteHours * 3600,
  });
}

export async function authRoutes(app: FastifyInstance) {
  const loginBody = z.object({
    username: z.string().trim().min(1).max(100),
    password: z.string().min(1).max(200),
    totp: z.string().trim().optional(),
  });

  app.post("/api/auth/login", {
    config: { rateLimit: { max: config.security.loginRateLimitPerMinute, timeWindow: "1 minute" } },
    schema: { tags: ["auth"], summary: "Sign in with username/password (+ TOTP when MFA is enabled)" },
  }, async (req, rep) => {
    const body = parse(loginBody, req.body);
    const ua = String(req.headers["user-agent"] || "");
    const u = await one(pool, "SELECT * FROM app_user WHERE username = $1 AND deleted_at IS NULL", [body.username]);
    const fail = async (reason: string) => {
      await securityEvent("login_failed", { username: body.username, userId: u?.id, ip: req.ip, ua, details: { reason } });
      return new ApiError(401, "invalid_credentials", "اسم المستخدم أو كلمة المرور غير صحيحة", "Invalid username or password");
    };
    if (!u || u.auth_provider !== "local" || !u.password_hash) throw await fail("unknown_or_external");
    if (u.status !== "active") throw await fail("inactive");
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      await securityEvent("login_locked", { username: u.username, userId: u.id, ip: req.ip, ua });
      throw new ApiError(423, "account_locked", "الحساب مقفل مؤقتاً بسبب محاولات دخول فاشلة", "Account temporarily locked after failed attempts",
        { until: u.locked_until });
    }
    if (!(await verify(u.password_hash, body.password))) {
      const attempts = u.failed_logins + 1;
      const lock = attempts >= config.security.maxFailedLogins;
      await withTx({ userId: u.id, ip: req.ip }, (c) => c.query(
        `UPDATE app_user SET failed_logins = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END WHERE id = $1`,
        [u.id, lock ? 0 : attempts, lock, config.security.lockoutMinutes]));
      if (lock) await securityEvent("account_locked", { username: u.username, userId: u.id, ip: req.ip, ua });
      throw await fail("bad_password");
    }
    if (u.mfa_enabled) {
      if (!body.totp) throw new ApiError(401, "mfa_required", "أدخل رمز التحقق من تطبيق المصادقة", "Enter the code from your authenticator app");
      if (!verifyTotp(decrypt(u.mfa_secret)!, body.totp)) throw await fail("bad_totp");
    }
    const token = randomToken();
    const session = await one(pool,
      `INSERT INTO user_session (user_id, token_hash, mfa_passed, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5, $6) RETURNING id`,
      [u.id, sha256(token), u.mfa_enabled, config.session.absoluteHours, req.ip, ua.slice(0, 300)]);
    await withTx({ userId: u.id, ip: req.ip }, (c) =>
      c.query("UPDATE app_user SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1", [u.id]));
    await securityEvent("login_success", { username: u.username, userId: u.id, ip: req.ip, ua });
    setSessionCookie(rep, token);
    return { user: serializeUser(await buildUser(u, session.id)) };
  });

  app.post("/api/auth/logout", { schema: { tags: ["auth"] } }, async (req, rep) => {
    if (req.user) {
      await pool.query("UPDATE user_session SET revoked_at = now() WHERE id = $1", [req.user.sessionId]);
      await securityEvent("logout", { username: req.user.username, userId: req.user.id, ip: req.ip });
    }
    rep.clearCookie(config.session.cookieName, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: requireAuth, schema: { tags: ["auth"] } }, async (req) => ({ user: serializeUser(req.user!) }));

  app.patch("/api/auth/me", { preHandler: requireAuth, schema: { tags: ["auth"] } }, async (req) => {
    const body = parse(z.object({ lang: z.enum(["ar", "en"]) }), req.body);
    await withTx(txCtx(req), (c) => c.query("UPDATE app_user SET preferred_lang = $2 WHERE id = $1", [req.user!.id, body.lang]));
    return { ok: true };
  });

  app.post("/api/auth/change-password", { preHandler: requireAuth, schema: { tags: ["auth"] } }, async (req) => {
    const body = parse(z.object({ currentPassword: z.string(), newPassword: passwordPolicy }), req.body);
    const u = await one(pool, "SELECT password_hash FROM app_user WHERE id = $1", [req.user!.id]);
    if (!u?.password_hash || !(await verify(u.password_hash, body.currentPassword))) {
      throw new ApiError(422, "invalid_current_password", "كلمة المرور الحالية غير صحيحة", "Current password is incorrect");
    }
    if (await verify(u.password_hash, body.newPassword)) {
      throw new ApiError(422, "password_reused", "يجب أن تختلف كلمة المرور الجديدة عن الحالية", "New password must differ from the current one");
    }
    await withTx(txCtx(req), async (c) => {
      await c.query("UPDATE app_user SET password_hash = $2, password_changed_at = now(), must_change_password = false WHERE id = $1",
        [req.user!.id, await hashPassword(body.newPassword)]);
      // sign out every other session
      await c.query("UPDATE user_session SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL",
        [req.user!.id, req.user!.sessionId]);
    });
    await securityEvent("password_changed", { username: req.user!.username, userId: req.user!.id, ip: req.ip });
    return { ok: true };
  });

  // ---- MFA enrolment
  app.post("/api/auth/mfa/setup", { preHandler: requireAuth, schema: { tags: ["auth"] } }, async (req) => {
    if (req.user!.mfaEnabled) throw E.conflict("mfa_already_enabled", "المصادقة الثنائية مفعّلة مسبقاً", "MFA is already enabled");
    const secret = base32(randomBytes(20));
    await withTx(txCtx(req), (c) => c.query("UPDATE app_user SET mfa_secret = $2 WHERE id = $1", [req.user!.id, encrypt(secret)]));
    const label = encodeURIComponent(`IARDA WMS:${req.user!.username}`);
    const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent("IARDA WMS")}&algorithm=SHA1&digits=6&period=30`;
    return { secret, otpauthUri: uri, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 220, color: { dark: "#014F37" } }) };
  });

  app.post("/api/auth/mfa/enable", { preHandler: requireAuth, schema: { tags: ["auth"] } }, async (req) => {
    const { code } = parse(z.object({ code: z.string() }), req.body);
    const u = await one(pool, "SELECT mfa_secret FROM app_user WHERE id = $1", [req.user!.id]);
    if (!u?.mfa_secret || !verifyTotp(decrypt(u.mfa_secret)!, code)) {
      throw new ApiError(422, "invalid_totp", "رمز التحقق غير صحيح", "Invalid verification code");
    }
    await withTx(txCtx(req), (c) => c.query("UPDATE app_user SET mfa_enabled = true WHERE id = $1", [req.user!.id]));
    await securityEvent("mfa_enabled", { username: req.user!.username, userId: req.user!.id, ip: req.ip });
    return { ok: true };
  });

  // ---- SSO (Azure AD / OIDC) entry point — stub until the tenant is configured
  app.get("/api/auth/oidc/login", { schema: { tags: ["auth"], summary: "SSO login (OIDC / Azure AD)" } }, async () => {
    if (!config.oidc.issuer || !config.oidc.clientId) {
      throw new ApiError(501, "sso_not_configured", "الدخول الموحد غير مهيأ بعد", "SSO is not configured. Set OIDC_ISSUER and OIDC_CLIENT_ID.");
    }
    throw new ApiError(501, "sso_pending", "الدخول الموحد قيد الربط", "OIDC flow will be enabled in the integrations phase");
  });
}
