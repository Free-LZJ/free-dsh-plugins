import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeCodeAdapter, claudeSkillRoots, readClaudeProjectServers, readClaudeServers } from '../src/adapters/claude-code.ts'
import type { AdapterContext } from '../src/adapter.ts'

/** Adapter inputs backed by an in-memory file map. */
function context(files: Record<string, string> = {}, env: Record<string, string | undefined> = {}): AdapterContext {
  return { projectRoot: join('C:', 'work'), env, readOptional: async path => files[path] }
}

/** One user-level configuration document declaring the given servers. */
function userConfig(servers: Record<string, unknown>): string {
  return JSON.stringify({ mcpServers: servers })
}

describe('readClaudeServers', () => {
  it('reads a stdio server without a type', () => {
    const text = userConfig({ postgres: { command: 'npx', args: ['-y', 'server-postgres'], env: { DSN: 'postgres://x' } } })
    expect(readClaudeServers(text, 'claude.json')).toEqual({
      servers: [{
        transport: 'stdio',
        name: 'postgres',
        source: 'claude-code',
        origin: 'claude.json',
        command: 'npx',
        args: ['-y', 'server-postgres'],
        env: { DSN: 'postgres://x' },
      }],
      notes: [],
    })
  })

  it('reads an explicit stdio type and an absent argument list', () => {
    const read = readClaudeServers(userConfig({ a: { type: 'stdio', command: 'node' } }), 'claude.json')
    expect(read.servers[0]).toMatchObject({ transport: 'stdio', args: [], env: {} })
  })

  it('reads an HTTP server with headers', () => {
    const text = userConfig({ utools: { type: 'http', url: 'http://127.0.0.1:3501/mcp', headers: { 'x-token': 't' } } })
    expect(readClaudeServers(text, 'claude.json').servers[0]).toEqual({
      transport: 'streamable-http',
      name: 'utools',
      source: 'claude-code',
      origin: 'claude.json',
      url: 'http://127.0.0.1:3501/mcp',
      headers: { 'x-token': 't' },
    })
  })

  it('reports a document that is not JSON', () => {
    const read = readClaudeServers('{ not json', 'claude.json')
    expect(read.servers).toEqual([])
    expect(read.notes[0]).toMatch(/^claude\.json: not valid JSON \(/)
  })

  it('reports a document that is not an object', () => {
    expect(readClaudeServers('[]', 'claude.json').notes).toEqual(['claude.json: configuration is not a JSON object'])
  })

  it('reads an absent mcpServers object as no servers', () => {
    expect(readClaudeServers('{"projects":{}}', 'claude.json')).toEqual({ servers: [], notes: [] })
  })

  it('reports an mcpServers value that is not an object', () => {
    expect(readClaudeServers('{"mcpServers":[]}', 'claude.json').notes).toEqual(['claude.json: "mcpServers" is not an object'])
  })

  it('reports a server declaration that is not an object', () => {
    expect(readClaudeServers(userConfig({ broken: 'npx' }), 'claude.json').notes)
      .toEqual(['claude.json: server "broken" skipped: declaration is not an object'])
  })
})

describe('readClaudeServers — unusable declarations', () => {
  it('skips an unsupported transport', () => {
    expect(readClaudeServers(userConfig({ a: { type: 'sse', url: 'https://x.test' } }), 'claude.json').notes)
      .toEqual(['claude.json: server "a" skipped: unsupported transport "sse"'])
  })

  it('skips a declaration whose type is not a string', () => {
    expect(readClaudeServers(userConfig({ a: { type: 1, command: 'node' } }), 'claude.json').notes)
      .toEqual(['claude.json: server "a" skipped: "type" must be a string'])
  })

  it('skips a stdio declaration without a command', () => {
    expect(readClaudeServers(userConfig({ a: { args: [] } }), 'claude.json').notes)
      .toEqual(['claude.json: server "a" skipped: missing "command"'])
  })

  it('skips a declaration whose arguments are not a string array', () => {
    expect(readClaudeServers(userConfig({ a: { command: 'node', args: 'x' } }), 'claude.json').notes)
      .toEqual(['claude.json: server "a" skipped: "args" must be an array of strings'])
  })

  it('skips a declaration whose argument array holds a non-string', () => {
    expect(readClaudeServers(userConfig({ a: { command: 'node', args: ['x', 2] } }), 'claude.json').notes)
      .toEqual(['claude.json: server "a" skipped: "args" must be an array of strings'])
  })

  it('skips a declaration whose environment is not an object', () => {
    expect(readClaudeServers(userConfig({ a: { command: 'node', env: [] } }), 'claude.json').notes)
      .toEqual(['claude.json: server "a" skipped: "env" must be an object'])
  })

  it('skips a declaration whose environment value is not a string', () => {
    expect(readClaudeServers(userConfig({ a: { command: 'node', env: { PORT: 1 } } }), 'claude.json').notes)
      .toEqual(['claude.json: server "a" skipped: env.PORT must be a string'])
  })

  it('skips a remote declaration without a url', () => {
    expect(readClaudeServers(userConfig({ a: { type: 'http' } }), 'claude.json').notes)
      .toEqual(['claude.json: server "a" skipped: missing "url"'])
  })

  it('skips a remote declaration whose headers are not an object', () => {
    expect(readClaudeServers(userConfig({ a: { type: 'http', url: 'https://x.test', headers: 'x' } }), 'claude.json').notes)
      .toEqual(['claude.json: server "a" skipped: "headers" must be an object'])
  })

  it('skips a remote declaration whose header value is not a string', () => {
    expect(readClaudeServers(userConfig({ a: { type: 'http', url: 'https://x.test', headers: { x: 1 } } }), 'claude.json').notes)
      .toEqual(['claude.json: server "a" skipped: headers.x must be a string'])
  })

  it('keeps a server that declares a startup timeout and reports the unapplied key', () => {
    const read = readClaudeServers(userConfig({ a: { command: 'node', startup_timeout_sec: 120 } }), 'claude.json')
    expect(read.servers).toHaveLength(1)
    expect(read.notes).toEqual(['claude.json: server "a" startup_timeout_sec has no dsh equivalent and was not applied'])
  })
})

describe('readClaudeProjectServers', () => {
  it('reads the override of the matching workspace', () => {
    const text = JSON.stringify({
      mcpServers: { shared: { command: 'user' } },
      projects: { 'C:\\Work\\App': { mcpServers: { local: { command: 'project' } } } },
    })
    const read = readClaudeProjectServers(text, 'claude.json', join('c:', 'work', 'app'))
    expect(read.servers.map(server => server.name)).toEqual(['local'])
  })

  it('matches a recorded key that differs in separators and trailing slash', () => {
    const text = JSON.stringify({ projects: { 'C:/Work/App/': { mcpServers: { local: { command: 'project' } } } } })
    expect(readClaudeProjectServers(text, 'claude.json', join('C:', 'work', 'app')).servers).toHaveLength(1)
  })

  it('reports nothing for a workspace with no override', () => {
    const text = JSON.stringify({ projects: { '/other/app': { mcpServers: { local: { command: 'x' } } } } })
    expect(readClaudeProjectServers(text, 'claude.json', join('C:', 'work', 'app'))).toEqual({ servers: [], notes: [] })
  })

  it('takes the first of two keys that normalize to the same workspace', () => {
    const text = JSON.stringify({
      projects: {
        'C:/Work/App': { mcpServers: { first: { command: 'one' } } },
        'c:/work/app/': { mcpServers: { second: { command: 'two' } } },
      },
    })
    expect(readClaudeProjectServers(text, 'claude.json', join('C:', 'work', 'app')).servers.map(server => server.name))
      .toEqual(['first'])
  })

  it('reads nothing from a document without projects', () => {
    expect(readClaudeProjectServers('{}', 'claude.json', 'C:/work')).toEqual({ servers: [], notes: [] })
  })

  it('reads nothing when projects is not an object', () => {
    expect(readClaudeProjectServers('{"projects":[]}', 'claude.json', 'C:/work')).toEqual({ servers: [], notes: [] })
  })

  it('reads nothing from a project record that is not an object', () => {
    expect(readClaudeProjectServers('{"projects":{"C:/work":"trusted"}}', 'claude.json', 'C:/work'))
      .toEqual({ servers: [], notes: [] })
  })

  it('reports a document that is not JSON', () => {
    expect(readClaudeProjectServers('{', 'claude.json', 'C:/work').notes[0]).toMatch(/^claude\.json: not valid JSON \(/)
  })
})

describe('claudeSkillRoots', () => {
  it('reads the user skill directory and the workspace directory', () => {
    expect(claudeSkillRoots(join('C:', 'home', '.claude'), join('C:', 'work'))).toEqual([
      { path: join('C:', 'home', '.claude', 'skills'), source: 'claude-code', skipDotEntries: true },
      { path: join('C:', 'work', '.claude', 'skills'), source: 'claude-code', skipDotEntries: true },
    ])
  })

  it('reads only the user skill directory without a workspace', () => {
    expect(claudeSkillRoots(join('C:', 'home', '.claude'), undefined)).toHaveLength(1)
  })
})

describe('claudeCodeAdapter', () => {
  it('reads the workspace override, the project file, and the user servers in that order', async () => {
    const userPath = join('C:', 'cfg', 'claude.json')
    const projectPath = join('C:', 'work', '.mcp.json')
    const files = {
      [userPath]: JSON.stringify({
        mcpServers: { top: { command: 'top' } },
        projects: { 'C:/work': { mcpServers: { override: { command: 'override' } } } },
      }),
      [projectPath]: JSON.stringify({ mcpServers: { project: { command: 'project' } } }),
    }
    const adapter = claudeCodeAdapter({ configPath: userPath })
    expect(adapter.source).toBe('claude-code')
    const reads = await adapter.readServers(context(files))
    expect(reads.flatMap(read => read.servers).map(server => server.name)).toEqual(['override', 'project', 'top'])
  })

  it('skips the project file when the workspace has none', async () => {
    const userPath = join('C:', 'cfg', 'claude.json')
    const files = { [userPath]: userConfig({ top: { command: 'top' } }) }
    const reads = await claudeCodeAdapter({ configPath: userPath }).readServers(context(files))
    expect(reads.flatMap(read => read.servers).map(server => server.name)).toEqual(['top'])
  })

  it('reads the default user file when no path is configured', async () => {
    const files = { [join(homedir(), '.claude.json')]: userConfig({ top: { command: 'top' } }) }
    const reads = await claudeCodeAdapter({}).readServers(context(files))
    expect(reads.flatMap(read => read.servers).map(server => server.name)).toEqual(['top'])
  })

  it('reports nothing when the user file is absent', async () => {
    expect(await claudeCodeAdapter({}).readServers(context())).toEqual([])
  })

  it('lists the user and workspace skill roots', () => {
    const roots = claudeCodeAdapter({ configDir: join('D:', 'claude') }).skillRoots(context())
    expect(roots[0]).toEqual({ path: join('D:', 'claude', 'skills'), source: 'claude-code', skipDotEntries: true })
    expect(roots[1]).toMatchObject({ path: join('C:', 'work', '.claude', 'skills') })
  })

  it('prefers CLAUDE_CONFIG_DIR over the default directory', () => {
    const roots = claudeCodeAdapter({}).skillRoots(context({}, { CLAUDE_CONFIG_DIR: join('D:', 'claude') }))
    expect(roots[0]).toMatchObject({ path: join('D:', 'claude', 'skills') })
  })

  it('falls back to the default directory without the environment override', () => {
    const roots = claudeCodeAdapter({}).skillRoots(context())
    expect(roots[0]).toMatchObject({ path: join(homedir(), '.claude', 'skills') })
  })

  it('resolves a relative config directory against the working directory', () => {
    const roots = claudeCodeAdapter({ configDir: 'relative' }).skillRoots(context())
    expect(roots[0]).toMatchObject({ path: join(process.cwd(), 'relative', 'skills') })
  })
})
