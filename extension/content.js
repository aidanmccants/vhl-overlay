// VHL Text Overlay - content script.
// Runs in every vhlcentral.com frame. Draws typed text boxes in an overlay layer
// on top of the page. Nothing is saved: the boxes disappear when the page reloads.
(() => {
  if (window.__vhlOverlayLoaded) return;
  window.__vhlOverlayLoaded = true;

  const IS_TOP = window === window.top;
  const COLORS = ['#111827', '#1d4ed8', '#dc2626', '#15803d', '#7c3aed'];
  const MIN_SIZE = 10;
  const MAX_SIZE = 48;

  let state = { open: false, typing: false, color: '#1d4ed8', size: 18 };
  let host = null; // shadow host element
  let root = null; // shadow root
  let layer = null; // container for notes
  let toolbar = null;
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
    .note.selected .text { box-shadow: 0 0 0 1.5px rgba(37, 99, 235, .9); background: rgba(255,255,255,.35); }
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
    .toolbar .size { min-width: 22px; text-align: center; font-variant-numeric: tabular-nums; }
    .toolbar .swatch {
      width: 18px; height: 18px; padding: 0; border-radius: 50%;
      border: 2px solid #fff; box-shadow: 0 0 0 1px #d1d5db;
    }
    .toolbar .swatch.active { box-shadow: 0 0 0 2px #111827; }
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
    ui.smaller = btn('A−', 'Smaller text', () => changeSize(-2));
    ui.size = document.createElement('span');
    ui.size.className = 'size';
    ui.bigger = btn('A+', 'Bigger text', () => changeSize(2));

    ui.swatches = COLORS.map((c) => {
      const s = btn('', 'Text color', () => sendState({ color: c }), 'swatch');
      s.style.background = c;
      s.dataset.color = c;
      return s;
    });

    ui.shot = btn('📷 Save', 'Save a screenshot with your text (Alt+Shift+S)', () =>
      chrome.runtime.sendMessage({ cmd: 'screenshot' })
    );
    ui.clear = btn('🗑 Clear', 'Remove all text boxes', () => {
      if (confirm('Remove all of your typed text from this page?')) chrome.runtime.sendMessage({ cmd: 'clear-all' });
    });
    ui.close = btn('✕', 'Hide toolbar (your text stays on the page)', () => sendState({ open: false, typing: false }));

    const sep = () => Object.assign(document.createElement('span'), { className: 'sep' });
    toolbar.append(
      drag, ui.typing, sep(), ui.smaller, ui.size, ui.bigger, sep(), ...ui.swatches, sep(), ui.shot, ui.clear, ui.close
    );
    root.appendChild(toolbar);

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
      ui.size.textContent = String(selected ? selected.size : state.size);
      for (const s of ui.swatches) s.classList.toggle('active', s.dataset.color === (selected ? selected.color : state.color));
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
    const note = createNote(anchor, x, y, state.color, state.size);
    selectNote(note);
    pendingFocus = note;
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

    const note = { el, textEl: text, anchor, fx: 0, fy: 0, baseW: 1, sx: 0, sy: 0, color, size };
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
    note.textEl.style.color = note.color;
    note.textEl.style.fontSize = note.size + 'px';
  }

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
