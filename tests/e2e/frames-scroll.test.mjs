// Text inside embedded frames, and text staying glued to the page when it scrolls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, gotoReader, ui, blank } from '../helpers.mjs';

let b;
before(async () => (b = await launch()));
after(async () => b?.close());

test('you can type inside an embedded frame, and the frame does not see the keys', async () => {
  const { page, sw } = b;
  await gotoReader(page, sw);
  await page.locator('#scroller').evaluate((s) => (s.scrollTop = 200));
  const frame = page.frameLocator('#frame');
  const box = await page.locator('#frame').boundingBox();
  const inner = await frame.locator('.blank').boundingBox();
  await page.mouse.click(inner.x + 10, inner.y + inner.height / 2);
  await page.keyboard.type('viven');
  const f = page.frames().find((fr) => fr.url().endsWith('/frame'));
  const texts = await f.evaluate(() => [...document.querySelector('vhl-text-overlay').shadowRoot.querySelectorAll('.text')].map((t) => t.textContent));
  assert.deepEqual(texts, ['viven']);
  assert.equal(await f.evaluate(() => window.frameKeys || 0), 0);
  assert.ok(box);
});

test('text moves with the page when the page viewer scrolls', async () => {
  const { page } = b;
  await page.keyboard.press('Escape');
  await page.locator('#scroller').evaluate((s) => (s.scrollTop = 0));
  await page.waitForTimeout(100);
  const p = await blank(page, 0);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.type('hablo');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500); // let the pop-in animation finish before measuring
  const text = ui(page, '.note .text').first();
  const blankBefore = await page.locator('.blank').first().boundingBox();
  const before = await text.boundingBox();
  await page.locator('#scroller').evaluate((s) => (s.scrollTop = 120));
  await page.waitForTimeout(150);
  const blankAfter = await page.locator('.blank').first().boundingBox();
  const after = await text.boundingBox();
  assert.ok(Math.abs(blankBefore.y - blankAfter.y - 120) < 2, 'page scrolled');
  assert.ok(Math.abs(before.y - after.y - 120) < 2, `text moved with it (${before.y - after.y})`);
  assert.ok(Math.abs(after.x - before.x) < 1);
});

test('text follows the page when the window is resized', async () => {
  const { page } = b;
  const text = ui(page, '.note .text').first();
  const blankBefore = await page.locator('.blank').first().boundingBox();
  const before = await text.boundingBox();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(150);
  const blankAfter = await page.locator('.blank').first().boundingBox();
  const after = await text.boundingBox();
  const dx = blankAfter.x - blankBefore.x;
  assert.ok(Math.abs(after.x - before.x - dx) < 2, `followed the page sideways (${after.x - before.x} vs ${dx})`);
});

test('text typed in the margin of the scrolling page viewer also moves when it scrolls', async () => {
  const { page } = b;
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.locator('#scroller').evaluate((s) => (s.scrollTop = 0));
  await page.waitForTimeout(100);
  // Gray margin left of the white page: the closest big element here is the scrolling
  // viewer itself, whose own box does not move when its content scrolls.
  const pageBox = await page.locator('#page').boundingBox();
  await page.mouse.click(pageBox.x - 90, 320);
  await page.keyboard.type('nota');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const text = ui(page, '.note .text').last();
  assert.equal(await text.textContent(), 'nota');
  const before = await text.boundingBox();
  await page.locator('#scroller').evaluate((s) => (s.scrollTop = 150));
  await page.waitForTimeout(150);
  const after = await text.boundingBox();
  assert.ok(Math.abs(before.y - after.y - 150) < 2, `margin text moved with the page (${before.y - after.y}px, expected 150)`);
});
