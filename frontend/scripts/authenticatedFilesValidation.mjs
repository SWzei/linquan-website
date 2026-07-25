import assert from 'node:assert/strict';
import {
  createAuthenticatedObjectUrlStore,
  downloadAuthenticatedFile,
  fetchAuthenticatedBlob,
  normalizeAuthenticatedFileUrl,
  openAuthenticatedFile
} from '../src/utils/authenticatedFiles.mjs';

assert.equal(
  normalizeAuthenticatedFileUrl({ defaults: { baseURL: '/api' } }, '/api/concerts/1/attachment'),
  '/concerts/1/attachment'
);
assert.equal(
  normalizeAuthenticatedFileUrl({ defaults: { baseURL: '/api/' } }, '/api/admin/gallery/1/media'),
  '/admin/gallery/1/media'
);
assert.equal(
  normalizeAuthenticatedFileUrl({ defaults: { baseURL: 'https://api.example.test' } }, '/api/file'),
  '/api/file'
);

const blob = new Blob(['protected']);
const calls = [];
const client = {
  async get(url, options) {
    calls.push({ url, options });
    return { data: blob };
  }
};
assert.equal(await fetchAuthenticatedBlob(client, '/protected'), blob);
assert.deepEqual(calls[0], { url: '/protected', options: { responseType: 'blob' } });

for (const status of [401, 403, 404, 500]) {
  const error = Object.assign(new Error(`HTTP ${status}`), { response: { status } });
  await assert.rejects(
    fetchAuthenticatedBlob({ get: async () => { throw error; } }, '/protected'),
    (received) => received === error
  );
}

const revoked = [];
let timerCallback = null;
const urlApi = {
  createObjectURL: () => 'blob:test',
  revokeObjectURL: (url) => revoked.push(url)
};
await openAuthenticatedFile(client, '/open', {
  urlApi,
  windowRef: {
    open: () => ({}),
    setTimeout: (callback) => { timerCallback = callback; }
  }
});
assert.equal(revoked.length, 0);
timerCallback();
assert.deepEqual(revoked, ['blob:test']);

await assert.rejects(
  openAuthenticatedFile(client, '/blocked', {
    urlApi,
    windowRef: { open: () => null, setTimeout: () => {} }
  }),
  /blocked/
);
assert.equal(revoked.at(-1), 'blob:test');

const clicked = [];
const appended = [];
let downloadTimer = null;
await downloadAuthenticatedFile(client, '/download', 'file.pdf', {
  urlApi,
  documentRef: {
    body: { appendChild: (link) => appended.push(link) },
    createElement: () => ({
      click() { clicked.push(this.download); },
      remove() {}
    })
  },
  windowRef: { setTimeout: (callback) => { downloadTimer = callback; } }
});
assert.equal(appended[0].download, 'file.pdf');
assert.deepEqual(clicked, ['file.pdf']);
downloadTimer();

let objectUrlCounter = 0;
const storeRevoked = [];
const store = createAuthenticatedObjectUrlStore(client, {
  urlApi: {
    createObjectURL: () => `blob:${++objectUrlCounter}`,
    revokeObjectURL: (url) => storeRevoked.push(url)
  }
});
assert.equal(await store.load('preview', '/one'), 'blob:1');
assert.equal(await store.load('preview', '/two'), 'blob:2');
assert.deepEqual(storeRevoked, ['blob:1']);
store.releaseAll();
assert.deepEqual(storeRevoked, ['blob:1', 'blob:2']);
assert.equal(store.size(), 0);

console.log('Authenticated file validation passed.');
