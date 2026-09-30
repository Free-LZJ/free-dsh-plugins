// @vitest-environment jsdom
/** The stylesheet the agent-import card installs for itself. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_IMPORT_CLASS, installAgentImportStyles } from '../src/client/agent-import-card-style.ts'

/** The id the installer keys its one style element by. */
const ELEMENT_ID = 'dsh-agent-import-card-styles'

afterEach(() => {
  vi.unstubAllGlobals()
  document.getElementById(ELEMENT_ID)?.remove()
})

describe('installAgentImportStyles', () => {
  it('installs one stylesheet that defines the classes the card renders', () => {
    const dispose = installAgentImportStyles()

    const element = document.getElementById(ELEMENT_ID)
    expect(element?.tagName).toBe('STYLE')
    for (const className of Object.values(AGENT_IMPORT_CLASS)) {
      expect(element?.textContent).toContain(`.${className}`)
    }

    dispose()
    expect(document.getElementById(ELEMENT_ID)).toBeNull()
  })

  it('reuses the element a previous load left behind', () => {
    installAgentImportStyles()
    const first = document.getElementById(ELEMENT_ID)
    const dispose = installAgentImportStyles()

    expect(document.getElementById(ELEMENT_ID)).toBe(first)
    expect(document.querySelectorAll(`#${ELEMENT_ID}`)).toHaveLength(1)

    dispose()
  })

  it('installs nothing where there is no document to install into', () => {
    vi.stubGlobal('document', undefined)

    const dispose = installAgentImportStyles()

    expect(() => { dispose() }).not.toThrow()
  })
})
