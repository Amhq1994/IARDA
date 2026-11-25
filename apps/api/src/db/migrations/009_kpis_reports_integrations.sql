-- 009 · KPI snapshots, reports & schedules, alerts, e-mail outbox, integration clients (API keys) and outbox/inbox logs.

-- ------------------------------------------------------------------ KPI history (daily snapshot job)
CREATE TABLE kpi_snapshot (
  id bigserial PRIMARY KEY,
  snap_date date NOT NULL,
  kpi text NOT NULL,
  warehouse_id uuid REFERENCES warehouse(id),
  value numeric(18,4),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX kpi_snapshot_uq ON kpi_snapshot (snap_date, kpi, coalesce(warehouse_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ------------------------------------------------------------------ reports
CREATE TABLE report_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  report_code text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}',
  format text NOT NULL CHECK (format IN ('pdf','xlsx','pptx')),
  lang text NOT NULL DEFAULT 'ar' CHECK (lang IN ('ar','en')),
  frequency text NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  weekday int CHECK (weekday BETWEEN 0 AND 6),          -- 0 = Sunday
  monthday int CHECK (monthday BETWEEN 1 AND 28),
  hour int NOT NULL DEFAULT 6 CHECK (hour BETWEEN 0 AND 23),  -- Riyadh time
  recipient_ids uuid[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  next_run_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz, deleted_by uuid
);
SELECT attach_standard_triggers('report_schedule');

CREATE TABLE report_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid REFERENCES report_schedule(id),
  report_code text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}',
  format text NOT NULL,
  lang text NOT NULL,
  status text NOT NULL CHECK (status IN ('ok','failed')),
  error text,
  attachment_id uuid REFERENCES attachment(id),
  size_bytes int,
  duration_ms int,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid
);
CREATE INDEX report_run_idx ON report_run (created_at DESC);

-- ------------------------------------------------------------------ notifications by e-mail & alert de-duplication
ALTER TABLE app_user ADD COLUMN notify_email boolean NOT NULL DEFAULT true;

CREATE TABLE email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES app_user(id),
  to_email text NOT NULL,
  subject text NOT NULL,
  html text NOT NULL,
  kind text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','logged','failed')),
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX email_outbox_status_idx ON email_outbox (status, created_at);

CREATE TABLE alert_log (
  alert_key text NOT NULL,
  alert_date date NOT NULL DEFAULT current_date,
  PRIMARY KEY (alert_key, alert_date)
);

-- ------------------------------------------------------------------ integrations
CREATE TABLE integration_client (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  system text NOT NULL CHECK (system IN ('erp','etimad','cmms','hr','other')),
  key_prefix text NOT NULL UNIQUE,
  key_hash text NOT NULL,                       -- SHA-256 of the full key; the key itself is shown once
  scopes text[] NOT NULL,
  service_user_id uuid NOT NULL REFERENCES app_user(id),
  allowed_ips text[],
  is_active boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);
SELECT attach_standard_triggers('integration_client');

CREATE TABLE integration_call (
  id bigserial PRIMARY KEY,
  client_id uuid REFERENCES integration_client(id),
  method text NOT NULL, path text NOT NULL,
  status_code int NOT NULL,
  request_id text, ip text,
  duration_ms int,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_call_idx ON integration_call (client_id, at DESC);

-- outbound events (ERP journals, Etimad requisitions, CMMS issues) — delivered by the dispatcher job
CREATE TABLE integration_outbox (
  id bigserial PRIMARY KEY,
  system text NOT NULL,
  event text NOT NULL,
  doc_type text, doc_id uuid, doc_no text,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed','stub')),
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX integration_outbox_status_idx ON integration_outbox (status, id);

-- ------------------------------------------------------------------ settings
-- Phase 1 stored flat targets ({"inventoryAccuracy": 98, ...}); the KPI engine needs {key: {target, dir}}. Keep any edited values.
UPDATE setting SET value = jsonb_build_object(
    'accuracy_pct', jsonb_build_object('target', coalesce(value -> 'inventoryAccuracy', '98'), 'dir', 'ge'),
    'fill_rate_pct', jsonb_build_object('target', coalesce(value -> 'fillRate', '95'), 'dir', 'ge'),
    'cycle_time_h', jsonb_build_object('target', coalesce(value -> 'cycleTimeHours', '24'), 'dir', 'le'),
    'dock_to_stock_h', jsonb_build_object('target', coalesce(value -> 'dockToStockHours', '48'), 'dir', 'le'),
    'dead_stock_pct', jsonb_build_object('target', coalesce(value -> 'deadStockPct', '10'), 'dir', 'le'),
    'critical_stockouts', jsonb_build_object('target', 0, 'dir', 'le'),
    'space_utilisation_pct', jsonb_build_object('target', coalesce(value -> 'spaceUtilization', '[75,85]'), 'dir', 'range'),
    'turnover', jsonb_build_object('target', 4, 'dir', 'ge'),
    'approvals_on_time_pct', jsonb_build_object('target', 90, 'dir', 'ge'))
  WHERE key = 'kpi.targets' AND value ? 'inventoryAccuracy';
INSERT INTO setting (key, value, description_ar, description_en) VALUES
  ('kpi.targets', '{"accuracy_pct":{"target":98,"dir":"ge"},"fill_rate_pct":{"target":95,"dir":"ge"},"cycle_time_h":{"target":24,"dir":"le"},"dock_to_stock_h":{"target":48,"dir":"le"},"dead_stock_pct":{"target":10,"dir":"le"},"critical_stockouts":{"target":0,"dir":"le"},"space_utilisation_pct":{"target":[75,85],"dir":"range"},"turnover":{"target":4,"dir":"ge"},"approvals_on_time_pct":{"target":90,"dir":"ge"}}',
   'مستهدفات مؤشرات الأداء', 'KPI targets'),
  ('email.enabled', 'true', 'إرسال الإشعارات بالبريد الإلكتروني', 'Send notifications by e-mail'),
  ('alerts.enabled', 'true', 'تنبيهات المخزون اليومية', 'Daily stock alerts'),
  ('app.public_url', '"http://localhost:3000"', 'رابط النظام في رسائل البريد', 'System URL used in e-mails')
ON CONFLICT (key) DO NOTHING;
