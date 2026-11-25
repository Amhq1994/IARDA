// Generic approval lifecycle for documents routed through the DoA matrix
// (transfers, adjustments, disposals, returns to vendor). Material requests use services/requests.ts.
import { one, many } from "../db/pool.ts";
import { E } from "../lib/errors.ts";
import { docEvent, notify, type Tx } from "./common.ts";
import { actOnTask, buildChain, createTasks, DOC_LINK, type DocCtx } from "./workflow.ts";

export const DOC_TABLE: Record<string, { table: string; no: string; owner: string; label: [string, string] }> = {
  TR: { table: "transfer_order", no: "tr_no", owner: "requested_by", label: ["طلب نقل", "Transfer"] },
  ADJ: { table: "adjustment", no: "adj_no", owner: "created_by", label: ["تسوية مخزون", "Adjustment"] },
  DSP: { table: "disposal", no: "dsp_no", owner: "recommended_by", label: ["إتلاف/شطب", "Disposal"] },
  RTV: { table: "return_doc", no: "ret_no", owner: "created_by", label: ["إرجاع للمورد", "Return to vendor"] },
};

export async function lockDoc(c: Tx, docType: string, id: string) {
  const m = DOC_TABLE[docType];
  const d = await one(c, `SELECT * FROM ${m.table} WHERE id = $1 FOR UPDATE`, [id]);
  if (!d) throw E.notFound(m.table);
  return d;
}

/** Routes a document through the DoA chain; with no matching rule it is approved directly. */
export async function submitDoc(c: Tx, actorId: string, docType: string, doc: any, ctx: { value: number; warehouseId: string; categoryIds: string[];
  hasCritical?: boolean; requesterId?: string }) {
  const m = DOC_TABLE[docType];
  const requester = ctx.requesterId ?? doc[m.owner] ?? actorId;
  const u = await one(c, "SELECT org_unit_id FROM app_user WHERE id = $1", [requester]);
  const dc: DocCtx = { docType, docId: doc.id, docNo: doc[m.no], requestType: "default", value: Math.abs(ctx.value), orgUnitId: u?.org_unit_id,
    warehouseId: ctx.warehouseId, requesterId: requester, hasCritical: !!ctx.hasCritical, categoryIds: ctx.categoryIds, revision: doc.revision };
  const chain = await buildChain(c, dc);
  await c.query(`UPDATE ${m.table} SET status = $2, status_reason = NULL WHERE id = $1`, [doc.id, chain.length ? "pending_approval" : "approved"]);
  await docEvent(c, docType, doc.id, "submitted", { from: doc.status, to: chain.length ? "pending_approval" : "approved", actorId,
    data: { chain: chain.map((l) => ({ level: l.level, approvers: l.assignees.map((a) => a.userId) })) } });
  if (chain.length) await createTasks(c, dc, chain);
  else await docEvent(c, docType, doc.id, "approved", { to: "approved", actorId, comment: "no DoA rule applies" });
  return { status: chain.length ? "pending_approval" : "approved" };
}

/** Approve / reject / return (assigned approver or delegate). Extra SoD checks can be passed in. */
export async function decideDoc(c: Tx, actorId: string, docType: string, id: string, action: "approve" | "reject" | "return", comment?: string,
  forbidden?: { ids: string[]; rule: string; ar: string; en: string }) {
  const m = DOC_TABLE[docType];
  const doc = await lockDoc(c, docType, id);
  if (doc.status !== "pending_approval") throw E.state(doc.status, action);
  if (action !== "approve" && !(comment && comment.trim().length >= 3)) throw E.invalid([{ path: "comment", message: "reason_required" }]);
  if (forbidden?.ids.includes(actorId)) throw E.sod(forbidden.rule, forbidden.ar, forbidden.en);
  const map = { approve: "approved", reject: "rejected", return: "returned" } as const;
  const r = await actOnTask(c, { docType, docId: id, docNo: doc[m.no], revision: doc.revision }, actorId, map[action], comment);
  await docEvent(c, docType, id, `${map[action]}_l${r.level}`, { actorId, comment });
  const owner = doc[m.owner];
  const link = `${DOC_LINK[docType]}/${id}`;
  if (action === "reject") {
    await c.query(`UPDATE ${m.table} SET status = 'rejected', status_reason = $2 WHERE id = $1`, [id, comment]);
    await notify(c, [owner], { kind: "doc_rejected", titleAr: `رُفض ${m.label[0]} ${doc[m.no]}`, titleEn: `${m.label[1]} ${doc[m.no]} was rejected`, bodyAr: comment, bodyEn: comment, link, docType, docId: id });
  } else if (action === "return") {
    await c.query(`UPDATE ${m.table} SET status = 'draft', status_reason = $2, revision = revision + 1 WHERE id = $1`, [id, comment]);
    await notify(c, [owner], { kind: "doc_returned", titleAr: `أعيد ${m.label[0]} ${doc[m.no]} للتعديل`, titleEn: `${m.label[1]} ${doc[m.no]} returned for revision`, bodyAr: comment, bodyEn: comment, link, docType, docId: id });
  } else if (r.result === "done") {
    await c.query(`UPDATE ${m.table} SET status = 'approved' WHERE id = $1`, [id]);
    await docEvent(c, docType, id, "approved", { from: "pending_approval", to: "approved", actorId });
    await notify(c, [owner], { kind: "doc_approved", titleAr: `اعتُمد ${m.label[0]} ${doc[m.no]}`, titleEn: `${m.label[1]} ${doc[m.no]} approved`, link, docType, docId: id });
  }
  return { status: (await one(c, `SELECT status FROM ${m.table} WHERE id = $1`, [id])).status };
}

export async function approversOfDoc(c: Tx, docType: string, id: string): Promise<string[]> {
  return (await many(c, "SELECT DISTINCT acted_by FROM approval_task WHERE doc_type = $1 AND doc_id = $2 AND status = 'approved'", [docType, id])).map((r) => r.acted_by);
}
