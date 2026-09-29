/** The flat-name view: the section is nested, the shared form addresses flat names. */

import { describe, expect, it } from 'vitest'
import { stubConfigForm } from './support/runtime.ts'
import { flatScope } from '../src/client/agent-import-flat-scope.ts'

/** The names the page addresses, spanning both section depths. */
const NAMES = ['projectRoot', 'codex.home', 'codex.configPath', 'codex.includeSystemSkills', 'serverDenyList']

describe('flatScope', () => {
  it('reads each name along its path, keeping only the members a layer carries', () => {
    const host = stubConfigForm<Record<string, unknown>>()
    host.publish({
      status: 'ready',
      writable: true,
      revision: 4,
      value: { projectRoot: '', codex: { home: '/h', configPath: '/c', includeSystemSkills: true } },
      base: { codex: { home: '/base' } },
      user: { codex: { home: '/h' }, serverDenyList: [] },
    })

    expect(flatScope(host.scope, NAMES).getSnapshot()).toEqual({
      status: 'ready',
      writable: true,
      revision: 4,
      value: {
        projectRoot: '',
        'codex.home': '/h',
        'codex.configPath': '/c',
        'codex.includeSystemSkills': true,
      },
      base: { 'codex.home': '/base' },
      user: { 'codex.home': '/h', serverDenyList: [] },
    })
  })

  it('reads nothing for a name whose path the layer does not carry', () => {
    const host = stubConfigForm<Record<string, unknown>>()
    host.publish({ status: 'ready', value: {}, user: { codex: '/' } })
    const scope = flatScope(host.scope, NAMES)

    // A missing first segment, and a member that is not an object where a path continues.
    expect(scope.getSnapshot().value).toEqual({})
    expect(scope.getSnapshot().user).toEqual({})
  })

  it('rewrites a written name onto its path and passes the Host acceptance through', async () => {
    const host = stubConfigForm<Record<string, unknown>>()
    const scope = flatScope(host.scope, NAMES)

    await expect(scope.mutate([
      { op: 'set', path: ['codex.home'], value: '/other' },
      { op: 'unset', path: ['serverDenyList'] },
    ], 4)).resolves.toBe(true)

    expect(host.mutate.mock.calls[0]).toEqual([[
      { op: 'set', path: ['codex', 'home'], value: '/other' },
      { op: 'unset', path: ['serverDenyList'] },
    ], 4])
  })

  it('observes the Host scope it views, and reads its newest revision', () => {
    const host = stubConfigForm<Record<string, unknown>>()
    const scope = flatScope(host.scope, NAMES)
    let notified = 0
    const stop = scope.subscribe(() => { notified += 1 })

    host.publish({ revision: 9 })
    stop()
    host.publish({ revision: 10 })

    expect(notified).toBe(1)
    expect(scope.getSnapshot().revision).toBe(10)
  })
})
