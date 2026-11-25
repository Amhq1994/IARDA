-- 002 · Master data: suppliers, warehouse structure, units of measure, categories, items.

-- ------------------------------------------------------------------ Arabic-aware normalisation
-- Used for search and duplicate detection: strips diacritics/tatweel, unifies alef/yaa/taa-marbuta forms.
CREATE OR REPLACE FUNCTION normalize_ar(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT btrim(regexp_replace(
    translate(lower(regexp_replace(coalesce(t, ''), '[ً-ْـٰ]', '', 'g')),
              'أإآٱىةؤئ٠١٢٣٤٥٦٧٨٩', 'اااايهوي0123456789'),
    '[^[:alnum:]؀-ۿ]+', ' ', 'g'))
$$;

-- ------------------------------------------------------------------ suppliers
CREATE TABLE supplier (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name_ar text NOT NULL, name_en text NOT NULL,
  cr_number text, vat_number text, etimad_vendor_id text,
  contact_name text, contact_email citext, contact_phone text,
  address text, city text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz, deleted_by uuid
);
ALTER TABLE app_user ADD CONSTRAINT app_user_supplier_fk FOREIGN KEY (supplier_id) REFERENCES supplier(id);
SELECT attach_standard_triggers('supplier');

-- ------------------------------------------------------------------ warehouse structure
CREATE TABLE warehouse (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{2,10}$'),
  name_ar text NOT NULL, name_en text NOT NULL,
  warehouse_type text NOT NULL CHECK (warehouse_type IN ('central','site','spare_parts')),
  city text, address text, latitude numeric(9,6), longitude numeric(9,6),
  manager_user_id uuid REFERENCES app_user(id),
  default_picking_rule text NOT NULL DEFAULT 'FIFO' CHECK (default_picking_rule IN ('FIFO','FEFO','LIFO')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz, deleted_by uuid
);
SELECT attach_standard_triggers('warehouse');

CREATE TABLE location (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  parent_id uuid REFERENCES location(id),
  level text NOT NULL CHECK (level IN ('zone','aisle','rack','bin')),
  code text NOT NULL,                       -- segment, e.g. "A03"
  full_code text NOT NULL,                  -- e.g. "WH01-STR-A03-R02-B05" (unique per warehouse)
  name_ar text, name_en text,
  zone_type text CHECK (zone_type IN ('receiving','inspection','storage','quarantine','picking','returns','damaged')),
  max_weight_kg numeric(12,3) CHECK (max_weight_kg IS NULL OR max_weight_kg > 0),
  max_volume_m3 numeric(12,4) CHECK (max_volume_m3 IS NULL OR max_volume_m3 > 0),
  current_weight_kg numeric(12,3) NOT NULL DEFAULT 0 CHECK (current_weight_kg >= 0),
  current_volume_m3 numeric(12,4) NOT NULL DEFAULT 0 CHECK (current_volume_m3 >= 0),
  velocity_class text CHECK (velocity_class IN ('fast','medium','slow')),
  temperature_controlled boolean NOT NULL DEFAULT false,
  hazmat_allowed boolean NOT NULL DEFAULT false,
  mixed_items_allowed boolean NOT NULL DEFAULT true,
  pick_sequence int,
  barcode text,
  is_blocked boolean NOT NULL DEFAULT false,
  block_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz, deleted_by uuid,
  -- zone type only on zones; zones are top-level, others must have a parent
  CHECK ((level = 'zone') = (zone_type IS NOT NULL)),
  CHECK ((level = 'zone') = (parent_id IS NULL))
);
CREATE UNIQUE INDEX location_full_code_uq ON location (warehouse_id, full_code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX location_barcode_uq ON location (barcode) WHERE barcode IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX location_parent_idx ON location (parent_id);
CREATE INDEX location_wh_level_idx ON location (warehouse_id, level);

-- Enforce the hierarchy Zone > Aisle > Rack > Bin and same-warehouse parents.
CREATE OR REPLACE FUNCTION trg_location_hierarchy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p location;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO p FROM location WHERE id = NEW.parent_id;
    IF p.warehouse_id <> NEW.warehouse_id THEN RAISE EXCEPTION 'Parent location belongs to another warehouse'; END IF;
    IF (p.level, NEW.level) NOT IN (('zone','aisle'),('aisle','rack'),('rack','bin')) THEN
      RAISE EXCEPTION 'Invalid hierarchy: % cannot contain %', p.level, NEW.level USING HINT = 'location_hierarchy';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER location_hierarchy BEFORE INSERT OR UPDATE OF parent_id, level ON location
  FOR EACH ROW EXECUTE FUNCTION trg_location_hierarchy();
SELECT attach_standard_triggers('location');

-- ------------------------------------------------------------------ units of measure
CREATE TABLE uom (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name_ar text NOT NULL, name_en text NOT NULL,
  dimension text NOT NULL DEFAULT 'count' CHECK (dimension IN ('count','weight','volume','length','area','time')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz, deleted_by uuid
);
SELECT attach_standard_triggers('uom');

-- ------------------------------------------------------------------ categories (Category > Group)
CREATE TABLE item_category (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{2,8}$'),
  name_ar text NOT NULL, name_en text NOT NULL,
  level text NOT NULL CHECK (level IN ('category','group')),
  parent_id uuid REFERENCES item_category(id),
  gl_inventory_account text, gl_expense_account text,
  valuation_method text CHECK (valuation_method IN ('WAVG','FIFO')),
  is_critical boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz, deleted_by uuid,
  CHECK ((level = 'category') = (parent_id IS NULL))
);
SELECT attach_standard_triggers('item_category');

-- ------------------------------------------------------------------ items
CREATE TABLE item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_code text NOT NULL,
  name_ar text NOT NULL,
  name_en text NOT NULL,
  normalized_name text NOT NULL DEFAULT '',
  description_ar text, description_en text,
  specs jsonb NOT NULL DEFAULT '{}'::jsonb,
  group_id uuid NOT NULL REFERENCES item_category(id),
  item_type text NOT NULL CHECK (item_type IN ('stock','non_stock','consumable','asset')),
  base_uom_id uuid NOT NULL REFERENCES uom(id),
  track_batch boolean NOT NULL DEFAULT false,
  track_serial boolean NOT NULL DEFAULT false,
  track_expiry boolean NOT NULL DEFAULT false,
  shelf_life_days int CHECK (shelf_life_days IS NULL OR shelf_life_days > 0),
  unit_weight_kg numeric(12,4) CHECK (unit_weight_kg IS NULL OR unit_weight_kg >= 0),
  unit_volume_m3 numeric(12,6) CHECK (unit_volume_m3 IS NULL OR unit_volume_m3 >= 0),
  hazard_class text,
  storage_conditions text,
  abc_class char(1) CHECK (abc_class IN ('A','B','C')),
  xyz_class char(1) CHECK (xyz_class IN ('X','Y','Z')),
  ved_class char(1) CHECK (ved_class IN ('V','E','D')),
  classes_computed_at timestamptz,
  standard_cost numeric(18,6) CHECK (standard_cost IS NULL OR standard_cost >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('requested','draft','pending_approval','active','blocked','obsolete')),
  status_reason text,
  requested_by uuid REFERENCES app_user(id),
  submitted_by uuid REFERENCES app_user(id),
  approved_by uuid REFERENCES app_user(id),
  approved_at timestamptz,
  duplicate_ack jsonb,                       -- candidates shown & acknowledged at creation
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz, deleted_by uuid,
  CHECK (NOT (track_serial AND track_batch)),
  CHECK (NOT track_expiry OR track_batch OR track_serial)
);
CREATE UNIQUE INDEX item_code_uq ON item (item_code);
CREATE INDEX item_group_idx ON item (group_id);
CREATE INDEX item_status_idx ON item (status) WHERE deleted_at IS NULL;
CREATE INDEX item_norm_trgm ON item USING gin (normalized_name gin_trgm_ops);
CREATE INDEX item_name_en_trgm ON item USING gin (lower(name_en) gin_trgm_ops);

CREATE OR REPLACE FUNCTION trg_item_normalize() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.normalized_name := normalize_ar(NEW.name_ar);
  RETURN NEW;
END $$;
CREATE TRIGGER item_normalize BEFORE INSERT OR UPDATE OF name_ar ON item FOR EACH ROW EXECUTE FUNCTION trg_item_normalize();
SELECT attach_standard_triggers('item');

CREATE TABLE item_uom_conversion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES item(id),
  uom_id uuid NOT NULL REFERENCES uom(id),
  factor_to_base numeric(18,6) NOT NULL CHECK (factor_to_base > 0),
  is_purchase_default boolean NOT NULL DEFAULT false,
  is_issue_default boolean NOT NULL DEFAULT false,
  barcode text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz, deleted_by uuid
);
CREATE UNIQUE INDEX item_uom_uq ON item_uom_conversion (item_id, uom_id) WHERE deleted_at IS NULL;
SELECT attach_standard_triggers('item_uom_conversion');

CREATE TABLE item_identifier (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES item(id),
  id_type text NOT NULL CHECK (id_type IN ('barcode','qr','rfid','mpn')),
  value text NOT NULL,
  manufacturer text,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz, deleted_by uuid
);
CREATE UNIQUE INDEX item_identifier_uq ON item_identifier (id_type, value) WHERE deleted_at IS NULL;
CREATE INDEX item_identifier_item_idx ON item_identifier (item_id);
SELECT attach_standard_triggers('item_identifier');

CREATE TABLE item_substitute (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES item(id),
  substitute_item_id uuid NOT NULL REFERENCES item(id),
  ratio numeric(12,4) NOT NULL DEFAULT 1 CHECK (ratio > 0),
  priority int NOT NULL DEFAULT 1,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz, deleted_by uuid,
  CHECK (item_id <> substitute_item_id)
);
CREATE UNIQUE INDEX item_substitute_uq ON item_substitute (item_id, substitute_item_id) WHERE deleted_at IS NULL;
SELECT attach_standard_triggers('item_substitute');

CREATE TABLE item_warehouse_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES item(id),
  warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  min_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (min_qty >= 0),
  max_qty numeric(18,4) CHECK (max_qty IS NULL OR max_qty >= 0),
  reorder_point numeric(18,4) CHECK (reorder_point IS NULL OR reorder_point >= 0),
  safety_stock numeric(18,4) NOT NULL DEFAULT 0 CHECK (safety_stock >= 0),
  reorder_qty numeric(18,4) CHECK (reorder_qty IS NULL OR reorder_qty > 0),
  lead_time_days int CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  preferred_location_id uuid REFERENCES location(id),
  picking_rule text CHECK (picking_rule IN ('FIFO','FEFO','LIFO')),
  is_stocked boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz, deleted_by uuid,
  CHECK (max_qty IS NULL OR max_qty >= min_qty),
  CHECK (reorder_point IS NULL OR reorder_point >= safety_stock)
);
CREATE UNIQUE INDEX item_wh_policy_uq ON item_warehouse_policy (item_id, warehouse_id) WHERE deleted_at IS NULL;
SELECT attach_standard_triggers('item_warehouse_policy');

-- Per-group item code sequence: GROUPCODE-00001
CREATE TABLE item_code_sequence (
  group_id uuid PRIMARY KEY REFERENCES item_category(id),
  next_no int NOT NULL DEFAULT 1
);
