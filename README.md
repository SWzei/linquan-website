# NJU 林泉钢琴社网站

Complete Linquan piano club website: Vue 3 frontend, Express backend, SQLite for local
development, PostgreSQL for production.

## Project Layout

- [`frontend/`](./frontend) — Vue 3 + Vue Router + Pinia + Axios single-page app
- [`backend/`](./backend) — Node.js + Express + JWT + Multer + Nodemailer API server
- [`database/`](./database) — canonical SQLite schema (`schema.sql`) and the local dev database
- [`deploy/aliyun/`](./deploy/aliyun) — server bootstrap scripts, Nginx config, and reviewed SQL migrations (`sql/`)
- `render.yaml` — Render Blueprint (single web service, `rootDir: backend`)

## Requirements

- Node.js >= 20 < 25, npm >= 10
- SQLite: bundled via `better-sqlite3`, no separate install
- PostgreSQL 16 for production parity checks (a disposable Docker instance is enough)

## Install

```bash
cd backend && npm ci
cd ../frontend && npm ci
cd ..
cp .env.example backend/.env
```

The copied file contains local-development placeholders only. Replace every placeholder before
using it in production.

## Initialize The Local Database

```bash
cd backend
npm run db:init
```

This creates `database/linquan.db` from `database/schema.sql`, applies runtime schema
normalization, and seeds the default semester with 196 standard room slots. It never creates
accounts. Provision the first Maintainer explicitly (server-side, requires a confirmation phrase
and a strong password; credentials are never printed):

```bash
npm run maintainer:provision
```

Optional disposable test members (refused outside temp directories and in production):

```bash
npm run seed:test-members
```

## Run

```bash
# backend API on http://localhost:4000 (serves frontend/dist when built)
cd backend && npm run dev

# or frontend dev server with /api proxy to the backend
cd frontend && npm run serve
```

Existing process environment variables always win. When commands run from `backend/`, the loader
uses the first existing file of `backend/.env` and the repository-root `.env` (see
[`.env.example`](./.env.example)). A non-empty `DATABASE_URL` selects PostgreSQL and ignores
`DB_PATH`; otherwise SQLite uses `DB_PATH`, defaulting to `../database/linquan.db` relative to the
backend working directory.

## Test

All suites use disposable databases and must pass before any release:

```bash
cd backend
npm run test:smoke              # full functional regression on a disposable SQLite DB
npm run test:modules:light      # module flow against a disposable SQLite source/copy
npm run test:security-guards    # password policy, seed/provision guards, TLS fail-closed
npm run test:clean-start        # fresh init + provision + login + auth boundaries
npm run test:targeted-defects   # regression tests for previously fixed defects
npm run test:sqlite:upgrade     # legacy SQLite schema upgrade path
npm run test:postgres:targeted  # PostgreSQL-specific behaviors (needs disposable PG)
npm run test:postgres:timeouts  # statement-timeout write safety (needs disposable PG)
npm run test:compat:backup      # full flow against a restored backup copy

cd frontend
npm run lint
npm run test:authenticated-files
npm run test:auth-ui-state
```

`test:modules:light` must receive `LIGHT_SOURCE_DB` or `DB_PATH` pointing to a disposable SQLite
database when used as a release gate. `test:compat:backup` is an operator-driven client: start the
application against a disposable restored backup, then provide `COMPAT_BASE_URL`,
`COMPAT_ADMIN_CREDENTIAL`, and `COMPAT_ADMIN_PASSWORD`. Never point either test at live data.

## Build

```bash
cd frontend && npm run build    # outputs frontend/dist (content-hashed, no source maps)
```

The backend serves `frontend/dist` when `SERVE_FRONTEND=true`, so a single Node process can host
the whole site.

## Deploy

- Production runbook (backup → build → restored-backup validation → explicit migration → PM2
  reload → health checks → rollback): [`deploy/aliyun/README.md`](./deploy/aliyun/README.md)
- Aliyun assets: [`deploy/aliyun/`](./deploy/aliyun) (`01`–`06` scripts, `nginx-linquan.conf`,
  `.env.backend.aliyun.example`, reviewed SQL in `sql/`)
- Render: `render.yaml` installs both locked dependency sets, builds the frontend, starts
  Express, and checks `/api/health`. `autoDeployTrigger: off` is deliberate: apply every SQL file
  under `deploy/aliyun/sql/` in filename order before triggering a deploy. The free plan's
  filesystem is ephemeral — uploads are not retained there.

## Access Model

- Guest: read-only Home, Members (`/members`), Linquan Gallery (`/gallery`), Contributors (`/contributors`).
- Member: registered account plus scheduling, concerts, class matching, self-service profile and
  password change; an admin-reset password forces a password change at next login.
- Admin: the same member account with `is_admin=1`, granted/revoked only by the Maintainer.
- Maintainer: one hidden, server-provisioned account (`/maintainer`) for password security,
  administrator grant/revoke with audit, contributor management, and archive deletion review.

Public member APIs expose a fixed profile projection and never return account IDs, student
numbers, email, phone, WeChat, active state, roles, or authentication metadata. No default
administrator is created or documented.

## Key Operational Rules

- Do not treat Git as a source for runtime data. `.env`, uploads, and database files are excluded
  from version control and must be preserved outside normal pulls.
- SQLite is for local development only. Production uses PostgreSQL with reviewed SQL migrations;
  runtime schema normalization is disabled in production.
- Production requires `TZ=UTC` (startup fails fast otherwise), an explicit `ALLOWED_ORIGINS`, and
  a non-placeholder `JWT_SECRET` of at least 32 characters.
- Run heavy compatibility validation against restored backups, ideally on a local Docker
  PostgreSQL instance, never against the live database.
