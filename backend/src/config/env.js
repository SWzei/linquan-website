import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const candidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../.env')
];

const envFile = candidates.find((file) => fs.existsSync(file));
dotenv.config(envFile ? { path: envFile } : undefined);

export const PORT = Number(process.env.PORT || 4000);
export const HOST = process.env.HOST || '0.0.0.0';
const configuredJwtSecret = process.env.JWT_SECRET || '';
const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
if (isProduction && process.env.TZ !== 'UTC') {
  throw new Error('TZ must be explicitly set to UTC in production');
}
if (
  isProduction
  && (!configuredJwtSecret || configuredJwtSecret.length < 32 || /^(dev-secret-change-this|replace-with-strong-secret)$/i.test(configuredJwtSecret))
) {
  throw new Error('JWT_SECRET must be a non-placeholder value of at least 32 characters in production');
}

export const JWT_SECRET = configuredJwtSecret || 'dev-secret-change-this';
export const DATABASE_URL = process.env.DATABASE_URL || '';
export const DB_PATH = process.env.DB_PATH || '../database/linquan.db';
export const UPLOAD_ROOT = process.env.UPLOAD_ROOT || 'uploads';
export const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || '';
if (isProduction && !ALLOWED_ORIGINS.trim()) {
  throw new Error('ALLOWED_ORIGINS must be explicitly configured in production');
}
export const SERVE_FRONTEND = String(process.env.SERVE_FRONTEND || 'true').toLowerCase() === 'true';
// PostgreSQL production schema changes must use reviewed SQL migrations. This
// compatibility path remains available only for disposable/local environments.
export const ALLOW_RUNTIME_SCHEMA_MIGRATION = !isProduction
  && String(process.env.ALLOW_RUNTIME_SCHEMA_MIGRATION || 'true').toLowerCase() === 'true';

export const SMTP_HOST = process.env.SMTP_HOST || '';
export const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
export const SMTP_USER = process.env.SMTP_USER || '';
export const SMTP_PASS = process.env.SMTP_PASS || '';
export const SMTP_FROM = process.env.SMTP_FROM || 'NJU林泉钢琴社 <no-reply@example.com>';
