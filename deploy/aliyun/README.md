# Alibaba ECS Deployment Assets

This directory provides production deployment files for Ubuntu 24.04 on Alibaba ECS:

- `01_init_server.sh`: initialize system, install Node.js 20 LTS, PM2, Nginx, UFW.
- `02_setup_postgres.sh`: install PostgreSQL and create app database/user.
- `03_deploy_app.sh`: clone/pull repo, install/build app, start PM2.
- `04_setup_nginx.sh`: apply reverse proxy config to `127.0.0.1:3000`.
- `05_enable_https.sh`: configure Let's Encrypt with Certbot.
- `06_update_app.sh`: verify disk headroom, create a PostgreSQL-or-SQLite plus uploads rollback
  snapshot, pull/build, and reload PM2 only after the migration checkpoint.
- `nginx-linquan.conf`: Nginx site template with bounded uploads and gzip for text/JSON/JS/CSS.
- `.env.backend.aliyun.example`: backend production env template.
- `sql/*.sql`: reviewed migrations. Apply every file explicitly in the following filename order,
  and only after a restored-backup gate:
  1. `0000_baseline.sql`
  2. `2026-04-06_additive_postgres_compat.sql`
  3. `2026-07-19_access_security_architecture.sql`
  4. `2026-07-20_contributors.sql`
  5. `2026-07-20_shared_room_inventory.sql`
  6. `2026-07-20_unified_archival_policy.sql`
  7. `2026-07-24_profile_reminder.sql`
  8. `2026-07-24_release_integrity.sql`
  9. `2026-07-24_remove_legacy_concert_review.sql`

Runtime layout on server:

- code: `/var/www/linquan/repo` (the cloned `linquan-website` repository)
- backend link: `/var/www/linquan/backend`
- frontend link: `/var/www/linquan/frontend`
- persistent environment: `/var/www/linquan/shared/backend.env` (`0600`)
- persistent uploads: `/var/www/linquan/shared/uploads`
- SQLite fallback: `/var/www/linquan/shared/data/linquan.db`
- rollback snapshots: `/var/www/linquan/backups/<UTC timestamp>`

Run scripts as `root`. Deployment/update intentionally stops before PM2 reload unless
`ACCESS_MIGRATION_VERIFIED=yes`; this is a human checkpoint, not permission to run a
migration against the live database without first restoring and validating a backup.
The update script sources only the root-owned `shared/backend.env`; keep it shell-compatible and
mode `0600`. A PostgreSQL deployment requires working `psql` and `pg_dump` clients, and the update
stops before code changes if either the database snapshot or conservative disk preflight fails.
The shared-room migration aborts on ambiguous existing scheduling conflicts instead of deleting
data. Keep `PG_POOL_MAX` and all PostgreSQL timeout values bounded for the 2 GiB host.
Every migration is transactional and designed to be safely rechecked/reapplied where practical.
`0000_baseline.sql` owns the previously missing empty-database baseline. On an existing database its
`CREATE TABLE IF NOT EXISTS` statements are non-destructive; the dated migrations remain responsible
for additive upgrades. The release-integrity migration adds forced Member password change/audit and
the required `notifications` table.
Always use `psql -v ON_ERROR_STOP=1`; if a migration fails, retain its output, confirm the
transaction rolled back, reconcile the restored copy, and do not continue with later files.
The 2026-07-19 rendered template passed `nginx -t` in an official Nginx container; TLS/Certbot and
systemd/PM2 still require verification on the actual Ubuntu host.
