/**
 * One runnable check for the pieces that can silently break search: mapping an
 * Anthropic response to portable sources, and taking the credential path the
 * shipped provider refuses to take off the account route.
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'
import {
  AccountSearchProvider,
  citationSnippets,
  parseSearchResponse,
} from '../src/index.ts'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

/** A response shaped like the account endpoint's answer to a native search. */
function responseWith(sources: readonly { url: string; title?: string; age?: string }[]) {
  const citations = sources
    .filter((source) => source.title !== undefined)
    .map((source) => ({ url: source.url, cited_text: `excerpt for ${source.url}` }))
  return {
    content: [
      { type: 'thinking', thinking: 'searching' },
      { type: 'server_tool_use', name: 'web_search' },
      {
        type: 'web_search_tool_result',
        content: sources.map((source) => ({
          type: 'web_search_result',
          url: source.url,
          ...(source.title === undefined ? {} : { title: source.title }),
          ...(source.age === undefined ? {} : { page_age: source.age }),
        })),
      },
      { type: 'text', text: 'here is what I found', citations },
    ],
  }
}

test('maps result blocks to portable sources, joining citation excerpts', () => {
  const result = parseSearchResponse(
    responseWith([
      { url: 'https://a.example/one', title: 'One', age: '2026-01-02' },
      { url: 'https://b.example/two' },
    ]),
  )

  assert.equal(result.truncated, false)
  assert.deepEqual(result.sources, [
    {
      url: 'https://a.example/one',
      title: 'One',
      snippet: 'excerpt for https://a.example/one',
      publishedAt: '2026-01-02',
    },
    { url: 'https://b.example/two' },
  ])
})

test('dedupes a URL that two result blocks both report', () => {
  const one = responseWith([{ url: 'https://a.example/one', title: 'One' }])
  const block = one.content[2]
  const result = parseSearchResponse({ content: [...one.content, block] })

  assert.equal(result.sources.length, 1)
})

test('refuses a response that carries no result block', () => {
  // The failure that made the shipped provider unusable on a gateway: 200 OK,
  // no server-side search, so the model would otherwise answer from memory.
  assert.throws(
    () => parseSearchResponse({ content: [{ type: 'thinking' }, { type: 'text', text: 'no' }] }),
    /web_search_tool_result/,
  )
})

test('citationSnippets keeps the first excerpt when a page is cited twice', () => {
  const snippets = citationSnippets([
    { type: 'text', citations: [{ url: 'https://a.example', cited_text: 'first' }] },
    { type: 'text', citations: [{ url: 'https://a.example', cited_text: 'second' }] },
  ])

  assert.equal(snippets.get('https://a.example'), 'first')
})

test('search sends the account credential the account route expects', async () => {
  const seen: { url: string; headers: Record<string, string>; body: string }[] = []
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const request = init as { headers: Record<string, string>; body: string }
    seen.push({ url: String(url), headers: request.headers, body: request.body })
    return new Response(
      JSON.stringify(responseWith([{ url: 'https://a.example/one', title: 'One' }])),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch

  const provider = new AccountSearchProvider(
    'deepseek-account',
    () => ({
      baseURL: 'https://api.deepseek.com/anthropic/v1',
      model: 'deepseek-v4-flash',
      apiVersion: '2023-06-01',
      maxTokens: 4096,
      maxUses: 5,
    }),
    () => ({ resolveToken: async () => 'account-token' }),
  )

  const result = await provider.search({ query: 'dsh harness' })

  assert.equal(result.sources[0]?.url, 'https://a.example/one')
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.url, 'https://api.deepseek.com/anthropic/v1/messages')
  // The header, not an API key: this is the whole point of the plugin.
  assert.equal(seen[0]?.headers['x-dsh-auth-token'], 'account-token')
  assert.equal(seen[0]?.headers['x-api-key'], undefined)
  assert.match(seen[0]?.body ?? '', /web_search_20250305/)
})

test('search reports missing sign-in instead of falling back to an API key', async () => {
  const provider = new AccountSearchProvider(
    'deepseek-account',
    () => ({
      baseURL: 'https://api.deepseek.com/anthropic/v1',
      model: 'deepseek-v4-flash',
      apiVersion: '2023-06-01',
      maxTokens: 4096,
      maxUses: 5,
    }),
    () => ({ resolveToken: async () => undefined }),
  )

  await assert.rejects(provider.search({ query: 'x' }), (error: unknown) => {
    assert.match(String(error), /Sign in to DeepSeek again/)
    return true
  })
})
