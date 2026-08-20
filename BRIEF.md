# Karakeep Desktop (macOS) — Build Brief

Approved architecture: **Option B** — Electron app with its own local renderer,
talking to any Karakeep instance over the REST API at `/api/v1` with a Bearer token.

## Verified API facts (probed live, 2026-08-18 — trust these over guesses)

Base: `http://localhost:3000` — read creds from `.env.local`, NEVER hardcode.
All requests: `Authorization: Bearer <key>`.

- `GET /api/v1/users/me` -> `{id,name,email,image,localUser}`
- `GET /api/v1/bookmarks?limit=N&cursor=...` -> `{bookmarks:[...], nextCursor:"<id>_<iso>"}`
  - bookmark: `{id, firstCreatedAt, createdAt, modifiedAt, title, archived, favourited,
    taggingStatus, summarizationStatus, note, summary, source, userId,
    tags:[{id,name,attachedBy}], content:{...}, assets:[{id,assetType,fileName}]}`
  - `content` (type "link"): `{type,url,title,description,imageUrl,imageAssetId,
    screenshotAssetId,favicon,contentAssetId,readerViewStatus,readerViewScore,
    preferredPreview,crawledAt,crawlStatus,author,publisher,datePublished,dateModified}`
  - other content types exist (text, asset) — handle defensively.
- `GET /api/v1/bookmarks/search?q=...&limit=N` -> same shape
- `GET /api/v1/lists` -> `{lists:[{id,name,description,icon,parentId,type,query,public,
  hasCollaborators,userRole}]}`  — `parentId` means lists are a TREE; `type` is
  `manual` or smart (with `query`).
- `GET /api/v1/tags` -> `{tags:[{id,name,numBookmarks,numBookmarksByAttachedType}]}`
- `GET /api/v1/highlights` -> `{highlights:[{id,bookmarkId,startOffset,endOffset,color,text,note,...}]}`
  - offsets are **plain-text character offsets** over the document text
- Assets: `GET /api/assets/<assetId>` (Bearer auth) -> raw bytes, e.g. image/jpeg
- No OpenAPI spec is served (404). Probe with curl when unsure; don't invent endpoints.

Full client surface already exists — port `reference/karakeep-extension-api.js` (170 LOC,
Bearer + custom-headers + timeout + error handling). Reuse it, convert to TypeScript.

## Reference code (read before writing your own)

- `reference/raindrop-webview/` — MIT, (c) 2024 Rustem Mussabekov. The WebView
  abstraction: one component, iframe on web / embedded browser view on desktop, with
  loading, error, preloader, and white-flash prevention. Take the DESIGN; do not copy
  the `<webview>` tag (see below). Keep the MIT notice on anything you copy verbatim.
- `reference/raindrop-useWithWebView/` — MIT. The postMessage protocol between shell
  and loaded page for highlights: READY / CONFIG / APPLY / ADD / UPDATE / REMOVE.
  Adopt this protocol shape, renamed to KK_*.
- `reference/karakeep-extension-content.js` + `-content-styles.js` — highlight
  serialization (text-offset based), re-application, selection toolbar, note dialog.
  This becomes the **preload script** for the live web pane. Reuse heavily.

## Hard technical requirement

Raindrop uses the `<webview>` tag. Electron discourages it. Use **`WebContentsView`**
(Electron 30+): the live page is a real view owned by the main process, positioned over
the renderer. The renderer reports the pane's bounding rect to main via IPC; main calls
`setBounds`. Handle resize, window resize, tab switch (hide/show), and scroll.
**This is the highest-risk part of the project — build it first and prove it works.**

## Milestone 1 — vertical slice (this task)

Prove the whole architecture end to end. Deliver a runnable `npm run dev` app that:

1. **Shell**: Electron + Vite + TypeScript + React 18 + Tailwind. Hidden titlebar
   (`titleBarStyle: 'hiddenInset'`), correct traffic-light inset, draggable title area,
   native app menu with real macOS roles. Dark mode follows system.
2. **Config + auth**: onboarding screen for server URL + API key + optional custom
   headers. Store the API key with Electron `safeStorage` (Keychain-backed), never in
   plaintext prefs, never in source. In dev, seed from `.env.local` if present.
   Validate by calling `/api/v1/users/me` and show the signed-in user.
3. **Library**: three-pane layout — sidebar (lists tree + tags) / list (virtualized,
   cursor pagination, infinite scroll) / detail. Show title, favicon, url, tags,
   and the image asset via `/api/assets/<id>`.
4. **Search**: server-side via `/api/v1/bookmarks/search`, debounced.
5. **Detail view with tabs**: `Preview` (reader/cached content) and **`Web`**
   (the live URL in a `WebContentsView`). Toggling tabs shows/hides the view
   correctly. Web pane has back / forward / reload / stop, the real URL displayed,
   and "Open in Safari".
6. **Highlights in the Web pane**: preload script (adapted from the extension's
   content.js) applies existing highlights on load and captures new selections,
   writing back to `/api/v1/highlights`. Known caveat: offsets from cached reader
   content will not always map onto the live DOM — apply best-effort with text
   matching as fallback, and log mismatches rather than corrupting data.

## Rules

- **Never write the API key into any tracked file, log line, or commit.** It lives only
  in `.env.local` (gitignored) and Keychain.
- TypeScript strict. No `any` in API types — model the shapes above.
- Small atomic git commits with clear messages as you go. Do not push anywhere.
- Prefer boring, current deps: electron, electron-vite (or vite + electron-builder),
  react, tailwind, zod for API response validation, tanstack-query, tanstack-virtual.
- Do NOT reimplement Karakeep settings/admin/rules — out of scope, link to web app.
- Verify your work by actually running the app and driving it, not by assuming.
- Report honestly: if something doesn't work, say so with the error output.
