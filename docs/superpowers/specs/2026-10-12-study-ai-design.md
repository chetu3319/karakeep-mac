# Study: rethinking the AI features in the reader

Date: 2026-10-12
Status: approved for implementation

## Why

The app has two AI features. The **inline query** is the popup on a text selection; it gives quick answers. The **sidebar** ("AI Co-Pilot", `PageAiDrawer`) is meant for deeper analysis. In practice the sidebar falls short. The user's own example: they were trying to understand a figure, a set of formulas, or a dense technical sentence. They had to copy and paste the passage into the sidebar. Then they had to work out themselves which part of the page each sentence of the answer was talking about.

What the code does today:

1. **The sidebar's view of a PDF is too narrow.** It is grounded only in the text of the page you're currently on (`PdfPane` → `onAiContextChange`). When you scroll, that one page is replaced, and earlier turns lose the page they were asked about. It can't connect ideas across sections.
2. **The sidebar never sees your selection.** Only the inline popup gets it, which is why the user had to copy and paste.
3. **The AI only ever sees text.** Figures, and formulas that PDFium extracts as garbled characters, never reach the model.
4. **Answers don't point back into the document.**
5. **The two features are disconnected.** The inline popup can't hand off to the sidebar. Sidebar chats disappear when the panel closes. The web view has a separate copy of the inline popup (vanilla DOM in `preload/webpane.ts`) with emoji labels. The PDF version (`SelectionAiHUD`) is yet another floating window.

The user's framing, which this design keeps:

- **The inline query must be quick, short and keep you in your reading flow.**
- **The sidebar is for going deeper.** Sometimes that's one passage or figure, sometimes the whole paper and how its sections connect.

## Goals

1. **The sidebar ("Study") can see the whole document.** It always reads the full document, not just the current page. What you point at is the focus of a question, not the limit of what the model can see.
2. **Point, don't paste.**
   - A text selection, or a rectangle you drag over a figure or equation, becomes a chip attached to your next question.
   - Figure and equation regions are sent to the model as images.
3. **Answers point back.**
   - Every claim in an answer carries a small reference tag.
   - Clicking the tag jumps the reader to that place and briefly flashes the exact passage.
4. **The inline query stays a glance.**
   - It lives in the same selection toolbar as the highlight colours, not in a second floating window.
   - It answers in two or three sentences.
   - It can hand off to Study with "Continue in Study".
5. **Chats persist per bookmark.**
   - They're stored locally for instant opening.
   - They're backed up to Karakeep as an HTML file attached to the bookmark. That file opens in Karakeep's web app as a readable transcript.
6. **It looks native to the app.**
   - It uses the same dark reader, emerald accent, line icons and type scale.
   - The selection toolbar shares the highlight popover's look (`.kh-pop` styles).
   - No emoji, and no new visual language.
   - The PDF and web readers behave the same way.

## Non-goals

- Backend changes to Karakeep. Only API endpoints that already exist are used.
- Other AI providers. It stays on Gemini, with the existing key, model setting and `net.fetch` path.
- More than one chat thread per bookmark. There is one thread per bookmark, and "Clear" (with a confirmation) starts over.
- Agent tool use beyond the document itself, such as web search or reading other bookmarks.
- Syncing chats in real time between devices. Last write wins (see Persistence).

## Anti-goals (failure even if it "works")

- **Looking bolted on.** Emoji tabs, solid green chat bubbles, or a third floating-window style. The user named UI quality and seamlessness as the thing that would make them wince.
- **Answers whose claims can't be traced to the page,** or reference tags that silently do nothing when clicked.
- **An inline query that becomes slow or wordy.**
- **Any regression to highlights:** creating, anchoring, the popover, or the flash on focus.
- **Model output inserted into the web page as HTML.** The in-page UI runs inside an untrusted third-party page. It must keep building DOM with `textContent` and `createElement` only, never `innerHTML`.

## Design

### 1. Surfaces

**Selection toolbar (PDF and web).**

- The existing selection toolbar holds the highlight colour dots. It gains these text actions after a thin divider: **Explain · Define · Math · Ask…**
- *Dejargonify* is folded into Explain. (My call; the Explain prompt already asks for plain language.)
- Clicking an action expands an answer area under the same toolbar: the same card and the same `.kh-pop` look, with no separate window.
- The answer area has three footer actions: **Copy**, **Save as note** (the existing behaviour: create a highlight carrying the answer as its note) and **Continue in Study →**.
- **Ask…** opens a one-line input inside the card.
- Esc or a click outside dismisses it, as today.
- The toolbar also gets an **Add to Study** action, shown as an icon with a tooltip. It attaches the selection as a chip without asking anything.
- PDF: replace `SelectionAiHUD` with an expanded `SelectionMenu` (PdfPane.tsx). Web: rework `openAiPopover` and the selection toolbar in `preload/webpane.ts` to match.

**Study panel (replaces `PageAiDrawer`).**

- **Toolbar button.** "AI Co-Pilot" becomes **Study**, with a line icon from `Icon.tsx`. The button sits in the same place in the reader toolbar, and its toggled state uses the existing emerald tint.
- **Shortcut.** Add a View menu item "Study panel" with accelerator ⌥⌘S. (My call.)
- **Header.** "Study", then a muted scope line ("Whole paper · 15 pages" or "Whole article"), then "Clear" and the close button.
- **Messages.**
  - User turns are neutral bubbles (`neutral-800` background with a border), not solid green.
  - Attachment labels sit above the question, with a paperclip or region icon.
  - Model turns are plain text, rendered by `miniMarkdown`.
- **Composer.** Attachment chips sit above a single input; each chip can be removed. ⌘↵ or ↵ sends.
- **Empty state.** Two or three short suggested prompts, with no emoji.
- **Width and resize.** The panel keeps `SidePanel`'s existing width and resize behaviour, and the web pane's bounds shrink the way they do today.
- **Tabs.** It works on the PDF, Web and Preview tabs. On Preview, clicking a reference switches to the reader tab (Web or PDF) and then jumps.

**Region capture.**

- A **Capture region** tool button in the reader toolbar, next to Study, starts it.
- The cursor becomes a crosshair; drag a rectangle; Esc cancels.
- The result is an image chip (labelled "Figure · p.4" or "Region · p.4") plus any text inside the rectangle.
- **PDF:**
  - Overlay on the page element.
  - Render the rectangle with the engine's `renderPageRect` at device-pixel scale.
  - Cap the image at about 1600px on its long side.
  - Read the text inside the rectangle from the page geometry.
- **Web:**
  - The crosshair overlay lives in the preload, as a vanilla DOM element drawn inside the page.
  - The preload sends the rectangle to main, which calls `webContents.capturePage(rect)`.
- Capturing opens Study if it isn't already open.

### 2. Context the model receives

**Study (deep):**

- **Document text, all of it.**
  - **PDF:** every page's PDFium text, with page markers (`[[page 4]]`). `pageText(page)` and the page index already exist in `PdfPane`.
  - **Web / Preview:** `useBookmarkText`. Raise its cap for Study only, since it currently cuts to 24k characters.
  - **Budget:** about 400k characters. Above that, keep the first 2 pages, the pages around the focus and the current page, and the last page. Insert `[… pages N–M omitted …]` markers for the rest.
- **Prompt order.** Put the document first, as a stable prefix, so Gemini's automatic prefix caching can make follow-up turns cheaper.
- **Focus for this turn:**
  - the attached selections: quote, page, and roughly 200 surrounding characters;
  - the attached regions: image (inline data) plus page;
  - "Reader is currently on page N" (PDF only).
- **History:** every earlier turn as text, with the attachment labels inline. Re-send the images from roughly the last four turns; older images are replaced by their labels. (My call.)
- **Model settings:** thinking level medium, as today.

**Inline (quick):** the selection, the surrounding paragraph and the current page text, as today. Thinking level stays low. The system prompt asks for at most three sentences.

### 3. References: answers that point back

- **Prompt contract.** The system prompt tells the model to back every claim with an inline reference: `[[ref p=4 "exact verbatim quote of at most 25 words"]]`.
  - `p=` is required for PDFs and left out for web content.
  - Region references use `[[ref fig p=4 "caption or nearby text"]]`.
- **Parsing.**
  - A parser in the renderer (new `lib/aiRefs.ts`) turns these markers into tag elements.
  - While a stream is in progress, an unfinished `[[` is held back, not shown raw.
- **Labels.** PDF tags read `p.4` (or `Fig. · p.4` for figures). Web tags are numbered `1`, `2`, `3` in order. The full quote shows as a tooltip.
- **On click, PDF:**
  - Find the quote using the logic in `pdfAnchor.ts`: search the hinted page first, then nearby pages, ignoring whitespace differences.
  - Scroll there and draw a temporary flash overlay over the quote's text, the same treatment a focused highlight gets (`flashId` / `animate-pulse`), for about 1.5s.
  - This flash overlay is new and is not a saved highlight.
- **On click, web:**
  - Send the quote to the preload over a new IPC message, `webpane:reveal-quote`.
  - The preload finds the quote in the DOM, ignoring whitespace differences. It reuses the text-anchoring helpers that already place highlights.
  - It scrolls the quote into view and wraps it in a temporary flash marker that removes itself afterwards.
- **Not found.** The tag shows a muted style with the tooltip "Couldn't find this passage". Clicking does nothing. The tag never silently fails.
- **Verify early.** Resolve every reference once when the turn finishes, so dead tags show as dead straight away instead of only on click.

### 4. Persistence

- **Local.**
  - `app.getPath('userData')/chats/<bookmarkId>.json`, read and written from main over IPC.
  - Schema: `{ v: 1, bookmarkId, updatedAt, messages: [{ role, text, attachments?: [{ kind: 'text' | 'region', page?, quote?, rect? }] }] }`.
  - Region images are not stored; the rectangle and page are, so they can be re-rendered if needed.
- **Remote (Karakeep).** Verified against the live server on 2026-10-12, with all test data removed afterwards:
  - `POST /api/v1/assets` accepts `text/html`. It returns 400 "Unsupported asset type" for JSON, Markdown and plain text.
  - `POST /api/v1/bookmarks/{id}/assets` with `{ id, assetType: 'userUploaded' }` returns 201. The file then appears in `bookmark.assets` with its `fileName`.
  - `GET /api/assets/{id}` returns the file byte for byte.
  - `DELETE /api/v1/bookmarks/{id}/assets/{assetId}` returns 204 and deletes the file; a later GET returns 404.
  - Not yet verified: whether deleting a bookmark also deletes its attached files. Check this during the build and note the result in `api.ts`'s probe comment.
- **File format.** One file per bookmark, named `karakeep-desktop-study.html`:
  - A readable transcript: title, then each turn, with references shown as quoted passages and page numbers. All text must be HTML-escaped.
  - A `<script type="application/json" id="kk-study">` block carrying the same data as the local file.
- **Sync rules.**
  - **When to push:** after a turn finishes, debounced by about 5s, and when the panel closes or the bookmark changes. Upload the new file, attach it, then detach the old one. If the new file fails to attach, keep the old one.
  - **Opening a bookmark:** look for that file name in `bookmark.assets`. If its `updatedAt` is newer than the local copy, load it.
  - **Conflicts:** last write wins.
  - **Failures are quiet:** a muted line in the panel ("Not backed up yet") with a retry. Never a modal.
- **Hiding the file.** Filter it out anywhere the app lists or uses a bookmark's attachments, so it's never picked as the bookmark's PDF, image or other main file.

### 5. Code to retire

- **Delete:** `SelectionAiHUD.tsx`, and the emoji-labelled `openAiPopover` UI in `preload/webpane.ts` (its replacement is described above).
- **Rewrite:** `PageAiDrawer.tsx`, as `StudyPanel.tsx`.
- **Drop:** `meso-page` and `micro-dejargon` from `AiMode` once nothing uses them. Add a `study` mode. `ai.ts`'s prompt builder gains support for image parts (`inlineData`).

## Constraints

- Electron 32, React 18, TypeScript strict, Tailwind. `npm run typecheck` must pass. There is no unit test framework; adding vitest for `aiRefs.ts` and the chat file format is the builder's call.
- Use the existing renderer ↔ main IPC style (`shared/ipc.ts`, `preload/index.ts`), and Karakeep calls go through `api.ts`. The Gemini API key never leaves main.
- The web reader is a native `WebContentsView` drawn over the window. Anything shown on top of the page must live in the preload, and React UI must sit outside the view's bounds.
- macOS arm64 only.

## Left to the builder

- Exact component structure and file split; icon artwork (match the line style in `Icon.tsx`).
- How the region overlay is implemented for each reader.
- The prompt wording, as long as the reference contract and the length limits hold.
- Whether to add vitest.
- Smaller interaction details: hover states, focus order, and keyboard access for the tags.

## Settled during the builder review

These were settled as my calls after a fresh builder read this document.

1. **Context budget.** Use a single constant of about 400k characters. If Gemini rejects a request for being too large (a 400 error mentioning tokens or the context length), retry once with half the budget. If that also fails, show the error in the panel with Retry.
2. **Where the PDF text comes from.**
   - Extract it lazily in the renderer the first time Study opens on a document, showing a progress line ("Reading document… 12 / 40 pages").
   - Keep it in memory for that document session, and reuse `PdfPane`'s per-page text cache.
   - The renderer sends the assembled text with each turn over IPC; main stays stateless. Local IPC of a few hundred KB is fine, and the prefix stays byte-identical, so Gemini's caching still applies.
3. **Empty content and tabs.**
   - **No document text** (for example, a link that hasn't been crawled): Study still opens. The scope line reads "No page text available — answering from title and description", and region capture still works.
   - **PDF bookmarks:** the document text always comes from the PDF. Opening Study, or clicking a reference, while on Preview switches to the PDF tab first.
   - **Link bookmarks:** clicking a reference on Preview switches to the Web tab first.
4. **Sync on open.**
   - Download the remote file at most once per app session per bookmark, when Study first opens for it, and only if `bookmark.assets` has a file with the Study name.
   - A remote file that is malformed is ignored, and the local copy is kept.
   - A remote file from a newer schema version (`v` higher than this app supports) is also ignored. In that case the app never pushes over it, and the panel shows "Saved by a newer version of the app".
5. **Hiding the file.** Add one helper, `isStudyAsset(asset)`, in `shared/`, then search the code for every place that reads `bookmark.assets` and apply it there. This is not a wider refactor.
6. **References that can't be found** (common for garbled formulas). Fall through this ladder:
   1. exact quote;
   2. the quote with whitespace normalised, on the hinted page then nearby pages;
   3. **PDF only:** jump to the hinted page with no flash. The tag gets an "approximate" style, with the tooltip "Jumped to page 4 — exact passage not found".
   4. Dead tag. On the web there is no page to fall back to, so the ladder ends here.
7. **Concurrency and hand-off.**
   - A Study stream keeps going if you switch bookmark or tab. It saves to the bookmark it was started on, because the store key is fixed when you send.
   - "Continue in Study" adds the inline exchange as the first two turns: a user turn with the selection chip and the action name ("Explain"), then the model's inline answer. Follow-up questions therefore have it as context.

## Calls I made (for the user to check)

- Dejargonify folded into Explain.
- ⌥⌘S for the Study panel.
- One thread per bookmark, with Clear.
- Re-send images from about the last four turns only.
- Document budget of about 400k characters, with pages around the focus kept when trimming.
- Web reference tags are numbered rather than labelled by section.
