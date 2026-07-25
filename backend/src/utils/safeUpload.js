import fs from 'fs';
import path from 'path';
import HttpError from './httpError.js';

const rasterTypes = new Map([
  ['ffd8ff', { mimeType: 'image/jpeg', extensions: new Set(['.jpg', '.jpeg']) }],
  ['89504e470d0a1a0a', { mimeType: 'image/png', extensions: new Set(['.png']) }],
  ['474946383761', { mimeType: 'image/gif', extensions: new Set(['.gif']) }],
  ['474946383961', { mimeType: 'image/gif', extensions: new Set(['.gif']) }]
]);

function detectRasterType(buffer) {
  const hex = buffer.toString('hex');
  for (const [signature, result] of rasterTypes) {
    if (hex.startsWith(signature)) return result;
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { mimeType: 'image/webp', extensions: new Set(['.webp']) };
  }
  return null;
}

function readFileEdges(filePath, edgeSize = 4096) {
  const size = fs.statSync(filePath).size;
  const handle = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(Math.min(edgeSize, size));
    const tail = Buffer.alloc(Math.min(edgeSize, size));
    fs.readSync(handle, head, 0, head.length, 0);
    fs.readSync(handle, tail, 0, tail.length, Math.max(0, size - tail.length));
    return { size, head, tail };
  } finally {
    fs.closeSync(handle);
  }
}

function hasValidPngStructure(filePath) {
  const buffer = fs.readFileSync(filePath);
  let offset = 8;
  let sawIdat = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > buffer.length) return false;
    if (offset === 8 && (type !== 'IHDR' || length !== 13 || buffer.readUInt32BE(offset + 8) === 0 || buffer.readUInt32BE(offset + 12) === 0)) return false;
    if (type === 'IDAT' && length > 0) sawIdat = true;
    if (type === 'IEND') return length === 0 && sawIdat && chunkEnd === buffer.length;
    offset = chunkEnd;
  }
  return false;
}

function hasValidRasterStructure(detected, edges, filePath) {
  const { size, head, tail } = edges;
  if (detected.mimeType === 'image/jpeg') {
    const endMarker = tail.lastIndexOf(Buffer.from([0xff, 0xd9]));
    if (size < 4 || endMarker < 0 || tail.length - endMarker - 2 > 32) return false;
    const trailing = tail.subarray(endMarker + 2).toString('utf8');
    return !/<(?:!doctype\s+html|html|script|svg)(?:\s|>)/i.test(trailing);
  }
  if (detected.mimeType === 'image/png') {
    return size >= 57 && hasValidPngStructure(filePath);
  }
  if (detected.mimeType === 'image/gif') {
    return size >= 14
      && head.readUInt16LE(6) > 0
      && head.readUInt16LE(8) > 0
      && tail[tail.length - 1] === 0x3b;
  }
  if (detected.mimeType === 'image/webp') {
    const chunkType = head.toString('ascii', 12, 16);
    return size >= 20
      && head.readUInt32LE(4) + 8 === size
      && ['VP8 ', 'VP8L', 'VP8X'].includes(chunkType);
  }
  return false;
}

function assertStoredRasterImage(file) {
  if (!file?.path) throw new HttpError(400, 'Image file is required');
  const edges = readFileEdges(file.path);
  const detected = detectRasterType(edges.head.subarray(0, 16));
  const extension = path.extname(String(file.originalname || '')).toLowerCase();
  if (!detected || !detected.extensions.has(extension) || !hasValidRasterStructure(detected, edges, file.path)) {
    throw new HttpError(400, 'Unsupported or mismatched image file type');
  }
  file.mimetype = detected.mimeType;
  return detected;
}

function assertStoredAllowedAttachment(file, { allowZip = true } = {}) {
  if (!file?.path) throw new HttpError(400, 'Attachment file is required');
  const extension = path.extname(String(file.originalname || '')).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(extension)) {
    return assertStoredRasterImage(file);
  }

  const { head, tail } = readFileEdges(file.path);
  const headHex = head.subarray(0, 8).toString('hex');
  if (extension === '.pdf') {
    if (!head.subarray(0, 5).equals(Buffer.from('%PDF-')) || !tail.includes(Buffer.from('%%EOF'))) {
      throw new HttpError(400, 'Unsupported or mismatched PDF file type');
    }
    file.mimetype = 'application/pdf';
    return { mimeType: file.mimetype };
  }
  if (['.docx', '.xlsx', '.pptx', '.zip'].includes(extension)) {
    if (extension === '.zip' && !allowZip) throw new HttpError(400, 'ZIP attachments are not allowed here');
    const hasZipHeader = ['504b0304', '504b0506', '504b0708'].includes(headHex.slice(0, 8));
    if (!hasZipHeader || !tail.includes(Buffer.from('PK\u0005\u0006', 'binary'))) {
      throw new HttpError(400, 'Unsupported or malformed archive attachment');
    }
    return { mimeType: file.mimetype };
  }
  if (['.doc', '.xls', '.ppt'].includes(extension)) {
    if (headHex !== 'd0cf11e0a1b11ae1') throw new HttpError(400, 'Unsupported or mismatched document file type');
    return { mimeType: file.mimetype };
  }
  if (['.txt', '.md', '.csv'].includes(extension)) {
    const sample = head.toString('utf8').replace(/^\uFEFF/, '');
    if (head.includes(0) || /<(?:!doctype\s+html|html|script|svg)(?:\s|>)/i.test(sample)) {
      throw new HttpError(400, 'HTML, SVG, script, or binary content is not allowed as a text attachment');
    }
    return { mimeType: file.mimetype };
  }
  throw new HttpError(400, 'Unsupported attachment file type');
}

function cleanupRejectedUpload(file) {
  if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
}

export { assertStoredAllowedAttachment, assertStoredRasterImage, cleanupRejectedUpload };
