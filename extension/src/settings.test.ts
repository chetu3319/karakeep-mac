import { describe, expect, it } from 'vitest'
import { bookmarkWebUrl, formatHeaderLines, normalizeBaseUrl, parseHeaderLines } from './settings'

describe('normalizeBaseUrl', () => {
  it('keeps an explicit scheme and drops trailing slashes', () => {
    expect(normalizeBaseUrl('  https://keep.example.com/// ')).toBe('https://keep.example.com')
    expect(normalizeBaseUrl('http://keep.example.com')).toBe('http://keep.example.com')
  })

  it('assumes https for a public host', () => {
    expect(normalizeBaseUrl('keep.example.com')).toBe('https://keep.example.com')
  })

  it('assumes http for localhost, LAN addresses and .local names', () => {
    expect(normalizeBaseUrl('localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeBaseUrl('127.0.0.1:3999')).toBe('http://127.0.0.1:3999')
    expect(normalizeBaseUrl('192.168.1.10:3000/')).toBe('http://192.168.1.10:3000')
    expect(normalizeBaseUrl('nas.local')).toBe('http://nas.local')
  })

  it('leaves an empty value empty', () => {
    expect(normalizeBaseUrl('   ')).toBe('')
  })
})

describe('header lines', () => {
  it('round-trips and skips lines without a colon', () => {
    const parsed = parseHeaderLines('CF-Access-Client-Id: abc\njunk\nX-Token:  t:1 ')
    expect(parsed).toEqual({ 'CF-Access-Client-Id': 'abc', 'X-Token': 't:1' })
    expect(formatHeaderLines(parsed)).toBe('CF-Access-Client-Id: abc\nX-Token: t:1')
  })
})

describe('bookmarkWebUrl', () => {
  it('points at the web app preview page', () => {
    expect(bookmarkWebUrl('https://k.example', 'abc')).toBe('https://k.example/dashboard/preview/abc')
  })
})
