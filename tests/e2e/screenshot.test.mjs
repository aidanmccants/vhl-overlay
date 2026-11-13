// Screenshot: share the tab, then copy or download the picture.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, gotoReader, ui, blank, chromium } from '../helpers.mjs';

let b;
before(async () => (b = await launch()));
after(async () => b?.close());

let toolbarBox;
let panelBox;

test('Alt+Shift+S takes a screenshot and shows the Copy / Download card', async () => {
  const { page, sw } = b;
  await gotoReader(page, sw);
  const p = await blank(page, 0);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.type('hablo');
  await page.keyboard.press('Escape');
  toolbarBox = await ui(page, '.toolbar').boundingBox();
  panelBox = await ui(page, '.panel').boundingBox();
  await page.bringToFront();
  await page.keyboard.press('Alt+Shift+S');
  await ui(page, '.shotcard:not(.hidden)').waitFor({ timeout: 8000 });
  // Each button keeps all its labels stacked (no layout shift); aria-label is the visible one.
  const labels = await ui(page, '.shotcard .actions button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label')));
  assert.deepEqual(labels, ['Copy', 'Download']);
});

test('Copy puts the picture on the clipboard', async () => {
  const { page } = b;
  await ui(page, '.shotcard .actions button').nth(0).click();
  await page.waitForTimeout(300);
  assert.equal(await ui(page, '.shotcard .actions button').nth(0).getAttribute('aria-label'), 'Copied');
  const visible = await ui(page, '.shotcard .actions button').nth(0).evaluate((b) => [...b.querySelectorAll('.stack > span')].filter((s) => getComputedStyle(s).visibility === 'visible').map((s) => s.textContent));
  assert.deepEqual(visible, ['Copied'], 'only the new label is visible');
  const size = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    return (await item.getType('image/png')).size;
  });
  assert.ok(size > 1000, `clipboard has a PNG (${size} bytes)`);
});

test('Download saves a dated PNG without the toolbars but with your text', async () => {
  const { page } = b;
  const dl = page.waitForEvent('download');
  await ui(page, '.shotcard .actions button').nth(1).click();
  const d = await dl;
  assert.match(d.suggestedFilename(), /^vhl-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.png$/);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vhl-shot-')), 'shot.png');
  await d.saveAs(file);

  // Inspect the picture in a blank page.
  const br = await chromium.launch();
  const pg = await br.newPage();
  const data = 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
  const stats = await pg.evaluate(async ({ data, tb, pb }) => {
    const img = new Image();
    img.src = data;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const k = img.width / 1100;
    // Share of pixels in an area that match a plain color (within a small tolerance).
    const share = (x, y, w, h, [r, g, bl]) => {
      const d = ctx.getImageData(Math.round(x * k), Math.round(y * k), Math.round(w * k), Math.round(h * k)).data;
      let same = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - bl) < 24) same++;
      return same / (d.length / 4);
    };
    // Where the top bar was, the picture must show the reader's plain header (#374151);
    // where the side toolbar was, the plain page background (#e5e7eb).
    const topBar = share(tb.x + 4, 18, tb.width - 8, 22, [55, 65, 81]);
    const sideBar = share(pb.x + 4, pb.y + 40, pb.width - 8, pb.height - 80, [229, 231, 235]);
    // Count strongly blue pixels (the typed text).
    const all = ctx.getImageData(0, 0, c.width, c.height).data;
    let blue = 0;
    for (let i = 0; i < all.length; i += 4) if (all[i + 2] > 150 && all[i] < 90 && all[i + 1] < 120) blue++;
    return { w: img.width, topBar, sideBar, blue };
  }, { data, tb: toolbarBox, pb: panelBox });
  await br.close();
  assert.ok(stats.w >= 1000, 'full-size picture');
  assert.ok(stats.topBar > 0.97, `top bar is not in the picture (${(stats.topBar * 100).toFixed(1)}% plain header)`);
  assert.ok(stats.sideBar > 0.97, `side toolbar is not in the picture (${(stats.sideBar * 100).toFixed(1)}% plain background)`);
  assert.ok(stats.blue > 30, `typed text is in the picture (${stats.blue} blue pixels)`);
  assert.match(await ui(page, '.shotcard .status').textContent(), /Downloads/);
});

test('✕ closes the card', async () => {
  const { page } = b;
  await ui(page, '.shotcard .title button').click();
  await page.waitForTimeout(400);
  assert.equal(await ui(page, '.shotcard').evaluate((c) => c.classList.contains('hidden')), true);
});
