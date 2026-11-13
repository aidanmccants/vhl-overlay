// Every piece of text in the tour is readable (WCAG AA, 4.5:1) on the tour card, in
// both light and dark mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, gotoReader, ui } from '../helpers.mjs';

async function lowContrast(page) {
  return ui(page, '.tour-pop').evaluate((pop) => {
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
    };
    const over = (top, under) => top.rgb.map((v, i) => v * top.a + under[i] * (1 - top.a));
    const lum = (rgb) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
    };
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    // The card is see-through glass over the page; the test page behind it is light gray.
    const page = parse(getComputedStyle(document.body).backgroundColor).rgb;
    const card = over(parse(getComputedStyle(pop).backgroundColor), page);
    const bad = [];
    for (const el of pop.querySelectorAll('.content *')) {
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!hasText || el.closest('kbd') || (el.closest('button') && !el.closest('button.link'))) continue;
      const c = over(parse(getComputedStyle(el).color), card);
      const r = ratio(c, card);
      if (r < 4.5) bad.push(`"${el.textContent.trim().slice(0, 30)}" ${r.toFixed(2)}:1`);
    }
    return bad;
  });
}

for (const colorScheme of ['light', 'dark']) {
  test(`all tour text is readable in ${colorScheme} mode`, async () => {
    const b = await launch({ colorScheme });
    try {
      const { page, sw } = b;
      await gotoReader(page, sw);
      await ui(page, '.toolbar button[title^="Show the tour"]').click();
      const problems = [];
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(150);
        const title = await ui(page, '.tour-pop h3').textContent();
        for (const p of await lowContrast(page)) problems.push(`step ${i} (${title}): ${p}`);
        if (i < 11) await ui(page, '.tour-pop .row button.primary').click();
      }
      assert.deepEqual(problems, []);
    } finally {
      await b.close();
    }
  });
}
