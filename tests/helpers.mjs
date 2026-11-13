// Shared helpers for the browser tests: launch Chromium with the extension loaded and
// serve the test pages at https://reader.vhlcentral.com so the extension runs on them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const { chromium } = require('playwright');

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// VHL_EXT_DIR lets the mutation check run the tests against a deliberately broken copy.
export const EXT_DIR = process.env.VHL_EXT_DIR ? path.resolve(process.env.VHL_EXT_DIR) : path.join(ROOT, 'extension');
const FIX = path.join(ROOT, 'tests', 'fixtures');
export const READER = 'https://reader.vhlcentral.com';

const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const ROUTES = { '/book': 'reader.html', '/frame': 'frame.html', '/contrast': 'contrast.html' };

/**
 * Copy of the extension with extra host access, so captureVisibleTab (used for the
 * pixel-based contrast check) works without clicking the toolbar icon, which a test
 * can't do.
 */
export function extensionWithAllUrls() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhl-ext-'));
  fs.cpSync(EXT_DIR, dir, { recursive: true });
  const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  mf.host_permissions = [...mf.host_permissions, '<all_urls>'];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(mf));
  return dir;
}

/**
 * Start Chromium with the extension. Returns { ctx, sw, page, close }.
 * opts.tour: leave the first-run tour on (default off so it doesn't get in the way).
 */
export async function launch({ ext = EXT_DIR, tour = false, colorScheme = 'light', viewport = { width: 1100, height: 700 }, locale } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhl-profile-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    viewport,
    colorScheme,
    locale,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      '--auto-accept-this-tab-capture', // answer Chrome's "share this tab" prompt
    ],
  });
  await ctx.route(`${READER}/**`, (route) => {
    const file = ROUTES[new URL(route.request().url()).pathname];
    if (!file) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture(file) });
  });
  const sw =
    ctx.serviceWorkers().find((w) => w.url().endsWith('/background.js')) ||
    (await ctx.waitForEvent('serviceworker', (w) => w.url().endsWith('/background.js')));
  if (!tour) await sw.evaluate(() => chrome.storage.local.set({ tutorialPending: false }));
  for (const p of ctx.pages()) if (p.url().includes('welcome.html')) await p.close();
  const page = await ctx.newPage();
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: READER });
  const close = async () => {
    await ctx.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  };
  return { ctx, sw, page, close };
}

/** Same as clicking the extension's toolbar icon (tests can't click browser UI). */
export async function openToolbar(sw, patch = {}) {
  await sw.evaluate(async (patch) => {
    const [tab] = await chrome.tabs.query({ url: 'https://reader.vhlcentral.com/*' });
    const state = { open: true, typing: true, color: 'blue', size: 18, side: 'right', ...patch };
    await chrome.storage.session.set({ ['tab:' + tab.id]: state });
    chrome.tabs.sendMessage(tab.id, { type: 'state', state, patch: {} });
  }, patch);
}

export async function gotoReader(page, sw, { open = true, path: p = '/book', ...patch } = {}) {
  await page.goto(READER + p);
  if (open) {
    await openToolbar(sw, patch);
    await page.locator('vhl-text-overlay').locator('.toolbar:not(.hidden)').waitFor();
    await page.waitForTimeout(400); // let the toolbars glide in
  }
}

/** Locator inside the extension's shadow DOM. */
export const ui = (page, sel) => page.locator('vhl-text-overlay').locator(sel);

/** Text of every typed note in the page's top frame. */
export const noteTexts = (page) =>
  page.evaluate(() => [...(document.querySelector('vhl-text-overlay')?.shadowRoot.querySelectorAll('.note .text') || [])].map((t) => t.textContent));

/** Center of the n-th ".blank" span in a page or frame. */
export async function blank(target, n = 0) {
  const b = await target.locator('.blank').nth(n).boundingBox();
  return { x: b.x + 12, y: b.y + b.height / 2 - 2 };
}
