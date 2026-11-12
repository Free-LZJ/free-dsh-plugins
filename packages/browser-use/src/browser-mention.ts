/**
 * The browser tab provider: the first, and for now the only, mentionable thing.
 *
 * Everything specific to browsers lives here — the query match, the row text,
 * the ref shape. The registry above and the routes beside it stay ignorant of
 * what a tab is, which is what lets the next provider be a new file alone.
 *
 * @module @free-lzj/dsh-browser-use/browser-mention
 */

import type { BskMcpChannel } from './mcp-tabs.ts'
import { explainBsk } from './diagnose.ts'
import type { MentionProvider } from './mention.ts'
import type { BrowserTab } from './protocol.ts'

/** The provider id; also the `<provider>:` prefix of every ref it returns. */
const PROVIDER_ID = 'browser'

/** Section heading the client renders when it has no translation of its own. */
const PROVIDER_LABEL = '浏览器'

/**
 * Describe one tab in a menu row.
 *
 * The host alone would make several rows look identical (three `页面设计器`
 * tabs differ only by the page they show), so the path is part of the row when
 * the URL is not merely a site root.
 * @param tab - the tab.
 * @returns the row's second line.
 */
function describe(tab: BrowserTab): string {
  let site = tab.url
  let path = ''
  try {
    const parsed = new URL(tab.url)
    site = parsed.host
    path = parsed.pathname === '/' ? '' : parsed.pathname
  } catch {
    // A non-URL tab (`about:blank`, a devtools page) keeps its own text.
  }
  const where = path === '' ? site : `${site}${path}`
  return tab.active ? `${where} · 当前标签页` : where
}

/**
 * Match one tab against the typed query.
 *
 * Title and URL both match: people search for `jira` as often as for the ticket
 * number in the title.
 * @param tab - the tab.
 * @param needle - lowercase query; empty matches everything.
 * @returns whether the row belongs in the answer.
 */
function matches(tab: BrowserTab, needle: string): boolean {
  if (needle === '') return true
  return tab.title.toLowerCase().includes(needle) || tab.url.toLowerCase().includes(needle)
}

/**
 * Build the browser provider over one CLI handle.
 * @param cli - the shared `bsk` session.
 * @returns the provider the registry holds.
 */
export function browserMentionProvider(cli: BskMcpChannel): MentionProvider {
  return {
    id: PROVIDER_ID,
    label: PROVIDER_LABEL,
    async candidates(query: string, signal: AbortSignal): Promise<readonly { ref: string; label: string; description?: string }[]> {
      const needle = query.trim().toLowerCase()
      // Listing starts a session the first time, which is the one call worth
      // abandoning when the user has already typed past this menu.
      let tabs: readonly BrowserTab[]
      try {
        tabs = await cli.listUserTabs(signal)
      } catch (error: unknown) {
        // `bsk` writes a precise cause and no remedy; translated here so the
        // registry stays ignorant of browsers and the menu can show the sentence
        // where the rows would have been.
        const diagnosis = explainBsk(error instanceof Error ? error.message : String(error))
        throw new Error(`${diagnosis.reason}。${diagnosis.action}`)
      }
      if (signal.aborted) return []
      return tabs.filter(tab => matches(tab, needle)).map(tab => ({
        ref: `${PROVIDER_ID}:${tab.tabId}`,
        label: tab.title,
        description: describe(tab),
      }))
    },
  }
}
