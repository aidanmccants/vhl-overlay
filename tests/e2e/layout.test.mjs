// Layout stability: changing state (Typing on/off, Copy → Copied, tour steps, size
// numbers) must never resize a container or move the buttons around it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, gotoReader, ui } from '../helpers.mjs';

let b;
before(async () => (b = await launch()));
after(async () => b?.close());

const boxes = (loc) => loc.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
// Move the mouse off the buttons (hover lifts a button 1px with a transform, which
// doesn't move anything else) and wait out the spring animations.
const settle = async (page) => {
  await page.mouse.move(400, 690);
  await page.waitForTimeout(700);
};

function assertSameBoxes(a, b, what) {
  assert.equal(a.length, b.length, `${what}: same number of elements`);
  a.forEach((r, i) => {
    for (const k of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(r[k] - b[i][k]) < 0.5, `${what} #${i} ${k} moved: ${r[k]} → ${b[i][k]}`);
    }
  });
}

test('turning Typing on and off does not resize the top bar or move its buttons', async () => {
  const { page, sw } = b;
  await gotoReader(page, sw);
  await settle(page);
  const on = [await ui(page, '.toolbar').boundingBox(), ...(await boxes(ui(page, '.toolbar button')))];
  await ui(page, '.toolbar button').first().click();
  await settle(page);
  assert.match(await ui(page, '.toolbar button').first().getAttribute('aria-label'), /off/);
  const off = [await ui(page, '.toolbar').boundingBox(), ...(await boxes(ui(page, '.toolbar button')))];
  assertSameBoxes(on, off, 'top bar');
  await ui(page, '.toolbar button').first().click();
  await settle(page);
});

test('the size number keeps the same width from 10 to 48', async () => {
  const { page } = b;
  const widths = new Set();
  for (let i = 0; i < 5; i++) await ui(page, '.panel .small').click();
  await settle(page);
  assert.equal(await ui(page, '.panel .size').textContent(), '10');
  widths.add((await ui(page, '.panel .size').boundingBox()).width);
  const panel10 = await ui(page, '.panel').boundingBox();
  for (let i = 0; i < 20; i++) await ui(page, '.panel .big').click();
  await settle(page);
  assert.equal(await ui(page, '.panel .size').textContent(), '48');
  widths.add((await ui(page, '.panel .size').boundingBox()).width);
  assert.equal(widths.size, 1, `size number width changed: ${[...widths]}`);
  assertSameBoxes([panel10], [await ui(page, '.panel').boundingBox()], 'side toolbar');
});

test('the screenshot card does not change size when you Copy or Download', async () => {
  const { page } = b;
  await page.bringToFront();
  await page.keyboard.press('Alt+Shift+S');
  await ui(page, '.shotcard:not(.hidden)').waitFor({ timeout: 8000 });
  await settle(page);
  const parts = () => Promise.all([ui(page, '.shotcard').boundingBox(), ...[0, 1].map((i) => ui(page, '.shotcard .actions button').nth(i).boundingBox()), ui(page, '.shotcard .status').boundingBox()]);
  const start = await parts();
  await ui(page, '.shotcard .actions button').nth(0).click();
  await settle(page);
  assert.match(await ui(page, '.shotcard .actions button').nth(0).getAttribute('aria-label'), /Copied/);
  assertSameBoxes(start, await parts(), 'card after Copy');
  const dl = page.waitForEvent('download');
  await ui(page, '.shotcard .actions button').nth(1).click();
  await dl;
  await settle(page);
  assert.match(await ui(page, '.shotcard .actions button').nth(1).getAttribute('aria-label'), /Downloaded/);
  assertSameBoxes(start, await parts(), 'card after Download');
  // Labels never wrap onto a second line.
  for (const h of (await parts()).slice(1, 3).map((r) => r.height)) assert.ok(h < 48, `button height ${h}`);
  await ui(page, '.shotcard .title button').click();
});

test('tour buttons stay in the same place on every step', async () => {
  const { page } = b;
  await ui(page, '.toolbar button[title^="Show the tour"]').click();
  await settle(page);
  const rowOf = async () => {
    const pop = await ui(page, '.tour-pop').boundingBox();
    const btns = await boxes(ui(page, '.tour-pop .row button'));
    // Positions relative to the tip box (the tip box itself moves to point at each button).
    return btns.map((r) => ({ x: r.x - pop.x, y: 0, width: r.width, height: r.height }));
  };
  const first = await rowOf();
  assert.equal(first.length, 3, 'Skip, Back and Next are always laid out');
  for (let i = 1; i < 11; i++) {
    await ui(page, '.tour-pop .row button.primary').click();
    await settle(page);
    const now = await rowOf();
    if (i < 10) assertSameBoxes(first, now, `tour step ${i} buttons`);
    else assertSameBoxes(first.slice(1), now.slice(1), 'last step Back/Done'); // Skip is hidden on the last step
  }
});
