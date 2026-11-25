import { randomBytes } from "node:crypto";

const env = process.env;
const isProd = env.NODE_ENV === "production";

function required(name: string, devDefault: string): string {
  const v = env[name];
  if (v) return v;
  if (isProd) throw new Error(`Missing required environment variable ${name}`);
  return devDefault;
}

export const config = {
  isProd,
  port: Number(env.PORT || 3000),
  host: env.HOST || "0.0.0.0",
  /** Runtime connection: least-privilege role (no DELETE, no direct audit writes). */
  databaseUrl: required("DATABASE_URL", "postgres://wms_app:wms_app_dev@localhost:5432/iarda_wms"),
  /** Migration connection: schema owner. */
  ownerDatabaseUrl: required("DATABASE_OWNER_URL", "postgres://wms_owner:wms_owner_dev@localhost:5432/iarda_wms"),
  appDbRole: env.APP_DB_ROLE || "wms_app",
  /** 32-byte key (base64) for AES-256-GCM encryption of personal data and attachments. */
  dataKey: Buffer.from(required("DATA_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64")), "base64"),
  storageDir: env.STORAGE_DIR || new URL("../../../storage/", import.meta.url).pathname,
  session: {
    cookieName: "wms_session",
    idleMinutes: Number(env.SESSION_IDLE_MINUTES || 30),
    absoluteHours: Number(env.SESSION_ABSOLUTE_HOURS || 12),
    secureCookie: isProd || env.COOKIE_SECURE === "true",
  },
  security: {
    maxFailedLogins: Number(env.MAX_FAILED_LOGINS || 5),
    lockoutMinutes: Number(env.LOCKOUT_MINUTES || 15),
    passwordMinLength: 10,
    loginRateLimitPerMinute: Number(env.LOGIN_RATE_LIMIT || 10),
  },
  oidc: {
    issuer: env.OIDC_ISSUER || "",
    clientId: env.OIDC_CLIENT_ID || "",
  },
  webDist: env.WEB_DIST || new URL("../../web/dist/", import.meta.url).pathname,
  instanceId: randomBytes(4).toString("hex"),
};

if (config.dataKey.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes (base64)");
