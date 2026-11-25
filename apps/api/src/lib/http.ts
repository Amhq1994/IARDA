import { z } from "zod";
import { E } from "./errors.ts";

/** Parses input with a Zod schema, throwing a bilingual 422 on failure. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw E.invalid(r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message, code: i.code })));
  return r.data;
}

export const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().max(200).optional(),
  sort: z.string().max(40).optional(),
  dir: z.enum(["asc", "desc"]).default("asc"),
  includeDeleted: z.coerce.boolean().default(false),
});
export type ListQuery = z.infer<typeof listQuery>;

export interface Page<T> { data: T[]; total: number; page: number; pageSize: number; }

/** Resolves a whitelisted sort column; never interpolates user input directly. */
export function orderBy(q: ListQuery, allowed: Record<string, string>, fallback: string): string {
  const col = (q.sort && allowed[q.sort]) || fallback;
  return `${col} ${q.dir === "desc" ? "DESC" : "ASC"} NULLS LAST`;
}

export const uuid = z.string().uuid();
export const idParam = z.object({ id: uuid });
export const nameAr = z.string().trim().min(2).max(200);
export const nameEn = z.string().trim().min(2).max(200);
/** optimistic-locking version sent back by clients on update */
export const versionField = z.coerce.number().int().min(1);
