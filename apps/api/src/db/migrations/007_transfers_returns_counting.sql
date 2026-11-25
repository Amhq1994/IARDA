-- 007 · Transfers (bin-to-bin, inter-warehouse with in-transit), returns (to warehouse, to vendor),
--        quarantine, stock counting (annual / cycle-ABC / surprise / blind), adjustments, disposals.

-- ------------------------------------------------------------------ transfers
CREATE TABLE transfer_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tr_no text NOT NULL UNIQUE,
  from_warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  to_warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  requested_by uuid NOT NULL REFERENCES app_user(id),
  reason text,
  needed_by date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','rejected','in_transit','received','closed','cancelled')),
  status_reason text,
  estimated_value numeric(18,2) NOT NULL DEFAULT 0,
  revision int NOT NULL DEFAULT 0,
  shipped_at timestamptz, shipped_by uuid REFERENCES app_user(id),
  received_at timestamptz, received_by uuid REFERENCES app_user(id),
  has_discrepancy boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  CHECK (from_warehouse_id <> to_warehouse_id)
);

CREATE TABLE transfer_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES transfer_order(id),
  line_no int NOT NULL,
  item_id uuid NOT NULL REFERENCES item(id),
  qty_requested numeric(18,4) NOT NULL CHECK (qty_requested > 0),
  qty_shipped numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_shipped >= 0),
  qty_received numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (transfer_id, line_no)
);

-- what physically left the source (per bin / lot) and sits in transit at the destination dock
CREATE TABLE transfer_shipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_line_id uuid NOT NULL REFERENCES transfer_line(id),
  item_id uuid NOT NULL REFERENCES item(id),
  lot_id uuid REFERENCES stock_lot(id),
  from_location_id uuid NOT NULL REFERENCES location(id),
  transit_location_id uuid NOT NULL REFERENCES location(id),
  qty numeric(18,4) NOT NULL CHECK (qty > 0),
  qty_received numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  unit_cost numeric(18,6) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  CHECK (qty_received <= qty)
);

-- ------------------------------------------------------------------ returns
CREATE TABLE return_doc (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ret_no text NOT NULL UNIQUE,
  return_type text NOT NULL CHECK (return_type IN ('to_warehouse','to_vendor')),
  warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  org_unit_id uuid REFERENCES org_unit(id),
  returned_by uuid REFERENCES app_user(id),
  supplier_id uuid REFERENCES supplier(id),
  mr_id uuid REFERENCES material_request(id),
  receipt_id uuid REFERENCES receipt(id),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','rejected','received','shipped','closed','cancelled')),
  status_reason text,
  credit_note_ref text,
  estimated_value numeric(18,2) NOT NULL DEFAULT 0,
  revision int NOT NULL DEFAULT 0,
  posted_at timestamptz, posted_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  CHECK (return_type <> 'to_vendor' OR supplier_id IS NOT NULL)
);

CREATE TABLE return_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES return_doc(id),
  line_no int NOT NULL,
  item_id uuid NOT NULL REFERENCES item(id),
  qty numeric(18,4) NOT NULL CHECK (qty > 0),
  lot_id uuid REFERENCES stock_lot(id),             -- RTV: the stock being sent back; RTW: resolved at receipt
  lot_no text, serial_no text,                      -- RTW: as declared by the returner
  condition text CHECK (condition IN ('good','quarantine','damaged')),
  from_location_id uuid REFERENCES location(id),    -- RTV source bin
  from_status text,                                 -- RTV source stock status
  to_location_id uuid REFERENCES location(id),      -- RTW destination bin
  unit_cost numeric(18,6),
  ledger_id bigint,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (return_id, line_no)
);

ALTER TABLE putaway_task ADD COLUMN return_id uuid REFERENCES return_doc(id);
ALTER TABLE putaway_task ADD COLUMN transfer_id uuid REFERENCES transfer_order(id);
ALTER TABLE putaway_task ADD COLUMN stock_status text NOT NULL DEFAULT 'available';

-- ------------------------------------------------------------------ stock counting
CREATE TABLE count_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_no text NOT NULL UNIQUE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  count_type text NOT NULL CHECK (count_type IN ('annual','cycle','surprise')),
  blind boolean NOT NULL DEFAULT true,
  abc_classes text[],
  zone_ids uuid[],
  item_ids uuid[],
  sample_size int,
  counter_ids uuid[] NOT NULL DEFAULT '{}',
  scheduled_for date NOT NULL DEFAULT current_date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','counting','review','closed','cancelled')),
  released_at timestamptz, released_by uuid REFERENCES app_user(id),
  reviewed_at timestamptz, reviewed_by uuid REFERENCES app_user(id),
  closed_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);

CREATE TABLE count_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES count_plan(id),
  item_id uuid NOT NULL REFERENCES item(id),
  location_id uuid NOT NULL REFERENCES location(id),
  lot_id uuid REFERENCES stock_lot(id),
  stock_status text NOT NULL DEFAULT 'available',
  qty_snapshot numeric(18,4) NOT NULL DEFAULT 0,
  qty_count1 numeric(18,4) CHECK (qty_count1 IS NULL OR qty_count1 >= 0),
  qty_system1 numeric(18,4), counted1_by uuid REFERENCES app_user(id), counted1_at timestamptz,
  qty_count2 numeric(18,4) CHECK (qty_count2 IS NULL OR qty_count2 >= 0),
  qty_system2 numeric(18,4), counted2_by uuid REFERENCES app_user(id), counted2_at timestamptz,
  final_qty numeric(18,4),
  variance_qty numeric(18,4),
  variance_value numeric(18,2),
  unit_cost numeric(18,6),
  within_tolerance boolean,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','counted','recount','final')),
  is_unplanned boolean NOT NULL DEFAULT false,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  CHECK (counted2_by IS NULL OR counted2_by <> counted1_by)        -- recount by a different person
);
CREATE INDEX count_line_plan_idx ON count_line (plan_id, status);
CREATE INDEX count_line_item_idx ON count_line (item_id, counted1_at);

-- ------------------------------------------------------------------ adjustments
CREATE TABLE adjustment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adj_no text NOT NULL UNIQUE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  source text NOT NULL CHECK (source IN ('count','manual','transit','quarantine')),
  count_plan_id uuid REFERENCES count_plan(id),
  transfer_id uuid REFERENCES transfer_order(id),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','rejected','posted','cancelled')),
  status_reason text,
  value_abs numeric(18,2) NOT NULL DEFAULT 0,
  value_net numeric(18,2) NOT NULL DEFAULT 0,
  revision int NOT NULL DEFAULT 0,
  posted_at timestamptz, posted_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);

CREATE TABLE adjustment_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adjustment_id uuid NOT NULL REFERENCES adjustment(id),
  count_line_id uuid REFERENCES count_line(id),
  item_id uuid NOT NULL REFERENCES item(id),
  location_id uuid NOT NULL REFERENCES location(id),
  lot_id uuid REFERENCES stock_lot(id),
  stock_status text NOT NULL DEFAULT 'available',
  qty_delta numeric(18,4) NOT NULL CHECK (qty_delta <> 0),
  unit_cost numeric(18,6) NOT NULL DEFAULT 0,
  value numeric(18,2) NOT NULL DEFAULT 0,
  reason text,
  ledger_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);

-- ------------------------------------------------------------------ disposals / write-offs
CREATE TABLE disposal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dsp_no text NOT NULL UNIQUE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  method text NOT NULL CHECK (method IN ('scrap','sell','donate','recycle')),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','rejected','posted','cancelled')),
  status_reason text,
  committee_ids uuid[] NOT NULL DEFAULT '{}',
  recommended_by uuid REFERENCES app_user(id),
  recommended_at timestamptz,
  total_value numeric(18,2) NOT NULL DEFAULT 0,
  proceeds numeric(18,2),
  revision int NOT NULL DEFAULT 0,
  posted_at timestamptz, posted_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);

CREATE TABLE disposal_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  disposal_id uuid NOT NULL REFERENCES disposal(id),
  item_id uuid NOT NULL REFERENCES item(id),
  location_id uuid NOT NULL REFERENCES location(id),
  lot_id uuid REFERENCES stock_lot(id),
  stock_status text NOT NULL,
  qty numeric(18,4) NOT NULL CHECK (qty > 0),
  unit_cost numeric(18,6) NOT NULL DEFAULT 0,
  value numeric(18,2) NOT NULL DEFAULT 0,
  ledger_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['transfer_order','transfer_line','transfer_shipment','return_doc','return_line','count_plan','count_line',
                           'adjustment','adjustment_line','disposal','disposal_line'] LOOP
    PERFORM attach_standard_triggers(t, true);
  END LOOP;
END $$;

-- ------------------------------------------------------------------ ABC classification
-- A/B/C by 12-month issue value (Pareto 80 / 95 %); when no consumption exists yet, current stock value is used.
CREATE OR REPLACE FUNCTION classify_abc() RETURNS TABLE (a int, b int, c int, basis text) LANGUAGE plpgsql AS $$
DECLARE v_basis text;
BEGIN
  CREATE TEMP TABLE _abc ON COMMIT DROP AS
    SELECT i.id, coalesce((SELECT -sum(s.value) FROM stock_ledger s WHERE s.item_id = i.id AND s.movement_type = 'GI' AND s.posted_at > now() - interval '365 days'), 0) AS metric
      FROM item i WHERE i.deleted_at IS NULL AND i.item_type <> 'non_stock';
  v_basis := 'issue_value_12m';
  -- too little consumption history (new system / go-live) → classify by stock value instead
  IF (SELECT count(*) FROM _abc WHERE metric > 0) < greatest(10, (SELECT count(*) FROM _abc) * 0.3) THEN
    UPDATE _abc SET metric = coalesce((SELECT sum(v.total_value) FROM item_valuation v WHERE v.item_id = _abc.id), 0);
    v_basis := 'stock_value';
  END IF;
  WITH ranked AS (
    -- cumulative share *before* this item, so the top item is always A
    SELECT id, metric, (sum(metric) OVER (ORDER BY metric DESC, id) - metric) / nullif(sum(metric) OVER (), 0) AS cum FROM _abc)
  UPDATE item i SET abc_class = CASE WHEN r.metric <= 0 THEN 'C' WHEN r.cum < 0.80 THEN 'A' WHEN r.cum < 0.95 THEN 'B' ELSE 'C' END,
                    classes_computed_at = now()
    FROM ranked r WHERE r.id = i.id AND i.abc_class IS DISTINCT FROM (CASE WHEN r.metric <= 0 THEN 'C' WHEN r.cum < 0.80 THEN 'A' WHEN r.cum < 0.95 THEN 'B' ELSE 'C' END);
  RETURN QUERY SELECT count(*) FILTER (WHERE abc_class = 'A')::int, count(*) FILTER (WHERE abc_class = 'B')::int,
                      count(*) FILTER (WHERE abc_class = 'C')::int, v_basis FROM item WHERE deleted_at IS NULL AND item_type <> 'non_stock';
END $$;
