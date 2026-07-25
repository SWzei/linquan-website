import express from 'express';
import { z } from 'zod';
import db from '../config/db.js';
import { authenticate, requireMember } from '../middleware/auth.js';
import { resolveSemesterId } from '../utils/semester.js';
import HttpError from '../utils/httpError.js';

const router = express.Router();

const preferenceSchema = z.object({
  semesterId: z.number().int().positive().optional(),
  slotIds: z.array(z.number().int().positive()).max(500),
  classMatchingPriority: z.boolean().optional()
});

router.use('/scheduling', authenticate, requireMember);

router.get('/scheduling/semesters', (req, res, next) => {
  try {
    const rows = db
      .prepare(
        `SELECT
           id,
           name,
           start_date AS "startDate",
           end_date AS "endDate",
           is_active AS "isActive",
           created_at AS "createdAt"
         FROM semesters semester
         WHERE NOT EXISTS (SELECT 1 FROM archive_records ar
           WHERE ar.module = 'scheduling' AND ar.record_type = 'semester'
             AND ar.record_id = semester.id AND ar.status IN ('archived', 'deletion_requested'))
         ORDER BY is_active DESC, start_date DESC, id DESC`
      )
      .all()
      .map((item) => ({
        ...item,
        isActive: Boolean(item.isActive)
      }));

    res.json({
      items: rows,
      currentSemesterId: rows.find((item) => item.isActive)?.id || null
    });
  } catch (err) {
    next(err);
  }
});

router.get('/scheduling/slots', (req, res, next) => {
  try {
    const semesterId = resolveSemesterId(db, req.query.semesterId);

    const rows = db
      .prepare(
        `SELECT
           rs.id,
           rs.room_no AS "roomNo",
           rs.day_of_week AS "dayOfWeek",
           rs.hour,
           COALESCE(pref_counts.count, 0) AS "selectedCount",
           CASE WHEN my_pref.id IS NULL THEN 0 ELSE 1 END AS "selectedByMe",
           COALESCE(settings.class_matching_priority, 0) AS "classMatchingPriority"
         FROM room_slots rs
         LEFT JOIN (
           SELECT slot_id, COUNT(*) AS count
           FROM slot_preferences
           WHERE semester_id = ?
           GROUP BY slot_id
         ) pref_counts ON pref_counts.slot_id = rs.id
         LEFT JOIN slot_preferences my_pref
           ON my_pref.slot_id = rs.id
          AND my_pref.user_id = ?
          AND my_pref.semester_id = ?
         LEFT JOIN schedule_user_settings settings
           ON settings.user_id = ?
          AND settings.semester_id = ?
         WHERE rs.semester_id = ?
         ORDER BY rs.day_of_week, rs.hour, rs.room_no`
      )
      .all(semesterId, req.user.id, semesterId, req.user.id, semesterId, semesterId);

    res.json({
      semesterId,
      classMatchingPriority: Boolean(Number(rows[0]?.classMatchingPriority || 0)),
      items: rows.map((item) => ({
        ...item,
        classMatchingPriority: undefined
      }))
    });
  } catch (err) {
    next(err);
  }
});

router.post('/scheduling/preferences', (req, res, next) => {
  try {
    const parsed = preferenceSchema.parse({
      semesterId: req.body.semesterId ? Number(req.body.semesterId) : undefined,
      slotIds: Array.isArray(req.body.slotIds) ? req.body.slotIds.map((id) => Number(id)) : [],
      classMatchingPriority:
        req.body.classMatchingPriority === undefined
          ? undefined
          : req.body.classMatchingPriority === true
            || req.body.classMatchingPriority === 'true'
            || req.body.classMatchingPriority === 1
            || req.body.classMatchingPriority === '1'
    });

    const semesterId = resolveSemesterId(db, parsed.semesterId);
    const uniqueSlotIds = [...new Set(parsed.slotIds)];

    if (uniqueSlotIds.length > 0) {
      const placeholders = uniqueSlotIds.map(() => '?').join(', ');
      const validRows = db
        .prepare(
          `SELECT id FROM room_slots
           WHERE semester_id = ? AND id IN (${placeholders})`
        )
        .all(semesterId, ...uniqueSlotIds);
      if (validRows.length !== uniqueSlotIds.length) {
        throw new HttpError(400, 'One or more slotIds do not belong to the selected semester');
      }
    }

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM slot_preferences WHERE semester_id = ? AND user_id = ?').run(
        semesterId,
        req.user.id
      );

      const insertStmt = db.prepare(
        `INSERT INTO slot_preferences (semester_id, user_id, slot_id)
         VALUES (?, ?, ?)`
      );
      for (const slotId of uniqueSlotIds) {
        insertStmt.run(semesterId, req.user.id, slotId);
      }

      if (parsed.classMatchingPriority !== undefined) {
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO schedule_user_settings (semester_id, user_id, class_matching_priority, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (semester_id, user_id)
           DO UPDATE SET class_matching_priority = excluded.class_matching_priority, updated_at = excluded.updated_at`
        ).run(semesterId, req.user.id, parsed.classMatchingPriority ? 1 : 0, now, now);
      }
    });
    tx();

    res.json({
      message: 'Preference submission saved',
      semesterId,
      selectedCount: uniqueSlotIds.length
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid scheduling payload', details: err.issues });
    }
    return next(err);
  }
});

router.get('/scheduling/my-assignment', (req, res, next) => {
  try {
    const semesterId = resolveSemesterId(db, req.query.semesterId);

    const batch = db
      .prepare(
        `SELECT id, status, created_at AS createdAt, published_at AS publishedAt
         FROM schedule_batches
         WHERE semester_id = ? AND status = 'published'
         ORDER BY COALESCE(published_at, created_at) DESC, id DESC
         LIMIT 1`
      )
      .get(semesterId);

    if (!batch) {
      return res.json({
        semesterId,
        hasPublishedSchedule: false,
        assignments: []
      });
    }

    const assignments = db
      .prepare(
        `SELECT
           sa.id,
           rs.room_no AS "roomNo",
           rs.day_of_week AS "dayOfWeek",
           rs.hour
         FROM schedule_assignments sa
         JOIN room_slots rs ON rs.id = sa.slot_id
         WHERE sa.batch_id = ? AND sa.user_id = ?
         ORDER BY rs.day_of_week, rs.hour, rs.room_no`
      )
      .all(batch.id, req.user.id);

    return res.json({
      semesterId,
      hasPublishedSchedule: true,
      batch,
      totalHours: assignments.length,
      assignments
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
