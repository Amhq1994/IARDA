-- 001 · Foundation: extensions, request context, audit trail (hash-chained, append-only),
--        soft-delete guard, organisation & security tables.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

-- ------------------------------------------------------------------ request context
-- The API sets these with SET LOCAL inside every write transaction.
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_on_behalf_of() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.on_behalf_of', true), '')::uuid $$;

-- ------------------------------------------------------------------ generic triggers
CREATE OR REPLACE FUNCTION trg_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := coalesce(app_user_id(), NEW.updated_by);
  NEW.version := coalesce(OLD.version, 0) + 1;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION trg_stamp_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_by := coalesce(NEW.created_by, app_user_id());
  NEW.updated_by := coalesce(NEW.updated_by, NEW.created_by);
  RETURN NEW;
END $$;

-- Soft delete only (NFR): physical DELETE is refused on business tables.
CREATE OR REPLACE FUNCTION trg_forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'DELETE is not allowed on %; use soft delete (deleted_at)', TG_TABLE_NAME
    USING ERRCODE = 'P0001', HINT = 'soft_delete_only';
END $$;

-- ------------------------------------------------------------------ audit trail
CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  table_name    text        NOT NULL,
  record_id     uuid,
  action        text        NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  old_values    jsonb,
  new_values    jsonb,
  changed_fields text[],
  actor_id      uuid,
  on_behalf_of  uuid,
  request_id    text,
  ip            text,
  prev_hash     text,
  hash          text        NOT NULL
);
CREATE INDEX audit_log_record_idx ON audit_log (table_name, record_id, id);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, at);
CREATE INDEX audit_log_at_idx ON audit_log (at);

CREATE OR REPLACE FUNCTION audit_hash(p_prev text, p_table text, p_record uuid, p_action text,
  p_old jsonb, p_new jsonb, p_actor uuid, p_at timestamptz) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(digest(concat_ws('|', coalesce(p_prev, 'GENESIS'), p_table, p_record::text, p_action,
    coalesce(p_old::text, ''), coalesce(p_new::text, ''), coalesce(p_actor::text, ''),
    to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')), 'sha256'), 'hex')
$$;

-- Fields never written to the audit diff (secrets) are masked.
CREATE OR REPLACE FUNCTION audit_mask(j jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN j IS NULL THEN NULL
    ELSE j - 'password_hash' - 'mfa_secret' - 'token_hash'
      || CASE WHEN j ? 'password_hash' THEN '{"password_hash":"***"}'::jsonb ELSE '{}'::jsonb END
      || CASE WHEN j ? 'mfa_secret' AND j->>'mfa_secret' IS NOT NULL THEN '{"mfa_secret":"***"}'::jsonb ELSE '{}'::jsonb END
  END
$$;

CREATE OR REPLACE FUNCTION trg_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old jsonb; v_new jsonb; v_prev text; v_at timestamptz := clock_timestamp();
  v_changed text[]; v_id uuid; v_actor uuid := app_user_id();
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN v_old := to_jsonb(OLD); END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN v_new := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' THEN
    -- compare raw values (so secret changes are detected), then keep only changed fields
    SELECT array_agg(k ORDER BY k) INTO v_changed
      FROM jsonb_object_keys(v_new) k
     WHERE k NOT IN ('updated_at','updated_by','version','last_login_at','failed_logins') -- login noise lives in security_event
       AND (v_new->k) IS DISTINCT FROM (v_old->k);
    IF v_changed IS NULL THEN RETURN NEW; END IF;  -- no business change
    SELECT jsonb_object_agg(k, v_old->k) INTO v_old FROM unnest(v_changed) k;
    SELECT jsonb_object_agg(k, v_new->k) INTO v_new FROM unnest(v_changed) k;
  END IF;
  v_old := audit_mask(v_old);
  v_new := audit_mask(v_new);
  v_id := coalesce((to_jsonb(NEW)->>'id')::uuid, (to_jsonb(OLD)->>'id')::uuid);
  -- serialise the hash chain
  PERFORM pg_advisory_xact_lock(814201);
  SELECT hash INTO v_prev FROM audit_log ORDER BY id DESC LIMIT 1;
  INSERT INTO audit_log (at, table_name, record_id, action, old_values, new_values, changed_fields,
                         actor_id, on_behalf_of, request_id, ip, prev_hash, hash)
  VALUES (v_at, TG_TABLE_NAME, v_id, TG_OP, v_old, v_new, v_changed, v_actor, app_on_behalf_of(),
          nullif(current_setting('app.request_id', true), ''), nullif(current_setting('app.ip', true), ''),
          v_prev, audit_hash(v_prev, TG_TABLE_NAME, v_id, TG_OP, v_old, v_new, v_actor, v_at));
  RETURN coalesce(NEW, OLD);
END $$;

-- The audit trail itself is immutable.
CREATE OR REPLACE FUNCTION trg_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001', HINT = 'immutable';
END $$;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION trg_immutable();

-- Recomputes the chain; returns the first broken entry id (NULL = intact).
CREATE OR REPLACE FUNCTION audit_verify(p_from bigint DEFAULT 1) RETURNS TABLE (checked bigint, first_broken_id bigint)
LANGUAGE plpgsql STABLE AS $$
DECLARE r record; v_prev text; n bigint := 0;
BEGIN
  SELECT hash INTO v_prev FROM audit_log WHERE id < p_from ORDER BY id DESC LIMIT 1;
  FOR r IN SELECT * FROM audit_log WHERE id >= p_from ORDER BY id LOOP
    n := n + 1;
    IF r.prev_hash IS DISTINCT FROM v_prev OR r.hash <> audit_hash(r.prev_hash, r.table_name, r.record_id, r.action,
         r.old_values, r.new_values, r.actor_id, r.at) THEN
      checked := n; first_broken_id := r.id; RETURN NEXT; RETURN;
    END IF;
    v_prev := r.hash;
  END LOOP;
  checked := n; first_broken_id := NULL; RETURN NEXT;
END $$;

-- Helper used by every later migration to attach the standard triggers.
CREATE OR REPLACE FUNCTION attach_standard_triggers(p_table text, p_soft_delete boolean DEFAULT true) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER %1$s_stamp BEFORE INSERT ON %1$I FOR EACH ROW EXECUTE FUNCTION trg_stamp_insert()', p_table);
  EXECUTE format('CREATE TRIGGER %1$s_touch BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION trg_touch()', p_table);
  EXECUTE format('CREATE TRIGGER %1$s_audit AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION trg_audit()', p_table);
  IF p_soft_delete THEN
    EXECUTE format('CREATE TRIGGER %1$s_no_delete BEFORE DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION trg_forbid_delete()', p_table);
  END IF;
END $$;

-- ------------------------------------------------------------------ organisation & security
CREATE TABLE org_unit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name_ar text NOT NULL,
  name_en text NOT NULL,
  unit_type text NOT NULL DEFAULT 'department' CHECK (unit_type IN ('agency','department','section','cost_center')),
  parent_id uuid REFERENCES org_unit(id),
  cost_center_code text,
  annual_budget numeric(18,2) NOT NULL DEFAULT 0 CHECK (annual_budget >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz, deleted_by uuid
);

CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username citext NOT NULL UNIQUE,
  employee_no text UNIQUE,
  name_ar text NOT NULL,
  name_en text NOT NULL,
  email citext UNIQUE,
  mobile_enc text,                       -- AES-256-GCM, application-level (PDPL)
  org_unit_id uuid REFERENCES org_unit(id),
  position_ar text, position_en text,
  manager_id uuid REFERENCES app_user(id),
  supplier_id uuid,                      -- set for supplier-portal users (FK added in 002)
  auth_provider text NOT NULL DEFAULT 'local' CHECK (auth_provider IN ('local','oidc','ldap')),
  password_hash text,
  password_changed_at timestamptz,
  must_change_password boolean NOT NULL DEFAULT false,
  mfa_enabled boolean NOT NULL DEFAULT false,
  mfa_secret text,                       -- encrypted
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  preferred_lang text NOT NULL DEFAULT 'ar' CHECK (preferred_lang IN ('ar','en')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','suspended')),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz, deleted_by uuid
);
CREATE INDEX app_user_org_idx ON app_user (org_unit_id);
CREATE INDEX app_user_name_trgm ON app_user USING gin ((name_ar || ' ' || name_en) gin_trgm_ops);

CREATE TABLE role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name_ar text NOT NULL, name_en text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('all','warehouse','department','own','supplier','tasks')),
  is_system boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz, deleted_by uuid
);

CREATE TABLE permission (
  key text PRIMARY KEY,
  name_ar text NOT NULL, name_en text NOT NULL,
  module text NOT NULL
);

CREATE TABLE role_permission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES role(id),
  permission_key text NOT NULL REFERENCES permission(key),
  is_granted boolean NOT NULL DEFAULT true,          -- revoking = set false (no hard delete)
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (role_id, permission_key)
);

CREATE TABLE user_role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id),
  role_id uuid NOT NULL REFERENCES role(id),
  warehouse_ids uuid[],          -- NULL = all warehouses (for warehouse-scoped roles)
  org_unit_ids uuid[],           -- NULL = user's own org unit (for department-scoped roles)
  valid_from date NOT NULL DEFAULT current_date,
  valid_to date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (user_id, role_id)
);

CREATE TABLE delegation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id uuid NOT NULL REFERENCES app_user(id),
  to_user_id uuid NOT NULL REFERENCES app_user(id),
  role_id uuid REFERENCES role(id),
  doc_types text[],
  max_value numeric(18,2),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  CHECK (from_user_id <> to_user_id),
  CHECK (valid_to > valid_from)
);

CREATE TABLE user_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id),
  token_hash text NOT NULL UNIQUE,
  mfa_passed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip text, user_agent text,
  revoked_at timestamptz
);
CREATE INDEX user_session_user_idx ON user_session (user_id);

CREATE TABLE security_event (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  event text NOT NULL,               -- login_success, login_failed, locked, logout, mfa_enabled, password_changed …
  username text, user_id uuid, ip text, user_agent text, details jsonb
);
CREATE TRIGGER security_event_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON security_event
  FOR EACH STATEMENT EXECUTE FUNCTION trg_immutable();

CREATE TABLE setting (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  description_ar text, description_en text,
  id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1
);

CREATE TABLE number_sequence (
  doc_type text NOT NULL,
  period text NOT NULL,              -- e.g. Hijri year "1448"
  prefix text NOT NULL,
  next_no bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (doc_type, period)
);

CREATE TABLE attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type text NOT NULL,
  owner_id uuid NOT NULL,
  category text NOT NULL,            -- image, spec_sheet, inspection_report, minutes, invoice, signature …
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL,
  storage_key text NOT NULL,         -- encrypted blob on disk / object store
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz, deleted_by uuid
);
CREATE INDEX attachment_owner_idx ON attachment (owner_type, owner_id) WHERE deleted_at IS NULL;

SELECT attach_standard_triggers('org_unit');
SELECT attach_standard_triggers('app_user');
SELECT attach_standard_triggers('role');
SELECT attach_standard_triggers('role_permission');
SELECT attach_standard_triggers('user_role');
SELECT attach_standard_triggers('delegation');
SELECT attach_standard_triggers('setting');
SELECT attach_standard_triggers('attachment');
-- user_session: high-volume, security_event already records logins; protect from deletes only
CREATE TRIGGER user_session_no_delete BEFORE DELETE ON user_session FOR EACH ROW EXECUTE FUNCTION trg_forbid_delete();
