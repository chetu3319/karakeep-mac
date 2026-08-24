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

## Installing a release

Download the `.dmg` from [Releases](../../releases), open it, and drag Karakeep
to Applications.

The build is **not notarized**, so the first launch needs one extra step:
**right-click the app → Open**, then confirm. Double-clicking it the normal way
shows "Karakeep can't be opened because Apple cannot check it for malicious
software" with no Open button; the right-click route is what gets the option.
You only have to do this once.

If you'd rather clear the quarantine flag directly:

```bash
xattr -dr com.apple.quarantine /Applications/Karakeep.app
```

Releases are **Apple Silicon only**. Intel Macs are not built for.

## Building

```bash
npm run package
```

Produces `release/Karakeep-<version>-arm64.dmg`, a matching `.zip`, and the
unpacked `release/mac-arm64/Karakeep.app`.

The app is signed **ad-hoc** by `scripts/afterPack.cjs` rather than left
unsigned. That is not cosmetic: an unsigned bundle keeps Electron's own linker
signature over contents we have replaced, and macOS then refuses to launch it
at all with "Karakeep is damaged and can't be opened" — which, unlike the
unidentified-developer prompt above, has no way past it. Ad-hoc signing makes
the signature describe the bundle we actually shipped. Proper Developer ID
signing and notarization would need a paid Apple Developer account.

Other scripts: `npm run typecheck`, `npm run build`, `npm run icon` (regenerates
the app icon), `npm run smoke` (drives the app headlessly and screenshots it).

## Stack

Electron 32 · electron-vite · React 18 · TypeScript (strict) · Tailwind ·
TanStack Query · zod · EmbedPDF/PDFium.

## Notes and limitations

- **macOS only.** Nothing here is deliberately platform-specific beyond the
  Keychain integration and the packaging target, but nothing else is tested.
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
- **AI chats are not persisted.** The sidebar co-pilot (`PageAiDrawer`) and the
  in-situ selection HUD are backed by Gemini, but a conversation lives only in
  React state and is gone on close, tab switch, or app restart. Karakeep's API
  has no chat/conversation resource, so persistence would need a local store
  here, keyed by bookmark id. See the `TODO(ai-chat-persistence)` comment at
  the top of `src/renderer/src/components/PageAiDrawer.tsx`.

## Credits

The API client and the web-pane highlighting were originally ported from the
Karakeep browser extension; the embedded web view took its shape from the
Raindrop desktop app (MIT). Karakeep itself is a separate project — this is an
unofficial client.
