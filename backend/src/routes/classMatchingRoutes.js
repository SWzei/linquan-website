import express from 'express';
import { z } from 'zod';
import { authenticate, requireMember, requireRole } from '../middleware/auth.js';
import { resolveClassMatchingTermId } from '../utils/classMatching.js';
import db from '../config/db.js';
import {
  compareClassMatchingVersions,
  createClassMatchingTerm,
  exportClassMatchingCsv,
  generateClassMatchingVersion,
  getAdminClassMatchingOverview,
  getClassMatchingVersionDetail,
  getUserClassMatchingOverview,
  incrementalClassMatching,
  listClassMatchingTerms,
  manualAdjustClassMatching,
  restoreClassMatchingVersion,
  saveUserClassMatchingAvailability,
  saveUserClassMatchingProfile,
  saveUserClassMatchingRankings,
  updateClassMatchingTerm,
  updateTeacherQualification
} from '../services/classMatching/index.js';
import HttpError from '../utils/httpError.js';
import { archiveRecord } from '../services/archiveService.js';

const router = express.Router();

const isoDateSchema = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Invalid calendar date');

const termSchema = z.object({
  semesterId: z.number().int().positive(),
  name: z.string().trim().min(2).max(120),
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  activate: z.boolean().optional()
});

const termUpdateSchema = termSchema.partial();

const profileSchema = z.object({
  termId: z.number().int().positive().optional(),
  participantType: z.enum(['student', 'teacher']).optional(),
  matchingMode: z.enum(['direct', 'ranking']).optional(),
  skillLevel: z.string().trim().max(1000).optional().nullable(),
  learningGoals: z.string().trim().max(1000).optional().nullable(),
  budgetExpectation: z.string().trim().max(128).optional().nullable(),
  teachingExperience: z.string().trim().max(1000).optional().nullable(),
  skillSpecialization: z.string().trim().max(1000).optional().nullable(),
  feeExpectation: z.string().trim().max(128).optional().nullable(),
  capacity: z.number().int().positive().max(100).optional().nullable(),
  directTargetUserId: z.number().int().positive().optional().nullable()
});

const availabilitySchema = z.object({
  termId: z.number().int().positive().optional(),
  slotIds: z.array(z.number().int().positive()).max(200)
});

const rankingSchema = z.object({
  termId: z.number().int().positive().optional(),
  targetUserIds: z.array(z.number().int().positive()).max(200)
});

const qualificationSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']),
  feedback: z.string().trim().max(1000).optional().nullable()
});

const generateSchema = z.object({
  changeSummary: z.string().trim().max(300).optional(),
  termId: z.number().int().positive().optional()
});

const restoreSchema = z.object({
  changeSummary: z.string().trim().max(300).optional()
});

const manualSchema = z.object({
  studentUserId: z.number().int().positive(),
  teacherUserId: z.number().int().positive().optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
  changeSummary: z.string().trim().max(300).optional()
});

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return Number(value);
}

function sendCsv(res, fileName, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.status(200).send(csv);
}

router.use('/class-matching', authenticate, requireMember);

router.get('/class-matching/terms', (req, res, next) => {
  try {
    res.json(listClassMatchingTerms());
  } catch (err) {
    next(err);
  }
});

router.get('/class-matching/overview', (req, res, next) => {
  try {
    const termId = resolveClassMatchingTermId(db, req.query.termId);
    res.json(getUserClassMatchingOverview({ termId, userId: req.user.id }));
  } catch (err) {
    next(err);
  }
});

router.put('/class-matching/profile', (req, res, next) => {
  try {
    const parsed = profileSchema.parse({
      termId: optionalNumber(req.body.termId),
      participantType: req.body.participantType,
      matchingMode: req.body.matchingMode,
      skillLevel: req.body.skillLevel ?? undefined,
      learningGoals: req.body.learningGoals ?? undefined,
      budgetExpectation: req.body.budgetExpectation ?? undefined,
      teachingExperience: req.body.teachingExperience ?? undefined,
      skillSpecialization: req.body.skillSpecialization ?? undefined,
      feeExpectation: req.body.feeExpectation ?? undefined,
      capacity: optionalNumber(req.body.capacity),
      directTargetUserId: optionalNumber(req.body.directTargetUserId)
    });
    const termId = resolveClassMatchingTermId(db, parsed.termId);
    const profile = saveUserClassMatchingProfile({ termId, userId: req.user.id, input: parsed });
    res.json({ termId, profile });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid class matching profile payload', details: err.issues });
    }
    next(err);
  }
});

router.post('/class-matching/availability', (req, res, next) => {
  try {
    const parsed = availabilitySchema.parse({
      termId: optionalNumber(req.body.termId),
      slotIds: Array.isArray(req.body.slotIds) ? req.body.slotIds.map((item) => Number(item)) : []
    });
    const termId = resolveClassMatchingTermId(db, parsed.termId);
    res.json(saveUserClassMatchingAvailability({ termId, userId: req.user.id, slotIds: parsed.slotIds }));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid class matching availability payload', details: err.issues });
    }
    next(err);
  }
});

router.post('/class-matching/rankings', (req, res, next) => {
  try {
    const parsed = rankingSchema.parse({
      termId: optionalNumber(req.body.termId),
      targetUserIds: Array.isArray(req.body.targetUserIds) ? req.body.targetUserIds.map((item) => Number(item)) : []
    });
    const termId = resolveClassMatchingTermId(db, parsed.termId);
    res.json(saveUserClassMatchingRankings({ termId, userId: req.user.id, targetUserIds: parsed.targetUserIds }));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid class matching ranking payload', details: err.issues });
    }
    next(err);
  }
});

router.use('/admin/class-matching', authenticate, requireRole('admin'));

router.get('/admin/class-matching/terms', (req, res, next) => {
  try {
    res.json(listClassMatchingTerms());
  } catch (err) {
    next(err);
  }
});

router.post('/admin/class-matching/terms', (req, res, next) => {
  try {
    const parsed = termSchema.parse({
      ...req.body,
      semesterId: Number(req.body.semesterId),
      activate: req.body.activate === undefined ? true : req.body.activate
    });
    res.status(201).json(createClassMatchingTerm(parsed));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid class matching term payload', details: err.issues });
    }
    next(err);
  }
});

router.patch('/admin/class-matching/terms/:termId(\\d+)', (req, res, next) => {
  try {
    const parsed = termUpdateSchema.parse({
      name: req.body.name,
      semesterId: optionalNumber(req.body.semesterId),
      startDate: req.body.startDate,
      endDate: req.body.endDate,
      activate: req.body.activate
    });
    res.json(updateClassMatchingTerm({ termId: Number(req.params.termId), ...parsed }));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid class matching term update payload', details: err.issues });
    }
    next(err);
  }
});

router.delete('/admin/class-matching/terms/:termId(\\d+)', (req, res, next) => {
  try {
    res.json(archiveRecord({
      module: 'class_matching',
      recordType: 'term',
      recordId: Number(req.params.termId),
      actor: req.user,
      reason: String(req.body?.reason || '').trim() || null
    }));
  } catch (err) {
    next(err);
  }
});

router.get('/admin/class-matching/terms/:termId(\\d+)/overview', (req, res, next) => {
  try {
    res.json(getAdminClassMatchingOverview(Number(req.params.termId)));
  } catch (err) {
    next(err);
  }
});

router.patch('/admin/class-matching/terms/:termId(\\d+)/teachers/:teacherUserId(\\d+)/qualification', (req, res, next) => {
  try {
    const parsed = qualificationSchema.parse({
      status: req.body.status,
      feedback: req.body.feedback ?? undefined
    });
    res.json(
      updateTeacherQualification({
        termId: Number(req.params.termId),
        teacherUserId: Number(req.params.teacherUserId),
        status: parsed.status,
        feedback: parsed.feedback,
        adminId: req.user.id
      })
    );
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid teacher qualification payload', details: err.issues });
    }
    next(err);
  }
});

router.post('/admin/class-matching/terms/:termId(\\d+)/generate', (req, res, next) => {
  try {
    const parsed = generateSchema.parse({
      termId: Number(req.params.termId),
      changeSummary: req.body.changeSummary
    });
    res.status(201).json(generateClassMatchingVersion({ termId: parsed.termId, adminId: req.user.id, changeSummary: parsed.changeSummary }));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid class matching generate payload', details: err.issues });
    }
    next(err);
  }
});

router.post('/admin/class-matching/terms/:termId(\\d+)/incremental', (req, res, next) => {
  try {
    const parsed = generateSchema.parse({
      termId: Number(req.params.termId),
      changeSummary: req.body.changeSummary
    });
    res.status(201).json(incrementalClassMatching({ termId: parsed.termId, adminId: req.user.id, changeSummary: parsed.changeSummary }));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid class matching incremental payload', details: err.issues });
    }
    next(err);
  }
});

router.post('/admin/class-matching/terms/:termId(\\d+)/manual', (req, res, next) => {
  try {
    const parsed = manualSchema.parse({
      studentUserId: Number(req.body.studentUserId),
      teacherUserId: optionalNumber(req.body.teacherUserId),
      notes: req.body.notes ?? undefined,
      changeSummary: req.body.changeSummary
    });
    res.status(201).json(manualAdjustClassMatching({ termId: Number(req.params.termId), adminId: req.user.id, ...parsed }));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid class matching manual adjustment payload', details: err.issues });
    }
    next(err);
  }
});

router.get('/admin/class-matching/terms/:termId(\\d+)/versions', (req, res, next) => {
  try {
    res.json({
      items: getAdminClassMatchingOverview(Number(req.params.termId)).versions
    });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/class-matching/terms/:termId(\\d+)/versions/:versionId(\\d+)', (req, res, next) => {
  try {
    res.json(getClassMatchingVersionDetail({ termId: Number(req.params.termId), versionId: Number(req.params.versionId) }));
  } catch (err) {
    next(err);
  }
});

router.get('/admin/class-matching/terms/:termId(\\d+)/compare', (req, res, next) => {
  try {
    const fromVersionId = Number(req.query.fromVersionId);
    const toVersionId = Number(req.query.toVersionId);
    if (!Number.isInteger(fromVersionId) || !Number.isInteger(toVersionId)) {
      throw new HttpError(400, 'fromVersionId and toVersionId are required');
    }
    res.json(compareClassMatchingVersions({ termId: Number(req.params.termId), fromVersionId, toVersionId }));
  } catch (err) {
    next(err);
  }
});

router.post('/admin/class-matching/terms/:termId(\\d+)/versions/:versionId(\\d+)/restore', (req, res, next) => {
  try {
    const parsed = restoreSchema.parse({ changeSummary: req.body.changeSummary });
    res.status(201).json(
      restoreClassMatchingVersion({
        termId: Number(req.params.termId),
        versionId: Number(req.params.versionId),
        adminId: req.user.id,
        changeSummary: parsed.changeSummary
      })
    );
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid class matching restore payload', details: err.issues });
    }
    next(err);
  }
});

router.get('/admin/class-matching/terms/:termId(\\d+)/export', (req, res, next) => {
  try {
    const versionId = req.query.versionId ? Number(req.query.versionId) : null;
    const { fileName, csv } = exportClassMatchingCsv({ termId: Number(req.params.termId), versionId });
    sendCsv(res, fileName, csv);
  } catch (err) {
    next(err);
  }
});

export default router;
