# Karakeep Desktop (macOS)

A native macOS client for [Karakeep](https://karakeep.app), a self-hostable
bookmark manager. It talks to any Karakeep instance over the REST API at
`/api/v1` with a Bearer token — there is no server component here.

The point of the app is the reading and annotating experience that a browser
tab doesn't give you: your library in a real three-pane window, the live page
in an embedded web view, and PDFs you can highlight and annotate in place, with
every highlight synced back to Karakeep.

## What it does

- **Library** — lists (as a tree), tags, search, and the bookmark detail view.
- **Reader** — the Preview tab renders Karakeep's cached reader view of a link
  with your highlights placed in it, so a saved page can be read without the
  site it came from being up, or reachable, at all.
- **Web pane** — opens the bookmark's live page in an embedded view, finds your
  existing highlights in the real DOM, and lets you create, recolour, annotate
  and delete them inline.
- **PDF pane** — renders PDF bookmarks with [EmbedPDF](https://embedpdf.com)
  (PDFium via WebAssembly), with text selection, highlighting, and notes. The
  wasm and fonts are bundled, so the viewer never reaches out to a CDN.
- Highlights, notes and colours round-trip through the Karakeep API, so they
  show up in the web app and the browser extension too.

## Running it

```bash
npm install
npm run dev
```

On first launch the app asks for your instance URL and an API key (Settings →
API keys in Karakeep). The key is stored in the macOS Keychain via Electron's
`safeStorage`, not in a config file.

For development you can skip onboarding by creating `.env.local`:

```
KARAKEEP_BASE_URL=http://localhost:3000
KARAKEEP_API_KEY=...
```

That file is gitignored and read only in development.

## Building

```bash
npm run package
```

Produces `release/mac-arm64/Karakeep.app`. Builds are **unsigned** — macOS will
quarantine the app on first open (right-click → Open, or clear the quarantine
attribute yourself).

Other scripts: `npm run typecheck`, `npm run build`, `npm run smoke` (drives the
app headlessly and screenshots it).

## Stack

Electron 32 · electron-vite · React 18 · TypeScript (strict) · Tailwind ·
TanStack Query · zod · DOMPurify · EmbedPDF/PDFium.

## Notes and limitations

- **macOS only.** Nothing here is deliberately platform-specific beyond the
  Keychain integration and the packaging target, but nothing else is tested.
- **The cached article is somebody else's HTML.** It is sanitised on the way
  in (DOMPurify: no scripts, frames, embeds, forms, or inline styles) and then
  rendered in a frame that cannot execute anything —
  `sandbox="allow-same-origin"` with no `allow-scripts`, which still lets the
  app reach into the frame's DOM to place highlights. Both layers are
  deliberate; see the comments in `src/renderer/src/lib/readerContent.ts`.
  Text and layout come from the cached copy, but any images in it are still
  fetched from wherever the article points them (with `no-referrer`), so a
  reader view is only as offline as the article is image-free.
- **Reader highlights are matched by quote, not by offset.** A highlight made
  in the Web pane or the browser extension carries offsets into the live
  page's text, which is not the reader view's text. The stored quote is what
  gets searched for; the offsets only break ties between repeated matches. See
  `src/shared/textAnchor.ts`, which the live pane uses for the same reason.
- **PDF highlight offsets are local to this app.** Karakeep stores a highlight
  as two character offsets into the document text. A PDF has no canonical text
  string, so this app defines one (PDFium's extraction, pages end to end) — and
  Karakeep's own server-side extraction of a PDF can differ from it completely.
  The highlighted `text`, the note and the colour round-trip to every other
  Karakeep client; the raw offsets are only meaningful here. See
  `src/renderer/src/lib/pdfAnchor.ts`, which treats the stored quote as the real
  anchor and the offsets as a hint.
- The `reference/` directory cited in a few source comments holds verbatim
  copies of the Karakeep browser extension and Raindrop sources that were read
  while building this. It is deliberately not part of this repository.

## Credits

The API client and the web-pane highlighting were originally ported from the
Karakeep browser extension; the embedded web view took its shape from the
Raindrop desktop app (MIT). Karakeep itself is a separate project — this is an
unofficial client.
