// In-memory file store standing in for node:fs and node:fs/promises (attachments, generated files).
import { Buffer } from "buffer";

export const files = new Map<string, Uint8Array>();
const norm = (p: unknown) => String(p).replace(/\/+/g, "/");
const notFound = (p: string) => Object.assign(new Error(`ENOENT: no such file ${p}`), { code: "ENOENT" });

export async function mkdir(_p?: string, _o?: unknown) {}
export async function writeFile(p: string, data: string | Uint8Array) {
  files.set(norm(p), typeof data === "string" ? Buffer.from(data) : new Uint8Array(data));
}
export async function readFile(p: string, enc?: string) {
  const b = files.get(norm(p));
  if (!b) throw notFound(p);
  return enc ? Buffer.from(b).toString(enc as any) : Buffer.from(b);
}
/** Removes a file or a directory prefix from the in-memory store. */
export async function rm(p: string, _o?: unknown) {
  const k = norm(p);
  for (const f of [...files.keys()]) if (f === k || f.startsWith(k + "/")) files.delete(f);
}
export async function mkdtemp(prefix: string) { return `${prefix}${Math.random().toString(36).slice(2, 8)}`; }
export function readFileSync(p: string) {
  const b = files.get(norm(p));
  if (!b) throw notFound(p);
  return Buffer.from(b).toString("utf8");
}
export function existsSync(p: string) { return files.has(norm(p)); }
export function readdirSync() { return []; }
export const promises = { mkdir, writeFile, readFile, rm, mkdtemp };
export default { mkdir, writeFile, readFile, rm, mkdtemp, readFileSync, existsSync, readdirSync, promises };
