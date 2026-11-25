# WMS Operations: Configuration, Backups and Security Controls

This document covers running the WMS in production. The installation steps for the chosen hosting come in the next (deployment) step.

## Runtime configuration (environment variables)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Runtime connection as **`wms_app`**: no DELETE/TRUNCATE, no writes to the audit tables, read-only on stock tables |
| `DATABASE_OWNER_URL` | Migrations only, as **`wms_owner`**. Never give this to the running app |
| `DATA_ENCRYPTION_KEY` | 32-byte key (base64) for AES-256-GCM (PII fields and attachments). Required in production. Keep it in the secret store, and back it up separately from the data backups |
| `SESSION_IDLE_MINUTES` / `SESSION_ABSOLUTE_HOURS` | Session timeouts (default 30 min idle, 12 h absolute) |
| `STORAGE_DIR` | Encrypted attachment store, on a persistent volume |
| `NODE_ENV=production` | Turns on HSTS and secure cookies |
| `SMTP_URL`, `SMTP_FROM` | E-mail delivery, e.g. `smtps://user:pass@mail.iarda.gov.sa:465`. Unset: messages are logged only |
| `INTEGRATION_ERP_URL` / `_ETIMAD_URL` / `_CMMS_URL` / `_HR_URL` | Receivers of outbound events. Unset: events kept as *stub* |
| `INTEGRATION_SECRET` | HMAC key for `x-iarda-signature` on outbound events |
| `JOBS` | `off` disables the scheduler (one instance should run it; an advisory lock already prevents double runs) |
| PDF reports | Need Chromium (Playwright). Without it, PDF returns *501* and Excel / PowerPoint still work |

In-app settings (Settings page, all audited):
- `planning.*`
- `valuation.*`
- `kpi.targets`
- `count.tolerance_pct`
- `email.enabled`
- `alerts.enabled`
- `app.public_url` (links in e-mails)

## Scheduled jobs (in-process, single runner)

| When | Job |
|---|---|
| Every minute | Request SLA escalation · e-mail dispatch · integration outbox dispatch · due scheduled reports |
| Nightly (after 01:00 Riyadh) | Stock alerts · KPI snapshot · planning run (+ auto requisitions if enabled) · journal generation up to midnight |

## Backups (`scripts/backup.sh`, `scripts/restore.sh`)

- **Contents:** `pg_dump` (custom format) plus the attachment store, each encrypted with **AES-256 (PBKDF2, 200k iterations)**, with a `SHA256SUMS` manifest.
- **Retention:** 35 days by default (`RETENTION_DAYS`).
- **Recommended policy:**
  - Nightly full backup at 02:30, written to off-host storage.
  - Monthly **restore drill** into an empty database, checking that `audit_verify()` reports *intact*.
  - PostgreSQL WAL archiving or managed point-in-time recovery for an RPO of 15 minutes or less.
- **Restore:**

  ```bash
  BACKUP_KEY_FILE=/run/secrets/backup.key scripts/restore.sh /backups/20261125T023000Z postgres://wms_owner:…@db/iarda_wms_restore /srv/wms/storage
  DATABASE_OWNER_URL=postgres://wms_owner:…@db/iarda_wms_restore npx tsx apps/api/src/db/migrate.ts   # re-applies runtime-role grants
  ```

  Verified in the build environment: an encrypted backup of the demo database restored into an empty database with all data and an intact audit chain.

## Security controls (NCA ECC-1:2018 / PDPL mapping)

| Control area | Implementation |
|---|---|
| Identity & access (ECC 2-2) | RBAC: 14 roles, 58 permissions, warehouse and department scopes. TOTP MFA (can be required per role). Lockout after failed logins. Login rate limit. Idle session timeout. Password policy |
| Segregation of duties | Requester ≠ approver ≠ issuer ≠ adjuster ≠ poster. Inspection committee ≠ receiver. Count & disposal committees recommend only. Enforced in services and, for key rules, in the database |
| Data protection (ECC 2-7, PDPL) | AES-256-GCM for PII (mobile numbers) and every attachment, with SHA-256 integrity checks. TLS terminated at the proxy, HSTS. Masking of PII in the audit trail. Supplier users see only their own records |
| Logging & monitoring (ECC 2-12) | Hash-chained, append-only audit log of every change (who, when, IP, request id, old/new values, on-behalf-of). Security events. Integration call log. `audit_verify()` tamper check |
| Data integrity | Quantities change only through `SECURITY DEFINER` posting functions; no negative stock (database checks). Posted journals frozen by trigger. Ledger, audit log and journal sources are append-only. Soft delete only |
| Application security (ECC 2-15) | CSP, frame-ancestors none, CSRF header on state-changing calls, SameSite=Strict httpOnly cookies, Zod validation on every input, parameterised SQL only, file-type sniffing on uploads (JPG/PNG/WEBP/PDF), rate limits |
| Backup & recovery (ECC 2-9) | Encrypted backups with checksums and retention, documented restore, readiness probe `/api/ready` |
| Third parties (ECC 4-1) | Integration clients with scoped keys, IP allow-lists, per-key rate limits, signed outbound events, full call log |
| Data residency | Self-hostable. Deploy in a KSA region or on-premises to keep data in the Kingdom |

## Monitoring checklist

- **`GET /api/health`** (process) and **`GET /api/ready`** (database and migrations) from the load balancer.
- **Alerts:**
  - `email_outbox` rows with `failed` status
  - `integration_outbox` `failed` backlog
  - `report_run` rows with `failed` status
- **Integrity:** daily `SELECT * FROM audit_verify()` (`first_broken_id` must be NULL), and ledger = balances:

  ```sql
  SELECT (SELECT sum(qty) FROM stock_ledger) = (SELECT sum(qty_on_hand) FROM stock_balance);
  ```
