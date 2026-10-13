/**
 * Forgiving quote matching.
 *
 * A quote that the model (or a selection) hands back rarely matches the page
 * text byte for byte: PDF layout breaks lines mid-word with a hyphen, fonts
 * emit ﬁ/ﬂ ligatures as one code point, typesetting turns " into “ ”, and the
 * line breaks themselves are layout, not content. So both sides are reduced to
 * a flat comparison form first, and the hit is mapped back to offsets in the
 * *original* text so callers can slice or highlight the real thing.
 */

const LIGATURES: Record<string, string> = {
  'ﬀ': 'ff',
  'ﬁ': 'fi',
  'ﬂ': 'fl',
  'ﬃ': 'ffi',
  'ﬄ': 'ffl',
  'ﬅ': 'st',
  'ﬆ': 'st'
}

const QUOTES: Record<string, string> = {
  '“': '"',
  '”': '"',
  '„': '"',
  '‟': '"',
  '‘': "'",
  '’': "'",
  '‚': "'",
  '‛': "'"
}

const isSpace = (ch: string) => /\s/.test(ch)

/**
 * Lower-cased, whitespace-collapsed form of `s`. `map[i]` is the index in `s`
 * that produced `flat[i]`. Leading whitespace is dropped; a trailing run is
 * kept as one space (callers that need it gone trim the flat string).
 */
export function normalizeForMatch(s: string): { flat: string; map: number[] } {
  let flat = ''
  const map: number[] = []
  const emit = (text: string, at: number) => {
    for (const c of text) {
      flat += c
      map.push(at)
    }
  }

  let i = 0
  while (i < s.length) {
    const ch = s[i]

    if (isSpace(ch)) {
      let j = i
      while (j < s.length && isSpace(s[j])) j++
      if (flat.length > 0 && !flat.endsWith(' ')) emit(' ', i)
      i = j
      continue
    }

    // "atten-\ntion": a hyphen that ends a line is layout, not a word break.
    if (ch === '-' && flat.length > 0 && /[\p{L}\p{N}]$/u.test(flat)) {
      let j = i + 1
      let newline = false
      while (j < s.length && isSpace(s[j])) {
        if (s[j] === '\n' || s[j] === '\r') newline = true
        j++
      }
      if (newline && j < s.length) {
        i = j
        continue
      }
    }

    emit(LIGATURES[ch] ?? QUOTES[ch] ?? ch.toLowerCase(), i)
    i++
  }

  return { flat, map }
}

/**
 * Find `quote` in `haystack`, tolerant of the differences above. Returns
 * offsets into the original haystack (end exclusive), or null.
 */
export function findQuote(haystack: string, quote: string): { start: number; end: number } | null {
  const needle = normalizeForMatch(quote).flat.trim()
  if (!needle) return null

  const { flat, map } = normalizeForMatch(haystack)
  const hit = flat.indexOf(needle)
  if (hit < 0) return null

  return { start: map[hit], end: map[hit + needle.length - 1] + 1 }
}
