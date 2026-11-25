-- 006 · Material requests, configurable approval workflow (DoA), approval tasks with delegation,
--        SLA tracking, picking, delivery with e-signature, notifications.

CREATE TABLE material_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mr_no text NOT NULL UNIQUE,
  request_type text NOT NULL CHECK (request_type IN ('issue','urgent','work_order','custody','reservation')),
  requester_id uuid NOT NULL REFERENCES app_user(id),
  org_unit_id uuid NOT NULL REFERENCES org_unit(id),
  warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high','urgent')),
  needed_by date,
  purpose text,
  justification text,                       -- mandatory for urgent
  work_order_ref text,                      -- mandatory for work_order (CMMS)
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','rejected','reserved','picking',
    'ready_for_delivery','partially_delivered','delivered','closed','cancelled')),
  status_reason text,
  validation jsonb,                         -- last auto-validation result
  estimated_value numeric(18,2) NOT NULL DEFAULT 0,
  issued_value numeric(18,2) NOT NULL DEFAULT 0,
  current_level int,
  submitted_at timestamptz,
  approved_at timestamptz,
  delivered_at timestamptz,
  closed_at timestamptz,
  sla_due_at timestamptz,
  is_overdue boolean NOT NULL DEFAULT false,
  escalated_at timestamptz,
  revision int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  CHECK (request_type <> 'urgent' OR status = 'draft' OR coalesce(length(justification), 0) >= 10),
  CHECK (request_type <> 'work_order' OR status = 'draft' OR work_order_ref IS NOT NULL)
);
CREATE INDEX material_request_requester_idx ON material_request (requester_id, status);
CREATE INDEX material_request_org_idx ON material_request (org_unit_id, status);
CREATE INDEX material_request_wh_idx ON material_request (warehouse_id, status);

CREATE TABLE mr_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mr_id uuid NOT NULL REFERENCES material_request(id),
  line_no int NOT NULL,
  item_id uuid NOT NULL REFERENCES item(id),
  uom_id uuid NOT NULL REFERENCES uom(id),
  factor_to_base numeric(18,6) NOT NULL DEFAULT 1 CHECK (factor_to_base > 0),
  qty_requested numeric(18,4) NOT NULL CHECK (qty_requested > 0),   -- base UoM
  qty_approved numeric(18,4) CHECK (qty_approved IS NULL OR qty_approved >= 0),
  qty_reserved numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_reserved >= 0),
  qty_picked numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_picked >= 0),
  qty_issued numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_issued >= 0),
  unit_cost_est numeric(18,6) NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz, deleted_by uuid,     -- lines replaced while editing a draft
  CHECK (qty_issued <= coalesce(qty_approved, qty_requested))
);
CREATE UNIQUE INDEX mr_line_no_uq ON mr_line (mr_id, line_no) WHERE deleted_at IS NULL;

-- Delegation of Authority matrix (configurable; seeded from the approved design §2.4)
CREATE TABLE doa_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type text NOT NULL,                   -- MR
  request_types text[],                     -- NULL = all
  level int NOT NULL CHECK (level BETWEEN 1 AND 9),
  min_value numeric(18,2) NOT NULL DEFAULT 0,
  max_value numeric(18,2),                  -- NULL = no upper bound
  critical_only boolean NOT NULL DEFAULT false,
  category_ids uuid[],
  org_unit_ids uuid[],
  approver_kind text NOT NULL CHECK (approver_kind IN ('department_manager','warehouse_manager','role','user')),
  approver_role text,
  approver_user_id uuid REFERENCES app_user(id),
  parallel_group text,                      -- same group = any one approver suffices
  sla_hours int NOT NULL DEFAULT 24,
  description_ar text, description_en text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz, deleted_by uuid
);

CREATE TABLE approval_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type text NOT NULL,
  doc_id uuid NOT NULL,
  revision int NOT NULL DEFAULT 0,
  level int NOT NULL,
  rule_id uuid REFERENCES doa_rule(id),
  assignee_id uuid NOT NULL REFERENCES app_user(id),
  original_assignee_id uuid REFERENCES app_user(id),   -- set when routed to a delegate
  delegation_id uuid REFERENCES delegation(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('waiting','pending','approved','rejected','returned','skipped','cancelled')),
  due_at timestamptz,
  acted_by uuid REFERENCES app_user(id),
  acted_at timestamptz,
  comment text,
  is_escalation boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE INDEX approval_task_assignee_idx ON approval_task (assignee_id, status);
CREATE INDEX approval_task_doc_idx ON approval_task (doc_type, doc_id);

CREATE TABLE pick_list (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pick_no text NOT NULL UNIQUE,
  mr_id uuid NOT NULL REFERENCES material_request(id),
  warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  picking_rule text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  assigned_to uuid REFERENCES app_user(id),
  released_by uuid REFERENCES app_user(id),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);

CREATE TABLE pick_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pick_list_id uuid NOT NULL REFERENCES pick_list(id),
  mr_line_id uuid NOT NULL REFERENCES mr_line(id),
  reservation_id uuid NOT NULL,
  item_id uuid NOT NULL REFERENCES item(id),
  lot_id uuid REFERENCES stock_lot(id),
  location_id uuid NOT NULL REFERENCES location(id),
  seq int NOT NULL,
  qty numeric(18,4) NOT NULL CHECK (qty > 0),
  qty_picked numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_picked >= 0),
  qty_delivered numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_delivered >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','picked','short','delivered','cancelled')),
  picked_by uuid REFERENCES app_user(id),
  picked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  CHECK (qty_picked <= qty), CHECK (qty_delivered <= qty_picked)
);

CREATE TABLE delivery_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dn_no text NOT NULL UNIQUE,
  mr_id uuid NOT NULL REFERENCES material_request(id),
  is_partial boolean NOT NULL,
  issued_by uuid NOT NULL REFERENCES app_user(id),
  received_by_user_id uuid REFERENCES app_user(id),
  received_by_name text NOT NULL,
  signature_attachment_id uuid REFERENCES attachment(id),
  signature_sha256 text NOT NULL,
  signed_at timestamptz NOT NULL DEFAULT now(),
  device_info text,
  total_value numeric(18,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);

CREATE TABLE delivery_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_note_id uuid NOT NULL REFERENCES delivery_note(id),
  mr_line_id uuid NOT NULL REFERENCES mr_line(id),
  pick_task_id uuid NOT NULL REFERENCES pick_task(id),
  item_id uuid NOT NULL REFERENCES item(id),
  lot_id uuid REFERENCES stock_lot(id),
  location_id uuid NOT NULL REFERENCES location(id),
  qty numeric(18,4) NOT NULL CHECK (qty > 0),
  unit_cost numeric(18,6) NOT NULL,
  value numeric(18,2) NOT NULL,
  ledger_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);

CREATE TABLE notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id),
  kind text NOT NULL,
  title_ar text NOT NULL, title_en text NOT NULL,
  body_ar text, body_en text,
  link text,
  doc_type text, doc_id uuid,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_user_idx ON notification (user_id, read_at, created_at DESC);
CREATE TRIGGER notification_no_delete BEFORE DELETE ON notification FOR EACH ROW EXECUTE FUNCTION trg_forbid_delete();

-- document events (timeline shown on every document; complements the row-level audit trail)
CREATE TABLE doc_event (
  id bigserial PRIMARY KEY,
  doc_type text NOT NULL, doc_id uuid NOT NULL,
  event text NOT NULL,                      -- submitted, validation_failed, approved_l1, rejected, reserved …
  from_status text, to_status text,
  actor_id uuid, on_behalf_of uuid,
  comment text, data jsonb,
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX doc_event_doc_idx ON doc_event (doc_type, doc_id, id);
CREATE TRIGGER doc_event_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON doc_event FOR EACH STATEMENT EXECUTE FUNCTION trg_immutable();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['material_request','mr_line','doa_rule','approval_task','pick_list','pick_task','delivery_note','delivery_line'] LOOP
    PERFORM attach_standard_triggers(t, true);
  END LOOP;
END $$;
