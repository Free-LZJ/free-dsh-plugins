# free-dsh-plugins

My collection of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugins.

| Package | Role |
|---|---|
| [`@free-lzj/dsh-agent-import`](packages/agent-import/README.md) | **Host plugin**: reads the MCP servers and skills a Codex or Claude Code installation already declares and mounts them through dsh's own MCP client and skill catalog |
| [`@free-lzj/dsh-client-ui-settings-agent-import`](packages/ui-settings-agent-import/README.md) | **Browser companion**: registers the **Agent import** card in the dsh Web Plugins page, which reads and writes that plugin's configuration live |

中文: [README.md](README.md)

## What the plugin does

If this machine already runs Codex or Claude Code, neither tool's MCP servers nor skills have to be copied into dsh:

- `[mcp_servers.*]` (Codex `config.toml`) and `mcpServers` (Claude Code `~/.claude.json`, project `.mcp.json`) mount through dsh's `mcp-client` as `mcp__<server>__<tool>` tools;
- both tools' `skills/` directories join the skill catalog as one provider, where a same-named dsh skill wins;
- a declaration the plugin cannot translate becomes one `agent-import: …` warning and is skipped, so one unusable entry never costs the rest;
- the plugin's own configuration is live: saving on the Plugins page re-imports immediately, with no restart.

## Install

Both packages are needed: the Host plugin serves the settings namespace, the companion renders the card.

### From npm (once published)

```sh
dsh plugin --profile web add @free-lzj/dsh-agent-import @free-lzj/dsh-client-ui-settings-agent-import
```

### From this checkout (before publication)

```sh
pnpm install
pnpm run build

dsh plugin --profile web add "<absolute path>/packages/agent-import" "<absolute path>/packages/ui-settings-agent-import"
# or run pnpm pack first and install the .tgz files
```

### Declare the two rows (required)

Installing only makes the packages resolvable; the feature is enabled by declaring both rows in your profile. Put them in `$DSH_HOME/profiles/web/cordis.patch.yml`, or boot with an overlay:

```yaml
- insert:
    - id: agent-import
      name: '@free-lzj/dsh-agent-import'

    - id: ui-settings-agent-import
      name: '@free-lzj/dsh-client-ui-settings-agent-import'
```

```sh
dsh web --patch examples/agent-import.cordis.yml
```

The id `agent-import` is fixed: dsh names a row's settings namespace after the row's own entry id, and the Plugins-page card follows that namespace.

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

## Development

```sh
pnpm install
pnpm run typecheck   # both packages
pnpm run build       # tsc for types, tsdown for lib/index.js and lib/client.js
pnpm run test        # vitest
```

## Known limitations

- Neither package ships in the installed dsh Web composition; a deployment declares the two rows above.
- The Plugins-page card does not list the servers and skills it recognized: that needs a Remote namespace in dsh's own `packages/api/remotes`. Today they surface through the tool registry, the skill catalog, and the `agent-import: …` log lines.
- Foreign files are read at activation only (this plugin's own configuration excepted): editing a Codex or Claude Code declaration takes effect after a reload or restart.
- Neither tool's plugin marketplaces are expanded (for example Codex `plugin.json`); only server declarations and skill directories are imported.
- The real-composition end-to-end test (boot a shipped profile, assert the imported tools and skills are model-visible) runs in the dsh monorepo, because it depends on that repository's own profile-boot fixture. This repository's CI runs typecheck, build, and the unit/component suites.

## License

[MIT](LICENSE)
