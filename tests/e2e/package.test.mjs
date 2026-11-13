// The released zip, unzipped the way Windows and macOS do it, must load in Chrome
// as-is: "Load unpacked" on the folder it creates has to find manifest.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildZip, UNZIPPED_FOLDER } from '../../scripts/release.mjs';
import { readZip } from '../../scripts/lib/zip.mjs';
import { chromium } from '../helpers.mjs';

test('the unzipped release folder loads in Chrome as an extension', async () => {
  // Unzip like Windows "Extract All" / macOS Archive Utility: into a folder named after the zip.
  const folder = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vhl-unzip-')), UNZIPPED_FOLDER);
  for (const { name, data } of readZip(buildZip())) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), data);
  }
  assert.ok(fs.existsSync(path.join(folder, 'manifest.json')), 'manifest.json is directly in the folder people pick');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vhl-profile-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${folder}`, `--load-extension=${folder}`],
  });
  try {
    const sw =
      ctx.serviceWorkers().find((w) => w.url().endsWith('/background.js')) ||
      (await ctx.waitForEvent('serviceworker', { predicate: (w) => w.url().endsWith('/background.js'), timeout: 10000 }));
    const name = await sw.evaluate(() => chrome.runtime.getManifest().name);
    assert.equal(name, 'VHL Text Overlay');
  } finally {
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
