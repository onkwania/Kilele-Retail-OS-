# Deployment, backups and recovery

## Supported operating model

One Node application process, one local persistent SQLite database, HTTPS at a trusted reverse proxy, and a private backend port. Use a supported **Node 22 or 24 LTS** release for production. The sandbox verification ran on Node 20.20.2; that is not a recommendation to deploy an unsupported Node release.

Do not use ephemeral/serverless storage, NFS/network shares for the SQLite file, or multiple app replicas. Write serialization and local login rate limiting are designed for a single instance. Business/branch/user scoping is in the relational model, but multi-branch provisioning and shared registers across application instances are not implemented as a deployment feature.

## Clean operational bootstrap

**Never convert the preview database.** Immutable environment markers (and legacy preview-email detection) refuse preview-to-operational promotion and operational-to-preview authentication.

```bash
npm ci
npm run verify
# Copy/edit this privately: real HTTPS origin, dedicated new database path.
cp .env.example .env
chmod 600 .env
# Supply BOOTSTRAP_NAME, BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD and BUSINESS_NAME
# privately through your secret manager / environment. Do not paste secrets into history.
npm run bootstrap
# Remove/unset all bootstrap password variables immediately afterwards.
npm run db:check
npm start
```

`APP_ORIGIN` must be the exact public HTTPS origin, without a trailing slash. `NODE_ENV=production` and `PREVIEW_MODE=false` are required. The API serves the compiled client from `dist/client` in production. Work from the project root so `server/schema.sql` is present.

The build also emits standalone operational commands:

```text
dist/server/index.js
dist/server/bootstrap.js
dist/server/check.js
dist/server/backup.js
dist/server/restore.js
dist/server/catalogue-update.js
```

These use runtime dependencies only; they do not require `tsx` in the deployed image.

## Docker + Caddy template

`Dockerfile`, `deploy/compose.yaml` and `deploy/Caddyfile` provide a single-instance HTTPS template. It has not been deployed to a real host from this workspace. Review/pin base-image digests as part of your release process, set DNS and firewall rules, and test your infrastructure.

1. Set `PUBLIC_HOST` in your private `.env` to the real DNS hostname. Point DNS at the host; allow only necessary management access plus TCP 80/443.
2. Build the application image.
3. Bootstrap the empty named volume with privately supplied environment variables.
4. Start the services and inspect logs/health.

```bash
docker compose --env-file .env -f deploy/compose.yaml build app
# Export private bootstrap values first. "-e NAME" reads the current environment.
docker compose --env-file .env -f deploy/compose.yaml run --rm \
  -e BOOTSTRAP_NAME -e BOOTSTRAP_EMAIL -e BOOTSTRAP_PASSWORD -e BUSINESS_NAME \
  app node dist/server/bootstrap.js
unset BOOTSTRAP_PASSWORD
docker compose --env-file .env -f deploy/compose.yaml up -d
docker compose --env-file .env -f deploy/compose.yaml logs --tail=100 app gateway
```

The app runs as a non-root user, uses a read-only container root, and has a writable named data volume. Port 3001 is not published publicly. Caddy is the only ingress and obtains TLS certificates for the configured host.

`TRUST_PROXY=1` is appropriate only with that one restricted ingress. For a different network, configure exact trusted hops/CIDRs or leave it unset. Never trust arbitrary forwarded-IP headers on a publicly reachable backend. Verify that the audit trail records the correct client IP after deployment.

## Secrets and browser security

- No service-role/database credentials are placed in client code.
- Use unique private owner/staff passwords and separate staff accounts; temporary credentials force rotation.
- Production sessions are HttpOnly, Secure, SameSite=Strict cookies. Production CSP/X-Frame-Options prohibit embedding.
- The **isolated preview only** uses Secure, SameSite=None, Partitioned cookies for embedded previews. This does not weaken production cookies or enable production preview login.
- Never commit `.env`, database files, uploaded documents, backup contents, session cookies or private keys.
- Database/WAL/SHM files are restricted to the application file owner (0600) at startup; new parent directories are created with 0700. Run backup/restore as that same account and preserve ownership. Do not grant world-readable permissions to work around a deployment error.
- Install OS/security updates; keep the database directory and backups restricted. SQLite contents are not encrypted at rest by the application; use encrypted host disks and encrypted backup storage.
- Uploaded PNG/JPEG/WebP/PDF files have type/signature/size/access checks, not antivirus scanning. Add a malware-scanning service if your risk model requires one.

## Backups

Do not copy a running database file with a naive file copy; uncheckpointed WAL pages may contain committed data. The online backup command uses SQLite’s consistent backup API and checks the resulting database, foreign keys, audit chain, balanced journals and inventory ledger.

```bash
npm run backup -- ./data/backups/your-new-snapshot.sqlite
# Or in the container; the destination is in its persistent volume:
docker compose --env-file .env -f deploy/compose.yaml exec -T app \
  node dist/server/backup.js /app/data/backups/your-new-snapshot.sqlite
```

The command refuses existing destinations, restricts file permissions, and emits a matching `.manifest.json` containing SHA-256 and the audit-event count. Both files are required for restore. Preserve them together; encrypt and copy them to separately controlled off-site storage. A checksum detects accidental change, not an attacker who controls both database and manifest. Anchor backup hashes in a separately protected log/object store for stronger evidence.

`deploy/backup.sh` is a scheduler-friendly wrapper. Example cron policy, **to be configured by your operator**, not installed automatically:

```cron
CRON_TZ=Africa/Nairobi
15 23 * * * /opt/kilele/deploy/backup.sh >> /var/log/kilele-backup.log 2>&1
```

Define your own recovery point/time objectives, retention, off-site encryption and alerting. Keep at least the latest verified restorable snapshot and test recovery regularly. Database/document growth is not automatically capped beyond the 3 MB per-document upload limit.

## Restore drill and incident recovery

1. Stop new posting and preserve the current database/WAL/filesystem snapshot for investigation.
2. Verify the backup and its independently retained manifest/hash.
3. Restore to a **new path**. The command never overwrites a live file or its WAL/SHM companions.
4. Check integrity and preview/operational provenance, and inspect reference totals and latest posting time.
5. Test a non-public application instance against that restored copy, with only one writer.
6. Reconcile the backup cutoff with provider statements and separately retained records. A restore cannot magically recover transactions posted after its cutoff.
7. Only after authorised review, stop the original service, switch `DATABASE_PATH` to the restored file and restart. Retain the incident copy securely.

```bash
npm run restore -- ./data/backups/snapshot.sqlite ./data/restored.sqlite
DATABASE_PATH=./data/restored.sqlite npm run db:check
# Compiled equivalents:
node dist/server/restore.js BACKUP.sqlite NEW_DATABASE.sqlite
DATABASE_PATH=NEW_DATABASE.sqlite node dist/server/check.js
```

Restored environment markers are preserved. A restored preview remains a preview.

## Upgrades and go-live checklist

- [ ] Back up and perform a successful restore drill before each release.
- [ ] Run unit/API tests, typecheck, lint, production build, browser acceptance and dependency audit on the release.
- [ ] Stage the new release against a backup copy. Schema changes are applied by startup; do not run an older release against a newer schema without a verified rollback plan.
- [ ] Deploy exactly one process, with persistent storage and a tested shutdown/restart procedure.
- [ ] Verify public HTTPS/origin, private backend, cookie security, actual client IP, time synchronisation and Africa/Nairobi reporting boundaries.
- [ ] Create distinct authorised staff and independent reviewers; remove unused access.
- [ ] Confirm real packages/barcodes, manually enter costs/prices/tax, record witnessed opening stock and count opening cash.
- [ ] Witness cash, M-Pesa/card/bank, split, return, expense, receiving and closing scenarios with the actual hardware and provider statements.
- [ ] Confirm your tax/licensing/age-check process and an appropriate eTIMS solution. Internal receipts are not fiscal invoices.
- [ ] Configure backup scheduling, off-site copies, restore monitoring, disk-space alerts, login/error monitoring and incident ownership.
- [ ] Obtain business/accountant approval and any required independent security review. No formal penetration test has been performed here.

**Operational limitations:** no offline sale posting, payment initiation, automatic provider reconciliation, eTIMS integration, multi-instance HA or autonomous AI financial writes. All payment/refund entries require manual confirmation outside this application.
