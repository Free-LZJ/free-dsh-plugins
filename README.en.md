<div align="center">

# free-dsh-plugins

**A set of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugins: every package is a dual-face one — a Host half plus a browser half — so one install and one Loader row add one feature to dsh.**

[![CI](https://github.com/Free-LZJ/free-dsh-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/Free-LZJ/free-dsh-plugins/actions/workflows/ci.yml)
[![npm: agent-import](https://img.shields.io/npm/v/@free-lzj/dsh-agent-import.svg?label=agent-import)](https://www.npmjs.com/package/@free-lzj/dsh-agent-import)
[![npm: mail](https://img.shields.io/npm/v/@free-lzj/dsh-mail.svg?label=mail)](https://www.npmjs.com/package/@free-lzj/dsh-mail)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](LICENSE)

[中文](README.md) · [Packages](#packages) · [Development](#development-in-this-repository) · [Example overlay](examples/agent-import.cordis.yml)

</div>

---

## Packages

| Package | Version | What it adds to dsh |
|---|---|---|
| [`@free-lzj/dsh-agent-import`](packages/agent-import/README.md) | `0.3.2` | Mounts the MCP servers Codex / Claude Code already declare, and manages every agent tool's skills by **linking** them into dsh's own skills directory; the same package ships the Settings page that configures both |
| [`@free-lzj/dsh-mail`](packages/mail/README.md) | `0.1.0` | A sidebar mail panel: read / search / flag / move / delete (**no sending**), and a new message that opens an agent session, lands in one you already have, or just lights up the panel |

Each package's install steps, configuration fields, panel details and known limitations live in its own README (linked above). What follows is what both packages share, and how this repository itself is developed.

## Every package is a dual-face one

Both halves come out of **one build** and ride **one Loader row**, attached by the package's own `dsh.client` declaration:

| Half | Artifact | Where it runs |
|---|---|---|
| **Host** | `lib/index.js` (ESM) | The Node process: the plugin body the Loader row mounts — long-lived connections, routes, and the settings namespace |
| **Browser** | `lib/client.js` | The page: a sidebar panel or a Settings section, appearing with the Host's namespace |

Every package declares `dsh.bundle` (its patch file is the `cordis.patch.yml` beside it), so `dsh plugin add` — or listing the package in the profile's `dsh.profile.bundles` — **inserts that row for you**.

**Once it has been installed that way, do not hand-write an `- insert:` row with the same id**: the bundle layer already inserted one, and a second row with the same id makes the plugin market's preflight fail with `duplicate loader entry id "agent-import" (2 rows)` and roll the whole install or update back. To configure that row, write a same-id **override** (no `insert`):

```yaml
- id: agent-import                # the mail package is id: mail
  config:
    sources: [codex, claude-code]
```

**The `id` is fixed** — dsh names a row's settings namespace after the row's own entry id, and the page follows that namespace. Write `- insert:` only when the package is *not* in `dsh.profile.bundles` and you are assembling the profile by hand, or in a `dsh web --patch` overlay (see [`examples/agent-import.cordis.yml`](examples/agent-import.cordis.yml)).

## Install

```sh
dsh plugin --profile web add @free-lzj/dsh-agent-import
dsh plugin --profile web add @free-lzj/dsh-mail
```

**Pick the profile you actually run**: `dsh web` uses `web`. The Electron Desktop app uses `desktop` — it is not a different client but the same `dsh-web-app` composition plus a **bundled** dsh runtime of its own, serving the page through the Host's own `ctx.webServer` on a local port, so both halves work there too; only the profile and the global CLI do not carry over:

```sh
dsh plugin --profile desktop add @free-lzj/dsh-mail
```

> **When a change takes effect**: Host code is JS loaded at boot, so a change to it needs a **`dsh web` restart** (the Desktop preview too); the browser half needs a page refresh.

> **Compatibility preflight**: both packages' peer ranges cover the 0.1.x runtimes from 0.1.7 on and the 0.2.x runtimes including their prereleases (the one the Desktop bundles among them). When the running version falls outside that range, dsh's startup preflight **disables the row outright** (stderr prints `dsh: disabling profile plugin row "…": …`) and neither the plugin nor its page appears, which reads as "the install did nothing". Grant the exact-version exemption to admit it: `dsh plugin --profile <profile> allow-version <package@version> --dsh-version <runtime version> --accept-risk`.

### From this checkout (only when working on a plugin itself)

<details>
<summary>Expand</summary>

```sh
pnpm install
pnpm run build

dsh plugin --profile web add "<absolute path>/packages/agent-import"
dsh plugin --profile web add "<absolute path>/packages/mail"
# or run pnpm pack first and install the .tgz file
```

Booting with an overlay works too, without touching a profile (see [`examples/agent-import.cordis.yml`](examples/agent-import.cordis.yml)):

```sh
dsh web --patch examples/agent-import.cordis.yml
```

</details>

### Upgrading from 0.2.x

`agent-import`'s 0.2.x was two packages and two Loader rows (`@free-lzj/dsh-agent-import` plus `@free-lzj/dsh-client-ui-settings-agent-import`). 0.3.0 merges them into one package and stops publishing the companion:

```sh
dsh plugin --profile web remove @free-lzj/dsh-client-ui-settings-agent-import
dsh plugin --profile web add @free-lzj/dsh-agent-import
```

Then drop the `ui-settings-agent-import` row from the profile, leaving only `id: agent-import` (as in the example above), and restart `dsh web`. The page comes from the package's own `dsh.client` declaration and needs no row of its own.

## Development in this repository

A pnpm monorepo: one directory under `packages/*` is one package.

| Directory | Package |
|---|---|
| [`packages/agent-import`](packages/agent-import) | `@free-lzj/dsh-agent-import` (MCP servers + skill import) |
| [`packages/mail`](packages/mail) | `@free-lzj/dsh-mail` (sidebar mail) |

```sh
pnpm install
pnpm run typecheck   # every package, both halves
pnpm run build       # tsc for types, tsdown for lib/index.js (Node half) and lib/client.js (browser half)
pnpm run test        # vitest: 31 spec files / 515 tests
```

Build before testing: the artifacts have contract specs of their own (registration id, the `dsh.client` declaration, `exports["./client"]`, and that nothing in the browser entry takes a value from the Host half), and one of them reports as skipped without `lib/`.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on `windows-latest`: the adapter specs assert Windows drive-letter path handling (`C:`, `D:` fixtures for Codex and Claude Code homes), which Linux reads as relative paths.

The browser-half specs need the dsh client packages' Node halves and their module table; [`vitest.config.ts`](vitest.config.ts) and [`packages/agent-import/tests/support/`](packages/agent-import/tests/support) document those two seams (see ["How the specs get dsh's client code"](packages/agent-import/README.md#测试如何拿到-dsh-的客户端代码) in the agent-import README).

The real-composition end-to-end test (boot a shipped profile, assert the imported tools and skills are model-visible) runs in the dsh monorepo, because it depends on that repository's own profile-boot fixture. This repository's CI runs typecheck, build, and the unit/component suites.

### Releasing

```sh
cd packages/agent-import   # or packages/mail
npm publish               # prepublishOnly builds first; publishConfig carries access: public
```

- The version lives in each package's `package.json`; a version npm already has cannot be published again.
- With auth-and-writes 2FA on the account, `npm publish` needs an OTP — or a **granular access token with "Bypass 2FA" enabled**; an ordinary token fails with `403 … bypass 2fa enabled is required`.
- The npm package page renders the README from the tarball, so a README edit after a release reaches npm only with a new version.

## License

[MIT](LICENSE)
