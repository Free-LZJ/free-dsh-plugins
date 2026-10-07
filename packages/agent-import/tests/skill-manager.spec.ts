import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSkillCatalog, type SkillCatalog, type SkillReport } from '../src/skill-catalog.ts'
import { importSkill, removeSkill, skillStatePathFor, syncSkills } from '../src/skill-import.ts'
import { createSkillLink, readLinkTarget } from '../src/skill-links.ts'
import { resolveSkillRoots, type ResolvedSkillRoot } from '../src/skill-roots.ts'
import { readSkillState, writeSkillState } from '../src/skill-state.ts'

/** Every temp home created by this file, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Bounds that never truncate in these fixtures. */
const OPTIONS = { maxSkills: 200 }

/** Create one temp home to stand in for the user's. */
async function tempHome(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agent-import-skills-')))
  tempDirs.push(dir)
  return dir
}

/** Create one skill bundle and return its directory. */
async function writeSkill(root: string, name: string, description = `Skill ${name}.`): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`)
  return dir
}

/** Resolve the three roots these fixtures use: dsh's own, Codex's, and Claude's. */
function rootsFor(home: string): readonly ResolvedSkillRoot[] {
  return resolveSkillRoots({ home, env: {}, sources: ['dsh', 'codex', 'claude-code'] })
}

/** Compare two paths the way the platform does. */
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Find one skill row, failing loudly when the fixture did not produce it. */
function row(catalog: SkillCatalog, name: string): SkillReport {
  const found = catalog.skills.find(skill => skill.name === name)
  if (found === undefined) throw new Error(`no skill row for ${name}`)
  return found
}

describe('buildSkillCatalog', () => {
  it('groups two sources serving one name into a conflict with the lower rank winning', async () => {
    const home = await tempHome()
    await writeSkill(join(home, '.codex', 'skills'), 'alpha', 'Codex copy.')
    await writeSkill(join(home, '.claude', 'skills'), 'alpha', 'Claude copy.')
    await writeSkill(join(home, '.claude', 'skills'), 'beta')
    const catalog = await buildSkillCatalog(rootsFor(home), OPTIONS)
    const alpha = row(catalog, 'alpha')
    expect(alpha.conflict).toBe(true)
    expect(alpha.state).toBe('available')
    expect(alpha.description).toBe('Codex copy.')
    expect(alpha.candidates.map(candidate => candidate.source)).toEqual(['codex', 'claude-code'])
    expect(alpha.candidates.map(candidate => candidate.winner)).toEqual([true, false])
    const beta = row(catalog, 'beta')
    expect(beta.conflict).toBe(false)
    expect(beta.candidates).toHaveLength(1)
    expect(catalog.skills.map(skill => skill.name)).toEqual(['alpha', 'beta'])
  })

  it('collapses two roots serving the same files into one candidate', async () => {
    const home = await tempHome()
    const claudeSkill = await writeSkill(join(home, '.claude', 'skills'), 'delta')
    await mkdir(join(home, '.codex', 'skills'), { recursive: true })
    // The shape most Codex skills have: a link into the tool that holds the real directory.
    await createSkillLink(claudeSkill, join(home, '.codex', 'skills', 'delta'), 'directory')
    const delta = row(await buildSkillCatalog(rootsFor(home), OPTIONS), 'delta')
    expect(delta.conflict).toBe(false)
    expect(delta.candidates).toHaveLength(1)
    expect(delta.candidates[0]).toMatchObject({ source: 'codex', linked: true })
  })

  it('reports an entry in a dsh root as local, and a link with no target as broken', async () => {
    const home = await tempHome()
    await writeSkill(join(home, '.dsh', 'skills'), 'gamma')
    await mkdir(join(home, '.dsh', 'skills'), { recursive: true })
    await createSkillLink(join(home, '.codex', 'skills', 'ghost'), join(home, '.dsh', 'skills', 'ghost'), 'directory')
    const catalog = await buildSkillCatalog(rootsFor(home), OPTIONS)
    expect(row(catalog, 'gamma').state).toBe('local')
    expect(row(catalog, 'ghost').state).toBe('broken')
    expect(row(catalog, 'ghost').candidates).toHaveLength(0)
  })

  it('notes when the scan hit its bound', async () => {
    const home = await tempHome()
    await writeSkill(join(home, '.codex', 'skills'), 'alpha')
    await writeSkill(join(home, '.codex', 'skills'), 'beta')
    const catalog = await buildSkillCatalog(rootsFor(home), { maxSkills: 1 })
    expect(catalog.notes.some(note => note.includes('stopped after 1'))).toBe(true)
  })
  it('reports a name the user switched off as disabled, not as one never imported', async () => {
    const home = await tempHome()
    await writeSkill(join(home, '.codex', 'skills'), 'alpha')
    await writeSkill(join(home, '.codex', 'skills'), 'beta')
    const roots = rootsFor(home)
    const statePath = skillStatePathFor(roots) ?? ''
    const options = { maxSkills: 200, statePath }
    await syncSkills(roots, options)
    await removeSkill(roots, options, 'alpha')

    const off = await buildSkillCatalog(roots, options)
    // The page has to tell a switch that was turned off from a skill that was
    // never in, or the switch reads as having done nothing.
    expect(row(off, 'alpha').state).toBe('disabled')
    expect(row(off, 'beta').state).toBe('linked')
    // A caller that keeps no decisions has no removal to report.
    expect(row(await buildSkillCatalog(roots, OPTIONS), 'alpha').state).toBe('available')

    await importSkill(roots, options, { name: 'alpha' })
    expect(row(await buildSkillCatalog(roots, options), 'alpha').state).toBe('linked')
  })
})

describe('syncSkills', () => {
  it('links the winner of each name and leaves the sources alone', async () => {
    const home = await tempHome()
    const codexSkill = await writeSkill(join(home, '.codex', 'skills'), 'alpha')
    await writeSkill(join(home, '.claude', 'skills'), 'alpha')
    const claudeOnly = await writeSkill(join(home, '.claude', 'skills'), 'beta')
    const outcome = await syncSkills(rootsFor(home), OPTIONS)
    expect([...outcome.imported].sort()).toEqual(['alpha', 'beta'])
    expect(samePath((await readLinkTarget(join(home, '.dsh', 'skills', 'alpha'))) ?? '', codexSkill)).toBe(true)
    expect(samePath((await readLinkTarget(join(home, '.dsh', 'skills', 'beta'))) ?? '', claudeOnly)).toBe(true)
    await expect(readFile(join(codexSkill, 'SKILL.md'), 'utf8')).resolves.toContain('Body of alpha.')
  })

  it('is idempotent, reporting what is already installed', async () => {
    const home = await tempHome()
    await writeSkill(join(home, '.codex', 'skills'), 'alpha')
    const roots = rootsFor(home)
    await syncSkills(roots, OPTIONS)
    const again = await syncSkills(roots, OPTIONS)
    expect(again.imported).toEqual([])
    expect(again.skipped).toEqual([{ name: 'alpha', reason: 'already-installed' }])
  })

  it('never replaces a real directory in a dsh root', async () => {
    const home = await tempHome()
    await writeSkill(join(home, '.codex', 'skills'), 'gamma')
    const local = await writeSkill(join(home, '.dsh', 'skills'), 'gamma', 'Mine.')
    const outcome = await syncSkills(rootsFor(home), OPTIONS)
    expect(outcome.imported).toEqual([])
    expect(outcome.skipped).toEqual([{ name: 'gamma', reason: 'local-copy' }])
    await expect(readFile(join(local, 'SKILL.md'), 'utf8')).resolves.toContain('Mine.')
    expect(await readLinkTarget(local)).toBeUndefined()
  })

  it('reports a link that stopped resolving instead of replacing it', async () => {
    const home = await tempHome()
    await mkdir(join(home, '.dsh', 'skills'), { recursive: true })
    await createSkillLink(join(home, '.codex', 'skills', 'ghost'), join(home, '.dsh', 'skills', 'ghost'), 'directory')
    const outcome = await syncSkills(rootsFor(home), OPTIONS)
    expect(outcome.imported).toEqual([])
    expect(outcome.skipped).toEqual([{ name: 'ghost', reason: 'failed', detail: 'its link no longer resolves' }])
  })

  it('marks the imported state back into the catalog', async () => {
    const home = await tempHome()
    await writeSkill(join(home, '.codex', 'skills'), 'alpha')
    await writeSkill(join(home, '.claude', 'skills'), 'alpha')
    const roots = rootsFor(home)
    await syncSkills(roots, OPTIONS)
    const alpha = row(await buildSkillCatalog(roots, OPTIONS), 'alpha')
    expect(alpha.state).toBe('linked')
    expect(alpha.installedSource).toBe('codex')
    expect(alpha.conflict).toBe(true)
    expect(alpha.installedPath).toBe(join(home, '.dsh', 'skills', 'alpha'))
  })
})

describe('importSkill', () => {
  it('imports a chosen source in place of the winner when asked to replace', async () => {
    const home = await tempHome()
    await writeSkill(join(home, '.codex', 'skills'), 'alpha')
    const claudeSkill = await writeSkill(join(home, '.claude', 'skills'), 'alpha')
    const roots = rootsFor(home)
    await syncSkills(roots, OPTIONS)
    const replaced = await importSkill(roots, OPTIONS, { name: 'alpha', source: 'claude-code', replace: true })
    expect(replaced.imported).toEqual(['alpha'])
    expect(replaced.removed).toEqual(['alpha'])
    expect(samePath((await readLinkTarget(join(home, '.dsh', 'skills', 'alpha'))) ?? '', claudeSkill)).toBe(true)
  })

  it('refuses a second import while a link is in place, unless replacing', async () => {
    const home = await tempHome()
    await writeSkill(join(home, '.codex', 'skills'), 'alpha')
    await writeSkill(join(home, '.claude', 'skills'), 'alpha')
    const roots = rootsFor(home)
    await syncSkills(roots, OPTIONS)
    const again = await importSkill(roots, OPTIONS, { name: 'alpha', source: 'claude-code' })
    expect(again.imported).toEqual([])
    expect(again.skipped).toEqual([{ name: 'alpha', reason: 'already-installed' }])
  })

  it('reports a name no source offers', async () => {
    const home = await tempHome()
    await writeSkill(join(home, '.codex', 'skills'), 'alpha')
    const outcome = await importSkill(rootsFor(home), OPTIONS, { name: 'nowhere' })
    expect(outcome.skipped).toEqual([{ name: 'nowhere', reason: 'no-source' }])
  })

  it('repairs a broken link by replacing it', async () => {
    const home = await tempHome()
    const alpha = await writeSkill(join(home, '.codex', 'skills'), 'alpha')
    await mkdir(join(home, '.dsh', 'skills'), { recursive: true })
    await createSkillLink(join(home, '.codex', 'skills', 'ghost'), join(home, '.dsh', 'skills', 'alpha'), 'directory')
    const outcome = await importSkill(rootsFor(home), OPTIONS, { name: 'alpha', source: 'codex', replace: true })
    expect(outcome.imported).toEqual(['alpha'])
    expect(outcome.removed).toEqual(['alpha'])
    expect(samePath((await readLinkTarget(join(home, '.dsh', 'skills', 'alpha'))) ?? '', alpha)).toBe(true)
  })
})

describe('removeSkill', () => {
  it('removes the link and keeps the source directory intact', async () => {
    const home = await tempHome()
    const claudeSkill = await writeSkill(join(home, '.claude', 'skills'), 'beta')
    const roots = rootsFor(home)
    await syncSkills(roots, OPTIONS)
    const outcome = await removeSkill(roots, OPTIONS, 'beta')
    expect(outcome.removed).toEqual(['beta'])
    expect(await readLinkTarget(join(home, '.dsh', 'skills', 'beta'))).toBeUndefined()
    await expect(readFile(join(claudeSkill, 'SKILL.md'), 'utf8')).resolves.toContain('Body of beta.')
    expect(row(await buildSkillCatalog(roots, OPTIONS), 'beta').state).toBe('available')
  })

  it('refuses a name a real directory owns', async () => {
    const home = await tempHome()
    await writeSkill(join(home, '.codex', 'skills'), 'gamma')
    const local = await writeSkill(join(home, '.dsh', 'skills'), 'gamma')
    const outcome = await removeSkill(rootsFor(home), OPTIONS, 'gamma')
    expect(outcome.removed).toEqual([])
    expect(outcome.skipped).toEqual([{ name: 'gamma', reason: 'local-copy' }])
    await expect(readFile(join(local, 'SKILL.md'), 'utf8')).resolves.toContain('name: gamma')
  })

  it('removes a link that no longer resolves', async () => {
    const home = await tempHome()
    await mkdir(join(home, '.dsh', 'skills'), { recursive: true })
    await createSkillLink(join(home, '.codex', 'skills', 'ghost'), join(home, '.dsh', 'skills', 'ghost'), 'directory')
    const outcome = await removeSkill(rootsFor(home), OPTIONS, 'ghost')
    expect(outcome.removed).toEqual(['ghost'])
    expect(await readLinkTarget(join(home, '.dsh', 'skills', 'ghost'))).toBeUndefined()
  })

  it('reports a name dsh does not hold at all', async () => {
    const home = await tempHome()
    await writeSkill(join(home, '.codex', 'skills'), 'alpha')
    const outcome = await removeSkill(rootsFor(home), OPTIONS, 'alpha')
    expect(outcome.skipped).toEqual([{ name: 'alpha', reason: 'no-source' }])
  })
})

describe('remembered removals', () => {
  it('leaves a name the user removed alone on the next synchronization', async () => {
    const home = await tempHome()
    await writeSkill(join(home, '.codex', 'skills'), 'alpha')
    await writeSkill(join(home, '.codex', 'skills'), 'beta')
    const roots = rootsFor(home)
    const options = { maxSkills: 200, statePath: skillStatePathFor(roots) ?? '' }
    expect((await syncSkills(roots, options)).imported).toEqual(['alpha', 'beta'])
    expect((await removeSkill(roots, options, 'alpha')).removed).toEqual(['alpha'])

    const second = await syncSkills(roots, options)
    expect(second.imported).toEqual([])
    expect(second.skipped).toEqual([
      { name: 'alpha', reason: 'removed' },
      { name: 'beta', reason: 'already-installed' },
    ])
    expect(await readLinkTarget(join(home, '.dsh', 'skills', 'alpha'))).toBeUndefined()
    expect(await readLinkTarget(join(home, '.dsh', 'skills', 'beta'))).toBeDefined()
  })

  it('imports the name again when the user asks for it, and forgets the removal', async () => {
    const home = await tempHome()
    await writeSkill(join(home, '.codex', 'skills'), 'alpha')
    const roots = rootsFor(home)
    const statePath = skillStatePathFor(roots) ?? ''
    const options = { maxSkills: 200, statePath }
    await syncSkills(roots, options)
    await removeSkill(roots, options, 'alpha')
    expect((await readSkillState(statePath)).removed).toEqual(['alpha'])

    expect((await importSkill(roots, options, { name: 'alpha' })).imported).toEqual(['alpha'])
    expect((await readSkillState(statePath)).removed).toEqual([])
    expect((await syncSkills(roots, options)).skipped).toEqual([{ name: 'alpha', reason: 'already-installed' }])
  })

  it('still calls a removed name installed once something links it again', async () => {
    const home = await tempHome()
    const source = await writeSkill(join(home, '.codex', 'skills'), 'alpha')
    const roots = rootsFor(home)
    const statePath = skillStatePathFor(roots) ?? ''
    await writeSkillState(statePath, { removed: ['alpha'] })
    await mkdir(join(home, '.dsh', 'skills'), { recursive: true })
    await createSkillLink(source, join(home, '.dsh', 'skills', 'alpha'), 'directory')

    expect((await syncSkills(roots, { maxSkills: 200, statePath })).skipped).toEqual([{ name: 'alpha', reason: 'already-installed' }])
  })

  it('keeps no decision when no state file is configured', async () => {
    const home = await tempHome()
    await writeSkill(join(home, '.codex', 'skills'), 'alpha')
    const roots = rootsFor(home)
    await syncSkills(roots, OPTIONS)
    const outcome = await removeSkill(roots, OPTIONS, 'alpha')
    expect(outcome.notes).not.toContain('automatic import will not bring this name back')
    // Without a place to remember it, the next synchronization takes it back.
    expect((await syncSkills(roots, OPTIONS)).imported).toEqual(['alpha'])
  })

  it('says a removal will stick, and writes the decision beside dsh’s skill directory', async () => {
    const home = await tempHome()
    await writeSkill(join(home, '.codex', 'skills'), 'alpha')
    const roots = rootsFor(home)
    const statePath = skillStatePathFor(roots) ?? ''
    const options = { maxSkills: 200, statePath }
    await syncSkills(roots, options)
    const outcome = await removeSkill(roots, options, 'alpha')
    expect(outcome.notes).toContain('automatic import will not bring this name back')
    expect(samePath(statePath, join(home, '.dsh', 'agent-import', 'state.json'))).toBe(true)
    await expect(readFile(statePath, 'utf8')).resolves.toContain('"alpha"')
  })

  it('decides under the user’s home even when a workspace root is the writable one that sorts first', async () => {
    const home = await tempHome()
    const project = await tempHome()
    const roots = resolveSkillRoots({ home, projectRoot: project, env: {}, sources: ['dsh', 'codex'] })
    // The project-scope dsh root is writable by the catalog's reckoning and ranks
    // first; a decision file under it would land in the user's own workspace.
    expect(roots[0]).toMatchObject({ source: 'dsh', scope: 'project', writable: true })
    expect(samePath(skillStatePathFor(roots) ?? '', join(home, '.dsh', 'agent-import', 'state.json'))).toBe(true)
  })
})
