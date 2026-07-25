import path from 'path';

const mojibakeLeadPattern = /[ÃÂâåäæçðñø]/g;
const c1ControlPattern = /[\u0080-\u009F]/g;
const replacementCharPattern = /\uFFFD/g;

function countMatches(text, pattern) {
  return (String(text || '').match(pattern) || []).length;
}

function stripClientPath(rawName) {
  const normalized = String(rawName || '').replaceAll('\\', '/');
  return path.posix.basename(normalized);
}

function isSafeDecodedCandidate(candidate) {
  if (!candidate) {
    return false;
  }
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(candidate)
    && !candidate.includes('\uFFFD');
}

function scoreMojibakeRisk(text) {
  return (countMatches(text, c1ControlPattern) * 4)
    + (countMatches(text, mojibakeLeadPattern) * 2)
    + (countMatches(text, replacementCharPattern) * 4);
}

function decodeLatin1Utf8Candidate(value) {
  try {
    return Buffer.from(value, 'latin1').toString('utf8');
  } catch (err) {
    return value;
  }
}

function normalizeUploadedOriginalName(rawName) {
  const baseName = stripClientPath(rawName).normalize('NFC').trim();
  if (!baseName) {
    return 'file';
  }

  const candidate = decodeLatin1Utf8Candidate(baseName).normalize('NFC').trim();
  if (candidate === baseName || !isSafeDecodedCandidate(candidate)) {
    return baseName;
  }

  const originalRisk = scoreMojibakeRisk(baseName);
  const candidateRisk = scoreMojibakeRisk(candidate);
  const candidateHasWideUnicode = /[^\u0000-\u00FF]/.test(candidate);

  if ((originalRisk > 0 && candidateRisk < originalRisk) || (candidateHasWideUnicode && originalRisk > 0)) {
    return candidate;
  }

  return baseName;
}

function normalizeUploadedFileMeta(file) {
  if (!file || file.__linquanFilenameNormalized) {
    return file;
  }
  file.originalname = normalizeUploadedOriginalName(file.originalname);
  file.__linquanFilenameNormalized = true;
  return file;
}

export {
  normalizeUploadedFileMeta,
  normalizeUploadedOriginalName
};
