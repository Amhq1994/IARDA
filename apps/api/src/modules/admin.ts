// Administration: users, role assignments (with warehouse/department scopes), role–permission
// matrix, settings, delegations register. System Admins cannot post stock transactions.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PERMISSIONS } from "@iarda/shared";
import { pool, one, many, withTx } from "../db/pool.ts";
import { E, ApiError } from "../lib/errors.ts";
import { parse, listQuery, orderBy, uuid, idParam, nameAr, nameEn, versionField } from "../lib/http.ts";
import { requirePerm, txCtx } from "../auth/context.ts";
import { encrypt, decrypt, randomToken } from "../lib/crypto.ts";
import { hashPassword, passwordPolicy } from "../auth/routes.ts";

const userCols = `u.id, u.username, u.employee_no, u.name_ar, u.name_en, u.email, u.org_unit_id, u.position_ar, u.position_en,
  u.manager_id, u.supplier_id, u.auth_provider, u.mfa_enabled, u.status, u.locked_until, u.last_login_at, u.preferred_lang,
  u.must_change_password, u.version, u.created_at, o.name_ar AS org_name_ar, o.name_en AS org_name_en`;

async function getUser(db: any, id: string) {
  const u = await one(db, `SELECT ${userCols}, u.mobile_enc FROM app_user u LEFT JOIN org_unit o ON o.id = u.org_unit_id
                           WHERE u.id = $1 AND u.deleted_at IS NULL`, [id]);
  if (!u) throw E.notFound("user");
  const roles = await many(db,
    `SELECT ur.id, ur.role_id, r.code, r.name_ar, r.name_en, r.scope, ur.warehouse_ids, ur.org_unit_ids, ur.valid_from, ur.valid_to, ur.is_active, ur.version
       FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.code`, [id]);
  const { mobile_enc, ...rest } = u;
  return { ...rest, mobile: decrypt(mobile_enc), roles };
}

export async function adminRoutes(app: FastifyInstance) {
  const admin = requirePerm("admin.users");

  // ---------------------------------------------------------------- users
  app.get("/api/users", { preHandler: requirePerm("admin.users", "audit.read"), schema: { tags: ["admin"] } }, async (req) => {
    const q = parse(listQuery.extend({ role: z.string().optional(), status: z.string().optional(), orgUnitId: uuid.optional() }), req.query);
    const p: unknown[] = []; const where = ["u.deleted_at IS NULL"];
    if (q.q) { p.push(`%${q.q}%`); where.push(`(u.username ILIKE $${p.length} OR u.name_ar ILIKE $${p.length} OR u.name_en ILIKE $${p.length} OR u.employee_no ILIKE $${p.length})`); }
    if (q.status) { p.push(q.status); where.push(`u.status = $${p.length}`); }
    if (q.orgUnitId) { p.push(q.orgUnitId); where.push(`u.org_unit_id = $${p.length}`); }
    if (q.role) { p.push(q.role); where.push(`EXISTS (SELECT 1 FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = u.id AND ur.is_active AND r.code = $${p.length})`); }
    const w = `WHERE ${where.join(" AND ")}`;
    const total = (await one(pool, `SELECT count(*)::int AS n FROM app_user u ${w}`, p))!.n;
    const data = await many(pool,
      `SELECT ${userCols},
              (SELECT array_agg(r.code ORDER BY r.code) FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = u.id AND ur.is_active) AS role_codes
         FROM app_user u LEFT JOIN org_unit o ON o.id = u.org_unit_id ${w}
        ORDER BY ${orderBy(q, { username: "u.username", nameAr: "u.name_ar", nameEn: "u.name_en", lastLogin: "u.last_login_at" }, "u.username")}
        LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, p);
    return { data, total, page: q.page, pageSize: q.pageSize };
  });

  app.get("/api/users/:id", { preHandler: requirePerm("admin.users", "audit.read"), schema: { tags: ["admin"] } }, async (req) =>
    getUser(pool, parse(idParam, req.params).id));

  const userBody = {
    nameAr, nameEn, employeeNo: z.string().trim().max(20).nullable().optional(), email: z.string().email().nullable().optional(),
    mobile: z.string().regex(/^\+?\d{9,15}$/).nullable().optional(), orgUnitId: uuid.nullable().optional(),
    positionAr: z.string().max(100).nullable().optional(), positionEn: z.string().max(100).nullable().optional(),
    managerId: uuid.nullable().optional(), supplierId: uuid.nullable().optional(), preferredLang: z.enum(["ar", "en"]).optional(),
  };

  app.post("/api/users", { preHandler: admin, schema: { tags: ["admin"] } }, async (req, rep) => {
    const b = parse(z.object({ username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/), ...userBody,
      authProvider: z.enum(["local", "oidc", "ldap"]).default("local"), initialPassword: passwordPolicy.optional() }), req.body);
    const temp = b.authProvider === "local" ? (b.initialPassword ?? `Tmp!${randomToken(9)}9a`) : null;
    const out = await withTx(txCtx(req), async (c) => {
      const u = await one(c,
        `INSERT INTO app_user (username, employee_no, name_ar, name_en, email, mobile_enc, org_unit_id, position_ar, position_en, manager_id,
                               supplier_id, auth_provider, password_hash, password_changed_at, must_change_password, preferred_lang)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), $14, $15) RETURNING id`,
        [b.username, b.employeeNo ?? null, b.nameAr, b.nameEn, b.email ?? null, b.mobile ? encrypt(b.mobile) : null, b.orgUnitId ?? null,
         b.positionAr ?? null, b.positionEn ?? null, b.managerId ?? null, b.supplierId ?? null, b.authProvider,
         temp ? await hashPassword(temp) : null, !!temp && !b.initialPassword, b.preferredLang ?? "ar"]);
      return getUser(c, u.id);
    });
    rep.status(201);
    // the temporary password is shown once to the admin and must be changed at first login
    return { ...out, temporaryPassword: b.initialPassword ? undefined : temp };
  });

  app.patch("/api/users/:id", { preHandler: admin, schema: { tags: ["admin"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ ...Object.fromEntries(Object.entries(userBody).map(([k, v]) => [k, (v as any).optional()])),
      status: z.enum(["active", "inactive", "suspended"]).optional(), version: versionField }), req.body) as any;
    return withTx(txCtx(req), async (c) => {
      const cur = await one(c, "SELECT version FROM app_user WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]);
      if (!cur) throw E.notFound("user");
      if (cur.version !== b.version) throw E.stale();
      if (id === req.user!.id && b.status && b.status !== "active") {
        throw new ApiError(409, "self_lockout", "لا يمكنك تعطيل حسابك", "You cannot deactivate your own account");
      }
      const map: Record<string, string> = { nameAr: "name_ar", nameEn: "name_en", employeeNo: "employee_no", email: "email", orgUnitId: "org_unit_id",
        positionAr: "position_ar", positionEn: "position_en", managerId: "manager_id", supplierId: "supplier_id", preferredLang: "preferred_lang", status: "status" };
      const sets: string[] = []; const p: unknown[] = [id];
      for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { p.push(b[k]); sets.push(`${col} = $${p.length}`); }
      if (b.mobile !== undefined) { p.push(b.mobile ? encrypt(b.mobile) : null); sets.push(`mobile_enc = $${p.length}`); }
      if (sets.length) await c.query(`UPDATE app_user SET ${sets.join(", ")} WHERE id = $1`, p);
      if (b.status && b.status !== "active") await c.query("UPDATE user_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [id]);
      return getUser(c, id);
    });
  });

  app.post("/api/users/:id/unlock", { preHandler: admin, schema: { tags: ["admin"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    await withTx(txCtx(req), (c) => c.query("UPDATE app_user SET locked_until = NULL, failed_logins = 0 WHERE id = $1", [id]));
    return { ok: true };
  });

  app.post("/api/users/:id/reset-password", { preHandler: admin, schema: { tags: ["admin"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const temp = `Tmp!${randomToken(9)}9a`;
    await withTx(txCtx(req), async (c) => {
      const r = await c.query(`UPDATE app_user SET password_hash = $2, must_change_password = true, password_changed_at = now(),
                                failed_logins = 0, locked_until = NULL WHERE id = $1 AND auth_provider = 'local' AND deleted_at IS NULL`, [id, await hashPassword(temp)]);
      if (!r.rowCount) throw E.notFound("local user");
      await c.query("UPDATE user_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [id]);
    });
    return { temporaryPassword: temp };
  });

  // ---- role assignments
  app.post("/api/users/:id/roles", { preHandler: admin, schema: { tags: ["admin"] } }, async (req, rep) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ roleCode: z.string(), warehouseIds: z.array(uuid).nullable().optional(), orgUnitIds: z.array(uuid).nullable().optional(),
      validFrom: z.string().date().optional(), validTo: z.string().date().nullable().optional() }), req.body);
    const out = await withTx(txCtx(req), async (c) => {
      const role = await one(c, "SELECT id FROM role WHERE code = $1 AND deleted_at IS NULL", [b.roleCode]);
      if (!role) throw E.notFound("role");
      return one(c,
        `INSERT INTO user_role (user_id, role_id, warehouse_ids, org_unit_ids, valid_from, valid_to)
         VALUES ($1,$2,$3,$4,coalesce($5::date, current_date),$6)
         ON CONFLICT (user_id, role_id) DO UPDATE SET warehouse_ids = EXCLUDED.warehouse_ids, org_unit_ids = EXCLUDED.org_unit_ids,
           valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to, is_active = true
         RETURNING *`, [id, role.id, b.warehouseIds ?? null, b.orgUnitIds ?? null, b.validFrom ?? null, b.validTo ?? null]);
    });
    rep.status(201); return out;
  });

  app.delete("/api/users/:id/roles/:roleCode", { preHandler: admin, schema: { tags: ["admin"], summary: "Revoke role (deactivates; history kept)" } }, async (req) => {
    const { id, roleCode } = parse(z.object({ id: uuid, roleCode: z.string() }), req.params);
    if (id === req.user!.id && roleCode === "ADM") throw new ApiError(409, "self_lockout", "لا يمكنك إزالة دور مدير النظام عن نفسك", "You cannot remove your own admin role");
    await withTx(txCtx(req), async (c) => {
      const r = await c.query(`UPDATE user_role ur SET is_active = false, valid_to = current_date FROM role r
                               WHERE r.id = ur.role_id AND ur.user_id = $1 AND r.code = $2 AND ur.is_active`, [id, roleCode]);
      if (!r.rowCount) throw E.notFound("role assignment");
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- roles & permission matrix
  app.get("/api/roles", { preHandler: requirePerm("admin.users", "admin.roles", "audit.read"), schema: { tags: ["admin"] } }, async () => {
    const roles = await many(pool, `SELECT r.id, r.code, r.name_ar, r.name_en, r.scope,
        (SELECT count(*)::int FROM user_role ur WHERE ur.role_id = r.id AND ur.is_active) AS user_count,
        coalesce((SELECT array_agg(rp.permission_key ORDER BY rp.permission_key) FROM role_permission rp WHERE rp.role_id = r.id AND rp.is_granted), '{}') AS permissions
      FROM role r WHERE r.deleted_at IS NULL ORDER BY r.code`);
    const permissions = await many(pool, "SELECT key, name_ar, name_en, module FROM permission ORDER BY module, key");
    return { roles, permissions };
  });

  app.put("/api/roles/:code/permissions/:key", { preHandler: requirePerm("admin.roles"), schema: { tags: ["admin"], summary: "Grant/revoke a permission (audited)" } }, async (req) => {
    const { code, key } = parse(z.object({ code: z.string(), key: z.string() }), req.params);
    const { granted } = parse(z.object({ granted: z.boolean() }), req.body);
    if (!(key in PERMISSIONS)) throw E.notFound("permission");
    if (code === "ADM" && key.startsWith("admin.") && !granted) {
      throw new ApiError(409, "self_lockout", "لا يمكن سحب صلاحيات الإدارة من دور مدير النظام", "Admin permissions cannot be removed from the System Admin role");
    }
    // SoD: System Admin, Auditor, Finance, Supplier and MDO may never receive stock-transaction permissions
    const txPerms = ["receipt.execute", "grn.post", "putaway.execute", "issue.execute", "pick.execute", "transfer.bin", "adjustment.approve", "count.execute"];
    if (granted && ["ADM", "AUD", "FIN", "SUP", "MDO"].includes(code) && txPerms.includes(key)) {
      throw E.sod("NO_TX_ROLE", "هذا الدور لا يجوز أن يمتلك صلاحيات حركات المخزون", "This role may not hold stock-transaction permissions");
    }
    return withTx(txCtx(req), async (c) => {
      const role = await one(c, "SELECT id FROM role WHERE code = $1 AND deleted_at IS NULL", [code]);
      if (!role) throw E.notFound("role");
      return one(c, `INSERT INTO role_permission (role_id, permission_key, is_granted) VALUES ($1,$2,$3)
                     ON CONFLICT (role_id, permission_key) DO UPDATE SET is_granted = EXCLUDED.is_granted RETURNING *`, [role.id, key, granted]);
    });
  });

  // ---------------------------------------------------------------- settings
  app.get("/api/settings", { preHandler: requirePerm("admin.settings", "audit.read"), schema: { tags: ["admin"] } }, async () => ({
    data: await many(pool, "SELECT key, value, description_ar, description_en, version, updated_at FROM setting ORDER BY key"),
  }));
  app.put("/api/settings/:key", { preHandler: requirePerm("admin.settings"), schema: { tags: ["admin"] } }, async (req) => {
    const { key } = parse(z.object({ key: z.string().max(80) }), req.params);
    const b = parse(z.object({ value: z.unknown(), version: versionField }), req.body);
    return withTx(txCtx(req), async (c) => {
      const cur = await one(c, "SELECT version FROM setting WHERE key = $1 FOR UPDATE", [key]);
      if (!cur) throw E.notFound("setting");
      if (cur.version !== b.version) throw E.stale();
      return one(c, "UPDATE setting SET value = $2 WHERE key = $1 RETURNING *", [key, JSON.stringify(b.value)]);
    });
  });

  // ---------------------------------------------------------------- delegations register (workflows use it from phase 2)
  app.get("/api/delegations", { preHandler: requirePerm("admin.delegations", "delegation.own"), schema: { tags: ["admin"] } }, async (req) => {
    const all = req.user!.permissions.has("admin.delegations");
    return { data: await many(pool,
      `SELECT d.*, f.name_ar AS from_name_ar, f.name_en AS from_name_en, t.name_ar AS to_name_ar, t.name_en AS to_name_en
         FROM delegation d JOIN app_user f ON f.id = d.from_user_id JOIN app_user t ON t.id = d.to_user_id
        ${all ? "" : "WHERE d.from_user_id = $1 OR d.to_user_id = $1"} ORDER BY d.valid_from DESC LIMIT 200`, all ? [] : [req.user!.id]) };
  });
}
