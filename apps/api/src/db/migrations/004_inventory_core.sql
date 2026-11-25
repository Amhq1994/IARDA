-- 004 · Inventory core: lots, balances, append-only stock ledger, weighted-average valuation,
--        reservations, and the posting engine.
--
-- Invariants (docs/wms/01-design.md §1.1):
--   I-1 quantities change only through wms_post() — the runtime role has SELECT only on
--       stock_balance / stock_ledger / item_valuation / reservation;
--   I-2 no negative stock (explicit checks + CHECK constraints, rows locked FOR UPDATE);
--   I-3 the ledger is append-only.

-- ------------------------------------------------------------------ lots / serials
CREATE TABLE stock_lot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES item(id),
  lot_no text,
  serial_no text,
  mfg_date date,
  expiry_date date,
  supplier_id uuid REFERENCES supplier(id),
  source_doc text,
  status text NOT NULL DEFAULT 'released' CHECK (status IN ('released','quarantine','expired','damaged')),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  CHECK (lot_no IS NOT NULL OR serial_no IS NOT NULL),
  CHECK (expiry_date IS NULL OR mfg_date IS NULL OR expiry_date > mfg_date)
);
CREATE UNIQUE INDEX stock_lot_lot_uq ON stock_lot (item_id, lot_no) WHERE serial_no IS NULL;
CREATE UNIQUE INDEX stock_lot_serial_uq ON stock_lot (item_id, serial_no) WHERE serial_no IS NOT NULL;
CREATE INDEX stock_lot_expiry_idx ON stock_lot (expiry_date) WHERE expiry_date IS NOT NULL;
CREATE TRIGGER stock_lot_stamp BEFORE INSERT ON stock_lot FOR EACH ROW EXECUTE FUNCTION trg_stamp_insert();
CREATE TRIGGER stock_lot_touch BEFORE UPDATE ON stock_lot FOR EACH ROW EXECUTE FUNCTION trg_touch();
CREATE TRIGGER stock_lot_audit AFTER INSERT OR UPDATE ON stock_lot FOR EACH ROW EXECUTE FUNCTION trg_audit();
CREATE TRIGGER stock_lot_no_delete BEFORE DELETE ON stock_lot FOR EACH ROW EXECUTE FUNCTION trg_forbid_delete();

-- ------------------------------------------------------------------ balances
CREATE TABLE stock_balance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES item(id),
  warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  location_id uuid NOT NULL REFERENCES location(id),
  lot_id uuid REFERENCES stock_lot(id),
  lot_key uuid GENERATED ALWAYS AS (coalesce(lot_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED,
  stock_status text NOT NULL DEFAULT 'available' CHECK (stock_status IN ('available','quarantine','inspection','in_transit','damaged')),
  qty_on_hand numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  qty_reserved numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_reserved >= 0),
  last_movement_at timestamptz,
  first_received_at timestamptz,
  CHECK (qty_reserved <= qty_on_hand),
  UNIQUE (item_id, location_id, lot_key, stock_status)
);
CREATE INDEX stock_balance_item_wh_idx ON stock_balance (item_id, warehouse_id) WHERE qty_on_hand > 0;
CREATE INDEX stock_balance_location_idx ON stock_balance (location_id) WHERE qty_on_hand > 0;
CREATE TRIGGER stock_balance_no_delete BEFORE DELETE ON stock_balance FOR EACH ROW EXECUTE FUNCTION trg_forbid_delete();

-- ------------------------------------------------------------------ ledger (append-only)
CREATE TABLE stock_ledger (
  id bigserial PRIMARY KEY,
  posted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  doc_type text NOT NULL,                -- GRN, MR, PUTAWAY, OPENING, ADJ, TR …
  doc_id uuid,
  doc_no text,
  doc_line_id uuid,
  movement_type text NOT NULL,           -- GR, GI, PUTAWAY_OUT, PUTAWAY_IN, OPENING, …
  item_id uuid NOT NULL REFERENCES item(id),
  warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  location_id uuid NOT NULL REFERENCES location(id),
  lot_id uuid REFERENCES stock_lot(id),
  stock_status text NOT NULL,
  qty numeric(18,4) NOT NULL CHECK (qty <> 0),
  unit_cost numeric(18,6) NOT NULL,
  value numeric(18,2) NOT NULL,
  balance_after numeric(18,4) NOT NULL,  -- at location/lot/status
  wh_qty_after numeric(18,4) NOT NULL,   -- item in warehouse (all statuses)
  avg_cost_after numeric(18,6) NOT NULL,
  reservation_id uuid,
  posted_by uuid NOT NULL,
  on_behalf_of uuid,
  reversal_of bigint REFERENCES stock_ledger(id),
  notes text
);
CREATE INDEX stock_ledger_item_idx ON stock_ledger (item_id, warehouse_id, id);
CREATE INDEX stock_ledger_doc_idx ON stock_ledger (doc_type, doc_id);
CREATE INDEX stock_ledger_posted_idx ON stock_ledger (posted_at);
CREATE TRIGGER stock_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON stock_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION trg_immutable();

-- ------------------------------------------------------------------ valuation (weighted average per item & warehouse)
CREATE TABLE item_valuation (
  item_id uuid NOT NULL REFERENCES item(id),
  warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty >= 0),
  total_value numeric(18,2) NOT NULL DEFAULT 0 CHECK (total_value >= 0),
  avg_cost numeric(18,6) NOT NULL DEFAULT 0 CHECK (avg_cost >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, warehouse_id)
);

-- ------------------------------------------------------------------ reservations
CREATE TABLE reservation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  balance_id uuid NOT NULL REFERENCES stock_balance(id),
  item_id uuid NOT NULL REFERENCES item(id),
  warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  location_id uuid NOT NULL REFERENCES location(id),
  lot_id uuid REFERENCES stock_lot(id),
  source_type text NOT NULL,             -- MR, TR …
  source_id uuid NOT NULL,
  source_line_id uuid,
  qty numeric(18,4) NOT NULL CHECK (qty > 0),
  qty_consumed numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_consumed >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','consumed')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  CHECK (qty_consumed <= qty)
);
CREATE INDEX reservation_source_idx ON reservation (source_type, source_id) WHERE status = 'active';
CREATE INDEX reservation_balance_idx ON reservation (balance_id) WHERE status = 'active';
CREATE TRIGGER reservation_stamp BEFORE INSERT ON reservation FOR EACH ROW EXECUTE FUNCTION trg_stamp_insert();
CREATE TRIGGER reservation_touch BEFORE UPDATE ON reservation FOR EACH ROW EXECUTE FUNCTION trg_touch();
CREATE TRIGGER reservation_audit AFTER INSERT OR UPDATE ON reservation FOR EACH ROW EXECUTE FUNCTION trg_audit();
CREATE TRIGGER reservation_no_delete BEFORE DELETE ON reservation FOR EACH ROW EXECUTE FUNCTION trg_forbid_delete();

-- ------------------------------------------------------------------ posting engine
CREATE OR REPLACE FUNCTION wms_post(
  p_doc_type text, p_doc_id uuid, p_doc_no text, p_doc_line_id uuid, p_movement text,
  p_item uuid, p_location uuid, p_lot uuid, p_status text, p_qty numeric,
  p_unit_cost numeric DEFAULT NULL, p_reservation uuid DEFAULT NULL, p_notes text DEFAULT NULL
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := app_user_id();
  v_loc location; v_item item; v_bal stock_balance; v_val item_valuation; v_res reservation;
  v_cost numeric; v_value numeric; v_ledger bigint; v_consume numeric := 0;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'posting requires an authenticated actor' USING ERRCODE = 'P0001', HINT = 'no_actor'; END IF;
  IF p_qty IS NULL OR p_qty = 0 THEN RAISE EXCEPTION 'quantity must be non-zero' USING ERRCODE = 'P0001', HINT = 'zero_qty'; END IF;

  SELECT * INTO v_item FROM item WHERE id = p_item AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown item' USING ERRCODE = 'P0001', HINT = 'unknown_item'; END IF;
  IF v_item.item_type = 'non_stock' THEN RAISE EXCEPTION 'non-stock items carry no inventory' USING ERRCODE = 'P0001', HINT = 'non_stock_item'; END IF;
  IF p_qty > 0 AND v_item.status NOT IN ('active') AND p_movement NOT LIKE '%\_IN' THEN
    RAISE EXCEPTION 'item % is %', v_item.item_code, v_item.status USING ERRCODE = 'P0001', HINT = 'item_not_active';
  END IF;
  IF (v_item.track_batch OR v_item.track_serial) AND p_lot IS NULL THEN
    RAISE EXCEPTION 'item % requires a batch/serial', v_item.item_code USING ERRCODE = 'P0001', HINT = 'lot_required';
  END IF;

  SELECT * INTO v_loc FROM location WHERE id = p_location AND deleted_at IS NULL;
  IF NOT FOUND OR v_loc.level <> 'bin' THEN RAISE EXCEPTION 'stock can only be held in bins' USING ERRCODE = 'P0001', HINT = 'bin_required'; END IF;
  IF p_qty > 0 AND v_loc.is_blocked THEN RAISE EXCEPTION 'location % is blocked', v_loc.full_code USING ERRCODE = 'P0001', HINT = 'location_blocked'; END IF;

  -- valuation row (lock order: valuation → balance → reservation)
  INSERT INTO item_valuation (item_id, warehouse_id) VALUES (p_item, v_loc.warehouse_id) ON CONFLICT DO NOTHING;
  SELECT * INTO v_val FROM item_valuation WHERE item_id = p_item AND warehouse_id = v_loc.warehouse_id FOR UPDATE;

  INSERT INTO stock_balance (item_id, warehouse_id, location_id, lot_id, stock_status)
  VALUES (p_item, v_loc.warehouse_id, p_location, p_lot, p_status) ON CONFLICT DO NOTHING;
  SELECT * INTO v_bal FROM stock_balance
   WHERE item_id = p_item AND location_id = p_location AND lot_key = coalesce(p_lot, '00000000-0000-0000-0000-000000000000'::uuid)
     AND stock_status = p_status FOR UPDATE;

  IF p_reservation IS NOT NULL THEN
    SELECT * INTO v_res FROM reservation WHERE id = p_reservation FOR UPDATE;
    IF NOT FOUND OR v_res.status <> 'active' OR v_res.balance_id <> v_bal.id THEN
      RAISE EXCEPTION 'reservation does not match the stock being issued' USING ERRCODE = 'P0001', HINT = 'reservation_mismatch';
    END IF;
    IF p_qty > 0 THEN RAISE EXCEPTION 'reservations are consumed by outgoing movements only' USING ERRCODE = 'P0001', HINT = 'reservation_mismatch'; END IF;
    v_consume := least(-p_qty, v_res.qty - v_res.qty_consumed);
  END IF;

  IF p_qty < 0 THEN
    IF v_bal.qty_on_hand + p_qty < 0 THEN
      RAISE EXCEPTION 'insufficient stock of % at % (on hand %, requested %)', v_item.item_code, v_loc.full_code, v_bal.qty_on_hand, -p_qty
        USING ERRCODE = 'P0001', HINT = 'insufficient_stock';
    END IF;
    IF v_bal.qty_on_hand + p_qty < v_bal.qty_reserved - v_consume THEN
      RAISE EXCEPTION 'stock of % at % is reserved for other requests', v_item.item_code, v_loc.full_code
        USING ERRCODE = 'P0001', HINT = 'stock_reserved';
    END IF;
    v_cost := v_val.avg_cost;
  ELSE
    v_cost := coalesce(p_unit_cost, nullif(v_val.avg_cost, 0), v_item.standard_cost, 0);
  END IF;
  v_value := round(p_qty * v_cost, 2);

  -- valuation (weighted average); outgoing movements never change the average
  UPDATE item_valuation SET
    qty = qty + p_qty,
    total_value = CASE WHEN qty + p_qty = 0 THEN 0 ELSE greatest(total_value + v_value, 0) END,
    avg_cost = CASE WHEN p_qty > 0 AND qty + p_qty > 0 THEN round((total_value + v_value) / (qty + p_qty), 6) ELSE avg_cost END,
    updated_at = now()
  WHERE item_id = p_item AND warehouse_id = v_loc.warehouse_id
  RETURNING * INTO v_val;

  UPDATE stock_balance SET
    qty_on_hand = qty_on_hand + p_qty,
    qty_reserved = qty_reserved - v_consume,
    last_movement_at = now(),
    first_received_at = CASE WHEN p_qty > 0 AND (first_received_at IS NULL OR qty_on_hand = 0) THEN now() ELSE first_received_at END
  WHERE id = v_bal.id RETURNING * INTO v_bal;

  IF p_reservation IS NOT NULL THEN
    UPDATE reservation SET qty_consumed = qty_consumed + v_consume,
           status = CASE WHEN qty_consumed + v_consume >= qty THEN 'consumed' ELSE status END
     WHERE id = p_reservation;
  END IF;

  -- physical load of the bin
  UPDATE location SET
    current_weight_kg = greatest(current_weight_kg + p_qty * coalesce(v_item.unit_weight_kg, 0), 0),
    current_volume_m3 = greatest(current_volume_m3 + p_qty * coalesce(v_item.unit_volume_m3, 0), 0)
  WHERE id = p_location;

  INSERT INTO stock_ledger (doc_type, doc_id, doc_no, doc_line_id, movement_type, item_id, warehouse_id, location_id, lot_id, stock_status,
                            qty, unit_cost, value, balance_after, wh_qty_after, avg_cost_after, reservation_id, posted_by, on_behalf_of, notes)
  VALUES (p_doc_type, p_doc_id, p_doc_no, p_doc_line_id, p_movement, p_item, v_loc.warehouse_id, p_location, p_lot, p_status,
          p_qty, v_cost, v_value, v_bal.qty_on_hand, v_val.qty, v_val.avg_cost, p_reservation, v_actor, app_on_behalf_of(), p_notes)
  RETURNING id INTO v_ledger;
  RETURN v_ledger;
END $$;

-- Reserve available quantity on a specific balance row.
CREATE OR REPLACE FUNCTION wms_reserve(p_balance uuid, p_qty numeric, p_source_type text, p_source_id uuid,
  p_source_line_id uuid DEFAULT NULL, p_expires timestamptz DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_bal stock_balance; v_id uuid;
BEGIN
  IF app_user_id() IS NULL THEN RAISE EXCEPTION 'reservation requires an authenticated actor' USING ERRCODE = 'P0001', HINT = 'no_actor'; END IF;
  IF p_qty <= 0 THEN RAISE EXCEPTION 'quantity must be positive' USING ERRCODE = 'P0001', HINT = 'zero_qty'; END IF;
  SELECT * INTO v_bal FROM stock_balance WHERE id = p_balance FOR UPDATE;
  IF NOT FOUND OR v_bal.stock_status <> 'available' THEN RAISE EXCEPTION 'stock is not available' USING ERRCODE = 'P0001', HINT = 'not_available'; END IF;
  IF v_bal.qty_on_hand - v_bal.qty_reserved < p_qty THEN
    RAISE EXCEPTION 'only % available to reserve', v_bal.qty_on_hand - v_bal.qty_reserved USING ERRCODE = 'P0001', HINT = 'insufficient_stock';
  END IF;
  UPDATE stock_balance SET qty_reserved = qty_reserved + p_qty WHERE id = p_balance;
  INSERT INTO reservation (balance_id, item_id, warehouse_id, location_id, lot_id, source_type, source_id, source_line_id, qty, expires_at)
  VALUES (p_balance, v_bal.item_id, v_bal.warehouse_id, v_bal.location_id, v_bal.lot_id, p_source_type, p_source_id, p_source_line_id, p_qty, p_expires)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Release the unconsumed part of a reservation.
CREATE OR REPLACE FUNCTION wms_release(p_reservation uuid) RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_res reservation; v_left numeric;
BEGIN
  IF app_user_id() IS NULL THEN RAISE EXCEPTION 'release requires an authenticated actor' USING ERRCODE = 'P0001', HINT = 'no_actor'; END IF;
  SELECT * INTO v_res FROM reservation WHERE id = p_reservation FOR UPDATE;
  IF NOT FOUND OR v_res.status <> 'active' THEN RETURN 0; END IF;
  v_left := v_res.qty - v_res.qty_consumed;
  PERFORM 1 FROM stock_balance WHERE id = v_res.balance_id FOR UPDATE;
  UPDATE stock_balance SET qty_reserved = greatest(qty_reserved - v_left, 0) WHERE id = v_res.balance_id;
  UPDATE reservation SET status = 'released' WHERE id = p_reservation;
  RETURN v_left;
END $$;

-- Pickable stock view: available status, in storage/picking zones, unblocked bins.
CREATE OR REPLACE VIEW v_pickable_stock AS
SELECT b.*, b.qty_on_hand - b.qty_reserved AS qty_free, l.full_code, l.pick_sequence, z.zone_type,
       sl.lot_no, sl.serial_no, sl.expiry_date, sl.mfg_date
  FROM stock_balance b
  JOIN location l ON l.id = b.location_id AND NOT l.is_blocked AND l.deleted_at IS NULL
  JOIN location r ON r.id = l.parent_id
  JOIN location a ON a.id = r.parent_id
  JOIN location z ON z.id = a.parent_id AND z.zone_type IN ('storage','picking')
  LEFT JOIN stock_lot sl ON sl.id = b.lot_id
 WHERE b.stock_status = 'available' AND b.qty_on_hand > b.qty_reserved
   AND (sl.id IS NULL OR (sl.status = 'released' AND (sl.expiry_date IS NULL OR sl.expiry_date > current_date)));
