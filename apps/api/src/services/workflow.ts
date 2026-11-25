// Approval routing: Delegation-of-Authority rules → approval tasks, with time-bound delegation,
// SoD (requester/approver separation, SoD-7 for delegates) and escalation.
import { many, one } from "../db/pool.ts";
import { ApiError } from "../lib/errors.ts";
import { notify, type Tx } from "./common.ts";

/** Where each document type is opened in the web app (notifications link there). */
export const DOC_LINK: Record<string, string> = { MR: "/requests", TR: "/transfers", ADJ: "/adjustments", DSP: "/disposals", RTV: "/returns" };

export interface DocCtx {
  docType: string; docId: string; docNo: string; requestType: string; value: number; orgUnitId: string; warehouseId: string;
  requesterId: string; hasCritical: boolean; categoryIds: string[]; revision: number;
}

interface Level { level: number; assignees: { userId: string; ruleId: string; slaHours: number }[]; anyOne: boolean }

async function usersWithRole(c: Tx, role: string, filter: { orgUnitId?: string; warehouseId?: string } = {}) {
  return many(c,
    `SELECT u.id, u.org_unit_id FROM app_user u
       JOIN user_role ur ON ur.user_id = u.id AND ur.is_active AND ur.valid_from <= current_date AND (ur.valid_to IS NULL OR ur.valid_to >= current_date)
       JOIN role r ON r.id = ur.role_id AND r.code = $1
      WHERE u.status = 'active' AND u.deleted_at IS NULL
        AND ($2::uuid IS NULL OR u.org_unit_id = $2)
        AND ($3::uuid IS NULL OR ur.warehouse_ids IS NULL OR $3 = ANY(ur.warehouse_ids))
      ORDER BY u.username`, [role, filter.orgUnitId ?? null, filter.warehouseId ?? null]);
}

async function resolveRuleAssignees(c: Tx, rule: any, d: DocCtx): Promise<string[]> {
  switch (rule.approver_kind) {
    case "user": return rule.approver_user_id ? [rule.approver_user_id] : [];
    case "role": return (await usersWithRole(c, rule.approver_role)).map((u) => u.id).slice(0, 1);
    case "warehouse_manager": {
      const wh = await one(c, "SELECT manager_user_id FROM warehouse WHERE id = $1", [d.warehouseId]);
      const wms = await usersWithRole(c, "WM", { warehouseId: d.warehouseId });
      const pref = wms.find((u) => u.id === wh?.manager_user_id);
      return [(pref ?? wms[0])?.id].filter(Boolean);
    }
    case "department_manager": {
      const dms = await usersWithRole(c, "DM", { orgUnitId: d.orgUnitId });
      if (dms.length) return [dms[0].id];
      const req = await one(c, "SELECT manager_id FROM app_user WHERE id = $1", [d.requesterId]);
      return req?.manager_id ? [req.manager_id] : [];
    }
    default: return [];
  }
}

/** Builds the approval chain for a document from the active DoA rules. */
export async function buildChain(c: Tx, d: DocCtx): Promise<Level[]> {
  const rules = await many(c,
    `SELECT * FROM doa_rule WHERE deleted_at IS NULL AND is_active AND doc_type = $1
        AND (request_types IS NULL OR $2 = ANY(request_types))
        AND min_value <= $3 AND (max_value IS NULL OR $3 <= max_value)
        AND (NOT critical_only OR $4)
        AND (org_unit_ids IS NULL OR $5 = ANY(org_unit_ids))
        AND (category_ids IS NULL OR category_ids && $6::uuid[])
      ORDER BY level, id`, [d.docType, d.requestType, d.value, d.hasCritical, d.orgUnitId, d.categoryIds]);
  const byLevel = new Map<number, Level>();
  const requester = await one(c, "SELECT manager_id FROM app_user WHERE id = $1", [d.requesterId]);
  for (const rule of rules) {
    let ids = await resolveRuleAssignees(c, rule, d);
    // SoD-1: a requester never approves their own request → route to their manager, else the warehouse manager
    ids = await Promise.all(ids.map(async (id) => {
      if (id !== d.requesterId) return id;
      if (requester?.manager_id && requester.manager_id !== d.requesterId) return requester.manager_id;
      const wm = (await resolveRuleAssignees(c, { approver_kind: "warehouse_manager" }, d))[0];
      if (wm && wm !== d.requesterId) return wm;
      // last resort: another holder of the same role (e.g. the other warehouse manager) — never the requester
      const role = rule.approver_kind === "department_manager" ? "DM" : rule.approver_kind === "warehouse_manager" ? "WM" : rule.approver_role;
      return role ? (await usersWithRole(c, role)).map((u) => u.id).find((u) => u !== d.requesterId) : undefined;
    }));
    ids = ids.filter((id) => id && id !== d.requesterId);
    if (!ids.length) {
      throw new ApiError(409, "no_approver", "لا يوجد معتمد متاح وفق مصفوفة الصلاحيات", "No approver could be resolved from the DoA matrix",
        { level: rule.level, kind: rule.approver_kind });
    }
    const lvl: Level = byLevel.get(rule.level) ?? { level: rule.level, assignees: [], anyOne: !!rule.parallel_group };
    lvl.anyOne = lvl.anyOne && !!rule.parallel_group;
    for (const id of ids) if (!lvl.assignees.some((a) => a.userId === id)) lvl.assignees.push({ userId: id, ruleId: rule.id, slaHours: rule.sla_hours });
    byLevel.set(rule.level, lvl);
  }
  // an approver who already approves at a lower level is not asked again at a higher level
  const levels = [...byLevel.values()].sort((a, b) => a.level - b.level);
  const seen = new Set<string>();
  for (const l of levels) {
    l.assignees = l.assignees.filter((a) => !seen.has(a.userId));
    l.assignees.forEach((a) => seen.add(a.userId));
  }
  return levels.filter((l) => l.assignees.length);
}

/** Active, time-bound delegation for an approver (SoD-7: never to the requester). */
export async function delegateOf(c: Tx, userId: string, d: Pick<DocCtx, "docType" | "value" | "requesterId">) {
  return one(c,
    `SELECT * FROM delegation WHERE from_user_id = $1 AND status = 'active' AND now() BETWEEN valid_from AND valid_to
        AND (doc_types IS NULL OR $2 = ANY(doc_types)) AND (max_value IS NULL OR max_value >= $3) AND to_user_id <> $4
      ORDER BY valid_from DESC LIMIT 1`, [userId, d.docType, d.value, d.requesterId]);
}

export async function createTasks(c: Tx, d: DocCtx, levels: Level[]) {
  for (const [i, l] of levels.entries()) {
    for (const a of l.assignees) {
      const dlg = await delegateOf(c, a.userId, d);
      const assignee = dlg?.to_user_id ?? a.userId;
      await c.query(
        `INSERT INTO approval_task (doc_type, doc_id, revision, level, rule_id, assignee_id, original_assignee_id, delegation_id, status, due_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $9 = 'pending' THEN now() + make_interval(hours => $10) END)`,
        [d.docType, d.docId, d.revision, l.level, a.ruleId, assignee, dlg ? a.userId : null, dlg?.id ?? null, i === 0 ? "pending" : "waiting", a.slaHours]);
    }
  }
  if (levels[0]) await notifyPending(c, d, levels[0].level);
}

export async function notifyPending(c: Tx, d: Pick<DocCtx, "docType" | "docId" | "docNo" | "revision">, level: number) {
  const ids = (await many(c, "SELECT assignee_id FROM approval_task WHERE doc_type = $1 AND doc_id = $2 AND revision = $3 AND level = $4 AND status = 'pending'",
    [d.docType, d.docId, d.revision, level])).map((r) => r.assignee_id);
  await notify(c, ids, { kind: "approval_required", titleAr: `طلب بانتظار اعتمادك — ${d.docNo}`, titleEn: `Request awaiting your approval — ${d.docNo}`,
    link: `${DOC_LINK[d.docType] ?? "/requests"}/${d.docId}`, docType: d.docType, docId: d.docId });
}

/** Marks the actor's task; returns "next" (another level opened), "done" (chain complete) or "waiting" (same level still open). */
export async function actOnTask(c: Tx, d: Pick<DocCtx, "docType" | "docId" | "docNo" | "revision">, actorId: string,
  action: "approved" | "rejected" | "returned", comment?: string): Promise<{ result: "next" | "done" | "waiting" | "terminal"; level: number }> {
  const task = await one(c,
    `SELECT * FROM approval_task WHERE doc_type = $1 AND doc_id = $2 AND revision = $3 AND status = 'pending' AND assignee_id = $4
      ORDER BY level LIMIT 1 FOR UPDATE`, [d.docType, d.docId, d.revision, actorId]);
  if (!task) {
    throw new ApiError(403, "not_your_approval", "لا توجد مهمة اعتماد مسندة إليك لهذا الطلب", "There is no pending approval assigned to you for this request");
  }
  await c.query("UPDATE approval_task SET status = $2, acted_by = $3, acted_at = now(), comment = $4 WHERE id = $1", [task.id, action, actorId, comment ?? null]);
  if (action !== "approved") {
    await c.query(`UPDATE approval_task SET status = 'cancelled' WHERE doc_type = $1 AND doc_id = $2 AND revision = $3 AND status IN ('pending','waiting')`,
      [d.docType, d.docId, d.revision]);
    return { result: "terminal", level: task.level };
  }
  const lvl = await many(c, `SELECT t.*, r.parallel_group FROM approval_task t LEFT JOIN doa_rule r ON r.id = t.rule_id
                              WHERE t.doc_type = $1 AND t.doc_id = $2 AND t.revision = $3 AND t.level = $4`, [d.docType, d.docId, d.revision, task.level]);
  const anyOne = lvl.every((t) => t.parallel_group || t.is_escalation) || task.is_escalation;
  const stillOpen = lvl.filter((t) => t.status === "pending" && !t.is_escalation);
  if (anyOne || stillOpen.length === 0) {
    await c.query(`UPDATE approval_task SET status = 'skipped' WHERE doc_type = $1 AND doc_id = $2 AND revision = $3 AND level = $4 AND status = 'pending'`,
      [d.docType, d.docId, d.revision, task.level]);
    const next = await one(c, `SELECT min(level) AS l FROM approval_task WHERE doc_type = $1 AND doc_id = $2 AND revision = $3 AND status = 'waiting'`,
      [d.docType, d.docId, d.revision]);
    if (next?.l == null) return { result: "done", level: task.level };
    await c.query(`UPDATE approval_task t SET status = 'pending', due_at = now() + make_interval(hours => coalesce(r.sla_hours, 24))
                     FROM doa_rule r WHERE r.id = t.rule_id AND t.doc_type = $1 AND t.doc_id = $2 AND t.revision = $3 AND t.level = $4 AND t.status = 'waiting'`,
      [d.docType, d.docId, d.revision, next.l]);
    await notifyPending(c, d, next.l);
    return { result: "next", level: next.l };
  }
  return { result: "waiting", level: task.level };
}
