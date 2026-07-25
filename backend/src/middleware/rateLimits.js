import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

const isTest = process.env.NODE_ENV === 'test';

function createLimiter(max, message) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: isTest ? 10_000 : max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message }
  });
}

function createUploadLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: isTest ? 10_000 : 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => `upload:${req.user?.id || 'anonymous'}:${ipKeyGenerator(req.ip)}`,
    message: { message: 'Too many uploads; please try again later' }
  });
}

const apiLimiter = createLimiter(600, 'Too many requests; please try again later');
const memberLoginLimiter = createLimiter(20, 'Too many login attempts; please try again later');
const registrationLimiter = createLimiter(10, 'Too many registration attempts; please try again later');
const maintainerLoginLimiter = createLimiter(8, 'Too many Maintainer login attempts; please try again later');
const uploadLimiter = createUploadLimiter();

export { apiLimiter, memberLoginLimiter, registrationLimiter, maintainerLoginLimiter, uploadLimiter };
