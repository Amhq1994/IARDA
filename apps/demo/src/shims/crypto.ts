// Browser implementation of the node:crypto subset the WMS uses (synchronous, same output formats as Node,
// so data encrypted by the snapshot build in Node decrypts in the browser).
import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha256";
import { sha1 } from "@noble/hashes/sha1";
import { hmac } from "@noble/hashes/hmac";
import { gcm } from "@noble/ciphers/aes";

const toBytes = (d: string | Uint8Array, enc?: string) => (typeof d === "string" ? Buffer.from(d, (enc as any) ?? "utf8") : d);
const algo = (a: string) => {
  const x = a.toLowerCase();
  if (x === "sha256") return sha256;
  if (x === "sha1") return sha1;
  throw new Error(`hash ${a} not available in demo`);
};
const out = (b: Uint8Array, enc?: string) => (enc ? Buffer.from(b).toString(enc as any) : Buffer.from(b));

export function createHash(a: string) {
  const parts: Uint8Array[] = [];
  const h = {
    update(d: string | Uint8Array, enc?: string) { parts.push(toBytes(d, enc)); return h; },
    digest(enc?: string) { return out(algo(a)(Buffer.concat(parts)), enc); },
  };
  return h;
}
export function createHmac(a: string, key: string | Uint8Array) {
  const parts: Uint8Array[] = [];
  const h = {
    update(d: string | Uint8Array, enc?: string) { parts.push(toBytes(d, enc)); return h; },
    digest(enc?: string) { return out(hmac(algo(a), toBytes(key), Buffer.concat(parts)), enc); },
  };
  return h;
}
export function randomBytes(n: number) { const b = Buffer.alloc(n); globalThis.crypto.getRandomValues(b); return b; }
export function randomUUID() { return globalThis.crypto.randomUUID(); }
export function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

export function createCipheriv(_alg: string, key: Uint8Array, iv: Uint8Array) {
  const parts: Uint8Array[] = [];
  let tag: Buffer = Buffer.alloc(0);
  return {
    update(d: Uint8Array) { parts.push(d); return Buffer.alloc(0); },
    final() {
      const ct = gcm(key, iv).encrypt(Buffer.concat(parts));
      tag = Buffer.from(ct.subarray(ct.length - 16));
      return Buffer.from(ct.subarray(0, ct.length - 16));
    },
    getAuthTag() { return tag; },
  };
}
export function createDecipheriv(_alg: string, key: Uint8Array, iv: Uint8Array) {
  const parts: Uint8Array[] = [];
  let tag: Uint8Array = new Uint8Array(0);
  return {
    setAuthTag(t: Uint8Array) { tag = t; },
    update(d: Uint8Array) { parts.push(d); return Buffer.alloc(0); },
    final() { return Buffer.from(gcm(key, iv).decrypt(Buffer.concat([...parts, tag]))); },
  };
}
export default { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual, createCipheriv, createDecipheriv };
