-- 005 · Inbound: purchase orders (ERP/Etimad), ASN, receiving, committee inspection, GRN,
--        put-away tasks, supplier invoices and 3-way match.

CREATE OR REPLACE FUNCTION std_doc_cols() RETURNS void LANGUAGE sql AS $$ SELECT $$;  -- marker only

CREATE TABLE purchase_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_no text NOT NULL UNIQUE,
  etimad_ref text,
  supplier_id uuid NOT NULL REFERENCES supplier(id),
  warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  order_date date NOT NULL DEFAULT current_date,
  expected_date date,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('erp','manual')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','partially_received','received','closed','cancelled')),
  total_amount numeric(18,2) NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE INDEX purchase_order_supplier_idx ON purchase_order (supplier_id, status);

CREATE TABLE po_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id uuid NOT NULL REFERENCES purchase_order(id),
  line_no int NOT NULL,
  item_id uuid NOT NULL REFERENCES item(id),
  uom_id uuid NOT NULL REFERENCES uom(id),
  factor_to_base numeric(18,6) NOT NULL DEFAULT 1 CHECK (factor_to_base > 0),
  qty_ordered numeric(18,4) NOT NULL CHECK (qty_ordered > 0),          -- in line UoM
  unit_price numeric(18,6) NOT NULL CHECK (unit_price >= 0),            -- per line UoM, excl. VAT
  vat_rate numeric(5,2) NOT NULL DEFAULT 15,
  qty_received numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),   -- accepted, line UoM
  qty_invoiced numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_invoiced >= 0),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (po_id, line_no)
);

CREATE TABLE asn (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asn_no text NOT NULL UNIQUE,
  po_id uuid NOT NULL REFERENCES purchase_order(id),
  supplier_id uuid NOT NULL REFERENCES supplier(id),
  expected_at timestamptz NOT NULL,
  vehicle_no text, driver_name text, driver_mobile text, supplier_delivery_ref text,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','arrived','received','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);

CREATE TABLE asn_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asn_id uuid NOT NULL REFERENCES asn(id),
  po_line_id uuid NOT NULL REFERENCES po_line(id),
  qty numeric(18,4) NOT NULL CHECK (qty > 0),
  lot_no text, serial_nos text[], mfg_date date, expiry_date date,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);

CREATE TABLE receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no text NOT NULL UNIQUE,
  grn_no text UNIQUE,
  po_id uuid NOT NULL REFERENCES purchase_order(id),
  asn_id uuid REFERENCES asn(id),
  warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  dock_location_id uuid NOT NULL REFERENCES location(id),
  supplier_delivery_ref text,
  status text NOT NULL DEFAULT 'arrived' CHECK (status IN ('arrived','qty_checked','in_inspection','inspected','grn_posted','putaway_done','cancelled')),
  arrived_at timestamptz NOT NULL DEFAULT now(),
  received_by uuid REFERENCES app_user(id),
  qty_checked_at timestamptz,
  inspection_started_at timestamptz,
  inspected_at timestamptz,
  grn_posted_at timestamptz,
  grn_posted_by uuid REFERENCES app_user(id),
  grn_value numeric(18,2),
  putaway_completed_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE INDEX receipt_status_idx ON receipt (warehouse_id, status);

CREATE TABLE receipt_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES receipt(id),
  po_line_id uuid NOT NULL REFERENCES po_line(id),
  item_id uuid NOT NULL REFERENCES item(id),
  qty_expected numeric(18,4) NOT NULL DEFAULT 0,            -- line UoM
  qty_received numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  qty_damaged numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_damaged >= 0),
  qty_accepted numeric(18,4) CHECK (qty_accepted IS NULL OR qty_accepted >= 0),
  qty_rejected numeric(18,4) CHECK (qty_rejected IS NULL OR qty_rejected >= 0),
  reject_reason text,
  inspection_notes text,
  lot_no text, serial_nos text[], mfg_date date, expiry_date date,
  lot_id uuid REFERENCES stock_lot(id),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  CHECK (qty_damaged <= qty_received),
  CHECK (qty_accepted IS NULL OR qty_accepted + coalesce(qty_rejected, 0) = qty_received)
);

CREATE TABLE inspection_member (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES receipt(id),
  user_id uuid NOT NULL REFERENCES app_user(id),
  is_chair boolean NOT NULL DEFAULT false,
  decision text CHECK (decision IN ('agree','object')),
  comment text,
  signed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (receipt_id, user_id)
);

CREATE TABLE putaway_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_no text NOT NULL UNIQUE,
  receipt_id uuid REFERENCES receipt(id),
  receipt_line_id uuid REFERENCES receipt_line(id),
  warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  item_id uuid NOT NULL REFERENCES item(id),
  lot_id uuid REFERENCES stock_lot(id),
  qty numeric(18,4) NOT NULL CHECK (qty > 0),               -- base UoM
  from_location_id uuid NOT NULL REFERENCES location(id),
  suggested_location_id uuid REFERENCES location(id),
  suggestion jsonb,
  to_location_id uuid REFERENCES location(id),
  override_reason text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  assigned_to uuid REFERENCES app_user(id),
  completed_by uuid REFERENCES app_user(id),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE INDEX putaway_task_open_idx ON putaway_task (warehouse_id, status);

CREATE TABLE supplier_invoice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no text NOT NULL,
  supplier_id uuid NOT NULL REFERENCES supplier(id),
  po_id uuid NOT NULL REFERENCES purchase_order(id),
  invoice_date date NOT NULL,
  amount_excl_vat numeric(18,2) NOT NULL CHECK (amount_excl_vat >= 0),
  vat_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (vat_amount >= 0),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','matched','exception','ready_for_payment','cancelled')),
  match_result jsonb,
  matched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (supplier_id, invoice_no)
);

CREATE TABLE invoice_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES supplier_invoice(id),
  po_line_id uuid NOT NULL REFERENCES po_line(id),
  qty numeric(18,4) NOT NULL CHECK (qty > 0),
  unit_price numeric(18,6) NOT NULL CHECK (unit_price >= 0),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);

-- standard triggers (no soft delete column on documents: they are cancelled, never deleted)
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_order','po_line','asn','asn_line','receipt','receipt_line','inspection_member','putaway_task','supplier_invoice','invoice_line'] LOOP
    PERFORM attach_standard_triggers(t, true);
  END LOOP;
END $$;
DROP FUNCTION std_doc_cols();
