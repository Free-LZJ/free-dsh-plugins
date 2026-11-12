/**
 * The mention route enumerates the user's open tabs, so the origin guard is the
 * only thing standing between a page on another site and that list. These are
 * the four cases `dsh-host-webserver` leaves to the route itself.
 */

import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { isSameOrigin } from '../src/routes.ts'

/**
 * Build the header view one request needs.
 * @param headers - the headers under test.
 * @returns the request-shaped value.
 */
function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe('isSameOrigin', () => {
  it('accepts a request with no Origin at all', () => {
    expect(isSameOrigin(request({}))).toBe(true)
  })

  it('accepts the page this server sent', () => {
    expect(isSameOrigin(request({ origin: 'http://127.0.0.1:2350', host: '127.0.0.1:2350' }))).toBe(true)
  })

  it('refuses another site reaching through the user browser', () => {
    expect(isSameOrigin(request({
      'sec-fetch-site': 'cross-site',
      origin: 'https://evil.example',
      host: '127.0.0.1:2350',
    }))).toBe(false)
  })

  it('refuses a mismatched Origin even without a fetch hint', () => {
    expect(isSameOrigin(request({ origin: 'https://evil.example', host: '127.0.0.1:2350' }))).toBe(false)
  })

  it('refuses an unparseable Origin', () => {
    expect(isSameOrigin(request({ origin: 'not a url', host: '127.0.0.1:2350' }))).toBe(false)
  })
})
