// Checks for the release tool: extension validation, zip building and the
// release-notes generator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  validate, readManifest, listExtensionFiles, buildZip, pngSize, nextVersion,
  categorize, changesMarkdown, releaseNotes, EXT_DIR, ZIP_FOLDER, ALLOWED_PERMISSIONS,
} from '../../scripts/release.mjs';
import { createZip, readZip, crc32 } from '../../scripts/lib/zip.mjs';

test('the extension passes every release check', () => {
  assert.deepEqual(validate(), []);
});

test('manifest is Manifest V3 with a x.y.z version', () => {
  const m = readManifest();
  assert.equal(m.manifest_version, 3);
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
});

test('only asks for the expected permissions', () => {
  const m = readManifest();
  for (const p of m.permissions) assert.ok(ALLOWED_PERMISSIONS.includes(p), p);
  assert.deepEqual(m.host_permissions, ['*://*.vhlcentral.com/*']);
  assert.ok(!m.permissions.includes('downloads'), 'downloads permission is not needed');
});

test('icons exist at the sizes the manifest says', () => {
  for (const [size, rel] of Object.entries(readManifest().icons)) {
    const { width, height } = pngSize(path.join(EXT_DIR, rel));
    assert.equal(width, +size);
    assert.equal(height, +size);
  }
});

test('content script only runs on vhlcentral.com, in every frame, at document_start', () => {
  const [cs] = readManifest().content_scripts;
  assert.deepEqual(cs.matches, ['*://*.vhlcentral.com/*']);
  assert.equal(cs.all_frames, true);
  assert.equal(cs.run_at, 'document_start');
});

test('the zip has every extension file inside one "VHL Text Overlay" folder', () => {
  const files = readZip(buildZip());
  const expected = listExtensionFiles().map((f) => `${ZIP_FOLDER}/${f}`);
  assert.deepEqual(files.map((f) => f.name), expected);
  for (const f of files) {
    const original = fs.readFileSync(path.join(EXT_DIR, f.name.slice(ZIP_FOLDER.length + 1)));
    assert.ok(original.equals(f.data), `${f.name} matches`);
  }
});

test('building twice gives the same zip (reproducible)', () => {
  assert.ok(buildZip().equals(buildZip()));
});

test('zip writer round-trips text, binary and empty files', () => {
  const entries = [
    { name: 'a.txt', data: Buffer.from('hello '.repeat(100)) },
    { name: 'dir/b.bin', data: Buffer.from([0, 1, 2, 255, 254]) },
    { name: 'empty.txt', data: Buffer.alloc(0) },
    { name: 'ñ/ü.txt', data: Buffer.from('español') },
  ];
  const back = readZip(createZip(entries));
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  back.forEach((e, i) => assert.ok(e.data.equals(entries[i].data)));
});

test('crc32 matches known values', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('version bumps', () => {
  assert.equal(nextVersion('0.1.0', 'patch'), '0.1.1');
  assert.equal(nextVersion('0.1.9', 'minor'), '0.2.0');
  assert.equal(nextVersion('0.9.3', 'major'), '1.0.0');
  assert.equal(nextVersion('0.1.0', '2.3.4'), '2.3.4');
  assert.throws(() => nextVersion('0.1.0', 'huge'));
});

test('release notes group commits by kind', () => {
  assert.equal(categorize('Add a dark mode'), '✨ New');
  assert.equal(categorize('Fix toolbar overlapping the page'), '🐛 Fixes');
  assert.equal(categorize('Switch the color scheme to red'), '🎨 Look and feel');
  assert.equal(categorize('Rewrite README in plain language'), '📝 Docs');
  assert.equal(categorize('Add release script and tests'), '✨ New');
  assert.equal(categorize('Update CI workflow'), '🔧 Maintenance');
  assert.equal(categorize('Make text boxes snappier'), '💅 Improvements');
  const md = changesMarkdown(
    [
      { subject: 'Fix a crash', hash: 'abc1234' },
      { subject: 'Add stickers', hash: 'def5678' },
    ],
    { links: false }
  );
  assert.match(md, /### ✨ New\n\n- Add stickers/);
  assert.match(md, /### 🐛 Fixes\n\n- Fix a crash/);
  assert.ok(md.indexOf('New') < md.indexOf('Fixes'), 'new features come first');
});

test('release notes include version, install steps in both languages and checksum', () => {
  const md = releaseNotes({ from: 'HEAD', sha256: 'f00d' });
  assert.match(md, new RegExp(`# VHL Text Overlay ${readManifest().version.replace(/\./g, '\\.')}`));
  assert.match(md, /Download \*\*VHL-Text-Overlay\.zip\*\*/);
  assert.match(md, /Descargue/);
  assert.match(md, /SHA-256 .*f00d/);
});
