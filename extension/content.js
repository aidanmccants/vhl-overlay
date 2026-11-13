// VHL Text Overlay - content script.
// Runs in every vhlcentral.com frame. Draws typed text boxes in an overlay layer
// on top of the page. Nothing is saved: the boxes disappear when the page reloads.
(() => {
  if (window.__vhlOverlayLoaded) return;
  window.__vhlOverlayLoaded = true;

  const IS_TOP = window === window.top;
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

  let state = { open: false, typing: false, color: 'blue', size: 18, side: 'right' };
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
        if (!state.typing || capturing) return;
        if (e.button !== undefined && e.button !== 0) return; // only left clicks / taps
        if (onScrollbar(e)) return; // let scrollbars keep working
        // Typing mode: the page should not react to this click at all.
        // (pointerdown/mousedown keep their default so the frame still gets focus.)
        if (type !== 'pointerdown' && type !== 'mousedown') e.preventDefault();
        e.stopImmediatePropagation();
        if (type === 'pointerdown') onPageClick(e);
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

  const KEY_EVENTS = ['keydown', 'keyup', 'keypress'];
  for (const type of KEY_EVENTS) {
    window.addEventListener(
      type,
      (e) => {
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
      if (isOurs(e)) e.stopImmediatePropagation();
    }, true);
  }

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

  const CSS = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; overflow: hidden; }
    .note {
      position: absolute; left: 0; top: 0; transform-origin: 0 0;
      pointer-events: none; min-width: 12px;
    }
    .typing .note { pointer-events: auto; }
    .text {
      font-family: "Segoe Print", "Bradley Hand", "Comic Sans MS", Arial, sans-serif;
      line-height: 1.2; white-space: pre; outline: none; padding: 1px 3px;
      min-width: 8px; min-height: 1.2em; cursor: text; border-radius: 3px;
      font-weight: 600;
    }
    .typing .note:hover .text { box-shadow: 0 0 0 1px rgba(37, 99, 235, .45); }
    .note.selected .text { box-shadow: 0 0 0 1.5px #2563eb, 0 0 0 3px rgba(255,255,255,.85); }
    .note.probing { opacity: 0 !important; }
    .grip, .del {
      position: absolute; top: -18px; height: 16px; display: none;
      font: 600 11px/16px Arial, sans-serif; color: #fff; border-radius: 3px;
      user-select: none; text-align: center;
    }
    .grip { left: 0; width: 16px; background: #2563eb; cursor: move; }
    .del { left: 18px; width: 16px; background: #dc2626; cursor: pointer; border: 0; padding: 0; }
    .typing .note.selected .grip, .typing .note.selected .del { display: block; }
    .capturing .text { box-shadow: none !important; background: transparent !important; }
    .capturing .grip, .capturing .del { display: none !important; }
    .hidden { display: none !important; }

    .toolbar {
      position: fixed; top: 12px; right: 12px; pointer-events: auto;
      display: flex; align-items: center; gap: 6px; padding: 6px 8px;
      background: #fff; color: #111827; border-radius: 10px;
      box-shadow: 0 4px 18px rgba(0,0,0,.22), 0 0 0 1px rgba(0,0,0,.06);
      font: 13px/1 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
      user-select: none;
    }
    .toolbar .drag { cursor: move; color: #9ca3af; padding: 0 2px; font-size: 14px; }
    .toolbar button {
      font: inherit; border: 1px solid #d1d5db; background: #f9fafb; color: #111827;
      border-radius: 6px; padding: 5px 8px; cursor: pointer; white-space: nowrap;
    }
    .toolbar button:hover { background: #eef2ff; }
    .toolbar button.on { background: #2563eb; border-color: #2563eb; color: #fff; }
    .toolbar .sep { width: 1px; align-self: stretch; background: #e5e7eb; }
    .panel {
      position: fixed; top: max(64px, calc(50vh - 170px)); right: 10px; pointer-events: auto;
      display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px 6px;
      background: #fff; color: #111827; border-radius: 12px;
      box-shadow: 0 4px 18px rgba(0,0,0,.22), 0 0 0 1px rgba(0,0,0,.06);
      font: 13px/1 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; user-select: none;
    }
    .panel.left { right: auto; left: 10px; }
    .panel button {
      font: inherit; border: 1px solid #d1d5db; background: #f9fafb; color: #111827;
      border-radius: 6px; width: 34px; height: 30px; padding: 0; cursor: pointer;
    }
    .panel button:hover { background: #eef2ff; }
    .panel .big { font-size: 16px; font-weight: 700; }
    .panel .small { font-size: 11px; font-weight: 700; }
    .panel .size { font-weight: 600; font-variant-numeric: tabular-nums; padding: 2px 0; }
    .panel .label { font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: .04em; }
    .panel .sep { height: 1px; width: 100%; background: #e5e7eb; }
    .panel .swatch {
      width: 24px; height: 24px; padding: 0; border-radius: 50%;
      border: 2px solid #fff; box-shadow: 0 0 0 1px #9ca3af;
    }
    .panel .swatch:hover { background-clip: padding-box; }
    .panel .swatch.active { box-shadow: 0 0 0 2.5px #111827; }
    .panel .flip { font-size: 14px; height: 24px; color: #6b7280; }
    .toast {
      position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
      background: #111827; color: #fff; padding: 10px 14px; border-radius: 8px;
      font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
      max-width: 80vw; pointer-events: none; box-shadow: 0 4px 18px rgba(0,0,0,.25);
    }
    .toast.error { background: #b91c1c; }
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

    // Stop our UI's events from bubbling up into the reader's own handlers.
    for (const type of [...POINTER_EVENTS, 'pointermove', 'mousemove', 'contextmenu', 'touchstart', 'touchend']) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }

    if (IS_TOP) buildToolbar();
    (document.body || document.documentElement).appendChild(host);
    keepAttached();
    requestAnimationFrame(tick);
  }

  // Some single-page apps wipe <body>; put our layer back if that happens.
  function keepAttached() {
    new MutationObserver(() => {
      if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  function btn(label, title, onClick, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    if (cls) b.className = cls;
    // pointerdown default would steal focus from the note being edited
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', onClick);
    return b;
  }

  let ui = {};
  function buildToolbar() {
    toolbar = document.createElement('div');
    toolbar.className = 'toolbar hidden';

    const drag = document.createElement('span');
    drag.className = 'drag';
    drag.textContent = '⋮⋮';
    drag.title = 'Drag to move the toolbar';
    makeDraggable(drag, toolbar, null);

    ui.typing = btn('✏️ Typing', 'Typing mode: click anywhere on the page to add text (Alt+Shift+T closes the toolbar)', () =>
      sendState({ typing: !state.typing })
    );

    ui.shot = btn('📷 Save', 'Save a screenshot with your text (Alt+Shift+S)', () =>
      chrome.runtime.sendMessage({ cmd: 'screenshot' })
    );
    ui.clear = btn('🗑 Clear', 'Remove all text boxes', () => {
      if (confirm('Remove all of your typed text from this page?')) chrome.runtime.sendMessage({ cmd: 'clear-all' });
    });
    ui.close = btn('✕', 'Hide toolbar (your text stays on the page)', () => sendState({ open: false, typing: false }));

    const sep = () => Object.assign(document.createElement('span'), { className: 'sep' });
    toolbar.append(drag, ui.typing, sep(), ui.shot, ui.clear, ui.close);
    root.appendChild(toolbar);

    // Side toolbar: text size and color.
    panel = document.createElement('div');
    panel.className = 'panel hidden';
    const label = (t) => Object.assign(document.createElement('div'), { className: 'label', textContent: t });
    const hsep = () => Object.assign(document.createElement('div'), { className: 'sep' });
    ui.bigger = btn('A+', 'Bigger text', () => changeSize(2), 'big');
    ui.size = document.createElement('div');
    ui.size.className = 'size';
    ui.size.title = 'Text size';
    ui.smaller = btn('A−', 'Smaller text', () => changeSize(-2), 'small');
    ui.swatches = COLORS.map((c) => {
      const sw = btn('', c.name + ' (switches to a lighter or darker shade automatically so it stays readable)', () => sendState({ color: c.id }), 'swatch');
      // left half: shade used on light backgrounds; right half: shade used on dark ones
      sw.style.background = `linear-gradient(135deg, ${c.light} 0 55%, ${c.dark} 55% 100%)`;
      sw.dataset.color = c.id;
      return sw;
    });
    ui.flip = btn('⇄', 'Move this toolbar to the other side of the screen', () =>
      sendState({ side: state.side === 'left' ? 'right' : 'left' }), 'flip');
    panel.append(label('Size'), ui.bigger, ui.size, ui.smaller, hsep(), label('Color'), ...ui.swatches, hsep(), ui.flip);
    root.appendChild(panel);

    toastEl = document.createElement('div');
    toastEl.className = 'toast hidden';
    root.appendChild(toastEl);
  }

  function changeSize(delta) {
    const base = selected ? selected.size : state.size;
    const size = Math.max(MIN_SIZE, Math.min(MAX_SIZE, base + delta));
    sendState({ size });
  }

  function sendState(patch) {
    chrome.runtime.sendMessage({ cmd: 'set-state', patch });
  }

  function render() {
    if (!host) return;
    layer.classList.toggle('typing', state.typing && !capturing);
    if (!state.typing) selectNote(null);
    if (toolbar) {
      toolbar.classList.toggle('hidden', !state.open || capturing);
      ui.typing.classList.toggle('on', state.typing);
      ui.typing.textContent = state.typing ? '✏️ Typing: on' : '✏️ Typing: off';
      panel.classList.toggle('hidden', !state.open || capturing);
      panel.classList.toggle('left', state.side === 'left');
      ui.size.textContent = String(selected ? selected.size : state.size);
      const cur = family(selected ? selected.color : state.color).id;
      for (const s of ui.swatches) s.classList.toggle('active', s.dataset.color === cur);
    }
  }

  let toastTimer = null;
  function toast(text, isError) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.classList.toggle('error', !!isError);
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), isError ? 6000 : 2500);
  }

  // ---------------------------------------------------------------------------
  // Notes
  // ---------------------------------------------------------------------------

  // Find a reasonably large, stable page element under the click to pin the note to,
  // so the note scrolls and zooms together with the textbook page.
  function findAnchor(x, y, fallbackTarget) {
    let el = document.elementFromPoint(x, y) || fallbackTarget;
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
    grip.textContent = '✥';
    grip.title = 'Drag to move';
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
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
      if (capturing) return;
      setTimeout(() => {
        if (pendingFocus !== note && root.activeElement !== text && text.textContent.trim() === '') removeNote(note);
      }, 0);
    });
    del.addEventListener('pointerdown', (e) => e.preventDefault());
    del.addEventListener('click', () => removeNote(note));
    makeDraggable(grip, el, note);
    // Clicking the note's border/grip area shouldn't create a new note.
    el.addEventListener('pointerdown', () => selectNote(note));
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

  function applyStyle(note) {
    const { color, halo } = readableColor(note.color, note.bg);
    note.textEl.style.color = color;
    // A thin outline in the opposite color keeps text readable on busy pictures.
    note.textEl.style.textShadow = halo
      ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].map(([a, b]) => `${a}px ${b}px 1px ${halo}`).join(',')
      : 'none';
    note.textEl.style.fontSize = note.size + 'px';
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
  }

  // Keep every note glued to its page element (handles scrolling, zoom, resizing).
  function tick() {
    for (const n of notes) {
      const a = n.anchor;
      if (!a.isConnected) {
        n.el.style.display = 'none'; // page changed; note belonged to the old page
        continue;
      }
      const r = a.getBoundingClientRect();
      if (!r.width && !r.height) {
        n.el.style.display = 'none';
        continue;
      }
      n.el.style.display = '';
      const scale = r.width / n.baseW;
      const x = r.left + n.fx * r.width - (scrollX0(a) - n.sx) * scale;
      const y = r.top + n.fy * r.height - (scrollY0(a) - n.sy) * scale;
      n.el.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    }
    requestAnimationFrame(tick);
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

  function onOwnKey(e) {
    const path = e.composedPath();
    const note = [...notes].find((n) => path.includes(n.textEl));
    if (!note) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      note.textEl.blur();
      selectNote(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Screenshot support
  // ---------------------------------------------------------------------------

  function captureStart() {
    capturing = true;
    if (!host) return;
    layer.classList.add('capturing');
    refocusAfterCapture = selected && root.activeElement === selected.textEl ? selected : null;
    if (refocusAfterCapture) refocusAfterCapture.textEl.blur(); // hide the blinking caret
    render();
  }

  function captureEnd() {
    capturing = false;
    if (!host) return;
    layer.classList.remove('capturing');
    render();
    if (refocusAfterCapture && notes.has(refocusAfterCapture)) focusEnd(refocusAfterCapture.textEl);
    refocusAfterCapture = null;
  }

  // ---------------------------------------------------------------------------
  // Messages from the background worker
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
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
