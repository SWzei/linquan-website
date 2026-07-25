import fs from 'fs';
import path from 'path';
import { UPLOAD_ROOT } from '../config/env.js';
import HttpError from '../utils/httpError.js';

const DEFAULT_MAX_UPLOAD_REQUEST_BYTES = 64 * 1024 * 1024;
const DEFAULT_MIN_UPLOAD_FREE_BYTES = 256 * 1024 * 1024;

function positiveBytes(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export const MAX_UPLOAD_REQUEST_BYTES = positiveBytes(
  process.env.MAX_UPLOAD_REQUEST_BYTES,
  DEFAULT_MAX_UPLOAD_REQUEST_BYTES
);
export const MIN_UPLOAD_FREE_BYTES = positiveBytes(
  process.env.MIN_UPLOAD_FREE_BYTES,
  DEFAULT_MIN_UPLOAD_FREE_BYTES
);

const uploadRoot = path.resolve(process.cwd(), UPLOAD_ROOT);

function availableDiskBytes() {
  const stats = fs.statfsSync(uploadRoot);
  return Number(stats.bavail) * Number(stats.bsize);
}

export function assertUploadBudget({
  incomingBytes = 0,
  freeBytes = availableDiskBytes()
} = {}) {
  const normalizedIncomingBytes = Number(incomingBytes || 0);
  if (normalizedIncomingBytes > MAX_UPLOAD_REQUEST_BYTES) {
    throw new HttpError(413, 'Combined upload size exceeds the request limit');
  }
  if (Number(freeBytes) - normalizedIncomingBytes < MIN_UPLOAD_FREE_BYTES) {
    throw new HttpError(507, 'Insufficient storage space for upload');
  }
}

export function checkUploadCapacity(req, res, next) {
  try {
    const contentLength = Number(req.headers['content-length'] || 0);
    assertUploadBudget({
      incomingBytes: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0
    });
    return next();
  } catch (err) {
    return next(err);
  }
}

function uploadedFiles(req) {
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === 'object') return Object.values(req.files).flat();
  return [];
}

export function enforceUploadedFileBudget(req, res, next) {
  const files = uploadedFiles(req);
  try {
    const totalBytes = files.reduce((sum, file) => sum + Number(file?.size || 0), 0);
    if (totalBytes > MAX_UPLOAD_REQUEST_BYTES) {
      throw new HttpError(413, 'Combined upload size exceeds the request limit');
    }
    assertUploadBudget();
    return next();
  } catch (err) {
    for (const file of files) {
      if (!file?.path) continue;
      try {
        fs.unlinkSync(file.path);
      } catch (cleanupErr) {
        if (cleanupErr?.code !== 'ENOENT') {
          // eslint-disable-next-line no-console
          console.warn('Failed to clean rejected upload:', cleanupErr.message);
        }
      }
    }
    return next(err);
  }
}
