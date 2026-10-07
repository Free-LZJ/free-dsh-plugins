<div align="center">

# free-dsh-plugins

**Brings the MCP servers and skills Codex or Claude Code already declares into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).**

[![CI](https://github.com/Free-LZJ/free-dsh-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/Free-LZJ/free-dsh-plugins/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@free-lzj/dsh-agent-import.svg)](https://www.npmjs.com/package/@free-lzj/dsh-agent-import)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](LICENSE)
[![dsh plugin](https://img.shields.io/badge/dsh-plugin-4f46e5.svg)](packages/agent-import/README.md)

[中文](README.md) · [npm](https://www.npmjs.com/package/@free-lzj/dsh-agent-import) · [Package docs](packages/agent-import/README.md) · [Example overlay](examples/agent-import.cordis.yml)

</div>

---

> When one machine runs both dsh and Codex or Claude Code, each MCP server and skill needs to be declared only once. On activation this plugin reads the other tool's declarations, mounts them through dsh's own `mcp-client` and skill catalog, and adds a page to dsh's Settings page that shows what the import actually mounted and which parts of it to read.

## What is in here

| Package | In one line |
|---|---|
| [`@free-lzj/dsh-agent-import`](packages/agent-import/README.md) | Host plugin + browser half (a dual-face package): the Host half imports and mounts, the browser half renders the Settings page |

One package, one Loader row: the two halves merged in `0.3.0`; they used to be two packages and two rows (see [Upgrading from 0.2.x](#upgrading-from-02x)).

## What it does

| Capability | Detail |
|---|---|
| **MCP servers** | `[mcp_servers.*]` (Codex `config.toml`) and `mcpServers` (Claude Code `~/.claude.json`, project `.mcp.json`) mount through dsh's `mcp-client` as `mcp__<server>__<tool>` tools |
| **Skills** | Both tools' `skills/` directories join the skill catalog as one provider, where a same-named dsh skill wins |
| **One bad entry costs nothing** | A declaration the plugin cannot translate becomes one `agent-import: …` warning and is skipped; the rest still imports |
| **Live configuration** | The plugin's own configuration is live: saving on the Settings page re-imports immediately, with no restart |
| **One page that states the result** | The page has two tabs, **Loaded** and **Configuration**: Loaded tabulates the MCP servers this import mounted (status, command or URL, skip reason) and the skills it published (source, instruction file) with a **Refresh** button, while Configuration holds every setting |
| **Minimal exposure** | The report carries names and locations only: a server's arguments, environment, and headers never appear in it |

## Install

One package is enough: its Host half serves the settings namespace and its browser half renders that Settings page — the page attaches to whichever Loader row declares `dsh.client`, so it always follows the Host.

> **Requirements**: `@deepseek-ai/cordis ^4.0.3`, plus `@deepseek-ai/dsh-mcp-client` / `@deepseek-ai/dsh-skill` `>=0.1.7-alpha.2 <0.3.0-0` — peers the dsh runtime provides; the range covers the 0.1.x and 0.2.x runtimes from 0.1.7 on, including the one the Desktop app bundles. The page itself appears wherever a settings shell exists; only its Loaded section reads `/agent-import/report`, so that section needs the composition's `ctx.webServer` (dsh Web and Desktop both have one).

> **Why a Settings page, not the Plugins page's Official group.** The browser half registers the Settings page's `settings.section` entry, beside `general` / `models` / `account` / `plugins`. The Plugins page's `plugins.item` slot is by contract the official settings-card seat (its official occupants are `agent-loop` / `shell` / `subagent` / `web-search`); a third-party plugin's own configuration page uses `settings.section`, or `settings.plugins.tab` inside the Plugins section.

### 1. Install the package

```sh
dsh plugin --profile web add @free-lzj/dsh-agent-import
```

<details>
<summary>From this checkout (only when working on the plugin itself)</summary>

```sh
pnpm install
pnpm run build

dsh plugin --profile web add "<absolute path>/packages/agent-import"
# or run pnpm pack first and install the .tgz file
```

</details>

### Desktop (Electron)

The Desktop app is not a different client: it runs the same `dsh-web-app` composition with a **bundled** dsh runtime of its own, and serves the page through the Host's own `ctx.webServer` on a local port — so both halves work there too. The difference is the **profile: `desktop`**, not `web`:

```sh
dsh plugin --profile desktop add @free-lzj/dsh-agent-import
```

> The version the Desktop bundles is usually **not** the one your global CLI runs. If it falls outside this package's peer range, dsh's compatibility preflight disables the row outright (stderr prints `dsh: disabling profile plugin row "agent-import": …`), and neither the plugin nor its Settings page appears. Two ways out: install a version whose peer range covers that runtime, or grant the exact-version exemption — `dsh plugin --profile desktop allow-version <package@version> --dsh-version <runtime version> --accept-risk` (the Desktop Plugins page offers the same grant for incompatible entries).

### 2. Declare the one row (required)

Installing only makes the package resolvable; the feature is enabled by declaring this row in the profile. Put it in `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (`web`, `desktop`, …), or boot with an overlay:

```yaml
- insert:
    - id: agent-import
      name: '@free-lzj/dsh-agent-import'
```

```sh
dsh web --patch examples/agent-import.cordis.yml
```

> **The id `agent-import` is fixed.** dsh names a row's settings namespace after the row's own entry id, and the Settings page follows that namespace; a different id is a different namespace, and the page never appears.

### 3. Take effect

Host code is JS loaded at boot, so a change to it needs a `dsh web` restart; the browser half (`lib/client.js`) needs a page refresh.

### Upgrading from 0.2.x

0.2.x was two packages and two Loader rows (`@free-lzj/dsh-agent-import` plus `@free-lzj/dsh-client-ui-settings-agent-import`). 0.3.0 merges them into one package and stops publishing the companion:

```sh
dsh plugin --profile web remove @free-lzj/dsh-client-ui-settings-agent-import
dsh plugin --profile web add @free-lzj/dsh-agent-import
```

Then drop the `ui-settings-agent-import` row from the profile, leaving only `id: agent-import` (as in the example above), and restart `dsh web`. The page comes from the package's own `dsh.client` declaration and needs no row of its own.

## Configuration

The Settings page covers every field; the equivalent row configuration is:

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

The Host plugin publishes the current import on `GET /agent-import/report`, and its Loaded section reads it with a same-origin `fetch`. That route sits beside dsh's own pages but outside the API gateway's session check, so it answers **same-origin** requests only (`Sec-Fetch-Site` other than `same-origin`/`none`, or an `Origin` naming another host, is refused with 403; anything but GET/HEAD with 405), and it carries names and locations only: a server's arguments, environment, and headers never appear.

The skill list is enumerated **per request**, not captured at activation, so adding or removing a skill in Codex or Claude Code shows up on the next **Refresh**; the server rows describe the current import generation.

## Development

```sh
pnpm install
pnpm run typecheck   # one package, both halves
pnpm run build       # tsc for types, tsdown for lib/index.js (Node half) and lib/client.js (browser half)
pnpm run test        # vitest: 16 spec files / 250 tests
```

Build before testing: [`tests/package-faces.client.spec.ts`](packages/agent-import/tests/package-faces.client.spec.ts) checks the **artifacts** (registration id, the `dsh.client` declaration, `exports["./client"]`, and that nothing in the browser entry takes a value from the Host half), and one of its cases reports as skipped without `lib/`.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on `windows-latest`: the adapter specs assert Windows drive-letter path handling (`C:`, `D:` fixtures for Codex and Claude Code homes), which Linux reads as relative paths.

The browser-half specs need the dsh client packages' Node halves and their module table; [`vitest.config.ts`](vitest.config.ts) and [`packages/agent-import/tests/support/`](packages/agent-import/tests/support) document those two seams (see "How the specs get dsh's client code" in the package README).

### Releasing

```sh
cd packages/agent-import
npm publish      # prepublishOnly builds first; publishConfig carries access: public
```

- The version lives in [`packages/agent-import/package.json`](packages/agent-import/package.json); a version npm already has cannot be published again.
- With auth-and-writes 2FA on the account, `npm publish` needs an OTP — or a **granular access token with "Bypass 2FA" enabled**; an ordinary token fails with `403 … bypass 2fa enabled is required`.
- The npm package page renders the README from the tarball, so a README edit after a release reaches npm only with a new version.

## Known limitations

- The package does not ship in the installed dsh Web composition; a deployment declares the row above.
- The Loaded section reads dsh Web's own HTTP route, so it needs a composition with `ctx.webServer`. dsh Web and the Electron Desktop both have one (the Desktop page is served by the Host's own `ctx.webServer` on a local port); in a composition without `ctx.webServer` the section reports itself unavailable while the rest of the configuration still works.
- dsh runs a compatibility preflight at startup: a plugin whose peer range excludes the running runtime has its row **disabled outright** (stderr prints `dsh: disabling profile plugin row …`), and **the Settings page then never appears at all**, which reads as "the install did nothing". Grant the exact-version exemption to admit it: `dsh plugin --profile <profile> allow-version <package@version> --dsh-version <runtime version> --accept-risk`. This package's peer range covers the 0.1.x and 0.2.x runtimes; anything later needs a wider range or a grant.
- The Loaded section answers "did it mount": a server that mounted but cannot connect is logged by dsh's own `mcp-client` (which keeps reconnecting while `failOnStartupError` is `false`), and its row still reads **Mounted**.
- Foreign files are read at activation only (this plugin's own configuration excepted): editing a Codex or Claude Code declaration takes effect after a reload or restart.
- Neither tool's plugin marketplaces are expanded (for example Codex `plugin.json`); only server declarations and skill directories are imported.
- The real-composition end-to-end test (boot a shipped profile, assert the imported tools and skills are model-visible) runs in the dsh monorepo, because it depends on that repository's own profile-boot fixture. This repository's CI runs typecheck, build, and the unit/component suites.

## License

[MIT](LICENSE)
