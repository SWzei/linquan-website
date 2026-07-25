import express from 'express';
import fs from 'fs';
import path from 'path';
import db from '../config/db.js';
import { UPLOAD_ROOT } from '../config/env.js';
import { attachContentAttachments } from '../utils/contentAttachments.js';
import HttpError from '../utils/httpError.js';
import { normalizeUploadedOriginalName } from '../utils/uploadFilename.js';
import { serializePublishingTimestamps } from '../utils/dateTime.js';
import { coalescedTimestampOrder } from '../utils/sqlTimeCompat.js';

const router = express.Router();
const uploadRoot = path.resolve(process.cwd(), UPLOAD_ROOT);
const activityOrderExpr = coalescedTimestampOrder('event_time', 'published_at', 'created_at');
const announcementOrderExpr = coalescedTimestampOrder('published_at', 'created_at');

function resolveStoredUploadPath(rawPath) {
  if (!rawPath) {
    return null;
  }
  const normalized = String(rawPath).replaceAll('\\', '/');
  if (!normalized.startsWith('/uploads/')) {
    return null;
  }
  const relativePath = normalized.replace(/^\/+uploads\/+/, '');
  const absolutePath = path.resolve(uploadRoot, relativePath);
  const relativeToRoot = path.relative(uploadRoot, absolutePath);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    return null;
  }
  return absolutePath;
}

function escapeHeaderFilename(value) {
  return encodeURIComponent(String(value || 'download'))
    .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function asciiFallbackFilename(value) {
  const normalized = String(value || 'download')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_')
    .replace(/[<>:|?*]/g, '_')
    .trim();
  return normalized || 'download';
}

function setAttachmentDownloadHeaders(res, originalName, mimeType, size, disposition = 'attachment') {
  const fileName = normalizeUploadedOriginalName(originalName || 'download');
  const fallbackName = asciiFallbackFilename(fileName);
  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${fallbackName}"; filename*=UTF-8''${escapeHeaderFilename(fileName)}`
  );
  if (Number.isFinite(size) && size >= 0) {
    res.setHeader('Content-Length', String(size));
  }
}

router.get('/activities', (req, res) => {
  const rows = attachContentAttachments(
    db,
    'activity',
    db
    .prepare(
      `SELECT
         id,
         title,
         content,
         event_time AS "eventTime",
         location,
         published_at AS "publishedAt",
         created_at AS "createdAt",
         updated_at AS "updatedAt"
       FROM activities activity
       WHERE is_published = 1
         AND NOT EXISTS (SELECT 1 FROM archive_records ar
           WHERE ar.module = 'publishing' AND ar.record_type = 'activity'
             AND ar.record_id = activity.id AND ar.status IN ('archived', 'deletion_requested'))
       ORDER BY ${activityOrderExpr} DESC, id DESC`
    )
    .all(),
    { primaryField: 'attachmentPath' }
  );

  res.json({ items: rows.map((item) => serializePublishingTimestamps(item)) });
});

router.get('/announcements', (req, res) => {
  const rows = attachContentAttachments(
    db,
    'announcement',
    db
    .prepare(
      `SELECT
         id,
         title,
         content,
         attachment_path AS "attachmentPath",
         published_at AS "publishedAt",
         created_at AS "createdAt",
         updated_at AS "updatedAt"
       FROM announcements announcement
       WHERE is_published = 1
         AND NOT EXISTS (SELECT 1 FROM archive_records ar
           WHERE ar.module = 'publishing' AND ar.record_type = 'announcement'
             AND ar.record_id = announcement.id AND ar.status IN ('archived', 'deletion_requested'))
       ORDER BY ${announcementOrderExpr} DESC, id DESC`
    )
    .all(),
    { primaryField: 'attachmentPath' }
  );

  res.json({ items: rows.map((item) => serializePublishingTimestamps(item)) });
});

function servePublishedAttachment(disposition) {
  return (req, res, next) => {
  try {
    const attachmentId = Number(req.params.attachmentId);
    if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
      throw new HttpError(400, 'Invalid attachmentId');
    }

    const row = db
      .prepare(
        `SELECT
           id,
           owner_type AS ownerType,
           owner_id AS ownerId,
           original_name AS originalName,
           file_path AS filePath,
           file_size AS fileSize,
           mime_type AS mimeType
         FROM content_attachments
         WHERE id = ?`
      )
      .get(attachmentId);
    if (!row) {
      throw new HttpError(404, 'Attachment not found');
    }

    if (row.ownerType === 'activity') {
      const owner = db.prepare(`SELECT activity.id FROM activities activity
        WHERE activity.id = ? AND activity.is_published = 1
          AND NOT EXISTS (SELECT 1 FROM archive_records ar
            WHERE ar.module = 'publishing' AND ar.record_type = 'activity'
              AND ar.record_id = activity.id AND ar.status IN ('archived', 'deletion_requested'))`).get(row.ownerId);
      if (!owner) {
        throw new HttpError(404, 'Attachment not found');
      }
    } else if (row.ownerType === 'announcement') {
      const owner = db.prepare(`SELECT announcement.id FROM announcements announcement
        WHERE announcement.id = ? AND announcement.is_published = 1
          AND NOT EXISTS (SELECT 1 FROM archive_records ar
            WHERE ar.module = 'publishing' AND ar.record_type = 'announcement'
              AND ar.record_id = announcement.id AND ar.status IN ('archived', 'deletion_requested'))`).get(row.ownerId);
      if (!owner) {
        throw new HttpError(404, 'Attachment not found');
      }
    } else {
      throw new HttpError(404, 'Attachment not found');
    }

    const absolutePath = resolveStoredUploadPath(row.filePath);
    if (!absolutePath || !fs.existsSync(absolutePath)) {
      throw new HttpError(404, 'Attachment file not found');
    }

    const safeInlineTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    const effectiveDisposition = disposition === 'inline' && safeInlineTypes.has(String(row.mimeType).toLowerCase())
      ? 'inline'
      : 'attachment';
    setAttachmentDownloadHeaders(res, row.originalName, row.mimeType, Number(row.fileSize || 0), effectiveDisposition);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (effectiveDisposition === 'inline') {
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    }
    return res.sendFile(absolutePath);
  } catch (err) {
    return next(err);
  }
  };
}

router.get('/attachments/:attachmentId/view', servePublishedAttachment('inline'));
router.get('/attachments/:attachmentId/download', servePublishedAttachment('attachment'));

router.get('/gallery', (req, res) => {
  const rows = db
    .prepare(
      `SELECT
         id,
         src,
         fallback,
         title_zh AS "titleZh",
         title_en AS "titleEn",
         description_zh AS "descriptionZh",
         description_en AS "descriptionEn",
         alt_zh AS "altZh",
         alt_en AS "altEn",
         display_order AS "displayOrder"
       FROM gallery_items gallery
       WHERE is_visible = 1
         AND NOT EXISTS (SELECT 1 FROM archive_records ar
           WHERE ar.module = 'gallery_display' AND ar.record_type = 'gallery_item'
             AND ar.record_id = gallery.id AND ar.status IN ('archived', 'deletion_requested'))
       ORDER BY display_order ASC, id ASC`
    )
    .all();

  res.json({
    items: rows.map((item) => ({
      ...item,
      src: String(item.src || '').startsWith('/uploads/') ? `/api/gallery/${item.id}/media` : item.src,
      fallback: String(item.fallback || '').startsWith('/uploads/') ? `/api/gallery/${item.id}/media?fallback=1` : item.fallback
    }))
  });
});

router.get('/gallery/:itemId/media', (req, res, next) => {
  try {
    const itemId = Number(req.params.itemId);
    if (!Number.isInteger(itemId) || itemId <= 0) throw new HttpError(400, 'Invalid itemId');
    const row = db.prepare(`SELECT gallery.src, gallery.fallback FROM gallery_items gallery
      WHERE gallery.id = ? AND gallery.is_visible = 1
        AND NOT EXISTS (SELECT 1 FROM archive_records ar
          WHERE ar.module = 'gallery_display' AND ar.record_type = 'gallery_item'
            AND ar.record_id = gallery.id AND ar.status IN ('archived', 'deletion_requested'))`).get(itemId);
    if (!row) throw new HttpError(404, 'Gallery item not found');
    const selected = req.query.fallback === '1' ? row.fallback : row.src;
    const absolutePath = resolveStoredUploadPath(selected);
    if (!absolutePath || !fs.existsSync(absolutePath)) throw new HttpError(404, 'Gallery image not found');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.sendFile(absolutePath);
  } catch (err) {
    return next(err);
  }
});

export default router;
