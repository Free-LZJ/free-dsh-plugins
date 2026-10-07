import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexAdapter, readCodexServers } from '../src/adapters/codex.ts'
import type { AdapterContext } from '../src/adapter.ts'

/** Adapter inputs backed by an in-memory file map. */
function context(files: Record<string, string> = {}, env: Record<string, string | undefined> = {}): AdapterContext {
  return { projectRoot: join('C:', 'work'), env, readOptional: async path => files[path] }
}

describe('readCodexServers — stdio declarations', () => {
  it('reads a literal Windows command path and its arguments', () => {
    const text = [
      '[mcp_servers.epctl]',
      "type = 'stdio'",
      String.raw`command = 'C:\tools\epaasctl.exe'`,
      String.raw`args = ['serve', 'C:\data\app.json']`,
    ].join('\n')
    const read = readCodexServers(text, 'config.toml', {})
    expect(read.servers).toEqual([{
      transport: 'stdio',
      name: 'epctl',
      source: 'codex',
      origin: 'config.toml',
      command: String.raw`C:\tools\epaasctl.exe`,
      args: ['serve', String.raw`C:\data\app.json`],
      env: {},
    }])
    expect(read.notes).toEqual([])
  })

  it('treats a declaration without a type as stdio', () => {
    const read = readCodexServers('[mcp_servers.a]\ncommand = "node"\nargs = ["x.js"]', 'config.toml', {})
    expect(read.servers[0]).toMatchObject({ transport: 'stdio', command: 'node', args: ['x.js'] })
  })

  it('accepts a declaration without arguments', () => {
    const read = readCodexServers('[mcp_servers.a]\ncommand = "node"', 'config.toml', {})
    expect(read.servers[0]).toMatchObject({ transport: 'stdio', args: [] })
  })

  it('reads inline environment entries and lets them win over inherited variables', () => {
    const text = '[mcp_servers.a]\ncommand = "node"\nenv = { TOKEN = "inline" }\nenv_vars = ["TOKEN", "MISSING"]'
    const read = readCodexServers(text, 'config.toml', { TOKEN: 'inherited', MISSING: undefined })
    expect(read.servers[0]).toMatchObject({ env: { TOKEN: 'inline' } })
    expect(read.notes).toEqual([])
  })

  it('reads an environment sub-table', () => {
    const text = '[mcp_servers.a]\ncommand = "node"\n[mcp_servers.a.env]\nREGION = "cn-hangzhou"'
    const read = readCodexServers(text, 'config.toml', {})
    expect(read.servers[0]).toMatchObject({ env: { REGION: 'cn-hangzhou' } })
  })

  it('inherits only the named variables the process defines', () => {
    const text = '[mcp_servers.a]\ncommand = "node"\nenv_vars = ["SET", "UNSET"]'
    const read = readCodexServers(text, 'config.toml', { SET: 'yes' })
    expect(read.servers[0]).toMatchObject({ env: { SET: 'yes' } })
  })
})

describe('readCodexServers — remote declarations', () => {
  it('reads a streamable HTTP server with inline headers', () => {
    const text = [
      '[mcp_servers.remote]',
      'type = "streamable-http"',
      'url = "https://example.test/mcp"',
      'http_headers = { "x-actor" = "key" }',
    ].join('\n')
    const read = readCodexServers(text, 'config.toml', {})
    expect(read.servers).toEqual([{
      transport: 'streamable-http',
      name: 'remote',
      source: 'codex',
      origin: 'config.toml',
      url: 'https://example.test/mcp',
      headers: { 'x-actor': 'key' },
    }])
  })

  it('reads a header sub-table and resolves a bearer token from the environment', () => {
    const text = [
      '[mcp_servers.remote]',
      'type = "http"',
      'url = "https://example.test/mcp"',
      'bearer_token_env_var = "REMOTE_TOKEN"',
      '[mcp_servers.remote.http_headers]',
      'x-extra = "1"',
    ].join('\n')
    const read = readCodexServers(text, 'config.toml', { REMOTE_TOKEN: 'secret' })
    expect(read.servers[0]).toMatchObject({
      transport: 'streamable-http',
      headers: { 'x-extra': '1', Authorization: 'Bearer secret' },
    })
  })

  it('skips a server whose bearer token variable is not set', () => {
    const text = '[mcp_servers.remote]\ntype = "http"\nurl = "https://x.test"\nbearer_token_env_var = "ABSENT"'
    const read = readCodexServers(text, 'config.toml', {})
    expect(read.servers).toEqual([])
    expect(read.notes).toEqual(['config.toml: server "remote" skipped: bearer_token_env_var "ABSENT" is not set in the environment'])
  })
})

describe('readCodexServers — unusable declarations', () => {
  it('skips an unsupported transport', () => {
    const read = readCodexServers('[mcp_servers.a]\ntype = "sse"\ncommand = "node"', 'config.toml', {})
    expect(read.notes).toEqual(['config.toml: server "a" skipped: unsupported transport "sse"'])
  })

  it('skips a stdio server without a command', () => {
    const read = readCodexServers('[mcp_servers.a]\nargs = ["x"]', 'config.toml', {})
    expect(read.notes).toEqual(['config.toml: server "a" skipped: missing "command"'])
  })

  it('skips a server whose arguments are not a string array', () => {
    expect(readCodexServers('[mcp_servers.a]\ncommand = "node"\nargs = "x"', 'config.toml', {}).notes)
      .toEqual(['config.toml: server "a" skipped: "args" must be an array of strings'])
  })

  it('skips a server whose argument array holds a non-string', () => {
    expect(readCodexServers('[mcp_servers.a]\ncommand = "node"\nargs = ["x", 2]', 'config.toml', {}).notes)
      .toEqual(['config.toml: server "a" skipped: "args" must be an array of strings'])
  })

  it('skips a server whose inline environment is not a table', () => {
    expect(readCodexServers('[mcp_servers.a]\ncommand = "node"\nenv = "x"', 'config.toml', {}).notes)
      .toEqual(['config.toml: server "a" skipped: "env" must be a table'])
  })

  it('skips a server whose environment value is not a string', () => {
    expect(readCodexServers('[mcp_servers.a]\ncommand = "node"\nenv = { PORT = 1 }', 'config.toml', {}).notes)
      .toEqual(['config.toml: server "a" skipped: env.PORT must be a string'])
  })

  it('skips a server whose environment sub-table holds a non-string', () => {
    const text = '[mcp_servers.a]\ncommand = "node"\n[mcp_servers.a.env]\nPORT = 1'
    expect(readCodexServers(text, 'config.toml', {}).notes)
      .toEqual(['config.toml: server "a" skipped: env.PORT must be a string'])
  })

  it('skips a server whose inherited variables are not a string array', () => {
    expect(readCodexServers('[mcp_servers.a]\ncommand = "node"\nenv_vars = "TOKEN"', 'config.toml', {}).notes)
      .toEqual(['config.toml: server "a" skipped: "env_vars" must be an array of strings'])
  })

  it('skips a server whose bearer variable is not a non-empty string', () => {
    const text = '[mcp_servers.a]\ntype = "http"\nurl = "https://x.test"\nbearer_token_env_var = ""'
    expect(readCodexServers(text, 'config.toml', {}).notes)
      .toEqual(['config.toml: server "a" skipped: "bearer_token_env_var" must be a non-empty string'])
  })

  it('skips a remote server without a url', () => {
    expect(readCodexServers('[mcp_servers.a]\ntype = "http"', 'config.toml', {}).notes)
      .toEqual(['config.toml: server "a" skipped: missing "url"'])
  })

  it('skips a remote server whose headers are not a table', () => {
    const text = '[mcp_servers.a]\ntype = "http"\nurl = "https://x.test"\nhttp_headers = "x"'
    expect(readCodexServers(text, 'config.toml', {}).notes)
      .toEqual(['config.toml: server "a" skipped: "http_headers" must be a table'])
  })

  it('skips a remote server whose header value is not a string', () => {
    const text = '[mcp_servers.a]\ntype = "http"\nurl = "https://x.test"\nhttp_headers = { x = 1 }'
    expect(readCodexServers(text, 'config.toml', {}).notes)
      .toEqual(['config.toml: server "a" skipped: http_headers.x must be a string'])
  })

  it('skips a remote server whose header sub-table holds a non-string', () => {
    const text = '[mcp_servers.a]\ntype = "http"\nurl = "https://x.test"\n[mcp_servers.a.http_headers]\nx = 1'
    expect(readCodexServers(text, 'config.toml', {}).notes)
      .toEqual(['config.toml: server "a" skipped: http_headers.x must be a string'])
  })

  it('reports an empty type as stdio rather than an unsupported transport', () => {
    const read = readCodexServers('[mcp_servers.a]\ntype = ""\ncommand = "node"', 'config.toml', {})
    expect(read.servers[0]).toMatchObject({ transport: 'stdio' })
  })
})

describe('readCodexServers — keys this package does not apply', () => {
  it('reports unknown keys and startup_timeout_sec', () => {
    const text = '[mcp_servers.a]\ncommand = "node"\nstartup_timeout_sec = 120\nunknown_key = 1'
    const read = readCodexServers(text, 'config.toml', {})
    expect(read.servers).toHaveLength(1)
    expect(read.notes).toEqual([
      'config.toml: server "a" ignored unsupported keys: unknown_key',
      'config.toml: server "a" startup_timeout_sec has no dsh equivalent and was not applied',
    ])
  })

  it('reads nothing from a document without an mcp_servers table', () => {
    expect(readCodexServers('model = "gpt"\n[other]\nkey = 1', 'config.toml', {})).toEqual({ servers: [], notes: [] })
  })

  it('ignores the bare mcp_servers header and unrelated sub-tables', () => {
    const text = '[mcp_servers]\n[mcp_servers.a.other]\nkey = 1\n[mcp_servers.a]\ncommand = "node"'
    const read = readCodexServers(text, 'config.toml', {})
    expect(read.servers.map(server => server.name)).toEqual(['a'])
  })

  it('keeps the last declaration of a repeated server name', () => {
    const text = '[mcp_servers.a]\ncommand = "one"\n[mcp_servers.a]\ncommand = "two"'
    const read = readCodexServers(text, 'config.toml', {})
    expect(read.servers.map(server => server.transport === 'stdio' ? server.command : '')).toEqual(['two'])
  })

  it('reports an unreadable statement and still reads the servers around it', () => {
    const text = '[mcp_servers.a]\ncommand = "node"\n= broken\n[mcp_servers.b]\ncommand = "node"'
    const read = readCodexServers(text, 'config.toml', {})
    expect(read.servers.map(server => server.name)).toEqual(['a', 'b'])
    expect(read.notes).toEqual(['config.toml: unreadable statement "= broken"'])
  })
})

describe('codexAdapter', () => {
  it('reads the configured configuration file', async () => {
    const files = { [join('C:', 'cfg', 'config.toml')]: '[mcp_servers.a]\ncommand = "node"' }
    const adapter = codexAdapter({ home: join('C:', 'cfg'), configPath: join('C:', 'cfg', 'config.toml') })
    expect(adapter.source).toBe('codex')
    const reads = await adapter.readServers(context(files))
    expect(reads.flatMap(read => read.servers).map(server => server.name)).toEqual(['a'])
  })

  it('reads the configuration file of the configured home', async () => {
    const files = { [join('C:', 'cfg', 'config.toml')]: '[mcp_servers.b]\ncommand = "node"' }
    const reads = await codexAdapter({ home: join('C:', 'cfg') }).readServers(context(files))
    expect(reads.flatMap(read => read.servers).map(server => server.name)).toEqual(['b'])
  })

  it('prefers CODEX_HOME over the default home', async () => {
    const files = { [join('D:', 'codex', 'config.toml')]: '[mcp_servers.c]\ncommand = "node"' }
    const reads = await codexAdapter({}).readServers(context(files, { CODEX_HOME: join('D:', 'codex') }))
    expect(reads.flatMap(read => read.servers).map(server => server.name)).toEqual(['c'])
  })

  it('reads the default home when neither the option nor the environment names one', async () => {
    const files = { [join(homedir(), '.codex', 'config.toml')]: '[mcp_servers.d]\ncommand = "node"' }
    const reads = await codexAdapter({}).readServers(context(files))
    expect(reads.flatMap(read => read.servers).map(server => server.name)).toEqual(['d'])
  })

  it('reports nothing when the configuration file is absent', async () => {
    expect(await codexAdapter({ home: join('C:', 'cfg') }).readServers(context())).toEqual([])
  })

  it('resolves a relative home against the working directory', async () => {
    const files = { [join(process.cwd(), 'relative', 'config.toml')]: '[mcp_servers.e]\ncommand = "node"' }
    const reads = await codexAdapter({ home: 'relative' }).readServers(context(files))
    expect(reads.flatMap(read => read.servers).map(server => server.name)).toEqual(['e'])
  })
})
