import { normalizeUploadedOriginalName } from './uploadFilename.js';
import { toUtcIsoString } from './dateTime.js';

function mapAttachmentRow(row) {
  const viewUrl = `/api/attachments/${Number(row.id)}/view`;
  const downloadUrl = `/api/attachments/${Number(row.id)}/download`;
  return {
    id: Number(row.id),
    originalName: normalizeUploadedOriginalName(row.originalName),
    fileName: normalizeUploadedOriginalName(row.originalName),
    filePath: viewUrl,
    url: viewUrl,
    viewUrl,
    downloadUrl,
    fileSize: Number(row.fileSize || 0),
    size: Number(row.fileSize || 0),
    mimeType: row.mimeType || '',
    createdAt: toUtcIsoString(row.createdAt, { naiveTimezone: 'utc' }),
    uploadedAt: toUtcIsoString(row.createdAt, { naiveTimezone: 'utc' })
  };
}

function loadContentAttachmentsByOwner(db, ownerType, ownerIds) {
  const normalizedOwnerIds = [...new Set(ownerIds.map((item) => Number(item)).filter((item) => item > 0))];
  const grouped = new Map(normalizedOwnerIds.map((item) => [item, []]));
  if (normalizedOwnerIds.length === 0) {
    return grouped;
  }

  const placeholders = normalizedOwnerIds.map(() => '?').join(', ');
  const rows = db
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
       WHERE owner_type = ? AND owner_id IN (${placeholders})
       ORDER BY created_at ASC, id ASC`
    )
    .all(ownerType, ...normalizedOwnerIds);

  for (const row of rows) {
    const ownerId = Number(row.ownerId);
    if (!grouped.has(ownerId)) {
      grouped.set(ownerId, []);
    }
    grouped.get(ownerId).push(mapAttachmentRow(row));
  }

  return grouped;
}

function attachContentAttachments(db, ownerType, items, { primaryField = 'attachmentPath' } = {}) {
  const ownerIds = items.map((item) => Number(item.id)).filter((item) => item > 0);
  const grouped = loadContentAttachmentsByOwner(db, ownerType, ownerIds);
  return items.map((item) => {
    const attachments = grouped.get(Number(item.id)) || [];
    return {
      ...item,
      attachments,
      [primaryField]: attachments[0]?.url || null
    };
  });
}

export {
  attachContentAttachments,
  loadContentAttachmentsByOwner,
  mapAttachmentRow
};
