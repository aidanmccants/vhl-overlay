// Pen mode: drawing with a pen (pressure, eraser end), a mouse or a finger.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, gotoReader, ui, noteTexts } from '../helpers.mjs';

let b;
let cdp;
before(async () => {
  b = await launch();
  cdp = await b.page.context().newCDPSession(b.page);
});
after(async () => b?.close());

// A real pen stroke through Chrome's input pipeline (pointerType "pen", with pressure).
async function pen(pts, force = 0.5) {
  const send = (type, [x, y], extra) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', pointerType: 'pen', ...extra });
  await send('mousePressed', pts[0], { buttons: 1, clickCount: 1, force });
  for (const p of pts.slice(1)) await send('mouseMoved', p, { buttons: 1, force });
  await send('mouseReleased', pts.at(-1), { buttons: 0, clickCount: 1, force: 0 });
}
const line = (x, y, n = 25) => Array.from({ length: n }, (_, i) => [x + i * 6, y]);
const strokeCount = (page) => ui(page, '.ink').count();
const strokeBox = (page, i) => ui(page, '.ink path').nth(i).boundingBox();
// Pick a mode and wait until the page has really switched (no fixed sleeps: CI can be slow).
async function mode(page, m) {
  await ui(page, `.modes button[data-mode="${m}"][aria-pressed="false"]`).click();
  await ui(page, `.modes button[data-mode="${m}"][aria-pressed="true"]`).waitFor();
  await ui(page, m === 'pen' ? '.layer.drawing' : '.layer:not(.drawing)').waitFor({ state: 'attached' });
}

test('the mode selector has Off, Pen and Typing, and Typing is on at first', async () => {
  const { page, sw } = b;
  await gotoReader(page, sw);
  const modes = await ui(page, '.modes button').evaluateAll((bs) => bs.map((x) => [x.dataset.mode, x.getAttribute('aria-pressed')]));
  assert.deepEqual(modes, [['off', 'false'], ['pen', 'false'], ['typing', 'true']]);
});

test('in Pen mode a mouse drag draws, without adding text or reaching the reader', async () => {
  const { page } = b;
  await mode(page, 'pen');
  await page.waitForTimeout(150);
  assert.equal(await ui(page, '.layer').evaluate((l) => getComputedStyle(l).touchAction), 'none', 'dragging draws instead of scrolling');
  await page.mouse.move(300, 330);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(300 + i * 8, 330 + (i % 5) * 3);
  await page.mouse.up();
  assert.equal(await strokeCount(page), 1);
  assert.deepEqual(await noteTexts(page), []);
  assert.equal(await page.evaluate(() => window.nextClicks || 0), 0);
  assert.equal(await page.evaluate(() => window.readerClicks), 0);
  const box = await strokeBox(page, 0);
  assert.ok(box.width > 140 && box.width < 180, `stroke follows the drag (${box.width}px wide)`);
});

test('pressing the pen harder draws a thicker line', async () => {
  const { page } = b;
  await pen(line(300, 400), 0.1);
  await pen(line(300, 460), 1);
  const [thick, thin] = [await strokeBox(page, 0), await strokeBox(page, 1)]; // newest is first
  assert.ok(thick.height > thin.height * 2, `thin ${thin.height}px, thick ${thick.height}px`);
});

test('ink stays readable: light shade on the dark box', async () => {
  const { page } = b;
  const d = await page.locator('#dark').boundingBox();
  await pen(line(d.x + 260, d.y + 25, 10));
  assert.equal(await ui(page, '.ink path').first().getAttribute('fill'), '#93c5fd');
  assert.equal(await ui(page, '.ink path').nth(1).getAttribute('fill'), '#1d4ed8', 'dark blue on the white page');
  assert.equal(await strokeCount(page), 4);
});

test('drawings stick to the page when it scrolls', async () => {
  const { page } = b;
  const y0 = (await strokeBox(page, 1)).y;
  await page.locator('#scroller').evaluate((s) => (s.scrollTop = 100));
  await page.waitForTimeout(100);
  const y1 = (await strokeBox(page, 1)).y;
  assert.ok(Math.abs(y0 - y1 - 100) < 2, `moved up with the page: ${y0} → ${y1}`);
});

test('the mouse wheel still scrolls the page in Pen mode', async () => {
  const { page } = b;
  await page.mouse.move(500, 400);
  await page.mouse.wheel(0, -100);
  await page.waitForFunction(() => document.getElementById('scroller').scrollTop === 0);
});

test("a Surface Pen's eraser end erases the line it touches", async () => {
  const { page } = b;
  const box = await strokeBox(page, 1); // the thick line
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  // Chrome reports the eraser end as a pen with button 5 (buttons bit 32).
  await ui(page, '.layer').evaluate((l, [x, y]) => {
    const ev = (type, buttons) => new PointerEvent(type, { pointerType: 'pen', pointerId: 7, button: 5, buttons, clientX: x, clientY: y, bubbles: true, composed: true, pressure: 0.5 });
    l.dispatchEvent(ev('pointerdown', 32));
    l.dispatchEvent(ev('pointerup', 0));
  }, [x, y]);
  assert.equal(await strokeCount(page), 3);
});

test('the 🧽 eraser button erases with the mouse', async () => {
  const { page } = b;
  await ui(page, '.panel .erasebtn').click();
  assert.equal(await ui(page, '.panel .erasebtn').getAttribute('aria-pressed'), 'true');
  const box = await strokeBox(page, 1);
  await page.mouse.move(box.x - 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  assert.equal(await strokeCount(page), 2);
  await ui(page, '.panel .erasebtn').click();
  assert.equal(await ui(page, '.panel .erasebtn').getAttribute('aria-pressed'), 'false');
});

test('Ctrl+Z undoes drawing and erasing; Ctrl+Shift+Z redoes', async () => {
  const { page } = b;
  await page.evaluate(() => {
    window.zKeys = 0;
    window.addEventListener('keydown', (e) => e.key.toLowerCase() === 'z' && window.zKeys++);
  });
  await page.keyboard.press('Control+z'); // un-erase (button)
  assert.equal(await strokeCount(page), 3);
  await page.keyboard.press('Control+z'); // un-erase (pen end)
  assert.equal(await strokeCount(page), 4);
  await page.keyboard.press('Control+z'); // undraw the last line
  assert.equal(await strokeCount(page), 3);
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await strokeCount(page), 4);
  assert.equal(await page.evaluate(() => window.zKeys), 0, 'the reader never sees Ctrl+Z');
});

test('Off lets you use the textbook again, and the drawings stay', async () => {
  const { page } = b;
  await mode(page, 'off');
  await page.waitForTimeout(150);
  await page.locator('#next').click();
  assert.equal(await page.evaluate(() => window.nextClicks), 1);
  assert.equal(await strokeCount(page), 4);
});

test('Clear removes drawings too', async () => {
  const { page } = b;
  page.once('dialog', (d) => d.accept());
  await ui(page, '.toolbar button[title^="Remove all"]').click();
  await page.waitForTimeout(200);
  assert.equal(await strokeCount(page), 0);
});
