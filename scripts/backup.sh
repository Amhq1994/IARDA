#!/usr/bin/env bash
# Encrypted backup of the WMS: database (pg_dump custom format) + attachment store, with a SHA-256 manifest
# and retention. Run from cron / a systemd timer / the platform scheduler, e.g. daily at 02:30 Riyadh time.
#
#   DATABASE_OWNER_URL  postgres://wms_owner:…@host:5432/iarda_wms   (or DATABASE_URL)
#   BACKUP_DIR          target directory (default ./backups)            — mount an off-host volume in production
#   BACKUP_KEY_FILE     file holding the encryption passphrase (≥ 32 random chars, kept in the secret store)
#   STORAGE_DIR         attachment store (default ./storage)
#   RETENTION_DAYS      delete backups older than this (default 35)
#
# Restore with scripts/restore.sh. Test a restore at least monthly (NCA ECC 2-9).
set -euo pipefail
DB_URL="${DATABASE_OWNER_URL:-${DATABASE_URL:?set DATABASE_OWNER_URL}}"
DIR="${BACKUP_DIR:-./backups}"
KEY="${BACKUP_KEY_FILE:?set BACKUP_KEY_FILE (passphrase file)}"
STORE="${STORAGE_DIR:-./storage}"
KEEP="${RETENTION_DAYS:-35}"
[ -r "$KEY" ] || { echo "backup: key file not readable: $KEY" >&2; exit 2; }
[ "$(wc -c < "$KEY")" -ge 32 ] || { echo "backup: key must be at least 32 bytes" >&2; exit 2; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DIR/$STAMP"
mkdir -p "$OUT"
umask 077

enc() { openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$KEY" -out "$1"; }

echo "backup: database → $OUT/db.dump.enc"
pg_dump --format=custom --compress=6 --no-owner --no-privileges "$DB_URL" | enc "$OUT/db.dump.enc"

if [ -d "$STORE" ]; then
  echo "backup: attachments → $OUT/storage.tar.gz.enc"
  tar -C "$STORE" -czf - . | enc "$OUT/storage.tar.gz.enc"
fi

( cd "$OUT" && sha256sum ./*.enc > SHA256SUMS )
psql "$DB_URL" -Atc "SELECT 'migrations=' || count(*) FROM schema_migrations" > "$OUT/INFO" 2>/dev/null || true
echo "created=$STAMP" >> "$OUT/INFO"

# retention
find "$DIR" -mindepth 1 -maxdepth 1 -type d -name '20*Z' -mtime +"$KEEP" -print -exec rm -rf {} + | sed 's/^/backup: pruned /'
echo "backup: done ($(du -sh "$OUT" | cut -f1))"
