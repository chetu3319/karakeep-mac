/**
 * Content script for Karakeep extension.
 * Provides text highlighting and note-taking on web pages.
 */

import {
  HIGHLIGHT_CLASS, TOOLBAR_ID, NOTE_DIALOG_ID,
  OVERLAY_ID, STYLE_ID, getStylesheet,
} from './content-styles.js';

(function karakeepInit() {
  if (window.__karakeepHL) return;
  window.__karakeepHL = true;

  let pageHighlights = [];

  // ── inject stylesheet ─────────────────────────────────────
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = getStylesheet();
    document.head.appendChild(el);
  }

  // ── helpers ───────────────────────────────────────────────
  function uid() {
    return 'kh-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  }

  // ── text-node walker within a Range ───────────────────────
  function textNodesIn(range) {
    const start = range.startContainer;
    const end = range.endContainer;
    if (start === end && start.nodeType === Node.TEXT_NODE) return [start];

    const result = [];
    const walker = document.createTreeWalker(
      range.commonAncestorContainer,
      NodeFilter.SHOW_TEXT,
    );
    let n;
    while ((n = walker.nextNode())) {
      if (range.intersectsNode(n)) result.push(n);
    }
    return result;
  }

  // ── wrap selected text in <mark> elements ─────────────────
  function wrapRange(range, id, color) {
    const nodes = textNodesIn(range);
    const marks = [];

    for (const node of nodes) {
      const nr = document.createRange();
      nr.selectNodeContents(node);
      if (node === range.startContainer) nr.setStart(node, range.startOffset);
      if (node === range.endContainer) nr.setEnd(node, range.endOffset);
      if (nr.collapsed || !nr.toString().trim()) continue;

      try {
        const mark = document.createElement('mark');
        mark.className = HIGHLIGHT_CLASS;
        mark.dataset.khId = id;
        mark.dataset.khColor = color;
        nr.surroundContents(mark);
        marks.push(mark);
      } catch (e) {
        // surroundContents can throw if the range partially selects a non-Text node
      }
    }
    return marks;
  }

  // ── character offset of a range within document.body's text ───
  // Mirrors the TreeWalker offset scheme Karakeep's own web reader uses
  // (BookmarkHtmlHighlighter), so highlights sync to the server with
  // real positional data instead of being uploaded as bare text.
  function textOffsetOf(node, nodeOffset) {
    var tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var total = 0;
    var n;
    while ((n = tw.nextNode())) {
      if (n === node) return total + nodeOffset;
      total += n.textContent.length;
    }
    return -1;
  }

  // ── extract surrounding context for a range ────────────────
  var CONTEXT_LEN = 50;

  function extractContext(range) {
    var prefix = '';
    var suffix = '';
    try {
      // Get text before the range
      var preRange = document.createRange();
      preRange.setStart(document.body, 0);
      preRange.setEnd(range.startContainer, range.startOffset);
      var preText = preRange.toString();
      prefix = preText.slice(-CONTEXT_LEN);

      // Get text after the range
      var postRange = document.createRange();
      postRange.setStart(range.endContainer, range.endOffset);
      postRange.setEnd(document.body, document.body.childNodes.length);
      var postText = postRange.toString();
      suffix = postText.slice(0, CONTEXT_LEN);
    } catch (e) {
      // Context extraction is best-effort
    }
    return { prefix: prefix, suffix: suffix };
  }

  // ── create a highlight from current selection ─────────────
  function createHighlight(sel, color, withNote) {
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (!text) return;

    const range = sel.getRangeAt(0);
    const id = uid();
    const context = extractContext(range);
    const startOffset = textOffsetOf(range.startContainer, range.startOffset);
    const endOffset = textOffsetOf(range.endContainer, range.endOffset);
    const marks = wrapRange(range, id, color);
    if (!marks.length) return;

    sel.removeAllRanges();

    const hl = {
      id,
      text,
      color,
      note: '',
      url: location.href,
      title: document.title,
      prefix: context.prefix,
      suffix: context.suffix,
      startOffset,
      endOffset,
      createdAt: new Date().toISOString(),
    };
    pageHighlights.push(hl);

    marks.forEach(function (m) {
      m.addEventListener('click', function () { openNote(hl); });
    });

    chrome.runtime.sendMessage({ type: 'HIGHLIGHT_CREATED', highlight: hl }, function (resp) {
      // Store the server-side highlight ID if the sync to Karakeep succeeded
      if (resp?.highlight?.highlightId) {
        hl.highlightId = resp.highlight.highlightId;
        hl.bookmarkId = resp.highlight.bookmarkId;
      }
    });

    if (withNote) openNote(hl);
  }

  // ── remove a highlight by id ──────────────────────────────
  function destroyHighlight(id) {
    document.querySelectorAll('[data-kh-id="' + id + '"]').forEach(function (m) {
      const p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      p.normalize();
    });
    pageHighlights = pageHighlights.filter(function (h) { return h.id !== id; });
    chrome.runtime.sendMessage({
      type: 'HIGHLIGHT_REMOVED',
      highlightId: id,
      url: location.href,
    });
  }

  // ── toolbar (appears on text selection) ───────────────────
  function showToolbar(sel) {
    hideToolbar();
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const bar = document.createElement('div');
    bar.id = TOOLBAR_ID;

    function addBtn(label, fn) {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();
      });
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        fn();
        hideToolbar();
      });
      bar.appendChild(b);
    }

    addBtn('\u2728 Highlight', function () { createHighlight(sel, 'green', false); });
    addBtn('\uD83D\uDCDD Note', function () { createHighlight(sel, 'green', true); });

    var sep = document.createElement('div');
    sep.className = 'kh-sep';
    bar.appendChild(sep);

    var palette = [
      ['green',  '#10b981'],
      ['yellow', '#facc15'],
      ['red',    '#ef4444'],
      ['blue',   '#3b82f6'],
      ['purple', '#a855f7'],
    ];
    palette.forEach(function (pair) {
      var dot = document.createElement('button');
      dot.className = 'kh-dot';
      dot.style.backgroundColor = pair[1];
      dot.title = pair[0];
      dot.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
      dot.addEventListener('click', function (e) {
        e.stopPropagation();
        createHighlight(sel, pair[0], false);
        hideToolbar();
      });
      bar.appendChild(dot);
    });

    bar.style.top = (rect.top + window.scrollY - 44) + 'px';
    bar.style.left = (rect.left + window.scrollX + rect.width / 2) + 'px';
    bar.style.transform = 'translateX(-50%)';
    document.body.appendChild(bar);
  }

  function hideToolbar() {
    var el = document.getElementById(TOOLBAR_ID);
    if (el) el.remove();
  }

  // ── note dialog ───────────────────────────────────────────
  function openNote(hl) {
    closeNote();

    var ov = document.createElement('div');
    ov.id = OVERLAY_ID;
    ov.addEventListener('click', closeNote);
    document.body.appendChild(ov);

    var dlg = document.createElement('div');
    dlg.id = NOTE_DIALOG_ID;

    var hdr = document.createElement('div');
    hdr.className = 'kh-hdr';
    var hdrTitle = document.createElement('span');
    hdrTitle.textContent = hl.note ? 'Edit Note' : 'Add Note';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'kh-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', closeNote);
    hdr.appendChild(hdrTitle);
    hdr.appendChild(closeBtn);
    dlg.appendChild(hdr);

    var body = document.createElement('div');
    body.className = 'kh-body';

    var quote = document.createElement('div');
    quote.className = 'kh-quote';
    quote.textContent = hl.text;
    body.appendChild(quote);

    var ta = document.createElement('textarea');
    ta.className = 'kh-ta';
    ta.placeholder = 'Add your note here\u2026';
    ta.value = hl.note || '';
    body.appendChild(ta);
    dlg.appendChild(body);

    var ftr = document.createElement('div');
    ftr.className = 'kh-ftr';

    var delBtn = document.createElement('button');
    delBtn.className = 'kh-del';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', function () {
      destroyHighlight(hl.id);
      closeNote();
    });
    ftr.appendChild(delBtn);

    var spacer = document.createElement('div');
    spacer.style.flex = '1';
    ftr.appendChild(spacer);

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'kh-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closeNote);
    ftr.appendChild(cancelBtn);

    var saveBtn = document.createElement('button');
    saveBtn.className = 'kh-save-btn';
    saveBtn.textContent = 'Save Note';
    saveBtn.addEventListener('click', function () {
      hl.note = ta.value.trim();
      document.querySelectorAll('[data-kh-id="' + hl.id + '"]').forEach(function (m) {
        m.dataset.khNote = hl.note ? '1' : '';
      });
      chrome.runtime.sendMessage({ type: 'HIGHLIGHT_UPDATED', highlight: hl });
      closeNote();
    });
    ftr.appendChild(saveBtn);
    dlg.appendChild(ftr);

    document.body.appendChild(dlg);
    ta.focus();

    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveBtn.click();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeNote();
      }
    });
  }

  function closeNote() {
    var d = document.getElementById(NOTE_DIALOG_ID);
    var o = document.getElementById(OVERLAY_ID);
    if (d) d.remove();
    if (o) o.remove();
  }

  // ── re-apply saved highlights on the page ─────────────────
  function applyStored(list) {
    console.log('[karakeep-debug] applyStored called with', list && list.length, 'highlights', list);
    if (!list || !list.length) return;
    list.forEach(function (h) {
      if (pageHighlights.some(function (e) { return e.id === h.id; })) {
        console.log('[karakeep-debug] skipping, already applied', h.id);
        return;
      }
      var found = locateText(h.text, h.prefix, h.suffix);
      console.log('[karakeep-debug] locateText result', {
        id: h.id,
        text: h.text,
        prefix: h.prefix,
        suffix: h.suffix,
        found: !!found,
        foundText: found ? found.toString() : null,
      });
      if (!found) return;
      var marks = wrapRange(found, h.id, h.color || 'green');
      console.log('[karakeep-debug] wrapRange produced', marks.length, 'marks for', h.id);
      if (!marks.length) return;
      marks.forEach(function (m) {
        if (h.note) m.dataset.khNote = '1';
        m.addEventListener('click', function () { openNote(h); });
      });
      pageHighlights.push(h);
    });
  }

  // ── fuzzy text matching helpers ─────────────────────────────
  // Highlights synced down from the server were selected against Karakeep's
  // Readability-extracted article text, not the live DOM — so a byte-exact
  // indexOf() often misses on smart quotes, non-breaking spaces, unicode
  // dashes, or differing whitespace runs between words. Normalize those away
  // (length-preserving, so offsets still map 1:1 into `full`) and fall back
  // to a whitespace-tolerant regex if an exact match still isn't found.
  function normalizeForMatch(str) {
    return str
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„‟]/g, '"')
      .replace(/[–—−]/g, '-')
      .replace(/[ \t\n\r\f\v]/g, ' ');
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function buildFuzzyPattern(needle) {
    var parts = needle.split(/\s+/).filter(Boolean).map(escapeRegExp);
    if (!parts.length) return null;
    try {
      return new RegExp(parts.join('\\s+'), 'g');
    } catch (e) {
      return null;
    }
  }

  function findOccurrences(full, needle) {
    var occurrences = [];
    var searchFrom = 0;
    while (true) {
      var idx = full.indexOf(needle, searchFrom);
      if (idx < 0) break;
      occurrences.push({ start: idx, end: idx + needle.length });
      searchFrom = idx + 1;
    }
    if (occurrences.length) return occurrences;

    // Exact match failed — retry tolerating differing whitespace runs.
    var pattern = buildFuzzyPattern(needle);
    if (!pattern) return occurrences;
    var m;
    while ((m = pattern.exec(full))) {
      occurrences.push({ start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) pattern.lastIndex++;
    }
    return occurrences;
  }

  function locateText(needle, prefix, suffix) {
    if (!needle) return null;
    var tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var nodes = [];
    var n;
    while ((n = tw.nextNode())) nodes.push(n);

    var full = '';
    var map = [];
    nodes.forEach(function (tn) {
      var s = full.length;
      full += tn.textContent;
      map.push({ node: tn, start: s, end: full.length });
    });

    var normFull = normalizeForMatch(full);
    var normNeedle = normalizeForMatch(needle);
    var occurrences = findOccurrences(normFull, normNeedle);
    console.log('[karakeep-debug] locateText search', {
      needle: needle,
      needleLength: needle.length,
      pageTextLength: full.length,
      occurrenceCount: occurrences.length,
      exactMatch: normFull.indexOf(normNeedle) !== -1,
    });
    if (occurrences.length === 0) return null;

    // Pick the best occurrence using context (prefix/suffix)
    var best = occurrences[0];
    if (occurrences.length > 1 && (prefix || suffix)) {
      var bestScore = -1;
      for (var oi = 0; oi < occurrences.length; oi++) {
        var occ = occurrences[oi];
        var score = 0;
        if (prefix) {
          var actualPrefix = full.slice(Math.max(0, occ.start - prefix.length), occ.start);
          // Count matching characters from the end of the prefix
          var pLen = Math.min(actualPrefix.length, prefix.length);
          for (var pi = 0; pi < pLen; pi++) {
            if (actualPrefix[actualPrefix.length - 1 - pi] === prefix[prefix.length - 1 - pi]) score++;
            else break;
          }
        }
        if (suffix) {
          var actualSuffix = full.slice(occ.end, occ.end + suffix.length);
          var sLen = Math.min(actualSuffix.length, suffix.length);
          for (var si = 0; si < sLen; si++) {
            if (actualSuffix[si] === suffix[si]) score++;
            else break;
          }
        }
        if (score > bestScore) {
          bestScore = score;
          best = occ;
        }
      }
    }

    var sNode, sOff, eNode, eOff;
    for (var i = 0; i < map.length; i++) {
      if (!sNode && map[i].end > best.start) { sNode = map[i].node; sOff = best.start - map[i].start; }
      if (map[i].end >= best.end) { eNode = map[i].node; eOff = best.end - map[i].start; break; }
    }
    if (!sNode || !eNode) return null;
    var r = document.createRange();
    r.setStart(sNode, sOff);
    r.setEnd(eNode, eOff);
    return r;
  }

  // ── selection listener (show toolbar) ─────────────────────
  var timer = null;

  document.addEventListener('mouseup', function () {
    clearTimeout(timer);
    timer = setTimeout(function () {
      var s = window.getSelection();
      if (s && !s.isCollapsed && s.toString().trim()) {
        var anchor = s.anchorNode;
        if (anchor && anchor.nodeType !== Node.ELEMENT_NODE) anchor = anchor.parentElement;
        if (anchor && anchor.closest('#' + TOOLBAR_ID + ', #' + NOTE_DIALOG_ID)) return;
        showToolbar(s);
      } else {
        hideToolbar();
      }
    }, 200);
  });

  document.addEventListener('mousedown', function (e) {
    var tb = document.getElementById(TOOLBAR_ID);
    if (tb && !tb.contains(e.target)) hideToolbar();
  });

  // ── message listener (from background) ────────────────────
  chrome.runtime.onMessage.addListener(function (msg, _sender, reply) {
    if (msg.type === 'APPLY_HIGHLIGHTS') {
      applyStored(msg.highlights);
      reply({ ok: true });
    } else if (msg.type === 'GET_SELECTION') {
      var s = window.getSelection();
      reply({ text: s ? s.toString().trim() : '', url: location.href, title: document.title });
    } else if (msg.type === 'TRIGGER_HIGHLIGHT') {
      var sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) {
        createHighlight(sel, msg.color || 'green', !!msg.openNote);
        reply({ ok: true });
      } else {
        reply({ ok: false, error: 'No text selected' });
      }
    } else if (msg.type === 'GET_HIGHLIGHTS') {
      reply({ highlights: pageHighlights });
    }
    return true;
  });

  // ── boot ──────────────────────────────────────────────────
  ensureStyles();
  console.log('[karakeep-debug] content script booted for', location.href);

  chrome.runtime.sendMessage(
    { type: 'GET_PAGE_HIGHLIGHTS', url: location.href },
    function (resp) {
      console.log('[karakeep-debug] GET_PAGE_HIGHLIGHTS response', resp);
      if (resp && resp.highlights) applyStored(resp.highlights);
    },
  );
})();
