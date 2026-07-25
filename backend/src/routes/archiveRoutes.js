import express from 'express';
import { z } from 'zod';
import { authenticate, requireAdmin, requireMaintainer } from '../middleware/auth.js';
import {
  listArchivedRecords,
  listArchiveHistory,
  permanentlyDeleteArchivedRecord,
  requestPermanentDeletion,
  restoreArchivedRecord
} from '../services/archiveService.js';

const router = express.Router();
const reasonSchema = z.object({ reason: z.string().trim().min(1).max(500) });
const confirmationSchema = z.object({ confirmation: z.string().min(1).max(300) });

function listRecords(req, res) {
  res.json({ items: listArchivedRecords(req.query) });
}

function listHistory(req, res) {
  res.json({ items: listArchiveHistory({
    ...req.query,
    archiveId: req.query.archiveId ? Number(req.query.archiveId) : null
  }) });
}

router.get('/admin/archive', authenticate, requireAdmin, listRecords);
router.get('/admin/archive/history', authenticate, requireAdmin, listHistory);
router.post('/admin/archive/:archiveId(\\d+)/restore', authenticate, requireAdmin, (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim() || null;
    res.json(restoreArchivedRecord({ archiveId: Number(req.params.archiveId), actor: req.user, reason }));
  } catch (err) { next(err); }
});
router.post('/admin/archive/:archiveId(\\d+)/deletion-request', authenticate, requireAdmin, (req, res, next) => {
  try {
    const input = reasonSchema.parse(req.body);
    res.json(requestPermanentDeletion({ archiveId: Number(req.params.archiveId), actor: req.user, reason: input.reason }));
  } catch (err) { next(err); }
});

router.get('/maintainer/archive', authenticate, requireMaintainer, listRecords);
router.get('/maintainer/archive/history', authenticate, requireMaintainer, listHistory);
router.post('/maintainer/archive/:archiveId(\\d+)/permanent-delete', authenticate, requireMaintainer, (req, res, next) => {
  try {
    const input = confirmationSchema.parse(req.body);
    res.json(permanentlyDeleteArchivedRecord({
      archiveId: Number(req.params.archiveId), actor: req.user, confirmation: input.confirmation
    }));
  } catch (err) { next(err); }
});

export default router;
