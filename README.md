# VHL Text Overlay

A Chrome extension for **reader.vhlcentral.com** that lets you type text on top of
the textbook pages, so you can fill in blanks as you go. Save your work by taking a
screenshot. Your text is **not saved**: it's only an overlay and disappears when you
reload the page.

## Install (one time)

1. Download this repository (green **Code** button → **Download ZIP**) and unzip it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `extension` folder.
5. Pin it: click the puzzle-piece icon in Chrome's toolbar, then the pin next to **VHL Text Overlay**.

## Use

1. Open your textbook on reader.vhlcentral.com.
2. Click the blue **T** extension icon (or press **Alt+Shift+T**). A small toolbar appears and **typing mode** turns on.
3. Click anywhere on the page and start typing. Click somewhere else to start another box.
   - **Enter** starts a new line. **Esc** finishes the box.
   - Click a box to edit it. Drag its blue **✥** tab to move it, or click the red **×** to delete it.
   - Boxes stick to the page, so they move with it when you scroll or zoom.
4. Toolbar buttons:
   - **✏️ Typing: on/off**: turn typing off to use the reader normally (turn pages, click links). Your text stays visible.
   - **A− / A+** and the **color dots**: change the size and color of new text, and of the box you're editing.
   - **📷 Save**: saves a PNG screenshot of what's on screen (with your text, without the toolbar) to `Downloads/VHL Overlay/`. Shortcut: **Alt+Shift+S**.
   - **🗑 Clear**: removes all your text.
   - **✕**: hides the toolbar. Your text stays on the page. Click the icon again to bring the toolbar back.

While typing mode is on, clicks on the page add text instead of reaching the reader,
and your typing doesn't trigger the reader's keyboard shortcuts.

## Notes

- Chrome only lets an extension screenshot a tab after you've clicked its icon or used
  its shortcut on that tab. If **Save** says it can't take the screenshot (for example
  after reloading the page), click the extension icon once or press **Alt+Shift+S**.
- If you turn to a different page and the reader replaces that page's content, the text
  you typed on the old page is hidden along with it.
- You can change the keyboard shortcuts at `chrome://extensions/shortcuts`.
