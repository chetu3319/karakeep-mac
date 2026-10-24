# Karakeep for Chrome

A Manifest V3 Chrome extension that brings the desktop app's web reader to
ordinary browser tabs: save the page you're on, see your Karakeep highlights
drawn on it, and highlight, annotate or ask AI about passages in place.
Everything syncs through the same `/api/v1` REST API as the desktop app, so
highlights made here show up in the Mac app and the Karakeep web app too.

## What it does

- **Save to Karakeep** from the toolbar popup, the right-click menu (page or
  link), or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>.
- **Highlights on saved pages.** Open a page you've saved and its highlights
  are drawn in place, in their colours, with a dot on those that carry a note.
  The toolbar badge shows how many there are.
- **Highlight toolbar, on request.** Select text, right-click, and choose
  **Highlight with Karakeep** (or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>).
  The toolbar is the desktop reader's own: four colours, Note, Copy, and the AI
  actions Explain and Ask…. Unlike the desktop reader, it does **not** appear
  on every selection; on the open web most selections are copy and paste.
- **Click a highlight** to recolour it, read or edit its note, copy or delete it.
- **Highlighting an unsaved page saves it** first, then the highlight.
- **The popup** on a saved page shows favourite / archive / open in Karakeep /
  delete, tags, lists, the bookmark's note, and every highlight. Click one to
  jump to it on the page.
- **AI answers** use Google Gemini with your own key (Settings), with the
  desktop app's prompts (`src/main/aiPrompt.ts`). "Save as note" keeps an
  answer as the highlight's note.

## Build and load

```bash
npm install
npm run ext:build        # -> extension/dist
```

In Chrome, open `chrome://extensions`, turn on **Developer mode**, click
**Load unpacked**, and pick `extension/dist`. The settings page opens on first
install. Enter your server URL and an API key (Karakeep → Settings → API keys).

`npm run ext:watch` rebuilds the scripts on change. Click the reload icon on the
extension's card to pick them up.

## How it fits together

| Piece | File | Role |
| --- | --- | --- |
| Service worker | `src/background.ts` | The only part that talks to Karakeep and Gemini. Context menu, shortcuts, badge. |
| API client | `src/api.ts` | The subset of `src/main/api.ts` the extension needs, on `fetch`. |
| Content script | `src/content.ts` | Draws highlights, owns the toolbar and popovers. A port of `src/preload/webpane.ts`. |
| Popup | `src/popup/` | React and Tailwind, with the desktop app's `Icon` and class vocabulary. |
| Settings | `src/options/` | Server, API key, custom headers, Gemini key, highlight behaviour. |

Shared with the desktop app, unchanged: the highlight palette and popover
styles (`src/shared/highlightUi.ts`), safe markdown rendering
(`src/shared/safeMarkdown.ts`), API schemas (`src/shared/types.ts`) and the
Gemini prompt builder (`src/main/aiPrompt.ts`). The anchoring core (finding a
stored highlight in a live page) was lifted out of the web-pane preload into
`src/shared/pageAnchor.ts`, with unit tests. The desktop preload still has its
own copy. Moving it onto the shared module is a follow-up.

The toolbar renders inside a **closed** shadow root, so the page's scripts and
styles can't reach it.

## Privacy

The API key and Gemini key live in `chrome.storage.local`, which is never
synced. With **Show my highlights on saved pages** on, the extension asks your
Karakeep server whether each page you open is saved (`GET
/bookmarks/check-url`). That lookup is how it knows to draw highlights. Turn it
off and the extension only contacts the server when you save, highlight, or
open the popup.

## Tests

```bash
npm test               # unit tests, including src/shared/pageAnchor.test.ts
npm run ext:typecheck
npm run ext:e2e -- <outDir>
```

`ext:e2e` builds `extension/dist-e2e`. That build is identical to `dist` except
that the toolbar's shadow root is open, so the run can click inside it; never
load it as your real extension. The run then drives real Chromium under Xvfb
against `e2e/mock-server.mjs`: an in-memory Karakeep exposing exactly the
endpoints the extension calls, a Gemini streaming stub, and two sample
articles. Every step is checked against what reached the server, and the run
writes screenshots and `results.json` to `<outDir>`.

## Known limitations

- Top-level frames only: text inside iframes can't be highlighted.
- Highlights anchor by text and context, like the desktop web pane. A page that
  has changed substantially since a highlight was made may not place it. The
  extension retries while the page hydrates and then gives up quietly.
- Offsets are measured over the live page's text, as the desktop app does. The
  Karakeep web app measures over its cached reader view, so the two can differ
  for the same passage. Both anchor by text first.
