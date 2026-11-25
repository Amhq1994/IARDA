// Attachments: encrypted at rest (AES-256-GCM), SHA-256 fingerprint, type/size checks, soft delete.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Permission } from "@iarda/shared";
import { pool, one, withTx } from "../db/pool.ts";
import { config } from "../config.ts";
import { E, ApiError } from "../lib/errors.ts";
import { parse, uuid, idParam } from "../lib/http.ts";
import { requireAuth, txCtx, can } from "../auth/context.ts";
import { decryptBlob, encryptBlob, sha256 } from "../lib/crypto.ts";

const ALLOWED: Record<string, string[]> = {
  "image/jpeg": ["ffd8ff"], "image/png": ["89504e47"], "image/webp": ["52494646"], "application/pdf": ["25504446"],
};
/** Which permission is needed to write / read attachments of an owner type. */
const OWNER_PERMS: Record<string, { write: Permission; read: Permission }> = {
  item: { write: "item.manage", read: "item.read" },
};

export async function attachmentRoutes(app: FastifyInstance) {
  app.post("/api/attachments", { preHandler: requireAuth, schema: { tags: ["items"], summary: "Upload an attachment (multipart)" } }, async (req, rep) => {
    const file = await req.file();
    if (!file) throw E.invalid([{ path: "file", message: "required" }]);
    const fields = Object.fromEntries(Object.entries(file.fields).map(([k, v]: any) => [k, v?.value]));
    const meta = parse(z.object({ ownerType: z.enum(Object.keys(OWNER_PERMS) as [string]), ownerId: uuid,
      category: z.enum(["image", "spec_sheet", "inspection_report", "minutes", "invoice", "other"]), isPrimary: z.coerce.boolean().default(false) }), fields);
    if (!can(req.user, OWNER_PERMS[meta.ownerType].write)) throw E.forbidden(OWNER_PERMS[meta.ownerType].write);
    const buf = await file.toBuffer();
    const sigs = ALLOWED[file.mimetype];
    if (!sigs || !sigs.some((s) => buf.subarray(0, s.length / 2).toString("hex") === s)) {
      throw new ApiError(415, "unsupported_file", "نوع الملف غير مسموح (JPG, PNG, WEBP, PDF)", "File type not allowed (JPG, PNG, WEBP, PDF)");
    }
    if (meta.category === "image" && !file.mimetype.startsWith("image/")) throw E.invalid([{ path: "file", message: "image_required" }]);
    const owner = await one(pool, "SELECT id FROM item WHERE id = $1 AND deleted_at IS NULL", [meta.ownerId]);
    if (!owner) throw E.notFound(meta.ownerType);
    const digest = sha256(buf);
    const key = `${meta.ownerType}/${digest.slice(0, 2)}/${digest}-${Date.now()}.bin`;
    await mkdir(join(config.storageDir, meta.ownerType, digest.slice(0, 2)), { recursive: true });
    await writeFile(join(config.storageDir, key), encryptBlob(buf));
    const row = await withTx(txCtx(req), async (c) => {
      if (meta.isPrimary) await c.query("UPDATE attachment SET is_primary = false WHERE owner_type = $1 AND owner_id = $2 AND category = $3 AND is_primary",
        [meta.ownerType, meta.ownerId, meta.category]);
      return one(c, `INSERT INTO attachment (owner_type, owner_id, category, file_name, mime_type, size_bytes, sha256, storage_key, is_primary)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, file_name, mime_type, size_bytes, sha256, is_primary, created_at`,
        [meta.ownerType, meta.ownerId, meta.category, file.filename.slice(0, 200), file.mimetype, buf.length, digest, key, meta.isPrimary]);
    });
    rep.status(201); return row;
  });

  app.get("/api/attachments/:id/content", { preHandler: requireAuth, schema: { tags: ["items"] } }, async (req, rep) => {
    const { id } = parse(idParam, req.params);
    const a = await one(pool, "SELECT * FROM attachment WHERE id = $1 AND deleted_at IS NULL", [id]);
    if (!a) throw E.notFound("attachment");
    const perms = OWNER_PERMS[a.owner_type];
    if (!perms || !can(req.user, perms.read)) throw E.forbidden();
    const data = decryptBlob(await readFile(join(config.storageDir, a.storage_key)));
    if (sha256(data) !== a.sha256) throw new ApiError(500, "integrity", "فشل التحقق من سلامة الملف", "Attachment integrity check failed");
    rep.header("content-type", a.mime_type).header("cache-control", "private, max-age=300")
      .header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(a.file_name)}`);
    return rep.send(data);
  });

  app.delete("/api/attachments/:id", { preHandler: requireAuth, schema: { tags: ["items"] } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return withTx(txCtx(req), async (c) => {
      const a = await one(c, "SELECT owner_type FROM attachment WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]);
      if (!a) throw E.notFound("attachment");
      if (!can(req.user, OWNER_PERMS[a.owner_type]?.write)) throw E.forbidden();
      await c.query("UPDATE attachment SET deleted_at = now(), deleted_by = $2 WHERE id = $1", [id, req.user!.id]);
      return { ok: true };
    });
  });
}
