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
      --accent: #0a84ff;
      --shadow: 0 10px 40px rgba(17, 12, 46, .22), 0 2px 8px rgba(17, 12, 46, .12);
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

    /* ---------- typed text ---------- */
    .note {
      position: absolute; left: 0; top: 0; transform-origin: 0 0;
      pointer-events: none; min-width: 12px;
    }
    .typing .note { pointer-events: auto; }
    .text {
      font-family: "Segoe Print", "Bradley Hand", "Comic Sans MS", Arial, sans-serif;
      line-height: 1.2; white-space: pre; outline: none; padding: 1px 4px;
      min-width: 8px; min-height: 1.2em; cursor: text; border-radius: 8px;
      font-weight: 600;
      animation: pop .38s var(--spring) both;
      transition: color .35s var(--ease), font-size .25s var(--ease), box-shadow .25s var(--ease), text-shadow .35s var(--ease);
    }
    @keyframes pop { from { opacity: 0; transform: scale(.85); filter: blur(3px); } }
    .typing .note:hover .text { box-shadow: 0 0 0 1px rgba(10, 132, 255, .45); }
    .note.selected .text { box-shadow: 0 0 0 1.5px var(--accent), 0 0 0 4px rgba(255, 255, 255, .7), 0 4px 14px rgba(10, 132, 255, .25); }
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
    .grip { left: 0; background: rgba(10, 132, 255, .85); cursor: grab; }
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

    .glass button {
      position: relative; font: inherit; color: var(--ink); cursor: pointer;
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
    .toolbar .drag { cursor: grab; color: var(--ink-soft); padding: 0 3px 0 5px; font-size: 14px; letter-spacing: -2px; }
    .toolbar button { padding: 8px 13px; white-space: nowrap; font-weight: 500; }
    .toolbar button.on {
      background: linear-gradient(180deg, #3b9bff, #0a7aff); color: #fff;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .45), 0 4px 14px rgba(10, 132, 255, .45);
    }
    .toolbar button.icon { width: 32px; height: 32px; padding: 0; }
    .toolbar .sep { width: 1px; height: 20px; background: var(--ink-soft); opacity: .25; margin: 0 2px; }

    .panel {
      top: max(70px, calc(50vh - 190px)); left: calc(100% - 66px); width: 52px; box-sizing: border-box;
      display: flex; flex-direction: column; align-items: center; gap: 7px;
      padding: 12px 0; border-radius: 26px;
    }
    .panel.left { left: 14px; }
    .panel.hidden { transform: translateX(18px) scale(.94); }
    .panel.left.hidden { transform: translateX(-18px) scale(.94); }
    .panel button { width: 36px; height: 36px; padding: 0; }
    .panel .big { font-size: 16px; font-weight: 700; }
    .panel .small { font-size: 11px; font-weight: 700; }
    .panel .size { font-weight: 600; font-variant-numeric: tabular-nums; padding: 1px 0; }
    .panel .size.bump { animation: bump .35s var(--spring); }
    @keyframes bump { 40% { transform: scale(1.3); } }
    .panel .label { font-size: 9.5px; font-weight: 600; color: var(--ink-soft); text-transform: uppercase; letter-spacing: .06em; }
    .panel .sep { height: 1px; width: 26px; background: var(--ink-soft); opacity: .25; margin: 2px 0; }
    .panel .swatch {
      width: 28px; height: 28px; border-radius: 50%;
      box-shadow: 0 0 0 1.5px rgba(255, 255, 255, .85), 0 2px 6px rgba(0, 0, 0, .2), inset 0 1px 1px rgba(255, 255, 255, .5);
    }
    .panel .swatch:hover { transform: scale(1.12); }
    .panel .swatch.active {
      transform: scale(1.12);
      box-shadow: 0 0 0 2px rgba(255, 255, 255, .95), 0 0 0 4.5px var(--accent), 0 4px 12px rgba(10, 132, 255, .35);
    }
    .panel .flip { width: 36px; height: 28px; font-size: 14px; color: var(--ink-soft); }

    .toast {
      left: 50%; bottom: 28px; transform: translateX(-50%);
      display: flex; align-items: center; gap: 10px;
      padding: 11px 18px; border-radius: 999px; max-width: 80vw;
      font: 500 13.5px/1.35 var(--font);
      background: var(--glass-strong);
    }
    .toast.hidden { transform: translate(-50%, 24px) scale(.92); }
    .toast.error { color: #fff; background: rgba(215, 38, 38, .82); }
    .toast button { padding: 6px 12px; font-weight: 600; background: var(--accent); color: #fff; }

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
    toolbar.className = 'glass toolbar hidden';

    const drag = document.createElement('span');
    drag.className = 'drag';
    drag.textContent = '⋮⋮';
    drag.title = 'Drag to move the toolbar';
    makeDraggable(drag, toolbar, null);

    ui.typing = btn('✏️ Typing', 'Typing mode: click anywhere on the page to add text (Alt+Shift+T closes the toolbar)', () =>
      sendState({ typing: !state.typing })
    );

    ui.shot = btn('📷 Copy', 'Copy a screenshot with your text to the clipboard (Alt+Shift+S)', () => takeScreenshot());
    ui.clear = btn('🗑 Clear', 'Remove all text boxes', () => {
      if (confirm('Remove all of your typed text from this page?')) chrome.runtime.sendMessage({ cmd: 'clear-all' });
    });
    ui.close = btn('✕', 'Hide toolbar (your text stays on the page)', () => sendState({ open: false, typing: false }), 'icon');

    const sep = () => Object.assign(document.createElement('span'), { className: 'sep' });
    toolbar.append(drag, ui.typing, sep(), ui.shot, ui.clear, ui.close);
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
    toastEl.className = 'glass toast hidden';
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
      const sizeText = String(selected ? selected.size : state.size);
      if (ui.size.textContent && ui.size.textContent !== sizeText) {
        ui.size.classList.remove('bump');
        void ui.size.offsetWidth; // restart the little "bump" animation
        ui.size.classList.add('bump');
      }
      ui.size.textContent = sizeText;
      const cur = family(selected ? selected.color : state.color).id;
      for (const s of ui.swatches) s.classList.toggle('active', s.dataset.color === cur);
    }
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
      toast(err && err.name === 'NotAllowedError' ? 'Screenshot cancelled.' : "Couldn't start the screenshot: " + (err && err.message), err && err.name !== 'NotAllowedError');
      return;
    }
    let blob = null;
    try {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      chrome.runtime.sendMessage({ cmd: 'capture', on: true }); // hide toolbars + outlines in every frame
      captureStart();
      // Give the page a moment to hide our UI (and settle after Chrome's "sharing" bar appears).
      await sleep(450);
      await new Promise((res) => {
        if (!video.requestVideoFrameCallback) return res();
        const t = setTimeout(res, 400);
        video.requestVideoFrameCallback(() => {
          clearTimeout(t);
          res();
        });
      });
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
    await copyImage(blob);
  }

  const PASTE_HINT = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘V' : 'Ctrl+V';

  async function copyImage(blob) {
    try {
      window.focus();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast(`✓ Screenshot copied. Paste it anywhere with ${PASTE_HINT}.`);
    } catch (err) {
      // Usually means the page lost focus during the share prompt; one more click fixes it.
      toast('Screenshot ready.', false, { label: 'Copy to clipboard', onClick: () => copyImage(blob) });
    }
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
