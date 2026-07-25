import db from '../config/db.js';
import HttpError from '../utils/httpError.js';
import { currentUtcIsoString } from '../utils/dateTime.js';
import { revalidateExistingMatches } from './classMatching/algorithm.js';
import { lockSemesterInventory } from './roomInventory.js';

const ACTIVE_ARCHIVE_STATUSES = new Set(['archived', 'deletion_requested']);

const RECORD_TYPES = {
  'publishing/activity': {
    table: 'activities',
    module: 'publishing',
    recordType: 'activity',
    load: (id) => db.prepare('SELECT * FROM activities WHERE id = ?').get(id),
    title: (row) => row.title,
    search: (row) => `${row.title || ''} ${row.content || ''} ${row.location || ''}`,
    dependencyCount: (id) => Number(db.prepare("SELECT COUNT(*) AS count FROM content_attachments WHERE owner_type = 'activity' AND owner_id = ?").get(id)?.count || 0)
  },
  'publishing/announcement': {
    table: 'announcements',
    module: 'publishing',
    recordType: 'announcement',
    load: (id) => db.prepare('SELECT * FROM announcements WHERE id = ?').get(id),
    title: (row) => row.title,
    search: (row) => `${row.title || ''} ${row.content || ''}`,
    dependencyCount: (id) => Number(db.prepare("SELECT COUNT(*) AS count FROM content_attachments WHERE owner_type = 'announcement' AND owner_id = ?").get(id)?.count || 0)
  },
  'scheduling/semester': {
    table: 'semesters',
    module: 'scheduling',
    recordType: 'semester',
    load: (id) => db.prepare('SELECT * FROM semesters WHERE id = ?').get(id),
    title: (row) => row.name,
    search: (row) => `${row.name || ''} ${row.start_date || ''} ${row.end_date || ''}`,
    dependencyCount: (id) => {
      const row = db.prepare(`SELECT
          (SELECT COUNT(*) FROM slot_preferences WHERE semester_id = ?) +
          (SELECT COUNT(*) FROM schedule_batches WHERE semester_id = ?) +
          (SELECT COUNT(*) FROM class_matching_terms WHERE semester_id = ?) AS count`).get(id, id, id);
      return Number(row?.count || 0);
    }
  },
  'class_matching/term': {
    table: 'class_matching_terms',
    module: 'class_matching',
    recordType: 'term',
    load: (id) => db.prepare('SELECT * FROM class_matching_terms WHERE id = ?').get(id),
    title: (row) => row.name,
    search: (row) => `${row.name || ''} ${row.start_date || ''} ${row.end_date || ''}`,
    dependencyCount: (id) => {
      const row = db.prepare(`SELECT
          (SELECT COUNT(*) FROM class_matching_profiles WHERE term_id = ?) +
          (SELECT COUNT(*) FROM class_matching_versions WHERE term_id = ?) AS count`).get(id, id);
      return Number(row?.count || 0);
    }
  },
  'concert_management/concert': {
    table: 'concerts',
    module: 'concert_management',
    recordType: 'concert',
    load: (id) => db.prepare('SELECT * FROM concerts WHERE id = ?').get(id),
    title: (row) => row.title,
    search: (row) => `${row.title || ''} ${row.description || ''} ${row.announcement || ''}`,
    dependencyCount: (id) => Number(db.prepare('SELECT COUNT(*) AS count FROM concert_applications WHERE concert_id = ?').get(id)?.count || 0)
  },
  'gallery_display/gallery_item': {
    table: 'gallery_items',
    module: 'gallery_display',
    recordType: 'gallery_item',
    load: (id) => db.prepare('SELECT * FROM gallery_items WHERE id = ?').get(id),
    title: (row) => row.title_zh || row.title_en || `Gallery ${row.id}`,
    search: (row) => `${row.title_zh || ''} ${row.title_en || ''} ${row.description_zh || ''} ${row.description_en || ''}`,
    dependencyCount: () => 0
  },
  'member_accounts/member': {
    table: 'users',
    module: 'member_accounts',
    recordType: 'member',
    load: (id) => db.prepare(`SELECT u.*, p.display_name, p.public_id
      FROM users u LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.id = ? AND u.account_type = 'member'`).get(id),
    title: (row) => row.display_name || row.student_number,
    search: (row) => `${row.display_name || ''} ${row.student_number || ''} ${row.email || ''}`,
    dependencyCount: () => Number.MAX_SAFE_INTEGER
  }
};

function configFor(module, recordType) {
  const config = RECORD_TYPES[`${module}/${recordType}`];
  if (!config) throw new HttpError(400, 'Unsupported archive record type');
  return config;
}

function parseSnapshot(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

function publicSnapshot(value) {
  const snapshot = typeof value === 'string' ? parseSnapshot(value) : { ...(value || {}) };
  for (const key of ['password_hash', 'passwordHash', 'auth_version', 'authVersion']) {
    delete snapshot[key];
  }
  return snapshot;
}

function serializeArchive(row) {
  return {
    id: Number(row.id),
    module: row.module,
    recordType: row.recordType,
    recordId: Number(row.recordId),
    title: row.title,
    searchText: row.searchText,
    status: row.status,
    snapshot: publicSnapshot(row.snapshotJson),
    archivedAt: row.archivedAt,
    archivedBy: row.archivedBy ? Number(row.archivedBy) : null,
    restoredAt: row.restoredAt,
    restoredBy: row.restoredBy ? Number(row.restoredBy) : null,
    deletionRequestedAt: row.deletionRequestedAt,
    deletionRequestedBy: row.deletionRequestedBy ? Number(row.deletionRequestedBy) : null,
    permanentlyDeletedAt: row.permanentlyDeletedAt,
    permanentlyDeletedBy: row.permanentlyDeletedBy ? Number(row.permanentlyDeletedBy) : null,
    updatedAt: row.updatedAt
  };
}

function getArchiveById(archiveId) {
  const row = db.prepare(`SELECT id, module, record_type AS "recordType", record_id AS "recordId",
      title, search_text AS "searchText", status, snapshot_json AS "snapshotJson",
      archived_at AS "archivedAt", archived_by AS "archivedBy", restored_at AS "restoredAt",
      restored_by AS "restoredBy", deletion_requested_at AS "deletionRequestedAt",
      deletion_requested_by AS "deletionRequestedBy", permanently_deleted_at AS "permanentlyDeletedAt",
      permanently_deleted_by AS "permanentlyDeletedBy", updated_at AS "updatedAt"
    FROM archive_records WHERE id = ?`).get(archiveId);
  if (!row) throw new HttpError(404, 'Archived record not found');
  return serializeArchive(row);
}

function recordHistory({ archiveId, action, actor, reason = null, details = null }) {
  db.prepare(`INSERT INTO archive_history (
      archive_id, action, actor_user_id, actor_account_type, actor_credential,
      reason, details_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      archiveId,
      action,
      actor?.id || null,
      actor?.accountType || 'system',
      actor?.studentNumber || 'system',
      reason || null,
      details ? JSON.stringify(details) : null,
      currentUtcIsoString()
    );
}

function archiveRow(module, recordType, recordId, actor, reason) {
  const config = configFor(module, recordType);
  const row = config.load(recordId);
  if (!row) throw new HttpError(404, 'Record not found');
  if (module === 'member_accounts' && Boolean(row.is_admin)) {
    throw new HttpError(409, 'Administrator privilege must be revoked by the Maintainer before archiving this member');
  }

  const existing = db.prepare(`SELECT id, status FROM archive_records
    WHERE module = ? AND record_type = ? AND record_id = ?`).get(module, recordType, recordId);
  if (existing && ACTIVE_ARCHIVE_STATUSES.has(existing.status)) {
    return getArchiveById(existing.id);
  }

  const now = currentUtcIsoString();
  const snapshot = JSON.stringify(publicSnapshot(row));
  let archiveId;
  if (existing) {
    db.prepare(`UPDATE archive_records SET title = ?, search_text = ?, status = 'archived',
        snapshot_json = ?, archived_at = ?, archived_by = ?, restored_at = NULL, restored_by = NULL,
        deletion_requested_at = NULL, deletion_requested_by = NULL,
        permanently_deleted_at = NULL, permanently_deleted_by = NULL, updated_at = ?
      WHERE id = ?`)
      .run(config.title(row), config.search(row), snapshot, now, actor.id, now, existing.id);
    archiveId = Number(existing.id);
  } else {
    archiveId = Number(db.prepare(`INSERT INTO archive_records (
        module, record_type, record_id, title, search_text, status, snapshot_json,
        archived_at, archived_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'archived', ?, ?, ?, ?)`)
      .run(module, recordType, recordId, config.title(row), config.search(row), snapshot, now, actor.id, now).lastInsertRowid);
  }

  if (module === 'member_accounts') {
    db.prepare(`UPDATE users SET is_active = 0, auth_version = auth_version + 1,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(recordId);
  } else if (module === 'scheduling') {
    db.prepare('UPDATE semesters SET is_active = 0 WHERE id = ?').run(recordId);
  } else if (module === 'class_matching') {
    db.prepare('UPDATE class_matching_terms SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(recordId);
  } else if (module === 'gallery_display') {
    db.prepare("UPDATE gallery_items SET src = '', fallback = NULL, is_visible = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(recordId);
  }
  recordHistory({ archiveId, action: 'archive', actor, reason, details: { title: config.title(row) } });
  return getArchiveById(archiveId);
}

export function archiveRecord({ module, recordType, recordId, actor, reason = null }) {
  const tx = db.transaction(() => archiveRow(module, recordType, Number(recordId), actor, reason));
  return tx();
}

export function listArchivedRecords({ module = '', status = '', search = '', limit = 200 } = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const keyword = `%${String(search || '').trim().toLowerCase()}%`;
  const rows = db.prepare(`SELECT id, module, record_type AS "recordType", record_id AS "recordId",
      title, search_text AS "searchText", status, snapshot_json AS "snapshotJson",
      archived_at AS "archivedAt", archived_by AS "archivedBy", restored_at AS "restoredAt",
      restored_by AS "restoredBy", deletion_requested_at AS "deletionRequestedAt",
      deletion_requested_by AS "deletionRequestedBy", permanently_deleted_at AS "permanentlyDeletedAt",
      permanently_deleted_by AS "permanentlyDeletedBy", updated_at AS "updatedAt"
    FROM archive_records
    WHERE ((? = '' AND status IN ('archived', 'deletion_requested')) OR status = ?)
      AND (? = '' OR module = ?)
      AND (? = '%%' OR LOWER(title) LIKE ? OR LOWER(search_text) LIKE ?)
    ORDER BY archived_at DESC, id DESC LIMIT ?`)
    .all(status, status, module, module, keyword, keyword, keyword, normalizedLimit);
  return rows.map(serializeArchive);
}

export function listArchiveHistory({ archiveId = null, module = '', search = '', limit = 300 } = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 300, 1), 500);
  const normalizedArchiveId = Number(archiveId) || 0;
  const keyword = `%${String(search || '').trim().toLowerCase()}%`;
  return db.prepare(`SELECT h.id, h.archive_id AS "archiveId", ar.module, ar.record_type AS "recordType",
      ar.record_id AS "recordId", ar.title, h.action, h.actor_user_id AS "actorUserId",
      h.actor_account_type AS "actorAccountType", h.actor_credential AS "actorCredential",
      h.reason, h.details_json AS "detailsJson", h.created_at AS "createdAt"
    FROM archive_history h JOIN archive_records ar ON ar.id = h.archive_id
    WHERE (? = 0 OR h.archive_id = ?)
      AND (? = '' OR ar.module = ?)
      AND (? = '%%' OR LOWER(ar.title) LIKE ? OR LOWER(COALESCE(h.reason, '')) LIKE ?)
    ORDER BY h.created_at DESC, h.id DESC LIMIT ?`)
    .all(normalizedArchiveId, normalizedArchiveId, module, module, keyword, keyword, keyword, normalizedLimit)
    .map((row) => ({
      ...row,
      id: Number(row.id),
      archiveId: Number(row.archiveId),
      recordId: Number(row.recordId),
      actorUserId: row.actorUserId ? Number(row.actorUserId) : null,
      details: parseSnapshot(row.detailsJson)
    }));
}

export function restoreArchivedRecord({ archiveId, actor, reason = null }) {
  const tx = db.transaction(() => {
    const archived = getArchiveById(Number(archiveId));
    if (!ACTIVE_ARCHIVE_STATUSES.has(archived.status)) throw new HttpError(409, 'Record is not currently archived');
    const config = configFor(archived.module, archived.recordType);
    const current = config.load(archived.recordId);
    if (!current) throw new HttpError(409, 'Original record no longer exists and cannot be restored online');
    const snapshot = archived.snapshot;
    const now = currentUtcIsoString();
    // Marking the archive restored inside this transaction lets the ordinary
    // Class Matching loaders inspect it. Any validation failure rolls this back.
    db.prepare(`UPDATE archive_records SET status = 'restored', restored_at = ?, restored_by = ?,
      deletion_requested_at = NULL, deletion_requested_by = NULL, updated_at = ? WHERE id = ?`)
      .run(now, actor.id, now, archived.id);
    if (archived.module === 'member_accounts') {
      db.prepare(`UPDATE users SET is_active = ?, auth_version = auth_version + 1,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(Number(snapshot.is_active ?? 1), archived.recordId);
    } else if (archived.module === 'scheduling') {
      if (Number(snapshot.is_active || 0)) {
        db.prepare('UPDATE semesters SET is_active = 0 WHERE id != ?').run(archived.recordId);
      }
      db.prepare('UPDATE semesters SET is_active = ? WHERE id = ?').run(Number(snapshot.is_active || 0), archived.recordId);
    } else if (archived.module === 'class_matching') {
      if (Number(snapshot.is_active || 0)) {
        if (!current.semester_id) {
          throw new HttpError(409, 'Archived Class Matching term has no linked semester inventory');
        }
        lockSemesterInventory(current.semester_id);
        const currentMatches = db.prepare(
          `SELECT
             match.student_user_id AS "studentUserId",
             match.teacher_user_id AS "teacherUserId",
             match.room_slot_id AS "roomSlotId",
             match.match_type AS "matchType",
             match.matching_score AS "matchingScore",
             match.status,
             match.notes,
             match.admin_comment AS "adminComment"
           FROM class_matching_versions version
           JOIN class_matching_matches match ON match.version_id = version.id
           WHERE version.term_id = ? AND version.is_current = 1
           ORDER BY match.id ASC`
        ).all(archived.recordId);
        if (currentMatches.length > 0) {
          const revalidated = revalidateExistingMatches(archived.recordId, currentMatches);
          const changedRoom = revalidated.validMatches.some((item) => {
            const original = currentMatches.find(
              (candidate) => Number(candidate.studentUserId) === Number(item.studentUserId)
            );
            return Number(original?.roomSlotId || 0) !== Number(item.roomSlotId || 0);
          });
          if (revalidated.droppedMatches.length > 0 || changedRoom) {
            throw new HttpError(
              409,
              'This archived Class Matching term conflicts with the current Piano Time plan and cannot be restored'
            );
          }
        }
        db.prepare('UPDATE class_matching_terms SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id != ?')
          .run(archived.recordId);
      }
      db.prepare('UPDATE class_matching_terms SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(Number(snapshot.is_active || 0), archived.recordId);
    } else if (archived.module === 'gallery_display') {
      db.prepare(`UPDATE gallery_items SET src = ?, fallback = ?, is_visible = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`).run(snapshot.src || '', snapshot.fallback || null, Number(snapshot.is_visible || 0), archived.recordId);
    }
    recordHistory({ archiveId: archived.id, action: 'restore', actor, reason });
    return getArchiveById(archived.id);
  });
  return tx();
}

export function requestPermanentDeletion({ archiveId, actor, reason }) {
  if (!String(reason || '').trim()) throw new HttpError(400, 'A deletion reason is required');
  const tx = db.transaction(() => {
    const archived = getArchiveById(Number(archiveId));
    if (archived.status !== 'archived') throw new HttpError(409, 'Only archived records can enter deletion review');
    const now = currentUtcIsoString();
    db.prepare(`UPDATE archive_records SET status = 'deletion_requested', deletion_requested_at = ?,
      deletion_requested_by = ?, updated_at = ? WHERE id = ?`).run(now, actor.id, now, archived.id);
    recordHistory({ archiveId: archived.id, action: 'deletion_request', actor, reason });
    return getArchiveById(archived.id);
  });
  return tx();
}

export function permanentlyDeleteArchivedRecord({ archiveId, actor, confirmation }) {
  const tx = db.transaction(() => {
    const archived = getArchiveById(Number(archiveId));
    if (archived.status !== 'deletion_requested') throw new HttpError(409, 'Deletion has not been requested');
    const expected = `PERMANENTLY DELETE ${archived.module}/${archived.recordType}/${archived.recordId}`;
    if (confirmation !== expected) throw new HttpError(400, `Confirmation must exactly match: ${expected}`);
    const config = configFor(archived.module, archived.recordType);
    const current = config.load(archived.recordId);
    if (!current) throw new HttpError(409, 'Original record is already missing; review it manually');
    const dependencies = config.dependencyCount(archived.recordId);
    if (dependencies > 0) {
      throw new HttpError(409, 'Permanent deletion is blocked because historical or dependent records exist');
    }
    db.prepare(`DELETE FROM ${config.table} WHERE id = ?`).run(archived.recordId);
    const now = currentUtcIsoString();
    db.prepare(`UPDATE archive_records SET status = 'permanently_deleted', permanently_deleted_at = ?,
      permanently_deleted_by = ?, updated_at = ? WHERE id = ?`).run(now, actor.id, now, archived.id);
    recordHistory({ archiveId: archived.id, action: 'permanent_delete', actor, details: { confirmation: expected } });
    return getArchiveById(archived.id);
  });
  return tx();
}

export function isArchived(module, recordType, recordId) {
  const row = db.prepare(`SELECT status FROM archive_records
    WHERE module = ? AND record_type = ? AND record_id = ?`).get(module, recordType, recordId);
  return Boolean(row && ACTIVE_ARCHIVE_STATUSES.has(row.status));
}

export function activeArchiveFilter(alias, module, recordType, idColumn = 'id') {
  return `NOT EXISTS (SELECT 1 FROM archive_records ar
    WHERE ar.module = '${module}' AND ar.record_type = '${recordType}'
      AND ar.record_id = ${alias}.${idColumn} AND ar.status IN ('archived', 'deletion_requested'))`;
}
