// End-to-end run of the extension in real Chromium against the mock Karakeep
// server. Drives every user-facing feature, checks what reached the server
// after each step, and writes screenshots plus results.json.
//
//   node extension/build.mjs --e2e
//   xvfb-run -a -s "-screen 0 1280x960x24" node extension/e2e/run.mjs <outDir>
//
// Headful under Xvfb rather than headless so the native context menu
// actually draws and can be photographed from the X display. It uses the
// dist-e2e build, whose only difference is an open shadow root around the
// toolbar so its buttons can be clicked by selector.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API_KEY, startMockServer } from './mock-server.mjs'
import { sitesHtml } from './sites.mjs'

// Resolved with require so a globally installed Playwright (NODE_PATH) works
// as well as a local one; ESM imports ignore NODE_PATH.
const { chromium } = createRequire(import.meta.url)('playwright')

const here = dirname(fileURLToPath(import.meta.url))
const extDir = resolve(here, '../dist-e2e')
const outDir = resolve(process.argv[2] || join(here, 'out'))
mkdirSync(outDir, { recursive: true })

const API_PORT = 3999
const SITES_PORT = 4100
const server = await startMockServer({ apiPort: API_PORT, sitesPort: SITES_PORT, sitesHtml })
const BASE = `http://127.0.0.1:${API_PORT}`
const SAVED = `${server.sitesOrigin}/articles/deep-reading`
const UNSAVED = `${server.sitesOrigin}/articles/attention-budget`
const S = () => server.state()

const results = []
const shots = []
let shotN = 0
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeout = 6000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(100)
  }
  return false
}
async function shot(page, name, caption, opts = {}) {
  const file = `${String(++shotN).padStart(2, '0')}-${name}.png`
  await page.screenshot({ path: join(outDir, file), ...opts })
  shots.push({ file, caption })
}

const context = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--window-size=1280,960',
    '--window-position=0,0'
  ]
})

let sw = context.serviceWorkers()[0]
if (!sw) sw = await context.waitForEvent('serviceworker')
const extId = new URL(sw.url()).host
const extUrl = (p) => `chrome-extension://${extId}/${p}`

// Point AI answers at the local Gemini stub (a storage key with no UI).
await sw.evaluate((endpoint) => chrome.storage.local.set({ geminiEndpoint: endpoint }), `${BASE}/gemini/v1beta`)

const tabIdFor = (url) => sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id ?? null, url)
const badgeFor = (tabId) => sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)
const openToolbar = (tabId) => sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'kk:open-toolbar' }), tabId)

/** Opens the popup UI as a page for a given tab, sized like the real popup. */
async function openPopup(tabId, { dark = false } = {}) {
  const p = await context.newPage()
  await p.setViewportSize({ width: 380, height: 600 })
  await p.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
  await p.goto(extUrl(`popup.html?tabId=${tabId}`))
  await p.waitForSelector('header')
  await p.waitForFunction(() => !document.querySelector('.animate-pulse'))
  return p
}
async function popupShot(p, name, caption) {
  const box = await p.locator('#root > div').boundingBox()
  await shot(p, name, caption, { clip: { x: 0, y: 0, width: 380, height: Math.min(600, Math.ceil(box.height)) } })
}

/** Selects the first occurrence of `phrase` on the page; returns its centre. */
async function selectPhrase(page, phrase) {
  return page.evaluate((needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let n
    while ((n = walker.nextNode())) {
      const i = n.data.indexOf(needle)
      if (i < 0) continue
      const r = document.createRange()
      r.setStart(n, i)
      r.setEnd(n, i + needle.length)
      // A person selects what they can see.
      const before = r.getBoundingClientRect()
      if (before.top < 80 || before.bottom > innerHeight - 140) {
        window.scrollBy(0, before.top - innerHeight * 0.45)
      }
      const sel = getSelection()
      sel.removeAllRanges()
      sel.addRange(r)
      const b = r.getBoundingClientRect()
      return { x: b.left + Math.min(40, b.width / 2), y: b.top + b.height / 2, left: b.left, right: b.right }
    }
    return null
  }, phrase)
}

const pop = (page) => page.locator('#karakeep-hl-overlay .kh-pop')
const popBtn = (page, label) => pop(page).locator('button', { hasText: label })
const swatch = (page, color) => pop(page).locator(`button.kh-swatch[title="${color}"]`)
const marksOf = (page, id) => page.locator(`mark.karakeep-hl[data-kh-id="${id}"]`)
const serverHl = (pred) => S().highlights.find(pred)

try {
  // ── 1. Onboarding / settings ─────────────────────────────────────────
  const optionsOpened = await waitFor(() => context.pages().some((p) => p.url().includes('options.html')), 4000)
  check('Settings page opens by itself on first install', optionsOpened)
  const options = context.pages().find((p) => p.url().includes('options.html')) ?? (await context.newPage())
  if (!options.url().includes('options.html')) await options.goto(extUrl('options.html'))
  await options.setViewportSize({ width: 860, height: 1240 })
  await options.waitForSelector('text=Connect to Karakeep')
  await shot(options, 'settings-empty', 'First run: the settings page opens automatically and asks for the server and an API key, like the Mac app’s onboarding.')

  await options.fill('input[placeholder="http://localhost:3000"]', '127.0.0.1:3999')
  await options.fill('input[placeholder="kk_..."]', 'wrong-key')
  await options.click('button:has-text("Sign in")')
  await options.waitForSelector('text=API error 401')
  const badKey = (await sw.evaluate(() => chrome.storage.local.get('apiKey'))).apiKey
  check('A wrong API key is rejected and not saved', !badKey)

  await options.fill('input[placeholder="kk_..."]', API_KEY)
  await options.click('button:has-text("Sign in")')
  await options.waitForSelector('text=Signed in as Demo Reader')
  const stored = await sw.evaluate(() => chrome.storage.local.get(['baseUrl', 'apiKey']))
  check('Sign-in checks /users/me, then stores a normalised server URL', stored.baseUrl === BASE && stored.apiKey === API_KEY, stored.baseUrl)

  await options.fill('input[placeholder="AIza..."]', 'AIza-e2e')
  await options.click('button:has-text("Save")')
  await options.waitForSelector('text=Connected to gemini-3.7-flash')
  check('Gemini key is tested before it is saved', true)
  await shot(options, 'settings-connected', 'Signed in, with a Gemini key for the AI actions. The Highlights card spells out that the toolbar only opens when asked for.')

  // ── 2. A saved page shows its highlights ─────────────────────────────
  const page = await context.newPage()
  await page.goto(SAVED)
  const anchored = await waitFor(async () => (await page.locator('mark.karakeep-hl').count()) >= 3)
  const ids = await page.evaluate(() => [...new Set([...document.querySelectorAll('mark.karakeep-hl')].map((m) => m.dataset.khId))])
  check('Saved highlights are drawn on the page when it loads', anchored && ids.length === 3, ids.join(', '))
  check('A highlight with a note carries the note marker', (await marksOf(page, 'hl-2').first().getAttribute('data-kh-note')) === '1')
  const savedTab = await tabIdFor(SAVED)
  const badge1 = await badgeFor(savedTab)
  check('Toolbar badge shows the highlight count on a saved page', badge1 === '3', `badge "${badge1}"`)
  await page.evaluate(() => window.scrollTo(0, 150))
  await shot(page, 'page-highlights', 'A page already saved in Karakeep: its three highlights are drawn in place, in their colours. The green one has a note (the dot).')

  // ── 3. Selecting text alone does nothing ────────────────────────────
  const plain = await selectPhrase(page, 'Children are not born knowing how to sink into a paragraph')
  await page.evaluate(() => getSelection().removeAllRanges())
  await page.mouse.move(plain.left + 1, plain.y)
  await page.mouse.down()
  await page.mouse.move(plain.right - 1, plain.y, { steps: 10 })
  await page.mouse.up()
  await sleep(700)
  const selectedText = await page.evaluate(() => getSelection().toString())
  check('Dragging to select text does not open a toolbar', selectedText.length > 10 && (await pop(page).count()) === 0, `selected "${selectedText.slice(0, 30)}…"`)
  await shot(page, 'plain-selection', 'Selecting text with the mouse shows nothing extra: no toolbar pops up, so ordinary copy and paste stays undisturbed.')

  // ── 4. Clicking an existing highlight ───────────────────────────────
  await page.evaluate(() => getSelection().removeAllRanges())
  await marksOf(page, 'hl-2').first().click()
  await pop(page).waitFor()
  check('Clicking a highlight opens its popover with the note', (await pop(page).locator('.kh-note-view').textContent()).includes('core claim'))
  await shot(page, 'highlight-popover-note', 'Clicking a highlight opens its popover. The note reads in place; colour, Edit, Copy and Delete are underneath.')

  await swatch(page, 'Blue').click()
  await waitFor(() => serverHl((h) => h.id === 'hl-2')?.color === 'blue')
  check('Recolouring a highlight syncs to Karakeep', serverHl((h) => h.id === 'hl-2')?.color === 'blue')
  await popBtn(page, 'Edit').click()
  await pop(page).locator('textarea.kh-ta').fill('This is the core claim. Tools that interrupt reading are not neutral: they rewire what we can attend to. Cite in chapter 2.')
  await shot(page, 'highlight-edit-note', 'Edit turns the popover into a note editor (⌘↩ or Ctrl+Enter saves).')
  await popBtn(page, 'Save').click()
  await waitFor(() => serverHl((h) => h.id === 'hl-2')?.note.includes('chapter 2'))
  check('Editing a note syncs to Karakeep', serverHl((h) => h.id === 'hl-2')?.note.includes('chapter 2'))
  await page.keyboard.press('Escape')

  // ── 5. Right-click → Highlight with Karakeep ────────────────────────
  const menuPhrase = 'Skim a thousand feeds and you get very good at skimming'
  const at = await selectPhrase(page, menuPhrase)
  await page.mouse.click(at.x, at.y, { button: 'right' })
  await sleep(900)
  try {
    const file = `${String(++shotN).padStart(2, '0')}-context-menu.png`
    execFileSync('import', ['-window', 'root', join(outDir, file)])
    shots.push({ file, caption: 'Real Chrome, right-click on a selection: "Highlight with Karakeep" sits at the top level of the native menu, one click away.' })
    check('Native context menu captured from the X display', true)
  } catch (err) {
    check('Native context menu captured from the X display', false, err.message)
  }
  // Playwright can't press keys inside a native menu, but a click elsewhere
  // in the window dismisses it the same way it would for a person.
  await page.mouse.click(5, 790)
  await sleep(300)

  // The menu entry's click handler sends exactly this message; Playwright
  // cannot click inside a native menu, so this step is driven the same way.
  await selectPhrase(page, menuPhrase)
  await openToolbar(savedTab)
  await pop(page).waitFor()
  check('"Highlight with Karakeep" opens the toolbar at the selection', (await popBtn(page, 'Explain').count()) === 1)
  await shot(page, 'toolbar-from-menu', 'After choosing "Highlight with Karakeep": the same toolbar as the Mac app: colours, Note, Copy, then Explain and Ask… for AI.')

  // ── 6. AI: Explain → Save as note ───────────────────────────────────
  await popBtn(page, 'Explain').click()
  await waitFor(async () => (await popBtn(page, 'Save as note').isEnabled()))
  const answer = await pop(page).locator('.kh-ans').textContent()
  const geminiCall = S().log.filter((l) => l.path === '/gemini').at(-1)
  const sentPrompt = JSON.stringify(geminiCall?.body ?? {})
  check('Explain streams an answer into the toolbar', answer.includes('tools we read with'), answer.slice(0, 60))
  check('The AI request carries the selection and its paragraph', sentPrompt.includes(menuPhrase) && sentPrompt.includes('medium trains the reader'))
  await shot(page, 'ai-explain', 'Explain streams a short answer into the toolbar (bold rendered safely, never as HTML). Copy it, or keep it as the highlight’s note.')

  await popBtn(page, 'Save as note').click()
  await waitFor(() => !!serverHl((h) => h.text === menuPhrase))
  const aiHl = serverHl((h) => h.text === menuPhrase)
  check('Save as note creates the highlight with the answer as its note', aiHl && aiHl.note.includes('tools we read with'), aiHl?.id)
  check('The saved note is plain text, without markdown', aiHl && !aiHl.note.includes('**'))
  await sleep(250)
  await shot(page, 'ai-saved-as-note', 'Save as note: the passage becomes a highlight in Karakeep with the answer as its plain-text note (the dot), and a toast confirms it.')
  await marksOf(page, aiHl.id).first().click()
  await pop(page).waitFor()
  await shot(page, 'ai-note-reopened', 'Clicking the new highlight shows the AI answer as its note.')
  await page.keyboard.press('Escape')

  // ── 7. Ask… a custom question ───────────────────────────────────────
  await selectPhrase(page, 'Marginalia are not decoration')
  await openToolbar(savedTab)
  await pop(page).waitFor()
  await popBtn(page, 'Ask…').click()
  await pop(page).locator('input.kh-input').fill('Is there evidence for this?')
  await shot(page, 'ai-ask', 'Ask… opens a question field under the toolbar; the answer streams in below it.')
  await page.keyboard.press('Escape')

  // ── 8. Note from the toolbar ────────────────────────────────────────
  await selectPhrase(page, 'Choose tools that make the slow path the easy one')
  await openToolbar(savedTab)
  await pop(page).waitFor()
  await popBtn(page, 'Note').click()
  await pop(page).locator('textarea.kh-ta').waitFor()
  await pop(page).locator('textarea.kh-ta').fill('Closing line, good epigraph.')
  await shot(page, 'toolbar-note', 'Note highlights the passage straight away and opens a note editor on it.')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
  await waitFor(() => serverHl((h) => h.text === 'Choose tools that make the slow path the easy one')?.note === 'Closing line, good epigraph.')
  check('Note from the toolbar creates the highlight, then saves the note', !!serverHl((h) => h.note === 'Closing line, good epigraph.'))
  await page.keyboard.press('Escape')
  const badge2 = await badgeFor(savedTab)
  check('Badge count follows new highlights', badge2 === '5', `badge "${badge2}"`)

  // ── 9. Popup on the saved page ──────────────────────────────────────
  let popup = await openPopup(savedTab)
  check('Popup shows the bookmark as saved', (await popup.locator('text=Saved').count()) > 0)
  check('Popup lists all highlights', (await popup.locator('section li').count()) === 5)
  await popupShot(popup, 'popup-saved', 'The popup on a saved page: favourite / archive / open in Karakeep / delete, tags, lists, the bookmark note, and every highlight.')

  await popup.click('button:has-text("+ Tag")')
  await popup.fill('input[placeholder="tag name"]', 'attention')
  await popup.keyboard.press('Enter')
  await waitFor(() => S().bookmarks[0].tags.some((t) => t.name === 'attention'))
  check('Adding a tag from the popup syncs', S().bookmarks[0].tags.some((t) => t.name === 'attention'))
  await popup.selectOption('select[aria-label="Add to list"]', 'l-ml')
  await waitFor(() => S().membership.get('bm-deep-reading').has('l-ml'))
  check('Adding to a list from the popup syncs', S().membership.get('bm-deep-reading').has('l-ml'))
  await popup.click('button[aria-label="Archive"]')
  await waitFor(() => S().bookmarks[0].archived === true)
  check('Archive from the popup syncs', S().bookmarks[0].archived === true)
  await popup.click('button[aria-label="Unarchive"]')
  await waitFor(() => S().bookmarks[0].archived === false)

  // Click a highlight in the popup → the page scrolls to it and flashes it.
  await page.evaluate(() => window.scrollTo(0, 0))
  await popup.locator('section li button', { hasText: 'An annotation is a conversation' }).click()
  const scrolled = await waitFor(() => page.evaluate(() => window.scrollY > 300))
  check('Clicking a highlight in the popup scrolls the page to it', scrolled)

  // Delete from the popup → the mark goes away on the page too.
  const toDelete = serverHl((h) => h.text === 'Choose tools that make the slow path the easy one').id
  await popup.locator('section li', { hasText: 'Choose tools that make' }).hover()
  await popup.locator('section li', { hasText: 'Choose tools that make' }).locator('button[aria-label="Delete highlight"]').click()
  await waitFor(async () => (await marksOf(page, toDelete).count()) === 0)
  check('Deleting a highlight in the popup removes it from Karakeep and the page', !serverHl((h) => h.id === toDelete) && (await marksOf(page, toDelete).count()) === 0)
  await popup.close()

  popup = await openPopup(savedTab, { dark: true })
  await popupShot(popup, 'popup-saved-dark', 'The popup follows the system’s dark mode, like the desktop app.')
  await popup.close()

  // ── 10. An unsaved page ─────────────────────────────────────────────
  const page2 = await context.newPage()
  await page2.goto(UNSAVED)
  await sleep(800)
  const tab2 = await tabIdFor(UNSAVED)
  check('An unsaved page gets no badge and no marks', (await badgeFor(tab2)) === '' && (await page2.locator('mark.karakeep-hl').count()) === 0)
  popup = await openPopup(tab2)
  await popupShot(popup, 'popup-unsaved', 'The popup on a page that isn’t saved yet: one button to save it, and a hint on how to highlight.')

  await popup.click('button:has-text("Save to Karakeep")')
  await popup.waitForSelector('text=Saved')
  const created = S().bookmarks.find((b) => b.content.url === UNSAVED)
  check('Save to Karakeep creates a link bookmark', created && created.source === 'extension', created?.id)
  await popupShot(popup, 'popup-just-saved', 'Saved. Tags, lists and a note can be added right away; highlights appear here as they are made.')
  await popup.click('button[aria-label="Delete bookmark"]')
  await popup.click('button:text-is("Delete")')
  await popup.waitForSelector('text=Save to Karakeep')
  check('Deleting the bookmark from the popup works', !S().bookmarks.some((b) => b.content.url === UNSAVED))
  await popup.close()

  // Highlighting an unsaved page saves it.
  await page2.bringToFront()
  await selectPhrase(page2, 'A good tool, in other words, is one you summon')
  await openToolbar(tab2)
  await pop(page2).waitFor()
  await swatch(page2, 'Green').click()
  await waitFor(() => S().bookmarks.some((b) => b.content.url === UNSAVED) && !!serverHl((h) => h.text.startsWith('A good tool')))
  const autoBm = S().bookmarks.find((b) => b.content.url === UNSAVED)
  const autoHl = serverHl((h) => h.text.startsWith('A good tool'))
  check('Highlighting an unsaved page saves the page, then the highlight', autoBm && autoHl?.bookmarkId === autoBm.id && autoHl.color === 'green')
  await page2.locator('#karakeep-hl-overlay .kh-toast').waitFor()
  await shot(page2, 'auto-save-toast', 'Highlighting a page that isn’t saved yet saves it to Karakeep first. A toast confirms it, and the highlight syncs.')
  const serverIdOnPage = await page2.evaluate(() => document.querySelector('mark.karakeep-hl')?.dataset.khId)
  check('The page adopts the server id for the new highlight', serverIdOnPage === autoHl?.id, serverIdOnPage)

  // ── 11. Persistence: reload re-anchors from the server ──────────────
  await page2.reload()
  const reanchored = await waitFor(async () => (await marksOf(page2, autoHl.id).count()) > 0)
  check('After a reload the new highlight is drawn again from Karakeep', reanchored)

  // ── 12. Highlights off: page loads ask the server nothing ──────────
  await options.bringToFront()
  await options.reload()
  await options.uncheck('input[type="checkbox"]')
  await waitFor(async () => (await sw.evaluate(() => chrome.storage.local.get('showHighlights'))).showHighlights === false)
  const before = S().log.length
  await page.bringToFront()
  await page.reload()
  await sleep(1500)
  const lookups = S().log.slice(before).filter((l) => l.path.includes('check-url')).length
  check('With highlights turned off, opening a page sends no lookup to Karakeep', lookups === 0 && (await page.locator('mark.karakeep-hl').count()) === 0, `${lookups} lookups`)

  await page.close()
  await page2.close()
} catch (err) {
  check('run completed without an exception', false, err?.stack || String(err))
  for (const [i, p] of context.pages().entries()) {
    await p.screenshot({ path: join(outDir, `failure-${i}.png`) }).catch(() => undefined)
  }
}

writeFileSync(join(outDir, 'results.json'), JSON.stringify({ results, shots, log: S().log }, null, 2))
await context.close()
server.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
