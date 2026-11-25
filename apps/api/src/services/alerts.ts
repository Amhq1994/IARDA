// Daily alerts (once per key per day): below reorder point, expiring / expired lots, critical (V) stock-outs,
// overdue approval reminders, unacknowledged custody. Delivered as in-app notifications (+ e-mail via notify()).
import { many } from "../db/pool.ts";
import { notify, setting, type Tx } from "./common.ts";

async function once(c: Tx, key: string) {
  const r = await c.query("INSERT INTO alert_log (alert_key) VALUES ($1) ON CONFLICT DO NOTHING", [key]);
  return r.rowCount === 1;
}

async function managers(c: Tx, warehouseId: string, roles: string[]) {
  return (await many(c, `SELECT DISTINCT u.id FROM app_user u JOIN user_role ur ON ur.user_id = u.id AND ur.is_active JOIN role r ON r.id = ur.role_id
                         WHERE r.code = ANY($2) AND u.status = 'active' AND (ur.warehouse_ids IS NULL OR $1 = ANY(ur.warehouse_ids))`, [warehouseId, roles])).map((r) => r.id);
}

export async function runAlerts(c: Tx) {
  if ((await setting(c, "alerts.enabled", true)) === false) return { sent: 0 };
  let sent = 0;
  const whs = await many(c, "SELECT id, code, name_ar, name_en FROM warehouse WHERE deleted_at IS NULL");
  for (const w of whs) {
    const below = await many(c, `SELECT i.item_code FROM item_warehouse_policy p JOIN item i ON i.id = p.item_id AND i.status = 'active'
        WHERE p.warehouse_id = $1 AND p.deleted_at IS NULL AND p.reorder_point IS NOT NULL
          AND coalesce((SELECT sum(qty_free) FROM v_pickable_stock s WHERE s.item_id = p.item_id AND s.warehouse_id = p.warehouse_id), 0) <= p.reorder_point`, [w.id]);
    if (below.length && (await once(c, `below_rop:${w.id}`))) {
      await notify(c, await managers(c, w.id, ["PLN", "WM"]), { kind: "alert_reorder", titleAr: `${below.length} صنفاً عند أو دون نقطة إعادة الطلب — ${w.code}`,
        titleEn: `${below.length} items at or below reorder point — ${w.code}`, bodyAr: below.slice(0, 10).map((x) => x.item_code).join("، "),
        bodyEn: below.slice(0, 10).map((x) => x.item_code).join(", "), link: "/planning" });
      sent++;
    }
    const exp = await many(c, `SELECT DISTINCT i.item_code, sl.lot_no, sl.expiry_date FROM stock_balance b JOIN stock_lot sl ON sl.id = b.lot_id JOIN item i ON i.id = b.item_id
        WHERE b.warehouse_id = $1 AND b.qty_on_hand > 0 AND sl.expiry_date <= current_date + 30 ORDER BY sl.expiry_date`, [w.id]);
    if (exp.length && (await once(c, `expiry:${w.id}`))) {
      const expired = exp.filter((e) => new Date(e.expiry_date) <= new Date()).length;
      await notify(c, await managers(c, w.id, ["WM", "SK"]), { kind: "alert_expiry",
        titleAr: `${exp.length} دفعة تنتهي صلاحيتها خلال 30 يوماً (${expired} منتهية) — ${w.code}`,
        titleEn: `${exp.length} lots expire within 30 days (${expired} expired) — ${w.code}`,
        bodyAr: exp.slice(0, 8).map((e) => `${e.item_code} ${e.lot_no ?? ""}`).join("، "), bodyEn: exp.slice(0, 8).map((e) => `${e.item_code} ${e.lot_no ?? ""}`).join(", "),
        link: "/returns?tab=quarantine" });
      sent++;
    }
    for (const v of await many(c, `SELECT i.id, i.item_code, i.name_ar, i.name_en FROM item_warehouse_policy p JOIN item i ON i.id = p.item_id AND i.status = 'active' AND i.ved_class = 'V'
        WHERE p.warehouse_id = $1 AND p.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM v_pickable_stock s WHERE s.item_id = p.item_id AND s.warehouse_id = p.warehouse_id)`, [w.id])) {
      if (!(await once(c, `stockout:${w.id}:${v.id}`))) continue;
      await notify(c, await managers(c, w.id, ["PLN", "WM"]), { kind: "alert_stockout", titleAr: `نفاد صنف حرج: ${v.item_code} — ${w.code}`,
        titleEn: `Critical item out of stock: ${v.item_code} — ${w.code}`, bodyAr: v.name_ar, bodyEn: v.name_en, link: `/items/${v.id}` });
      sent++;
    }
  }
  for (const t of await many(c, `SELECT assignee_id, count(*)::int AS n FROM approval_task WHERE status = 'pending' AND due_at < now() GROUP BY 1`)) {
    if (!(await once(c, `approvals_overdue:${t.assignee_id}`))) continue;
    await notify(c, [t.assignee_id], { kind: "alert_approvals", titleAr: `لديك ${t.n} اعتماد متأخر عن المدة المحددة`, titleEn: `You have ${t.n} overdue approval(s)`, link: "/approvals" });
    sent++;
  }
  for (const h of await many(c, `SELECT holder_id, count(*)::int AS n FROM custody WHERE status = 'active' AND acknowledged_at IS NULL AND issued_at < now() - interval '3 days' GROUP BY 1`)) {
    if (!(await once(c, `custody_ack:${h.holder_id}`))) continue;
    await notify(c, [h.holder_id], { kind: "alert_custody", titleAr: `يرجى الإقرار باستلام ${h.n} عهدة`, titleEn: `Please acknowledge ${h.n} custody item(s)`, link: "/custody?view=mine" });
    sent++;
  }
  return { sent };
}
