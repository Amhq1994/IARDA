-- 008 · Inventory planning (min/max, ROP, safety stock, EOQ, forecast, auto purchase requisitions, dead stock),
--        valuation (WAVG book value + FIFO comparison, provisions), GL journals generated from the stock ledger,
--        assets & custody, employee clearance.

-- ------------------------------------------------------------------ consumption history (legacy import at go-live)
-- Planning needs months of demand; at go-live this comes from the legacy system. The ledger supplies everything after.
CREATE TABLE consumption_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES item(id),
  warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  period date NOT NULL CHECK (extract(day FROM period) = 1),
  qty numeric(18,4) NOT NULL CHECK (qty >= 0),
  value numeric(18,2) NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'legacy',
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (item_id, warehouse_id, period, source)
);
SELECT attach_standard_triggers('consumption_history');

-- ------------------------------------------------------------------ planning runs (computed, reproducible)
CREATE TABLE planning_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_no text NOT NULL UNIQUE,
  warehouse_id uuid REFERENCES warehouse(id),
  params jsonb NOT NULL,
  lines int NOT NULL DEFAULT 0,
  reorder_lines int NOT NULL DEFAULT 0,
  dead_lines int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);
SELECT attach_standard_triggers('planning_run');

-- Derived figures (not audited row by row: the run, its parameters and every policy change applied from it are).
CREATE TABLE planning_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES planning_run(id),
  item_id uuid NOT NULL REFERENCES item(id),
  warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  avg_daily_demand numeric(18,6) NOT NULL,
  demand_sd_daily numeric(18,6) NOT NULL,
  forecast_30d numeric(18,4) NOT NULL,
  months_with_demand int NOT NULL,
  lead_time_days int NOT NULL,
  unit_cost numeric(18,6) NOT NULL,
  safety_stock numeric(18,4) NOT NULL,
  reorder_point numeric(18,4) NOT NULL,
  eoq numeric(18,4),
  min_qty numeric(18,4) NOT NULL,
  max_qty numeric(18,4) NOT NULL,
  cur_min numeric(18,4), cur_rop numeric(18,4), cur_max numeric(18,4),
  on_hand numeric(18,4) NOT NULL,
  free_qty numeric(18,4) NOT NULL,
  on_order numeric(18,4) NOT NULL,
  suggested_qty numeric(18,4) NOT NULL DEFAULT 0,
  suggested_value numeric(18,2) NOT NULL DEFAULT 0,
  action text NOT NULL CHECK (action IN ('reorder','ok','excess','dead','no_demand')),
  last_issue_at timestamptz,
  applied_at timestamptz, applied_by uuid,
  pr_id uuid
);
CREATE INDEX planning_line_run_idx ON planning_line (run_id, action);

-- ------------------------------------------------------------------ purchase requisitions (auto from planning or manual)
CREATE TABLE purchase_requisition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_no text NOT NULL UNIQUE,
  warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  source text NOT NULL CHECK (source IN ('auto','manual')),
  planning_run_id uuid REFERENCES planning_run(id),
  requested_by uuid NOT NULL REFERENCES app_user(id),
  needed_by date,
  notes text,
  estimated_value numeric(18,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','rejected','converted','cancelled')),
  status_reason text,
  revision int NOT NULL DEFAULT 0,
  converted_at timestamptz, converted_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);
SELECT attach_standard_triggers('purchase_requisition');
CREATE INDEX purchase_requisition_status_idx ON purchase_requisition (status, warehouse_id);

CREATE TABLE pr_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id uuid NOT NULL REFERENCES purchase_requisition(id),
  line_no int NOT NULL,
  item_id uuid NOT NULL REFERENCES item(id),
  qty numeric(18,4) NOT NULL CHECK (qty > 0),
  est_unit_cost numeric(18,6) NOT NULL DEFAULT 0,
  value numeric(18,2) NOT NULL DEFAULT 0,
  planning_line_id uuid REFERENCES planning_line(id),
  po_id uuid REFERENCES purchase_order(id),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (pr_id, line_no)
);
SELECT attach_standard_triggers('pr_line');
ALTER TABLE purchase_order ADD COLUMN pr_id uuid REFERENCES purchase_requisition(id);

-- ------------------------------------------------------------------ chart of accounts (inventory sub-ledger) & movement mapping
CREATE TABLE gl_account (
  code text PRIMARY KEY,
  name_ar text NOT NULL, name_en text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('asset','contra_asset','liability','equity','income','expense','clearing')),
  is_inventory boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);
SELECT attach_standard_triggers('gl_account');

CREATE TABLE movement_gl_map (
  movement_type text PRIMARY KEY,
  offset_account text NOT NULL REFERENCES gl_account(code),
  use_cost_center boolean NOT NULL DEFAULT false,
  description_ar text, description_en text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);
SELECT attach_standard_triggers('movement_gl_map');

-- inventory account by stock status
CREATE TABLE status_gl_map (
  stock_status text PRIMARY KEY,
  inventory_account text NOT NULL REFERENCES gl_account(code)
);

INSERT INTO gl_account (code, name_ar, name_en, account_type, is_inventory) VALUES
  ('1310', 'المخزون — متاح', 'Inventory — available', 'asset', true),
  ('1320', 'المخزون — بضاعة في الطريق', 'Inventory — in transit', 'asset', true),
  ('1330', 'المخزون — حجر وتالف وتحت الفحص', 'Inventory — quarantine, damaged & inspection', 'asset', true),
  ('1319', 'مخصص تقادم وتلف المخزون', 'Inventory obsolescence provision', 'contra_asset', false),
  ('1390', 'حساب وسيط — حركات المخزون الداخلية', 'Inventory internal movements clearing', 'clearing', false),
  ('2110', 'بضاعة مستلمة غير مفوترة', 'Goods received not invoiced (GRNI)', 'liability', false),
  ('3100', 'أرصدة افتتاحية', 'Opening balances', 'equity', false),
  ('4910', 'فروقات جرد — زيادة', 'Inventory count gains', 'income', false),
  ('5110', 'مصروف استهلاك مواد', 'Materials consumption expense', 'expense', false),
  ('5910', 'فروقات جرد — عجز', 'Inventory count losses', 'expense', false),
  ('5920', 'مصروف إتلاف وشطب', 'Write-off & disposal expense', 'expense', false),
  ('5930', 'مصروف مخصص التقادم', 'Obsolescence provision expense', 'expense', false);

INSERT INTO movement_gl_map (movement_type, offset_account, use_cost_center, description_ar, description_en) VALUES
  ('GR', '2110', false, 'استلام مشتريات', 'Goods receipt'),
  ('OPENING', '3100', false, 'رصيد افتتاحي', 'Opening balance'),
  ('GI', '5110', true, 'صرف مواد على مركز التكلفة', 'Issue to cost center'),
  ('RTW', '5110', true, 'مرتجع للمستودع', 'Return to warehouse'),
  ('RTV', '2110', false, 'إرجاع للمورد', 'Return to vendor'),
  ('ADJ_PLUS', '4910', false, 'تسوية بالزيادة', 'Adjustment gain'),
  ('ADJ_MINUS', '5910', false, 'تسوية بالعجز', 'Adjustment loss'),
  ('SCRAP', '5920', false, 'إتلاف وشطب', 'Write-off'),
  ('PUTAWAY_OUT', '1390', false, 'تخزين', 'Put-away'), ('PUTAWAY_IN', '1390', false, 'تخزين', 'Put-away'),
  ('MOVE_OUT', '1390', false, 'نقل بين المواقع', 'Bin move'), ('MOVE_IN', '1390', false, 'نقل بين المواقع', 'Bin move'),
  ('STATUS_OUT', '1390', false, 'تغيير حالة', 'Status change'), ('STATUS_IN', '1390', false, 'تغيير حالة', 'Status change'),
  ('TR_OUT', '1390', false, 'نقل بين المستودعات', 'Transfer'), ('TR_IN_TRANSIT', '1390', false, 'نقل بين المستودعات', 'Transfer'),
  ('TR_RECEIVE_OUT', '1390', false, 'استلام نقل', 'Transfer receipt'), ('TR_RECEIVE_IN', '1390', false, 'استلام نقل', 'Transfer receipt');

INSERT INTO status_gl_map VALUES ('available', '1310'), ('in_transit', '1320'), ('quarantine', '1330'), ('damaged', '1330'), ('inspection', '1330');

-- ------------------------------------------------------------------ journals
CREATE TABLE journal_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  je_no text NOT NULL UNIQUE,
  period text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  je_date date NOT NULL,
  source text NOT NULL CHECK (source IN ('ledger','provision')),
  description text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','exported')),
  total_debit numeric(18,2) NOT NULL DEFAULT 0,
  total_credit numeric(18,2) NOT NULL DEFAULT 0,
  ledger_rows int NOT NULL DEFAULT 0,
  posted_at timestamptz, posted_by uuid REFERENCES app_user(id),
  exported_at timestamptz, erp_ref text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  CHECK (total_debit = total_credit)
);
SELECT attach_standard_triggers('journal_entry');

CREATE TABLE journal_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  je_id uuid NOT NULL REFERENCES journal_entry(id),
  line_no int NOT NULL,
  account_code text NOT NULL REFERENCES gl_account(code),
  warehouse_id uuid REFERENCES warehouse(id),
  org_unit_id uuid REFERENCES org_unit(id),
  debit numeric(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  memo text,
  CHECK ((debit = 0) <> (credit = 0)),
  UNIQUE (je_id, line_no)
);
CREATE INDEX journal_line_account_idx ON journal_line (account_code, warehouse_id);

-- each ledger row is journalised exactly once
CREATE TABLE journal_source (
  ledger_id bigint PRIMARY KEY REFERENCES stock_ledger(id),
  je_id uuid NOT NULL REFERENCES journal_entry(id)
);

-- posted / exported journals are frozen: lines cannot change, amounts cannot change, status only moves forward
CREATE OR REPLACE FUNCTION trg_journal_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  IF TG_TABLE_NAME = 'journal_line' THEN
    SELECT status INTO v_status FROM journal_entry WHERE id = coalesce(NEW.je_id, OLD.je_id);
    IF v_status <> 'draft' THEN RAISE EXCEPTION 'journal % is %', coalesce(NEW.je_id, OLD.je_id), v_status USING ERRCODE = 'P0001', HINT = 'journal_frozen'; END IF;
    RETURN coalesce(NEW, OLD);
  END IF;
  IF OLD.status <> 'draft' AND (NEW.total_debit <> OLD.total_debit OR NEW.total_credit <> OLD.total_credit OR NEW.period <> OLD.period
      OR (OLD.status = 'exported' AND NEW.status <> 'exported') OR (OLD.status = 'posted' AND NEW.status = 'draft')) THEN
    RAISE EXCEPTION 'journal % is %', OLD.je_no, OLD.status USING ERRCODE = 'P0001', HINT = 'journal_frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_line_frozen BEFORE INSERT OR UPDATE OR DELETE ON journal_line FOR EACH ROW EXECUTE FUNCTION trg_journal_frozen();
CREATE TRIGGER journal_entry_frozen BEFORE UPDATE ON journal_entry FOR EACH ROW EXECUTE FUNCTION trg_journal_frozen();
CREATE TRIGGER journal_line_audit AFTER INSERT OR UPDATE ON journal_line FOR EACH ROW EXECUTE FUNCTION trg_audit();

-- ------------------------------------------------------------------ provisions (obsolescence, expiry, damage)
CREATE TABLE provision_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_no text NOT NULL UNIQUE,
  as_of date NOT NULL,
  rates jsonb NOT NULL,
  required numeric(18,2) NOT NULL DEFAULT 0,
  previous numeric(18,2) NOT NULL DEFAULT 0,
  delta numeric(18,2) NOT NULL DEFAULT 0,
  je_id uuid REFERENCES journal_entry(id),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);
SELECT attach_standard_triggers('provision_run');

CREATE TABLE provision_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES provision_run(id),
  item_id uuid NOT NULL REFERENCES item(id),
  warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  lot_id uuid REFERENCES stock_lot(id),
  category text NOT NULL CHECK (category IN ('expired','near_expiry','damaged','quarantine','dead_stock','slow_moving')),
  qty numeric(18,4) NOT NULL,
  value numeric(18,2) NOT NULL,
  rate numeric(5,4) NOT NULL,
  provision numeric(18,2) NOT NULL
);
CREATE INDEX provision_line_run_idx ON provision_line (run_id);

-- ------------------------------------------------------------------ FIFO valuation (comparison to the WAVG book value)
-- Remaining on-hand is matched against the newest inbound cost layers (receipts, opening, returns, count gains,
-- transfers in). Internal moves are not layers. Book value and journals stay on weighted average.
CREATE OR REPLACE FUNCTION fifo_value(p_item uuid, p_wh uuid) RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE v_left numeric; v_val numeric := 0; r record; v_take numeric;
BEGIN
  SELECT coalesce(sum(qty_on_hand), 0) INTO v_left FROM stock_balance WHERE item_id = p_item AND warehouse_id = p_wh;
  IF v_left <= 0 THEN RETURN 0; END IF;
  FOR r IN SELECT qty, unit_cost FROM stock_ledger
            WHERE item_id = p_item AND warehouse_id = p_wh AND qty > 0
              AND movement_type IN ('GR','OPENING','RTW','ADJ_PLUS','TR_IN_TRANSIT')
            ORDER BY posted_at DESC, id DESC LOOP
    v_take := least(v_left, r.qty);
    v_val := v_val + v_take * r.unit_cost;
    v_left := v_left - v_take;
    EXIT WHEN v_left <= 0;
  END LOOP;
  IF v_left > 0 THEN  -- layers exhausted (should not happen): value the remainder at average cost
    v_val := v_val + v_left * coalesce((SELECT avg_cost FROM item_valuation WHERE item_id = p_item AND warehouse_id = p_wh), 0);
  END IF;
  RETURN round(v_val, 2);
END $$;

-- ------------------------------------------------------------------ assets & custody
CREATE TABLE custody (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  custody_no text NOT NULL UNIQUE,
  item_id uuid NOT NULL REFERENCES item(id),
  lot_id uuid REFERENCES stock_lot(id),
  qty numeric(18,4) NOT NULL CHECK (qty > 0),
  holder_id uuid NOT NULL REFERENCES app_user(id),
  org_unit_id uuid REFERENCES org_unit(id),
  warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  mr_id uuid REFERENCES material_request(id),
  delivery_line_id uuid REFERENCES delivery_line(id),
  unit_cost numeric(18,6) NOT NULL DEFAULT 0,
  value numeric(18,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','return_pending','returned','lost')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  return_id uuid REFERENCES return_doc(id),
  returned_at timestamptz,
  lost_reason text, lost_confirmed_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);
SELECT attach_standard_triggers('custody');
CREATE INDEX custody_holder_idx ON custody (holder_id, status);
ALTER TABLE return_doc ADD COLUMN custody_id uuid REFERENCES custody(id);

CREATE TABLE clearance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cl_no text NOT NULL UNIQUE,
  employee_id uuid NOT NULL REFERENCES app_user(id),
  reason text NOT NULL CHECK (reason IN ('resignation','transfer','retirement','end_of_contract','other')),
  notes text,
  requested_by uuid NOT NULL REFERENCES app_user(id),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','hr')),
  status text NOT NULL DEFAULT 'blocked' CHECK (status IN ('blocked','cleared','cancelled')),
  blockers jsonb NOT NULL DEFAULT '[]',
  checked_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz, cleared_by uuid REFERENCES app_user(id),
  certificate_no text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);
SELECT attach_standard_triggers('clearance');

-- ------------------------------------------------------------------ settings
INSERT INTO setting (key, value, description_ar, description_en) VALUES
  ('planning.service_level_z', '1.65', 'معامل مستوى الخدمة لمخزون الأمان (1.65 = 95%)', 'Service-level z for safety stock (1.65 = 95%)'),
  ('planning.order_cost_sar', '150', 'تكلفة إصدار أمر الشراء (ر.س) لحساب الكمية الاقتصادية', 'Ordering cost per PO (SAR) for EOQ'),
  ('planning.holding_rate', '0.2', 'نسبة تكلفة الاحتفاظ السنوية من قيمة الصنف', 'Annual holding cost rate'),
  ('planning.history_months', '6', 'أشهر الاستهلاك المستخدمة في التخطيط', 'Months of demand history used'),
  ('planning.default_lead_time_days', '14', 'مدة التوريد الافتراضية (يوم)', 'Default lead time (days)'),
  ('planning.dead_stock_days', '180', 'المخزون الراكد: لا صرف منذ (يوم)', 'Dead stock: no issue for (days)'),
  ('planning.slow_moving_days', '90', 'بطيء الحركة: لا صرف منذ (يوم)', 'Slow moving: no issue for (days)'),
  ('planning.auto_pr', 'false', 'إنشاء طلبات الشراء تلقائياً من التشغيل الليلي', 'Create purchase requisitions from the nightly run'),
  ('valuation.method', '"WAVG"', 'طريقة التقييم الدفترية (FIFO للمقارنة)', 'Book valuation method (FIFO shown for comparison)'),
  ('valuation.provision_rates', '{"expired":1,"damaged":1,"quarantine":0.25,"near_expiry":0.5,"dead_stock":0.5,"slow_moving":0.1}', 'نسب مخصص التقادم والتلف', 'Provision rates by category')
ON CONFLICT (key) DO NOTHING;
