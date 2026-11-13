// The side toolbar: text size, colors that stay readable, and switching sides.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, gotoReader, ui, blank, extensionWithAllUrls, READER } from '../helpers.mjs';

let b;
before(async () => (b = await launch({ ext: extensionWithAllUrls() })));
after(async () => b?.close());

const style = (loc) => loc.evaluate((t) => ({ color: getComputedStyle(t).color, size: getComputedStyle(t).fontSize, halo: t.style.textShadow !== 'none' }));

test('A+ and A− change the size of new text and the selected box', async () => {
  const { page, sw } = b;
  await gotoReader(page, sw);
  const p = await blank(page, 0);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.type('hablo');
  await ui(page, '.panel .big').click();
  await ui(page, '.panel .big').click();
  await page.waitForTimeout(400);
  assert.equal((await style(ui(page, '.note .text').first())).size, '22px');
  assert.equal(await ui(page, '.panel .size').textContent(), '22');
  await ui(page, '.panel .small').click();
  await page.waitForTimeout(400);
  assert.equal((await style(ui(page, '.note .text').first())).size, '20px');
});

test('size stops at the limits', async () => {
  const { page } = b;
  for (let i = 0; i < 30; i++) await ui(page, '.panel .small').click();
  await page.waitForTimeout(300);
  assert.equal(await ui(page, '.panel .size').textContent(), '10');
});

test('picking a color recolors the selected box', async () => {
  const { page } = b;
  await ui(page, '.panel .swatch[data-color="red"]').click();
  await page.waitForTimeout(500);
  assert.equal((await style(ui(page, '.note .text').first())).color, 'rgb(185, 28, 28)');
  assert.equal(await ui(page, '.panel .swatch.active').getAttribute('data-color'), 'red');
});

test('the selection ring around a color dot does not overlap its neighbors', async () => {
  const { page } = b;
  const boxes = await ui(page, '.panel .swatch').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
  for (let i = 1; i < boxes.length; i++) {
    const gap = boxes[i].top - boxes[i - 1].bottom;
    assert.ok(gap >= 10, `gap between dots ${i - 1} and ${i} is ${gap}px`); // ring is about 4px each side
  }
});

test('⇄ moves the side toolbar to the other side and back', async () => {
  const { page } = b;
  const x0 = (await ui(page, '.panel').boundingBox()).x;
  await ui(page, '.panel .flip').click();
  await page.waitForTimeout(900);
  const x1 = (await ui(page, '.panel').boundingBox()).x;
  assert.ok(x0 > 900 && x1 < 40, `moved from ${x0} to ${x1}`);
  await ui(page, '.panel .flip').click();
  await page.waitForTimeout(900);
  assert.ok((await ui(page, '.panel').boundingBox()).x > 900);
});

test('text color adapts to the background so it stays readable', async () => {
  const { page, sw } = b;
  await page.goto(READER + '/contrast');
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://reader.vhlcentral.com/*' });
    const state = { open: true, typing: true, color: 'blue', size: 20, side: 'right' };
    await chrome.storage.session.set({ ['tab:' + tab.id]: state });
    chrome.tabs.sendMessage(tab.id, { type: 'state', state, patch: {} });
  });
  await page.waitForTimeout(500);
  for (const id of ['white', 'dark', 'gray', 'photo']) {
    const r = await page.locator('#' + id).boundingBox();
    await page.mouse.click(r.x + 40, r.y + 80);
    await page.keyboard.type(id);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2500); // pixel checks are rate-limited by Chrome
  const got = await ui(page, '.note .text').evaluateAll((ts) => ts.map((t) => ({ text: t.textContent, color: t.style.color, halo: t.style.textShadow !== 'none' })));
  const by = Object.fromEntries(got.map((g) => [g.text, g]));
  assert.deepEqual(by.white, { text: 'white', color: 'rgb(29, 78, 216)', halo: false }, 'dark blue on white');
  assert.deepEqual(by.dark, { text: 'dark', color: 'rgb(147, 197, 253)', halo: false }, 'light blue on dark');
  assert.equal(by.gray.halo, true, 'outline on mid-gray');
  assert.equal(by.photo.halo, true, 'outline on a busy picture');
});
