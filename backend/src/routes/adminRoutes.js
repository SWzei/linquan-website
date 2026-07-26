import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import db from '../config/db.js';
import { UPLOAD_ROOT } from '../config/env.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import HttpError from '../utils/httpError.js';
import { createStandardSlots, getActiveSemesterId, resolveSemesterId } from '../utils/semester.js';
import { attachContentAttachments } from '../utils/contentAttachments.js';
import { normalizeUploadedFileMeta, normalizeUploadedOriginalName } from '../utils/uploadFilename.js';
import { assertStoredAllowedAttachment, assertStoredRasterImage, cleanupRejectedUpload } from '../utils/safeUpload.js';
import { isUniqueConstraintError } from '../utils/databaseErrors.js';
import { recordAuthSecurityEvent } from '../services/authAuditService.js';
import { uploadLimiter } from '../middleware/rateLimits.js';
import { checkUploadCapacity, enforceUploadedFileBudget } from '../middleware/uploadProtection.js';
import {
  currentUtcIsoString,
  normalizePublishingEventTimeInput,
  serializePublishingTimestamps
} from '../utils/dateTime.js';
import { coalescedTimestampOrder } from '../utils/sqlTimeCompat.js';
import {
  generateProposedSchedule,
  updateProposedSchedule,
  publishScheduleBatch
} from '../services/schedulerService.js';
import {
  deliverQueuedNotifications,
  notifyUsers,
  queueNotifications
} from '../services/notificationService.js';
import { buildClassOccupancy, lockSemesterInventory, roomTimeKey } from '../services/roomInventory.js';
import { archiveRecord, isArchived } from '../services/archiveService.js';
import {
  MEMBER_PASSWORD_REQUIREMENT,
  generateStrongMemberPassword,
  memberPasswordSchema
} from '../utils/memberPassword.js';

const router = express.Router();
const activityOrderExpr = coalescedTimestampOrder('a.event_time', 'a.published_at', 'a.created_at');
const announcementOrderExpr = coalescedTimestampOrder('a.published_at', 'a.created_at');

const uploadRoot = path.resolve(process.cwd(), UPLOAD_ROOT);
const concertUploadDir = path.join(uploadRoot, 'concerts');
if (!fs.existsSync(concertUploadDir)) {
  fs.mkdirSync(concertUploadDir, { recursive: true });
}
const activityUploadDir = path.join(uploadRoot, 'activities');
if (!fs.existsSync(activityUploadDir)) {
  fs.mkdirSync(activityUploadDir, { recursive: true });
}
const galleryUploadDir = path.join(uploadRoot, 'gallery');
if (!fs.existsSync(galleryUploadDir)) {
  fs.mkdirSync(galleryUploadDir, { recursive: true });
}
const announcementUploadDir = path.join(uploadRoot, 'announcements');
if (!fs.existsSync(announcementUploadDir)) {
  fs.mkdirSync(announcementUploadDir, { recursive: true });
}

const concertUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, concertUploadDir),
    filename: (req, file, cb) => {
      normalizeUploadedFileMeta(file);
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, `concert-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext || '.bin'}`);
    }
  }),
  limits: {
    fileSize: 20 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    normalizeUploadedFileMeta(file);
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (allowedAttachmentExts.has(ext) && ext !== '.zip') return cb(null, true);
    return cb(new HttpError(400, 'Unsupported concert attachment file type'));
  }
});

const allowedAttachmentExts = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.csv',
  '.txt',
  '.md',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.zip',
  '.ppt',
  '.pptx'
]);

function validatePublishingAttachment(file) {
  normalizeUploadedFileMeta(file);
  const ext = path.extname(String(file?.originalname || '')).toLowerCase();
  const mimeType = String(file?.mimetype || '').toLowerCase();
  if (!allowedAttachmentExts.has(ext)) return false;
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return mimeType.startsWith('image/');
  return !mimeType.includes('html') && !mimeType.includes('svg');
}

function createPublishingUpload(targetDir, prefix) {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, targetDir),
      filename: (req, file, cb) => {
        normalizeUploadedFileMeta(file);
        const ext = path.extname(file.originalname || '').toLowerCase();
        cb(null, `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext || '.bin'}`);
      }
    }),
    limits: {
      fileSize: 20 * 1024 * 1024,
      files: 8
    },
    fileFilter: (req, file, cb) => {
      if (validatePublishingAttachment(file)) {
        return cb(null, true);
      }
      return cb(new HttpError(400, 'Unsupported attachment file type'));
    }
  });
}

const activityAttachmentUpload = createPublishingUpload(activityUploadDir, 'activity');
const announcementAttachmentUpload = createPublishingUpload(announcementUploadDir, 'announcement');

const galleryUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, galleryUploadDir),
    filename: (req, file, cb) => {
      normalizeUploadedFileMeta(file);
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, `gallery-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext || '.bin'}`);
    }
  }),
  limits: {
    fileSize: 10 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(normalizeUploadedOriginalName(file.originalname || '')).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
      return cb(null, true);
    }
    return cb(new HttpError(400, 'Gallery file must be an image'));
  }
});

function optionalString(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = String(value).trim();
  return text.length ? text : null;
}

function optionalBoolean(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const text = String(value).toLowerCase().trim();
  if (text === 'true' || text === '1') {
    return true;
  }
  if (text === 'false' || text === '0') {
    return false;
  }
  return undefined;
}

function normalizeTrimmed(value) {
  return typeof value === 'string' ? value.trim() : value;
}

const requiredTrimmedString = (min, max) =>
  z.preprocess(normalizeTrimmed, z.string().min(min).max(max));

const optionalTrimmedString = (max) =>
  z.preprocess((value) => {
    if (value === undefined || value === null) {
      return undefined;
    }
    const normalized = normalizeTrimmed(value);
    return normalized === '' ? undefined : normalized;
  }, z.string().max(max).optional());

const nullableTrimmedString = (max) =>
  z.preprocess((value) => {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    const normalized = normalizeTrimmed(value);
    return normalized === '' ? null : normalized;
  }, z.string().max(max).nullable().optional());

const nullableDateTimeString = () =>
  z.preprocess((value) => {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    const normalized = normalizeTrimmed(value);
    if (normalized === '') {
      return null;
    }
    return normalized.replace(' ', 'T');
  }, z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/).nullable().optional());

const trimmedStatus = (defaultValue) =>
  z.preprocess((value) => {
    if (value === undefined || value === null) {
      return defaultValue;
    }
    const normalized = normalizeTrimmed(value);
    return normalized === '' ? defaultValue : normalized;
  }, z.enum(['draft', 'open', 'closed']).default(defaultValue));

function toPublicPath(rawPath) {
  if (!rawPath) {
    return null;
  }
  const normalized = String(rawPath).replaceAll('\\', '/').replace(/^\/+/, '');
  if (normalized.startsWith('uploads/')) {
    return `/${normalized}`;
  }
  if (normalized.startsWith('concerts/')) {
    return `/uploads/${normalized}`;
  }
  return `/${normalized}`;
}

function toStoredUploadPath(filePath) {
  const relativePath = path.relative(uploadRoot, filePath).replaceAll('\\', '/').replace(/^\/+/, '');
  return `/uploads/${relativePath}`;
}

function resolveManagedUploadPath(rawPath) {
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

function removeManagedUploadFile(rawPath) {
  const filePath = resolveManagedUploadPath(rawPath);
  if (!filePath) {
    return;
  }
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function cleanupUploadedFiles(files) {
  for (const file of files || []) {
    if (file?.path && fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
  }
}

function assertPublishingUploads(files) {
  for (const file of files || []) assertStoredAllowedAttachment(file);
}

function parseIdList(rawValue, fieldName) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return [];
  }
  let values = rawValue;
  if (typeof values === 'string' && values.trim().startsWith('[')) {
    try {
      values = JSON.parse(values);
    } catch (err) {
      throw new HttpError(400, `Invalid ${fieldName}`);
    }
  }
  const source = Array.isArray(values) ? values : [values];
  const parsed = [...new Set(source.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0))];
  if (parsed.length !== source.length) {
    throw new HttpError(400, `Invalid ${fieldName}`);
  }
  return parsed;
}

function loadContentAttachmentsForOwner(ownerType, ownerId) {
  return attachContentAttachments(db, ownerType, [{ id: ownerId }], { primaryField: 'attachmentPath' })[0]?.attachments || [];
}

function insertContentAttachmentRows(ownerType, ownerId, files, createdBy) {
  if (!files?.length) {
    return [];
  }
  const insertStmt = db.prepare(
    `INSERT INTO content_attachments (
       owner_type, owner_id, original_name, file_path, file_size, mime_type, created_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const file of files) {
      insertStmt.run(
        ownerType,
        ownerId,
        normalizeUploadedOriginalName(file.originalname || path.basename(file.path)),
        toStoredUploadPath(file.path),
        Number(file.size || 0),
        file.mimetype || null,
        createdBy || null
      );
    }
  });
  tx();
  return loadContentAttachmentsForOwner(ownerType, ownerId);
}

function deleteContentAttachmentRows(ownerType, ownerId, attachmentIds) {
  const normalizedIds = [...new Set((attachmentIds || []).map((item) => Number(item)).filter((item) => item > 0))];
  if (!normalizedIds.length) {
    return;
  }
  const placeholders = normalizedIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id, file_path AS filePath
       FROM content_attachments
       WHERE owner_type = ? AND owner_id = ? AND id IN (${placeholders})`
    )
    .all(ownerType, ownerId, ...normalizedIds);
  if (rows.length !== normalizedIds.length) {
    throw new HttpError(404, 'Attachment not found');
  }

  const deleteStmt = db.prepare(
    `DELETE FROM content_attachments
     WHERE owner_type = ? AND owner_id = ? AND id = ?`
  );
  const tx = db.transaction(() => {
    for (const row of rows) {
      deleteStmt.run(ownerType, ownerId, row.id);
      removeManagedUploadFile(row.filePath);
    }
  });
  tx();
}

function getContentAttachmentRow(ownerType, ownerId, attachmentId) {
  return db
    .prepare(
      `SELECT
         id,
         owner_type AS ownerType,
         owner_id AS ownerId,
         original_name AS originalName,
         file_path AS filePath,
         file_size AS fileSize,
         mime_type AS mimeType,
         created_by AS createdBy,
         created_at AS createdAt
       FROM content_attachments
       WHERE owner_type = ? AND owner_id = ? AND id = ?`
    )
    .get(ownerType, ownerId, attachmentId);
}

function replaceContentAttachmentRow(ownerType, ownerId, attachmentId, file, createdBy) {
  const existing = getContentAttachmentRow(ownerType, ownerId, attachmentId);
  if (!existing) {
    throw new HttpError(404, 'Attachment not found');
  }

  db.prepare(
    `UPDATE content_attachments
     SET
       original_name = ?,
       file_path = ?,
       file_size = ?,
       mime_type = ?,
       created_by = ?
     WHERE owner_type = ? AND owner_id = ? AND id = ?`
  ).run(
    normalizeUploadedOriginalName(file.originalname || path.basename(file.path)),
    toStoredUploadPath(file.path),
    Number(file.size || 0),
    file.mimetype || null,
    createdBy || existing.createdBy || null,
    ownerType,
    ownerId,
    attachmentId
  );

  removeManagedUploadFile(existing.filePath);
}

function syncAnnouncementAttachmentPath(announcementId) {
  const firstAttachment = db
    .prepare(
      `SELECT file_path AS filePath
       FROM content_attachments
       WHERE owner_type = 'announcement' AND owner_id = ?
       ORDER BY created_at ASC, id ASC
       LIMIT 1`
    )
    .get(announcementId);
  db.prepare('UPDATE announcements SET attachment_path = ? WHERE id = ?').run(
    firstAttachment?.filePath || null,
    announcementId
  );
}

function mapGalleryRow(item) {
  return {
    ...item,
    previewUrl: String(item.src || '').startsWith('/uploads/') ? `/api/admin/gallery/${item.id}/media` : item.src,
    fallbackPreviewUrl: String(item.fallback || '').startsWith('/uploads/')
      ? `/api/admin/gallery/${item.id}/media?fallback=1`
      : item.fallback,
    isVisible: Boolean(item.isVisible)
  };
}

function serializePublishingItem(item) {
  return serializePublishingTimestamps(item);
}

function serializeConcertItem(item) {
  if (!item) {
    return item;
  }
  return serializePublishingTimestamps({
    ...item,
    attachmentPath: item.attachmentPath ? `/api/concerts/${Number(item.id)}/attachment` : null
  });
}

function serializeConcertApplicationItem(item) {
  if (!item) {
    return item;
  }
  return serializePublishingTimestamps({
    ...item,
    scoreFilePath: item.scoreFilePath
      ? `/api/concerts/${Number(item.concertId)}/applications/${Number(item.id)}/score`
      : null
  });
}

function escapeCsv(value) {
  const text = String(value ?? '');
  if (text.includes('"') || text.includes(',') || text.includes('\n')) {
    // Mitigate CSV formula injection by prefixing formula trigger characters
    // with a single quote (OWASP recommendation).
    const escaped = text.replaceAll('"', '""');
    if (/^[=+\-@\t\r]/.test(escaped)) {
      return `"'${escaped}"`;
    }
    return `"${escaped}"`;
  }
  if (/^[=+\-@\t\r]/.test(text)) {
    return `'${text}`;
  }
  return text;
}

function parsePositiveInt(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new HttpError(400, `Invalid ${fieldName}`);
  }
  return number;
}

function getLatestProposedBatchForSemester(semesterId) {
  return db
    .prepare(
      `SELECT id, semester_id AS semesterId, created_at AS createdAt
       FROM schedule_batches
       WHERE semester_id = ? AND status = 'proposed'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get(semesterId);
}

function getScheduleCompliance(semesterId, batchId) {
  const totalSlots = Number(
    db
      .prepare('SELECT COUNT(*) AS count FROM room_slots WHERE semester_id = ?')
      .get(semesterId)?.count || 0
  );
  const totalMembers = Number(
    db
      .prepare(
        `SELECT COUNT(DISTINCT sp.user_id) AS count
         FROM slot_preferences sp
         JOIN users u ON u.id = sp.user_id
         WHERE sp.semester_id = ? AND u.account_type = 'member' AND u.is_active = 1`
      )
      .get(semesterId)?.count || 0
  );

  const memberHours = batchId
    ? db
      .prepare(
        `SELECT sa.user_id AS userId, COUNT(*) AS hours
         FROM schedule_assignments sa
         JOIN users u ON u.id = sa.user_id
         WHERE sa.batch_id = ? AND u.account_type = 'member' AND u.is_active = 1
         GROUP BY sa.user_id`
      )
      .all(batchId)
    : [];

  const assignedMembers = memberHours.length;
  const totalAssignedSlots = memberHours.reduce((sum, item) => sum + Number(item.hours || 0), 0);
  const overTwoMembers = memberHours.filter((item) => Number(item.hours || 0) > 2).length;
  const oneOrTwoMembers = memberHours.filter((item) => {
    const hours = Number(item.hours || 0);
    return hours >= 1 && hours <= 2;
  }).length;
  const expectedMaxFairMembers = Math.min(totalMembers, totalSlots);

  const fairness = {
    expectedMaxFairMembers,
    achievedMembersWithAtLeastOne: assignedMembers,
    satisfied: assignedMembers >= expectedMaxFairMembers
  };
  const rangeRule = {
    overTwoMembers,
    satisfied: overTwoMembers === 0
  };
  const utilization = totalSlots > 0 ? totalAssignedSlots / totalSlots : 0;

  return {
    totalMembers,
    assignedMembers,
    unassignedMembers: Math.max(0, totalMembers - assignedMembers),
    oneOrTwoMembers,
    overTwoMembers,
    totalSlots,
    totalAssignedSlots,
    utilization,
    fairness,
    rangeRule,
    basicRequirementSatisfied: fairness.satisfied && rangeRule.satisfied
  };
}

function listScheduleOperations(semesterId, batchId, limit = 60) {
  let rows = [];
  try {
    if (batchId === null || batchId === undefined) {
      rows = db
        .prepare(
          `SELECT
             id,
             batch_id AS batchId,
             semester_id AS semesterId,
             operation_type AS operationType,
             payload_json AS payloadJson,
             created_by AS createdBy,
             created_at AS createdAt
           FROM schedule_operation_logs
           WHERE semester_id = ?
           ORDER BY id DESC
           LIMIT ?`
        )
        .all(semesterId, limit);
    } else {
      rows = db
        .prepare(
          `SELECT
             id,
             batch_id AS batchId,
             semester_id AS semesterId,
             operation_type AS operationType,
             payload_json AS payloadJson,
             created_by AS createdBy,
             created_at AS createdAt
           FROM schedule_operation_logs
           WHERE semester_id = ?
             AND batch_id = ?
           ORDER BY id DESC
           LIMIT ?`
        )
        .all(semesterId, batchId, limit);
    }
  } catch (err) {
    // Never block scheduling UI due to operation-log read issues.
    // eslint-disable-next-line no-console
    console.warn('schedule_operation_logs read failed:', err?.message || err);
    rows = [];
  }

  return rows.map((item) => {
    let payload = null;
    if (item.payloadJson) {
      try {
        payload = JSON.parse(item.payloadJson);
      } catch (err) {
        payload = null;
      }
    }
    return {
      ...item,
      payload
    };
  });
}

function recordScheduleOperation({
  batchId = null,
  semesterId = null,
  operationType,
  payload = null,
  adminId = null
}) {
  try {
    db.prepare(
      `INSERT INTO schedule_operation_logs (
         batch_id, semester_id, operation_type, payload_json, created_by
       ) VALUES (?, ?, ?, ?, ?)`
    ).run(
      batchId,
      semesterId,
      operationType,
      payload ? JSON.stringify(payload) : null,
      adminId
    );
  } catch (err) {
    const message = String(err?.message || '');
    if (!/schedule_operation_logs|no such table|relation .* does not exist/i.test(message)) {
      throw err;
    }
    // eslint-disable-next-line no-console
    console.warn('schedule_operation_logs is unavailable, skip operation record.');
  }
}

function assertPianoPlacementAllowed({ batchId, semesterId, userId, slot, ignoreAssignmentIds = [] }) {
  const classOccupancy = buildClassOccupancy(semesterId);
  if (classOccupancy.occupiedRoomSlotIds.has(Number(slot.id))) {
    throw new HttpError(409, 'Target room is reserved by the current Class Matching schedule');
  }
  const targetTime = roomTimeKey(slot.dayOfWeek, slot.hour);
  if (classOccupancy.participantBusyTimes.get(Number(userId))?.has(targetTime)) {
    throw new HttpError(409, 'Member already has a Class Matching lesson at this time');
  }

  const ignoreIds = ignoreAssignmentIds.map(Number).filter((id) => Number.isInteger(id) && id > 0);
  const ignoreSql = ignoreIds.length ? `AND sa.id NOT IN (${ignoreIds.map(() => '?').join(', ')})` : '';
  const ownAssignments = db
    .prepare(
      `SELECT sa.id, rs.day_of_week AS "dayOfWeek", rs.hour
       FROM schedule_assignments sa
       JOIN room_slots rs ON rs.id = sa.slot_id
       WHERE sa.batch_id = ? AND sa.user_id = ? ${ignoreSql}`
    )
    .all(batchId, userId, ...ignoreIds);
  if (ownAssignments.length >= 2) {
    throw new HttpError(409, 'A member can have at most two Piano Time assignments in one schedule');
  }
  if (ownAssignments.some((item) => roomTimeKey(item.dayOfWeek, item.hour) === targetTime)) {
    throw new HttpError(409, 'Member already has a Piano Time assignment at this time');
  }
}

function deriveUnsatisfiedMembers(members) {
  return (members || [])
    .filter((item) => {
      const assigned = Number(item.assignedCount || 0);
      return assigned < 1 || assigned > 2;
    })
    .map((item) => {
      const assigned = Number(item.assignedCount || 0);
      let reason = 'no_assignment';
      if (assigned > 2) {
        reason = 'over_limit';
      }
      return {
        userId: item.userId,
        studentNumber: item.studentNumber,
        displayName: item.displayName,
        assignedCount: assigned,
        preferenceCount: Number(item.preferenceCount || 0),
        reason
      };
    });
}

const semesterSchema = z.object({
  name: z.string().trim().min(2).max(80),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  activate: z.boolean().default(true)
});
const semesterUpdateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  activate: z.boolean().optional()
});

function mapSemesterRow(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    isActive: Boolean(row.isActive)
  };
}

function listSemesterRows() {
  return db
    .prepare(
      `SELECT
         id,
         name,
         start_date AS startDate,
         end_date AS endDate,
         is_active AS isActive,
         created_at AS createdAt
       FROM semesters semester
       WHERE NOT EXISTS (SELECT 1 FROM archive_records ar
         WHERE ar.module = 'scheduling' AND ar.record_type = 'semester'
           AND ar.record_id = semester.id AND ar.status IN ('archived', 'deletion_requested'))
       ORDER BY is_active DESC, start_date DESC, id DESC`
    )
    .all()
    .map(mapSemesterRow);
}

function getSemesterRow(semesterId) {
  return mapSemesterRow(
    db
      .prepare(
        `SELECT
           id,
           name,
           start_date AS startDate,
           end_date AS endDate,
           is_active AS isActive,
           created_at AS createdAt
         FROM semesters semester
         WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM archive_records ar
             WHERE ar.module = 'scheduling' AND ar.record_type = 'semester'
               AND ar.record_id = semester.id AND ar.status IN ('archived', 'deletion_requested'))`
      )
      .get(semesterId)
  );
}

function findReplacementSemesterId(excludedSemesterId) {
  return (
    db
      .prepare(
        `SELECT id
         FROM semesters semester
         WHERE id != ?
           AND NOT EXISTS (SELECT 1 FROM archive_records ar
             WHERE ar.module = 'scheduling' AND ar.record_type = 'semester'
               AND ar.record_id = semester.id AND ar.status IN ('archived', 'deletion_requested'))
         ORDER BY is_active DESC, start_date DESC, id DESC
         LIMIT 1`
      )
      .get(excludedSemesterId)?.id || null
  );
}

function getSchedulingPreferenceSummary(semesterId, batchId = null) {
  const summary = db
    .prepare(
      `SELECT
         COUNT(DISTINCT u.id) AS totalMembers,
         COUNT(DISTINCT CASE WHEN sp.id IS NOT NULL THEN u.id END) AS membersWithPreferences,
         COUNT(DISTINCT CASE WHEN sa.id IS NOT NULL THEN u.id END) AS membersInDraft
       FROM users u
       LEFT JOIN slot_preferences sp
         ON sp.user_id = u.id
        AND sp.semester_id = ?
       LEFT JOIN schedule_assignments sa
         ON sa.user_id = u.id
        AND sa.batch_id = ?
       WHERE u.account_type = 'member'
         AND u.is_active = 1`
    )
    .get(semesterId, batchId || -1);
  const totalMembers = Number(summary?.totalMembers || 0);
  const membersWithPreferences = Number(summary?.membersWithPreferences || 0);
  const membersInDraft = Number(summary?.membersInDraft || 0);
  return {
    totalMembers,
    membersWithPreferences,
    membersWithoutPreferences: Math.max(0, totalMembers - membersWithPreferences),
    membersInDraft,
    readyForGeneration: membersWithPreferences > 0
  };
}

const publishContentSchema = z.object({
  title: requiredTrimmedString(2, 150),
  content: requiredTrimmedString(2, 5000),
  eventTime: optionalTrimmedString(64),
  location: optionalTrimmedString(256),
  isPublished: z.boolean().default(true)
});

const updateActivitySchema = z.object({
  title: optionalTrimmedString(150).refine((value) => value === undefined || value.length >= 2, {
    message: 'Title must be at least 2 characters'
  }),
  content: optionalTrimmedString(5000).refine((value) => value === undefined || value.length >= 2, {
    message: 'Content must be at least 2 characters'
  }),
  eventTime: nullableTrimmedString(64),
  location: nullableTrimmedString(256),
  isPublished: z.boolean().optional()
});

const publishAnnouncementSchema = z.object({
  title: requiredTrimmedString(2, 150),
  content: requiredTrimmedString(2, 5000),
  isPublished: z.boolean().default(true)
});

const updateAnnouncementSchema = z.object({
  title: optionalTrimmedString(150).refine((value) => value === undefined || value.length >= 2, {
    message: 'Title must be at least 2 characters'
  }),
  content: optionalTrimmedString(5000).refine((value) => value === undefined || value.length >= 2, {
    message: 'Content must be at least 2 characters'
  }),
  isPublished: z.boolean().optional()
});

const runScheduleSchema = z.object({
  semesterId: z.number().int().positive().optional()
});

const updateAssignmentSchema = z.object({
  slotId: z.number().int().positive(),
  swapIfOccupied: z.boolean().default(true)
});

const createManualAssignmentSchema = z.object({
  batchId: z.number().int().positive().optional(),
  userId: z.number().int().positive(),
  slotId: z.number().int().positive()
});

const publishScheduleSchema = z.object({
  semesterId: z.number().int().positive().optional()
});

const exportScheduleSchema = z.object({
  batchId: z.number().int().positive().optional()
});

const createConcertSchema = z.object({
  title: requiredTrimmedString(2, 200),
  description: nullableTrimmedString(5000),
  announcement: nullableTrimmedString(5000),
  applicationDeadline: nullableDateTimeString(),
  status: trimmedStatus('draft')
});

const updateConcertSchema = z.object({
  title: optionalTrimmedString(200).refine((value) => value === undefined || value.length >= 2, {
    message: 'Title must be at least 2 characters'
  }),
  description: nullableTrimmedString(5000),
  announcement: nullableTrimmedString(5000),
  applicationDeadline: nullableDateTimeString(),
  status: z.preprocess((value) => {
    if (value === undefined || value === null) {
      return undefined;
    }
    const normalized = normalizeTrimmed(value);
    return normalized === '' ? undefined : normalized;
  }, z.enum(['draft', 'open', 'closed']).optional()),
  removeAttachment: z.boolean().optional()
});

const releaseConcertSchema = z.object({
  message: z.string().max(5000).nullable().optional()
});

const createGalleryItemSchema = z.object({
  src: z.string().max(512).default(''),
  fallback: z.string().max(512).nullable().optional(),
  titleZh: z.string().min(1).max(120),
  titleEn: z.string().min(1).max(120),
  descriptionZh: z.string().max(600).nullable().optional(),
  descriptionEn: z.string().max(600).nullable().optional(),
  altZh: z.string().max(200).nullable().optional(),
  altEn: z.string().max(200).nullable().optional(),
  isVisible: z.boolean().default(true),
  displayOrder: z.number().int().min(0).optional()
});

const updateGalleryItemSchema = z.object({
  src: z.string().max(512).optional(),
  fallback: z.string().max(512).nullable().optional(),
  titleZh: z.string().min(1).max(120).optional(),
  titleEn: z.string().min(1).max(120).optional(),
  descriptionZh: z.string().max(600).nullable().optional(),
  descriptionEn: z.string().max(600).nullable().optional(),
  altZh: z.string().max(200).nullable().optional(),
  altEn: z.string().max(200).nullable().optional(),
  isVisible: z.boolean().optional(),
  displayOrder: z.number().int().min(0).optional()
});

const resetMemberPasswordSchema = z.object({
  newPassword: memberPasswordSchema.optional()
});

router.use('/admin', authenticate, requireRole('admin'));

const archivedParams = {
  userId: ['member_accounts', 'member'],
  itemId: ['gallery_display', 'gallery_item'],
  activityId: ['publishing', 'activity'],
  announcementId: ['publishing', 'announcement'],
  semesterId: ['scheduling', 'semester'],
  concertId: ['concert_management', 'concert']
};
for (const [paramName, [module, recordType]] of Object.entries(archivedParams)) {
  router.param(paramName, (req, res, next, rawId) => {
    const recordId = Number(rawId);
    if (Number.isInteger(recordId) && recordId > 0 && isArchived(module, recordType, recordId)) {
      return next(new HttpError(404, 'Record not found'));
    }
    return next();
  });
}

router.get('/admin/members', (req, res, next) => {
  try {
    const keyword = optionalString(req.query.keyword);
    let rows = [];

    if (keyword) {
      const likeKeyword = `%${keyword.toLowerCase()}%`;
      rows = db
        .prepare(
          `SELECT
             u.id,
             u.student_number AS studentNumber,
             u.email,
             u.account_type AS accountType,
             u.is_admin AS isAdmin,
             u.created_at AS createdAt,
             u.updated_at AS updatedAt,
           p.display_name AS displayName,
           p.academy,
           p.major,
           p.grade
           FROM users u
           LEFT JOIN profiles p ON p.user_id = u.id
           WHERE u.account_type = 'member'
             AND u.is_active = 1
             AND NOT EXISTS (SELECT 1 FROM archive_records ar
               WHERE ar.module = 'member_accounts' AND ar.record_type = 'member'
                 AND ar.record_id = u.id AND ar.status IN ('archived', 'deletion_requested'))
             AND (
               LOWER(u.student_number) LIKE ?
               OR LOWER(COALESCE(u.email, '')) LIKE ?
               OR LOWER(COALESCE(p.display_name, '')) LIKE ?
               OR LOWER(COALESCE(p.academy, '')) LIKE ?
               OR LOWER(COALESCE(p.major, '')) LIKE ?
             )
           ORDER BY u.id DESC`
        )
        .all(likeKeyword, likeKeyword, likeKeyword, likeKeyword, likeKeyword);
    } else {
      rows = db
        .prepare(
          `SELECT
             u.id,
             u.student_number AS studentNumber,
             u.email,
             u.account_type AS accountType,
             u.is_admin AS isAdmin,
             u.created_at AS createdAt,
             u.updated_at AS updatedAt,
           p.display_name AS displayName,
           p.academy,
           p.major,
           p.grade
           FROM users u
           LEFT JOIN profiles p ON p.user_id = u.id
           WHERE u.account_type = 'member'
             AND u.is_active = 1
             AND NOT EXISTS (SELECT 1 FROM archive_records ar
               WHERE ar.module = 'member_accounts' AND ar.record_type = 'member'
                 AND ar.record_id = u.id AND ar.status IN ('archived', 'deletion_requested'))
           ORDER BY u.id DESC`
        )
        .all();
    }

    res.json({
      items: rows,
      total: rows.length
    });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/members/:userId(\\d+)', (req, res, next) => {
  try {
    const userId = parsePositiveInt(req.params.userId, 'userId');
    const member = db
      .prepare(
        `SELECT
           u.id,
           u.student_number AS studentNumber,
           u.email,
           u.account_type AS accountType,
           u.is_admin AS isAdmin,
           u.created_at AS createdAt,
           u.updated_at AS updatedAt,
           p.display_name AS displayName,
           p.avatar_url AS avatarUrl,
           p.photo_url AS photoUrl,
           p.bio,
           p.grade,
           p.major,
           p.academy,
           p.hobbies,
           p.piano_interests AS pianoInterests,
           p.wechat_account AS wechatAccount,
           p.phone
         FROM users u
         LEFT JOIN profiles p ON p.user_id = u.id
         WHERE u.id = ? AND u.account_type = 'member' AND u.is_active = 1
         LIMIT 1`
      )
      .get(userId);

    if (!member) {
      throw new HttpError(404, 'Member account not found');
    }

    const preferenceCount = Number(
      db
        .prepare('SELECT COUNT(*) AS count FROM slot_preferences WHERE user_id = ?')
        .get(userId)?.count || 0
    );
    const assignmentCount = Number(
      db
        .prepare('SELECT COUNT(*) AS count FROM schedule_assignments WHERE user_id = ?')
        .get(userId)?.count || 0
    );
    const applicationCount = Number(
      db
        .prepare('SELECT COUNT(*) AS count FROM concert_applications WHERE user_id = ?')
        .get(userId)?.count || 0
    );

    res.json({
      ...member,
      preferenceCount,
      assignmentCount,
      applicationCount
    });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/members/:userId(\\d+)/reset-password', (req, res, next) => {
  try {
    const userId = parsePositiveInt(req.params.userId, 'userId');
    const input = resetMemberPasswordSchema.parse({
      newPassword: optionalString(req.body?.newPassword) || undefined
    });

    const targetMember = db
      .prepare(
        `SELECT
           id,
           student_number AS studentNumber,
           account_type AS accountType,
           is_admin AS isAdmin,
           is_active AS isActive
         FROM users
         WHERE id = ?`
      )
      .get(userId);

    if (!targetMember) {
      throw new HttpError(404, 'Member account not found');
    }
    if (targetMember.accountType !== 'member') {
      throw new HttpError(403, 'Only member accounts can be managed here');
    }
    if (Boolean(targetMember.isAdmin)) {
      throw new HttpError(403, 'The Maintainer must revoke administrator privilege before this account can be managed');
    }
    if (!Boolean(targetMember.isActive)) {
      throw new HttpError(404, 'Member account not found');
    }

    const temporaryPassword = input.newPassword || generateStrongMemberPassword(14);
    const passwordHash = bcrypt.hashSync(temporaryPassword, 10);
    db.transaction(() => {
      db.prepare(
        `UPDATE users
         SET password_hash = ?, must_change_password = 1,
             auth_version = auth_version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).run(passwordHash, userId);
      recordAuthSecurityEvent({
        actorUserId: req.user.id,
        actorAccountType: req.user.accountType,
        actorCredential: req.user.studentNumber,
        targetUserId: userId,
        targetCredential: targetMember.studentNumber,
        action: 'admin_password_reset'
      });
    })();

    res.json({
      userId,
      studentNumber: targetMember.studentNumber,
      temporaryPassword
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: MEMBER_PASSWORD_REQUIREMENT, details: err.issues });
    }
    return next(err);
  }
});

router.delete('/admin/members/:userId(\\d+)', (req, res, next) => {
  try {
    const userId = parsePositiveInt(req.params.userId, 'userId');
    const targetMember = db
      .prepare(
        `SELECT
           id,
           student_number AS studentNumber,
           account_type AS accountType,
           is_admin AS isAdmin,
           is_active AS isActive
         FROM users
         WHERE id = ?`
      )
      .get(userId);

    if (!targetMember) {
      throw new HttpError(404, 'Member account not found');
    }
    if (targetMember.accountType !== 'member') {
      throw new HttpError(403, 'Only member accounts can be deactivated here');
    }
    if (Boolean(targetMember.isAdmin)) {
      throw new HttpError(403, 'The Maintainer must revoke administrator privilege before this account can be deactivated');
    }
    res.json(archiveRecord({
      module: 'member_accounts',
      recordType: 'member',
      recordId: userId,
      actor: req.user,
      reason: String(req.body?.reason || '').trim() || null
    }));
  } catch (err) {
    next(err);
  }
});

router.get('/admin/gallery', (req, res, next) => {
  try {
    const rows = db
      .prepare(
        `SELECT
           id,
           src,
           fallback,
           title_zh AS titleZh,
           title_en AS titleEn,
           description_zh AS descriptionZh,
           description_en AS descriptionEn,
           alt_zh AS altZh,
           alt_en AS altEn,
           is_visible AS isVisible,
           display_order AS displayOrder,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM gallery_items gallery
         WHERE NOT EXISTS (SELECT 1 FROM archive_records ar
           WHERE ar.module = 'gallery_display' AND ar.record_type = 'gallery_item'
             AND ar.record_id = gallery.id AND ar.status IN ('archived', 'deletion_requested'))
         ORDER BY display_order ASC, id ASC`
      )
      .all()
      .map(mapGalleryRow);

    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/gallery/upload', uploadLimiter, checkUploadCapacity, galleryUpload.single('imageFile'), enforceUploadedFileBudget, (req, res, next) => {
  try {
    if (!req.file) {
      throw new HttpError(400, 'Image file is required');
    }
    assertStoredRasterImage(req.file);
    const src = toStoredUploadPath(req.file.path);
    res.status(201).json({ src });
  } catch (err) {
    cleanupRejectedUpload(req.file);
    next(err);
  }
});

router.get('/admin/gallery/:itemId/media', (req, res, next) => {
  try {
    const itemId = parsePositiveInt(req.params.itemId, 'itemId');
    const row = db.prepare('SELECT src, fallback FROM gallery_items WHERE id = ?').get(itemId);
    if (!row) throw new HttpError(404, 'Gallery item not found');
    const selected = req.query.fallback === '1' ? row.fallback : row.src;
    const absolutePath = resolveManagedUploadPath(selected);
    if (!absolutePath || !fs.existsSync(absolutePath)) throw new HttpError(404, 'Gallery image not found');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.sendFile(absolutePath);
  } catch (err) {
    return next(err);
  }
});

router.post('/admin/gallery', (req, res, next) => {
  try {
    const input = createGalleryItemSchema.parse({
      src: optionalString(req.body.src) || '',
      fallback: optionalString(req.body.fallback) || null,
      titleZh: optionalString(req.body.titleZh) || '',
      titleEn: optionalString(req.body.titleEn) || '',
      descriptionZh: optionalString(req.body.descriptionZh) || null,
      descriptionEn: optionalString(req.body.descriptionEn) || null,
      altZh: optionalString(req.body.altZh) || null,
      altEn: optionalString(req.body.altEn) || null,
      isVisible: optionalBoolean(req.body.isVisible),
      displayOrder:
        req.body.displayOrder === undefined || req.body.displayOrder === null || req.body.displayOrder === ''
          ? undefined
          : Number(req.body.displayOrder)
    });

    const nextOrder = Number(
      db.prepare('SELECT COALESCE(MAX(display_order), -1) + 1 AS nextOrder FROM gallery_items').get()?.nextOrder || 0
    );
    const displayOrder = input.displayOrder ?? nextOrder;

    const result = db
      .prepare(
        `INSERT INTO gallery_items (
           src, fallback, title_zh, title_en, description_zh, description_en, alt_zh, alt_en, is_visible, display_order
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.src,
        input.fallback,
        input.titleZh,
        input.titleEn,
        input.descriptionZh,
        input.descriptionEn,
        input.altZh,
        input.altEn,
        input.src && input.isVisible ? 1 : 0,
        displayOrder
      );

    const created = db
      .prepare(
        `SELECT
           id,
           src,
           fallback,
           title_zh AS titleZh,
           title_en AS titleEn,
           description_zh AS descriptionZh,
           description_en AS descriptionEn,
           alt_zh AS altZh,
           alt_en AS altEn,
           is_visible AS isVisible,
           display_order AS displayOrder,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM gallery_items
         WHERE id = ?`
      )
      .get(Number(result.lastInsertRowid));

    res.status(201).json(mapGalleryRow(created));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid gallery item payload', details: err.issues });
    }
    return next(err);
  }
});

router.patch('/admin/gallery/:itemId', (req, res, next) => {
  try {
    const itemId = Number(req.params.itemId);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      throw new HttpError(400, 'Invalid itemId');
    }

    const input = updateGalleryItemSchema.parse({
      src: req.body.src === undefined ? undefined : optionalString(req.body.src) || '',
      fallback: req.body.fallback === undefined ? undefined : optionalString(req.body.fallback),
      titleZh: req.body.titleZh === undefined ? undefined : optionalString(req.body.titleZh) || '',
      titleEn: req.body.titleEn === undefined ? undefined : optionalString(req.body.titleEn) || '',
      descriptionZh:
        req.body.descriptionZh === undefined ? undefined : optionalString(req.body.descriptionZh),
      descriptionEn:
        req.body.descriptionEn === undefined ? undefined : optionalString(req.body.descriptionEn),
      altZh: req.body.altZh === undefined ? undefined : optionalString(req.body.altZh),
      altEn: req.body.altEn === undefined ? undefined : optionalString(req.body.altEn),
      isVisible: optionalBoolean(req.body.isVisible),
      displayOrder:
        req.body.displayOrder === undefined || req.body.displayOrder === null || req.body.displayOrder === ''
          ? undefined
          : Number(req.body.displayOrder)
    });

    const current = db
      .prepare(
        `SELECT
           id,
           src,
           fallback,
           title_zh AS titleZh,
           title_en AS titleEn,
           description_zh AS descriptionZh,
           description_en AS descriptionEn,
           alt_zh AS altZh,
           alt_en AS altEn,
           is_visible AS isVisible,
           display_order AS displayOrder
         FROM gallery_items
         WHERE id = ?`
      )
      .get(itemId);
    if (!current) {
      throw new HttpError(404, 'Gallery item not found');
    }
    const nextSrc = input.src ?? current.src;
    const nextVisible = Boolean(nextSrc) && (input.isVisible === undefined ? Boolean(current.isVisible) : input.isVisible);

    db.prepare(
      `UPDATE gallery_items
       SET
         src = ?,
         fallback = ?,
         title_zh = ?,
         title_en = ?,
         description_zh = ?,
         description_en = ?,
         alt_zh = ?,
         alt_en = ?,
         is_visible = ?,
         display_order = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(
      nextSrc,
      input.fallback === undefined ? current.fallback : input.fallback,
      input.titleZh ?? current.titleZh,
      input.titleEn ?? current.titleEn,
      input.descriptionZh === undefined ? current.descriptionZh : input.descriptionZh,
      input.descriptionEn === undefined ? current.descriptionEn : input.descriptionEn,
      input.altZh === undefined ? current.altZh : input.altZh,
      input.altEn === undefined ? current.altEn : input.altEn,
      nextVisible ? 1 : 0,
      input.displayOrder ?? current.displayOrder,
      itemId
    );

    if (input.src !== undefined && input.src !== current.src) {
      removeManagedUploadFile(current.src);
    }

    const updated = db
      .prepare(
        `SELECT
           id,
           src,
           fallback,
           title_zh AS titleZh,
           title_en AS titleEn,
           description_zh AS descriptionZh,
           description_en AS descriptionEn,
           alt_zh AS altZh,
           alt_en AS altEn,
           is_visible AS isVisible,
           display_order AS displayOrder,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM gallery_items
         WHERE id = ?`
      )
      .get(itemId);

    res.json(mapGalleryRow(updated));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid gallery item update payload', details: err.issues });
    }
    return next(err);
  }
});

router.delete('/admin/gallery/:itemId', (req, res, next) => {
  try {
    const itemId = Number(req.params.itemId);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      throw new HttpError(400, 'Invalid itemId');
    }

    res.json(archiveRecord({
      module: 'gallery_display',
      recordType: 'gallery_item',
      recordId: itemId,
      actor: req.user,
      reason: String(req.body?.reason || '').trim() || null
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/admin/activities', uploadLimiter, checkUploadCapacity, activityAttachmentUpload.array('attachmentFiles', 8), enforceUploadedFileBudget, (req, res, next) => {
  try {
    assertPublishingUploads(req.files);
    const input = publishContentSchema.parse({
      title: req.body.title,
      content: req.body.content,
      eventTime: req.body.eventTime,
      location: req.body.location,
      isPublished: optionalBoolean(req.body.isPublished) ?? true
    });

    const nowUtc = currentUtcIsoString();
    const normalizedEventTime = normalizePublishingEventTimeInput(input.eventTime);
    const publishedAt = input.isPublished ? nowUtc : null;

    const result = db
      .prepare(
        `INSERT INTO activities (
           title, content, event_time, location, created_by, is_published, published_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.title,
        input.content,
        normalizedEventTime,
        input.location || null,
        req.user.id,
        input.isPublished ? 1 : 0,
        publishedAt,
        nowUtc,
        nowUtc
      );

    const activityId = Number(result.lastInsertRowid);
    insertContentAttachmentRows('activity', activityId, req.files, req.user.id);

    const created = attachContentAttachments(
      db,
      'activity',
      [
        db
          .prepare(
            `SELECT
               id,
               title,
               content,
               event_time AS eventTime,
               location,
               is_published AS isPublished,
               published_at AS publishedAt,
               created_at AS createdAt,
               updated_at AS updatedAt
             FROM activities
             WHERE id = ?`
          )
          .get(activityId)
      ],
      { primaryField: 'attachmentPath' }
    )[0];

    if (input.isPublished) {
      const memberIds = db
        .prepare("SELECT id FROM users WHERE account_type = 'member' AND is_active = 1")
        .all()
        .map((row) => row.id);
      notifyUsers({
        userIds: memberIds,
        subject: `[NJU林泉钢琴社活动] ${created.title}`,
        content: created.content,
        relatedType: 'activity',
        relatedId: activityId
      }).catch((notifyErr) => {
        console.warn('Activity publish notification failed:', notifyErr);
      });
    }

    res.status(201).json(serializePublishingItem({
      ...created,
      isPublished: Boolean(created.isPublished)
    }));
  } catch (err) {
    cleanupUploadedFiles(req.files);
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid activity payload', details: err.issues });
    }
    return next(err);
  }
});

router.get('/admin/activities', (req, res, next) => {
  try {
    const rows = attachContentAttachments(
      db,
      'activity',
      db
        .prepare(
          `SELECT
             a.id,
             a.title,
             a.content,
             a.event_time AS eventTime,
             a.location,
             a.is_published AS isPublished,
             a.published_at AS publishedAt,
             a.created_at AS createdAt,
             a.updated_at AS updatedAt,
             u.student_number AS createdByStudentNumber,
             COALESCE(p.display_name, u.student_number) AS createdByName
           FROM activities a
           LEFT JOIN users u ON u.id = a.created_by
           LEFT JOIN profiles p ON p.user_id = u.id
           WHERE NOT EXISTS (SELECT 1 FROM archive_records ar
             WHERE ar.module = 'publishing' AND ar.record_type = 'activity'
               AND ar.record_id = a.id AND ar.status IN ('archived', 'deletion_requested'))
           ORDER BY ${activityOrderExpr} DESC, a.id DESC`
        )
        .all(),
      { primaryField: 'attachmentPath' }
    )
      .map((item) => ({
        ...serializePublishingItem(item),
        isPublished: Boolean(item.isPublished)
      }));

    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

router.patch('/admin/activities/:activityId', uploadLimiter, checkUploadCapacity, activityAttachmentUpload.array('attachmentFiles', 8), enforceUploadedFileBudget, (req, res, next) => {
  try {
    assertPublishingUploads(req.files);
    const activityId = Number(req.params.activityId);
    if (!Number.isInteger(activityId) || activityId <= 0) {
      throw new HttpError(400, 'Invalid activityId');
    }

    const input = updateActivitySchema.parse({
      title: req.body.title,
      content: req.body.content,
      eventTime: req.body.eventTime === null ? null : optionalString(req.body.eventTime),
      location: optionalString(req.body.location),
      isPublished: optionalBoolean(req.body.isPublished)
    });
    const removeAttachmentIds = parseIdList(req.body.removeAttachmentIds, 'removeAttachmentIds');

    const current = db
      .prepare(
        `SELECT
           id,
           title,
           content,
           event_time AS eventTime,
           location,
           is_published AS isPublished,
           published_at AS publishedAt
         FROM activities
         WHERE id = ?`
      )
      .get(activityId);
    if (!current) {
      throw new HttpError(404, 'Activity not found');
    }

    const nextPublished =
      input.isPublished === undefined ? Boolean(current.isPublished) : Boolean(input.isPublished);
    const nowUtc = currentUtcIsoString();
    const nextEventTime =
      input.eventTime === undefined
        ? current.eventTime
        : normalizePublishingEventTimeInput(input.eventTime);
    const nextPublishedAt = nextPublished ? (current.publishedAt || nowUtc) : null;

    db.prepare(
      `UPDATE activities
       SET
         title = ?,
         content = ?,
         event_time = ?,
         location = ?,
         is_published = ?,
         published_at = ?,
         updated_at = ?
       WHERE id = ?`
    ).run(
      input.title ?? current.title,
      input.content ?? current.content,
      nextEventTime,
      input.location === undefined ? current.location : input.location,
      nextPublished ? 1 : 0,
      nextPublishedAt,
      nowUtc,
      activityId
    );

    deleteContentAttachmentRows('activity', activityId, removeAttachmentIds);
    insertContentAttachmentRows('activity', activityId, req.files, req.user.id);

    const updated = attachContentAttachments(
      db,
      'activity',
      [
        db
          .prepare(
            `SELECT
               id,
               title,
               content,
               event_time AS eventTime,
               location,
               is_published AS isPublished,
               published_at AS publishedAt,
               created_at AS createdAt,
               updated_at AS updatedAt
             FROM activities
             WHERE id = ?`
          )
          .get(activityId)
      ],
      { primaryField: 'attachmentPath' }
    )[0];

    if (!Boolean(current.isPublished) && nextPublished) {
      const memberIds = db
        .prepare("SELECT id FROM users WHERE account_type = 'member' AND is_active = 1")
        .all()
        .map((row) => row.id);
      notifyUsers({
        userIds: memberIds,
        subject: `[NJU林泉钢琴社活动] ${updated.title}`,
        content: updated.content,
        relatedType: 'activity',
        relatedId: activityId
      }).catch((notifyErr) => {
        console.warn('Activity publish notification failed:', notifyErr);
      });
    }

    res.json(serializePublishingItem({
      ...updated,
      isPublished: Boolean(updated.isPublished)
    }));
  } catch (err) {
    cleanupUploadedFiles(req.files);
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid activity update payload', details: err.issues });
    }
    return next(err);
  }
});

router.post(
  '/admin/activities/:activityId/attachments/:attachmentId/replace',
  uploadLimiter,
  checkUploadCapacity,
  activityAttachmentUpload.single('attachmentFile'),
  enforceUploadedFileBudget,
  (req, res, next) => {
    try {
      assertStoredAllowedAttachment(req.file);
      const activityId = Number(req.params.activityId);
      const attachmentId = Number(req.params.attachmentId);
      if (!Number.isInteger(activityId) || activityId <= 0) {
        throw new HttpError(400, 'Invalid activityId');
      }
      if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
        throw new HttpError(400, 'Invalid attachmentId');
      }
      if (!req.file) {
        throw new HttpError(400, 'Attachment file is required');
      }

      const current = db
        .prepare(
          `SELECT
             id,
             title,
             content,
             event_time AS eventTime,
             location,
             is_published AS isPublished,
             published_at AS publishedAt,
             created_at AS createdAt,
             updated_at AS updatedAt
           FROM activities
           WHERE id = ?`
        )
        .get(activityId);
      if (!current) {
        throw new HttpError(404, 'Activity not found');
      }

      replaceContentAttachmentRow('activity', activityId, attachmentId, req.file, req.user.id);
      db.prepare('UPDATE activities SET updated_at = ? WHERE id = ?').run(currentUtcIsoString(), activityId);

      const updated = attachContentAttachments(
        db,
        'activity',
        [
          db
            .prepare(
              `SELECT
                 id,
                 title,
                 content,
                 event_time AS eventTime,
                 location,
                 is_published AS isPublished,
                 published_at AS publishedAt,
                 created_at AS createdAt,
                 updated_at AS updatedAt
               FROM activities
               WHERE id = ?`
            )
            .get(activityId)
        ],
        { primaryField: 'attachmentPath' }
      )[0];
      return res.json({
        message: 'Activity attachment replaced',
        item: serializePublishingItem({
          ...updated,
          isPublished: Boolean(updated.isPublished)
        })
      });
    } catch (err) {
      cleanupUploadedFiles(req.file ? [req.file] : []);
      return next(err);
    }
  }
);

router.delete('/admin/activities/:activityId/attachments/:attachmentId', (req, res, next) => {
  try {
    const activityId = Number(req.params.activityId);
    const attachmentId = Number(req.params.attachmentId);
    if (!Number.isInteger(activityId) || activityId <= 0) {
      throw new HttpError(400, 'Invalid activityId');
    }
    if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
      throw new HttpError(400, 'Invalid attachmentId');
    }

    const current = db
      .prepare(
        `SELECT
           id,
           title,
           content,
           event_time AS eventTime,
           location,
           is_published AS isPublished,
           published_at AS publishedAt,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM activities
         WHERE id = ?`
      )
      .get(activityId);
    if (!current) {
      throw new HttpError(404, 'Activity not found');
    }

    deleteContentAttachmentRows('activity', activityId, [attachmentId]);
    db.prepare('UPDATE activities SET updated_at = ? WHERE id = ?').run(currentUtcIsoString(), activityId);
    const updated = attachContentAttachments(
      db,
      'activity',
      [
        db
          .prepare(
            `SELECT
               id,
               title,
               content,
               event_time AS eventTime,
               location,
               is_published AS isPublished,
               published_at AS publishedAt,
               created_at AS createdAt,
               updated_at AS updatedAt
             FROM activities
             WHERE id = ?`
          )
          .get(activityId)
      ],
      { primaryField: 'attachmentPath' }
    )[0];
    return res.json({
      message: 'Activity attachment deleted',
      item: serializePublishingItem({
        ...updated,
        isPublished: Boolean(updated.isPublished)
      })
    });
  } catch (err) {
    return next(err);
  }
});

router.delete('/admin/activities/:activityId', (req, res, next) => {
  try {
    const activityId = Number(req.params.activityId);
    if (!Number.isInteger(activityId) || activityId <= 0) {
      throw new HttpError(400, 'Invalid activityId');
    }

    res.json(archiveRecord({
      module: 'publishing', recordType: 'activity', recordId: activityId,
      actor: req.user, reason: String(req.body?.reason || '').trim() || null
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/admin/announcements', uploadLimiter, checkUploadCapacity, announcementAttachmentUpload.array('attachmentFiles', 8), enforceUploadedFileBudget, async (req, res, next) => {
  try {
    assertPublishingUploads(req.files);
    const input = publishAnnouncementSchema.parse({
      title: req.body.title,
      content: req.body.content,
      isPublished: optionalBoolean(req.body.isPublished) ?? true
    });

    const nowUtc = currentUtcIsoString();
    const publishedAt = input.isPublished ? nowUtc : null;

    const result = db
      .prepare(
        `INSERT INTO announcements (
           title, content, attachment_path, created_by, is_published, published_at, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.title, input.content, null, req.user.id, input.isPublished ? 1 : 0, publishedAt, nowUtc, nowUtc);

    const announcementId = Number(result.lastInsertRowid);
    insertContentAttachmentRows('announcement', announcementId, req.files, req.user.id);
    syncAnnouncementAttachmentPath(announcementId);

    let notifyResult = { queued: 0, sent: 0, failed: 0, errors: [] };
    if (input.isPublished) {
      const memberIds = db
        .prepare("SELECT id FROM users WHERE account_type = 'member' AND is_active = 1")
        .all()
        .map((row) => row.id);
      notifyResult = await notifyUsers({
        userIds: memberIds,
        subject: `[NJU林泉钢琴社公告] ${input.title}`,
        content: input.content,
        relatedType: 'announcement',
        relatedId: announcementId
      });
    }

    const created = attachContentAttachments(
      db,
      'announcement',
      [
        db
          .prepare(
            `SELECT
               id,
               title,
               content,
               attachment_path AS attachmentPath,
               is_published AS isPublished,
               published_at AS publishedAt,
               created_at AS createdAt,
               updated_at AS updatedAt
             FROM announcements
             WHERE id = ?`
          )
          .get(announcementId)
      ],
      { primaryField: 'attachmentPath' }
    )[0];

    res.status(201).json(serializePublishingItem({
      ...created,
      isPublished: Boolean(created.isPublished),
      notification: notifyResult
    }));
  } catch (err) {
    cleanupUploadedFiles(req.files);
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid announcement payload', details: err.issues });
    }
    return next(err);
  }
});

router.post(
  '/admin/announcements/:announcementId/attachments/:attachmentId/replace',
  uploadLimiter,
  checkUploadCapacity,
  announcementAttachmentUpload.single('attachmentFile'),
  enforceUploadedFileBudget,
  (req, res, next) => {
    try {
      assertStoredAllowedAttachment(req.file);
      const announcementId = Number(req.params.announcementId);
      const attachmentId = Number(req.params.attachmentId);
      if (!Number.isInteger(announcementId) || announcementId <= 0) {
        throw new HttpError(400, 'Invalid announcementId');
      }
      if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
        throw new HttpError(400, 'Invalid attachmentId');
      }
      if (!req.file) {
        throw new HttpError(400, 'Attachment file is required');
      }

      const current = db
        .prepare(
          `SELECT
             id,
             title,
             content,
             attachment_path AS attachmentPath,
             is_published AS isPublished,
             published_at AS publishedAt,
             created_at AS createdAt,
             updated_at AS updatedAt
           FROM announcements
           WHERE id = ?`
        )
        .get(announcementId);
      if (!current) {
        throw new HttpError(404, 'Announcement not found');
      }

      replaceContentAttachmentRow('announcement', announcementId, attachmentId, req.file, req.user.id);
      db.prepare('UPDATE announcements SET updated_at = ? WHERE id = ?').run(currentUtcIsoString(), announcementId);
      syncAnnouncementAttachmentPath(announcementId);

      const updated = attachContentAttachments(
        db,
        'announcement',
        [
          db
            .prepare(
              `SELECT
                 id,
                 title,
                 content,
                 attachment_path AS attachmentPath,
                 is_published AS isPublished,
                 published_at AS publishedAt,
                 created_at AS createdAt,
                 updated_at AS updatedAt
               FROM announcements
               WHERE id = ?`
            )
            .get(announcementId)
        ],
        { primaryField: 'attachmentPath' }
      )[0];
      return res.json({
        message: 'Announcement attachment replaced',
        item: serializePublishingItem({
          ...updated,
          isPublished: Boolean(updated.isPublished)
        })
      });
    } catch (err) {
      cleanupUploadedFiles(req.file ? [req.file] : []);
      return next(err);
    }
  }
);

router.get('/admin/announcements', (req, res, next) => {
  try {
    const rows = attachContentAttachments(
      db,
      'announcement',
      db
        .prepare(
          `SELECT
             a.id,
             a.title,
             a.content,
             a.attachment_path AS attachmentPath,
             a.is_published AS isPublished,
             a.published_at AS publishedAt,
             a.created_at AS createdAt,
             a.updated_at AS updatedAt,
             u.student_number AS createdByStudentNumber,
             COALESCE(p.display_name, u.student_number) AS createdByName
           FROM announcements a
           LEFT JOIN users u ON u.id = a.created_by
           LEFT JOIN profiles p ON p.user_id = u.id
           WHERE NOT EXISTS (SELECT 1 FROM archive_records ar
             WHERE ar.module = 'publishing' AND ar.record_type = 'announcement'
               AND ar.record_id = a.id AND ar.status IN ('archived', 'deletion_requested'))
           ORDER BY ${announcementOrderExpr} DESC, a.id DESC`
        )
        .all(),
      { primaryField: 'attachmentPath' }
    )
      .map((item) => ({
        ...serializePublishingItem(item),
        isPublished: Boolean(item.isPublished)
      }));

    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

router.patch('/admin/announcements/:announcementId', uploadLimiter, checkUploadCapacity, announcementAttachmentUpload.array('attachmentFiles', 8), enforceUploadedFileBudget, (req, res, next) => {
  try {
    assertPublishingUploads(req.files);
    const announcementId = Number(req.params.announcementId);
    if (!Number.isInteger(announcementId) || announcementId <= 0) {
      throw new HttpError(400, 'Invalid announcementId');
    }

    const input = updateAnnouncementSchema.parse({
      title: req.body.title,
      content: req.body.content,
      isPublished: optionalBoolean(req.body.isPublished)
    });
    const removeAttachmentIds = parseIdList(req.body.removeAttachmentIds, 'removeAttachmentIds');

    const current = db
      .prepare(
        `SELECT
           id,
           title,
           content,
           attachment_path AS attachmentPath,
           is_published AS isPublished,
           published_at AS publishedAt
         FROM announcements
         WHERE id = ?`
      )
      .get(announcementId);
    if (!current) {
      throw new HttpError(404, 'Announcement not found');
    }

    const nextPublished =
      input.isPublished === undefined ? Boolean(current.isPublished) : Boolean(input.isPublished);
    const nowUtc = currentUtcIsoString();
    const nextPublishedAt = nextPublished
      ? current.publishedAt || nowUtc
      : null;

    db.prepare(
      `UPDATE announcements
       SET
         title = ?,
         content = ?,
         is_published = ?,
         published_at = ?,
         updated_at = ?
       WHERE id = ?`
    ).run(
      input.title ?? current.title,
      input.content ?? current.content,
      nextPublished ? 1 : 0,
      nextPublishedAt,
      nowUtc,
      announcementId
    );

    deleteContentAttachmentRows('announcement', announcementId, removeAttachmentIds);
    insertContentAttachmentRows('announcement', announcementId, req.files, req.user.id);
    syncAnnouncementAttachmentPath(announcementId);

    const updated = attachContentAttachments(
      db,
      'announcement',
      [
        db
          .prepare(
            `SELECT
               id,
               title,
               content,
               attachment_path AS attachmentPath,
               is_published AS isPublished,
               published_at AS publishedAt,
               created_at AS createdAt,
               updated_at AS updatedAt
             FROM announcements
             WHERE id = ?`
          )
          .get(announcementId)
      ],
      { primaryField: 'attachmentPath' }
    )[0];

    if (!Boolean(current.isPublished) && nextPublished) {
      const memberIds = db
        .prepare("SELECT id FROM users WHERE account_type = 'member' AND is_active = 1")
        .all()
        .map((row) => row.id);
      notifyUsers({
        userIds: memberIds,
        subject: `[NJU林泉钢琴社公告] ${updated.title}`,
        content: updated.content,
        relatedType: 'announcement',
        relatedId: announcementId
      }).catch((notifyErr) => {
        console.warn('Announcement publish notification failed:', notifyErr);
      });
    }

    res.json({
      ...serializePublishingItem(updated),
      isPublished: Boolean(updated.isPublished)
    });
  } catch (err) {
    cleanupUploadedFiles(req.files);
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid announcement update payload', details: err.issues });
    }
    return next(err);
  }
});

router.delete('/admin/announcements/:announcementId/attachments/:attachmentId', (req, res, next) => {
  try {
    const announcementId = Number(req.params.announcementId);
    const attachmentId = Number(req.params.attachmentId);
    if (!Number.isInteger(announcementId) || announcementId <= 0) {
      throw new HttpError(400, 'Invalid announcementId');
    }
    if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
      throw new HttpError(400, 'Invalid attachmentId');
    }

    const current = db
      .prepare(
        `SELECT
           id,
           title,
           content,
           attachment_path AS attachmentPath,
           is_published AS isPublished,
           published_at AS publishedAt,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM announcements
         WHERE id = ?`
      )
      .get(announcementId);
    if (!current) {
      throw new HttpError(404, 'Announcement not found');
    }

    deleteContentAttachmentRows('announcement', announcementId, [attachmentId]);
    db.prepare('UPDATE announcements SET updated_at = ? WHERE id = ?').run(currentUtcIsoString(), announcementId);
    syncAnnouncementAttachmentPath(announcementId);
    const updated = attachContentAttachments(
      db,
      'announcement',
      [
        db
          .prepare(
            `SELECT
               id,
               title,
               content,
               attachment_path AS attachmentPath,
               is_published AS isPublished,
               published_at AS publishedAt,
               created_at AS createdAt,
               updated_at AS updatedAt
             FROM announcements
             WHERE id = ?`
          )
          .get(announcementId)
      ],
      { primaryField: 'attachmentPath' }
    )[0];
    return res.json({
      message: 'Announcement attachment deleted',
      item: serializePublishingItem({
        ...updated,
        isPublished: Boolean(updated.isPublished)
      })
    });
  } catch (err) {
    return next(err);
  }
});

router.delete('/admin/announcements/:announcementId', (req, res, next) => {
  try {
    const announcementId = Number(req.params.announcementId);
    if (!Number.isInteger(announcementId) || announcementId <= 0) {
      throw new HttpError(400, 'Invalid announcementId');
    }

    const existing = db
      .prepare('SELECT id, attachment_path AS attachmentPath FROM announcements WHERE id = ?')
      .get(announcementId);
    if (!existing) {
      throw new HttpError(404, 'Announcement not found');
    }

    res.json(archiveRecord({
      module: 'publishing', recordType: 'announcement', recordId: announcementId,
      actor: req.user, reason: String(req.body?.reason || '').trim() || null
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/admin/semesters', (req, res, next) => {
  try {
    const input = semesterSchema.parse(req.body);
    if (input.endDate < input.startDate) {
      throw new HttpError(400, 'End date must be on or after the start date');
    }

    const tx = db.transaction(() => {
      if (input.activate) {
        db.prepare('UPDATE semesters SET is_active = 0').run();
      }

      const result = db
        .prepare(
          `INSERT INTO semesters (name, start_date, end_date, is_active)
           VALUES (?, ?, ?, ?)`
        )
        .run(input.name, input.startDate, input.endDate, input.activate ? 1 : 0);

      const semesterId = Number(result.lastInsertRowid);
      createStandardSlots(db, semesterId);
      return semesterId;
    });

    const semesterId = tx();
    res.status(201).json({
      id: semesterId,
      name: input.name,
      startDate: input.startDate,
      endDate: input.endDate,
      active: input.activate,
      slotCount: 2 * 7 * 14
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid semester payload', details: err.issues });
    }
    if (isUniqueConstraintError(err, {
      table: 'semesters',
      column: 'name',
      constraints: ['semesters_name_key']
    })) {
      return res.status(409).json({ message: 'A semester with this name already exists. Please choose a different name.' });
    }
    return next(err);
  }
});

router.get('/admin/semesters', (req, res, next) => {
  try {
    const items = listSemesterRows();
    return res.json({
      items,
      currentSemesterId: items.find((item) => item.isActive)?.id || null
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/admin/semesters/current', (req, res, next) => {
  try {
    const row = getSemesterRow(getActiveSemesterId(db));

    if (!row) {
      return res.json({ item: null });
    }
    return res.json({ item: row });
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 400) {
      return res.json({ item: null });
    }
    return next(err);
  }
});

router.patch('/admin/semesters/:semesterId', (req, res, next) => {
  try {
    const semesterId = Number(req.params.semesterId);
    if (!Number.isInteger(semesterId) || semesterId <= 0) {
      throw new HttpError(400, 'Invalid semesterId');
    }
    const input = semesterUpdateSchema.parse(req.body);
    const current = getSemesterRow(semesterId);
    if (!current) {
      throw new HttpError(404, 'Semester not found');
    }

    const nextSemester = {
      name: input.name ?? current.name,
      startDate: input.startDate ?? current.startDate,
      endDate: input.endDate ?? current.endDate,
      activate: input.activate === undefined ? current.isActive : Boolean(input.activate)
    };
    if (nextSemester.endDate < nextSemester.startDate) {
      throw new HttpError(400, 'End date must be on or after the start date');
    }

    const replacementSemesterId =
      current.isActive && input.activate === false ? findReplacementSemesterId(semesterId) : null;
    if (current.isActive && input.activate === false && !replacementSemesterId) {
      throw new HttpError(400, 'At least one semester must stay active. Activate another semester first.');
    }

    db.transaction(() => {
      if (input.activate === true) {
        db.prepare('UPDATE semesters SET is_active = 0').run();
      }
      db.prepare(
        `UPDATE semesters
         SET name = ?, start_date = ?, end_date = ?, is_active = ?
         WHERE id = ?`
      ).run(
        nextSemester.name,
        nextSemester.startDate,
        nextSemester.endDate,
        nextSemester.activate ? 1 : 0,
        semesterId
      );
      if (replacementSemesterId) {
        db.prepare('UPDATE semesters SET is_active = 1 WHERE id = ?').run(replacementSemesterId);
      }
    })();

    return res.json({
      item: getSemesterRow(semesterId),
      replacementSemesterId
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid semester update payload', details: err.issues });
    }
    if (isUniqueConstraintError(err, {
      table: 'semesters',
      column: 'name',
      constraints: ['semesters_name_key']
    })) {
      return res.status(409).json({ message: 'A semester with this name already exists. Please choose a different name.' });
    }
    return next(err);
  }
});

router.delete('/admin/semesters/:semesterId', (req, res, next) => {
  try {
    const semesterId = Number(req.params.semesterId);
    if (!Number.isInteger(semesterId) || semesterId <= 0) {
      throw new HttpError(400, 'Invalid semesterId');
    }
    const current = getSemesterRow(semesterId);
    if (!current) {
      throw new HttpError(404, 'Semester not found');
    }
    const replacementSemesterId = current.isActive ? findReplacementSemesterId(semesterId) : null;
    if (current.isActive && !replacementSemesterId) {
      throw new HttpError(400, 'The active semester cannot be deleted until another semester is available to activate.');
    }

    const archived = archiveRecord({
      module: 'scheduling', recordType: 'semester', recordId: semesterId,
      actor: req.user, reason: String(req.body?.reason || '').trim() || null
    });
    if (replacementSemesterId) {
      db.prepare('UPDATE semesters SET is_active = 1 WHERE id = ?').run(replacementSemesterId);
    }
    return res.json({ ...archived, replacementSemesterId });
  } catch (err) {
    return next(err);
  }
});

router.post('/admin/scheduling/run', (req, res, next) => {
  try {
    const input = runScheduleSchema.parse({
      semesterId: req.body.semesterId ? Number(req.body.semesterId) : undefined
    });
    const semesterId = resolveSemesterId(db, input.semesterId);
    const result = generateProposedSchedule({
      semesterId,
      adminId: req.user.id
    });
    recordScheduleOperation({
      batchId: result.batchId,
      semesterId,
      operationType: 'run_schedule',
      payload: {
        stats: result.stats
      },
      adminId: req.user.id
    });

    res.status(201).json({
      message: 'Draft schedule generated',
      semesterId,
      ...result
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid schedule request payload', details: err.issues });
    }
    return next(err);
  }
});

router.post('/admin/scheduling/update', (req, res, next) => {
  try {
    const input = runScheduleSchema.parse({
      semesterId: req.body.semesterId ? Number(req.body.semesterId) : undefined
    });
    const semesterId = resolveSemesterId(db, input.semesterId);
    const result = updateProposedSchedule({
      semesterId,
      adminId: req.user.id
    });
    recordScheduleOperation({
      batchId: result.batchId,
      semesterId,
      operationType: 'update_schedule',
      payload: {
        createdNewDraft: Boolean(result.createdNewDraft),
        addedAssignments: Number(result.addedAssignments || 0),
        stats: result.stats
      },
      adminId: req.user.id
    });

    res.status(201).json({
      message: 'Draft schedule updated incrementally',
      semesterId,
      ...result
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid schedule update payload', details: err.issues });
    }
    return next(err);
  }
});

router.get('/admin/scheduling/proposed', (req, res, next) => {
  try {
    const semesterId = resolveSemesterId(db, req.query.semesterId);
    const semester = getSemesterRow(semesterId);
    const batch = getLatestProposedBatchForSemester(semesterId);
    const compliance = getScheduleCompliance(semesterId, batch?.id || null);
    const operations = listScheduleOperations(semesterId, batch?.id || null);
    const preferenceSummary = getSchedulingPreferenceSummary(semesterId, batch?.id || null);

    const members = db
      .prepare(
        `SELECT
           u.id AS userId,
           u.student_number AS studentNumber,
           COALESCE(p.display_name, u.student_number) AS displayName,
           COUNT(DISTINCT sa.id) AS assignedCount,
           COUNT(DISTINCT sp.id) AS preferenceCount
         FROM users u
         LEFT JOIN profiles p ON p.user_id = u.id
         LEFT JOIN slot_preferences sp
           ON sp.semester_id = ?
          AND sp.user_id = u.id
         LEFT JOIN schedule_assignments sa
           ON sa.batch_id = ?
          AND sa.user_id = u.id
         WHERE u.account_type = 'member'
           AND u.is_active = 1
         GROUP BY u.id, u.student_number, p.display_name
         HAVING COUNT(DISTINCT sp.id) > 0 OR COUNT(DISTINCT sa.id) > 0
         ORDER BY u.student_number ASC`
      )
      .all(semesterId, batch?.id || -1);

    if (!batch) {
      return res.json({
        semesterId,
        semester,
        batch: null,
        assignments: [],
        members,
        unsatisfiedMembers: deriveUnsatisfiedMembers(members),
        compliance,
        operations,
        preferenceSummary
      });
    }

    const assignments = db
      .prepare(
        `SELECT
           sa.id,
           sa.user_id AS userId,
           u.student_number AS studentNumber,
           COALESCE(p.display_name, u.student_number) AS displayName,
           sa.slot_id AS slotId,
           rs.room_no AS roomNo,
           rs.day_of_week AS dayOfWeek,
           rs.hour
         FROM schedule_assignments sa
         JOIN users u ON u.id = sa.user_id
         LEFT JOIN profiles p ON p.user_id = u.id
         JOIN room_slots rs ON rs.id = sa.slot_id
         WHERE sa.batch_id = ?
         ORDER BY u.student_number ASC, rs.day_of_week, rs.hour, rs.room_no`
      )
      .all(batch.id);

    return res.json({
      semesterId,
      semester,
      batch,
      assignments,
      members,
      unsatisfiedMembers: deriveUnsatisfiedMembers(members),
      compliance,
      operations,
      preferenceSummary
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/admin/scheduling/assignments', (req, res, next) => {
  try {
    const input = createManualAssignmentSchema.parse({
      batchId: req.body.batchId ? Number(req.body.batchId) : undefined,
      userId: Number(req.body.userId),
      slotId: Number(req.body.slotId)
    });

    const tx = db.transaction(() => {
      const slot = db
        .prepare(
          `SELECT id, semester_id AS "semesterId", day_of_week AS "dayOfWeek", hour
           FROM room_slots
           WHERE id = ?`
        )
        .get(input.slotId);
      if (!slot) {
        throw new HttpError(400, 'Target slot not found');
      }
      lockSemesterInventory(slot.semesterId);

      const batch = input.batchId
        ? db
          .prepare(
            `SELECT id, semester_id AS "semesterId"
             FROM schedule_batches
             WHERE id = ? AND status = 'proposed'`
          )
          .get(input.batchId)
        : db
          .prepare(
            `SELECT id, semester_id AS "semesterId"
             FROM schedule_batches
             WHERE semester_id = ? AND status = 'proposed'
             ORDER BY created_at DESC, id DESC
             LIMIT 1`
          )
          .get(slot.semesterId);
      if (!batch) {
        throw new HttpError(404, 'No draft schedule found');
      }
      if (Number(batch.semesterId) !== Number(slot.semesterId)) {
        throw new HttpError(400, 'Batch and slot are from different semesters');
      }

      const member = db
        .prepare("SELECT id FROM users WHERE id = ? AND account_type = 'member' AND is_active = 1")
        .get(input.userId);
      if (!member) {
        throw new HttpError(404, 'Member not found');
      }

      const existing = db
        .prepare('SELECT id FROM schedule_assignments WHERE batch_id = ? AND user_id = ? AND slot_id = ?')
        .get(batch.id, input.userId, input.slotId);
      if (existing) {
        return { existing: true, id: existing.id, batchId: batch.id, semesterId: batch.semesterId };
      }
      const occupied = db
        .prepare('SELECT id FROM schedule_assignments WHERE batch_id = ? AND slot_id = ?')
        .get(batch.id, input.slotId);
      if (occupied) {
        throw new HttpError(409, 'Target slot is already occupied');
      }
      assertPianoPlacementAllowed({
        batchId: batch.id,
        semesterId: batch.semesterId,
        userId: input.userId,
        slot
      });

      const result = db
        .prepare(
          `INSERT INTO schedule_assignments (batch_id, semester_id, user_id, slot_id, status)
           VALUES (?, ?, ?, ?, 'proposed')`
        )
        .run(batch.id, batch.semesterId, input.userId, input.slotId);
      const assignmentId = Number(result.lastInsertRowid);
      recordScheduleOperation({
        batchId: batch.id,
        semesterId: batch.semesterId,
        operationType: 'manual_assign',
        payload: { assignmentId, userId: input.userId, slotId: input.slotId },
        adminId: req.user.id
      });
      return { existing: false, id: assignmentId, batchId: batch.id, semesterId: batch.semesterId };
    });

    const result = tx();
    return res.status(result.existing ? 200 : 201).json({
      id: result.id,
      batchId: result.batchId,
      semesterId: result.semesterId,
      userId: input.userId,
      slotId: input.slotId
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid manual assignment payload', details: err.issues });
    }
    return next(err);
  }
});

router.patch('/admin/scheduling/assignments/:assignmentId', (req, res, next) => {
  try {
    const assignmentId = Number(req.params.assignmentId);
    if (!Number.isInteger(assignmentId) || assignmentId <= 0) {
      throw new HttpError(400, 'Invalid assignmentId');
    }

    const input = updateAssignmentSchema.parse({
      slotId: Number(req.body.slotId),
      swapIfOccupied: optionalBoolean(req.body.swapIfOccupied) ?? true
    });

    const assignment = db
      .prepare(
        `SELECT
           sa.id,
           sa.user_id AS userId,
           sa.slot_id AS currentSlotId,
           sa.batch_id AS batchId,
           sa.semester_id AS semesterId
         FROM schedule_assignments sa
         JOIN schedule_batches sb ON sb.id = sa.batch_id
         WHERE sa.id = ? AND sb.status = 'proposed'`
      )
      .get(assignmentId);
    if (!assignment) {
      throw new HttpError(404, 'Proposed assignment not found');
    }

    const validSlot = db
      .prepare(
        `SELECT id, day_of_week AS "dayOfWeek", hour
         FROM room_slots WHERE id = ? AND semester_id = ?`
      )
      .get(input.slotId, assignment.semesterId);
    if (!validSlot) {
      throw new HttpError(400, 'Target slot is not in this semester');
    }

    const occupied = db
      .prepare(
        `SELECT id, user_id AS userId FROM schedule_assignments
         WHERE batch_id = ? AND slot_id = ? AND id != ?`
      )
      .get(assignment.batchId, input.slotId, assignmentId);
    if (occupied && !input.swapIfOccupied) {
      throw new HttpError(409, 'Target slot is already occupied in the current draft schedule');
    }

    if (!occupied) {
      const tx = db.transaction(() => {
        lockSemesterInventory(assignment.semesterId);
        const newlyOccupied = db
          .prepare('SELECT id FROM schedule_assignments WHERE batch_id = ? AND slot_id = ? AND id != ?')
          .get(assignment.batchId, input.slotId, assignmentId);
        if (newlyOccupied) {
          throw new HttpError(409, 'Target slot became occupied; reload the draft and try again');
        }
        assertPianoPlacementAllowed({
          batchId: assignment.batchId,
          semesterId: assignment.semesterId,
          userId: assignment.userId,
          slot: validSlot,
          ignoreAssignmentIds: [assignmentId]
        });
        db.prepare(
          `UPDATE schedule_assignments
           SET slot_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        ).run(input.slotId, assignmentId);
        recordScheduleOperation({
          batchId: assignment.batchId,
          semesterId: assignment.semesterId,
          operationType: 'move_assignment',
          payload: {
            assignmentId,
            userId: assignment.userId,
            fromSlotId: assignment.currentSlotId,
            toSlotId: input.slotId,
            swapped: false
          },
          adminId: req.user.id
        });
      });
      tx();

      return res.json({
        message: 'Assignment updated',
        assignmentId,
        userId: assignment.userId,
        fromSlotId: assignment.currentSlotId,
        toSlotId: input.slotId,
        swapped: false
      });
    }

    const conflictForOccupiedUser = db
      .prepare(
        `SELECT id FROM schedule_assignments
         WHERE batch_id = ? AND user_id = ? AND slot_id = ? AND id != ?`
      )
      .get(assignment.batchId, occupied.userId, assignment.currentSlotId, occupied.id);
    if (conflictForOccupiedUser) {
      throw new HttpError(409, 'Swap would create duplicate slot assignment for target user');
    }

    const conflictForCurrentUser = db
      .prepare(
        `SELECT id FROM schedule_assignments
         WHERE batch_id = ? AND user_id = ? AND slot_id = ? AND id != ?`
      )
      .get(assignment.batchId, assignment.userId, input.slotId, assignment.id);
    if (conflictForCurrentUser) {
      throw new HttpError(409, 'Swap would create duplicate slot assignment for source user');
    }

    const tx = db.transaction(() => {
      lockSemesterInventory(assignment.semesterId);
      const sourceRow = db
        .prepare(
          `SELECT id, batch_id, semester_id, user_id, slot_id, status, assigned_at
           FROM schedule_assignments WHERE id = ? AND batch_id = ? AND slot_id = ?`
        )
        .get(assignment.id, assignment.batchId, assignment.currentSlotId);
      const targetRow = db
        .prepare(
          `SELECT id, batch_id, semester_id, user_id, slot_id, status, assigned_at
           FROM schedule_assignments WHERE id = ? AND batch_id = ? AND slot_id = ?`
        )
        .get(occupied.id, assignment.batchId, input.slotId);
      if (!sourceRow || !targetRow) {
        throw new HttpError(409, 'Draft changed while processing the swap; reload and try again');
      }
      const currentSlot = db
        .prepare(
          `SELECT id, day_of_week AS "dayOfWeek", hour
           FROM room_slots WHERE id = ? AND semester_id = ?`
        )
        .get(assignment.currentSlotId, assignment.semesterId);
      assertPianoPlacementAllowed({
        batchId: assignment.batchId,
        semesterId: assignment.semesterId,
        userId: assignment.userId,
        slot: validSlot,
        ignoreAssignmentIds: [assignment.id]
      });
      assertPianoPlacementAllowed({
        batchId: assignment.batchId,
        semesterId: assignment.semesterId,
        userId: occupied.userId,
        slot: currentSlot,
        ignoreAssignmentIds: [occupied.id]
      });

      db.prepare('DELETE FROM schedule_assignments WHERE id IN (?, ?)').run(sourceRow.id, targetRow.id);
      const reinsert = db.prepare(
        `INSERT INTO schedule_assignments (
           id, batch_id, semester_id, user_id, slot_id, status, assigned_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      );
      reinsert.run(
        sourceRow.id,
        sourceRow.batch_id,
        sourceRow.semester_id,
        sourceRow.user_id,
        targetRow.slot_id,
        sourceRow.status,
        sourceRow.assigned_at
      );
      reinsert.run(
        targetRow.id,
        targetRow.batch_id,
        targetRow.semester_id,
        targetRow.user_id,
        sourceRow.slot_id,
        targetRow.status,
        targetRow.assigned_at
      );
      recordScheduleOperation({
        batchId: assignment.batchId,
        semesterId: assignment.semesterId,
        operationType: 'swap_assignment',
        payload: {
          sourceAssignmentId: assignment.id,
          sourceUserId: assignment.userId,
          sourceFromSlotId: assignment.currentSlotId,
          sourceToSlotId: input.slotId,
          targetAssignmentId: occupied.id,
          targetUserId: occupied.userId,
          targetFromSlotId: input.slotId,
          targetToSlotId: assignment.currentSlotId,
          swapped: true
        },
        adminId: req.user.id
      });
    });
    tx();

    return res.json({
      message: 'Assignment swapped',
      assignmentId,
      userId: assignment.userId,
      fromSlotId: assignment.currentSlotId,
      toSlotId: input.slotId,
      swapped: true,
      swappedWithAssignmentId: occupied.id,
      swappedWithUserId: occupied.userId,
      swappedWithFromSlotId: input.slotId,
      swappedWithToSlotId: assignment.currentSlotId
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid assignment payload', details: err.issues });
    }
    return next(err);
  }
});

router.delete('/admin/scheduling/assignments/:assignmentId', (req, res, next) => {
  try {
    const assignmentId = Number(req.params.assignmentId);
    if (!Number.isInteger(assignmentId) || assignmentId <= 0) {
      throw new HttpError(400, 'Invalid assignmentId');
    }

    const assignment = db
      .prepare(
        `SELECT
           sa.id,
           sa.batch_id AS batchId,
           sa.semester_id AS semesterId,
           sa.user_id AS userId,
           sa.slot_id AS slotId
         FROM schedule_assignments sa
         JOIN schedule_batches sb ON sb.id = sa.batch_id
         WHERE sa.id = ? AND sb.status = 'proposed'`
      )
      .get(assignmentId);
    if (!assignment) {
      throw new HttpError(404, 'Proposed assignment not found');
    }

    const tx = db.transaction(() => {
      lockSemesterInventory(assignment.semesterId);
      const deleted = db.prepare('DELETE FROM schedule_assignments WHERE id = ?').run(assignmentId);
      if (Number(deleted.changes || 0) !== 1) {
        throw new HttpError(409, 'Draft changed while deleting the assignment; reload and try again');
      }
      recordScheduleOperation({
        batchId: assignment.batchId,
        semesterId: assignment.semesterId,
        operationType: 'delete_assignment',
        payload: {
          assignmentId: assignment.id,
          userId: assignment.userId,
          slotId: assignment.slotId
        },
        adminId: req.user.id
      });
    });
    tx();
    return res.json({
      message: 'Assignment deleted',
      assignmentId,
      deleted: assignment
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/admin/scheduling/preferences/export', (req, res, next) => {
  try {
    const semesterId = resolveSemesterId(db, req.query.semesterId);
    const semester = db
      .prepare(
        `SELECT
           id,
           name,
           start_date AS startDate,
           end_date AS endDate
         FROM semesters
         WHERE id = ?`
      )
      .get(semesterId);
    if (!semester) {
      throw new HttpError(404, 'Semester not found');
    }

    const rows = db
      .prepare(
        `SELECT
           u.student_number AS studentNumber,
           COALESCE(p.display_name, u.student_number) AS displayName,
           rs.day_of_week AS dayOfWeek,
           rs.hour,
           rs.room_no AS roomNo,
           sp.created_at AS createdAt
         FROM slot_preferences sp
         JOIN users u ON u.id = sp.user_id
         LEFT JOIN profiles p ON p.user_id = u.id
         JOIN room_slots rs ON rs.id = sp.slot_id
         WHERE sp.semester_id = ?
         ORDER BY u.student_number ASC, rs.day_of_week ASC, rs.hour ASC, rs.room_no ASC`
      )
      .all(semesterId);

    const dayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const lines = [];
    lines.push(
      [
        `学期: ${semester.name}`,
        `日期: ${semester.startDate} 至 ${semester.endDate}`,
        `偏好记录数: ${rows.length}`
      ]
        .map(escapeCsv)
        .join(',')
    );
    lines.push(
      ['学号', '姓名', '星期', '时间', '琴房', '提交时间']
        .map(escapeCsv)
        .join(',')
    );

    for (const row of rows) {
      lines.push(
        [
          row.studentNumber,
          row.displayName,
          dayLabels[row.dayOfWeek] || row.dayOfWeek,
          `${String(row.hour).padStart(2, '0')}:00`,
          row.roomNo === 1 ? '大活324琴房' : '大活325琴房',
          row.createdAt
        ]
          .map(escapeCsv)
          .join(',')
      );
    }

    const csv = `\uFEFF${lines.join('\n')}`;
    const safeSemesterName = semester.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `linquan_preferences_${safeSemesterName}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    return next(err);
  }
});

router.get('/admin/scheduling/export', (req, res, next) => {
  try {
    const input = exportScheduleSchema.parse({
      batchId: req.query.batchId ? Number(req.query.batchId) : undefined
    });

    const batch = input.batchId
      ? db
        .prepare(
          `SELECT
             id,
             semester_id AS semesterId,
             status,
             created_at AS createdAt,
             published_at AS publishedAt
           FROM schedule_batches
           WHERE id = ?`
        )
        .get(input.batchId)
      : db
        .prepare(
          `SELECT
             id,
             semester_id AS semesterId,
             status,
             created_at AS createdAt,
             published_at AS publishedAt
           FROM schedule_batches
           WHERE semester_id = ? AND status IN ('proposed', 'published')
           ORDER BY
             CASE WHEN status = 'proposed' THEN 0 ELSE 1 END,
             COALESCE(published_at, created_at) DESC,
             id DESC
           LIMIT 1`
        )
        .get(resolveSemesterId(db, req.query.semesterId));

    if (!batch) {
      throw new HttpError(404, 'No schedule batch available for export');
    }

    const semester = db
      .prepare(
        `SELECT
           id,
           name,
           start_date AS startDate,
           end_date AS endDate
         FROM semesters
         WHERE id = ?`
      )
      .get(batch.semesterId);
    if (!semester) {
      throw new HttpError(404, 'Semester not found');
    }

    const rows = db
      .prepare(
        `SELECT
           rs.day_of_week AS dayOfWeek,
           rs.hour,
           rs.room_no AS roomNo,
           COALESCE(p.display_name, u.student_number) AS displayName,
           u.student_number AS studentNumber
         FROM room_slots rs
         LEFT JOIN schedule_assignments sa
           ON sa.slot_id = rs.id
          AND sa.batch_id = ?
         LEFT JOIN users u ON u.id = sa.user_id
         LEFT JOIN profiles p ON p.user_id = u.id
         WHERE rs.semester_id = ?
         ORDER BY rs.day_of_week, rs.hour, rs.room_no`
      )
      .all(batch.id, batch.semesterId);

    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const headers = ['Time'];
    for (const day of dayLabels) {
      headers.push(`${day}-Room1`);
      headers.push(`${day}-Room2`);
    }

    const slotMap = new Map();
    for (const item of rows) {
      const key = `${item.dayOfWeek}-${item.hour}-${item.roomNo}`;
      const member = item.displayName
        ? `${item.displayName} (${item.studentNumber})`
        : '';
      slotMap.set(key, member);
    }

    const lines = [];
    lines.push([
      `Semester: ${semester.name}`,
      `Date: ${semester.startDate} to ${semester.endDate}`,
      `Batch: ${batch.id}`,
      `Status: ${batch.status}`
    ].map(escapeCsv).join(','));
    lines.push(headers.map(escapeCsv).join(','));

    for (let hour = 8; hour <= 21; hour += 1) {
      const row = [`${String(hour).padStart(2, '0')}:00`];
      for (let day = 0; day <= 6; day += 1) {
        row.push(slotMap.get(`${day}-${hour}-1`) || '');
        row.push(slotMap.get(`${day}-${hour}-2`) || '');
      }
      lines.push(row.map(escapeCsv).join(','));
    }

    const csv = `\uFEFF${lines.join('\n')}`;
    const safeSemesterName = semester.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `linquan_schedule_${safeSemesterName}_batch_${batch.id}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid export payload', details: err.issues });
    }
    return next(err);
  }
});

router.post('/admin/scheduling/publish', async (req, res, next) => {
  try {
    const input = publishScheduleSchema.parse({
      semesterId: req.body.semesterId ? Number(req.body.semesterId) : undefined
    });
    const semesterId = resolveSemesterId(db, input.semesterId);
    const batch = getLatestProposedBatchForSemester(semesterId);
    if (!batch) {
      throw new HttpError(404, 'No draft schedule found for current semester');
    }

    const publishResult = publishScheduleBatch({
      batchId: batch.id,
      adminId: req.user.id
    });
    recordScheduleOperation({
      batchId: batch.id,
      semesterId,
      operationType: 'publish_schedule',
      payload: {
        notifiedUsers: publishResult.userIds.length
      },
      adminId: req.user.id
    });

    const notifyResult = await notifyUsers({
      userIds: publishResult.userIds,
      subject: 'NJU林泉钢琴社琴房排班已发布',
      content:
        '本学期琴房排班已发布，请登录系统查看你的固定时段。',
      relatedType: 'schedule_batch',
      relatedId: batch.id
    });

    res.json({
      message: 'Schedule published',
      semesterId: publishResult.semesterId,
      batchId: batch.id,
      notification: notifyResult
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid publish payload', details: err.issues });
    }
    return next(err);
  }
});

router.get('/admin/concerts', (req, res, next) => {
  try {
    const rows = db
      .prepare(
        `SELECT
           c.id,
           c.title,
           c.description,
           c.announcement,
           c.application_deadline AS applicationDeadline,
           c.status,
           c.attachment_path AS attachmentPath,
           c.created_at AS createdAt,
           c.updated_at AS updatedAt,
           u.student_number AS createdByStudentNumber,
           COALESCE(p.display_name, u.student_number) AS createdByName
         FROM concerts c
         LEFT JOIN users u ON u.id = c.created_by
         LEFT JOIN profiles p ON p.user_id = u.id
         WHERE NOT EXISTS (SELECT 1 FROM archive_records ar
           WHERE ar.module = 'concert_management' AND ar.record_type = 'concert'
             AND ar.record_id = c.id AND ar.status IN ('archived', 'deletion_requested'))
         ORDER BY c.created_at DESC, c.id DESC`
      )
      .all()
      .map(serializeConcertItem);

    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/concerts', uploadLimiter, checkUploadCapacity, concertUpload.single('attachmentFile'), enforceUploadedFileBudget, (req, res, next) => {
  try {
    if (req.file) assertStoredAllowedAttachment(req.file, { allowZip: false });
    const input = createConcertSchema.parse({
      title: req.body.title,
      description: req.body.description,
      announcement: req.body.announcement,
      applicationDeadline: req.body.applicationDeadline,
      status: req.body.status
    });

    const attachmentPath = req.file
      ? toStoredUploadPath(req.file.path)
      : null;
    const normalizedApplicationDeadline = normalizePublishingEventTimeInput(input.applicationDeadline);

    const result = db
      .prepare(
        `INSERT INTO concerts (
           title, description, announcement, application_deadline, status, attachment_path, created_by
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.title,
        input.description ?? null,
        input.announcement ?? null,
        normalizedApplicationDeadline,
        input.status,
        attachmentPath,
        req.user.id
      );

    const concertId = Number(result.lastInsertRowid);
    const created = db
      .prepare(
        `SELECT
           id,
           title,
           description,
           announcement,
           application_deadline AS applicationDeadline,
           status,
           attachment_path AS attachmentPath,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM concerts
         WHERE id = ?`
      )
      .get(concertId);

    res.status(201).json(serializeConcertItem(created));
  } catch (err) {
    cleanupUploadedFiles(req.file ? [req.file] : []);
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid concert payload', details: err.issues });
    }
    return next(err);
  }
});

router.patch('/admin/concerts/:concertId', uploadLimiter, checkUploadCapacity, concertUpload.single('attachmentFile'), enforceUploadedFileBudget, (req, res, next) => {
  try {
    if (req.file) assertStoredAllowedAttachment(req.file, { allowZip: false });
    const concertId = Number(req.params.concertId);
    if (!Number.isInteger(concertId) || concertId <= 0) {
      throw new HttpError(400, 'Invalid concertId');
    }

    const input = updateConcertSchema.parse({
      title: req.body.title,
      description: req.body.description,
      announcement: req.body.announcement,
      applicationDeadline: req.body.applicationDeadline,
      status: req.body.status,
      removeAttachment: optionalBoolean(req.body.removeAttachment)
    });

    const existing = db
      .prepare(
        `SELECT
           id,
           title,
           description,
           announcement,
           application_deadline AS applicationDeadline,
           status,
           attachment_path AS attachmentPath
         FROM concerts
         WHERE id = ?`
      )
      .get(concertId);
    if (!existing) {
      throw new HttpError(404, 'Concert not found');
    }

    const nextAttachmentPath = req.file
      ? toStoredUploadPath(req.file.path)
      : input.removeAttachment
        ? null
        : existing.attachmentPath;
    const nextApplicationDeadline =
      input.applicationDeadline === undefined
        ? existing.applicationDeadline
        : normalizePublishingEventTimeInput(input.applicationDeadline);
    const replacedAttachmentPath =
      req.file && existing.attachmentPath && existing.attachmentPath !== nextAttachmentPath
        ? existing.attachmentPath
        : !req.file && input.removeAttachment && existing.attachmentPath
          ? existing.attachmentPath
          : null;

    const result = db
      .prepare(
        `UPDATE concerts
         SET
           title = ?,
           description = ?,
           announcement = ?,
           application_deadline = ?,
           status = ?,
           attachment_path = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(
        input.title ?? existing.title,
        input.description === undefined ? existing.description : input.description,
        input.announcement === undefined ? existing.announcement : input.announcement,
        nextApplicationDeadline,
        input.status ?? existing.status,
        nextAttachmentPath,
        concertId
      );
    if (result.changes === 0) {
      throw new HttpError(404, 'Concert not found');
    }

    const updated = db
      .prepare(
        `SELECT
           id,
           title,
           description,
           announcement,
           application_deadline AS applicationDeadline,
           status,
           attachment_path AS attachmentPath,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM concerts
         WHERE id = ?`
      )
      .get(concertId);

    if (replacedAttachmentPath) {
      removeManagedUploadFile(replacedAttachmentPath);
    }

    res.json(serializeConcertItem(updated));
  } catch (err) {
    cleanupUploadedFiles(req.file ? [req.file] : []);
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid concert update payload', details: err.issues });
    }
    return next(err);
  }
});

router.patch('/admin/concerts/:concertId/status', (req, res, next) => {
  try {
    const concertId = Number(req.params.concertId);
    if (!Number.isInteger(concertId) || concertId <= 0) {
      throw new HttpError(400, 'Invalid concertId');
    }
    const status = z.enum(['draft', 'open', 'closed']).parse(req.body.status);

    const result = db
      .prepare(
        `UPDATE concerts
         SET status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(status, concertId);
    if (result.changes === 0) {
      throw new HttpError(404, 'Concert not found');
    }

    res.json({ message: 'Concert status updated', concertId, status });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid status payload', details: err.issues });
    }
    return next(err);
  }
});

router.delete('/admin/concerts/:concertId', (req, res, next) => {
  try {
    const concertId = Number(req.params.concertId);
    if (!Number.isInteger(concertId) || concertId <= 0) {
      throw new HttpError(400, 'Invalid concertId');
    }

    res.json(archiveRecord({
      module: 'concert_management', recordType: 'concert', recordId: concertId,
      actor: req.user, reason: String(req.body?.reason || '').trim() || null
    }));
  } catch (err) {
    return next(err);
  }
});

router.get('/admin/concerts/:concertId/applications', (req, res, next) => {
  try {
    const concertId = Number(req.params.concertId);
    if (!Number.isInteger(concertId) || concertId <= 0) {
      throw new HttpError(400, 'Invalid concertId');
    }

    const concert = db.prepare('SELECT id FROM concerts WHERE id = ?').get(concertId);
    if (!concert) {
      throw new HttpError(404, 'Concert not found');
    }

    const rows = db
      .prepare(
        `SELECT
           ca.id,
           ca.concert_id AS concertId,
           ca.user_id AS userId,
           u.student_number AS studentNumber,
           COALESCE(p.display_name, u.student_number) AS displayName,
           ca.applicant_name AS applicantName,
           ca.applicant_student_number AS applicantStudentNumber,
           COALESCE(ca.piece_zh, ca.piece_title) AS pieceZh,
           COALESCE(ca.piece_en, ca.composer) AS pieceEn,
           ca.duration_min AS durationMin,
           ca.contact_qq AS contactQq,
           COALESCE(ca.piece_zh, ca.piece_title) AS pieceTitle,
           COALESCE(ca.piece_en, ca.composer) AS composer,
           ca.note,
           ca.score_file_path AS scoreFilePath,
           ca.status,
           ca.feedback,
           ca.created_at AS createdAt,
           ca.updated_at AS updatedAt
         FROM concert_applications ca
         JOIN users u ON u.id = ca.user_id
         LEFT JOIN profiles p ON p.user_id = u.id
         WHERE ca.concert_id = ?
         ORDER BY ca.created_at DESC, ca.id DESC`
      )
      .all(concertId)
      .map(serializeConcertApplicationItem);

    return res.json({ items: rows });
  } catch (err) {
    return next(err);
  }
});

router.get('/admin/concerts/:concertId/applications/export', (req, res, next) => {
  try {
    const concertId = Number(req.params.concertId);
    if (!Number.isInteger(concertId) || concertId <= 0) {
      throw new HttpError(400, 'Invalid concertId');
    }

    const concert = db
      .prepare(
        `SELECT
           id,
           title,
           status
         FROM concerts
         WHERE id = ?`
      )
      .get(concertId);
    if (!concert) {
      throw new HttpError(404, 'Concert not found');
    }

    const rows = db
      .prepare(
        `SELECT
           ca.id,
           ca.concert_id AS concertId,
           ca.user_id AS userId,
           u.student_number AS studentNumber,
           COALESCE(p.display_name, u.student_number) AS displayName,
           ca.applicant_name AS applicantName,
           ca.applicant_student_number AS applicantStudentNumber,
           COALESCE(ca.piece_zh, ca.piece_title) AS pieceZh,
           COALESCE(ca.piece_en, ca.composer) AS pieceEn,
           ca.duration_min AS durationMin,
           ca.contact_qq AS contactQq,
           ca.score_file_path AS scoreFilePath,
           ca.status,
           ca.feedback,
           ca.created_at AS createdAt,
           ca.updated_at AS updatedAt
         FROM concert_applications ca
         JOIN users u ON u.id = ca.user_id
         LEFT JOIN profiles p ON p.user_id = u.id
         WHERE ca.concert_id = ?
         ORDER BY ca.created_at DESC, ca.id DESC`
      )
      .all(concertId)
      .map(serializeConcertApplicationItem);

    const lines = [];
    lines.push(
      [
        `音乐会: ${concert.title}`,
        `音乐会ID: ${concert.id}`,
        `状态: ${concert.status}`,
        `报名数量: ${rows.length}`
      ]
        .map(escapeCsv)
        .join(',')
    );
    lines.push(
      [
        '报名ID',
        '姓名',
        '学号',
        '曲目作者与名称（中文）',
        '曲目作者与名称（英文）',
        '预计时长（min）',
        '联系方式（QQ）',
        '状态',
        '反馈',
        '乐谱文件',
        '提交时间',
        '更新时间'
      ]
        .map(escapeCsv)
        .join(',')
    );

    for (const row of rows) {
      lines.push(
        [
          row.id,
          row.applicantName || row.displayName,
          row.applicantStudentNumber || row.studentNumber,
          row.pieceZh || '',
          row.pieceEn || '',
          row.durationMin ?? '',
          row.contactQq || '',
          row.status || '',
          row.feedback || '',
          row.scoreFilePath || '',
          row.createdAt || '',
          row.updatedAt || ''
        ]
          .map(escapeCsv)
          .join(',')
      );
    }

    const csv = `\uFEFF${lines.join('\n')}`;
    const safeTitle = String(concert.title || 'concert').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `linquan_concert_applications_${safeTitle}_${concert.id}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    return next(err);
  }
});

router.post('/admin/concerts/:concertId/release', async (req, res, next) => {
  try {
    const concertId = Number(req.params.concertId);
    if (!Number.isInteger(concertId) || concertId <= 0) {
      throw new HttpError(400, 'Invalid concertId');
    }
    const input = releaseConcertSchema.parse({
      message: optionalString(req.body.message)
    });

    const release = db.transaction(() => {
      const concert = db
        .prepare(
          `SELECT id, title, description, announcement, status
           FROM concerts
           WHERE id = ?`
        )
        .get(concertId);
      if (!concert) throw new HttpError(404, 'Concert not found');
      if (concert.status === 'open') throw new HttpError(409, 'Concert is already released');

      const update = db.prepare(
        `UPDATE concerts
         SET status = 'open', updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status != 'open'`
      ).run(concertId);
      if (Number(update.changes || 0) !== 1) {
        throw new HttpError(409, 'Concert is already released');
      }

      const memberIds = db
        .prepare("SELECT id FROM users WHERE account_type = 'member' AND is_active = 1")
        .all()
        .map((row) => row.id);
      const notificationInput = {
        userIds: memberIds,
        subject: `[NJU林泉钢琴社音乐会发布] ${concert.title}`,
        content:
          input.message
          || concert.announcement
          || concert.description
          || '新的音乐会周期已发布，请登录查看详情并报名。',
        relatedType: 'concert',
        relatedId: concertId
      };
      return {
        notificationInput,
        queue: queueNotifications(notificationInput)
      };
    })();
    const notifyResult = await deliverQueuedNotifications(release.queue, release.notificationInput);

    res.json({
      message: 'Concert released',
      concertId,
      status: 'open',
      notification: notifyResult
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid release payload', details: err.issues });
    }
    return next(err);
  }
});

export default router;
