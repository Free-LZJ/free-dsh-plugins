import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSkillRoots, selectSkillSource, SKILL_SOURCES } from '../src/skill-roots.ts'

/** A fictional home, so nothing in these specs reads the real one. */
const HOME = join(tmpdir(), 'agent-import-roots-home')

/** Resolve roots for that home, against an empty environment unless a case adds one. */
function roots(options: { projectRoot?: string; env?: Record<string, string | undefined>; sources?: readonly never[] } = {}) {
  return resolveSkillRoots({ home: HOME, env: options.env ?? {}, ...options })
}

/** Find one root by the source and scope it belongs to. */
function rootFor(list: ReturnType<typeof roots>, source: string, scope: 'user' | 'project') {
  return list.find(entry => entry.source === source && entry.scope === scope)
}

describe('resolveSkillRoots', () => {
  it('resolves the user-scope directory of every known agent below the home', () => {
    const list = roots()
    expect(rootFor(list, 'dsh', 'user')).toMatchObject({ path: join(HOME, '.dsh', 'skills'), writable: true, rank: 400 })
    expect(rootFor(list, 'agents', 'user')).toMatchObject({ path: join(HOME, '.agents', 'skills'), writable: false })
    expect(rootFor(list, 'codex', 'user')).toMatchObject({ path: join(HOME, '.codex', 'skills') })
    expect(rootFor(list, 'claude-code', 'user')).toMatchObject({ path: join(HOME, '.claude', 'skills') })
    expect(rootFor(list, 'opencode', 'user')).toMatchObject({ path: join(HOME, '.config', 'opencode', 'skills') })
  })

  it('orders dsh first, then its shared agents directory, then the other tools', () => {
    const list = roots()
    const order = list.map(entry => entry.path)
    expect(order.indexOf(join(HOME, '.dsh', 'skills'))).toBe(0)
    expect(order.indexOf(join(HOME, '.agents', 'skills'))).toBeLessThan(order.indexOf(join(HOME, '.cc-switch', 'skills')))
    expect(order.indexOf(join(HOME, '.cc-switch', 'skills'))).toBeLessThan(order.indexOf(join(HOME, '.codex', 'skills')))
    expect(order.indexOf(join(HOME, '.codex', 'skills'))).toBeLessThan(order.indexOf(join(HOME, '.claude', 'skills')))
  })

  it('skips the project scope entirely when no project is named', () => {
    expect(roots().every(entry => entry.scope === 'user')).toBe(true)
  })

  it('adds project-scope roots below every user-scope root', () => {
    const project = join(HOME, 'project')
    const list = roots({ projectRoot: project })
    expect(rootFor(list, 'dsh', 'project')).toMatchObject({ path: join(project, '.dsh', 'skills'), writable: true })
    expect(rootFor(list, 'project', 'project')).toMatchObject({ path: join(project, 'skills'), writable: false })
    expect(rootFor(list, 'codex', 'project')).toMatchObject({ path: join(project, '.codex', 'skills') })
    expect(list[0]?.scope).toBe('project')
    expect(rootFor(list, 'dsh', 'project')?.rank).toBeLessThan(rootFor(list, 'dsh', 'user')?.rank ?? 0)
  })

  it('honours the environment variables that move a tool directory', () => {
    const env = {
      DSH_HOME: join(HOME, 'custom-dsh'),
      DSH_AGENTS_HOME: join(HOME, 'custom-agents'),
      CODEX_HOME: join(HOME, 'custom-codex'),
      CLAUDE_CONFIG_DIR: join(HOME, 'custom-claude'),
    }
    const list = roots({ env })
    expect(rootFor(list, 'dsh', 'user')?.path).toBe(join(HOME, 'custom-dsh', 'skills'))
    expect(rootFor(list, 'agents', 'user')?.path).toBe(join(HOME, 'custom-agents', 'skills'))
    expect(rootFor(list, 'codex', 'user')?.path).toBe(join(HOME, 'custom-codex', 'skills'))
    expect(rootFor(list, 'claude-code', 'user')?.path).toBe(join(HOME, 'custom-claude', 'skills'))
  })

  it('treats a blank environment override as absent', () => {
    expect(rootFor(roots({ env: { CODEX_HOME: '   ' } }), 'codex', 'user')?.path).toBe(join(HOME, '.codex', 'skills'))
  })

  it('resolves only the requested sources, plus the writable dsh root', () => {
    const list = resolveSkillRoots({ home: HOME, env: {}, sources: ['codex'] })
    expect([...new Set(list.map(entry => entry.source))].sort()).toEqual(['codex', 'dsh'])
    expect(list.some(entry => entry.writable)).toBe(true)
  })

  it('keeps every source identifier and rank unique, so precedence is never ambiguous', () => {
    const ids = SKILL_SOURCES.map(spec => spec.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('selectSkillSource', () => {
  it('picks the lowest-ranked root offering a name', () => {
    const list = roots()
    const codex = list.find(entry => entry.source === 'codex')
    const claude = list.find(entry => entry.source === 'claude-code')
    const dsh = list.find(entry => entry.source === 'dsh')
    expect(codex).toBeDefined()
    expect(claude).toBeDefined()
    expect(dsh).toBeDefined()
    expect(selectSkillSource([claude!, codex!])?.source).toBe('codex')
    expect(selectSkillSource([claude!, dsh!])?.source).toBe('dsh')
    expect(selectSkillSource([])).toBeUndefined()
  })
})
