-- 010 · Warehouse types for the Authority's five stores: spare parts, cleaning consumables, hospitality consumables,
--        scrap (الهالك — damaged / obsolete stock awaiting disposal) and assets.
ALTER TABLE warehouse DROP CONSTRAINT IF EXISTS warehouse_warehouse_type_check;
ALTER TABLE warehouse ADD CONSTRAINT warehouse_warehouse_type_check
  CHECK (warehouse_type IN ('central','site','spare_parts','consumables','assets','scrap'));
