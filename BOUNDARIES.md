# Agent Operating Boundaries

Binding for any agent working in this repo. Approved by the project owner
2026-08-18 after two unauthorized actions (a write to the live Karakeep instance,
and an OS-level screen capture). Read this before BRIEF.md.

## The rule

**Anything not on the allowlist below requires explicit sign-off from the
supervisor before you do it.** Ask and wait. "I'll undo it right after" is not a
substitute for asking — a cleanup step that fails halfway leaves debris nobody
notices. If you are unsure whether something is on the list, it is not: ask.

Being blocked is an acceptable outcome. Reaching outside the boundary to unblock
yourself is not. Report the block and stop.

## Allowed without asking

**Filesystem**
- Read/write/delete anything inside this repo, except files this doc protects.
- Read the sibling `../raindrop-app/` and `../karakeep-extension/` trees (reference only, never modify).
- Write to `tmp-screenshots/` and other gitignored scratch paths in this repo.

**Karakeep API (`http://100.89.248.28:3000`)**
- Any **read-only** request: `GET` on `/api/v1/*` and `/api/assets/*`.
- Probing endpoint existence and response shapes with curl is encouraged.

**Local toolchain**
- `npm install` / `run` / `ci`, `npx tsc`, `electron-vite`, vitest.
- `git` limited to local history: add, commit, status, log, diff, show, restore.
- Launching this app's own Electron process, and Electron's own APIs
  (`webContents.capturePage()`, `WebContentsView`, `safeStorage`, etc.).

## Requires sign-off — never do these unprompted

**Data**
- Any `POST` / `PATCH` / `PUT` / `DELETE` against the Karakeep instance. This is a
  real personal bookmark library, not a fixture.
- Any request to a host other than the Karakeep instance and package registries.

**The user's machine outside this repo**
- `screencapture` or any OS-level screen, window, audio, or camera capture. Use
  Electron's `capturePage()` — it captures only this app's own web contents.
- Reading, writing, or deleting outside this repo and the two reference trees.
  Explicitly off-limits: `~/Desktop`, `~/Documents` (beyond this project),
  `~/Downloads`, `~/Library`, Keychain (beyond this app's own `safeStorage` entry),
  browser profiles, shell history, SSH/cloud credentials.
- Installing anything globally, changing system or app settings, `sudo`.
- AppleScript / `osascript` / Accessibility automation of other applications.

**Outbound**
- `git push`, adding a remote, creating a repo, opening a PR.
- Posting, uploading, or sending anything anywhere.

**Secrets**
- The API key lives only in `.env.local` (gitignored) and Keychain. It must never
  appear in source, logs, console output, commit messages, screenshots, or
  a message back to the supervisor.

## Standing narrow exception: highlight write testing

Highlight create/update/delete is the feature under test and cannot be verified
read-only. Scoped authorization, valid until revoked:

- Bookmark `od9gkte7abmja0c4o1o8lii1` (the arxiv paper) is the **only** permitted
  write target, via `/api/v1/highlights` only.
- You may create highlights there, then update and delete **highlights you created
  in that same run**. Track their IDs.
- These three pre-existing highlights are **off-limits** — never update or delete:
  - `xtimrmid5l1fit5iuktxhyfq` (bookmark `od9gkte7abmja0c4o1o8lii1`)
  - `bj3ne7f4xk6u4aotfmd9qiy1` (bookmark `iee0die1to9qk2g0k7lyoxp0`)
  - `okr2x1nep6bg2yebn91x9c8c` (bookmark `iee0die1to9qk2g0k7lyoxp0`)
- Leave no highlight you created behind. Report the IDs you created and deleted so
  the supervisor can verify the count returns to 3.
- This exception covers nothing else — no bookmarks, lists, tags, or users.

## If you break a boundary

Say so immediately and plainly in your next report, before describing anything
else, including exactly what was touched and what you did about it. Self-reporting
is expected and will not be held against you; concealment is the failure that
matters.
