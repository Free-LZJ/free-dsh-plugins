import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as AgentImport from '../src/index.ts'
import { allocateServerName, mountForeignServers } from '../src/mcp.ts'
import type { ForeignMcpServer } from '../src/types.ts'
import { liveConfig } from './live-config.ts'

// The mount path is the only place this package hands declarations to another
// plugin, so this file replaces that plugin with a recorder and asserts the
// exact configuration each declaration produces. Isolated to this file: the
// mock must not be visible to the suites that exercise skills and readers.
const { configs, configSchema, events, failFor } = vi.hoisted(() => {
  const configs: unknown[] = []
  const events: string[] = []
  const failFor = new Set<string>()
  const configSchema = Object.assign(
    (config: unknown) => config,
    { '~standard': { version: 1, vendor: 'agent-import-test', validate: (value: unknown) => ({ value }) } },
  )
  return { configs, configSchema, events, failFor }
})

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({
  Config: configSchema,
  name: 'mcp-client',
  inject: [],
  // The repository's invariant host reads this metadata off every mounted
  // plugin, and a Vitest mock namespace throws on a property it does not
  // define, so the optional keys the real module omits are declared here.
  provide: undefined,
  intercept: undefined,
  apply: async (ctx: unknown, config: unknown) => {
    const { serverName } = config as { serverName: string }
    if (failFor.has(serverName)) throw new Error(`mock startup failure: ${serverName}`)
    configs.push(config)
    events.push(`mount:${serverName}`)
    ;(ctx as { effect: (callback: () => () => void) => void }).effect(() => () => {
      events.push(`unmount:${serverName}`)
    })
  },
}))

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  configs.splice(0)
  events.splice(0)
  failFor.clear()
})

/** Create one Codex home holding the given `config.toml`. */
async function codexHome(toml: string): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agent-import-mount-')))
  tempDirs.push(home)
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'config.toml'), toml)
  return home
}

/**
 * Mount one plugin fiber on a context of its own.
 * @param input - raw plugin configuration, resolved once by the mounting fiber.
 * @returns the mounted context.
 */
async function mount(input: Parameters<typeof AgentImport.Config>[0]): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentImport, input)
  return ctx
}

/** One normalized stdio declaration for the direct mount tests. */
function stdio(name: string, command = 'node'): ForeignMcpServer {
  return { transport: 'stdio', name, source: 'codex', origin: 'config.toml', command, args: ['a.js'], env: { TOKEN: 't' } }
}

/** One normalized remote declaration for the direct mount tests. */
function remote(name: string): ForeignMcpServer {
  return { transport: 'streamable-http', name, source: 'claude-code', origin: '.mcp.json', url: 'https://x.test/mcp', headers: { 'x-a': '1' } }
}

describe('allocateServerName', () => {
  it('keeps a name that already conforms', () => {
    expect(allocateServerName('postgres-readonly', new Set())).toBe('postgres-readonly')
  })

  it('reduces punctuation and surrounding separators to hyphens', () => {
    expect(allocateServerName('my.server name_v2', new Set())).toBe('my-server-name_v2')
    expect(allocateServerName('__edge__', new Set())).toBe('edge')
  })

  it('replaces a name with nothing usable', () => {
    expect(allocateServerName('...', new Set())).toBe('server')
    expect(allocateServerName('日本語', new Set())).toBe('server')
  })

  it('numbers repeated names in allocation order', () => {
    const used = new Set<string>()
    expect([allocateServerName('dup', used), allocateServerName('dup', used), allocateServerName('dup', used)]).toEqual(['dup', 'dup-2', 'dup-3'])
  })

  it('shortens an over-long name to a stable digest of the original', () => {
    const long = 'a'.repeat(40)
    const allocated = allocateServerName(long, new Set())
    expect(allocated).toHaveLength(32)
    expect(allocated).toMatch(/^a{25}-[0-9a-f]{6}$/)
    expect(allocateServerName(long, new Set())).toBe(allocated)
    expect(allocateServerName(`${long}b`, new Set())).not.toBe(allocated)
  })

  it('numbers an over-long name without exceeding the namespace length', () => {
    const long = 'b'.repeat(40)
    const used = new Set<string>()
    const first = allocateServerName(long, used)
    expect(allocateServerName(long, used)).toHaveLength(32)
    expect(allocateServerName(long, used)).not.toBe(first)
  })
})

describe('mountForeignServers', () => {
  it('mounts nothing when there is nothing to mount', async () => {
    const ctx = new Context()
    expect(await mountForeignServers(ctx, [], false)).toEqual([])
    expect(configs).toEqual([])
  })

  it('mounts a stdio declaration with its arguments and environment', async () => {
    const ctx = new Context()
    await mountForeignServers(ctx, [{ declaration: stdio('epctl'), serverName: 'epctl' }], true)
    expect(configs).toEqual([{
      transport: 'stdio',
      serverName: 'epctl',
      command: 'node',
      args: ['a.js'],
      env: { TOKEN: 't' },
      failOnStartupError: true,
    }])
  })

  it('mounts a remote declaration with its headers', async () => {
    const ctx = new Context()
    await mountForeignServers(ctx, [{ declaration: remote('utools'), serverName: 'utools' }], false)
    expect(configs).toEqual([{
      transport: 'streamable-http',
      serverName: 'utools',
      url: 'https://x.test/mcp',
      headers: { 'x-a': '1' },
      failOnStartupError: false,
    }])
  })

  it('mounts every planned server in order', async () => {
    const ctx = new Context()
    await mountForeignServers(ctx, [
      { declaration: stdio('one'), serverName: 'one' },
      { declaration: remote('two'), serverName: 'two' },
    ], false)
    expect(configs.map(config => (config as { serverName: string }).serverName)).toEqual(['one', 'two'])
  })

  it('unmounts the servers it already mounted when a later one fails to start', async () => {
    failFor.add('two')
    const ctx = new Context()
    await expect(mountForeignServers(ctx, [
      { declaration: stdio('one'), serverName: 'one' },
      { declaration: remote('two'), serverName: 'two' },
    ], true)).rejects.toThrow('mock startup failure: two')
    expect(events).toEqual(['mount:one', 'unmount:one'])
  })
})

describe('apply — mount planning', () => {
  it('mounts the declarations the configuration allows and reports the rest', async () => {
    const home = await codexHome([
      '[mcp_servers.epctl]',
      'command = "node"',
      'args = ["a.js"]',
      'env = { TOKEN = "t" }',
      '',
      '[mcp_servers.denied]',
      'command = "node"',
      '',
      '[mcp_servers.over-cap]',
      'command = "node"',
    ].join('\n'))
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    await ctx.plugin(AgentImport, { sources: ['codex'], codex: { home }, skills: false, serverDenyList: ['denied'], maxServers: 1 })
    expect(configs).toEqual([{
      transport: 'stdio',
      serverName: 'epctl',
      command: 'node',
      args: ['a.js'],
      env: { TOKEN: 't' },
      failOnStartupError: false,
    }])
    const messages = warn.mock.calls.map(call => String(call[0]))
    expect(messages.some(message => message.includes('"denied" skipped: listed in serverDenyList'))).toBe(true)
    expect(messages.some(message => message.includes('"over-cap" skipped: maxServers (1) reached'))).toBe(true)
  })

  it('namespaces two foreign names that reduce to the same server name', async () => {
    const home = await codexHome([
      '[mcp_servers."a.b"]',
      'command = "node"',
      '',
      '[mcp_servers."a b"]',
      'command = "node"',
    ].join('\n'))
    await mount({ sources: ['codex'], codex: { home }, skills: false })
    expect(configs.map(config => (config as { serverName: string }).serverName)).toEqual(['a-b', 'a-b-2'])
  })

  it('passes the startup-failure choice to every mount', async () => {
    const home = await codexHome('[mcp_servers.remote]\ntype = "http"\nurl = "https://x.test/mcp"\nhttp_headers = { "x-a" = "1" }')
    await mount({ sources: ['codex'], codex: { home }, skills: false, failOnStartupError: true })
    expect(configs).toEqual([{
      transport: 'streamable-http',
      serverName: 'remote',
      url: 'https://x.test/mcp',
      headers: { 'x-a': '1' },
      failOnStartupError: true,
    }])
  })

  it('mounts through the Claude Code adapter when it is selected', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'agent-import-claude-')))
    tempDirs.push(dir)
    const configPath = join(dir, 'claude.json')
    await writeFile(configPath, JSON.stringify({ mcpServers: { utools: { type: 'http', url: 'http://127.0.0.1:3501/mcp' } } }))
    await mount({ sources: ['claude-code'], claudeCode: { configDir: dir, configPath }, projectRoot: dir, skills: false })
    expect(configs).toEqual([{
      transport: 'streamable-http',
      serverName: 'utools',
      url: 'http://127.0.0.1:3501/mcp',
      headers: {},
      failOnStartupError: false,
    }])
  })

  it('reports a declaration file it cannot read instead of failing activation', async () => {
    const home = await codexHome('[mcp_servers.a]\ncommand = "node"')
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    await ctx.plugin(AgentImport, { sources: ['codex'], codex: { home, configPath: home }, skills: false })
    expect(configs).toEqual([])
    expect(warn.mock.calls.map(call => String(call[0])).some(message => message.includes('cannot read'))).toBe(true)
  })
})

describe('apply — live mount changes', () => {
  it('replaces the whole mount generation after a live configuration change', async () => {
    const home = await codexHome([
      '[mcp_servers.keep]',
      'command = "node"',
      '',
      '[mcp_servers.drop]',
      'command = "node"',
    ].join('\n'))
    const ctx = new Context()
    const live = await liveConfig(ctx, AgentImport, { sources: ['codex'], codex: { home }, skills: false })
    expect(events).toEqual(['mount:keep', 'mount:drop'])
    await live.update({ serverDenyList: ['drop'] })
    await vi.waitFor(() => {
      expect(events).toEqual(['mount:keep', 'mount:drop', 'unmount:keep', 'unmount:drop', 'mount:keep'])
    })
    await live.update({ mcp: false })
    await vi.waitFor(() => {
      expect(events).toEqual(['mount:keep', 'mount:drop', 'unmount:keep', 'unmount:drop', 'mount:keep', 'unmount:keep'])
    })
  })

  it('rolls back a partially mounted generation, reports it, and recovers on the next change', async () => {
    const home = await codexHome([
      '[mcp_servers.first]',
      'command = "node"',
      '',
      '[mcp_servers.second]',
      'command = "node"',
    ].join('\n'))
    const ctx = new Context()
    const error = vi.spyOn(ctx.logger, 'error')
    const live = await liveConfig(ctx, AgentImport, { sources: ['codex'], codex: { home }, skills: false })
    expect(events).toEqual(['mount:first', 'mount:second'])
    failFor.add('second')
    await live.update({ maxServers: 5 })
    await vi.waitFor(() => {
      expect(events).toEqual([
        'mount:first', 'mount:second',
        'unmount:first', 'unmount:second',
        'mount:first', 'unmount:first',
      ])
    })
    expect(error.mock.calls.map(call => String(call[0])).some(message => message.includes('re-import after a configuration change failed'))).toBe(true)
    failFor.delete('second')
    await live.update({ maxServers: 6 })
    await vi.waitFor(() => { expect(events.slice(-2)).toEqual(['mount:first', 'mount:second']) })
  })
})
