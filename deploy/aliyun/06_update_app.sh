#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root."
  exit 1
fi

APP_ROOT="${APP_ROOT:-/var/www/linquan}"
REPO_DIR="${APP_ROOT}/repo"
PROJECT_DIR="${REPO_DIR}"
BRANCH="${BRANCH:-main}"
SHARED_ROOT="${APP_ROOT}/shared"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${APP_ROOT}/backups/${STAMP}"

if [[ ! -d "${REPO_DIR}/.git" ]]; then
  echo "Repository not found: ${REPO_DIR}"
  exit 1
fi

if [[ ! -f "${SHARED_ROOT}/backend.env" ]]; then
  echo "Persistent environment file missing: ${SHARED_ROOT}/backend.env"
  exit 1
fi

set -a
# backend.env is the root-owned, mode-0600 application environment file.
# shellcheck disable=SC1090
source "${SHARED_ROOT}/backend.env"
set +a

UPLOAD_KB=0
SQLITE_KB=0
POSTGRES_KB=0
if [[ -d "${SHARED_ROOT}/uploads" ]]; then
  UPLOAD_KB="$(du -sk "${SHARED_ROOT}/uploads" | awk '{print $1}')"
fi
if [[ -f "${SHARED_ROOT}/data/linquan.db" ]]; then
  SQLITE_KB="$(du -sk "${SHARED_ROOT}/data/linquan.db"* | awk '{sum += $1} END {print sum + 0}')"
fi
if [[ -n "${DATABASE_URL:-}" ]]; then
  command -v pg_dump >/dev/null || { echo "pg_dump is required for PostgreSQL backup."; exit 1; }
  command -v psql >/dev/null || { echo "psql is required for PostgreSQL backup preflight."; exit 1; }
  POSTGRES_BYTES="$(psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -Atc 'SELECT pg_database_size(current_database())')"
  POSTGRES_KB="$(( (POSTGRES_BYTES + 1023) / 1024 ))"
elif [[ ! -f "${SHARED_ROOT}/data/linquan.db" ]]; then
  echo "Neither DATABASE_URL nor the persistent SQLite database is available."
  exit 1
fi

AVAILABLE_KB="$(df -Pk "${APP_ROOT}" | awk 'NR == 2 {print $4}')"
# Preserve 1 GiB of headroom in addition to a conservative uncompressed backup estimate.
REQUIRED_KB="$((UPLOAD_KB + SQLITE_KB + POSTGRES_KB + 1048576))"
if (( AVAILABLE_KB < REQUIRED_KB )); then
  echo "Insufficient disk for rollback snapshot: available=${AVAILABLE_KB} KiB required=${REQUIRED_KB} KiB."
  exit 1
fi

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"
if [[ -n "${DATABASE_URL:-}" ]]; then
  pg_dump --format=custom --file="${BACKUP_DIR}/postgres.dump" "${DATABASE_URL}"
else
  cp -a "${SHARED_ROOT}/data/linquan.db"* "${BACKUP_DIR}/"
fi
if [[ -d "${SHARED_ROOT}/uploads" ]]; then
  tar -C "${SHARED_ROOT}" -czf "${BACKUP_DIR}/uploads.tar.gz" uploads
fi
echo "Rollback snapshot created: ${BACKUP_DIR}"

echo "[1/5] Pulling latest code..."
git -C "${REPO_DIR}" fetch --all --prune
git -C "${REPO_DIR}" checkout "${BRANCH}"
git -C "${REPO_DIR}" pull --ff-only origin "${BRANCH}"

echo "[2/5] Installing backend dependencies..."
cd "${PROJECT_DIR}/backend"
npm ci --omit=dev

echo "[3/5] Building frontend..."
cd "${PROJECT_DIR}/frontend"
npm ci
NODE_OPTIONS=--max-old-space-size=512 npm run build

if [[ "${ACCESS_MIGRATION_VERIFIED:-}" != "yes" ]]; then
  echo "Code built, but reload stopped. Complete the documented migration/checkpoint and rerun with ACCESS_MIGRATION_VERIFIED=yes."
  exit 1
fi

echo "[4/5] Reloading PM2..."
cd "${PROJECT_DIR}/backend"
ln -sfn "${SHARED_ROOT}/backend.env" .env
pm2 reload ecosystem.config.cjs --update-env || pm2 start ecosystem.config.cjs --env production --update-env
pm2 save

echo "[5/5] Done."
curl -fsS http://127.0.0.1:3000/api/health && echo
