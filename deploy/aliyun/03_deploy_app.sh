#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root."
  exit 1
fi

REPO_URL="${REPO_URL:-}"
BRANCH="${BRANCH:-main}"
APP_ROOT="${APP_ROOT:-/var/www/linquan}"
SHARED_ROOT="${APP_ROOT}/shared"
REPO_DIR="${APP_ROOT}/repo"
PROJECT_DIR="${REPO_DIR}"

if [[ -z "${REPO_URL}" ]]; then
  echo "REPO_URL is required. Example:"
  echo "REPO_URL=git@github.com:<your-user>/linquan-website.git bash deploy/aliyun/03_deploy_app.sh"
  exit 1
fi

mkdir -p "${APP_ROOT}" "${SHARED_ROOT}" "${APP_ROOT}/backups"

if [[ ! -d "${REPO_DIR}/.git" ]]; then
  echo "[1/7] Cloning repository..."
  git clone "${REPO_URL}" "${REPO_DIR}"
else
  echo "[1/7] Updating repository..."
  git -C "${REPO_DIR}" fetch --all --prune
fi

echo "[2/7] Checkout target branch..."
git -C "${REPO_DIR}" checkout "${BRANCH}"
git -C "${REPO_DIR}" pull --ff-only origin "${BRANCH}"

if [[ ! -d "${PROJECT_DIR}/backend" ]]; then
  echo "Backend directory not found: ${PROJECT_DIR}/backend"
  echo "REPO_URL must point to the linquan-website repository."
  exit 1
fi

mkdir -p "${APP_ROOT}"
ln -sfn "${PROJECT_DIR}/backend" "${APP_ROOT}/backend"
ln -sfn "${PROJECT_DIR}/frontend" "${APP_ROOT}/frontend"

if [[ ! -f "${SHARED_ROOT}/backend.env" ]]; then
  cp "${PROJECT_DIR}/deploy/aliyun/.env.backend.aliyun.example" "${SHARED_ROOT}/backend.env.example"
  chmod 600 "${SHARED_ROOT}/backend.env.example"
  echo "Create ${SHARED_ROOT}/backend.env from the example, set real secrets, chmod 600, then rerun."
  exit 1
fi
ln -sfn "${SHARED_ROOT}/backend.env" "${PROJECT_DIR}/backend/.env"
mkdir -p "${SHARED_ROOT}/uploads" "${SHARED_ROOT}/data"

echo "[3/7] Installing locked dependencies..."
cd "${PROJECT_DIR}/backend"
npm ci --omit=dev

echo "[4/7] Building frontend with bounded memory..."
cd "${PROJECT_DIR}/frontend"
npm ci
NODE_OPTIONS=--max-old-space-size=512 npm run build

echo "[5/7] Validating persistent configuration and migration checkpoint..."
if grep -Eq 'replace-with|ChangeThis|<your-' "${SHARED_ROOT}/backend.env"; then
  echo "Found placeholder values in ${SHARED_ROOT}/backend.env. Deployment stopped."
  exit 1
fi
if [[ "${ACCESS_MIGRATION_VERIFIED:-}" != "yes" ]]; then
  echo "Set ACCESS_MIGRATION_VERIFIED=yes only after backup, access migration, Maintainer provisioning, admin grant, and rollback verification."
  exit 1
fi

echo "[6/7] Starting app with PM2..."
cd "${PROJECT_DIR}/backend"
pm2 start ecosystem.config.cjs --env production --update-env
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null || true

echo "[7/7] Deployment complete."
pm2 status
echo "Health check: curl http://127.0.0.1:3000/api/health"
