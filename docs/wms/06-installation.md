# Installation

One Docker image runs the whole system. The API serves the web app, brand assets and PDF export from one address, and on every start it migrates the database, creates the least-privilege runtime role, and (if asked) loads the demonstration data. Starting it again is safe.

| File | Purpose |
|---|---|
| `Dockerfile` | Builds the image (web build, API, Chromium for PDF reports). |
| `render.yaml` | Render Blueprint for the test deployment: web service, PostgreSQL 16, disk, generated secrets. |
| `docker-compose.yml` | Internal server: PostgreSQL 16 and the app, with persistent volumes. |
| `.env.example` | Settings and secrets for the internal server. |
| `apps/api/src/boot.ts` | Start-up sequence: extensions, runtime role, migrations, optional seed, server. |
| `scripts/docker-entrypoint.sh` | Makes the storage directory writable, then runs the app as the unprivileged `node` user. |

## 1. Test deployment on Render

> Render is for testing with demonstration data only. The database is hosted outside the Kingdom, so real operational or personal data belongs on the authority's internal server.

1. Sign in at render.com with GitHub, and allow Render to access the `amhq1994/iarda` repository.
2. **New → Blueprint**, choose the repository and the branch that holds `render.yaml` (currently `claude/iarda-brand-identity-nih0j5`, or `main` after the pull request is merged).
3. Render reads `render.yaml` and shows two resources: `iarda-wms` (web service) and `iarda-wms-db` (PostgreSQL). Click **Apply**.
4. The first build takes about 5–10 minutes. When the service shows *Live*, open its address (`https://iarda-wms-….onrender.com`).
5. Sign in as `admin` with the demo password `Iarda@2026!`. Every demo account uses the same password. The demo accounts list is not shown on the login page in this build, so change the `admin` password from *Users* if you share the address.

What Render generates and keeps: `DATA_ENCRYPTION_KEY`, `APP_DB_PASSWORD`, `INTEGRATION_SECRET` (*Environment* tab of the service). Never change `DATA_ENCRYPTION_KEY` after data exists: attachments and personal fields are encrypted with it.

**Cost.** The Blueprint uses paid plans so data and attachments persist: web service *Starter*, database *Basic 256 MB*, and a 1 GB disk. Check current prices on Render's pricing page before applying.

**Free option (short trial only).** In `render.yaml` set the web `plan: free`, delete the `disk:` block, and set the database `plan: free`. Limits: the service sleeps when idle (the first visit then takes about a minute), uploaded attachments are lost on every restart or deploy, and Render's free database expires after a limited period.

**Reset the demo data.** In the database page choose *Delete*, then re-apply the Blueprint, or connect with the *PSQL command* and run `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` and restart the service.

## 2. Internal server

Any server that runs Docker: Linux (Ubuntu 22.04+/RHEL 9 recommended) or Windows Server with Docker. Minimum 2 vCPU, 4 GB RAM, 40 GB disk.

```bash
git clone <repository> iarda && cd iarda
cp .env.example .env
# fill in DB_OWNER_PASSWORD, APP_DB_PASSWORD, DATA_ENCRYPTION_KEY, INTEGRATION_SECRET:
openssl rand -base64 32
docker compose up -d --build
docker compose logs -f app      # wait for "Server listening"
```

Then:

- **TLS.** Publish the app through the authority's reverse proxy or load balancer over HTTPS, forwarding to port 3000. Keep `COOKIE_SECURE=true`.
- **Backups.** Schedule `scripts/backup.sh` daily (database and attachments, encrypted) to storage outside the server, and test `scripts/restore.sh` monthly. Keep `DATA_ENCRYPTION_KEY` and the backup key in the authority's secret store, apart from the backups.
- **E-mail and SSO.** Set `SMTP_URL` / `SMTP_FROM` for notifications and `OIDC_ISSUER` / `OIDC_CLIENT_ID` for Azure AD sign-in.
- **Updates.** `git pull && docker compose up -d --build`. Migrations run automatically on start.

Production starts empty (`SEED_MODE` left blank). The production first-run setup (roles, units of measure, the first administrator account, and loading the real item master and opening balances) is the next installation step.

## 3. Settings reference

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_OWNER_URL` | yes | PostgreSQL connection of the schema owner. |
| `DATABASE_URL` | no | Runtime connection. If unset, `boot.ts` creates `APP_DB_ROLE` with `APP_DB_PASSWORD` and uses it; if the database refuses to create roles, the owner connection is used and a warning is logged. |
| `APP_DB_ROLE`, `APP_DB_PASSWORD` | recommended | Least-privilege runtime role (no DELETE, no direct stock or audit writes). |
| `DATA_ENCRYPTION_KEY` | yes | 32 bytes, base64. |
| `SEED_MODE` | no | `demo` loads demonstration data once. |
| `STORAGE_DIR` | no | Attachment store, default `/data/storage` in the image. |
| `SMTP_URL`, `SMTP_FROM` | no | Outgoing e-mail. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID` | no | Azure AD / Entra ID single sign-on. |
| `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS` | no | Session limits (30 min idle, 12 h absolute). |
| `COOKIE_SECURE` | no | `false` only for testing without HTTPS. |

## Verified

The image was built and started against an empty PostgreSQL 16 database owned by a non-superuser account, the way Render provides it: the runtime role was created, all 11 migrations applied, the demo data loaded (28 users, 5 warehouses, 200 items), sign-in worked in the browser, a restart re-applied nothing, and the app ran as the unprivileged user with a root-owned empty disk mounted at `/data`. A second run on a database that refuses `CREATE ROLE` fell back to the owner connection with a warning. PDF export needs the Chromium layer, which this test environment could not download; Render's builder downloads it normally.
