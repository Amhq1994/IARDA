// @node-rs/argon2 stand-in: salted SHA-256 for the demo only (the server build keeps Argon2id).
import { createHash } from "node:crypto";

export async function hash(pw: string) {
  const salt = Math.random().toString(36).slice(2, 10);
  return `demo$${salt}$${createHash("sha256").update(salt + pw).digest("hex")}`;
}
export async function verify(h: string, pw: string) {
  const [k, salt, d] = String(h).split("$");
  return k === "demo" && createHash("sha256").update(salt + pw).digest("hex") === d;
}
export default { hash, verify };
