// VHL Text Overlay - background service worker.
// Holds the per-tab UI state (toolbar open, typing/highlighter on, colors, size, side), relays it
// to every frame in the tab, and samples screen pixels for the contrast check.

const DEFAULT_STATE = { open: false, typing: false, mark: false, markColor: 'red', color: 'blue', size: 18, side: 'right' };

async function getState(tabId) {
  const key = 'tab:' + tabId;
  const got = await chrome.storage.session.get(key);
  return { ...DEFAULT_STATE, ...(got[key] || {}) };
}

async function setState(tabId, patch) {
  const state = { ...(await getState(tabId)), ...patch };
  await chrome.storage.session.set({ ['tab:' + tabId]: state });
  broadcast(tabId, { type: 'state', state, patch });
  return state;
}

function broadcast(tabId, msg) {
  // Without a frameId, tabs.sendMessage reaches every frame of the tab.
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

function isVhl(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'vhlcentral.com' || h.endsWith('.vhlcentral.com');
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chrome allows only ~2 captureVisibleTab calls per second, so captures are queued.
let captureQueue = Promise.resolve();
let lastCapture = 0;
function queuedCapture(fn) {
  const run = captureQueue.then(async () => {
    const wait = 550 - (Date.now() - lastCapture);
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastCapture = Date.now();
    }
  });
  captureQueue = run.catch(() => {});
  return run;
}

function luminance(r, g, b) {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

// Measure the background behind a new text box from real screen pixels.
// Returns { lum, busy }: the typical (median) brightness, and whether the area has
// lots of strongly different colors (a photo or illustration).
async function sampleBackground(tab, rect, vw) {
  return queuedCapture(async () => {
    broadcast(tab.id, { type: 'probe-start' }); // hide the empty new box
    await sleep(60);
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } finally {
      broadcast(tab.id, { type: 'probe-end' });
    }
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const k = bmp.width / vw; // device pixel ratio
    const sx = Math.max(0, Math.floor(rect.x * k));
    const sy = Math.max(0, Math.floor(rect.y * k));
    const sw = Math.max(1, Math.min(bmp.width - sx, Math.floor(rect.w * k)));
    const sh = Math.max(1, Math.min(bmp.height - sy, Math.floor(rect.h * k)));
    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
    const { data } = ctx.getImageData(0, 0, sw, sh);
    const lums = [];
    const step = 4 * Math.max(1, Math.floor((sw * sh) / 4000)); // ~4000 samples max
    for (let i = 0; i < data.length; i += step) lums.push(luminance(data[i], data[i + 1], data[i + 2]));
    lums.sort((a, b) => a - b);
    const lum = lums[Math.floor(lums.length / 2)];
    const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    // Printed text on a plain page is a small share of pixels; a picture is a lot.
    const different = lums.filter((l) => ratio(l, lum) > 2).length / lums.length;
    return { lum, busy: different > 0.3 };
  });
}

// First install: turn on the one-time tour and show the welcome page.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.storage.local.set({ tutorialPending: true });
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!isVhl(tab.url)) return;
  const s = await getState(tab.id);
  // Clicking the icon opens the toolbar with typing on; clicking again closes it.
  if (s.open) await setState(tab.id, { open: false, typing: false, mark: false });
  else await setState(tab.id, { open: true, typing: true });
});


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tab = sender.tab;
  if (!tab) return;
  (async () => {
    switch (msg.cmd) {
      case 'get-state':
        sendResponse(await getState(tab.id));
        break;
      case 'set-state':
        sendResponse(await setState(tab.id, msg.patch));
        break;
      case 'pick-color': {
        // A color dot was clicked. The frame where letters are selected colors just
        // those letters and answers; if no frame answers, it's the color for the box.
        const painted = await chrome.tabs.sendMessage(tab.id, { type: 'paint', color: msg.color }).catch(() => false);
        sendResponse(painted ? null : await setState(tab.id, { color: msg.color }));
        break;
      }
      case 'clear-all':
        broadcast(tab.id, { type: 'clear-all' });
        sendResponse(true);
        break;
      case 'sample':
        try {
          sendResponse(await sampleBackground(tab, msg.rect, msg.vw));
        } catch {
          sendResponse(null); // no screenshot permission yet: the page keeps its CSS-based guess
        }
        break;
      case 'capture':
        // A screenshot is being taken: every frame hides its toolbars and outlines.
        broadcast(tab.id, { type: msg.on ? 'capture-start' : 'capture-end' });
        sendResponse(true);
        break;
      case 'screenshot':
        // Shortcut pressed inside a frame: the top page takes the screenshot.
        chrome.tabs.sendMessage(tab.id, { type: 'do-screenshot' }, { frameId: 0 }).catch(() => {});
        sendResponse(true);
        break;
      default:
        sendResponse(null);
    }
  })();
  return true; // async response
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove('tab:' + tabId);
});
