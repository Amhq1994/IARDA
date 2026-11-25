// Put-away suggestions: capacity (weight/volume), compatibility (hazmat, temperature, mixing),
// velocity match, consolidation with the same item, preferred bin, best fit.
import { many, one, type Db } from "../db/pool.ts";

export interface Suggestion {
  locationId: string; fullCode: string; score: number;
  reasons: { key: string; points: number }[];
  freeWeightKg: number | null; freeVolumeM3: number | null;
}

const VELOCITY_BY_VED: Record<string, string> = { V: "fast", E: "medium", D: "slow" };
const RANK: Record<string, number> = { fast: 0, medium: 1, slow: 2 };

export async function suggestBins(db: Db, args: { itemId: string; warehouseId: string; qty: number; excludeLocationId?: string; limit?: number; taskId?: string }): Promise<Suggestion[]> {
  const item = await one(db, `SELECT i.*, g.parent_id AS category_id, c.code AS category_code, c.is_critical
                                FROM item i JOIN item_category g ON g.id = i.group_id JOIN item_category c ON c.id = g.parent_id WHERE i.id = $1`, [args.itemId]);
  if (!item) return [];
  const policy = await one(db, "SELECT preferred_location_id FROM item_warehouse_policy WHERE item_id = $1 AND warehouse_id = $2 AND deleted_at IS NULL",
    [args.itemId, args.warehouseId]);
  const needWeight = args.qty * Number(item.unit_weight_kg ?? 0);
  const needVolume = args.qty * Number(item.unit_volume_m3 ?? 0);
  const hazardous = !!item.hazard_class;
  const cold = item.category_code === "VET" || /2\s*[–-]\s*8|مبرد|cold/i.test(item.storage_conditions ?? "");
  const velocity = item.abc_class === "A" ? "fast" : item.abc_class === "C" ? "slow" : VELOCITY_BY_VED[item.ved_class ?? ""] ?? "medium";

  const bins = await many(db,
    `SELECT l.id, l.full_code, l.max_weight_kg, l.max_volume_m3, l.current_weight_kg, l.current_volume_m3, l.velocity_class,
            l.hazmat_allowed, l.temperature_controlled, l.mixed_items_allowed, z.zone_type, z.temperature_controlled AS zone_cold,
            coalesce((SELECT sum(b.qty_on_hand) FROM stock_balance b WHERE b.location_id = l.id AND b.item_id = $2), 0) AS same_qty,
            (SELECT count(DISTINCT b.item_id) FROM stock_balance b WHERE b.location_id = l.id AND b.qty_on_hand > 0 AND b.item_id <> $2) AS other_items,
            -- capacity already promised to open put-away tasks heading to this bin (so one receipt's tasks don't all pick the same bin)
            coalesce((SELECT sum(t.qty * coalesce(ti.unit_weight_kg, 0)) FROM putaway_task t JOIN item ti ON ti.id = t.item_id
                       WHERE t.suggested_location_id = l.id AND t.status = 'open' AND t.id IS DISTINCT FROM $4::uuid), 0) AS planned_w,
            coalesce((SELECT sum(t.qty * coalesce(ti.unit_volume_m3, 0)) FROM putaway_task t JOIN item ti ON ti.id = t.item_id
                       WHERE t.suggested_location_id = l.id AND t.status = 'open' AND t.id IS DISTINCT FROM $4::uuid), 0) AS planned_v
       FROM location l
       JOIN location r ON r.id = l.parent_id JOIN location a ON a.id = r.parent_id JOIN location z ON z.id = a.parent_id
      WHERE l.warehouse_id = $1 AND l.level = 'bin' AND NOT l.is_blocked AND l.deleted_at IS NULL
        AND z.zone_type IN ('storage','picking') AND ($3::uuid IS NULL OR l.id <> $3)`,
    [args.warehouseId, args.itemId, args.excludeLocationId ?? null, args.taskId ?? null]);
  const anyCold = bins.some((b) => b.temperature_controlled || b.zone_cold);

  const out: Suggestion[] = [];
  for (const b of bins) {
    const freeW = b.max_weight_kg == null ? null : Number(b.max_weight_kg) - Number(b.current_weight_kg) - Number(b.planned_w);
    const freeV = b.max_volume_m3 == null ? null : Number(b.max_volume_m3) - Number(b.current_volume_m3) - Number(b.planned_v);
    if (freeW != null && needWeight > freeW + 1e-9) continue;
    if (freeV != null && needVolume > freeV + 1e-9) continue;
    if (hazardous && !b.hazmat_allowed) continue;
    if (!b.mixed_items_allowed && b.other_items > 0) continue;
    const isCold = b.temperature_controlled || b.zone_cold;
    if (cold && anyCold && !isCold) continue;           // cold-chain items go to cold bins when the warehouse has them
    const reasons: { key: string; points: number }[] = [];
    if (policy?.preferred_location_id === b.id) reasons.push({ key: "preferred_bin", points: 50 });
    if (b.same_qty > 0) reasons.push({ key: "consolidate_same_item", points: 30 });
    else if (b.other_items === 0) reasons.push({ key: "empty_bin", points: 5 });
    if (b.velocity_class) {
      const d = Math.abs(RANK[b.velocity_class] - RANK[velocity]);
      if (d === 0) reasons.push({ key: `velocity_${velocity}`, points: 20 }); else if (d === 1) reasons.push({ key: "velocity_near", points: 8 });
    }
    if (velocity === "fast" && b.zone_type === "picking") reasons.push({ key: "fast_mover_picking_zone", points: 6 });
    if (!hazardous && b.hazmat_allowed) reasons.push({ key: "keep_hazmat_bins_free", points: -6 });
    if (!cold && isCold) reasons.push({ key: "keep_cold_bins_free", points: -10 });
    if (freeV != null && b.max_volume_m3 > 0 && needVolume > 0) {
      const fill = needVolume / freeV;                  // best fit: prefer bins this load fills well
      reasons.push({ key: "best_fit", points: Math.round(10 * Math.min(1, fill)) });
    }
    out.push({ locationId: b.id, fullCode: b.full_code, score: reasons.reduce((s, r) => s + r.points, 0), reasons, freeWeightKg: freeW, freeVolumeM3: freeV });
  }
  out.sort((x, y) => y.score - x.score || x.fullCode.localeCompare(y.fullCode));
  return out.slice(0, args.limit ?? 3);
}

/** Validates a bin chosen/scanned by the operator for a given item & quantity. */
export async function validateBin(db: Db, args: { itemId: string; warehouseId: string; locationId: string; qty: number; taskId?: string }) {
  const ok = await suggestBins(db, { ...args, limit: 10_000 });
  return ok.find((s) => s.locationId === args.locationId) ?? null;
}
