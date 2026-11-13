#!/usr/bin/env node
// Mutation check: proves the tests catch bad code.
//
// For each "mutant" below, this copies the extension, plants one realistic bug in
// the copy, and runs the tests that should notice it (with VHL_EXT_DIR pointing at
// the broken copy). Every mutant must make those tests FAIL. If a broken copy
// still passes, the tests have a blind spot and this script exits with an error.
//
//   node scripts/mutation-check.mjs            run every mutant
//   node scripts/mutation-check.mjs keys clip  run mutants whose id contains "keys" or "clip"
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const T = (name) => `tests/e2e/${name}.test.mjs`;
const UNIT = 'tests/unit/release.test.mjs';

// Each mutant: the file to break, the exact code to replace, what to put instead,
// and the tests that must catch it.
export const MUTANTS = [
  {
    id: 'keys-leak',
    why: "typing reaches the reader's keyboard shortcuts (arrow keys would turn the page)",
    file: 'content.js',
    find: '        // from firing while you type. Default actions (typing) still happen.\n        e.stopImmediatePropagation();',
    replace: '        // (mutant) keys are no longer stopped',
    tests: [T('typing'), T('frames-scroll')],
  },
  {
    id: 'clicks-leak',
    why: "clicks in typing mode also press the reader's buttons",
    file: 'content.js',
    find: "if (type !== 'pointerdown' && type !== 'mousedown') e.preventDefault();\n        e.stopImmediatePropagation();",
    replace: "if (type !== 'pointerdown' && type !== 'mousedown') e.preventDefault();",
    tests: [T('typing')],
  },
  {
    id: 'empty-boxes-stay',
    why: 'empty text boxes are left behind',
    file: 'content.js',
    find: "if (prev.textEl.textContent.trim() === '') removeNote(prev);",
    replace: 'if (false) removeNote(prev);',
    also: [['pendingFocus !== note && root.activeElement !== text', 'false && root.activeElement !== text']],
    tests: [T('typing')],
  },
  {
    id: 'scroll-drift',
    why: "text doesn't follow the page when the page viewer scrolls",
    file: 'content.js',
    find: '(scrollY0(a) - n.sy) * scale',
    replace: '0',
    tests: [T('frames-scroll')],
  },
  {
    id: 'no-light-shade',
    why: 'text keeps its dark shade on dark backgrounds (unreadable)',
    file: 'content.js',
    find: 'let best = [fam.light, fam.dark]',
    replace: 'let best = [fam.light]',
    tests: [T('toolbar')],
  },
  {
    id: 'no-outline',
    why: 'no outline on busy pictures',
    file: 'content.js',
    find: 'const needsHalo = bg.busy || best.s < AA;',
    replace: 'const needsHalo = false;',
    tests: [T('toolbar')],
  },
  {
    id: 'no-size-limit',
    why: 'text size can go below the minimum',
    file: 'content.js',
    find: 'const size = Math.max(MIN_SIZE, Math.min(MAX_SIZE, base + delta));',
    replace: 'const size = base + delta;',
    tests: [T('toolbar')],
  },
  {
    id: 'dots-crowded',
    why: 'color dots too close together (selection ring overlaps)',
    file: 'content.js',
    find: 'gap: 14px',
    replace: 'gap: 7px',
    tests: [T('toolbar')],
  },
  {
    id: 'flip-broken',
    why: '⇄ no longer moves the side toolbar',
    file: 'content.js',
    find: '.panel.left { left: 14px; }',
    replace: '.panel.left { }',
    tests: [T('toolbar')],
  },
  {
    id: 'toolbar-in-screenshot',
    why: 'the toolbar shows up in screenshots',
    file: 'content.js',
    find: "toolbar.classList.toggle('hidden', !state.open || capturing);",
    replace: "toolbar.classList.toggle('hidden', !state.open);",
    tests: [T('screenshot')],
  },
  {
    id: 'copy-broken',
    why: 'Copy does not put the picture on the clipboard',
    file: 'content.js',
    find: 'navigator.clipboard.write',
    replace: 'Promise.resolve',
    tests: [T('screenshot')],
  },
  {
    id: 'download-broken',
    why: 'Download opens the picture instead of saving a file',
    file: 'content.js',
    find: 'a.download = name;',
    replace: '',
    tests: [T('screenshot')],
  },
  {
    id: 'tour-repeats',
    why: 'the tour comes back every time after finishing',
    file: 'content.js',
    find: 'chrome.storage.local.set({ tutorialPending: false });',
    replace: '',
    tests: [T('tour')],
  },
  {
    id: 'no-skip',
    why: 'the tour has no Skip button',
    file: 'content.js',
    find: "skip.classList.toggle('reserve', last);\n    row.append(skip);",
    replace: '',
    tests: [T('tour')],
  },
  {
    id: 'no-first-run',
    why: 'installing does not turn on the first-run tour',
    file: 'background.js',
    find: 'chrome.storage.local.set({ tutorialPending: true });',
    replace: '',
    tests: [T('tour')],
  },
  {
    id: 'labels-resize',
    why: 'changing labels (Typing on/off, Copy → Copied, Next/Done) resize their buttons',
    file: 'content.js',
    find: '.stack > span.off { visibility: hidden; }',
    replace: '.stack > span.off { display: none; }',
    tests: [T('layout')],
  },
  {
    id: 'status-pops-in',
    why: 'the screenshot card grows when its status message appears',
    file: 'content.js',
    find: 'margin: 10px 4px 0; height: 2.7em;',
    replace: 'margin: 10px 4px 0;',
    tests: [T('layout')],
  },
  {
    id: 'tour-buttons-jump',
    why: 'tour buttons shift when Back/Skip appear or disappear',
    file: 'content.js',
    find: '.reserve { visibility: hidden !important; pointer-events: none !important; }',
    replace: '.reserve { display: none !important; }',
    tests: [T('layout')],
  },
  {
    id: 'gt-marks-nothing',
    why: 'typing ">" does not start marking letters',
    file: 'content.js',
    find: 'note.markTyping = true;\n        note.markFresh = true;',
    replace: 'note.markFresh = true;',
    tests: [T('marks')],
  },
  {
    id: 'mark-runs-on',
    why: 'a space does not end the mark, so the rest of the sentence gets marked',
    file: 'content.js',
    find: 'endMarkTyping(note); // a space or punctuation ends the mark\n        color = null;',
    replace: 'color = markColor();',
    tests: [T('marks')],
  },
  {
    id: 'sticky-mark',
    why: 'letters typed right after a mark are marked too',
    file: 'content.js',
    find: 'if (!left || left === right) return; // the browser gets this right on its own',
    replace: 'return;',
    tests: [T('marks')],
  },
  {
    id: 'select-colors-box',
    why: 'selecting letters and clicking a color recolors the whole box',
    file: 'background.js',
    find: "const painted = await chrome.tabs.sendMessage(tab.id, { type: 'paint', color: msg.color }).catch(() => false);",
    replace: 'const painted = false;',
    tests: [T('marks')],
  },
  {
    id: 'no-unmark',
    why: 'clicking a marked letter with the highlighter does not unmark it',
    file: 'content.js',
    find: 'const color = start[first].c === mc ? null : mc;',
    replace: 'const color = mc;',
    tests: [T('marks')],
  },
  {
    id: 'highlighter-clicks-leak',
    why: "with the highlighter on, clicks on the page reach the reader's buttons",
    file: 'content.js',
    find: 'if (!(state.typing || state.mark) || capturing) return;',
    replace: 'if (!state.typing || capturing) return;',
    tests: [T('marks')],
  },
  {
    id: 'marks-plain',
    why: 'marked letters are not bold or underlined (hard to see, lost in black-and-white prints)',
    file: 'content.js',
    find: 'font-weight: 800; text-decoration: underline;',
    replace: '',
    tests: [T('marks')],
  },
  {
    id: 'marks-unreadable',
    why: 'marked letters skip the readability check',
    file: 'content.js',
    find: 'const { color, halo } = readableColor(span.dataset.c, note.bg);',
    replace: 'const { dark: color } = family(span.dataset.c); const halo = null;',
    tests: [T('marks')],
  },
  {
    id: 'undo-broken',
    why: 'Ctrl+Z stops working after letters are marked',
    file: 'content.js',
    find: '      undoRedo(note, k === \'z\' && !e.shiftKey);',
    replace: '',
    tests: [T('marks')],
  },
  {
    id: 'mark-button-grows',
    why: 'turning on the 🖍 highlighter makes its button bigger and pushes the toolbar around',
    file: 'content.js',
    find: '.panel button.markbtn { font-size: 17px; }',
    replace: '.panel button.markbtn { font-size: 17px; } .panel button.markbtn.on { height: 44px; }',
    tests: [T('layout')],
  },
  {
    id: 'extra-permission',
    why: 'the extension asks for a permission it should not need',
    file: 'manifest.json',
    find: '"clipboardWrite"',
    replace: '"clipboardWrite",\n    "tabs"',
    tests: [UNIT],
  },
  {
    id: 'syntax-error',
    why: 'a typo breaks the content script',
    file: 'content.js',
    find: 'const MIN_SIZE = 10;',
    replace: 'const MIN_SIZE = 10;}',
    tests: [UNIT, T('typing')],
  },
  {
    id: 'missing-icon',
    why: 'an icon file is missing from the package',
    file: 'manifest.json',
    find: '"48": "icons/icon48.png",\n    "128"',
    replace: '"48": "icons/icon-missing.png",\n    "128"',
    tests: [UNIT],
  },
];

function mutate(m) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vhl-mutant-${m.id}-`));
  fs.cpSync(EXT, dir, { recursive: true });
  const file = path.join(dir, m.file);
  let src = fs.readFileSync(file, 'utf8');
  for (const [find, replace] of [[m.find, m.replace], ...(m.also || [])]) {
    const n = src.split(find).length - 1;
    if (n !== 1) throw new Error(`mutant "${m.id}": expected the code to appear once in ${m.file}, found ${n}. Update the mutant.`);
    src = src.replace(find, () => replace);
  }
  fs.writeFileSync(file, src);
  return dir;
}

function runTests(files, extDir) {
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    cwd: ROOT,
    env: { ...process.env, VHL_EXT_DIR: extDir },
    encoding: 'utf8',
  });
  const failed = (r.stdout.match(/^# fail (\d+)/m) || [])[1];
  return { passed: r.status === 0, failed: Number(failed || 0), output: r.stdout + r.stderr };
}

function main(filters) {
  const list = filters.length ? MUTANTS.filter((m) => filters.some((f) => m.id.includes(f))) : MUTANTS;
  if (!list.length) {
    console.error('No mutants match ' + filters.join(', '));
    process.exit(1);
  }
  console.log(`Planting ${list.length} bugs, one at a time, and checking the tests catch each one…\n`);
  const survivors = [];
  for (const m of list) {
    const t0 = Date.now();
    const dir = mutate(m);
    try {
      const r = runTests(m.tests, dir);
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      if (r.passed) {
        survivors.push(m);
        console.log(`  ✗ NOT CAUGHT  ${m.id.padEnd(22)} ${m.why}  (${secs}s)`);
      } else {
        console.log(`  ✓ caught      ${m.id.padEnd(22)} ${r.failed || 'some'} test(s) failed  (${secs}s)`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log('');
  if (survivors.length) {
    console.error(`✗ ${survivors.length} of ${list.length} planted bugs got past the tests:`);
    for (const m of survivors) console.error(`  - ${m.id}: ${m.why} (ran ${m.tests.join(', ')})`);
    process.exit(1);
  }
  console.log(`✓ The tests caught all ${list.length} planted bugs.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error('✗ ' + e.message);
    process.exit(1);
  }
}
