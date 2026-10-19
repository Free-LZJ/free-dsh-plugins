/**
 * Search the web with the DeepSeek account the user already signed in to.
 *
 * dsh ships a DeepSeek search provider, but it can only borrow the account
 * credential when the *conversation itself* runs on the `deepseek-account`
 * route: it reads the session's request context and gives up otherwise. That
 * leaves a search key mandatory for anyone whose chat is pinned to another
 * route — a gateway provider, a third-party model — even though the machine
 * holds a perfectly usable account token.
 *
 * This provider makes the account credential the *only* thing it needs, so the
 * session's model route stops being a dependency of search. It sends the same
 * Anthropic-compatible Messages request the shipped provider sends, with the
 * native `web_search_20250305` server tool and the account token in the header
 * that route expects, and maps the result blocks back to portable sources.
 *
 * The account service decides whether a destination is allowed: `resolveToken`
 * returns no token for an origin it will not authenticate, and that refusal is
 * surfaced as sign-in guidance rather than retried against another endpoint.
 *
 * Nothing here touches the conversation: no model provider is registered or
 * configured, so installing this plugin changes how searches are answered and
 * nothing about which model replies.
 *
 * @module @deepseek-ai/dsh-web-search-account
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'

/** Plugin name registered under the Cordis loader. */
export const name = 'web-search-account'

/** The web seam this provider registers into. */
export const inject = ['web'] as const

/** Default Messages endpoint, including `/v1`; `/messages` is appended. */
const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1'

/** Default Anthropic-format model name. */
const DEFAULT_MODEL = 'deepseek-v4-flash'

/** Default `anthropic-version` header value. */
const DEFAULT_API_VERSION = '2023-06-01'

/** Default upper bound on generated tokens for the Messages request. */
const DEFAULT_MAX_TOKENS = 4096

/** Default maximum `web_search` server-tool uses per request. */
const DEFAULT_MAX_USES = 5

/** Provider id this plugin registers under, and the value `web.searchProvider` must name. */
const DEFAULT_PROVIDER_ID = 'deepseek-account'

/** Attribution header sent on every request. */
const USER_AGENT = 'deepseek-harness/web-search-account'

/**
 * The slice of the account service this provider uses.
 *
 * Declared structurally rather than imported from
 * `@deepseek-ai/dsh-deepseek-account` so the plugin carries no runtime or type
 * dependency on a package the harness may re-version: only this one method
 * matters here, and a missing or differently-shaped service reads as "no
 * account", never as a load failure.
 */
interface AccountLike {
  resolveToken(url: string): Promise<string | undefined>
}

/** One resolved configuration section, snapshotted per search. */
export interface ProviderOptions {
  readonly baseURL: string
  readonly model: string
  readonly apiVersion: string
  readonly maxTokens: number
  readonly maxUses: number
}

/**
 * Plugin configuration.
 *
 * Every field is volatile so an operator — or a settings card — can retarget
 * the endpoint or model without restarting, which matters because the account
 * route accepts a narrower set of destinations than a plain API key does.
 */
export interface Config {
  /** Registry key this provider answers; `web.searchProvider` must name it. */
  providerId: Volatile<string>
  /** Anthropic-compatible Messages base, without `/messages`. */
  baseURL: Volatile<string>
  /** Model that runs the search turn. */
  model: Volatile<string>
  /** `anthropic-version` header value. */
  apiVersion: Volatile<string>
  /** Upper bound on generated tokens for one search turn. */
  maxTokens: Volatile<number>
  /** Maximum `web_search` server-tool uses per request. */
  maxUses: Volatile<number>
}

/** The raw configuration a profile supplies; every field is optional. */
export interface ConfigInput {
  providerId?: string
  baseURL?: string
  model?: string
  apiVersion?: string
  maxTokens?: number
  maxUses?: number
}

export const Config = z.object({
  providerId: z.string().default(DEFAULT_PROVIDER_ID).volatile(),
  baseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
  model: z.string().default(DEFAULT_MODEL).volatile(),
  apiVersion: z.string().default(DEFAULT_API_VERSION).volatile(),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS).volatile(),
  maxUses: z.number().step(1).min(1).default(DEFAULT_MAX_USES).volatile(),
}) as z<ConfigInput, Config>

/**
 * Build the `url → cited_text` map from every `text` block's `citations[]`.
 *
 * This is where the snippet comes from: an Anthropic `web_search_result` item
 * carries `url`/`title`/`page_age` but typically no inline excerpt — the
 * excerpt lives in a separate `text` block's citation, keyed by `url`. First
 * occurrence wins so a page cited twice keeps the snippet it was first read in.
 */
export function citationSnippets(blocks: readonly unknown[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const raw of blocks) {
    if (!isRecord(raw) || raw['type'] !== 'text') continue
    const citations = raw['citations']
    if (!Array.isArray(citations)) continue
    for (const citation of citations) {
      if (!isRecord(citation)) continue
      const url = citation['url']
      const text = citation['cited_text']
      if (typeof url !== 'string' || url.length === 0) continue
      if (typeof text !== 'string' || text.length === 0) continue
      if (!map.has(url)) map.set(url, text)
    }
  }
  return map
}

/**
 * Map a parsed Messages response to the seam's portable result.
 *
 * Walks `web_search_tool_result` blocks for citeable `web_search_result` items,
 * joins each to its citation excerpt, and dedupes by URL — one request with
 * `max_uses > 1` can surface the same page twice. `truncated` is always false:
 * the seam owns `maxResults` truncation, so claiming it here would be a second
 * opinion about a bound this layer cannot see.
 *
 * @throws {@link WebError} when the response carries no result block at all,
 * which means the upstream served the model turn without running a search.
 */
export function parseSearchResponse(body: unknown): WebSearchResult {
  const blocks = isRecord(body) && Array.isArray(body['content']) ? body['content'] : []
  const resultBlocks = blocks.filter(
    (block) => isRecord(block) && block['type'] === 'web_search_tool_result',
  )
  if (resultBlocks.length === 0) {
    throw new WebError(
      'the account endpoint answered without a web_search_tool_result block, so it did not run a server-side search; this endpoint does not support the native web_search tool',
      'WEB_PROVIDER_ERROR',
    )
  }
  const snippets = citationSnippets(blocks)
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const block of resultBlocks) {
    const content = isRecord(block) ? block['content'] : undefined
    if (!Array.isArray(content)) continue
    for (const item of content) {
      if (!isRecord(item) || item['type'] !== 'web_search_result') continue
      const url = item['url']
      if (typeof url !== 'string' || url.length === 0 || seen.has(url)) continue
      seen.add(url)
      const title = item['title']
      const snippet = snippets.get(url)
      const pageAge = item['page_age']
      sources.push({
        url,
        ...(typeof title === 'string' && title.length > 0 ? { title } : {}),
        ...(snippet !== undefined && snippet.length > 0 ? { snippet } : {}),
        ...(typeof pageAge === 'string' && pageAge.length > 0 ? { publishedAt: pageAge } : {}),
      })
    }
  }
  return { sources, truncated: false }
}

/** Narrow an unknown to a string-keyed record without asserting its fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The account-backed search provider.
 *
 * `available()` is a local check by contract — it never touches the network —
 * so it reports whether an account service is present, not whether the stored
 * token will be accepted. A rejected or absent token surfaces from `search()`.
 */
export class AccountSearchProvider implements WebSearchProvider {
  readonly id: string
  private readonly resolveOptions: () => ProviderOptions
  private readonly account: () => AccountLike | undefined

  /**
   * @param id - the registry key this provider answers, also the id `web.searchProvider` names.
   * @param resolveOptions - options snapshotted once at each search's entry, so one search never mixes two configuration sections.
   * @param account - the account service, read fresh so a service mounted after this plugin is still picked up.
   */
  constructor(
    id: string,
    resolveOptions: () => ProviderOptions,
    account: () => AccountLike | undefined,
  ) {
    this.id = id
    this.resolveOptions = resolveOptions
    this.account = account
  }

  available(): boolean {
    return this.account() !== undefined
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const endpoint = `${options.baseURL}/messages`
    const token = await this.token(options, signal)
    throwIfAborted(signal)
    const body = {
      model: options.model,
      max_tokens: options.maxTokens,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: `Perform a web search for the query: ${request.query}` }],
        },
      ],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: options.maxUses }],
    }
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'x-dsh-auth-token': token,
          'anthropic-version': options.apiVersion,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw endpointError(endpoint, `search request failed: ${String(error)}`, error)
    }
    if (!response.ok) {
      const status = response.status
      let message = `account search error (HTTP ${status})`
      try {
        const parsed: unknown = await response.json()
        const detail = errorDetail(parsed)
        if (detail !== undefined) message += `: ${detail}`
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      }
      if (status === 401) throw unauthorized(message)
      throw endpointError(endpoint, message)
    }
    try {
      const parsed: unknown = await response.json()
      return parseSearchResponse(parsed)
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      if (error instanceof WebError) throw error
      throw endpointError(endpoint, `unprocessable response body: ${String(error)}`, error)
    }
  }

  /**
   * Resolve the account token for this endpoint.
   *
   * No token means the account service refused this destination or nobody is
   * signed in; both are answered with sign-in guidance, because retrying
   * elsewhere would send a credential to an endpoint it was not issued for.
   */
  private async token(options: ProviderOptions, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal)
    const account = this.account()
    if (account === undefined) {
      throw new WebError(
        'no DeepSeek account service is mounted, so search has no credential; sign in to DeepSeek, or disable this plugin and configure a search provider that takes an API key',
        'WEB_PROVIDER_CREDENTIAL_MISSING',
      )
    }
    let resolved: string | undefined
    try {
      resolved = await resolveAbortable(account.resolveToken(`${options.baseURL}/messages`), signal)
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw new WebError(
        `could not read the DeepSeek account credential: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    if (resolved === undefined || resolved.length === 0) {
      throw new WebError(
        `the DeepSeek account issued no token for ${JSON.stringify(options.baseURL)}. Sign in to DeepSeek again, or point baseURL at the endpoint the signed-in account authenticates (the default is https://api.deepseek.com/anthropic/v1)`,
        'WEB_PROVIDER_CREDENTIAL_MISSING',
      )
    }
    return resolved
  }
}

/** Extract the human-readable message from an error body, whichever shape it uses. */
function errorDetail(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return undefined
  const error = parsed['error']
  if (typeof error === 'string' && error.length > 0) return error
  if (isRecord(error)) {
    const message = error['message']
    if (typeof message === 'string' && message.length > 0) return message
  }
  const message = parsed['message']
  return typeof message === 'string' && message.length > 0 ? message : undefined
}

/** Sign-in guidance for a rejected credential, which needs no endpoint change. */
function unauthorized(message: string): WebError {
  return new WebError(
    `${message}\n\nDeepSeek rejected the account credential used for this web search. Sign in to DeepSeek again; the search endpoint does not need changing.`,
    'WEB_PROVIDER_ERROR',
  )
}

/** Add endpoint recovery guidance to failures that happened after dispatch began. */
function endpointError(endpoint: string, message: string, cause?: unknown): WebError {
  return new WebError(
    `${message}\n\nThe search request used endpoint ${JSON.stringify(endpoint)}. Search endpoint configuration is separate from chat: change this plugin's baseURL to an Anthropic-compatible Messages base the signed-in account authenticates.`,
    'WEB_PROVIDER_ERROR',
    cause === undefined ? undefined : { cause },
  )
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw aborted(signal)
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function aborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('web search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Race a same-process promise against caller cancellation, keeping settlement
 * handlers attached so a late rejection cannot become unhandled.
 */
function resolveAbortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(aborted(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(aborted(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * Mount the plugin.
 *
 * @param ctx - the Host plugin context.
 * @param config - the live configuration references.
 */
export function apply(ctx: Context, config: Config): void {
  const account = (): AccountLike | undefined => ctx.get('deepseekAccount') as AccountLike | undefined
  const provider = new AccountSearchProvider(
    config.providerId.get(),
    () => ({
      baseURL: config.baseURL.get(),
      model: config.model.get(),
      apiVersion: config.apiVersion.get(),
      maxTokens: config.maxTokens.get(),
      maxUses: config.maxUses.get(),
    }),
    account,
  )
  ctx.web.registerSearchProvider(provider)
  ctx.logger.info(`web search uses the signed-in DeepSeek account at ${config.baseURL.get()}`)
}
