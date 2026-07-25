const DEFAULT_REVOKE_DELAY_MS = 60_000;

export function normalizeAuthenticatedFileUrl(client, url) {
  const requestedUrl = String(url || '').trim();
  const baseUrl = String(client?.defaults?.baseURL || '').trim().replace(/\/+$/, '');
  if (
    baseUrl.startsWith('/')
    && (requestedUrl === baseUrl || requestedUrl.startsWith(`${baseUrl}/`))
  ) {
    return requestedUrl.slice(baseUrl.length) || '/';
  }
  return requestedUrl;
}

export async function fetchAuthenticatedBlob(client, url) {
  if (!client || typeof client.get !== 'function') throw new TypeError('Authenticated HTTP client is required');
  if (!url) throw new TypeError('Protected file URL is required');
  const response = await client.get(normalizeAuthenticatedFileUrl(client, url), { responseType: 'blob' });
  return response.data;
}

export async function openAuthenticatedFile(
  client,
  url,
  {
    windowRef = window,
    urlApi = URL,
    revokeDelayMs = DEFAULT_REVOKE_DELAY_MS
  } = {}
) {
  const blob = await fetchAuthenticatedBlob(client, url);
  const objectUrl = urlApi.createObjectURL(blob);
  const opened = windowRef.open(objectUrl, '_blank', 'noopener');
  if (!opened) {
    urlApi.revokeObjectURL(objectUrl);
    throw new Error('Browser blocked the protected file window');
  }
  windowRef.setTimeout(() => urlApi.revokeObjectURL(objectUrl), revokeDelayMs);
  return objectUrl;
}

export async function downloadAuthenticatedFile(
  client,
  url,
  fileName,
  {
    documentRef = document,
    windowRef = window,
    urlApi = URL
  } = {}
) {
  const blob = await fetchAuthenticatedBlob(client, url);
  const objectUrl = urlApi.createObjectURL(blob);
  const link = documentRef.createElement('a');
  link.href = objectUrl;
  link.download = fileName || 'download';
  link.rel = 'noopener';
  documentRef.body.appendChild(link);
  link.click();
  link.remove();
  windowRef.setTimeout(() => urlApi.revokeObjectURL(objectUrl), 0);
  return objectUrl;
}

export function createAuthenticatedObjectUrlStore(client, { urlApi = URL } = {}) {
  const objectUrls = new Map();

  function release(key) {
    const existing = objectUrls.get(key);
    if (existing) {
      urlApi.revokeObjectURL(existing);
      objectUrls.delete(key);
    }
  }

  return {
    async load(key, url) {
      const blob = await fetchAuthenticatedBlob(client, url);
      const objectUrl = urlApi.createObjectURL(blob);
      release(key);
      objectUrls.set(key, objectUrl);
      return objectUrl;
    },
    release,
    releaseAll() {
      for (const key of [...objectUrls.keys()]) release(key);
    },
    size() {
      return objectUrls.size;
    }
  };
}
