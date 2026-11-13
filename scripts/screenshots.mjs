#!/usr/bin/env node
// Regenerates the README screenshots in docs/images (English and Spanish Chrome).
//   npm run screenshots          both languages
//   npm run screenshots -- en    one language
// Uses a sample practice page (no VHL account needed) served at reader.vhlcentral.com
// inside the test browser, and Chrome's own Extensions page for the install steps.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'images');
// Load from a folder named like the released one, so the Extensions page looks the same.
const ext = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vhl-shots-')), 'VHL Text Overlay');
fs.cpSync(path.join(ROOT, 'extension'), ext, { recursive: true });
async function run(lang) {
const L = (en, es) => (lang === 'es' ? es : en);

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Lección 3</title></head>
<body style="margin:0;font:17px Georgia,serif;background:#e5e7eb">
<div style="position:fixed;inset:0 0 auto 0;height:44px;background:#374151;color:#fff;font:15px Arial;display:flex;align-items:center;padding:0 16px">◀ ▶ &nbsp; Lección 3 · Página 92</div>
<div id="scroller" style="position:absolute;inset:44px 0 0 0;overflow:auto">
 <div id="page" style="width:620px;min-height:900px;margin:24px auto;background:#fff;padding:36px 44px;box-shadow:0 2px 10px rgba(0,0,0,.15)">
  <h2 style="margin-top:0">Práctica</h2>
  <p><b>Completar</b> Completa las oraciones con la forma correcta del verbo.</p>
  <p style="line-height:2.6">1. Yo _____________ (hablar) español con mis amigos.<br>
  2. Tú _____________ (comer) en la cafetería.<br>
  3. Nosotros _____________ (vivir) en Madrid.<br>
  4. Ellas _____________ (estudiar) en la biblioteca.</p>
  <div style="background:#1e3a5f;color:#fff;padding:14px 18px;border-radius:8px;line-height:2.4"><b>¡Atención!</b><br>5. Ustedes _____________ (bailar) muy bien.</div>
 </div></div></body></html>`;

async function mark(page, rects, opts = {}) {
  await page.evaluate(({ rects, opts }) => {
    for (const r of rects) {
      const pad = r.pad ?? 6;
      const box = document.createElement('div');
      box.className = '__mark';
      box.style.cssText = `position:fixed;left:${r.x - pad}px;top:${r.y - pad}px;width:${r.w + pad * 2}px;height:${r.h + pad * 2}px;border:3px solid #f59e0b;border-radius:10px;z-index:2147483647;pointer-events:none;box-sizing:border-box`;
      document.documentElement.appendChild(box);
      if (r.label) {
        const t = document.createElement('div');
        t.className = '__mark';
        t.textContent = r.label;
        const below = r.labelPos !== 'above' && r.labelPos !== 'left';
        t.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;background:#f59e0b;color:#111;font:bold 15px Arial,sans-serif;padding:5px 9px;border-radius:7px;white-space:nowrap;`;
        document.documentElement.appendChild(t);
        const tw = t.offsetWidth, th = t.offsetHeight;
        let x = r.x + r.w / 2 - tw / 2, y = r.y + r.h + pad + 8;
        if (r.labelPos === 'above') y = r.y - pad - th - 8;
        if (r.labelPos === 'left') { x = r.x - pad - tw - 10; y = r.y + r.h / 2 - th / 2; }
        if (r.labelPos === 'right') { x = r.x + r.w + pad + 10; y = r.y + r.h / 2 - th / 2; }
        t.style.left = Math.max(4, Math.min(innerWidth - tw - 4, x)) + 'px';
        t.style.top = y + 'px';
      }
    }
  }, { rects, opts });
}
const unmark = (page) => page.evaluate(() => document.querySelectorAll('.__mark').forEach((e) => e.remove()));
async function box(loc) { const b = await loc.boundingBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }

  const ctx = await chromium.launchPersistentContext('', {
    env: { ...process.env, LANGUAGE: lang === 'es' ? 'es' : 'en_US', LANG: lang === 'es' ? 'es_ES.UTF-8' : 'en_US.UTF-8' },
    headless: true, channel: 'chromium', locale: lang === 'es' ? 'es-ES' : 'en-US',
    viewport: { width: 1000, height: 560 }, deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, `--lang=${lang === 'es' ? 'es' : 'en-US'}`, '--auto-accept-this-tab-capture'],
  });
  const sw = ctx.serviceWorkers().find((w) => w.url().includes('background.js')) || await ctx.waitForEvent('serviceworker', (w) => w.url().includes('background.js'));
  // Welcome page (opens on install). Then turn off the automatic tour for the other shots.
  const welcome = ctx.pages().find((p) => p.url().includes('welcome.html')) || await ctx.waitForEvent('page', { predicate: (p) => p.url().includes('welcome.html') });
  await welcome.setViewportSize({ width: 1000, height: 900 });
  await welcome.waitForTimeout(1500);
  await welcome.screenshot({ path: `${OUT}/welcome-${lang}.png`, fullPage: true });
  await welcome.close();
  await sw.evaluate(() => chrome.storage.local.set({ tutorialPending: false }));
  const page = await ctx.newPage();
  const shot = (name, clip) => page.screenshot({ path: `${OUT}/${name}-${lang}.png`, clip });

  // ---- chrome://extensions ----
  await page.goto('chrome://extensions');
  await page.waitForTimeout(800);
  const hideCard = (hide) => page.evaluate((hide) => {
    const m = document.querySelector('extensions-manager');
    const list = m.shadowRoot.querySelector('extensions-item-list');
    list.shadowRoot.querySelectorAll('extensions-item').forEach((i) => (i.style.display = hide ? 'none' : ''));
  }, hide);
  await hideCard(true);
  // Hide this test browser's "managed by your organization" notice; readers won't see it.
  await page.evaluate(() => {
    const walk = (root) => root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) walk(el.shadowRoot);
      if (el.id === 'content' && /organizaci|organization/i.test(el.textContent) && el.textContent.length < 200) {
        const h = el.getRootNode().host;
        (h || el).style.display = 'none';
      }
    });
    walk(document);
  });
  await mark(page, [{ ...(await box(page.locator('#devMode'))), label: L('Turn this on', 'Actívelo'), pad: 8 }]);
  await shot('install-1-developer-mode', { x: 0, y: 0, width: 1000, height: 220 });
  await unmark(page);
  await page.locator('#devMode').click();
  await page.waitForTimeout(800);
  await mark(page, [{ ...(await box(page.locator('#loadUnpacked'))), label: L('Click here', 'Haga clic aquí') }]);
  await shot('install-2-load-unpacked', { x: 0, y: 0, width: 1000, height: 220 });
  await unmark(page);
  await hideCard(false);
  await page.waitForTimeout(800);
  const card = page.locator('extensions-item').first();
  await mark(page, [{ ...(await box(card)), label: L('Installed!', '¡Instalada!'), labelPos: 'right' }]);
  const cb = await card.boundingBox();
  await shot('install-3-installed', { x: 0, y: 0, width: 1000, height: Math.min(560, cb.y + cb.height + 30) });
  await unmark(page);

  // ---- textbook page ----
  await ctx.route('https://reader.vhlcentral.com/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
  await page.goto('https://reader.vhlcentral.com/book');
  await page.waitForTimeout(800);
  await sw.evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true });
    const s = { open: true, typing: true, color: '#1d4ed8', size: 18 };
    await chrome.storage.session.set({ ['tab:' + t.id]: s });
    chrome.tabs.sendMessage(t.id, { type: 'state', state: s, patch: {} });
  });
  await page.waitForTimeout(800);
  const sr = (sel) => page.locator('vhl-text-overlay').locator(sel);

  // Toolbar with labels
  await page.mouse.move(5, 300);
  const tb = await box(sr('.toolbar'));
  await shot('use-1-toolbar-appears', { x: 0, y: 0, width: 1000, height: 560 });

  // Fill in blanks
  const blanks = await page.evaluate(() => {
    // find the blank lines' positions
    const p = document.getElementById('page');
    const r = document.createRange(); const out = [];
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let n; while ((n = walker.nextNode())) { const i = n.textContent.indexOf('___'); if (i >= 0) { r.setStart(n, i); r.setEnd(n, i + 13); const b = r.getBoundingClientRect(); out.push({ x: b.left, y: b.top, w: b.width, h: b.height }); } }
    return out;
  });
  const words = ['hablo', 'comes', 'vivimos', 'estudian', 'bailan'];
  for (let i = 0; i < 5; i++) {
    await page.mouse.click(blanks[i].x + 14, blanks[i].y + blanks[i].h / 2 - 2);
    await page.keyboard.type(words[i]);
  }
  await page.keyboard.press('Escape');
  await page.mouse.move(5, 500);
  await page.waitForTimeout(800);
  const pageBox = await box(page.locator('#page'));
  const clipA = { x: pageBox.x - 20, y: 0, width: 1000 - (pageBox.x - 20), height: 400 };
  await mark(page, [
    { x: blanks[0].x, y: blanks[0].y - 8, w: 140, h: blanks[3].y + blanks[3].h - blanks[0].y + 10, label: L('Click a spot and type', 'Haga clic y escriba'), labelPos: 'left' },
    { x: blanks[4].x, y: blanks[4].y - 8, w: 140, h: blanks[4].h + 14, label: L('Light text on dark backgrounds', 'Texto claro sobre fondo oscuro'), labelPos: 'below' },
  ]);
  await shot('use-2-type', { x: 0, y: 0, width: 1000, height: 560 });
  await unmark(page);

  // Selected note with move / delete tabs
  await page.mouse.click(blanks[1].x + 30, blanks[1].y + 4);
  await page.waitForTimeout(800);
  const grip = await box(sr('.note.selected .grip'));
  const del = await box(sr('.note.selected .del'));
  await mark(page, [
    { ...grip, pad: 3, label: L('Drag to move', 'Arrastre para mover'), labelPos: 'left' },
    { ...del, pad: 3, label: L('Delete', 'Borrar'), labelPos: 'right' },
  ]);
  await shot('use-3-move-delete', { x: blanks[1].x - 230, y: blanks[1].y - 70, width: 520, height: 130 });
  await unmark(page);
  await page.keyboard.press('Escape');
  await page.mouse.move(5, 500);

  // Top bar close-up with numbers
  const tbtn = (i) => box(sr('.toolbar button').nth(i));
  const typing = await tbtn(0), save = await tbtn(1), clear = await tbtn(2), help = await tbtn(3), close = await tbtn(4);
  await mark(page, [
    { ...typing, pad: 4, label: '1' },
    { ...save, pad: 4, label: '2' },
    { ...clear, pad: 4, label: '3' },
    { ...help, pad: 4, label: '4' },
    { ...close, pad: 4, label: '5' },
  ]);
  await shot('use-4-top-bar', { x: tb.x - 20, y: 0, width: 1000 - (tb.x - 20), height: tb.y + tb.h + 52 });
  await unmark(page);

  // Side toolbar close-up
  const pb = await box(sr('.panel'));
  const big = await box(sr('.panel .big')), small = await box(sr('.panel .small'));
  const s0 = await box(sr('.panel .swatch').nth(0)), s5 = await box(sr('.panel .swatch').nth(5));
  const flip = await box(sr('.panel .flip'));
  await mark(page, [
    { x: big.x, y: big.y, w: big.w, h: small.y + small.h - big.y, pad: 5, label: L('Text size', 'Tamaño'), labelPos: 'left' },
    { x: s0.x, y: s0.y, w: s0.w, h: s5.y + s5.h - s0.y, pad: 5, label: L('Text color', 'Color'), labelPos: 'left' },
    { ...flip, pad: 4, label: L('Move to the other side', 'Mover al otro lado'), labelPos: 'left' },
  ]);
  await shot('use-5-side-bar', { x: pb.x - 230, y: pb.y - 12, width: 1000 - (pb.x - 230), height: pb.h + 24 });
  await unmark(page);

  // Tour: open with "?" and show the first two steps
  await sr('.toolbar button').nth(3).click();
  await page.waitForTimeout(900);
  await shot('tour-1-welcome', { x: 0, y: 0, width: 1000, height: 560 });
  await sr('.tour-pop .row button.primary').click();
  await page.waitForTimeout(900);
  await shot('tour-2-step', { x: 300, y: 0, width: 700, height: 340 });
  await sr('.tour-pop .row button.link').click();
  await page.waitForTimeout(900);

  // Screenshot card (real capture; the share prompt is auto-accepted in this test browser)
  await page.mouse.move(5, 500);
  await page.bringToFront();
  await page.keyboard.press('Alt+Shift+S');
  await page.waitForFunction(() => !document.querySelector('vhl-text-overlay').shadowRoot.querySelector('.shotcard')?.classList.contains('hidden'), null, { timeout: 8000 });
  await page.waitForTimeout(1200);
  const sc = await box(sr('.shotcard'));
  await shot('use-6-saved', { x: sc.x - 24, y: sc.y - 24, width: sc.w + 48, height: sc.h + 48 });

  await ctx.close();
}

const langs = process.argv[2] ? [process.argv[2]] : ['en', 'es'];
for (const lang of langs) {
  await run(lang);
  console.log(`✓ ${lang} screenshots saved to docs/images`);
}
