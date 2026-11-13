// First run: welcome page and the skippable feature tour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, gotoReader, ui } from '../helpers.mjs';

const tourTitle = (page) =>
  page.evaluate(() => {
    const p = document.querySelector('vhl-text-overlay')?.shadowRoot.querySelector('.tour-pop');
    return p && !p.classList.contains('hidden') ? p.querySelector('h3').textContent : null;
  });
const SUPPORT = 'https://buymeacoffee.com/aidanmccants';
const pending = (sw) => sw.evaluate(() => chrome.storage.local.get('tutorialPending').then((r) => r.tutorialPending));

test('installing opens the welcome page and the tour runs through every feature once', async () => {
  const b = await launch({ tour: true });
  try {
    const { ctx, sw, page } = b;
    // launch() closes the welcome tab; it must have been opened by onInstalled.
    assert.equal(await pending(sw), true);
    const welcome = await ctx.newPage();
    await welcome.goto(sw.url().replace('background.js', 'welcome.html'));
    assert.match(await welcome.locator('h1').textContent(), /installed/);
    assert.equal(await welcome.locator('#tour').isChecked(), true);
    // A small, optional support link: on the welcome page and the tour's last step only.
    assert.deepEqual(await welcome.locator('a[href*="buymeacoffee"]').evaluateAll((as) => as.map((a) => [a.href, a.target])), [[SUPPORT, '_blank']]);
    await welcome.close();

    await gotoReader(page, sw);
    await page.waitForTimeout(900);
    assert.match(await tourTitle(page), /Welcome/);
    const titles = [];
    const supportLinks = [];
    for (let i = 0; i < 12; i++) {
      titles.push(await tourTitle(page));
      supportLinks.push(await ui(page, '.tour-pop a[href*="buymeacoffee"]').evaluateAll((as) => as.map((a) => a.href).join()));
      if (i > 0 && i < 10) {
        const ring = await ui(page, '.tour-ring').evaluate((r) => !r.classList.contains('off'));
        if (i !== 2 && i !== 3) assert.ok(ring, `step ${i} highlights its button`);
      }
      await ui(page, '.tour-pop .row button.primary').click();
      await page.waitForTimeout(250);
    }
    assert.deepEqual(titles, [
      'Welcome to VHL Text Overlay 👋', 'Off, Pen or Typing', 'Write anywhere', 'Edit, move or delete', 'Text size',
      'Colors that stay readable', 'Highlight letters', 'Move this toolbar', 'Save a picture of your work', 'Clear', 'Hide the toolbars',
      'You’re all set! 🎉',
    ]);
    assert.deepEqual(supportLinks, [...Array(11).fill(''), SUPPORT], 'support link only on the last step');
    assert.equal(await tourTitle(page), null, 'Done closes the tour');
    assert.equal(await pending(sw), false, 'tour is not shown again');

    await gotoReader(page, sw);
    await page.waitForTimeout(900);
    assert.equal(await tourTitle(page), null, 'no tour after reloading');

    await ui(page, '.toolbar button[title^="Show the tour"]').click();
    await page.waitForTimeout(300);
    assert.match(await tourTitle(page), /Welcome/, '? replays the tour');
    await ui(page, '.tour-pop .row button.link').click();
    await page.waitForTimeout(300);
    assert.equal(await tourTitle(page), null, 'Skip tour closes it');
  } finally {
    await b.close();
  }
});

test('Back goes to the previous step and Skip works from the middle', async () => {
  const b = await launch({ tour: true });
  try {
    const { sw, page } = b;
    await gotoReader(page, sw);
    await page.waitForTimeout(900);
    await ui(page, '.tour-pop .row button.primary').click();
    await ui(page, '.tour-pop .row button.primary').click();
    await page.waitForTimeout(200);
    assert.equal(await tourTitle(page), 'Write anywhere');
    await page.locator('vhl-text-overlay').locator('.tour-pop .row button', { hasText: 'Back' }).click();
    await page.waitForTimeout(200);
    assert.equal(await tourTitle(page), 'Off, Pen or Typing');
    await ui(page, '.tour-pop .row button.link').click();
    assert.equal(await pending(sw), false);
  } finally {
    await b.close();
  }
});

test('turning the tour off on the welcome page skips it', async () => {
  const b = await launch({ tour: true });
  try {
    const { ctx, sw, page } = b;
    const welcome = await ctx.newPage();
    await welcome.goto(sw.url().replace('background.js', 'welcome.html'));
    await welcome.locator('.toggle').click();
    await welcome.waitForTimeout(200);
    assert.equal(await pending(sw), false);
    await welcome.close();
    await gotoReader(page, sw);
    await page.waitForTimeout(1000);
    assert.equal(await tourTitle(page), null);
  } finally {
    await b.close();
  }
});

test('tour and welcome page are in Spanish when Chrome is in Spanish', async () => {
  const b = await launch({ tour: true, locale: 'es-ES' });
  try {
    const { ctx, sw, page } = b;
    const welcome = await ctx.newPage();
    await welcome.goto(sw.url().replace('background.js', 'welcome.html'));
    assert.match(await welcome.locator('h1').textContent(), /instalada/);
    await welcome.close();
    await gotoReader(page, sw);
    await page.waitForTimeout(900);
    assert.match(await tourTitle(page), /Bienvenido/);
  } finally {
    await b.close();
  }
});
