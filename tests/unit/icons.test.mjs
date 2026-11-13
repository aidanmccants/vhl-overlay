// Icons come from Lucide (scripts/icons.mjs builds extension/icons.js). No emoji in the UI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAMES, build } from '../../scripts/icons.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const read = (f) => fs.readFileSync(path.join(ROOT_DIR, 'extension', f), 'utf8');

test('extension/icons.js is up to date with Lucide (run `npm run icons`)', () => {
  assert.equal(read('icons.js'), build());
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'extension', 'LICENSE-lucide.txt')), 'Lucide license is included');
});

test('every icon the extension asks for is in icons.js', () => {
  const used = new Set();
  for (const f of ['content.js', 'welcome.js', 'welcome.html']) {
    const src = read(f).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'); // skip comments
    for (const m of src.matchAll(/\{\{([\w-]+)\}\}/g)) used.add(m[1]);
    for (const m of src.matchAll(/\bic\('([\w-]+)'\)/g)) used.add(m[1]);
    for (const m of src.matchAll(/,\s*'([\w-]+)'\)(?=[,;\n])/g)) if (NAMES.includes(m[1])) used.add(m[1]);
    for (const m of src.matchAll(/\[\s*'([\w-]+)',\s*L\(/g)) used.add(m[1]);
  }
  const missing = [...used].filter((n) => !NAMES.includes(n));
  assert.deepEqual(missing, []);
  assert.ok(used.size >= 15, `found ${used.size} icons in use`);
});

test('no emoji in the on-screen interface', () => {
  const emoji = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}✥⇄⋮]/u;
  for (const f of ['content.js', 'welcome.js', 'welcome.html']) {
    read(f).split('\n').forEach((line, i) => {
      assert.ok(!emoji.test(line), `${f}:${i + 1} has an emoji: ${line.trim().slice(0, 80)}`);
    });
  }
});
