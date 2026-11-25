// Shared domain helpers: document numbers, posting-engine wrappers, notifications, document events.
import type pg from "pg";
import { one } from "../db/pool.ts";
import { queueEmails } from "./mailer.ts";

export type Tx = pg.PoolClient;

const PREFIX: Record<string, string> = {
  MR: "MR", PO: "PO", ASN: "ASN", RCV: "RCV", GRN: "GRN", PUT: "PUT", PCK: "PCK", DN: "DN", INV: "INV",
  TR: "TR", ADJ: "ADJ", RET: "RET", RTV: "RTV", CNT: "CNT", DSP: "DSP",
  PLN: "PLN", PR: "PR", JE: "JE", PRV: "PRV", CUS: "CUS", CL: "CL", CRT: "CRT",
};

export function hijriYear(d = new Date()): string {
  return new Intl.DateTimeFormat("en-u-ca-islamic-umalqura-nu-latn", { year: "numeric" }).format(d).replace(/\D/g, "");
}

/** Gap-free per-type, per-Hijri-year numbering: {TYPE}-{HIJRI_YEAR}-{SEQ6}. */
export async function nextDocNo(c: Tx, type: keyof typeof PREFIX): Promise<string> {
  const period = hijriYear();
  const r = await one(c,
    `INSERT INTO number_sequence (doc_type, period, prefix, next_no) VALUES ($1, $2, $3, 2)
     ON CONFLICT (doc_type, period) DO UPDATE SET next_no = number_sequence.next_no + 1
     RETURNING next_no - 1 AS n`, [type, period, PREFIX[type]]);
  return `${PREFIX[type]}-${period}-${String(r.n).padStart(6, "0")}`;
}

export interface PostArgs {
  docType: string; docId?: string | null; docNo?: string | null; docLineId?: string | null; movement: string;
  itemId: string; locationId: string; lotId?: string | null; status?: string; qty: number;
  unitCost?: number | null; reservationId?: string | null; notes?: string | null;
}

/** The only way quantities change (I-1). Returns the stock_ledger id. */
export async function post(c: Tx, a: PostArgs): Promise<number> {
  const r = await one(c, "SELECT wms_post($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS id", [
    a.docType, a.docId ?? null, a.docNo ?? null, a.docLineId ?? null, a.movement, a.itemId, a.locationId, a.lotId ?? null,
    a.status ?? "available", a.qty, a.unitCost ?? null, a.reservationId ?? null, a.notes ?? null,
  ]);
  return r.id;
}

export async function reserve(c: Tx, balanceId: string, qty: number, sourceType: string, sourceId: string, sourceLineId?: string): Promise<string> {
  return (await one(c, "SELECT wms_reserve($1,$2,$3,$4,$5) AS id", [balanceId, qty, sourceType, sourceId, sourceLineId ?? null])).id;
}

export async function release(c: Tx, reservationId: string): Promise<number> {
  return (await one(c, "SELECT wms_release($1) AS q", [reservationId])).q;
}

export async function docEvent(c: Tx, docType: string, docId: string, event: string,
  opts: { from?: string | null; to?: string | null; actorId?: string | null; comment?: string | null; data?: unknown } = {}) {
  await c.query(
    `INSERT INTO doc_event (doc_type, doc_id, event, from_status, to_status, actor_id, on_behalf_of, comment, data)
     VALUES ($1,$2,$3,$4,$5,$6, app_on_behalf_of(), $7, $8)`,
    [docType, docId, event, opts.from ?? null, opts.to ?? null, opts.actorId ?? null, opts.comment ?? null, opts.data ? JSON.stringify(opts.data) : null]);
}

export interface Note { kind: string; titleAr: string; titleEn: string; bodyAr?: string; bodyEn?: string; link?: string; docType?: string; docId?: string }

export async function notify(c: Tx, userIds: (string | null | undefined)[], n: Note) {
  const ids = [...new Set(userIds.filter(Boolean) as string[])];
  for (const id of ids) {
    await c.query(
      `INSERT INTO notification (user_id, kind, title_ar, title_en, body_ar, body_en, link, doc_type, doc_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, n.kind, n.titleAr, n.titleEn, n.bodyAr ?? null, n.bodyEn ?? null, n.link ?? null, n.docType ?? null, n.docId ?? null]);
  }
  if (ids.length) await queueEmails(c, ids, n);
}

export async function setting<T = any>(c: Tx | pg.Pool, key: string, fallback: T): Promise<T> {
  const r = await one(c, "SELECT value FROM setting WHERE key = $1", [key]);
  return (r?.value ?? fallback) as T;
}

/** Resolves a scanned/typed location code (barcode or full code). */
export async function findLocation(c: Tx, code: string, warehouseId?: string) {
  return one(c, `SELECT * FROM location WHERE deleted_at IS NULL AND (barcode = $1 OR full_code = upper($1)) ${warehouseId ? "AND warehouse_id = $2" : ""} LIMIT 1`,
    warehouseId ? [code, warehouseId] : [code]);
}

/** Resolves a scanned item code / barcode / QR / unit barcode to an item id. */
export async function findItemId(c: Tx, code: string): Promise<string | null> {
  const r = await one(c,
    `SELECT id FROM item WHERE deleted_at IS NULL AND item_code = $1
     UNION ALL SELECT item_id FROM item_identifier WHERE deleted_at IS NULL AND value = $1
     UNION ALL SELECT item_id FROM item_uom_conversion WHERE deleted_at IS NULL AND barcode = $1 LIMIT 1`, [code]);
  return r?.id ?? null;
}

export const round4 = (n: number) => Math.round(n * 10000) / 10000;
