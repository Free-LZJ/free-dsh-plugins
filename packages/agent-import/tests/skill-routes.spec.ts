import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_BODY_BYTES, MUTATION_HEADER } from '../src/http.ts'
import { buildSkillCatalog } from '../src/skill-catalog.ts'
import type { SkillCatalog, SkillCandidate, SkillReport } from '../src/skill-catalog.ts'
import { importSkill, removeSkill, skillStatePathFor } from '../src/skill-import.ts'
import type { SkillImportOutcome, SkillImportOptions, SkillImportRequest } from '../src/skill-import.ts'
import type { ResolvedSkillRoot } from '../src/skill-roots.ts'
import {
  createSkillContentHandler,
  createSkillMutationHandler,
  createSkillsHandler,
  MAX_CONTENT_BYTES,
  readSkillContent,
} from '../src/skill-routes.ts'
import type { SkillRouteOperations } from '../src/skill-routes.ts'

/** Directories this file wrote, removed once the case that made them ends. */
const temporary: string[] = []

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true })
})

/** Make a directory under the system temp root, removed after the current case. */
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-import-routes-'))
  temporary.push(root)
  return root
}

/** Write one skill bundle, returning the file the catalog would point at. */
async function writeSkill(root: string, name: string, body = 'Body line\n'): Promise<string> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'SKILL.md')
  await writeFile(path, `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n${body}`, 'utf8')
  return path
}

/** One candidate row, with the fields the routes read. */
function candidate(source: SkillCandidate['source'], file: string, winner: boolean): SkillCandidate {
  return {
    source,
    label: source,
    scope: 'user',
    path: join(file, '..'),
    file,
    realPath: join(file, '..'),
    linked: winner,
    winner,
  }
}

/** One catalog row built by hand, so the routes are read against known data. */
function row(name: string, candidates: readonly SkillCandidate[], overrides: Partial<SkillReport> = {}): SkillReport {
  const installed = candidates[0]
  return {
    name,
    description: `The ${name} skill.`,
    candidates,
    state: 'linked',
    ...installed === undefined ? {} : { installedPath: installed.path, installedFile: installed.file },
    conflict: candidates.length > 1,
    ...overrides,
  }
}

/** A request stub carrying exactly the fields the routes read. */
function request(options: {
  method?: string
  url?: string
  headers?: Record<string, string>
  body?: string
} = {}): IncomingMessage {
  const chunks = options.body === undefined ? [] : [Buffer.from(options.body, 'utf8')]
  return {
    method: options.method ?? 'GET',
    url: options.url ?? '/agent-import/skills',
    headers: options.headers ?? {},
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as IncomingMessage
}

/** A response stub that records what the handler answered. */
function response(): { res: ServerResponse; answer: () => { status: number; body: unknown; headers: Record<string, unknown> } } {
  let status = 0
  let headers: Record<string, unknown> = {}
  let written = ''
  const res = {
    writeHead(next: number, nextHeaders: Record<string, unknown>): void {
      status = next
      headers = nextHeaders
    },
    end(body?: string): void {
      written = body ?? ''
    },
  } as unknown as ServerResponse
  return {
    res,
    answer: () => ({ status, body: written.length === 0 ? undefined : JSON.parse(written) as unknown, headers }),
  }
}

/** Operations answering a fixed catalog, recording every mutation they receive. */
function operations(catalog: SkillCatalog | (() => Promise<SkillCatalog>), outcome?: SkillImportOutcome): {
  readonly ops: SkillRouteOperations
  readonly calls: { readonly imports: SkillImportRequest[]; readonly removals: string[] }
} {
  const calls = { imports: [] as SkillImportRequest[], removals: [] as string[] }
  const answer: SkillImportOutcome = outcome ?? { imported: [], removed: [], skipped: [], notes: [] }
  return {
    calls,
    ops: {
      catalog: typeof catalog === 'function' ? catalog : async () => catalog,
      importSkill: async (body: SkillImportRequest) => {
        calls.imports.push(body)
        return answer
      },
      removeSkill: async (skillName: string) => {
        calls.removals.push(skillName)
        return answer
      },
    },
  }
}

describe('the catalog route', () => {
  it('answers the catalog for a same-origin read', async () => {
    const { ops } = operations({ skills: [row('demo', [candidate('codex', 'C:\\x\\SKILL.md', true)])], notes: ['a note'] })
    const { res, answer } = response()
    await createSkillsHandler(ops)(request({ headers: { 'sec-fetch-site': 'same-origin' } }), res)
    expect(answer().status).toBe(200)
    expect(answer().body).toEqual({ skills: [expect.objectContaining({ name: 'demo' })], notes: ['a note'] })
    expect(answer().headers['cache-control']).toBe('no-store')
  })

  it('refuses a method it does not answer', async () => {
    const { ops } = operations({ skills: [], notes: [] })
    const { res, answer } = response()
    await createSkillsHandler(ops)(request({ method: 'POST' }), res)
    expect(answer()).toMatchObject({ status: 405, body: { error: 'method not allowed' } })
  })

  it('refuses a request from another site, and one whose Origin is another host', async () => {
    const { ops } = operations({ skills: [], notes: [] })
    const crossSite = response()
    await createSkillsHandler(ops)(request({ headers: { 'sec-fetch-site': 'cross-site' } }), crossSite.res)
    expect(crossSite.answer()).toMatchObject({ status: 403, body: { error: 'forbidden' } })

    const otherHost = response()
    await createSkillsHandler(ops)(request({ headers: { host: '127.0.0.1:19387', origin: 'http://evil.example' } }), otherHost.res)
    expect(otherHost.answer()).toMatchObject({ status: 403 })

    const sameHost = response()
    await createSkillsHandler(ops)(request({ headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' } }), sameHost.res)
    expect(sameHost.answer().status).toBe(200)
  })

  it('reports a catalog that could not be built instead of failing the request', async () => {
    const { ops } = operations(async () => { throw new Error('no roots') })
    const { res, answer } = response()
    await createSkillsHandler(ops)(request(), res)
    expect(answer()).toMatchObject({ status: 500, body: { error: 'Error: no roots' } })
  })
})

describe('the instruction-body route', () => {
  it('answers the installed copy of a skill, with the file it read', async () => {
    const root = await makeRoot()
    const file = await writeSkill(root, 'demo')
    const catalog: SkillCatalog = { skills: [row('demo', [candidate('codex', file, true)])], notes: [] }
    const { res, answer } = response()
    await createSkillContentHandler(operations(catalog).ops)(request({ url: '/agent-import/skills/content?name=demo' }), res)
    expect(answer()).toMatchObject({
      status: 200,
      body: { name: 'demo', description: 'The demo skill.', source: 'codex', file, content: 'Body line' },
    })
  })

  it('reads the copy a named source offers, rather than the installed one', async () => {
    const root = await makeRoot()
    const installed = await writeSkill(root, 'demo', 'Installed body\n')
    const other = await writeSkill(join(root, 'other'), 'demo', 'Other body\n')
    const catalog: SkillCatalog = {
      skills: [row('demo', [candidate('codex', installed, true), candidate('claude-code', other, false)])],
      notes: [],
    }
    const { ops } = operations(catalog)
    await expect(readSkillContent(catalog, { name: 'demo' })).resolves.toMatchObject({ file: installed, content: 'Installed body' })
    await expect(readSkillContent(catalog, { name: 'demo', source: 'claude-code' })).resolves.toMatchObject({ file: other, content: 'Other body' })

    const { res, answer } = response()
    await createSkillContentHandler(ops)(request({ url: '/agent-import/skills/content?name=demo&source=claude-code' }), res)
    expect(answer()).toMatchObject({ status: 200, body: { source: 'claude-code', content: 'Other body' } })
  })

  it('asks for a name, and explains every way one cannot be read', async () => {
    const root = await makeRoot()
    const file = await writeSkill(root, 'demo')
    const catalog: SkillCatalog = { skills: [row('demo', [candidate('codex', file, true)])], notes: [] }
    const { ops } = operations(catalog)

    const missing = response()
    await createSkillContentHandler(ops)(request({ url: '/agent-import/skills/content' }), missing.res)
    expect(missing.answer()).toMatchObject({ status: 400, body: { error: 'name is required' } })

    const unknown = response()
    await createSkillContentHandler(ops)(request({ url: '/agent-import/skills/content?name=absent' }), unknown.res)
    expect(unknown.answer()).toMatchObject({ status: 404, body: { error: 'no skill named absent' } })

    const wrongSource = response()
    await createSkillContentHandler(ops)(request({ url: '/agent-import/skills/content?name=demo&source=lingma' }), wrongSource.res)
    expect(wrongSource.answer()).toMatchObject({ status: 404, body: { error: 'demo has no lingma copy' } })

    await expect(readSkillContent({ skills: [row('ghost', [])], notes: [] }, { name: 'ghost' }))
      .resolves.toBe('ghost has no readable instruction file')
    await expect(readSkillContent(catalog, { name: 'demo' })).resolves.toMatchObject({ name: 'demo' })
  })

  it('refuses to display a skill larger than the page reads', async () => {
    const root = await makeRoot()
    const file = await writeSkill(root, 'big', 'x'.repeat(MAX_CONTENT_BYTES + 1))
    const catalog: SkillCatalog = { skills: [row('big', [candidate('codex', file, true)])], notes: [] }
    const { res, answer } = response()
    await createSkillContentHandler(operations(catalog).ops)(request({ url: '/agent-import/skills/content?name=big' }), res)
    expect(answer().status).toBe(404)
    expect(String((answer().body as { error: string }).error)).toContain('too large to display')
  })

  it('refuses a method it does not answer and a request from another site', async () => {
    const catalog: SkillCatalog = { skills: [], notes: [] }
    const { ops } = operations(catalog)
    const posted = response()
    await createSkillContentHandler(ops)(request({ method: 'POST' }), posted.res)
    expect(posted.answer()).toMatchObject({ status: 405 })

    const crossSite = response()
    await createSkillContentHandler(ops)(request({ headers: { 'sec-fetch-site': 'cross-site' } }), crossSite.res)
    expect(crossSite.answer()).toMatchObject({ status: 403 })
  })
})

describe('the mutating routes', () => {
  /** The marks this page's own script makes on a mutating request. */
  const marks = { [MUTATION_HEADER]: '1', 'content-type': 'application/json' }

  it('imports what the body names, and answers the outcome', async () => {
    const outcome: SkillImportOutcome = { imported: ['demo'], removed: [], skipped: [], notes: [] }
    const { ops, calls } = operations({ skills: [], notes: [] }, outcome)
    const { res, answer } = response()
    await createSkillMutationHandler(ops, 'import')(
      request({ method: 'POST', headers: marks, body: JSON.stringify({ name: 'demo', source: 'codex', replace: true }) }),
      res,
    )
    expect(calls.imports).toEqual([{ name: 'demo', source: 'codex', replace: true }])
    expect(answer()).toMatchObject({ status: 200, body: { outcome } })
  })

  it('removes what the body names, ignoring the fields only an import uses', async () => {
    const { ops, calls } = operations({ skills: [], notes: [] })
    const { res, answer } = response()
    await createSkillMutationHandler(ops, 'remove')(
      request({ method: 'POST', headers: marks, body: JSON.stringify({ name: 'demo', source: 'codex', replace: true }) }),
      res,
    )
    expect(calls.removals).toEqual(['demo'])
    expect(answer()).toMatchObject({ status: 200, body: { outcome: { imported: [], removed: [] } } })
  })

  it('refuses anything but a marked JSON POST from this page', async () => {
    const { ops, calls } = operations({ skills: [], notes: [] })
    const handler = createSkillMutationHandler(ops, 'import')

    const read = response()
    await handler(request({ method: 'GET' }), read.res)
    expect(read.answer()).toMatchObject({ status: 405 })

    const unmarked = response()
    await handler(request({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"demo"}' }), unmarked.res)
    expect(unmarked.answer()).toMatchObject({ status: 403, body: { error: 'forbidden' } })

    const formPost = response()
    await handler(request({ method: 'POST', headers: { [MUTATION_HEADER]: '1', 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=demo' }), formPost.res)
    expect(formPost.answer()).toMatchObject({ status: 403 })

    const crossSite = response()
    await handler(request({ method: 'POST', headers: { ...marks, 'sec-fetch-site': 'cross-site' }, body: '{"name":"demo"}' }), crossSite.res)
    expect(crossSite.answer()).toMatchObject({ status: 403 })

    expect(calls.imports).toEqual([])
  })

  it('rejects a body it cannot use, before any import runs', async () => {
    const { ops, calls } = operations({ skills: [], notes: [] })
    const handler = createSkillMutationHandler(ops, 'import')
    const cases: readonly (readonly [string, number, string])[] = [
      ['', 400, 'request body must be JSON'],
      ['not json', 400, 'request body must be JSON'],
      ['[]', 400, 'body must be a JSON object'],
      ['{}', 400, 'name must be a non-empty string'],
      ['{"name":"   "}', 400, 'name must be a non-empty string'],
      [JSON.stringify({ name: 'x'.repeat(201) }), 400, 'name is too long'],
      [JSON.stringify({ name: 'demo', replace: 'yes' }), 400, 'replace must be a boolean'],
      [JSON.stringify({ name: 'demo', source: 7 }), 400, 'source must be a string'],
    ]
    for (const [body, status, error] of cases) {
      const { res, answer } = response()
      await handler(request({ method: 'POST', headers: marks, body }), res)
      expect(answer()).toMatchObject({ status, body: { error } })
    }
    expect(calls.imports).toEqual([])
  })

  it('rejects a body larger than it ever needs to read', async () => {
    const { ops, calls } = operations({ skills: [], notes: [] })
    const { res, answer } = response()
    await createSkillMutationHandler(ops, 'import')(
      request({ method: 'POST', headers: marks, body: JSON.stringify({ name: 'x'.repeat(MAX_BODY_BYTES) }) }),
      res,
    )
    expect(answer()).toMatchObject({ status: 413, body: { error: 'request body too large' } })
    expect(calls.imports).toEqual([])
  })

  it('reports a failed import as the reason it failed', async () => {
    const ops: SkillRouteOperations = {
      catalog: async () => ({ skills: [], notes: [] }),
      importSkill: async () => { throw new Error('link is occupied') },
      removeSkill: async () => { throw new Error('never called') },
    }
    const { res, answer } = response()
    await createSkillMutationHandler(ops, 'import')(request({ method: 'POST', headers: marks, body: '{"name":"demo"}' }), res)
    expect(answer()).toMatchObject({ status: 500, body: { error: 'Error: link is occupied' } })
  })
})

describe('the routes against the real operations', () => {
  it('imports a link through the route, then reports it and removes it', async () => {
    const home = await makeRoot()
    const source = await makeRoot()
    await writeSkill(source, 'demo')
    const roots: readonly ResolvedSkillRoot[] = [
      { source: 'dsh', label: 'dsh', scope: 'user', path: join(home, 'skills'), rank: 400, writable: true },
      { source: 'codex', label: 'Codex', scope: 'user', path: source, rank: 510, writable: false },
    ]
    // The same wiring the plugin performs: one catalog build per request, and
    // the importing operations pointed at the generation's own roots.
    const ops: SkillRouteOperations = {
      catalog: async () => await buildSkillCatalog(roots, { maxSkills: 20 }),
      importSkill: async (body: SkillImportRequest) => await importSkill(roots, { maxSkills: 20 }, body),
      removeSkill: async (skillName: string) => await removeSkill(roots, { maxSkills: 20 }, skillName),
    }
    const link = join(home, 'skills', 'demo')
    const marks = { [MUTATION_HEADER]: '1', 'content-type': 'application/json' }

    const imported = response()
    await createSkillMutationHandler(ops, 'import')(
      request({ method: 'POST', headers: marks, body: JSON.stringify({ name: 'demo', source: 'codex' }) }),
      imported.res,
    )
    expect(imported.answer()).toMatchObject({ status: 200, body: { outcome: { imported: ['demo'] } } })
    expect((await lstat(link)).isSymbolicLink()).toBe(true)

    const catalog = response()
    await createSkillsHandler(ops)(request(), catalog.res)
    expect(catalog.answer()).toMatchObject({
      status: 200,
      body: { skills: [expect.objectContaining({ name: 'demo', state: 'linked', installedSource: 'codex' })] },
    })

    const body = response()
    await createSkillContentHandler(ops)(request({ url: '/agent-import/skills/content?name=demo' }), body.res)
    expect(body.answer()).toMatchObject({ status: 200, body: { content: 'Body line' } })

    const removed = response()
    await createSkillMutationHandler(ops, 'remove')(
      request({ method: 'POST', headers: marks, body: JSON.stringify({ name: 'demo' }) }),
      removed.res,
    )
    expect(removed.answer()).toMatchObject({ status: 200, body: { outcome: { removed: ['demo'] } } })
    await expect(lstat(link)).rejects.toThrow()
    // The skill the link pointed at is still there: only the import was undone.
    await expect(readFile(join(source, 'demo', 'SKILL.md'), 'utf8')).resolves.toContain('The demo skill.')
  })

  it('keeps a removal decision in the user’s dsh home, never in the workspace', async () => {
    const home = await makeRoot()
    const project = await makeRoot()
    const source = await makeRoot()
    await writeSkill(source, 'demo')
    // The order the plugin resolves: the project-scope dsh root is writable too,
    // and its rank puts it before the user root.
    const roots: readonly ResolvedSkillRoot[] = [
      { source: 'dsh', label: 'dsh', scope: 'project', path: join(project, '.dsh', 'skills'), rank: 100, writable: true },
      { source: 'dsh', label: 'dsh', scope: 'user', path: join(home, 'skills'), rank: 400, writable: true },
      { source: 'codex', label: 'Codex', scope: 'user', path: source, rank: 510, writable: false },
    ]
    const statePath = skillStatePathFor(roots)
    if (statePath === undefined) throw new Error('the fixture has a writable user root')
    const options: SkillImportOptions = { maxSkills: 20, statePath }
    const ops: SkillRouteOperations = {
      catalog: async () => await buildSkillCatalog(roots, options),
      importSkill: async (body: SkillImportRequest) => await importSkill(roots, options, body),
      removeSkill: async (skillName: string) => await removeSkill(roots, options, skillName),
    }
    const marks = { [MUTATION_HEADER]: '1', 'content-type': 'application/json' }

    const imported = response()
    await createSkillMutationHandler(ops, 'import')(
      request({ method: 'POST', headers: marks, body: JSON.stringify({ name: 'demo', source: 'codex' }) }),
      imported.res,
    )
    expect((await lstat(join(home, 'skills', 'demo'))).isSymbolicLink()).toBe(true)

    const removed = response()
    await createSkillMutationHandler(ops, 'remove')(
      request({ method: 'POST', headers: marks, body: JSON.stringify({ name: 'demo' }) }),
      removed.res,
    )
    expect(removed.answer()).toMatchObject({ status: 200, body: { outcome: { removed: ['demo'] } } })

    await expect(readFile(join(home, 'agent-import', 'state.json'), 'utf8')).resolves.toContain('"demo"')
    // The workspace is left without so much as the directory.
    await expect(lstat(join(project, '.dsh'))).rejects.toThrow()
  })
})
