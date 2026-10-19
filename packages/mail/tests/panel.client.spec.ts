// @vitest-environment jsdom
/**
 * The contract between the two halves, checked where it can actually break:
 * the real panel document, fed real Host payloads, in a DOM.
 *
 * The document is read from disk rather than imported, so a change to what the
 * Host actually serves is what these assertions see.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { JSDOM, VirtualConsole, type DOMWindow } from 'jsdom'
import { describe, expect, it } from 'vitest'
import type { MailConfigView, MailDetail, MailState, MailSummary } from '../src/types.ts'

/**
 * The shipped document, read as a consumer receives it.
 *
 * Resolved from the repository root rather than `import.meta.url`, which Vite
 * rewrites to an `http:` URL that `readFileSync` refuses.
 */
const PANEL_FILE = resolve(process.cwd(), 'packages/mail/assets/panel.html')

/* ─────────────────────────────── fixtures ─────────────────────────────── */

const MESSAGE: MailSummary = {
  accountId: 'acc-1',
  folder: 'INBOX',
  uid: 11,
  uidValidity: 7,
  subject: '季度评审纪要',
  from: { name: '张三', address: 'zhang@qq.com' },
  date: '2026-08-12T09:20:00.000Z',
  seen: false,
  flagged: false,
  hasAttachments: true,
  snippet: '下周三的评审改到周四，请提前看附件',
}

const OTHER_MESSAGE: MailSummary = {
  accountId: 'acc-1',
  folder: 'INBOX',
  uid: 12,
  uidValidity: 7,
  subject: '本月账单',
  from: { address: 'billing@qq.com' },
  date: '2026-08-11T20:00:00.000Z',
  seen: true,
  flagged: true,
  hasAttachments: false,
  snippet: '本月账单已出',
}

const ACCOUNT: MailConfigView['accounts'][number] = {
  id: 'acc-1',
  name: '我的 QQ 邮箱',
  address: 'me@qq.com',
  provider: 'qq',
  imapHost: 'imap.qq.com',
  imapPort: 993,
  secure: true,
  trigger: { mode: 'panel', filters: { unreadOnly: true } },
}

const EMPTY_STATE: MailState = {
  version: 1,
  revision: 1,
  collectedAt: '2026-08-12T09:31:00.000Z',
  accounts: [],
  mailboxes: [],
  messages: [],
  config: { fallbackScanSeconds: 300, maxListMessages: 100, accounts: [], triggerAvailability: { session: true, notify: true }, presets: { agents: [], permissions: [] } },
}

/** The account row `/state` reports for the account `ACCOUNT` configures. */
const ACCOUNT_VIEW: MailState['accounts'][number] = {
  id: 'acc-1',
  name: '我的 QQ 邮箱',
  address: 'me@qq.com',
  status: 'connected',
  unread: 1,
}

/** The state a configured account produces: two messages, one unread with an attachment. */
const STATE: MailState = {
  version: 1,
  revision: 1,
  collectedAt: '2026-08-12T09:31:00.000Z',
  accounts: [ACCOUNT_VIEW],
  mailboxes: [
    { accountId: 'acc-1', path: 'INBOX', specialUse: '\\Inbox', unseen: 1, total: 9 },
    { accountId: 'acc-1', path: 'Sent Messages', unseen: 0, total: 3 },
  ],
  messages: [MESSAGE, OTHER_MESSAGE],
  config: {
    fallbackScanSeconds: 300,
    maxListMessages: 100,
    accounts: [ACCOUNT],
    triggerAvailability: { session: true, notify: true },
    // What the drawer's two dropdowns show: the shipped presets name themselves
    // through the host, and a permission preset carries its label too.
    presets: {
      agents: [
        { value: 'standard', label: '标准模式', description: '日常编码与文件处理' },
        { value: 'minimal', label: '极简模式', broken: '缺少必需服务' },
      ],
      permissions: [
        { value: 'read-only', label: '只读' },
        { value: 'workspace-write', label: '仅工作目录可写' },
        { value: 'danger-full-access', label: '完全访问' },
      ],
    },
  },
}

/** Carries a remote tracking pixel: the panel must not let it through by default. */
const DETAIL: MailDetail = {
  ...MESSAGE,
  to: [{ address: 'me@qq.com' }],
  cc: [],
  text: '纯文本正文',
  html: '<p>正文第一段</p><img src="https://tracker.example/pixel.gif" alt="tracker"><p><a href="https://example.com/x">链接</a></p>',
  attachments: [{ part: '2', filename: '纪要.pdf', contentType: 'application/pdf', size: 2048 }],
  truncated: false,
}

/* ──────────────────────────────── harness ─────────────────────────────── */

/** One canned answer: `status` defaults to 200. */
interface Reply {
  readonly status?: number
  readonly body: unknown
}

/** Who answers which route. An absent `message` answers 404. */
interface Routes {
  readonly state: Reply
  readonly message?: Reply
}

/** One mutating request the panel made, so a test can assert on the body. */
interface WriteCall {
  readonly url: string
  readonly body: unknown
}

const settle = (window: DOMWindow, ms = 40): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, ms))

/**
 * Load the shipped panel document and answer its requests.
 * @param routes - canned Host answers.
 * @param bodyAttributes - extra attributes for the panel's own `<body>`, which
 * stands in for the Host shell's theme tokens (the bridge reads them off a body).
 * @returns the window and every uncaught error the document raised.
 */
async function renderPanel(
  routes: Routes,
  bodyAttributes = '',
): Promise<{ window: DOMWindow; errors: readonly string[]; writes: readonly WriteCall[] }> {
  const errors: string[] = []
  const writes: WriteCall[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error: Error) => errors.push(error.message))
  const html = readFileSync(PANEL_FILE, 'utf8').replace('<body>', `<body${bodyAttributes}>`)
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/dsh-mail/panel',
    virtualConsole,
    beforeParse(window) {
      // jsdom ships no fetch; the panel reads through it and writes when it marks
      // a message read, which is the one mutating call the list makes by itself.
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (init?.method === 'POST') {
          writes.push({ url, body: JSON.parse(String(init.body)) as unknown })
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }
        }
        const reply = url.startsWith('/dsh-mail/message') ? routes.message : routes.state
        const status = reply?.status ?? (reply ? 200 : 404)
        const body = reply ? reply.body : { error: 'no fixture for ' + url }
        return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }
      }) as unknown as typeof window.fetch
    },
  })
  await settle(dom.window)
  return { window: dom.window, errors, writes }
}

/* ───────────────────────────────── tests ──────────────────────────────── */

describe('the mail panel document', () => {
  it('lists the messages the Host reports and marks the unread ones', async () => {
    const { window } = await renderPanel({ state: { body: STATE } })
    const doc = window.document
    const rows = [...doc.querySelectorAll('.m-row')]

    expect(rows.length).toBe(2)
    expect(rows[0]?.textContent).toContain('张三')
    expect(rows[0]?.textContent).toContain('季度评审纪要')
    expect(rows[1]?.textContent).toContain('billing@qq.com')
    // One unread dot and one unread row; the seen message carries the flag instead.
    expect(doc.querySelectorAll('.m-row[data-unread="true"]').length).toBe(1)
    expect(doc.querySelectorAll('.m-unread-dot[data-unread="true"]').length).toBe(1)
    expect(rows[0]?.textContent).toContain('📎')
    expect(rows[1]?.textContent).toContain('★')
    expect(doc.querySelector('.m-unread')?.textContent).toBe('未读 1')
    // Folders come from the Host, with the special-use name resolved.
    expect(doc.querySelector('.m-folders')?.textContent).toContain('收件箱')
    expect(doc.querySelector('.m-status')?.textContent).toContain('最近更新')
    expect(doc.querySelector('.m-empty')?.hasAttribute('hidden')).toBe(true)
  })

  it('asks the server for a scan and shows progress while it runs', async () => {
    // The Host reports which stage its pass is in. The panel used to only re-read
    // the in-memory snapshot, which is why pressing this button looked dead.
    const scanning: MailState = {
      ...STATE,
      accounts: STATE.accounts.map((one) => ({ ...one, stage: 'scanning' })),
    }
    const { window, writes } = await renderPanel({ state: { body: scanning } })
    const doc = window.document

    doc.querySelector<HTMLElement>('.m-refresh')?.click()
    await settle(window, 80)

    expect(writes.some((one) => one.url === '/dsh-mail/refresh')).toBe(true)
    expect(doc.querySelector('.m-status [data-busy="true"]')).not.toBeNull()
    expect(doc.querySelector('.m-status')?.textContent).toContain('拉取')
  })

  it('says when the list it drew came from the cache rather than a fresh scan', async () => {
    const stale: MailState = {
      ...STATE,
      collectedAt: '2026-08-12T09:31:00.000Z',
      cacheAt: '2026-08-12T09:00:00.000Z',
    }
    const { window } = await renderPanel({ state: { body: stale } })

    // The plugin draws the remembered list the moment it starts; saying so keeps
    // a stale row from reading as "this is what the server says right now".
    const note = window.document.querySelector('.m-status [data-cache="true"]')
    expect(note?.textContent).toContain('缓存')
  })

  it('marks the message it opens as read, so the list stops calling it unread', async () => {
    const { window, writes } = await renderPanel({ state: { body: STATE }, message: { body: DETAIL } })
    const doc = window.document
    doc.querySelector<HTMLElement>('.m-row')?.click()
    await settle(window, 80)

    const action = writes.find((one) => one.url === '/dsh-mail/action')
    expect(action?.body).toMatchObject({ op: 'markRead', accountId: 'acc-1', folder: 'INBOX', uids: [11] })
    // The row stops being bold immediately, without waiting for the next poll.
    expect(doc.querySelector('.m-row[data-unread="true"]')).toBeNull()
  })

  it('shows how to obtain an authorization code when no account is configured', async () => {
    const { window } = await renderPanel({ state: { body: EMPTY_STATE } })
    const doc = window.document
    const empty = doc.querySelector('.m-empty')

    expect(doc.querySelectorAll('.m-row').length).toBe(0)
    expect(empty?.hasAttribute('hidden')).toBe(false)
    expect(empty?.textContent).toContain('授权码')
    expect(empty?.textContent).toContain('应用专用密码')
    expect(empty?.textContent).toContain('imap.qq.com')
    expect(empty?.textContent).toContain('imap.gmail.com')
    expect(doc.querySelector('.m-empty .m-open-settings')).toBeTruthy()
  })

  it('shows a server ALERT beside the status line, as the warning it is', async () => {
    const state: MailState = {
      ...STATE,
      accounts: [{ ...ACCOUNT_VIEW, alert: 'quota exceeded' }],
    }
    const { window } = await renderPanel({ state: { body: state } })
    const doc = window.document
    const status = doc.querySelector('.m-status')

    // RFC 2683 §3.4.11: "Clients must present ALERT text clearly to the user".
    expect(status?.textContent).toContain('服务器提示：quota exceeded')
    expect(status?.querySelector('[data-alert="true"]')).toBeTruthy()
    // It is the account's state, not a failed read, so the error styling and the
    // retry button stay off.
    expect(status?.getAttribute('data-error')).toBeNull()
    expect(status?.querySelector('.m-retry')).toBeNull()
  })

  it('reports a failed read with a retry instead of pretending the inbox is empty', async () => {
    const { window } = await renderPanel({ state: { status: 500, body: { error: 'imap 未连接' } } })
    const doc = window.document

    expect(doc.querySelector('.m-status')?.textContent).toContain('imap 未连接')
    expect(doc.querySelector('.m-status')?.getAttribute('data-error')).toBe('true')
    expect(doc.querySelector('.m-status .m-retry')).toBeTruthy()
    expect(doc.querySelector('.m-empty')?.textContent).toContain('imap 未连接')
    expect(doc.querySelectorAll('.m-row').length).toBe(0)
    // The guidance for an unconfigured account must not be shown for a failure.
    expect(doc.querySelector('.m-empty')?.textContent).not.toContain('授权码')
  })

  it('frames message HTML in a sandbox with no remote image source by default', async () => {
    const { window } = await renderPanel({ state: { body: STATE }, message: { body: DETAIL } })
    const doc = window.document
    doc.querySelector('.m-row')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle(window)

    const frame = doc.querySelector('.m-html-frame')
    expect(frame).toBeTruthy()
    // `sandbox=""` is the whole point: no scripts, no same-origin, no popups.
    expect(frame?.getAttribute('sandbox')).toBe('')
    const srcdoc = frame?.getAttribute('srcdoc') ?? ''
    expect(srcdoc).toContain('正文第一段')
    expect(srcdoc).toContain('<base target="_blank">')
    expect(srcdoc).toMatch(/img-src data:;/)
    // The tracking pixel is replaced outright, so its address never reaches the frame.
    expect(srcdoc).toContain('data:image/gif;base64')
    expect(srcdoc).not.toContain('https://tracker.example')
    expect(doc.querySelector('.m-from')?.textContent).toContain('张三')

    const attachment = doc.querySelector('.m-attachments a')
    expect(attachment?.getAttribute('href')).toContain('/dsh-mail/attachment?')
    expect(attachment?.getAttribute('href')).toContain('part=2')
    expect(attachment?.getAttribute('href')).toContain('uid=11')

    // Asking for images re-renders the same script-less sandbox, now allowing https.
    doc.querySelector('.m-show-images')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    const allowed = doc.querySelector('.m-html-frame')
    expect(allowed?.getAttribute('sandbox')).toBe('')
    expect(allowed?.getAttribute('srcdoc')).toContain('https://tracker.example')
    expect(allowed?.getAttribute('srcdoc')).toMatch(/img-src data: https:/)
  })

  it('keeps its own palette without throwing when there is no host document', async () => {
    const { window, errors } = await renderPanel({ state: { body: EMPTY_STATE } })
    expect(window.parent).toBe(window)
    const root = window.document.documentElement
    expect(root.dataset.mailScheme).toBe('light')
    expect(root.dataset.mailTokens).toBeUndefined()
    // jsdom cannot parse every declaration the panel uses; only script errors matter here.
    expect(errors.filter((entry) => !/stylesheet/i.test(entry))).toEqual([])
  })

  it('adopts the DSH tokens the shell writes on body, including the dark marker', async () => {
    const { window } = await renderPanel(
      { state: { body: EMPTY_STATE } },
      ' style="--dsw-alias-bg-base:#101216;--dsw-alias-label-primary:#e8eaee" data-ds-dark-theme',
    )
    const root = window.document.documentElement
    expect(root.style.getPropertyValue('--mail-page')).toBe('#101216')
    expect(root.style.getPropertyValue('--mail-fg')).toBe('#e8eaee')
    expect(root.dataset.mailTokens).toBe('')
    expect(root.dataset.mailScheme).toBe('dark')
  })

  it('offers the presets as labelled options and keeps a saved value the list no longer has', async () => {
    const state: MailState = {
      ...STATE,
      config: {
        ...STATE.config,
        accounts: [{
          ...ACCOUNT,
          trigger: {
            mode: 'session',
            filters: {},
            session: { workspacePath: 'D:\\ws', agentPreset: 'minimal', permissionPreset: 'gone-preset' },
          },
        }],
      },
    }
    const { window } = await renderPanel({ state: { body: state } })
    const doc = window.document
    doc.querySelector('.m-settings')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle(window)

    const agent = doc.querySelector<HTMLSelectElement>('.m-trigger-preset')
    const permission = doc.querySelector<HTMLSelectElement>('.m-trigger-permission')
    expect(agent?.tagName).toBe('SELECT')
    // The empty row means "use the deployment default"; every other row shows the
    // host's label, not the identifier that gets stored.
    expect([...(agent?.options ?? [])].map((option) => option.text)).toEqual(['（用部署默认）', '标准模式', '极简模式（不可用）'])
    expect([...(permission?.options ?? [])].map((option) => option.text)).toContain('只读')
    expect(agent?.value).toBe('minimal')
    // A saved preset the list no longer offers has to survive the round trip,
    // or opening the drawer would quietly rewrite the account's setting.
    expect(permission?.value).toBe('gone-preset')
    expect([...(permission?.options ?? [])].some((option) => option.text.includes('不在当前列表'))).toBe(true)
  })

  it('renders the saved rule list in order and posts it back with a new row appended', async () => {
    const state: MailState = {
      ...STATE,
      config: {
        ...STATE.config,
        accounts: [{
          ...ACCOUNT,
          trigger: {
            mode: 'panel',
            filters: {},
            rules: [
              { name: 'CI', when: { from: ['github'] }, action: 'session' },
              { when: { keywords: ['refund'] }, action: 'notify', notify: { sessionId: 's-1' } },
            ],
          },
        }],
      },
    }
    const { window, writes } = await renderPanel({ state: { body: state } })
    const doc = window.document
    doc.querySelector('.m-settings')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle(window)

    const rows = [...doc.querySelectorAll('[data-rule]')]
    expect(rows).toHaveLength(2)
    expect(rows[0]?.querySelector<HTMLSelectElement>('.m-rule-action')?.value).toBe('session')
    expect(rows[1]?.querySelector<HTMLSelectElement>('.m-rule-action')?.value).toBe('notify')
    expect(rows[0]?.querySelector<HTMLInputElement>('.m-rule-from')?.value).toBe('github')

    doc.querySelector<HTMLElement>('.m-rule-add')?.click()
    await settle(window)
    expect(doc.querySelectorAll('[data-rule]')).toHaveLength(3)

    doc.querySelector<HTMLElement>('.m-trigger-save')?.click()
    await settle(window, 80)
    const config = writes.find((one) => one.url === '/dsh-mail/config')
    const sent = (config?.body as { trigger?: { rules?: readonly { action?: string }[] } } | undefined)?.trigger
    expect(sent?.rules).toHaveLength(3)
    // The order the drawer shows is the order the Host evaluates.
    expect(sent?.rules?.[0]?.action).toBe('session')
    expect(sent?.rules?.[2]?.action).toBe('session')
  })

  it('sends the prompt template the drawer was given', async () => {
    const { window, writes } = await renderPanel({ state: { body: STATE } })
    const doc = window.document
    doc.querySelector('.m-settings')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle(window)

    const prompt = doc.querySelector<HTMLTextAreaElement>('.m-trigger-prompt')
    expect(prompt).toBeTruthy()
    if (prompt) prompt.value = '{subject}\n\n{body}'
    doc.querySelector<HTMLElement>('.m-trigger-save')?.click()
    await settle(window, 80)

    const config = writes.find((one) => one.url === '/dsh-mail/config')
    expect(config?.body).toMatchObject({ op: 'setTrigger', trigger: { promptTemplate: '{subject}\n\n{body}' } })
  })

  it('marks the trigger modes the Host half cannot offer', async () => {
    const state: MailState = {
      ...STATE,
      config: { ...STATE.config, triggerAvailability: { session: false, notify: false } },
    }
    const { window } = await renderPanel({ state: { body: state } })
    const doc = window.document
    doc.querySelector('.m-settings')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle(window)

    const options = [...doc.querySelectorAll('.m-trigger-mode option')] as HTMLOptionElement[]
    expect(options.find((option) => option.value === 'panel')?.disabled).toBe(false)
    expect(options.find((option) => option.value === 'session')?.disabled).toBe(true)
    expect(options.find((option) => option.value === 'notify')?.disabled).toBe(true)
    const note = doc.querySelector('.m-trigger-availability')
    expect(note?.hasAttribute('hidden')).toBe(false)
    expect(note?.textContent).toContain('不可选')
    // The drawer also offers the account form the Host's config route consumes.
    expect(doc.querySelector('.m-account-form')).toBeTruthy()
    expect(doc.querySelectorAll('.m-account-list [data-edit]').length).toBe(1)
  })
})
