const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

const legacyAssignHelper = [
  'var legacyAssign = function legacyAssign (target, source) {',
  "  if (source === null || typeof source !== 'object') return target",
  '',
  '  var keys = Object.keys(source)',
  '  var i = keys.length',
  '  while (i--) {',
  '    target[keys[i]] = source[keys[i]]',
  '  }',
  '  return target',
  '}'
].join('\n');

const patches = [
  {
    relativePath: 'node_modules/spdy-transport/lib/spdy-transport/utils.js',
    match: /Object\.assign = \(process\.versions\.modules >= 46 \|\| !isNode\)\s*\n\s*\? Object\.assign \/\/ eslint-disable-next-line\s*\n\s*: util\._extend/,
    replace:
      `${legacyAssignHelper}\n\n// Node.js 0.8, 0.10 and 0.12 support\nObject.assign = (process.versions.modules >= 46 || !isNode)\n  ? Object.assign // eslint-disable-next-line\n  : legacyAssign`
  },
  {
    relativePath: 'node_modules/spdy/lib/spdy/server.js',
    match: /Object\.assign = process\.versions\.modules >= 46\s*\n\s*\? Object\.assign \/\/ eslint-disable-next-line\s*\n\s*: util\._extend/,
    replace:
      `${legacyAssignHelper}\n\n// Node.js 0.8, 0.10 and 0.12 support\nObject.assign = process.versions.modules >= 46\n  ? Object.assign // eslint-disable-next-line\n  : legacyAssign`
  },
  {
    relativePath: 'node_modules/spdy/lib/spdy/agent.js',
    match: /Object\.assign = process\.versions\.modules >= 46\s*\n\s*\? Object\.assign \/\/ eslint-disable-next-line\s*\n\s*: util\._extend/,
    replace:
      `${legacyAssignHelper}\n\n// Node.js 0.8, 0.10 and 0.12 support\nObject.assign = process.versions.modules >= 46\n  ? Object.assign // eslint-disable-next-line\n  : legacyAssign`
  },
  {
    relativePath: 'node_modules/spdy/test/client-test.js',
    match: /Object\.assign = process\.versions\.modules >= 46\s*\n\s*\? Object\.assign \/\/ eslint-disable-next-line\s*\n\s*: util\._extend/,
    replace:
      `${legacyAssignHelper}\n\nObject.assign = process.versions.modules >= 46\n  ? Object.assign // eslint-disable-next-line\n  : legacyAssign`
  }
];

let modifiedCount = 0;

for (const patch of patches) {
  const targetPath = path.join(root, patch.relativePath);
  if (!fs.existsSync(targetPath)) {
    continue;
  }

  const original = fs.readFileSync(targetPath, 'utf8');
  if (original.includes('legacyAssign')) {
    continue;
  }

  const next = original.replace(patch.match, patch.replace);
  if (next !== original) {
    fs.writeFileSync(targetPath, next, 'utf8');
    modifiedCount += 1;
  }
}

if (modifiedCount > 0) {
  process.stdout.write(`patched deprecated util._extend usage in ${modifiedCount} file(s)\n`);
}
