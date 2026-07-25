export const IMAGE_FILE_LIMIT_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_FILE_LIMIT_BYTES = 20 * 1024 * 1024;
export const UPLOAD_REQUEST_LIMIT_BYTES = 64 * 1024 * 1024;

export function validateSelectedFiles(
  files,
  {
    maxFileBytes = ATTACHMENT_FILE_LIMIT_BYTES,
    maxTotalBytes = UPLOAD_REQUEST_LIMIT_BYTES,
    maxFiles = 8
  } = {}
) {
  const selected = Array.from(files || []);
  if (selected.length > maxFiles) return `Select no more than ${maxFiles} files`;
  const oversized = selected.find((file) => Number(file?.size || 0) > maxFileBytes);
  if (oversized) {
    return `${oversized.name || 'File'} exceeds the ${(maxFileBytes / 1024 / 1024).toFixed(0)} MB file limit`;
  }
  const totalBytes = selected.reduce((sum, file) => sum + Number(file?.size || 0), 0);
  if (totalBytes > maxTotalBytes) {
    return `Combined upload size exceeds ${(maxTotalBytes / 1024 / 1024).toFixed(0)} MB`;
  }
  return '';
}
