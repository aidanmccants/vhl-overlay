#!/usr/bin/env node
// Makes every image the Chrome Web Store listing needs, from the real extension:
//   docs/store/store-icon-128.png         store icon (96px artwork + 16px transparent padding)
//   docs/store/screenshot-1..5.png        1280x800 screenshots (the store allows 5)
//   docs/store/promo-small-440x280.png    small promo tile
//   docs/store/promo-marquee-1400x560.png marquee promo tile
//   docs/store/icons/                     the extension's own icons (16, 32, 48, 128)
// Run: npm run store-assets
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'store');
const EXT = path.join(ROOT, 'extension');
const ICON = 'data:image/png;base64,' + fs.readFileSync(path.join(EXT, 'icons', 'icon128.png')).toString('base64');
// The vector source (assets/icon.svg) for big, sharp copies on the promo tiles.
const ICON_SVG = 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(ROOT, 'assets', 'icon.svg')).toString('base64');
const LUCIDE = (() => {
  const g = {};
  new Function('globalThis', fs.readFileSync(path.join(EXT, 'icons.js'), 'utf8'))(g);
  return g.VHL_ICONS;
})();
const svg = (n, size = 30) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${LUCIDE[n]}</svg>`;
fs.mkdirSync(path.join(OUT, 'icons'), { recursive: true });

// A practice page like the VHL reader, with a caption band on top for the store.
const BAND = 78;
const page = (caption, icon) => `<!doctype html><html><head><meta charset="utf-8"><title>Lección 3</title></head>
<body style="margin:0;font:17px Georgia,serif;background:#e5e7eb;overflow:hidden">
<div style="position:fixed;inset:0 0 auto 0;height:${BAND}px;background:linear-gradient(90deg,#b00c2b,#c60e30 60%,#d8203f);color:#fff;display:flex;align-items:center;gap:16px;padding:0 30px;font:600 27px/1.2 -apple-system,'Segoe UI',Inter,Roboto,sans-serif;letter-spacing:-.01em;z-index:5">
  <span style="display:grid;place-items:center;width:44px;height:44px;border-radius:12px;background:rgba(255,255,255,.18)">${svg(icon, 26)}</span>${caption}</div>
<div style="position:fixed;inset:${BAND}px 0 auto 0;height:40px;background:#374151;color:#fff;font:14px Arial;display:flex;align-items:center;padding:0 16px">◀ ▶ &nbsp; Lección 3 · Página 92</div>
<div id="scroller" style="position:absolute;inset:${BAND + 40}px 0 0 0;overflow:auto">
 <div id="page" style="width:560px;min-height:900px;margin:20px 0 0 70px;background:#fff;padding:30px 40px;box-shadow:0 2px 10px rgba(0,0,0,.15)">
  <h2 style="margin:0 0 10px">Práctica</h2>
  <p style="margin:0 0 8px"><b>Completar</b> Completa las oraciones con la forma correcta del verbo.</p>
  <p style="line-height:2.5;margin:0">1. Yo <span class="blank">_____________</span> (hablar) español con mis amigos.<br>
  2. Tú <span class="blank">_____________</span> (comer) en la cafetería.<br>
  3. Nosotros <span class="blank">_____________</span> (vivir) en Madrid.<br>
  4. Ellas <span class="blank">_____________</span> (estudiar) en la biblioteca.</p>
  <div style="background:#1e3a5f;color:#fff;padding:10px 18px;border-radius:8px;line-height:2.3;margin-top:6px"><b>¡Atención!</b><br>5. Ustedes <span class="blank">_____________</span> (bailar) muy bien.</div>
 </div></div></body></html>`;

const extDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vhl-store-')), 'ext');
fs.cpSync(EXT, extDir, { recursive: true });
const ctx = await chromium.launchPersistentContext('', {
  headless: true, channel: 'chromium', locale: 'en-US',
  viewport: { width: 960, height: 600 }, deviceScaleFactor: 4 / 3, // 1280x800 pictures, UI big enough to read at half size
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--auto-accept-this-tab-capture'],
});
const sw = ctx.serviceWorkers().find((w) => w.url().includes('background.js')) || (await ctx.waitForEvent('serviceworker'));
await sw.evaluate(() => chrome.storage.local.set({ tutorialPending: false }));
for (const p of ctx.pages()) if (p.url().includes('welcome')) await p.close();
let html = '';
await ctx.route('https://reader.vhlcentral.com/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
const tab = await ctx.newPage();
const cdp = await ctx.newCDPSession(tab);
const sr = (sel) => tab.locator('vhl-text-overlay').locator(sel);
const wait = (ms) => tab.waitForTimeout(ms);

async function scene(caption, icon, state = {}) {
  html = page(caption, icon);
  await tab.goto('https://reader.vhlcentral.com/book');
  await wait(500);
  await sw.evaluate(async (patch) => {
    const [t] = await chrome.tabs.query({ active: true });
    const s = { open: true, typing: true, pen: false, eraser: false, mark: false, markColor: 'red', color: 'blue', size: 20, side: 'right', ...patch };
    await chrome.storage.session.set({ ['tab:' + t.id]: s });
    chrome.tabs.sendMessage(t.id, { type: 'state', state: s, patch: {} });
  }, state);
  await wait(900);
  // Keep the toolbars below the caption band.
  await tab.evaluate((band) => {
    const r = document.querySelector('vhl-text-overlay').shadowRoot;
    r.querySelector('.toolbar').style.top = band + 50 + 'px';
    r.querySelector('.panel').style.top = band + 104 + 'px';
  }, BAND);
  await wait(300);
}
const blanks = () => tab.locator('.blank').evaluateAll((bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, h: r.height }; }));
async function fill(words) {
  const bl = await blanks();
  for (let i = 0; i < words.length; i++) {
    await tab.mouse.click(bl[i].x + 14, bl[i].y + bl[i].h / 2 - 2);
    await tab.keyboard.type(words[i]);
  }
  await tab.keyboard.press('Escape');
  await tab.mouse.move(940, 590);
  await wait(900);
}
async function penLine(pts) {
  const send = (type, [x, y], extra) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', pointerType: 'pen', ...extra });
  await send('mousePressed', pts[0], { buttons: 1, clickCount: 1, force: 0.3 });
  for (let i = 1; i < pts.length; i++) await send('mouseMoved', pts[i], { buttons: 1, force: 0.35 + 0.5 * Math.sin((i / pts.length) * Math.PI) });
  await send('mouseReleased', pts.at(-1), { buttons: 0, clickCount: 1, force: 0 });
}
const noteBox = async (i) => { const b = await sr('.note .text').nth(i).boundingBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
const shot = (n) => tab.screenshot({ path: path.join(OUT, `screenshot-${n}.png`) });

// 1. Typing answers, readable on any background
await scene('Type your answers right on the textbook page', 'type');
await fill(['hablo', 'comes', 'vivimos', 'estudian', 'bailan']);
await shot(1);

// 2. All three ways to highlight a verb ending, one per answer, with numbered labels.
await scene('Highlight verb endings 3 ways', 'highlighter');
{
  const bl = await blanks();
  const typeAt = async (i, text) => {
    await tab.mouse.click(bl[i].x + 14, bl[i].y + bl[i].h / 2 - 2);
    await tab.keyboard.type(text);
  };
  // (1) type ">" before the ending
  await typeAt(0, 'habl>o');
  // (2) like Word: select the letters, click a color
  await typeAt(1, 'comes');
  await tab.keyboard.press('Shift+ArrowLeft');
  await tab.keyboard.press('Shift+ArrowLeft');
  await sr('.panel .swatch[data-color="green"]').click();
  await wait(200);
  await typeAt(2, 'vivimos');
  await typeAt(3, 'estudi>an');
  await typeAt(4, 'bail>an');
  await tab.keyboard.press('Escape');
  // (3) the highlighter: drag across the letters (orange marker)
  await sr('.panel .markbtn').click();
  await sr('.panel .swatch[data-color="orange"]').click();
  await wait(200);
  const span = await sr('.note .text').nth(2).evaluate((t) => {
    const n = t.firstChild;
    const r = document.createRange();
    const at = (i) => { r.setStart(n, i); r.setEnd(n, i + 1); return r.getBoundingClientRect(); };
    const a = at(3), z = at(6);
    return { x1: a.left + 2, x2: z.right - 2, y: (a.top + a.bottom) / 2 };
  });
  await tab.mouse.move(span.x1, span.y);
  await tab.mouse.down();
  await tab.mouse.move(span.x2, span.y, { steps: 6 });
  await tab.mouse.up();
  // Numbered labels in the margin, next to each answer.
  const notes = await sr('.note .text').evaluateAll((ts) => ts.slice(0, 3).map((t) => { const r = t.getBoundingClientRect(); return r.top + r.height / 2; }));
  const pageRight = await tab.locator('#page').evaluate((e) => e.getBoundingClientRect().right);
  await tab.evaluate(({ ys, x, labels }) => {
    labels.forEach((html, i) => {
      const d = document.createElement('div');
      d.innerHTML = `<b style="display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:#c60e30;color:#fff;font:700 13px/1 system-ui">${i + 1}</b>${html}`;
      d.style.cssText = `position:fixed;left:${x}px;top:${ys[i] - 17}px;display:flex;align-items:center;gap:8px;padding:6px 12px 6px 7px;border-radius:999px;background:#fff;color:#111827;font:600 14px/1.2 -apple-system,'Segoe UI',Inter,Roboto,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.18);white-space:nowrap;z-index:4`;
      document.body.appendChild(d);
    });
  }, { ys: notes, x: pageRight - 150, labels: [
    'Type <code style="font:600 13px ui-monospace,monospace;background:#f3f4f6;padding:1px 5px;border-radius:5px">habl&gt;o</code>',
    'Select letters, click a color',
    'Highlighter: click or drag',
  ] });
}
await tab.mouse.move(940, 590);
await wait(700);
await shot(2);

// 3. Pen mode: circle, underline, check mark
await scene('Draw with a Surface Pen, a mouse or your finger', 'pen-line', { color: 'blue' });
await fill(['hablo', 'comes', 'vivimos', 'estudian', 'bailan']);
await sr('.modes button[data-mode="pen"]').click();
await sr('.panel .swatch[data-color="red"]').click();
await wait(300);
{
  const n1 = await noteBox(1);
  const ell = [];
  for (let a = -0.4; a <= Math.PI * 2 + 0.3; a += 0.1) ell.push([n1.x + n1.w / 2 + Math.cos(a) * (n1.w / 2 + 16), n1.y + n1.h / 2 + Math.sin(a) * (n1.h / 2 + 9)]);
  await penLine(ell);
  const n2 = await noteBox(2);
  await penLine(Array.from({ length: 26 }, (_, i) => [n2.x - 4 + i * ((n2.w + 12) / 25), n2.y + n2.h + 5 + Math.sin(i / 3) * 1.5]));
  const pageRight = await tab.locator('#page').evaluate((e) => e.getBoundingClientRect().right);
  for (const k of [0, 3]) {
    const n = await noteBox(k);
    const cx = pageRight - 62, cy = n.y + n.h / 2 - 6; // in the empty right margin
    await penLine([...Array.from({ length: 6 }, (_, i) => [cx + i * 2, cy + i * 2.5]), ...Array.from({ length: 12 }, (_, i) => [cx + 12 + i * 2.5, cy + 13 - i * 3.2])]);
  }
}
await tab.mouse.move(940, 590);
await wait(600);
await shot(3);

// 4. Screenshot card: copy or download
await scene('Save a picture of your work: copy it or download it', 'camera');
await fill(['hablo', 'comes', 'vivimos', 'estudian', 'bailan']);
await tab.bringToFront();
await tab.keyboard.press('Alt+Shift+S');
await tab.waitForFunction(() => !document.querySelector('vhl-text-overlay').shadowRoot.querySelector('.shotcard')?.classList.contains('hidden'), null, { timeout: 10000 });
await tab.mouse.move(940, 590);
await wait(1300);
await shot(4);

// 5. The built-in tour (shows Off / Pen / Typing)
await scene('A one-minute tour shows you every feature', 'circle-help');
await fill(['hablo', 'comes']);
await sr('.toolbar button[title^="Show the tour"]').click();
await wait(500);
await sr('.tour-pop .row button.primary').click();
await tab.mouse.move(940, 590);
await wait(1100);
await shot(5);

// Promo tiles: brand, no text (as the store recommends), works at half size.
// (A separate browser at 1:1 pixels, so each image is exactly its required size.)
const plain = await chromium.launch();
async function tile(file, w, h, iconSize) {
  const p = await plain.newPage({ deviceScaleFactor: 1 });
  await p.setViewportSize({ width: w, height: h });
  const s = Math.min(w, h);
  await p.setContent(`<body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;background:radial-gradient(120% 140% at 50% 40%,#2b3446,#151a24);position:relative">
  <svg width="${w}" height="${h}" style="position:absolute;inset:0" fill="none" stroke-linecap="round">
    <path d="M${w * 0.06} ${h * 0.78} C ${w * 0.25} ${h * 0.62}, ${w * 0.4} ${h * 0.95}, ${w * 0.62} ${h * 0.74} S ${w * 0.9} ${h * 0.6}, ${w * 1.02} ${h * 0.7}" stroke="#c60e30" stroke-width="${s * 0.05}" opacity=".9"/>
    <path d="M${w * 0.7} ${h * 0.18} l ${s * 0.07} ${s * 0.08} l ${s * 0.15} -${s * 0.2}" stroke="rgba(255,255,255,.85)" stroke-width="${s * 0.045}" stroke-linejoin="round"/>
    <ellipse cx="${w * 0.2}" cy="${h * 0.24}" rx="${s * 0.16}" ry="${s * 0.09}" stroke="#60a5fa" stroke-width="${s * 0.03}" opacity=".85" transform="rotate(-8 ${w * 0.2} ${h * 0.24})"/>
  </svg>
  <img src="${ICON_SVG}" style="position:absolute;left:50%;top:50%;width:${iconSize}px;height:${iconSize}px;transform:translate(-50%,-50%);filter:drop-shadow(0 ${iconSize * 0.08}px ${iconSize * 0.2}px rgba(0,0,0,.55))">
  </body>`);
  await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(OUT, file) });
  await p.close();
}
await tile('promo-small-440x280.png', 440, 280, 150);
await tile('promo-marquee-1400x560.png', 1400, 560, 300);

// Store icon: the 128px icon's artwork at 96x96, centered with 16px transparent padding.
{
  const p = await plain.newPage({ deviceScaleFactor: 1 });
  await p.setViewportSize({ width: 128, height: 128 });
  await p.setContent(`<body style="margin:0;background:transparent"><img src="${ICON}" style="position:absolute;left:16px;top:16px;width:96px;height:96px"></body>`);
  await p.waitForTimeout(100);
  await p.screenshot({ path: path.join(OUT, 'store-icon-128.png'), omitBackground: true });
  await p.close();
}
for (const n of [16, 32, 48, 128]) fs.copyFileSync(path.join(EXT, 'icons', `icon${n}.png`), path.join(OUT, 'icons', `icon${n}.png`));

await plain.close();
await ctx.close();
console.log('✓ Store images saved to docs/store');
