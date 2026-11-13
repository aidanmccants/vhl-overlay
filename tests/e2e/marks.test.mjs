// Marking letters in a different color (for example a verb ending): select and
// click a color like in Word, the 🖍 highlighter, and ">" while typing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, gotoReader, ui, blank } from '../helpers.mjs';

let b;
before(async () => (b = await launch()));
after(async () => b?.close());

// Each text box as a list of [text, mark color or null] pieces.
const pieces = (page) =>
  page.evaluate(() =>
    [...document.querySelector('vhl-text-overlay').shadowRoot.querySelectorAll('.note .text')].map((t) =>
      [...t.childNodes].filter((n) => n.textContent).map((n) => [n.textContent, n.nodeType === 1 ? n.dataset.c : null])
    )
  );
const last = async (page) => (await pieces(page)).at(-1);

async function newBox(page, n, text) {
  const p = await blank(page, n);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.type(text);
}

test('typing ">" marks the letters that follow: hac>er', async () => {
  const { page, sw } = b;
  await gotoReader(page, sw);
  await newBox(page, 0, 'hac>er');
  assert.deepEqual(await last(page), [['hac', null], ['er', 'red']]);
});

test('a space ends the mark, so the next word is plain again', async () => {
  const { page } = b;
  await page.keyboard.type(' bien');
  assert.deepEqual(await last(page), [['hac', null], ['er', 'red'], [' bien', null]]);
});

test('">>" types a real ">" and marks nothing', async () => {
  const { page } = b;
  await page.keyboard.type(' a>>b');
  assert.deepEqual(await last(page), [['hac', null], ['er', 'red'], [' bien a>b', null]]);
  await page.keyboard.press('Escape');
});

test('marked letters are bold, underlined and readable', async () => {
  const { page } = b;
  const style = await ui(page, '.note .text .mark').first().evaluate((m) => {
    const cs = getComputedStyle(m);
    return { weight: Number(cs.fontWeight), line: cs.textDecorationLine, color: cs.color, base: getComputedStyle(m.parentElement).color };
  });
  assert.ok(style.weight >= 700, `bold (${style.weight})`);
  assert.equal(style.line, 'underline');
  assert.equal(style.color, 'rgb(185, 28, 28)', 'dark red on the white page');
  assert.notEqual(style.color, style.base, 'a different color from the rest of the box');
});

test('like Word: select letters, click a color, and only those letters change', async () => {
  const { page } = b;
  await newBox(page, 1, 'limpie');
  await page.keyboard.press('Shift+ArrowLeft');
  await ui(page, '.panel .swatch[data-color="green"]').click();
  await page.waitForTimeout(200);
  assert.deepEqual(await last(page), [['limpi', null], ['e', 'green']]);
  // The box itself and new boxes keep their color.
  assert.equal(await ui(page, '.panel .swatch.active').getAttribute('data-color'), 'blue');
  assert.equal(await sw0(b), 'blue');
  // Typing after the mark is plain again.
  await page.keyboard.press('End');
  await page.keyboard.type('s');
  assert.deepEqual(await last(page), [['limpi', null], ['e', 'green'], ['s', null]]);
  // Without a selection, the dot recolors the whole box as before.
  await ui(page, '.panel .swatch[data-color="purple"]').click();
  await page.waitForTimeout(200);
  assert.equal(await ui(page, '.panel .swatch.active').getAttribute('data-color'), 'purple');
  assert.equal(await sw0(b), 'purple');
  await ui(page, '.panel .swatch[data-color="blue"]').click();
  await page.keyboard.press('Escape');
});

const sw0 = ({ sw }) =>
  sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://reader.vhlcentral.com/*' });
    return (await chrome.storage.session.get('tab:' + tab.id))['tab:' + tab.id].color;
  });

// Center of letter i of the n-th box.
const letter = (page, n, i) =>
  ui(page, '.note .text').nth(n).evaluate((t, i) => {
    const r = document.createRange();
    let k = 0;
    for (const node of t.childNodes) {
      const tn = node.nodeType === 3 ? node : node.firstChild;
      for (let off = 0; off < tn.textContent.length; off++, k++) {
        if (k === i) {
          r.setStart(tn, off);
          r.setEnd(tn, off + 1);
          const b = r.getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        }
      }
    }
  }, i);

test('highlighter: click a letter to mark it, click again to unmark', async () => {
  const { page } = b;
  await newBox(page, 2, 'bailan');
  await page.keyboard.press('Escape');
  await ui(page, '.panel .markbtn').click();
  assert.equal(await ui(page, '.panel .markbtn').getAttribute('aria-pressed'), 'true');
  assert.equal(await ui(page, '.panel .swatch.active').getAttribute('data-color'), 'red', 'dots now pick the marker color');
  const p = await letter(page, 2, 4);
  await page.mouse.click(p.x, p.y);
  assert.deepEqual(await last(page), [['bail', null], ['a', 'red'], ['n', null]]);
  await page.mouse.click(p.x, p.y);
  assert.deepEqual(await last(page), [['bailan', null]]);
});

test('highlighter: drag across letters to mark them, in the chosen marker color', async () => {
  const { page } = b;
  await ui(page, '.panel .swatch[data-color="orange"]').click();
  const a = await letter(page, 2, 4);
  const z = await letter(page, 2, 5);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + z.x) / 2, a.y, { steps: 3 });
  await page.mouse.move(z.x + 2, z.y, { steps: 3 });
  await page.mouse.up();
  assert.deepEqual(await last(page), [['bail', null], ['an', 'orange']]);
  assert.equal(await sw0(b), 'blue', 'the text color is unchanged');
});

test('highlighter: clicking the page does not add text or reach the reader', async () => {
  const { page } = b;
  const before = (await pieces(page)).length;
  await page.mouse.click(700, 600);
  await page.locator('#next').click({ force: true });
  assert.equal((await pieces(page)).length, before);
  assert.equal(await page.evaluate(() => window.nextClicks || 0), 0);
  assert.equal(await page.evaluate(() => window.readerClicks), 0);
});

test('turning Typing back on ends the highlighter', async () => {
  const { page } = b;
  await ui(page, '.toolbar button').first().click(); // Typing (off -> on)
  await page.waitForTimeout(150);
  assert.equal(await ui(page, '.panel .markbtn').getAttribute('aria-pressed'), 'false');
  assert.match(await ui(page, '.toolbar button').first().getAttribute('aria-label'), /on/);
  const p = await letter(page, 2, 0);
  await page.mouse.click(p.x, p.y); // clicking text edits it again
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  assert.deepEqual(await last(page), [['bail', null], ['an', 'orange'], ['!', null]]);
  await page.keyboard.press('Escape');
});

test('marks work in text boxes inside frames too', async () => {
  const { page } = b;
  const frame = page.frameLocator('#frame');
  const fb = await page.locator('#frame').boundingBox();
  const inner = await frame.locator('.blank').first().boundingBox();
  await page.mouse.click(inner.x + 12, inner.y + inner.height / 2 - 2);
  await page.keyboard.type('com>en');
  const f = page.frames().find((fr) => fr.url().includes('/frame'));
  const got = await f.evaluate(() =>
    [...document.querySelector('vhl-text-overlay').shadowRoot.querySelectorAll('.note .text')].at(-1).innerHTML
  );
  assert.match(got, /^com<span class="mark" data-c="orange"[^>]*>en<\/span>$/, "the marker color chosen earlier");
  // Word-style selection from the side toolbar in the top page reaches the frame.
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await ui(page, '.panel .swatch[data-color="green"]').click();
  await page.waitForTimeout(200);
  const after = await f.evaluate(() =>
    [...document.querySelector('vhl-text-overlay').shadowRoot.querySelectorAll('.note .text')].at(-1).innerHTML
  );
  assert.match(after, /^co<span class="mark" data-c="green"[^>]*>men<\/span>$/);
  assert.ok(fb);
  await page.keyboard.press('Escape');
});
