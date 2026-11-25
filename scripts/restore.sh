#!/usr/bin/env bash
# Restores a backup made by scripts/backup.sh into a target database (and optionally the attachment store).
#
#   scripts/restore.sh <backup-dir> <target-db-url> [storage-dir]
#   BACKUP_KEY_FILE  the passphrase file used for the backup
#
# The target database must exist and be completely empty — no extensions either (create it as wms_owner). After a restore, run
# `npx tsx apps/api/src/db/migrate.ts` (re-applies grants for the runtime role) and check
# `SELECT * FROM audit_verify();` — first_broken_id must be NULL.
set -euo pipefail
SRC="${1:?backup directory}"
TARGET="${2:?target database URL}"
STORE="${3:-}"
KEY="${BACKUP_KEY_FILE:?set BACKUP_KEY_FILE}"

( cd "$SRC" && sha256sum -c SHA256SUMS ) || { echo "restore: checksum mismatch — aborting" >&2; exit 3; }
dec() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$KEY" -in "$1"; }

echo "restore: database → $TARGET"
dec "$SRC/db.dump.enc" | pg_restore --no-owner --no-privileges --exit-on-error -d "$TARGET"

if [ -n "$STORE" ] && [ -f "$SRC/storage.tar.gz.enc" ]; then
  echo "restore: attachments → $STORE"
  mkdir -p "$STORE"
  dec "$SRC/storage.tar.gz.enc" | tar -C "$STORE" -xzf -
fi
psql "$TARGET" -Atc "SELECT 'audit chain: ' || coalesce('BROKEN at ' || first_broken_id, 'intact') || ' (' || checked || ' entries)' FROM audit_verify()"
echo "restore: done"
