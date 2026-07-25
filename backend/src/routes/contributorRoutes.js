import express from 'express';
import { z } from 'zod';
import db from '../config/db.js';
import { authenticate, requireMaintainer } from '../middleware/auth.js';
import HttpError from '../utils/httpError.js';

const router = express.Router();

const contributorNameSchema = z.string().trim().min(1).max(80).refine(
  (value) => !/[\u0000-\u001f\u007f]/u.test(value),
  'Contributor name contains unsupported control characters'
);

const githubProfileSchema = z.string().trim().min(1).max(200).transform((value, context) => {
  try {
    const parsed = new URL(value);
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const username = pathParts[0] || '';
    const isProfile = parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === 'github.com'
      && pathParts.length === 1
      && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(username)
      && !parsed.search
      && !parsed.hash;
    if (!isProfile) {
      throw new Error('not a canonical GitHub profile URL');
    }
    return `https://github.com/${username.toLowerCase()}`;
  } catch (err) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'GitHub URL must be an HTTPS profile URL such as https://github.com/example'
    });
    return z.NEVER;
  }
});

const createContributorSchema = z.object({
  name: contributorNameSchema,
  githubUrl: githubProfileSchema
}).strict();

const updateContributorSchema = z.object({
  name: contributorNameSchema.optional(),
  githubUrl: githubProfileSchema.optional()
}).strict().refine((value) => value.name !== undefined || value.githubUrl !== undefined, {
  message: 'At least one contributor field is required'
});

const orderSchema = z.object({
  ids: z.array(z.number().int().positive()).max(500)
}).strict().refine((value) => new Set(value.ids).size === value.ids.length, {
  message: 'Contributor order cannot contain duplicate IDs'
});

function parse(schema, body, message) {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(400, message, result.error.issues);
  }
  return result.data;
}

function listContributorRecords() {
  return db.prepare(`SELECT id, name, github_url AS "githubUrl", display_order AS "displayOrder",
      created_at AS "createdAt", updated_at AS "updatedAt"
    FROM contributors
    ORDER BY display_order ASC, id ASC`).all();
}

function requireContributor(id) {
  const contributor = db.prepare(`SELECT id, name, github_url AS "githubUrl", display_order AS "displayOrder",
      created_at AS "createdAt", updated_at AS "updatedAt"
    FROM contributors WHERE id = ?`).get(id);
  if (!contributor) throw new HttpError(404, 'Contributor not found');
  return contributor;
}

function assertGitHubUrlAvailable(githubUrl, excludedId = null) {
  const existing = excludedId === null
    ? db.prepare('SELECT id FROM contributors WHERE github_url = ?').get(githubUrl)
    : db.prepare('SELECT id FROM contributors WHERE github_url = ? AND id <> ?').get(githubUrl, excludedId);
  if (existing) throw new HttpError(409, 'A contributor with this GitHub profile already exists');
}

router.get('/contributors', (req, res) => {
  const items = db.prepare(`SELECT name, github_url AS "githubUrl"
    FROM contributors ORDER BY display_order ASC, id ASC`).all();
  res.json({ items });
});

router.use('/maintainer/contributors', authenticate, requireMaintainer);

router.get('/maintainer/contributors', (req, res) => {
  res.json({ items: listContributorRecords() });
});

router.post('/maintainer/contributors', (req, res, next) => {
  try {
    const input = parse(createContributorSchema, req.body, 'Invalid contributor payload');
    assertGitHubUrlAvailable(input.githubUrl);
    const nextOrder = Number(db.prepare('SELECT COALESCE(MAX(display_order), -1) + 1 AS value FROM contributors').get()?.value || 0);
    const result = db.prepare(`INSERT INTO contributors (name, github_url, display_order)
      VALUES (?, ?, ?)`).run(input.name, input.githubUrl, nextOrder);
    res.status(201).json(requireContributor(Number(result.lastInsertRowid)));
  } catch (err) {
    next(err);
  }
});

router.patch('/maintainer/contributors/:contributorId(\\d+)', (req, res, next) => {
  try {
    const contributorId = Number(req.params.contributorId);
    const current = requireContributor(contributorId);
    const input = parse(updateContributorSchema, req.body, 'Invalid contributor payload');
    const githubUrl = input.githubUrl ?? current.githubUrl;
    assertGitHubUrlAvailable(githubUrl, contributorId);
    db.prepare(`UPDATE contributors
      SET name = ?, github_url = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).run(input.name ?? current.name, githubUrl, contributorId);
    res.json(requireContributor(contributorId));
  } catch (err) {
    next(err);
  }
});

router.put('/maintainer/contributors/order', (req, res, next) => {
  try {
    const input = parse(orderSchema, req.body, 'Invalid contributor order payload');
    const currentIds = listContributorRecords().map((item) => Number(item.id));
    const receivedIds = input.ids.map(Number);
    const sortedCurrentIds = [...currentIds].sort((a, b) => a - b);
    const sortedReceivedIds = [...receivedIds].sort((a, b) => a - b);
    const sameSet = currentIds.length === receivedIds.length
      && sortedCurrentIds.every((id, index) => id === sortedReceivedIds[index]);
    if (!sameSet) throw new HttpError(400, 'Contributor order must include every current contributor exactly once');

    const updateOrder = db.prepare(`UPDATE contributors
      SET display_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
    db.transaction(() => {
      receivedIds.forEach((id, index) => updateOrder.run(index, id));
    })();
    res.json({ items: listContributorRecords() });
  } catch (err) {
    next(err);
  }
});

router.delete('/maintainer/contributors/:contributorId(\\d+)', (req, res, next) => {
  try {
    const contributorId = Number(req.params.contributorId);
    requireContributor(contributorId);
    db.prepare('DELETE FROM contributors WHERE id = ?').run(contributorId);
    res.json({ message: 'Contributor removed' });
  } catch (err) {
    next(err);
  }
});

export default router;
