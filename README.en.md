# free-dsh-plugins

My collection of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugins.

| Package | Role |
|---|---|
| [`@free-lzj/dsh-agent-import`](packages/agent-import/README.md) | **Host plugin + browser card**: reads the MCP servers and skills a Codex or Claude Code installation already declares and mounts them through dsh's own MCP client and skill catalog; the same package also declares `dsh.client`, which registers the **Agent import** card in the dsh Web Plugins page to read and write its own configuration |

One package, one Loader row: the two halves merged in `0.3.0`; they used to be two packages and two rows (see "Upgrading from 0.2.x" below).

中文: [README.md](README.md)

## What the plugin does

If this machine already runs Codex or Claude Code, neither tool's MCP servers nor skills have to be copied into dsh:

- `[mcp_servers.*]` (Codex `config.toml`) and `mcpServers` (Claude Code `~/.claude.json`, project `.mcp.json`) mount through dsh's `mcp-client` as `mcp__<server>__<tool>` tools;
- both tools' `skills/` directories join the skill catalog as one provider, where a same-named dsh skill wins;
- a declaration the plugin cannot translate becomes one `agent-import: …` warning and is skipped, so one unusable entry never costs the rest;
- the plugin's own configuration is live: saving on the Plugins page re-imports immediately, with no restart;
- the card has two tabs, **Loaded** and **Configuration**: Loaded tabulates the MCP servers this import mounted (status, command or URL, skip reason) and the skills it published (source, instruction file) with a **Refresh** button, while Configuration holds every setting.

## Install

One package is enough: its Host half serves the settings namespace and its browser half renders the card — the card attaches to whichever Loader row declares `dsh.client`, so it always follows the Host.

### From npm (once published)

```sh
dsh plugin --profile web add @free-lzj/dsh-agent-import
```

### From this checkout (before publication)

```sh
pnpm install
pnpm run build

dsh plugin --profile web add "<absolute path>/packages/agent-import"
# or run pnpm pack first and install the .tgz file
```

### Declare the one row (required)

Installing only makes the package resolvable; the feature is enabled by declaring this row in your profile. Put it in `$DSH_HOME/profiles/web/cordis.patch.yml`, or boot with an overlay:

```yaml
- insert:
    - id: agent-import
      name: '@free-lzj/dsh-agent-import'
```

```sh
dsh web --patch examples/agent-import.cordis.yml
```

The id `agent-import` is fixed: dsh names a row's settings namespace after the row's own entry id, and the Plugins-page card follows that namespace.

### Upgrading from 0.2.x

0.2.x was two packages and two Loader rows (`@free-lzj/dsh-agent-import` plus
`@free-lzj/dsh-client-ui-settings-agent-import`). 0.3.0 merges them into one package and stops publishing the companion:

```sh
dsh plugin --profile web remove @free-lzj/dsh-client-ui-settings-agent-import
dsh plugin --profile web add @free-lzj/dsh-agent-import
```

Then drop the `ui-settings-agent-import` row from your profile, leaving only `id: agent-import` (as in the example above), and restart `dsh web`. The card comes from the package's own `dsh.client` declaration and needs no row of its own.

## Configuration

The Plugins-page card covers every field; the equivalent row configuration is:

```yaml
- id: agent-import
  name: '@free-lzj/dsh-agent-import'
  config:
    sources: ['codex', 'claude-code']
    serverDenyList: ['node_repl']
```

| Field | Default | Meaning |
|---|---|---|
| `sources` | `['codex', 'claude-code']` | Tools to read, in precedence order |
| `codex.home` | `$CODEX_HOME`, else `~/.codex` | Codex home holding `config.toml` and `skills/` |
| `codex.configPath` | `<home>/config.toml` | Codex configuration file to read |
| `codex.includeSystemSkills` | `false` | Also publish Codex's own `skills/.system` bundles |
| `claudeCode.configDir` | `$CLAUDE_CONFIG_DIR`, else `~/.claude` | Claude Code directory holding `skills/` |
| `claudeCode.configPath` | `~/.claude.json` | Claude Code user configuration holding user-scope servers and workspace overrides |
| `projectRoot` | empty, meaning the process working directory | Workspace whose project-local servers and Claude skill directory are read |
| `mcp` | `true` | Mount the imported MCP servers |
| `skills` | `true` | Publish the imported skills |
| `serverDenyList` | `[]` | Foreign server names to leave unmounted, matched against the declaring tool's own name |
| `maxServers` | `64` | Maximum imported servers to mount |
| `maxSkills` | `200` | Maximum imported skills to publish |
| `failOnStartupError` | `false` | Reject plugin activation when one imported server fails to start |

## Where the Loaded section comes from

The Host plugin publishes the current import on `GET /agent-import/report`, and the card reads it with a same-origin `fetch`. That route sits beside dsh's own pages but outside the API gateway's session check, so it answers **same-origin** requests only (`Sec-Fetch-Site` other than `same-origin`/`none`, or an `Origin` naming another host, is refused with 403; anything but GET/HEAD with 405), and it carries names and locations only: a server's arguments, environment, and headers never appear.

The skill list is enumerated **per request**, not captured at activation, so adding or removing a skill in Codex or Claude Code shows up on the next **Refresh**; the server rows describe the current import generation.

Host code is JS loaded at boot, so a change to it needs a `dsh web` restart; the browser half (`lib/client.js`) needs a page refresh.

## Development

```sh
pnpm install
pnpm run typecheck   # one package, both halves
pnpm run build       # tsc for types, tsdown for lib/index.js (Node half) and lib/client.js (browser half)
pnpm run test        # vitest: 16 spec files / 250 tests
```

Build before testing: `tests/package-faces.client.spec.ts` checks the **artifacts** (registration id, the `dsh.client` declaration, `exports["./client"]`, and that nothing in the browser entry takes a value from the Host half), and one of its cases reports as skipped without `lib/`.

## Known limitations

- The package does not ship in the installed dsh Web composition; a deployment declares the row above.
- The Plugins-page card reads the import report over dsh Web's own HTTP routes: the Electron desktop loads a `file://` page with no `ctx.webServer`, so that section is absent there (the rest of the card still works). Desktop parity needs a Remote namespace in dsh's own `packages/api/remotes`.
- The Loaded section answers "did it mount": a server that mounted but cannot connect is logged by dsh's own `mcp-client` (which keeps reconnecting while `failOnStartupError` is `false`), and its row still reads **Mounted**.
- Foreign files are read at activation only (this plugin's own configuration excepted): editing a Codex or Claude Code declaration takes effect after a reload or restart.
- Neither tool's plugin marketplaces are expanded (for example Codex `plugin.json`); only server declarations and skill directories are imported.
- The real-composition end-to-end test (boot a shipped profile, assert the imported tools and skills are model-visible) runs in the dsh monorepo, because it depends on that repository's own profile-boot fixture. This repository's CI runs typecheck, build, and the unit/component suites.

## License

[MIT](LICENSE)
