// Typing text onto the page, and keeping the reader from reacting while you do.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, gotoReader, ui, noteTexts, blank } from '../helpers.mjs';

let b;
before(async () => (b = await launch()));
after(async () => b?.close());

test('clicking the page and typing creates text boxes', async () => {
  const { page, sw } = b;
  await gotoReader(page, sw);
  const p0 = await blank(page, 0);
  await page.mouse.click(p0.x, p0.y);
  await page.keyboard.type('hablo');
  const p1 = await blank(page, 1);
  await page.mouse.click(p1.x, p1.y);
  await page.keyboard.type('comes');
  assert.deepEqual(await noteTexts(page), ['hablo', 'comes']);
});

test('the reader never sees clicks or keys meant for the overlay', async () => {
  const { page } = b;
  assert.equal(await page.evaluate(() => window.readerClicks), 0);
  assert.equal(await page.evaluate(() => window.readerKeys), 0);
  // Arrow keys would turn the page in the real reader.
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => window.readerKeys), 0);
});

test("while typing, the reader's own buttons don't react", async () => {
  const { page } = b;
  await page.locator('#next').click({ force: true });
  assert.equal(await page.evaluate(() => window.nextClicks || 0), 0);
});

test('Esc finishes a box, and empty boxes disappear', async () => {
  const { page } = b;
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 600); // start a box but type nothing
  await page.mouse.click(720, 640);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  assert.deepEqual(await noteTexts(page), ['hablo', 'comes']);
});

test('Enter makes a new line in the same box', async () => {
  const { page } = b;
  await page.mouse.click(500, 620);
  await page.keyboard.type('uno');
  await page.keyboard.press('Enter');
  await page.keyboard.type('dos');
  assert.equal((await noteTexts(page)).at(-1).replace(/\r/g, ''), 'uno\ndos');
  await page.keyboard.press('Escape');
});

test('a box can be moved with its ✥ handle and deleted with ×', async () => {
  const { page } = b;
  const text = ui(page, '.note .text').first();
  await text.click();
  await page.waitForTimeout(500); // the handles spring in; measure once they've settled
  const before = await text.boundingBox();
  const grip = await ui(page, '.note.selected .grip').boundingBox();
  await page.mouse.move(grip.x + 8, grip.y + 8);
  await page.mouse.down();
  await page.mouse.move(grip.x + 108, grip.y + 48, { steps: 6 });
  await page.mouse.up();
  const moved = await text.boundingBox();
  assert.ok(Math.abs(moved.x - before.x - 100) < 3, `moved right (${moved.x - before.x})`);
  assert.ok(Math.abs(moved.y - before.y - 40) < 3, `moved down (${moved.y - before.y})`);
  await ui(page, '.note.selected .del').click();
  assert.equal((await noteTexts(page)).length, 2);
});

test('with the mode set to Off, clicks go to the reader and text stays', async () => {
  const { page } = b;
  await ui(page, '.modes button[data-mode="off"]').click();
  await page.waitForTimeout(200);
  await page.locator('#next').click();
  assert.equal(await page.evaluate(() => window.nextClicks), 1);
  assert.equal((await noteTexts(page)).length, 2);
  assert.equal(await ui(page, '.note').first().evaluate((n) => getComputedStyle(n).pointerEvents), 'none');
});

test('✕ hides the toolbars but keeps the text', async () => {
  const { page } = b;
  await ui(page, '.toolbar button[title^="Hide toolbar"]').click();
  await page.waitForTimeout(500);
  assert.equal(await ui(page, '.toolbar').evaluate((t) => t.classList.contains('hidden')), true);
  assert.equal(await ui(page, '.panel').evaluate((t) => t.classList.contains('hidden')), true);
  assert.equal((await noteTexts(page)).length, 2);
});

test('Clear removes all text after confirming', async () => {
  const { page, sw } = b;
  await gotoReader(page, sw); // reload: text is never saved
  assert.equal((await noteTexts(page)).length, 0);
  await page.mouse.click(400, 300);
  await page.keyboard.type('borrar');
  page.once('dialog', (d) => d.accept());
  await ui(page, '.toolbar button[title^="Remove all"]').click();
  await page.waitForTimeout(200);
  assert.equal((await noteTexts(page)).length, 0);
});
