# Delicate Studio for Chrome

Records any browser tab in Delicate Studio and gives recording shortcuts that work from any app.

- **Record this tab** (popup, or Alt+Shift+R on the tab): Studio captures the tab's sound, names the take after the tab and plays the tab back while it records, because Chrome mutes a tab while it is captured.
- **Ctrl+Shift+9** (⌘⇧9 on a Mac) starts and stops recording in Studio, **Ctrl+Shift+8** sets a marker. Both are global, so they also work while another app is in front.
- The toolbar badge shows REC while Studio records; the popup shows the time and take, with Stop and Marker.
- Installing opens Studio with a short welcome.

Shortcuts can be changed at `chrome://extensions/shortcuts`.

## Try it unpacked

1. Open `chrome://extensions`, switch on Developer mode.
2. Load unpacked → choose this `extension` folder.
3. Pin it from the puzzle piece in the toolbar.

## Publish in the Chrome Web Store

Zip the contents of this folder (manifest.json at the top level) and upload it in the Chrome Web Store Developer Dashboard.

Privacy practices, as asked by the dashboard:

- **Single purpose:** record the sound of a browser tab into Delicate Studio and control Studio's recorder with shortcuts.
- **tabCapture:** captures the audio of the tab the user picks, for Studio to record.
- **activeTab:** the capture only works on the tab where the user clicked the extension or pressed its shortcut.
- **storage:** keeps which Studio tab is open and its recording state for the badge and popup, in session storage only.
- **Host access to studio.delicateaudio.com:** a content script passes messages between the extension and the Studio page.
- **Data:** the extension collects and sends no data. Audio goes from the captured tab straight into Studio in the same browser and is stored in that browser until the user exports it.

## Files

- `manifest.json`: Manifest V3, Chrome 116 or newer.
- `background.js`: service worker with the tab-capture stream ids, the Studio tab registry, badge, shortcuts and install welcome.
- `bridge.js`: content script on studio.delicateaudio.com, relays between the page (window.postMessage, checked by source and origin) and the service worker.
- `popup.html`, `popup.css`, `popup.js`: the toolbar popup.
- `_locales/`: English, German, French, Spanish, Italian, Portuguese and Hindi, following Chrome's language.
- `fonts/`: JetBrains Mono and Instrument Serif under the SIL Open Font License (`fonts/OFL.txt`).
