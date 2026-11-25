-- Development / test database bootstrap (run once as a PostgreSQL superuser):
--   psql -U postgres -f scripts/db-setup.sql
-- Production: create the same two roles with strong passwords from your secret store.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms_owner') THEN
    CREATE ROLE wms_owner LOGIN PASSWORD 'wms_owner_dev';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms_app') THEN
    CREATE ROLE wms_app LOGIN PASSWORD 'wms_app_dev';
  END IF;
END $$;
SELECT 'CREATE DATABASE iarda_wms OWNER wms_owner' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'iarda_wms')\gexec
SELECT 'CREATE DATABASE iarda_wms_test OWNER wms_owner' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'iarda_wms_test')\gexec
\c iarda_wms
CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS citext;
\c iarda_wms_test
CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS citext;
