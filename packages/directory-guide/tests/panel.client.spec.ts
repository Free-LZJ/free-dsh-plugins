// @vitest-environment jsdom
/**
 * The contract between the two halves, checked where it can actually break:
 * the real panel document, fed the real Host payload, in a DOM.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { JSDOM, type DOMWindow } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSnapshot, type Snapshot } from '../src/snapshot.ts'

/**
 * The shipped document, read as a consumer receives it.
 *
 * Resolved from the repository root rather than `import.meta.url`, which Vite
 * rewrites to an `http:` URL that `readFileSync` refuses.
 */
const PANEL_FILE = resolve(process.cwd(), 'packages/directory-guide/assets/panel.html')

let home = ''

/** Write one fixture file, creating its directory. */
function put(rel: string, body: string): void {
  const full = join(home, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, body)
}

/**
 * Load the shipped panel document and feed it the Host's answer.
 * @param bodyAttributes - extra attributes for the panel's own `<body>`, which
 * stands in for the Host shell's theme tokens (the bridge reads them off a body).
 * @returns the window, once the document has rendered the snapshot.
 */
async function renderPanel(bodyAttributes = ''): Promise<DOMWindow> {
  const snapshot: Snapshot = readSnapshot()
  const html = readFileSync(PANEL_FILE, 'utf8').replace('<body>', `<body${bodyAttributes}>`)
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/dsh-directory-guide/panel',
    beforeParse(window) {
      // jsdom ships neither, and the panel decodes the inlined bytes with them.
      window.TextEncoder = TextEncoder
      window.TextDecoder = TextDecoder
      window.fetch = (async () => ({ ok: true, status: 200, json: async () => snapshot })) as unknown as typeof window.fetch
      const dialog = window.HTMLDialogElement?.prototype
      if (dialog) {
        dialog.showModal = function showModal(this: HTMLDialogElement): void { this.setAttribute('open', '') }
        dialog.close = function close(this: HTMLDialogElement): void { this.removeAttribute('open') }
      }
    },
  })
  await new Promise(resolve => setTimeout(resolve, 40))
  return dom.window
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-guide-panel-'))
  process.env.DSH_HOME = home
  put('AGENTS.md', '# 用户全局指令\napi_key: sk-abcdefghijklmnop\n')
  put('.credentials.yaml', 'refs:\n  - name: real-secret\n')
  put('sessions/--D-open-repo--/session-abc/transcript.jsonl', '{"kind":"user"}\n')
  put('profiles/desktop/cordis.patch.yml', '- id: ui-chat\n')
})

afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('the panel document', () => {
  it('fetches the Host snapshot and lists the home directory without any permission step', async () => {
    const window = await renderPanel()
    const doc = window.document
    const rows = doc.querySelectorAll('tbody tr')
    // Four entries on disk, plus the hand-written rows for entries this fixture lacks.
    expect(rows.length).toBeGreaterThanOrEqual(4)
    const names = [...rows].map(row => row.querySelector('.ce-open')?.textContent?.trim())
    expect(names).toContain('AGENTS.md')
    expect(names).toContain('sessions')
    expect(doc.querySelector('.ce-live')?.textContent).toMatch(/快照/)
    expect(doc.querySelector('.ce-live')?.textContent).not.toMatch(/选择 .dsh 文件夹/)
    expect(doc.querySelector('.ce-captured')?.textContent).toMatch(/采集时间：\d{4}\/\d{2}\/\d{2}/)
    expect(doc.querySelector('.ce-crumb')?.textContent).toContain('.dsh')
  })

  it('expands a directory and previews an inlined file, redacted', async () => {
    const window = await renderPanel()
    const doc = window.document
    const rowFor = (name: string): Element | undefined =>
      [...doc.querySelectorAll('tbody tr')].find(row => row.querySelector('.ce-open')?.textContent?.trim() === name)

    rowFor('sessions')?.querySelector('.ce-disclosure')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 40))
    const repo = rowFor('--D-open-repo--')
    expect(repo).toBeDefined()
    expect(repo?.querySelector('td[data-column="note"]')?.textContent).toMatch(/按工作目录分桶/)
    expect(repo?.querySelector('td[data-column="advice"]')?.textContent?.trim()).toBe('保留')

    rowFor('AGENTS.md')?.querySelector('.ce-open')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 40))
    const text = doc.querySelector('.ce-preview-text')?.textContent ?? ''
    expect(text).toContain('用户全局指令')
    expect(text).toContain('[已遮盖]')
    expect(text).not.toContain('sk-abcdefghijklmnop')
  })

  it('hides a credential file body and marks the SQLite sidecar', async () => {
    put('storages/plugin-store/plugin-store.sqlite-wal', 'wal')
    const window = await renderPanel()
    const doc = window.document
    const rowFor = (name: string): Element | undefined =>
      [...doc.querySelectorAll('tbody tr')].find(row => row.querySelector('.ce-open')?.textContent?.trim() === name)

    rowFor('.credentials.yaml')?.querySelector('.ce-open')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 40))
    const text = doc.querySelector('.ce-preview-text')?.textContent ?? ''
    expect(text).toMatch(/已整体隐藏/)
    expect(text).not.toContain('real-secret')

    rowFor('storages')?.querySelector('.ce-disclosure')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 40))
    rowFor('plugin-store')?.querySelector('.ce-disclosure')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 40))
    const wal = rowFor('plugin-store.sqlite-wal')
    expect(wal?.querySelector('td[data-column="advice"]')?.textContent?.trim()).toBe('随主库')
    expect(wal?.querySelector('td[data-column="note"]')?.textContent).toMatch(/跟主库一起处理/)
  })

  it('follows the host theme through the DSH tokens the shell writes on body', async () => {
    const window = await renderPanel(' style="--dsw-alias-bg-base:#101216;--dsw-alias-label-primary:#e8eaee;--dsw-alias-brand-primary:#4f8cff" data-ds-dark-theme')
    const root = window.document.documentElement
    expect(root.style.getPropertyValue('--guide-page')).toBe('#101216')
    expect(root.style.getPropertyValue('--guide-fg')).toBe('#e8eaee')
    expect(root.style.getPropertyValue('--guide-accent')).toBe('#4f8cff')
    expect(root.dataset.guideTokens).toBe('')
    expect(root.dataset.guideScheme).toBe('dark')
  })

  it('keeps its own palette when no host theme is reachable', async () => {
    const window = await renderPanel()
    const root = window.document.documentElement
    expect(root.style.getPropertyValue('--guide-surface')).toBe('')
    expect(root.dataset.guideTokens).toBeUndefined()
    expect(root.dataset.guideScheme).toBe('light')
  })

  it('reports a failed snapshot read instead of rendering an empty table', async () => {
    const html = readFileSync(PANEL_FILE, 'utf8')
    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      url: 'http://localhost/dsh-directory-guide/panel',
      beforeParse(window) {
        window.TextEncoder = TextEncoder
        window.TextDecoder = TextDecoder
        window.fetch = (async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })) as unknown as typeof window.fetch
      },
    })
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(dom.window.document.querySelector('.ce-live')?.textContent).toMatch(/读取 ~\/\.dsh 失败：boom/)
  })
})
