// VHL Text Overlay - content script.
// Runs in every vhlcentral.com frame. Draws typed text boxes in an overlay layer
// on top of the page. Nothing is saved: the boxes disappear when the page reloads.
(() => {
  if (window.__vhlOverlayLoaded) return;
  window.__vhlOverlayLoaded = true;

  const IS_TOP = window === window.top;
  // Icons come from Lucide (see icons.js, built by scripts/icons.mjs).
  const ICONS = globalThis.VHL_ICONS || {};
  const ic = (name) =>
    `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  // Tour and tip text writes {{icon-name}} where an icon goes.
  const withIcons = (html) => html.replace(/\{\{([\w-]+)\}\}/g, (_, n) => ic(n));
  // Each color has a shade for light backgrounds and a shade for dark backgrounds.
  // When a text box starts, the shade that's easiest to read there is used.
  const COLORS = [
    { id: 'black', name: 'Black (white on dark backgrounds)', light: '#111827', dark: '#ffffff' },
    { id: 'blue', name: 'Blue', light: '#1d4ed8', dark: '#93c5fd' },
    { id: 'red', name: 'Red', light: '#b91c1c', dark: '#fca5a5' },
    { id: 'green', name: 'Green', light: '#15803d', dark: '#86efac' },
    { id: 'purple', name: 'Purple', light: '#6d28d9', dark: '#d8b4fe' },
    { id: 'orange', name: 'Orange', light: '#c2410c', dark: '#fdba74' },
  ];
  const family = (id) => COLORS.find((c) => c.id === id) || COLORS[1];
  const AA = 4.5; // WCAG AA contrast for normal text
  const MIN_SIZE = 10;
  const MAX_SIZE = 48;

  let state = { open: false, typing: false, pen: false, eraser: false, mark: false, markColor: 'red', color: 'blue', size: 18, side: 'right' };
  let host = null; // shadow host element
  let root = null; // shadow root
  let layer = null; // container for notes
  let toolbar = null;
  let panel = null; // side toolbar with size + color
  let toastEl = null;
  let selected = null; // the note the toolbar's color/size buttons apply to
  let capturing = false;
  let refocusAfterCapture = null;
  let pendingFocus = null; // note created on pointerdown, focused on pointerup/click
  const notes = new Set();
  const strokes = new Set(); // pen drawings (top page only)

  // ---------------------------------------------------------------------------
  // Event shielding. These listeners are registered at document_start, before any
  // of the reader's own scripts, so they run first and can stop the reader from
  // seeing clicks/keys that are meant for us.
  // ---------------------------------------------------------------------------

  const isOurs = (e) => host !== null && e.composedPath().includes(host);

  const POINTER_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick'];
  for (const type of POINTER_EVENTS) {
    window.addEventListener(
      type,
      (e) => {
        if (isOurs(e)) {
          return; // our own UI handles it; the host stops it from bubbling to the page
        }
        if (!(state.typing || state.mark || state.pen) || capturing) return;
        if (e.button !== undefined && e.button !== 0) return; // only left clicks / taps
        if (onScrollbar(e)) return; // let scrollbars keep working
        // Typing mode: the page should not react to this click at all.
        // (pointerdown/mousedown keep their default so the frame still gets focus.)
        if (type !== 'pointerdown' && type !== 'mousedown') e.preventDefault();
        e.stopImmediatePropagation();
        if (type === 'pointerdown') {
          if (state.mark) markHint(); // highlighter: only letters can be clicked
          else if (state.typing) onPageClick(e);
        }
        // Focus the new note once the browser has finished its own mousedown focus handling.
        if ((type === 'pointerup' || type === 'click') && pendingFocus) {
          const n = pendingFocus;
          if (type === 'click') pendingFocus = null;
          if (notes.has(n)) focusEnd(n.textEl);
        }
      },
      true
    );
  }

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyS') {
        e.preventDefault();
        e.stopImmediatePropagation();
        takeScreenshot();
      }
    },
    true
  );

  const KEY_EVENTS = ['keydown', 'keyup', 'keypress'];
  for (const type of KEY_EVENTS) {
    window.addEventListener(
      type,
      (e) => {
        if (state.pen && IS_TOP && isUndoKey(e)) {
          // Pen mode: Ctrl+Z / Ctrl+Shift+Z undo and redo drawing.
          e.preventDefault();
          e.stopImmediatePropagation();
          if (type === 'keydown') inkUndoRedo(e.key.toLowerCase() === 'z' && !e.shiftKey);
          return;
        }
        if (!isOurs(e)) return;
        if (type === 'keydown') onOwnKey(e);
        // Keep the reader's keyboard shortcuts (arrow keys = page turn, etc.)
        // from firing while you type. Default actions (typing) still happen.
        e.stopImmediatePropagation();
      },
      true
    );
  }

  // Other input-ish events that the page shouldn't react to when they come from us.
  for (const type of ['input', 'beforeinput', 'paste', 'copy', 'cut', 'focusin', 'focusout', 'wheel']) {
    window.addEventListener(type, (e) => {
      if (!isOurs(e)) return;
      if (type === 'beforeinput') onOwnBeforeInput(e);
      // Pen mode covers the page with the drawing layer; pass mouse-wheel scrolling
      // through to whatever is underneath.
      if (type === 'wheel' && e.composedPath()[0] === layer) {
        e.preventDefault();
        scrollUnder(e.clientX, e.clientY, e.deltaX, e.deltaY);
      }
      e.stopImmediatePropagation();
    }, { capture: true, passive: false });
  }

  const isUndoKey = (e) => (e.ctrlKey || e.metaKey) && !e.altKey && /^[zy]$/i.test(e.key);

  function onScrollbar(e) {
    const t = e.composedPath()[0];
    if (!(t instanceof Element) || !t.clientWidth) return false;
    const r = t.getBoundingClientRect();
    const sx = t === document.documentElement ? window.innerWidth - t.clientWidth : t.offsetWidth - t.clientWidth;
    const sy = t === document.documentElement ? window.innerHeight - t.clientHeight : t.offsetHeight - t.clientHeight;
    const right = t === document.documentElement ? window.innerWidth : r.right;
    const bottom = t === document.documentElement ? window.innerHeight : r.bottom;
    return (sx > 0 && e.clientX >= right - sx) || (sy > 0 && e.clientY >= bottom - sy);
  }

  // ---------------------------------------------------------------------------
  // UI construction
  // ---------------------------------------------------------------------------

  // "Liquid Glass" look: translucent, blurred, softly lit surfaces with spring-y motion.
  const CSS = `
    :host { all: initial; }
    :host {
      --spring: cubic-bezier(.2, .9, .25, 1.15);
      --ease: cubic-bezier(.25, .8, .25, 1);
      --glass: rgba(255, 255, 255, .58);
      --glass-strong: rgba(255, 255, 255, .78);
      --glass-edge: rgba(255, 255, 255, .7);
      --ink: #0b0b12;
      --ink-soft: rgba(11, 11, 18, .55);
      --chip: rgba(255, 255, 255, .55);
      --chip-hover: rgba(255, 255, 255, .85);
      --accent: #c60e30;
      --shadow: 0 10px 40px rgba(40, 10, 16, .22), 0 2px 8px rgba(40, 10, 16, .12);
      --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, system-ui, sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --glass: rgba(36, 36, 44, .55);
        --glass-strong: rgba(36, 36, 44, .8);
        --glass-edge: rgba(255, 255, 255, .22);
        --ink: #f5f5f7;
        --ink-soft: rgba(245, 245, 247, .6);
        --chip: rgba(255, 255, 255, .12);
        --chip-hover: rgba(255, 255, 255, .24);
        --shadow: 0 10px 40px rgba(0, 0, 0, .5), 0 2px 8px rgba(0, 0, 0, .3);
      }
    }

    .layer { position: fixed; inset: 0; pointer-events: none; overflow: hidden; }
    /* Pen mode: the layer takes the pen/mouse/finger, and dragging draws instead of
       scrolling the page (touch-action: none). */
    .layer.drawing { pointer-events: auto; touch-action: none; cursor: crosshair; }
    .layer.drawing.erasing { cursor: cell; }
    .ink { position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: visible; transform-origin: 0 0; pointer-events: none; }
    .ink path { paint-order: stroke; stroke-linejoin: round; }

    /* ---------- typed text ---------- */
    .note {
      position: absolute; left: 0; top: 0; transform-origin: 0 0;
      pointer-events: none; min-width: 12px;
    }
    .typing .note, .marking .note { pointer-events: auto; }
    /* Highlighter mode: a marker-shaped cursor over the letters */
    .marking .text {
      cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Cpath d='M4 20l3-1 11-11-2-2L5 17z' fill='%23c60e30' stroke='white' stroke-width='1.2'/%3E%3Cpath d='M3 22h8' stroke='%23c60e30' stroke-width='2.4'/%3E%3C/svg%3E") 3 21, crosshair;
      user-select: none;
    }
    .marking .note:hover .text { box-shadow: 0 0 0 1px rgba(198, 14, 48, .45); }
    /* Marked letters: their own color, bold, and underlined (so they also show in
       black-and-white printouts). */
    .text .mark {
      font-weight: 800; text-decoration: underline; text-decoration-thickness: .1em;
      text-underline-offset: .16em; transition: color .25s var(--ease);
    }
    .text {
      font-family: "Segoe Print", "Bradley Hand", "Comic Sans MS", Arial, sans-serif;
      line-height: 1.2; white-space: pre; outline: none; padding: 1px 4px;
      min-width: 8px; min-height: 1.2em; cursor: text; border-radius: 8px;
      font-weight: 600;
      animation: pop .38s var(--spring) both;
      transition: color .35s var(--ease), font-size .25s var(--ease), box-shadow .25s var(--ease), text-shadow .35s var(--ease);
    }
    @keyframes pop { from { opacity: 0; transform: scale(.85); filter: blur(3px); } }
    .typing .note:hover .text { box-shadow: 0 0 0 1px rgba(198, 14, 48, .45); }
    .note.selected .text { box-shadow: 0 0 0 1.5px var(--accent), 0 0 0 4px rgba(255, 255, 255, .7), 0 4px 14px rgba(198, 14, 48, .25); }
    .note.probing { opacity: 0 !important; }
    .grip, .del {
      position: absolute; top: -24px; width: 20px; height: 20px; display: grid; place-items: center;
      font: 600 11px/1 var(--font); color: #fff; border-radius: 50%;
      user-select: none; padding: 0; border: 1px solid rgba(255, 255, 255, .6);
      box-shadow: 0 3px 10px rgba(0, 0, 0, .25), inset 0 1px 0 rgba(255, 255, 255, .6);
      backdrop-filter: blur(10px) saturate(1.6);
      opacity: 0; transform: scale(.4) translateY(6px); pointer-events: none;
      transition: opacity .2s var(--ease), transform .4s var(--spring);
    }
    .grip { left: 0; background: rgba(44, 44, 50, .85); cursor: grab; }
    .grip .ico, .del .ico { width: 12px; height: 12px; }
    .grip:active { cursor: grabbing; }
    .del { left: 24px; background: rgba(255, 59, 48, .88); cursor: pointer; font-size: 13px; }
    .typing .note.selected .grip, .typing .note.selected .del { opacity: 1; transform: none; pointer-events: auto; }
    .typing .note.selected .del { transition-delay: .04s; }
    .grip:hover, .del:hover { transform: scale(1.12) !important; }
    .capturing .text { box-shadow: none !important; background: transparent !important; }
    .capturing .grip, .capturing .del { display: none !important; }

    /* ---------- glass surfaces ---------- */
    .glass {
      position: fixed; pointer-events: auto; color: var(--ink);
      background: var(--glass);
      backdrop-filter: blur(24px) saturate(1.9);
      -webkit-backdrop-filter: blur(24px) saturate(1.9);
      border: 1px solid var(--glass-edge);
      box-shadow: var(--shadow), inset 0 1px 0 rgba(255, 255, 255, .75), inset 0 -1px 0 rgba(255, 255, 255, .15);
      font: 13px/1 var(--font); user-select: none;
      transition: opacity .32s var(--ease), transform .55s var(--spring), filter .32s var(--ease),
        visibility 0s, left .6s var(--spring), top .25s var(--ease);
    }
    /* soft specular highlight across the top, like light on curved glass */
    .glass::before {
      content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
      background: linear-gradient(180deg, rgba(255, 255, 255, .55), rgba(255, 255, 255, 0) 55%);
      mix-blend-mode: soft-light;
    }
    .glass.hidden {
      opacity: 0; visibility: hidden; pointer-events: none; filter: blur(8px);
      transition: opacity .25s var(--ease), transform .35s var(--ease), filter .25s var(--ease),
        visibility 0s .35s, left .6s var(--spring);
    }

    /* Zero layout shift: labels that change (on/off, Copy/Copied, Next/Done) are all
       stacked in one grid cell, so a button is always as wide as its longest label. */
    .stack { display: inline-grid; place-items: center; }
    .stack > span { grid-area: 1 / 1; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; }
    /* Lucide icons */
    .ico { display: block; flex: none; width: 16px; height: 16px; }
    .stack > span.off { visibility: hidden; }
    /* Kept in the layout but invisible, so nothing moves when it's not needed. */
    .reserve { visibility: hidden !important; pointer-events: none !important; }

    .glass button {
      position: relative; font: inherit; color: var(--ink); cursor: pointer; white-space: nowrap;
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      border: 0; background: var(--chip); border-radius: 999px;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .6), 0 1px 2px rgba(0, 0, 0, .08);
      transition: transform .35s var(--spring), background .2s var(--ease), box-shadow .25s var(--ease), color .2s var(--ease);
    }
    .glass button:hover { background: var(--chip-hover); transform: translateY(-1px); }
    .glass button:active { transform: scale(.9); transition-duration: .12s; }
    .glass button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    .toolbar {
      top: 14px; right: 14px; display: flex; align-items: center; gap: 6px;
      padding: 6px 7px; border-radius: 999px;
    }
    .toolbar.hidden { transform: translateY(-14px) scale(.94); }
    .toolbar .drag { cursor: grab; color: var(--ink-soft); padding: 0 1px 0 3px; display: flex; }
    .toolbar .drag .ico { width: 18px; height: 18px; }
    .toolbar button.icon .ico { width: 17px; height: 17px; }
    .toolbar button { padding: 8px 13px; white-space: nowrap; font-weight: 500; }
    .toolbar button.on {
      background: linear-gradient(180deg, #e0294b, #b00c2b); color: #fff;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .45), 0 4px 14px rgba(198, 14, 48, .45);
    }
    .toolbar button.icon { width: 32px; height: 32px; padding: 0; }
    /* Off | Pen | Typing: one pill, the chosen mode lit up. Every segment keeps its
       size, so switching never moves anything. */
    .toolbar .modes { display: flex; gap: 2px; padding: 2px; border-radius: 999px; background: rgba(120, 120, 128, .14); }
    .toolbar .modes button { padding: 7px 11px; background: transparent; box-shadow: none; }
    .toolbar .modes button:hover { background: var(--chip); }
    .toolbar .modes button.on, .toolbar .modes button.on:hover {
      background: linear-gradient(180deg, #e0294b, #b00c2b); color: #fff;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .45), 0 3px 10px rgba(198, 14, 48, .4);
    }
    .toolbar .sep { width: 1px; height: 20px; background: var(--ink-soft); opacity: .25; margin: 0 2px; }

    .panel {
      top: max(64px, calc(50vh - 215px)); left: calc(100% - 108px); width: 94px; box-sizing: border-box;
      display: flex; flex-direction: column; align-items: center; gap: 7px;
      padding: 12px 0; border-radius: 26px;
    }
    .panel.left { left: 14px; }
    .panel.hidden { transform: translateX(18px) scale(.94); }
    .panel.left.hidden { transform: translateX(-18px) scale(.94); }
    .panel button { width: 36px; height: 36px; padding: 0; }
    .panel .big { font-size: 16px; font-weight: 700; }
    .panel .small { font-size: 11px; font-weight: 700; }
    .panel .size { width: 3ch; text-align: center; font-weight: 600; font-variant-numeric: tabular-nums; padding: 1px 0; white-space: nowrap; }
    .panel .size.bump { animation: bump .35s var(--spring); }
    @keyframes bump { 40% { transform: scale(1.3); } }
    .panel .label { font-size: 9.5px; font-weight: 600; color: var(--ink-soft); text-transform: uppercase; letter-spacing: .06em; }
    .panel .sep { height: 1px; width: 26px; background: var(--ink-soft); opacity: .25; margin: 2px 0; }
    .panel .swatch {
      width: 28px; height: 28px; border-radius: 50%;
      box-shadow: 0 0 0 1.5px rgba(255, 255, 255, .85), 0 2px 6px rgba(0, 0, 0, .2), inset 0 1px 1px rgba(255, 255, 255, .5);
    }
    /* Two columns of dots (keeps the toolbar short enough for small laptop screens),
       with room for the selection ring (about 4px around a dot) without touching neighbors. */
    .panel .swatches { display: grid; grid-template-columns: repeat(2, 28px); gap: 14px; padding: 6px 0 4px; }
    .panel .swatch:hover { transform: scale(1.08); }
    .panel .swatch.active {
      transform: scale(1.04);
      box-shadow: 0 0 0 2px rgba(255, 255, 255, .95), 0 0 0 4px var(--accent), 0 3px 10px rgba(198, 14, 48, .3);
    }
    .panel .flip { width: 36px; height: 28px; font-size: 14px; color: var(--ink-soft); }
    .panel .tools { display: flex; gap: 8px; }
    .panel button .ico { width: 18px; height: 18px; }
    .panel .flip .ico { width: 16px; height: 16px; }
    .panel button.markbtn, .panel button.erasebtn { font-size: 17px; }
    .panel button.markbtn.on, .panel button.erasebtn.on {
      color: #fff;
      background: linear-gradient(180deg, #e0294b, #b00c2b);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .45), 0 4px 14px rgba(198, 14, 48, .45);
    }

    .toast {
      left: 50%; bottom: 28px; transform: translateX(-50%);
      display: flex; align-items: center; gap: 10px;
      padding: 11px 18px; border-radius: 999px; max-width: 80vw;
      font: 500 13.5px/1.35 var(--font);
      background: var(--glass-strong);
    }
    .toast.hidden { transform: translate(-50%, 24px) scale(.92); }
    .toast.error { color: #fff; background: rgba(215, 38, 38, .82); }

    /* screenshot card: preview + Copy / Download */
    .shotcard {
      left: 50%; bottom: 24px; transform: translateX(-50%); width: min(340px, calc(100vw - 24px));
      box-sizing: border-box; padding: 12px; border-radius: 26px; background: var(--glass-strong);
    }
    .shotcard.hidden { transform: translate(-50%, 30px) scale(.9); }
    .shotcard img {
      display: block; width: 100%; max-height: 190px; object-fit: contain; border-radius: 16px;
      background: rgba(0, 0, 0, .06); box-shadow: 0 2px 10px rgba(0, 0, 0, .15);
    }
    .shotcard:not(.hidden) img { animation: develop .6s var(--ease) both; }
    @keyframes develop { from { opacity: 0; transform: scale(1.04); filter: brightness(1.6) blur(4px); } }
    .shotcard .title .ico { width: 18px; height: 18px; }
    .shotcard .title { display: flex; align-items: center; gap: 8px; margin: 2px 4px 10px; font: 600 14px/1.2 var(--font); }
    .shotcard .title .grow { flex: 1; }
    .shotcard .title button { width: 28px; height: 28px; padding: 0; font-size: 12px; }
    .shotcard .actions { display: flex; gap: 8px; margin-top: 12px; }
    .shotcard .actions button { flex: 1; padding: 10px 12px; font-weight: 600; font-size: 13.5px; }
    .shotcard .actions button.primary { background: linear-gradient(180deg, #e0294b, #b00c2b); color: #fff;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .45), 0 4px 14px rgba(198, 14, 48, .4); }
    .shotcard .actions button.done { background: rgba(52, 199, 89, .9); color: #fff; }
    /* Two lines are always reserved for the status, so the card never grows. */
    .shotcard .status {
      margin: 10px 4px 0; height: 2.7em; font: 13px/1.35 var(--font); color: var(--ink-soft);
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere;
    }
    .toast .ico { width: 16px; height: 16px; }
    .toast button { padding: 6px 12px; font-weight: 600; background: var(--accent); color: #fff; }

    /* ---------- first-time tour ---------- */
    .tour-ring {
      position: fixed; pointer-events: none; border-radius: 18px;
      box-shadow: 0 0 0 3px rgba(198, 14, 48, .95), 0 0 0 9px rgba(198, 14, 48, .25), 0 0 34px 8px rgba(198, 14, 48, .35);
      transition: left .55s var(--spring), top .55s var(--spring), width .55s var(--spring), height .55s var(--spring),
        opacity .3s var(--ease), border-radius .4s var(--ease);
      animation: breathe 2.2s ease-in-out infinite;
    }
    @keyframes breathe { 50% { box-shadow: 0 0 0 3px rgba(198, 14, 48, .95), 0 0 0 13px rgba(198, 14, 48, .12), 0 0 44px 12px rgba(198, 14, 48, .28); } }
    .tour-ring.off { opacity: 0; }
    .tour-pop {
      width: min(320px, calc(100vw - 24px)); box-sizing: border-box; padding: 16px 16px 14px;
      border-radius: 24px; background: var(--glass-strong);
      transition: opacity .3s var(--ease), transform .5s var(--spring), filter .3s var(--ease),
        left .55s var(--spring), top .55s var(--spring), visibility 0s;
    }
    .tour-pop.hidden { transform: scale(.94) translateY(8px); }
    .tour-pop .content { animation: swap .4s var(--ease); }
    @keyframes swap { from { opacity: 0; transform: translateY(6px); } }
    .tour-pop .count { white-space: nowrap; font-size: 11px; font-weight: 600; color: var(--ink-soft); letter-spacing: .04em; text-transform: uppercase; }
    .tour-pop h3 { margin: 6px 0 6px; font: 700 17px/1.25 var(--font); }
    .tour-pop p { margin: 0; font: 14px/1.45 var(--font); }
    .tour-pop p + p { margin-top: 8px; }
    .tour-pop .content .ico { display: inline-block; width: 1.05em; height: 1.05em; vertical-align: -.17em; }
    /* Small and quiet: an optional way to support the project (last step only). */
    .tour-pop p.support { margin-top: 12px; font-size: 12px; }
    .tour-pop .support a { color: var(--ink-soft); text-decoration: none; }
    .tour-pop .support a:hover { color: var(--ink); text-decoration: underline; }
    .tour-pop .try { margin-top: 10px; padding: 8px 11px; border-radius: 14px; font: 500 13px/1.4 var(--font);
      background: rgba(198, 14, 48, .12); color: var(--ink); }
    .tour-pop kbd { font: 600 11.5px/1 var(--font); padding: 2px 6px; border-radius: 6px; background: var(--chip);
      box-shadow: inset 0 -1px 0 rgba(0, 0, 0, .15); }
    .tour-pop .dots { display: flex; gap: 5px; margin: 14px 0 12px; }
    .tour-pop .dot { width: 6px; height: 6px; border-radius: 3px; background: var(--ink-soft); opacity: .3;
      transition: width .4s var(--spring), opacity .3s var(--ease), background .3s; }
    .tour-pop .dot.on { width: 18px; opacity: 1; background: var(--accent); }
    .tour-pop .row { display: flex; align-items: center; gap: 8px; }
    .tour-pop .row .grow { flex: 1; }
    .tour-pop .row button { padding: 8px 14px; font-weight: 600; }
    .tour-pop .row button.primary { background: linear-gradient(180deg, #e0294b, #b00c2b); color: #fff;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .45), 0 4px 14px rgba(198, 14, 48, .4); }
    .tour-pop .row button.link { background: none; box-shadow: none; color: var(--ink-soft); padding: 8px 6px; font-weight: 500; }
    .tour-pop .row button.link:hover { color: var(--ink); transform: none; }

    /* screenshots: hide instantly, no fading into the picture */
    :host([data-capturing]) * { transition: none !important; animation: none !important; }

    @media (prefers-reduced-motion: reduce) {
      *, *::before { transition-duration: .01ms !important; animation: none !important; }
    }
  `;

  function ensureUI() {
    if (host) return;
    host = document.createElement('vhl-text-overlay');
    host.style.cssText =
      'position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;';
    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    layer = document.createElement('div');
    layer.className = 'layer';
    root.appendChild(layer);
    layer.addEventListener('pointerdown', onLayerPointerDown);

    // Stop our UI's events from bubbling up into the reader's own handlers.
    for (const type of [...POINTER_EVENTS, 'pointermove', 'mousemove', 'contextmenu', 'touchstart', 'touchend']) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }

    if (IS_TOP) buildToolbar();
    (document.body || document.documentElement).appendChild(host);
    keepAttached();
    requestAnimationFrame(tick); // start the positioning loop
  }

  // Some single-page apps wipe <body>; put our layer back if that happens.
  function keepAttached() {
    new MutationObserver(() => {
      if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // A button with an optional Lucide icon in front of its label (or alone).
  function btn(label, title, onClick, cls, icon) {
    const b = document.createElement('button');
    b.type = 'button';
    if (icon) {
      b.innerHTML = ic(icon);
      if (label) b.append(Object.assign(document.createElement('span'), { textContent: label }));
      else b.setAttribute('aria-label', title);
    } else {
      b.textContent = label;
    }
    b.title = title;
    if (cls) b.className = cls;
    // pointerdown default would steal focus from the note being edited
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', onClick);
    return b;
  }

  // Give a button several labels stacked in one spot (see .stack in the CSS); only
  // one is visible, but the button is always sized for the longest.
  // A label is text, or [icon, text].
  function stack(b, labels) {
    b.textContent = '';
    const box = document.createElement('span');
    box.className = 'stack';
    b.append(box);
    b._labels = labels.map((l) => {
      const span = document.createElement('span');
      if (Array.isArray(l)) {
        span.innerHTML = ic(l[0]);
        span.append(l[1]);
      } else {
        span.textContent = l;
      }
      box.append(span);
      return span;
    });
    setStack(b, 0);
    return b;
  }
  function setStack(b, i) {
    b._labels.forEach((span, j) => span.classList.toggle('off', j !== i));
    b.setAttribute('aria-label', b._labels[i].textContent);
  }

  let ui = {};
  function buildToolbar() {
    toolbar = document.createElement('div');
    toolbar.className = 'glass toolbar hidden';

    const drag = document.createElement('span');
    drag.className = 'drag';
    drag.innerHTML = ic('grip-vertical');
    drag.title = 'Drag to move the toolbar';
    makeDraggable(drag, toolbar, null);

    // Mode selector: Off (use the textbook) | Pen (draw) | Typing (add text).
    ui.modes = document.createElement('div');
    ui.modes.className = 'modes';
    ui.modes.setAttribute('role', 'group');
    ui.modes.setAttribute('aria-label', L('Mode', 'Modo'));
    ui.mode = {
      off: btn(L('Off', 'Apagado'), L('Use the textbook normally (turn pages, click its buttons). Your work stays on the page.',
        'Use el libro con normalidad (pasar páginas, pulsar botones). Su trabajo se queda en la página.'), () => setMode('off'), '', 'mouse-pointer-2'),
      pen: btn(L('Pen', 'Lápiz'), L('Draw on the page with a pen, mouse or finger',
        'Dibuje en la página con un lápiz, el ratón o el dedo'), () => setMode('pen'), '', 'pen-line'),
      typing: btn('Typing', L('Click anywhere on the page to add text (Alt+Shift+T closes the toolbar)',
        'Haga clic en cualquier lugar para añadir texto (Alt+Mayús+T cierra la barra)'), () => setMode('typing'), '', 'type'),
    };
    for (const [m, b] of Object.entries(ui.mode)) {
      b.dataset.mode = m;
      ui.modes.append(b);
    }

    ui.shot = btn('Screenshot', 'Take a screenshot with your text, then copy or download it (Alt+Shift+S)', () => takeScreenshot(), '', 'camera');
    ui.clear = btn('Clear', 'Remove all text boxes and drawings', () => {
      if (confirm('Remove all of your typed text and drawings from this page?')) chrome.runtime.sendMessage({ cmd: 'clear-all' });
    }, '', 'trash-2');
    ui.close = btn('', 'Hide toolbar (your text stays on the page)', () => sendState({ open: false, typing: false, pen: false, mark: false }), 'icon', 'x');

    const sep = () => Object.assign(document.createElement('span'), { className: 'sep' });
    ui.help = btn('', 'Show the tour of every feature again', () => startTour(), 'icon', 'circle-help');
    toolbar.append(drag, ui.modes, sep(), ui.shot, ui.clear, ui.help, ui.close);
    root.appendChild(toolbar);

    // Side toolbar: text size and color.
    panel = document.createElement('div');
    panel.className = 'glass panel hidden';
    const label = (t) => Object.assign(document.createElement('div'), { className: 'label', textContent: t });
    const hsep = () => Object.assign(document.createElement('div'), { className: 'sep' });
    ui.bigger = btn('A+', 'Bigger text', () => changeSize(2), 'big');
    ui.size = document.createElement('div');
    ui.size.className = 'size';
    ui.size.title = 'Text size';
    ui.smaller = btn('A−', 'Smaller text', () => changeSize(-2), 'small');
    ui.swatches = COLORS.map((c) => {
      const sw = btn('', c.name + ' (switches to a lighter or darker shade automatically so it stays readable)', () => pickColor(c.id), 'swatch');
      // left half: shade used on light backgrounds; right half: shade used on dark ones
      sw.style.background = `linear-gradient(135deg, ${c.light} 0 55%, ${c.dark} 55% 100%)`;
      sw.dataset.color = c.id;
      return sw;
    });
    ui.mark = btn('', L('Highlighter: click or drag across letters to mark them (click again to unmark)',
      'Marcador: haga clic o arrastre sobre las letras para marcarlas (otro clic las desmarca)'), () =>
      sendState(state.mark ? { mark: false, typing: true } : { mark: true, typing: false, pen: false }), 'markbtn', 'highlighter');
    ui.eraser = btn('', L('Eraser: touch a drawing to erase it (a Surface Pen’s eraser end works too)',
      'Borrador: toque un dibujo para borrarlo (también funciona el extremo borrador del lápiz)'), () =>
      sendState(state.pen && state.eraser ? { eraser: false } : { eraser: true, pen: true, typing: false, mark: false }), 'erasebtn', 'eraser');
    const tools = document.createElement('div');
    tools.className = 'tools';
    tools.append(ui.mark, ui.eraser);
    ui.flip = btn('', 'Move this toolbar to the other side of the screen', () =>
      sendState({ side: state.side === 'left' ? 'right' : 'left' }), 'flip', 'arrow-left-right');
    const swatchGroup = document.createElement('div');
    swatchGroup.className = 'swatches';
    swatchGroup.append(...ui.swatches);
    panel.append(label('Size'), ui.bigger, ui.size, ui.smaller, hsep(), label(L('Tools', 'Útiles')), tools, hsep(), label('Color'), swatchGroup, hsep(), ui.flip);
    root.appendChild(panel);

    toastEl = document.createElement('div');
    toastEl.className = 'glass toast hidden';
    root.appendChild(toastEl);
  }

  function changeSize(delta) {
    const base = selected ? selected.size : state.size;
    const size = Math.max(MIN_SIZE, Math.min(MAX_SIZE, base + delta));
    sendState({ size });
  }

  // A color dot was clicked. If letters are selected in a text box, only those
  // letters change (like Word). In highlighter mode it picks the marker color.
  // Otherwise it's the color for the whole box and for new text.
  const markColor = () => state.markColor || 'red';

  function pickColor(id) {
    if (state.mark) return sendState({ markColor: id });
    chrome.runtime.sendMessage({ cmd: 'pick-color', color: id });
  }

  function setMode(m) {
    sendState({ typing: m === 'typing', pen: m === 'pen', mark: false, eraser: false });
  }

  function sendState(patch) {
    chrome.runtime.sendMessage({ cmd: 'set-state', patch });
  }

  function render() {
    if (!host) return;
    layer.classList.toggle('typing', state.typing && !capturing);
    layer.classList.toggle('marking', !!state.mark && !capturing);
    // Drawing happens in the top page's layer, which covers frames too.
    layer.classList.toggle('drawing', !!state.pen && IS_TOP && !capturing);
    layer.classList.toggle('erasing', !!state.pen && !!state.eraser);
    if (!state.typing) selectNote(null);
    if (toolbar) {
      toolbar.classList.toggle('hidden', !state.open || capturing);
      const mode = state.pen ? 'pen' : state.typing ? 'typing' : state.mark ? null : 'off';
      for (const [m, b] of Object.entries(ui.mode)) {
        b.classList.toggle('on', m === mode);
        b.setAttribute('aria-pressed', String(m === mode));
      }
      ui.eraser.classList.toggle('on', !!state.pen && !!state.eraser);
      ui.eraser.setAttribute('aria-pressed', String(!!state.pen && !!state.eraser));
      panel.classList.toggle('hidden', !state.open || capturing);
      panel.classList.toggle('left', state.side === 'left');
      const sizeText = String(selected ? selected.size : state.size);
      if (ui.size.textContent && ui.size.textContent !== sizeText) {
        ui.size.classList.remove('bump');
        void ui.size.offsetWidth; // restart the little "bump" animation
        ui.size.classList.add('bump');
      }
      ui.size.textContent = sizeText;
      ui.mark.classList.toggle('on', !!state.mark);
      ui.mark.setAttribute('aria-pressed', String(!!state.mark));
      const cur = family(state.mark ? markColor() : selected ? selected.color : state.color).id;
      for (const s of ui.swatches) s.classList.toggle('active', s.dataset.color === cur);
      if (tour && (!state.open || capturing)) hideTour(!state.open);
      else if (tour) showTourEls();
      maybeStartFirstTour();
    }
  }

  // ---------------------------------------------------------------------------
  // First-time tour: a short, skippable walkthrough of every feature. It starts
  // the first time the toolbars open after installing, and the "?" button
  // replays it.
  // ---------------------------------------------------------------------------

  const ES = /^es\b/i.test(navigator.language || '');
  const L = (en, es) => (ES ? es : en);
  const MOD = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const kbd = (k) => `<kbd>${k}</kbd>`;

  let tour = null; // { i, cacheFor, els }
  let tourRing = null;
  let tourPop = null;
  let tourChecked = false;

  const unionRect = (els) => {
    const rs = els
      .filter(Boolean)
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width || r.height);
    if (!rs.length) return null;
    const left = Math.min(...rs.map((r) => r.left));
    const top = Math.min(...rs.map((r) => r.top));
    const right = Math.max(...rs.map((r) => r.right));
    const bottom = Math.max(...rs.map((r) => r.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };
  const latestNote = () =>
    [...notes].reverse().find((n) => n.textEl.textContent.trim() && n.el.style.display !== 'none');

  const TOUR_STEPS = [
    {
      place: 'center',
      title: L('Welcome to VHL Text Overlay', 'Bienvenido a VHL Text Overlay'),
      body: L(
        '<p>Here’s a one-minute tour of everything it can do. You can try each thing as you go.</p><p>You can skip the tour now, or any time.</p>',
        '<p>Este es un recorrido de un minuto por todo lo que puede hacer. Puede probar cada cosa sobre la marcha.</p><p>Puede saltarse el recorrido ahora o en cualquier momento.</p>'
      ),
      next: L('Start the tour', 'Empezar'),
    },
    {
      target: () => [ui.modes],
      title: L('Off, Pen or Typing', 'Apagado, Lápiz o Typing'),
      body: L(
        '<p><b>{{type}} Typing</b>: click the page to add text.</p><p><b>{{pen-line}} Pen</b>: draw with a pen, mouse or finger. Press harder for thicker lines. Flip a Surface Pen over to erase.</p><p><b>{{mouse-pointer-2}} Off</b>: use the textbook normally. Your work stays on the page.</p>',
        '<p><b>{{type}} Typing</b>: haga clic en la página para añadir texto.</p><p><b>{{pen-line}} Lápiz</b>: dibuje con un lápiz, el ratón o el dedo. Si aprieta más, la línea es más gruesa. Dé la vuelta al lápiz de Surface para borrar.</p><p><b>{{mouse-pointer-2}} Apagado</b>: use el libro con normalidad. Su trabajo se queda en la página.</p>'
      ),
    },
    {
      place: 'bottom',
      title: L('Write anywhere', 'Escriba donde quiera'),
      body: L(
        `<p>Click any spot on the page and type. Click somewhere else to start another piece of text.</p><p>${kbd('Enter')} starts a new line. ${kbd('Esc')} finishes.</p><div class="try">Try it now: click a blank on the page and type a word.</div>`,
        `<p>Haga clic en cualquier lugar de la página y escriba. Haga clic en otro sitio para empezar otro texto.</p><p>${kbd('Intro')} empieza una línea nueva. ${kbd('Esc')} termina.</p><div class="try">Pruébelo: haga clic en un espacio en blanco y escriba una palabra.</div>`
      ),
    },
    {
      target: () => {
        const n = latestNote();
        if (!n) return null;
        selectNote(n);
        return [n.textEl, n.el.querySelector('.grip'), n.el.querySelector('.del')];
      },
      place: 'bottom',
      title: L('Edit, move or delete', 'Editar, mover o borrar'),
      body: L(
        '<p>Click your text to change it.</p><p>Drag the dark gray <b>{{move}}</b> handle to move it, or click the red <b>{{x}}</b> to delete it.</p><p>Your text sticks to the page when you scroll or zoom.</p>',
        '<p>Haga clic en su texto para cambiarlo.</p><p>Arrastre el círculo gris oscuro <b>{{move}}</b> para moverlo, o pulse la <b>{{x}}</b> roja para borrarlo.</p><p>El texto se queda pegado a la página al desplazarse o ampliar.</p>'
      ),
    },
    {
      target: () => [ui.bigger, ui.size, ui.smaller],
      title: L('Text size', 'Tamaño del texto'),
      body: L(
        '<p><b>A+</b> makes text bigger and <b>A−</b> makes it smaller.</p><p>To resize something you already wrote, click it first.</p>',
        '<p><b>A+</b> agranda el texto y <b>A−</b> lo hace más pequeño.</p><p>Para cambiar algo que ya escribió, haga clic en ello primero.</p>'
      ),
    },
    {
      target: () => ui.swatches,
      title: L('Colors that stay readable', 'Colores que siempre se leen'),
      body: L(
        '<p>Pick a color for your text. Each dot shows two shades.</p><p>The tool checks what’s behind your text and uses the shade that’s easiest to read. On photos it adds a thin outline.</p>',
        '<p>Elija un color para su texto. Cada punto muestra dos tonos.</p><p>La herramienta mira lo que hay detrás del texto y usa el tono que mejor se lee. Sobre fotos añade un contorno fino.</p>'
      ),
    },
    {
      target: () => [ui.mark],
      title: L('Highlight letters', 'Resaltar letras'),
      body: L(
        `<p>Show a verb ending in another color, like <b>limpi<u style="color:#b91c1c">e</u></b>. Three ways:</p><p>• Type ${kbd('&gt;')} before the letters: <b>hac&gt;er</b> gives <b>hac<u style="color:#b91c1c">er</u></b>. A space ends it (${kbd('&gt;&gt;')} types a real &gt;).<br>• Select letters in your text, then click a color dot.<br>• Click <b>{{highlighter}}</b>, then click or drag across letters. Click again to unmark.</p>`,
        `<p>Muestre una terminación verbal en otro color, como <b>limpi<u style="color:#b91c1c">e</u></b>. Tres maneras:</p><p>• Escriba ${kbd('&gt;')} antes de las letras: <b>hac&gt;er</b> da <b>hac<u style="color:#b91c1c">er</u></b>. Un espacio lo termina (${kbd('&gt;&gt;')} escribe un &gt; de verdad).<br>• Seleccione letras de su texto y pulse un punto de color.<br>• Pulse <b>{{highlighter}}</b> y haga clic o arrastre sobre las letras. Otro clic las desmarca.</p>`
      ),
    },
    {
      target: () => [ui.flip],
      title: L('Move this toolbar', 'Mover esta barra'),
      body: L(
        '<p><b>{{arrow-left-right}}</b> moves the size and color toolbar to the other side of the screen if it’s in your way.</p>',
        '<p><b>{{arrow-left-right}}</b> mueve la barra de tamaño y color al otro lado de la pantalla si le molesta.</p>'
      ),
    },
    {
      target: () => [ui.shot],
      title: L('Save a picture of your work', 'Guardar una imagen de su trabajo'),
      body: L(
        `<p>Click <b>{{camera}} Screenshot</b>. Chrome asks to <b>share this tab</b>: click <b>Share</b>. Nothing is recorded or sent anywhere.</p><p>Then choose <b>Copy</b> (paste it anywhere with ${kbd(MOD + '+V')}) or <b>Download</b> (saves a picture file).</p><p>Shortcut: ${kbd('Alt+Shift+S')}</p>`,
        `<p>Pulse <b>{{camera}} Screenshot</b>. Chrome pregunta si quiere <b>compartir esta pestaña</b>: pulse <b>Compartir</b>. No se graba ni se envía nada.</p><p>Luego elija <b>Copiar</b> (péguela donde quiera con ${kbd(MOD + '+V')}) o <b>Descargar</b> (guarda un archivo de imagen).</p><p>Atajo: ${kbd('Alt+Mayús+S')}</p>`
      ),
    },
    {
      target: () => [ui.clear],
      title: L('Clear', 'Borrar todo'),
      body: L(
        '<p><b>{{trash-2}} Clear</b> erases all of your text on the page.</p><p>Remember: text is never saved. Refreshing the page erases it too, so copy a picture first.</p>',
        '<p><b>{{trash-2}} Clear</b> borra todo su texto de la página.</p><p>Recuerde: el texto nunca se guarda. Al recargar la página también se borra, así que copie una imagen antes.</p>'
      ),
    },
    {
      target: () => [ui.close],
      title: L('Hide the toolbars', 'Ocultar las barras'),
      body: L(
        `<p><b>{{x}}</b> hides both toolbars. Your text stays on the page.</p><p>To bring them back, click the <b>T</b> button at the top right of Chrome, or press ${kbd('Alt+Shift+T')}.</p>`,
        `<p><b>{{x}}</b> oculta las dos barras. Su texto se queda en la página.</p><p>Para que vuelvan, pulse el botón <b>T</b> arriba a la derecha de Chrome o ${kbd('Alt+Mayús+T')}.</p>`
      ),
    },
    {
      target: () => [ui.help],
      title: L('You’re all set!', '¡Todo listo!'),
      body: L(
        '<p>Want to see this tour again? Click <b>{{circle-help}}</b> any time.</p><p class="support"><a href="https://buymeacoffee.com/aidanmccants" target="_blank" rel="noopener">Enjoying it? {{coffee}} Buy me a coffee</a></p>',
        '<p>¿Quiere ver este recorrido otra vez? Pulse <b>{{circle-help}}</b> cuando quiera.</p><p class="support"><a href="https://buymeacoffee.com/aidanmccants" target="_blank" rel="noopener">¿Le resulta útil? {{coffee}} Invíteme a un café</a></p>'
      ),
      next: L('Done', 'Terminar'),
    },
  ];

  function maybeStartFirstTour() {
    if (tourChecked || !IS_TOP || !state.open) return;
    tourChecked = true;
    chrome.storage.local.get('tutorialPending', (r) => {
      if (!chrome.runtime.lastError && r && r.tutorialPending) {
        setTimeout(() => state.open && !tour && startTour(), 650); // after the toolbars glide in
      }
    });
  }

  function buildTour() {
    if (tourPop) return;
    tourRing = document.createElement('div');
    tourRing.className = 'tour-ring off';
    tourPop = document.createElement('div');
    tourPop.className = 'glass tour-pop hidden';
    tourPop.setAttribute('role', 'dialog');
    tourPop.setAttribute('aria-label', L('Feature tour', 'Recorrido'));
    root.append(tourRing, tourPop);
  }

  function startTour() {
    if (!IS_TOP) return;
    ensureUI();
    buildTour();
    tour = { i: 0 };
    if (!state.open || !state.typing) sendState({ open: true, typing: true, pen: false, mark: false });
    showTourStep();
  }

  function endTour() {
    if (!tour) return;
    tour = null;
    chrome.storage.local.set({ tutorialPending: false });
    tourPop.classList.add('hidden');
    tourRing.classList.add('off');
  }

  // Toolbars closed (ends the tour) or a screenshot in progress (pauses it).
  function hideTour(end) {
    if (end) return endTour();
    tourPop.classList.add('hidden');
    tourRing.classList.add('off');
  }
  function showTourEls() {
    if (tourPop.classList.contains('hidden')) showTourStep();
  }

  function showTourStep() {
    const step = TOUR_STEPS[tour.i];
    const n = TOUR_STEPS.length;
    const last = tour.i === n - 1;
    tour.cacheFor = -1;
    tourPop.innerHTML = '';
    const content = document.createElement('div');
    content.className = 'content';
    content.innerHTML =
      // The step counter keeps its line on the first step too (hidden), so nothing jumps.
      `<div class="count${tour.i > 0 ? '' : ' reserve'}">${L('Step', 'Paso')} ${Math.max(1, tour.i)} ${L('of', 'de')} ${n - 1}</div>` +
      `<h3>${step.title}</h3>${withIcons(step.body)}` +
      `<div class="dots">${TOUR_STEPS.map((_, j) => `<span class="dot${j === tour.i ? ' on' : ''}"></span>`).join('')}</div>`;
    const row = document.createElement('div');
    row.className = 'row';
    // Skip and Back are always there (just invisible when they don't apply) so the
    // buttons never shift between steps.
    const skip = btn(L('Skip tour', 'Saltar'), L('Skip the tour', 'Saltar el recorrido'), () => endTour(), 'link');
    skip.classList.toggle('reserve', last);
    row.append(skip);
    const grow = document.createElement('span');
    grow.className = 'grow';
    row.append(grow);
    const back = btn(L('Back', 'Atrás'), L('Back', 'Atrás'), () => goTour(-1));
    back.classList.toggle('reserve', tour.i === 0);
    row.append(back);
    const next = stack(btn('', '', () => (last ? endTour() : goTour(1)), 'primary'), [
      TOUR_STEPS[0].next,
      L('Next', 'Siguiente'),
      TOUR_STEPS[n - 1].next,
    ]);
    setStack(next, tour.i === 0 ? 0 : last ? 2 : 1);
    row.append(next);
    content.append(row);
    tourPop.append(content);
    tourPop.classList.remove('hidden');
    positionTour();
  }

  function goTour(d) {
    if (!tour) return;
    tour.i = Math.max(0, Math.min(TOUR_STEPS.length - 1, tour.i + d));
    showTourStep();
  }

  // Runs every frame while the tour is open so the ring follows its target
  // (for example while the side toolbar glides to the other side).
  function positionTour() {
    if (!tour || tourPop.classList.contains('hidden')) return;
    const step = TOUR_STEPS[tour.i];
    let rect = null;
    if (step.target) {
      if (tour.cacheFor !== tour.i) {
        tour.cacheFor = tour.i;
        tour.els = step.target();
      }
      rect = tour.els ? unionRect(tour.els) : null;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const m = 12;
    const pw = tourPop.offsetWidth;
    const ph = tourPop.offsetHeight;
    let x;
    let y;
    if (rect) {
      const pad = 7;
      tourRing.classList.remove('off');
      Object.assign(tourRing.style, {
        left: rect.left - pad + 'px',
        top: rect.top - pad + 'px',
        width: rect.width + pad * 2 + 'px',
        height: rect.height + pad * 2 + 'px',
        borderRadius: Math.min(26, (rect.height + pad * 2) / 2) + 'px',
      });
      const gap = 18;
      const below = rect.bottom + pad + gap;
      const above = rect.top - pad - gap - ph;
      const leftOf = rect.left - pad - gap - pw;
      const rightOf = rect.right + pad + gap;
      if (below + ph <= vh - m) [x, y] = [rect.left + rect.width / 2 - pw / 2, below];
      else if (leftOf >= m) [x, y] = [leftOf, rect.top + rect.height / 2 - ph / 2];
      else if (rightOf + pw <= vw - m) [x, y] = [rightOf, rect.top + rect.height / 2 - ph / 2];
      else [x, y] = [rect.left + rect.width / 2 - pw / 2, above];
    } else {
      tourRing.classList.add('off');
      x = vw / 2 - pw / 2;
      y = step.place === 'bottom' ? vh - ph - 28 : vh / 2 - ph / 2;
    }
    tourPop.style.left = Math.round(Math.max(m, Math.min(vw - pw - m, x))) + 'px';
    tourPop.style.top = Math.round(Math.max(m, Math.min(vh - ph - m, y))) + 'px';
  }

  let toastTimer = null;
  function toast(text, isError, action) {
    if (!toastEl) return;
    toastEl.textContent = text;
    if (action) toastEl.append(btn(action.label, action.label, action.onClick));
    toastEl.classList.toggle('error', !!isError);
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), action ? 15000 : isError ? 6000 : 3000);
  }

  // ---------------------------------------------------------------------------
  // Screenshot: Chrome's "share this tab" capture -> clipboard
  // ---------------------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let shooting = false;

  async function takeScreenshot() {
    if (!IS_TOP) {
      // Frames inside the page can't share the tab; the top page does it.
      chrome.runtime.sendMessage({ cmd: 'screenshot' });
      return;
    }
    if (shooting) return;
    shooting = true;
    ensureUI();
    hideShotCard();
    let stream;
    try {
      // Chrome asks "Share this tab?" (this tab is offered first). Nothing is recorded
      // or sent anywhere; one frame is taken and the sharing stops right away.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser', frameRate: 30 },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
        monitorTypeSurfaces: 'exclude',
      });
    } catch (err) {
      shooting = false;
      toast(
        err && err.name === 'NotAllowedError'
          ? L('Screenshot cancelled.', 'Captura cancelada.')
          : L("Couldn't start the screenshot: ", 'No se pudo hacer la captura: ') + (err && err.message),
        err && err.name !== 'NotAllowedError'
      );
      return;
    }
    let blob = null;
    try {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      const frames = watchFrames(video);
      chrome.runtime.sendMessage({ cmd: 'capture', on: true }); // hide toolbars + outlines in every frame
      captureStart();
      // Wait until the toolbars are really gone from the screen, then use the first
      // video frame captured after that (frames recorded earlier still show them).
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const hiddenAt = performance.now();
      await sleep(250); // also lets the page settle after Chrome's "sharing" bar appears
      const fresh = await waitFreshFrame(frames, hiddenAt);
      frames.stop = true;
      if (!fresh) throw new Error('no fresh frame'); // never hand over a picture with the toolbars in it
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    } catch (err) {
      console.warn('VHL overlay screenshot failed', err);
    } finally {
      stream.getTracks().forEach((t) => t.stop());
      chrome.runtime.sendMessage({ cmd: 'capture', on: false });
      captureEnd();
      shooting = false;
    }
    if (!blob) {
      toast("Couldn't take the screenshot. Please try again.", true);
      return;
    }
    showShotCard(blob);
  }

  // Keep track of when the newest video frame was captured.
  function watchFrames(video) {
    const w = { capture: -1, present: -1, stop: false };
    if (!video.requestVideoFrameCallback) return w;
    const cb = (now, meta) => {
      w.capture = meta.captureTime ?? -1;
      w.present = now;
      if (!w.stop) video.requestVideoFrameCallback(cb);
    };
    video.requestVideoFrameCallback(cb);
    return w;
  }

  // Wait until the video shows a frame captured after `hiddenAt`. Chrome only sends a
  // new frame when something on screen changes, so while waiting we flip an invisible
  // pixel to ask for one. Returns false if no fresh frame came (then we don't use it).
  async function waitFreshFrame(w, hiddenAt) {
    const nudge = document.createElement('div');
    nudge.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;background:#000;opacity:0';
    root.appendChild(nudge);
    const t0 = performance.now();
    let n = 0;
    try {
      while (performance.now() - t0 < 4000) {
        if (w.capture >= 0 ? w.capture >= hiddenAt : w.present >= hiddenAt + 150) return true;
        if (++n % 8 === 0) nudge.style.opacity = nudge.style.opacity === '0' ? '0.01' : '0';
        await sleep(30);
      }
      return false;
    } finally {
      nudge.remove();
    }
  }

  const PASTE_HINT = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘V' : 'Ctrl+V';

  // After a screenshot: a small card with a preview and two choices.
  let shotCard = null;
  let shotUrl = null;
  let shotTimer = null;

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  }

  function hideShotCard() {
    clearTimeout(shotTimer);
    if (shotCard) shotCard.classList.add('hidden');
  }

  function showShotCard(blob) {
    hideShotCard();
    if (shotUrl) URL.revokeObjectURL(shotUrl);
    shotUrl = URL.createObjectURL(blob);
    const name = `vhl-${stamp()}.png`;
    if (!shotCard) {
      shotCard = document.createElement('div');
      shotCard.className = 'glass shotcard hidden';
      shotCard.setAttribute('role', 'dialog');
      root.appendChild(shotCard);
    }
    shotCard.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'title';
    title.innerHTML = `${ic('camera')}<span>${L('Screenshot ready', 'Captura lista')}</span><span class="grow"></span>`;
    title.append(btn('', L('Close', 'Cerrar'), hideShotCard, '', 'x'));
    const img = document.createElement('img');
    img.src = shotUrl;
    img.alt = L('Screenshot preview', 'Vista previa de la captura');
    const status = document.createElement('div');
    status.className = 'status';
    const actions = document.createElement('div');
    actions.className = 'actions';
    const done = (b, msg) => {
      setStack(b, 1);
      b.classList.remove('primary');
      b.classList.add('done');
      status.textContent = msg;
      clearTimeout(shotTimer);
      shotTimer = setTimeout(hideShotCard, 12000);
    };
    const copyBtn = btn(L('Copy', 'Copiar'), L('Copy the picture so you can paste it anywhere', 'Copiar la imagen para pegarla donde quiera'), async () => {
      try {
        window.focus();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        done(copyBtn, L(`Paste it anywhere with ${PASTE_HINT}.`, `Péguela donde quiera con ${PASTE_HINT}.`));
      } catch (err) {
        status.textContent = L("Couldn't copy. Click Copy again, or use Download.", 'No se pudo copiar. Pulse Copiar otra vez o use Descargar.');
      }
    }, 'primary');
    const dlBtn = btn(L('Download', 'Descargar'), L('Save the picture as a file', 'Guardar la imagen como archivo'), () => {
      const a = document.createElement('a');
      a.href = shotUrl;
      a.download = name;
      root.appendChild(a);
      a.click();
      a.remove();
      done(dlBtn, L(`Saved to your Downloads folder as ${name}`, `Guardada en Descargas como ${name}`));
    });
    stack(copyBtn, [['copy', L('Copy', 'Copiar')], ['check', L('Copied', 'Copiada')]]);
    stack(dlBtn, [['download', L('Download', 'Descargar')], ['check', L('Downloaded', 'Descargada')]]);
    actions.append(copyBtn, dlBtn);
    shotCard.append(title, img, actions, status);
    shotCard.classList.remove('hidden');
  }

  // ---------------------------------------------------------------------------
  // Notes
  // ---------------------------------------------------------------------------

  // Find a reasonably large, stable page element under the click to pin the note to,
  // so the note scrolls and zooms together with the textbook page.
  function findAnchor(x, y, fallbackTarget) {
    let el = document.elementsFromPoint(x, y).find((e) => e !== host) || fallbackTarget;
    if (!el || el === host) el = document.documentElement;
    while (el && el !== document.documentElement) {
      const r = el.getBoundingClientRect();
      if (r.width >= 200 && r.height >= 150) break;
      el = el.parentElement || (el.getRootNode() && el.getRootNode().host) || null;
    }
    return el || document.documentElement;
  }

  function onPageClick(e) {
    ensureUI();
    const target = e.composedPath()[0];
    const anchor = findAnchor(e.clientX, e.clientY, target instanceof Element ? target : null);
    // Place the text so the caret starts roughly where you clicked.
    const x = e.clientX - 3;
    const y = e.clientY - state.size * 0.7;
    // Quick guess from the page's colors first, then refine with real pixels.
    const guess = cssBackground(e.clientX, e.clientY);
    const note = createNote(anchor, x, y, state.color, state.size);
    note.bg = guess;
    applyStyle(note);
    selectNote(note);
    pendingFocus = note;
    probeBackground(note, e.clientX, e.clientY);
  }

  function createNote(anchor, clientX, clientY, color, size) {
    const el = document.createElement('div');
    el.className = 'note';
    const grip = document.createElement('div');
    grip.className = 'grip';
    grip.innerHTML = ic('move');
    grip.title = 'Drag to move';
    const del = document.createElement('button');
    del.className = 'del';
    del.innerHTML = ic('x');
    del.setAttribute('aria-label', 'Delete');
    del.title = 'Delete';
    const text = document.createElement('div');
    text.className = 'text';
    text.contentEditable = 'plaintext-only';
    text.spellcheck = false;
    el.append(grip, del, text);
    layer.appendChild(el);

    const note = { el, textEl: text, anchor, fx: 0, fy: 0, baseW: 1, sx: 0, sy: 0, color, size, bg: null };
    setNoteAnchor(note, anchor, clientX, clientY);
    applyStyle(note);
    notes.add(note);

    text.addEventListener('focus', () => selectNote(note));
    text.addEventListener('blur', () => {
      endMarkTyping(note);
      if (capturing) return;
      setTimeout(() => {
        if (pendingFocus !== note && root.activeElement !== text && text.textContent.trim() === '') removeNote(note);
      }, 0);
    });
    del.addEventListener('pointerdown', (e) => e.preventDefault());
    del.addEventListener('click', () => removeNote(note));
    makeDraggable(grip, el, note);
    // Clicking the note's border/grip area shouldn't create a new note.
    el.addEventListener('pointerdown', () => !state.mark && selectNote(note));
    text.addEventListener('pointerdown', (e) => {
      if (state.mark) startMarking(note, e);
      else endMarkTyping(note); // clicking moves the caret: stop marking while typing
    });
    return note;
  }

  function setNoteAnchor(note, anchor, clientX, clientY, keepScale) {
    const r = anchor.getBoundingClientRect();
    note.anchor = anchor;
    if (!keepScale) note.baseW = r.width || 1;
    note.fx = r.width ? (clientX - r.left) / r.width : 0;
    note.fy = r.height ? (clientY - r.top) / r.height : 0;
    // If the anchor is itself a scroll box (e.g. the reader's page viewer), its own
    // box doesn't move when its content scrolls, so remember the scroll position too.
    note.sx = scrollX0(anchor);
    note.sy = scrollY0(anchor);
    if (!r.width) {
      note.fx = clientX;
      note.fy = clientY;
    }
  }

  const isRootScroller = (el) => el === document.documentElement || el === document.body;
  const scrollX0 = (el) => (isRootScroller(el) ? 0 : el.scrollLeft);
  const scrollY0 = (el) => (isRootScroller(el) ? 0 : el.scrollTop);

  // A thin outline in the opposite color keeps text readable on busy pictures.
  const haloShadow = (halo) =>
    halo ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].map(([a, b]) => `${a}px ${b}px 1px ${halo}`).join(',') : 'none';

  function applyStyle(note) {
    if (note.path) return styleStroke(note);
    const { color, halo } = readableColor(note.color, note.bg);
    note.textEl.style.color = color;
    note.textEl.style.textShadow = haloShadow(halo);
    note.textEl.style.fontSize = note.size + 'px';
    styleMarks(note);
  }

  // Marked letters get the readable shade of their own color, checked against the
  // same background as the rest of the box.
  function styleMarks(note) {
    for (const span of note.textEl.querySelectorAll('.mark')) {
      const { color, halo } = readableColor(span.dataset.c, note.bg);
      span.style.color = color;
      span.style.textShadow = haloShadow(halo);
    }
  }

  // ---------------------------------------------------------------------------
  // Contrast
  // ---------------------------------------------------------------------------

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function luminance([r, g, b]) {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  const contrast = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

  // bg = { lum: background luminance, busy: true when the background is a picture or
  //        has lots of different colors, so no single text color is safe everywhere }
  function readableColor(colorId, bg) {
    const fam = family(colorId);
    bg = bg || { lum: 1, busy: false };
    const score = (c) => contrast(luminance(hexToRgb(c)), bg.lum);
    let best = [fam.light, fam.dark].map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s)[0];
    if (best.s < 3) {
      // Neither shade of this color works here (mid-tone background): use black or white.
      const bw = ['#111827', '#ffffff'].map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s)[0];
      if (bw.s > best.s) best = bw;
    }
    const needsHalo = bg.busy || best.s < AA;
    const textIsLight = luminance(hexToRgb(best.c)) > 0.4;
    return {
      color: best.c,
      contrast: best.s,
      halo: needsHalo ? (textIsLight ? 'rgba(0,0,0,.85)' : 'rgba(255,255,255,.9)') : null,
    };
  }

  function parseCssColor(str) {
    const m = str && str.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat);
    return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
  }

  // Estimate the background from the page's CSS (works everywhere, but can't see
  // inside pictures). Pictures are marked busy so their text gets an outline.
  function cssBackground(x, y) {
    // Skip our own overlay (a note may already sit at this spot).
    let el = document.elementsFromPoint(x, y).find((e) => e !== host);
    while (el) {
      if (/^(IMG|CANVAS|VIDEO|SVG|PICTURE|IFRAME|EMBED|OBJECT)$/i.test(el.tagName)) return { lum: 1, busy: true };
      const cs = getComputedStyle(el);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return { lum: 1, busy: true };
      const c = parseCssColor(cs.backgroundColor);
      if (c && c.a >= 0.5) return { lum: luminance(c.rgb), busy: false };
      el = el.parentElement || (el.getRootNode() && el.getRootNode().host) || null;
    }
    return { lum: 1, busy: false }; // browsers draw white behind pages by default
  }

  // Look at the real pixels around the click (top frame only; frames inside the
  // page can't tell where they are on screen). Falls back silently to the CSS guess.
  function probeBackground(note, x, y) {
    if (!IS_TOP) return;
    const w = Math.max(90, note.size * 7);
    const h = note.size * 1.5;
    const rect = {
      x: Math.max(0, x - 6),
      y: Math.max(0, y - h * 0.6),
      w: Math.min(w, window.innerWidth - x),
      h: Math.min(h, window.innerHeight - y + h * 0.6),
    };
    if (rect.w < 4 || rect.h < 4) return;
    probing.add(note);
    chrome.runtime.sendMessage({ cmd: 'sample', rect, vw: window.innerWidth }, (res) => {
      probing.delete(note);
      note.el.classList.remove('probing');
      if (chrome.runtime.lastError || !res || !notes.has(note)) return;
      note.bg = res;
      applyStyle(note);
    });
  }
  const probing = new Set();

  function removeNote(note) {
    if (!notes.has(note)) return;
    notes.delete(note);
    note.el.remove();
    if (selected === note) selectNote(null);
  }

  function selectNote(note) {
    if (selected === note) return;
    const prev = selected;
    if (prev) prev.el.classList.remove('selected');
    selected = note;
    if (note) note.el.classList.add('selected');
    if (prev && notes.has(prev)) {
      if (prev.textEl.textContent.trim() === '') removeNote(prev);
      else if (root && root.activeElement === prev.textEl) prev.textEl.blur();
    }
    if (toolbar) render();
  }

  function focusEnd(el) {
    el.focus({ preventScroll: true });
    // Put the caret at the end of any existing text.
    try {
      const sel = window.getSelection();
      if (el.lastChild) sel.collapse(el.lastChild, (el.lastChild.textContent || '').length);
    } catch {
      /* caret placement is best-effort inside the shadow DOM */
    }
  }

  function clearAll() {
    for (const n of [...notes]) removeNote(n);
    for (const st of [...strokes]) removeStroke(st);
    inkHistory.length = inkRedo.length = 0;
  }

  // Keep every note and drawing glued to its page element (handles scrolling, zoom, resizing).
  function place(n) {
    const a = n.anchor;
    if (!a.isConnected) {
      n.el.style.display = 'none'; // page changed; it belonged to the old page
      return;
    }
    const r = a.getBoundingClientRect();
    if (!r.width && !r.height) {
      n.el.style.display = 'none';
      return;
    }
    n.el.style.display = '';
    const scale = r.width / n.baseW;
    const x = r.left + n.fx * r.width - (scrollX0(a) - n.sx) * scale;
    const y = r.top + n.fy * r.height - (scrollY0(a) - n.sy) * scale;
    n.tx = x;
    n.ty = y;
    n.scale = scale;
    n.el.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }

  function tick() {
    for (const n of notes) place(n);
    for (const st of strokes) place(st);
    if (tour) positionTour();
    requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------------------
  // Pen mode: drawing with a pen, mouse or finger (Pointer Events). Strokes are SVG
  // shapes whose width follows the pen pressure, pinned to the page like notes.
  // ---------------------------------------------------------------------------

  const SVGNS = 'http://www.w3.org/2000/svg';
  const inkHistory = []; // [{ add: [strokes] } | { erase: [strokes] }]
  const inkRedo = [];
  let penSeen = false; // once a pen is used, fingers scroll instead of drawing (palm rejection)
  let inkPresenter = null; // Chrome's Ink API, if available: the system draws the newest bit of the line

  const isEraserEvent = (e) => e.pointerType === 'pen' && ((e.buttons & 32) !== 0 || e.button === 5);

  function onLayerPointerDown(e) {
    if (!state.pen || capturing || e.composedPath()[0] !== layer) return;
    if (e.pointerType === 'pen') penSeen = true;
    if (e.pointerType === 'touch' && penSeen) return touchScroll(e);
    if (e.button !== 0 && !isEraserEvent(e)) return;
    e.preventDefault();
    try {
      layer.setPointerCapture(e.pointerId);
    } catch {
      /* not critical */
    }
    if (state.eraser || isEraserEvent(e)) return eraseDrag(e);
    drawStroke(e);
  }

  function drawStroke(e) {
    const anchor = findAnchor(e.clientX, e.clientY, null);
    const st = { el: null, path: null, anchor, fx: 0, fy: 0, baseW: 1, sx: 0, sy: 0, pts: [], color: state.color, size: state.size, bg: null, pen: e.pointerType === 'pen' };
    st.el = document.createElementNS(SVGNS, 'svg');
    st.el.setAttribute('class', 'ink');
    st.path = document.createElementNS(SVGNS, 'path');
    st.el.append(st.path);
    layer.insertBefore(st.el, layer.firstChild); // drawings sit under text boxes
    setNoteAnchor(st, anchor, e.clientX, e.clientY);
    place(st);
    st.bg = cssBackground(e.clientX, e.clientY);
    strokes.add(st);
    styleStroke(st);
    const base = Math.max(1.5, st.size / 6);
    const addPoint = (ev) => {
      const s = st.scale || 1;
      const x = (ev.clientX - st.tx) / s;
      const y = (ev.clientY - st.ty) / s;
      const last = st.pts[st.pts.length - 1];
      if (last && Math.hypot(x - last.x, y - last.y) < 0.75) return;
      // Pens report pressure (press harder = thicker); a mouse reports 0.5 while pressed.
      const p = ev.pointerType === 'pen' ? ev.pressure : 0.5;
      const raw = base * (0.35 + 1.3 * p);
      const w = last ? last.w * 0.6 + raw * 0.4 : raw; // smooth out sudden jumps
      st.pts.push({ x, y, w });
    };
    addPoint(e);
    st.path.setAttribute('d', strokePath(st.pts));
    let inkStyle = null;
    if (navigator.ink && !inkPresenter) {
      navigator.ink.requestPresenter({ presentationArea: layer }).then((p) => (inkPresenter = p)).catch(() => {});
    }
    const move = (ev) => {
      // Pens send many more positions than the screen shows; use them all for smooth lines.
      const all = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [];
      for (const c of all.length ? all : [ev]) addPoint(c);
      st.path.setAttribute('d', strokePath(st.pts));
      if (inkPresenter) {
        try {
          inkStyle = inkStyle || { color: st.path.getAttribute('fill'), diameter: base * (st.scale || 1) };
          inkPresenter.updateInkTrailStartPoint(ev, inkStyle);
        } catch {
          /* best effort */
        }
      }
    };
    const up = () => {
      layer.removeEventListener('pointermove', move);
      layer.removeEventListener('pointerup', up);
      layer.removeEventListener('pointercancel', up);
      inkHistory.push({ add: [st] });
      inkRedo.length = 0;
      const b = st.el.getBoundingClientRect();
      if (b.width || b.height) probeBackground(st, b.left + 2, b.top + b.height / 2);
    };
    layer.addEventListener('pointermove', move);
    layer.addEventListener('pointerup', up);
    layer.addEventListener('pointercancel', up);
  }

  // The outline of a line whose width changes along the way, with round ends.
  function strokePath(pts) {
    const f = (n) => Math.round(n * 100) / 100;
    if (pts.length === 1) {
      const { x, y, w } = pts[0];
      const r = w / 2;
      return `M${f(x - r)} ${f(y)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;
    }
    const left = [];
    const right = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const r = pts[i].w / 2;
      left.push([pts[i].x - dy * r, pts[i].y + dx * r]);
      right.push([pts[i].x + dy * r, pts[i].y - dx * r]);
    }
    // Smooth curves through the midpoints of each side.
    const side = (ps) => {
      let d = '';
      for (let i = 1; i < ps.length - 1; i++) {
        const mx = (ps[i][0] + ps[i + 1][0]) / 2;
        const my = (ps[i][1] + ps[i + 1][1]) / 2;
        d += `Q${f(ps[i][0])} ${f(ps[i][1])} ${f(mx)} ${f(my)}`;
      }
      const l = ps[ps.length - 1];
      return d + `L${f(l[0])} ${f(l[1])}`;
    };
    const rEnd = f(pts[pts.length - 1].w / 2);
    const rStart = f(pts[0].w / 2);
    const rr = right.slice().reverse();
    return `M${f(left[0][0])} ${f(left[0][1])}${side(left)}A${rEnd} ${rEnd} 0 0 1 ${f(rr[0][0])} ${f(rr[0][1])}${side(rr)}A${rStart} ${rStart} 0 0 1 ${f(left[0][0])} ${f(left[0][1])}Z`;
  }

  // Same readability check as text: the shade of the color that stands out, plus a
  // thin outline on pictures.
  function styleStroke(st) {
    const { color, halo } = readableColor(st.color, st.bg);
    st.path.setAttribute('fill', color);
    st.path.setAttribute('stroke', halo || 'none');
    st.path.setAttribute('stroke-width', halo ? '1.6' : '0');
  }

  function removeStroke(st) {
    strokes.delete(st);
    st.el.remove();
  }

  // Erase whole lines the pointer touches.
  function eraseDrag(e) {
    const erased = [];
    const at = (ev) => {
      for (const st of [...strokes]) {
        if (st.el.style.display === 'none' || !touches(st, ev.clientX, ev.clientY)) continue;
        removeStroke(st);
        erased.push(st);
      }
    };
    at(e);
    const move = (ev) => at(ev);
    const up = () => {
      layer.removeEventListener('pointermove', move);
      layer.removeEventListener('pointerup', up);
      layer.removeEventListener('pointercancel', up);
      if (erased.length) {
        inkHistory.push({ erase: erased });
        inkRedo.length = 0;
      }
    };
    layer.addEventListener('pointermove', move);
    layer.addEventListener('pointerup', up);
    layer.addEventListener('pointercancel', up);
  }

  function touches(st, cx, cy) {
    const s = st.scale || 1;
    const x = (cx - st.tx) / s;
    const y = (cy - st.ty) / s;
    const reach = 8 / s; // a little slack around the line
    for (let i = 0; i < st.pts.length; i++) {
      const a = st.pts[i];
      const b = st.pts[i + 1] || a;
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / (vx * vx + vy * vy || 1)));
      if (Math.hypot(x - (a.x + t * vx), y - (a.y + t * vy)) <= a.w / 2 + reach) return true;
    }
    return false;
  }

  function inkUndoRedo(undo) {
    const from = undo ? inkHistory : inkRedo;
    const step = from.pop();
    if (!step) return;
    const show = (list) => list.forEach((st) => {
      strokes.add(st);
      layer.insertBefore(st.el, layer.firstChild);
    });
    const hide = (list) => list.forEach(removeStroke);
    if (step.add) (undo ? hide : show)(step.add);
    else (undo ? show : hide)(step.erase);
    (undo ? inkRedo : inkHistory).push(step);
  }

  // Scroll whatever page element is under (x, y), including inside frames.
  function scrollUnder(x, y, dx, dy, doc = document) {
    let el = doc.elementsFromPoint(x, y).find((e) => e !== host);
    while (el) {
      if (el.tagName === 'IFRAME') {
        try {
          const r = el.getBoundingClientRect();
          if (scrollUnder(x - r.left, y - r.top, dx, dy, el.contentDocument)) return true;
        } catch {
          /* a frame from another site: scroll around it instead */
        }
      }
      const cs = getComputedStyle(el);
      const canY = dy && el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(cs.overflowY);
      const canX = dx && el.scrollWidth > el.clientWidth && /(auto|scroll)/.test(cs.overflowX);
      if (canY || canX) {
        el.scrollBy(dx, dy);
        return true;
      }
      el = el.parentElement;
    }
    // Nothing scrollable inside: the frame's own page, if it can move (otherwise the
    // page around the frame scrolls).
    const se = doc.scrollingElement;
    if (!se) return false;
    const before = se.scrollTop + se.scrollLeft;
    se.scrollBy(dx, dy);
    return se.scrollTop + se.scrollLeft !== before || doc === document;
  }

  // After a pen has been used, a finger drag scrolls the page instead of drawing.
  function touchScroll(e) {
    let lx = e.clientX;
    let ly = e.clientY;
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      scrollUnder(e.clientX, e.clientY, lx - ev.clientX, ly - ev.clientY);
      lx = ev.clientX;
      ly = ev.clientY;
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      layer.removeEventListener('pointermove', move);
      layer.removeEventListener('pointerup', up);
      layer.removeEventListener('pointercancel', up);
    };
    layer.addEventListener('pointermove', move);
    layer.addEventListener('pointerup', up);
    layer.addEventListener('pointercancel', up);
  }

  // ---------------------------------------------------------------------------
  // Dragging (notes and the toolbar)
  // ---------------------------------------------------------------------------

  function makeDraggable(handle, box, note) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const start = box.getBoundingClientRect();
      const dx = e.clientX - start.left;
      const dy = e.clientY - start.top;
      const move = (ev) => {
        const left = ev.clientX - dx;
        const top = ev.clientY - dy;
        if (note) {
          // grip sits above the text; position by the note box itself
          setNoteAnchor(note, note.anchor, left, top, true);
        } else {
          box.style.left = Math.max(0, Math.min(window.innerWidth - 40, left)) + 'px';
          box.style.top = Math.max(0, Math.min(window.innerHeight - 20, top)) + 'px';
          box.style.right = 'auto';
        }
      };
      const up = () => {
        if (note && note.el.isConnected) {
          const r = note.textEl.getBoundingClientRect();
          note.bg = cssBackground(r.left + 4, r.top + r.height / 2);
          applyStyle(note);
          probeBackground(note, r.left + 4, r.top + r.height / 2);
        }
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  // ---------------------------------------------------------------------------
  // Keyboard inside a note
  // ---------------------------------------------------------------------------

  const noteOf = (e) => {
    const path = e.composedPath();
    return [...notes].find((n) => path.includes(n.textEl));
  };

  function onOwnKey(e) {
    const note = noteOf(e);
    if (!note) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      note.textEl.blur();
      selectNote(null);
      return;
    }
    // Undo / redo (Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y; ⌘ on a Mac) use the box's own history.
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === 'z' || k === 'y')) {
      e.preventDefault();
      undoRedo(note, k === 'z' && !e.shiftKey);
      return;
    }
    if (e.key === '>' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) {
      // ">" starts marking the letters you type next: hac>er gives hac + marked "er".
      // ">>" types a real ">", and ">" while marking stops early.
      e.preventDefault();
      if (note.markTyping && note.markFresh) {
        endMarkTyping(note);
        remember(note);
        typeText(note, '>', null);
      } else if (note.markTyping) {
        endMarkTyping(note);
      } else {
        note.markTyping = true;
        note.markFresh = true;
        note.textEl.style.caretColor = readableColor(markColor(), note.bg).color;
      }
      return;
    }
    // Moving the caret or starting a new line also ends the mark.
    if (/^(Enter|Arrow|Home|End|Page|Tab)/.test(e.key)) endMarkTyping(note);
  }

  function endMarkTyping(note) {
    if (!note.markTyping) return;
    note.markTyping = false;
    note.markFresh = false;
    note.textEl.style.caretColor = '';
  }

  // Typing a letter. We only step in when the browser would get the color wrong:
  // while marking, and right after a mark (the browser would keep typing inside it).
  function onOwnBeforeInput(e) {
    const note = noteOf(e);
    if (!note) return;
    // Our own undo history: Chrome's can't follow the marks we add (Ctrl+Z would stop working).
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault();
      undoRedo(note, e.inputType === 'historyUndo');
      return;
    }
    if (e.inputType !== 'insertCompositionText') remember(note);
    if (e.inputType !== 'insertText' || e.isComposing || e.data == null) {
      if (e.inputType !== 'insertCompositionText') endMarkTyping(note);
      return;
    }
    const sel = getSel();
    if (!sel || !sel.rangeCount) return;
    const [a, b] = selOffsets(note.textEl, sel);
    if (a < 0) return;
    const chars = getChars(note.textEl);
    let color;
    if (note.markTyping) {
      if (/^[\p{L}\p{N}\p{M}]+$/u.test(e.data)) {
        color = markColor();
        note.markFresh = false;
      } else {
        endMarkTyping(note); // a space or punctuation ends the mark
        color = null;
      }
    } else {
      const left = a > 0 ? chars[a - 1].c : null;
      const right = b < chars.length ? chars[b].c : null;
      if (!left || left === right) return; // the browser gets this right on its own
      color = null; // just after a mark: new letters are plain again
    }
    e.preventDefault();
    typeText(note, e.data, color, [a, b]);
  }

  // ---------------------------------------------------------------------------
  // Marked letters. A text box holds plain text plus <span class="mark" data-c="red">
  // pieces. To change them we read the box as a list of letters with a color each,
  // change that list, and rebuild the box.
  // ---------------------------------------------------------------------------

  // Undo/redo: a copy of the box's letters (and the caret) before each change.
  function snapshot(note) {
    const sel = getSel();
    const at = sel && sel.rangeCount ? selOffsets(note.textEl, sel) : [-1, -1];
    return { chars: getChars(note.textEl), sel: at[0] < 0 ? null : at };
  }
  function remember(note) {
    note.undo = note.undo || [];
    note.undo.push(snapshot(note));
    if (note.undo.length > 300) note.undo.shift();
    note.redo = [];
  }
  function undoRedo(note, undo) {
    const from = undo ? note.undo : note.redo;
    if (!from || !from.length) return;
    const to = undo ? (note.redo = note.redo || []) : note.undo;
    to.push(snapshot(note));
    const snap = from.pop();
    endMarkTyping(note);
    const [a, b] = snap.sel || [snap.chars.length, snap.chars.length];
    setChars(note, snap.chars, a, b);
  }

  const getSel = () => (root && root.getSelection ? root.getSelection() : window.getSelection());

  function getChars(textEl) {
    const out = [];
    for (const node of textEl.childNodes) {
      const c = node.nodeType === 1 ? node.dataset.c || null : null;
      const t = node.nodeType === 1 && node.tagName === 'BR' ? '\n' : node.textContent;
      for (const ch of t) out.push({ ch, c });
    }
    return out;
  }

  // Letter position of a (node, offset) point inside the box, or -1.
  function offsetOf(textEl, node, off) {
    if (!node || (node !== textEl && !textEl.contains(node))) return -1;
    const r = document.createRange();
    r.setStart(textEl, 0);
    r.setEnd(node, off);
    return [...r.toString()].length;
  }

  function selOffsets(textEl, sel) {
    const r = sel.getRangeAt(0);
    const a = offsetOf(textEl, r.startContainer, r.startOffset);
    const b = offsetOf(textEl, r.endContainer, r.endOffset);
    return a < 0 || b < 0 ? [-1, -1] : [a, b];
  }

  // The DOM point for letter position `pos`, staying with the letter on its left
  // (so a caret right after plain text is in the plain text, not in the next mark).
  function pointAt(textEl, pos) {
    let n = 0;
    let last = null;
    for (const node of textEl.childNodes) {
      const t = node.nodeType === 3 ? node : node.firstChild;
      if (!t) continue;
      const len = [...t.textContent].length;
      if (pos <= n + len && (pos > n || n === 0)) return [t, [...t.textContent].slice(0, pos - n).join('').length];
      n += len;
      last = t;
    }
    return last ? [last, last.textContent.length] : [textEl, 0];
  }

  function setChars(note, chars, selA, selB = selA) {
    const el = note.textEl;
    el.textContent = '';
    let i = 0;
    while (i < chars.length) {
      const c = chars[i].c;
      let t = '';
      while (i < chars.length && chars[i].c === c) t += chars[i++].ch;
      if (c) {
        const span = document.createElement('span');
        span.className = 'mark';
        span.dataset.c = c;
        span.textContent = t;
        el.append(span);
      } else {
        el.append(t);
      }
    }
    styleMarks(note);
    if (selA != null && root.activeElement === el) {
      try {
        getSel().setBaseAndExtent(...pointAt(el, selA), ...pointAt(el, selB));
      } catch {
        /* best effort */
      }
    }
  }

  // Replace letters a..b with `text` in one color (null = the box's own color).
  function typeText(note, text, color, range) {
    const sel = getSel();
    const [a, b] = range || (sel && sel.rangeCount ? selOffsets(note.textEl, sel) : [-1, -1]);
    const chars = getChars(note.textEl);
    const at = a < 0 ? chars.length : a;
    const ins = [...text].map((ch) => ({ ch, c: color }));
    chars.splice(at, a < 0 ? 0 : b - a, ...ins);
    setChars(note, chars, at + ins.length);
  }

  // Color letters a..b-1 (null = back to the box's own color).
  function colorRange(note, a, b, color, keepSel) {
    const chars = getChars(note.textEl);
    for (let i = Math.max(0, a); i < Math.min(b, chars.length); i++) chars[i].c = chars[i].ch === '\n' ? null : color;
    if (keepSel) setChars(note, chars, a, b);
    else setChars(note, chars);
  }

  // Word-style: letters selected in the box you're editing take the clicked color.
  function paintSelection(colorId) {
    const note = selected;
    if (!note || !notes.has(note) || !root || root.activeElement !== note.textEl) return false;
    const sel = getSel();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return false;
    const [a, b] = selOffsets(note.textEl, sel);
    if (a < 0 || b <= a) return false;
    remember(note);
    colorRange(note, a, b, colorId === note.color ? null : colorId, true);
    return true;
  }

  // Which letter is under the pointer? Returns its position, or -1. With `nearest`,
  // the closest letter on the same line (for dragging past the ends).
  function letterAt(textEl, x, y, nearest) {
    let best = -1;
    let bestD = Infinity;
    let i = 0;
    const r = document.createRange();
    for (const node of textEl.childNodes) {
      const t = node.nodeType === 3 ? node : node.firstChild;
      if (!t) continue;
      let off = 0;
      for (const ch of t.textContent) {
        if (ch !== '\n') {
          r.setStart(t, off);
          r.setEnd(t, off + ch.length);
          const b = r.getBoundingClientRect();
          if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return i;
          const dy = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
          const dx = x < b.left ? b.left - x : x > b.right ? x - b.right : 0;
          const d = dy * 1000 + dx;
          if (d < bestD) [bestD, best] = [d, i];
        }
        off += ch.length;
        i++;
      }
    }
    return nearest ? best : -1;
  }

  // Highlighter: click a letter to mark it (or unmark it), or drag across letters.
  function startMarking(note, e) {
    if (e.button !== 0) return;
    e.preventDefault(); // no caret, no text selection
    const first = letterAt(note.textEl, e.clientX, e.clientY, true);
    if (first < 0) return;
    remember(note);
    const start = getChars(note.textEl);
    const mc = markColor();
    // Clicking a letter that already has this marker color takes the mark off.
    const color = start[first].c === mc ? null : mc;
    const paint = (i) => {
      const [a, b] = i < first ? [i, first + 1] : [first, i + 1];
      const chars = start.map((ch, k) => (k >= a && k < b && ch.ch !== '\n' ? { ...ch, c: color } : ch));
      setChars(note, chars);
    };
    paint(first);
    const t = note.textEl;
    try {
      t.setPointerCapture(e.pointerId);
    } catch {
      /* not critical */
    }
    const move = (ev) => paint(Math.max(0, letterAt(t, ev.clientX, ev.clientY, true)));
    const up = () => {
      t.removeEventListener('pointermove', move);
      t.removeEventListener('pointerup', up);
      t.removeEventListener('pointercancel', up);
    };
    t.addEventListener('pointermove', move);
    t.addEventListener('pointerup', up);
    t.addEventListener('pointercancel', up);
  }

  let hintShown = 0;
  function markHint() {
    if (!IS_TOP || Date.now() - hintShown < 4000) return;
    hintShown = Date.now();
    toast(L('Highlighter is on: click or drag across letters in your text. Click the highlighter button again to go back to typing.',
      'El marcador está activado: haga clic o arrastre sobre las letras de su texto. Pulse otra vez el botón del marcador para volver a escribir.'));
  }

  // ---------------------------------------------------------------------------
  // Screenshot support
  // ---------------------------------------------------------------------------

  function captureStart() {
    if (capturing) return;
    capturing = true;
    if (!host) return;
    host.setAttribute('data-capturing', '');
    layer.classList.add('capturing');
    refocusAfterCapture = selected && root.activeElement === selected.textEl ? selected : null;
    if (refocusAfterCapture) refocusAfterCapture.textEl.blur(); // hide the blinking caret
    render();
  }

  function captureEnd() {
    if (!capturing) return;
    capturing = false;
    if (!host) return;
    // keep motion off until the toolbars are back in place
    requestAnimationFrame(() => requestAnimationFrame(() => host.removeAttribute('data-capturing')));
    layer.classList.remove('capturing');
    render();
    if (refocusAfterCapture && notes.has(refocusAfterCapture)) focusEnd(refocusAfterCapture.textEl);
    refocusAfterCapture = null;
  }

  // ---------------------------------------------------------------------------
  // Messages from the background worker
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'paint':
        // Only the frame holding selected letters answers; if none does, the
        // background makes it the color for the whole box instead.
        if (paintSelection(msg.color)) sendResponse(true);
        break;
      case 'state': {
        state = msg.state;
        if (state.open || state.typing || notes.size) ensureUI();
        // A color/size button was pressed: also restyle the note you're editing.
        const p = msg.patch || {};
        if (selected && ('color' in p || 'size' in p)) {
          if ('color' in p) selected.color = p.color;
          if ('size' in p) selected.size = p.size;
          applyStyle(selected);
        }
        render();
        break;
      }
      case 'clear-all':
        clearAll();
        break;
      case 'do-screenshot':
        if (IS_TOP) takeScreenshot();
        break;
      case 'probe-start':
        for (const n of probing) n.el.classList.add('probing');
        break;
      case 'probe-end':
        for (const n of probing) n.el.classList.remove('probing');
        break;
      case 'capture-start':
        captureStart();
        break;
      case 'capture-end':
        captureEnd();
        break;
      case 'toast':
        if (IS_TOP) {
          ensureUI();
          toast(msg.text, msg.error);
        }
        break;
    }
  });

  function init() {
    chrome.runtime.sendMessage({ cmd: 'get-state' }, (s) => {
      if (chrome.runtime.lastError || !s) return;
      state = s;
      if (state.open || state.typing) ensureUI();
      render();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
