#!/usr/bin/env bash
# Development only: drops and recreates a WMS database, then migrates (and seeds unless --no-seed).
#   scripts/db-reset.sh [iarda_wms|iarda_wms_test] [--no-seed]
set -euo pipefail
DB="${1:-iarda_wms}"
PSQL_SU=${PSQL_SU:-"psql -U postgres"}
$PSQL_SU -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB OWNER wms_owner"
$PSQL_SU -q -d "$DB" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS citext;"
cd "$(dirname "$0")/../apps/api"
DATABASE_OWNER_URL="postgres://wms_owner:wms_owner_dev@localhost:5432/$DB" npx tsx src/db/migrate.ts
if [[ "${2:-}" != "--no-seed" ]]; then
  DATABASE_URL="postgres://wms_app:wms_app_dev@localhost:5432/$DB" npx tsx seed/seed.ts
fi
