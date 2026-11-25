// Authenticated user context, permission guards and data-scope helpers.
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Permission, RoleCode, Scope } from "@iarda/shared";
import { pool, one, many } from "../db/pool.ts";
import { sha256 } from "../lib/crypto.ts";
import { E } from "../lib/errors.ts";
import { config } from "../config.ts";

export interface UserRoleScope {
  code: RoleCode;
  scope: Scope;
  warehouseIds: string[] | null;
  orgUnitIds: string[] | null;
  permissions: Set<string>;
}

export interface AuthUser {
  id: string;
  username: string;
  nameAr: string;
  nameEn: string;
  orgUnitId: string | null;
  supplierId: string | null;
  lang: "ar" | "en";
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  sessionId: string;
  roles: UserRoleScope[];
  permissions: Set<string>;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export async function loadUserFromSession(token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const s = await one(pool,
    `SELECT s.id AS session_id, s.last_seen_at, u.*
       FROM user_session s JOIN app_user u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND u.status = 'active' AND u.deleted_at IS NULL`, [sha256(token)]);
  if (!s) return null;
  const idleMs = config.session.idleMinutes * 60_000;
  if (Date.now() - new Date(s.last_seen_at).getTime() > idleMs) {
    await pool.query("UPDATE user_session SET revoked_at = now() WHERE id = $1", [s.session_id]);
    return null;
  }
  if (Date.now() - new Date(s.last_seen_at).getTime() > 60_000) {
    await pool.query("UPDATE user_session SET last_seen_at = now() WHERE id = $1", [s.session_id]);
  }
  return buildUser(s, s.session_id);
}

export async function buildUser(u: any, sessionId: string): Promise<AuthUser> {
  const rows = await many(pool,
    `SELECT r.code, r.scope, ur.warehouse_ids, ur.org_unit_ids,
            coalesce(array_agg(rp.permission_key) FILTER (WHERE rp.is_granted), '{}') AS perms
       FROM user_role ur
       JOIN role r ON r.id = ur.role_id AND r.deleted_at IS NULL
       LEFT JOIN role_permission rp ON rp.role_id = r.id
      WHERE ur.user_id = $1 AND ur.is_active
        AND ur.valid_from <= current_date AND (ur.valid_to IS NULL OR ur.valid_to >= current_date)
      GROUP BY r.code, r.scope, ur.warehouse_ids, ur.org_unit_ids`, [u.id]);
  const roles: UserRoleScope[] = rows.map((r) => ({
    code: r.code, scope: r.scope, warehouseIds: r.warehouse_ids, orgUnitIds: r.org_unit_ids, permissions: new Set(r.perms),
  }));
  return {
    id: u.id, username: u.username, nameAr: u.name_ar, nameEn: u.name_en, orgUnitId: u.org_unit_id,
    supplierId: u.supplier_id, lang: u.preferred_lang, mfaEnabled: u.mfa_enabled, mustChangePassword: u.must_change_password,
    sessionId, roles, permissions: new Set(roles.flatMap((r) => [...r.permissions])),
  };
}

export const can = (u: AuthUser | undefined, p: Permission) => !!u && u.permissions.has(p);
export const hasRole = (u: AuthUser | undefined, code: RoleCode) => !!u && u.roles.some((r) => r.code === code);

/** Fastify preHandler: requires a session and at least one of the given permissions. */
export function requirePerm(...perms: Permission[]) {
  return async (req: FastifyRequest, _rep: FastifyReply) => {
    if (!req.user) throw E.unauthenticated();
    if (perms.length && !perms.some((p) => req.user!.permissions.has(p))) throw E.forbidden(perms.join("|"));
  };
}

export async function requireAuth(req: FastifyRequest) {
  if (!req.user) throw E.unauthenticated();
}

/**
 * Warehouses the user may act on for a permission: "all" or a list of ids.
 * Roles with scope "all", or warehouse-scoped roles without explicit ids, see every warehouse.
 */
export function warehouseScope(u: AuthUser, perm: Permission): "all" | string[] {
  const ids = new Set<string>();
  for (const r of u.roles) {
    if (!r.permissions.has(perm)) continue;
    if (r.scope === "all" || !r.warehouseIds || r.warehouseIds.length === 0) return "all";
    r.warehouseIds.forEach((id) => ids.add(id));
  }
  return [...ids];
}

export function assertWarehouseInScope(u: AuthUser, perm: Permission, warehouseId: string) {
  const s = warehouseScope(u, perm);
  if (s !== "all" && !s.includes(warehouseId)) throw E.outOfScope();
}

/** Transaction context derived from a request (actor + traceability for the audit trail). */
export const txCtx = (req: FastifyRequest) => ({
  userId: req.user?.id ?? null,
  requestId: String(req.id),
  ip: req.ip,
});
