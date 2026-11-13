// VHL Text Overlay - background service worker.
// Holds the per-tab UI state (toolbar open, typing on, color, size), relays it
// to every frame in the tab, and takes screenshots.

const DEFAULT_STATE = { open: false, typing: false, color: '#1d4ed8', size: 18 };

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

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function screenshot(tab) {
  broadcast(tab.id, { type: 'capture-start' });
  await sleep(200); // let every frame hide its toolbar / editing outlines
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    broadcast(tab.id, { type: 'capture-end' });
    await chrome.downloads.download({
      url: dataUrl,
      filename: `VHL Overlay/vhl-${timestamp()}.png`,
      saveAs: false,
    });
    broadcast(tab.id, { type: 'toast', text: 'Screenshot saved to Downloads/VHL Overlay' });
  } catch (err) {
    broadcast(tab.id, { type: 'capture-end' });
    console.warn('captureVisibleTab failed', err);
    broadcast(tab.id, {
      type: 'toast',
      error: true,
      text:
        "Couldn't take the screenshot. Click the extension's toolbar icon once (or press Alt+Shift+S) and try again.",
    });
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!isVhl(tab.url)) return;
  const s = await getState(tab.id);
  // Clicking the icon opens the toolbar with typing on; clicking again closes it.
  if (s.open) await setState(tab.id, { open: false, typing: false });
  else await setState(tab.id, { open: true, typing: true });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'take-screenshot' && tab && isVhl(tab.url)) await screenshot(tab);
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
      case 'clear-all':
        broadcast(tab.id, { type: 'clear-all' });
        sendResponse(true);
        break;
      case 'screenshot':
        await screenshot(tab);
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
