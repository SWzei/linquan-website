import db from '../../config/db.js';
import HttpError from '../../utils/httpError.js';
import { currentUtcIsoString } from '../../utils/dateTime.js';
import { getTerm } from './common.js';
import { lockSemesterInventory } from '../roomInventory.js';

const VERSION_SOURCES = new Set(['algorithm', 'manual', 'incremental', 'restore']);
const MATCH_TYPES = new Set(['locked', 'algorithm', 'manual']);

function mapBoolean(value) {
  return Boolean(Number(value || 0));
}

function escapeCsv(value) {
  const text = value === undefined || value === null ? '' : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function getCurrentVersion(termId) {
  const row = db
    .prepare(
      `SELECT
         id,
         term_id AS "termId",
         version_number AS "versionNumber",
         source_type AS "sourceType",
         change_summary AS "changeSummary",
         created_by AS "createdBy",
         created_at AS "createdAt",
         based_on_version_id AS "basedOnVersionId",
         is_current AS "isCurrent"
       FROM class_matching_versions
       WHERE term_id = ? AND is_current = 1
       ORDER BY version_number DESC, id DESC
       LIMIT 1`
    )
    .get(termId);
  if (!row) {
    return null;
  }
  return {
    ...row,
    isCurrent: mapBoolean(row.isCurrent)
  };
}

export function getVersion(termId, versionId) {
  const row = db
    .prepare(
      `SELECT
         id,
         term_id AS "termId",
         version_number AS "versionNumber",
         source_type AS "sourceType",
         change_summary AS "changeSummary",
         created_by AS "createdBy",
         created_at AS "createdAt",
         based_on_version_id AS "basedOnVersionId",
         is_current AS "isCurrent"
       FROM class_matching_versions
       WHERE term_id = ? AND id = ?`
    )
    .get(termId, versionId);
  if (!row) {
    throw new HttpError(404, 'Class matching version not found');
  }
  return {
    ...row,
    isCurrent: mapBoolean(row.isCurrent)
  };
}

export function listVersions(termId) {
  return db
    .prepare(
      `SELECT
         v.id,
         v.term_id AS "termId",
         v.version_number AS "versionNumber",
         v.source_type AS "sourceType",
         v.change_summary AS "changeSummary",
         v.created_by AS "createdBy",
         v.created_at AS "createdAt",
         v.based_on_version_id AS "basedOnVersionId",
         v.is_current AS "isCurrent",
         COALESCE(u.student_number, '') AS "operatorStudentNumber",
         COALESCE(p.display_name, u.student_number, '') AS "operatorName",
         COUNT(m.id) AS "matchCount"
       FROM class_matching_versions v
       LEFT JOIN users u ON u.id = v.created_by
       LEFT JOIN profiles p ON p.user_id = u.id
       LEFT JOIN class_matching_matches m ON m.version_id = v.id
       WHERE v.term_id = ?
       GROUP BY
         v.id, v.term_id, v.version_number, v.source_type, v.change_summary,
         v.created_by, v.created_at, v.based_on_version_id, v.is_current,
         u.student_number, p.display_name
       ORDER BY v.version_number DESC, v.id DESC`
    )
    .all(termId)
    .map((item) => ({
      ...item,
      isCurrent: mapBoolean(item.isCurrent)
    }));
}

export function loadVersionMatches(versionId) {
  return db
    .prepare(
      `SELECT
         m.id,
         m.version_id AS "versionId",
         m.term_id AS "termId",
         m.student_user_id AS "studentUserId",
         su.student_number AS "studentNumber",
         COALESCE(sp.display_name, su.student_number) AS "studentName",
         m.teacher_user_id AS "teacherUserId",
         tu.student_number AS "teacherNumber",
         COALESCE(tp.display_name, tu.student_number) AS "teacherName",
         m.room_slot_id AS "roomSlotId",
         rs.room_no AS "roomNo",
         rs.day_of_week AS "dayOfWeek",
         rs.hour,
         m.match_type AS "matchType",
         m.matching_score AS "matchingScore",
         m.status,
         m.notes,
         m.admin_comment AS "adminComment",
         m.created_at AS "createdAt",
         m.updated_at AS "updatedAt"
       FROM class_matching_matches m
       JOIN users su ON su.id = m.student_user_id
       LEFT JOIN profiles sp ON sp.user_id = su.id
       JOIN users tu ON tu.id = m.teacher_user_id
       LEFT JOIN profiles tp ON tp.user_id = tu.id
       LEFT JOIN room_slots rs ON rs.id = m.room_slot_id
       WHERE m.version_id = ?
       ORDER BY su.student_number ASC`
    )
    .all(versionId);
}

export function loadCurrentMatches(termId) {
  const version = getCurrentVersion(termId);
  if (!version) {
    return {
      version: null,
      matches: []
    };
  }
  return {
    version,
    matches: loadVersionMatches(version.id)
  };
}

function getNextVersionNumber(termId) {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(version_number), 0) AS "maxVersion"
       FROM class_matching_versions
       WHERE term_id = ?`
    )
    .get(termId);
  return Number(row?.maxVersion || 0) + 1;
}

export function createVersionSnapshot({ termId, sourceType, adminId, changeSummary, basedOnVersionId = null, matches }) {
  if (!VERSION_SOURCES.has(sourceType)) {
    throw new HttpError(400, 'Unsupported class matching version source');
  }

  const versionNumber = getNextVersionNumber(termId);
  const nowUtc = currentUtcIsoString();

  const tx = db.transaction(() => {
    const term = getTerm(termId);
    if (!term.semesterId) {
      throw new HttpError(409, 'Class Matching term is not linked to a Piano Time semester');
    }
    lockSemesterInventory(term.semesterId);
    db.prepare('UPDATE class_matching_versions SET is_current = 0 WHERE term_id = ?').run(termId);

    const versionResult = db
      .prepare(
        `INSERT INTO class_matching_versions (
           term_id, version_number, source_type, change_summary, created_by, created_at, based_on_version_id, is_current
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(termId, versionNumber, sourceType, changeSummary || null, adminId || null, nowUtc, basedOnVersionId);

    const versionId = Number(versionResult.lastInsertRowid);
    if (Array.isArray(matches) && matches.length > 0) {
      const insertMatch = db.prepare(
        `INSERT INTO class_matching_matches (
           version_id, term_id, student_user_id, teacher_user_id, room_slot_id,
           match_type, matching_score, status, notes, admin_comment, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const match of matches) {
        if (!MATCH_TYPES.has(match.matchType)) {
          throw new HttpError(400, 'Unsupported class matching match type');
        }
        if (!Number.isInteger(Number(match.roomSlotId)) || Number(match.roomSlotId) <= 0) {
          throw new HttpError(409, 'Every Class Matching result must reserve a piano room and time');
        }
        insertMatch.run(
          versionId,
          termId,
          match.studentUserId,
          match.teacherUserId,
          Number(match.roomSlotId),
          match.matchType,
          Number(match.matchingScore || 0),
          match.status || 'matched',
          match.notes || null,
          match.adminComment || null,
          nowUtc,
          nowUtc
        );
      }
    }

    return {
      id: versionId,
      termId,
      versionNumber,
      sourceType,
      changeSummary: changeSummary || null,
      createdBy: adminId || null,
      createdAt: nowUtc,
      basedOnVersionId,
      isCurrent: true
    };
  });

  return tx();
}

export function compareVersions(termId, fromVersionId, toVersionId) {
  const fromVersion = getVersion(termId, fromVersionId);
  const toVersion = getVersion(termId, toVersionId);
  const fromMatches = loadVersionMatches(fromVersionId);
  const toMatches = loadVersionMatches(toVersionId);

  const fromMap = new Map(fromMatches.map((item) => [item.studentUserId, item]));
  const toMap = new Map(toMatches.map((item) => [item.studentUserId, item]));
  const allStudents = new Set([...fromMap.keys(), ...toMap.keys()]);

  const added = [];
  const removed = [];
  const changed = [];

  for (const studentUserId of allStudents) {
    const left = fromMap.get(studentUserId) || null;
    const right = toMap.get(studentUserId) || null;
    if (!left && right) {
      added.push(right);
      continue;
    }
    if (left && !right) {
      removed.push(left);
      continue;
    }
    if (!left || !right) {
      continue;
    }
    if (
      left.teacherUserId !== right.teacherUserId
      || left.matchType !== right.matchType
      || Number(left.roomSlotId || 0) !== Number(right.roomSlotId || 0)
      || Number(left.matchingScore || 0) !== Number(right.matchingScore || 0)
      || String(left.notes || '') !== String(right.notes || '')
      || String(left.adminComment || '') !== String(right.adminComment || '')
    ) {
      changed.push({
        studentUserId,
        studentNumber: right.studentNumber || left.studentNumber,
        studentName: right.studentName || left.studentName,
        from: left,
        to: right
      });
    }
  }

  return {
    fromVersion,
    toVersion,
    added,
    removed,
    changed
  };
}

export function exportVersionCsv(termId, versionId = null) {
  const term = getTerm(termId);
  const version = versionId ? getVersion(termId, versionId) : getCurrentVersion(termId);
  if (!version) {
    throw new HttpError(404, 'No class matching version available for export');
  }

  const matches = loadVersionMatches(version.id);
  const lines = [];
  lines.push(
    ['匹配 term', term.name, '版本', `v${version.versionNumber}`, '生成时间', version.createdAt]
      .map(escapeCsv)
      .join(',')
  );
  lines.push(
    ['学生学号', '学生姓名', '教师学号', '教师姓名', '琴房', '星期', '时间', '匹配类型', '匹配分数', '状态', '备注', '管理员说明']
      .map(escapeCsv)
      .join(',')
  );
  for (const item of matches) {
    lines.push(
      [
        item.studentNumber,
        item.studentName,
        item.teacherNumber,
        item.teacherName,
        item.roomNo || '',
        item.dayOfWeek ?? '',
        item.hour === null || item.hour === undefined ? '' : `${item.hour}:00`,
        item.matchType,
        item.matchingScore,
        item.status,
        item.notes || '',
        item.adminComment || ''
      ]
        .map(escapeCsv)
        .join(',')
    );
  }

  return {
    version,
    fileName: `linquan_class_matching_${term.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_v${version.versionNumber}.csv`,
    csv: `\uFEFF${lines.join('\n')}`
  };
}
