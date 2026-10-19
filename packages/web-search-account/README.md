# dsh-web-search-account

Search with the DeepSeek account you are **already signed in to**, whichever
model your conversation runs on.

## Why this exists

dsh ships a DeepSeek search provider, but it borrows the account credential
only when the *conversation itself* runs on the `deepseek-account` route:

```js
// dsh-web-search-deepseek
if (ctx.get("agents")?.currentInitiator()?.session.requestContext()?.provider !== 'deepseek-account')
  return void 0
```

Pin your chat to a gateway provider or a third-party model and that line gives
up, so search needs a separate API key — even though the machine already holds
a valid account token. On a relay that only speaks `openai-completions` the
situation is worse: the native `web_search` server tool is not forwarded at
all, so search fails no matter which key you supply.

This provider removes the conversation from the equation. It asks the account
service for a token for the search endpoint and sends it in the header that
route expects, so search works while chat stays exactly where it was.

## What it does not touch

Nothing about which model replies. No model provider is registered, no
`agent-default-model` is written, no chat route changes — the plugin only
replaces how a search is answered.

## Install

```powershell
dsh plugin --profile <profile> add @free-lzj/dsh-web-search-account
```

The bundle patch pins `web.searchProvider` to `deepseek-account`, so the seam
routes searches here instead of to the shipped provider. Without that step the
built-in provider keeps winning and nothing changes.

The same bundle patch **inserts this package's own `web-search-account` row**, so
do not add an `- insert:` row for that id to your profile patch: the bundle layer
already inserted one, and a second row with the same id fails the plugin market's
preflight (`duplicate loader entry id "web-search-account" (2 rows)`) and rolls
the install back. To override that row's config, patch it by id with no `insert`:

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: web-search-account
  config:
    model: deepseek-v4-flash
```

Disable the shipped row if it is still mounted, so two providers do not
advertise themselves as usable:

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: web-search-deepseek
  disabled: true
```

(Selection by an explicit `searchProvider` id means ambiguity is not fatal, but
a disabled shipped row keeps the two from disagreeing about which one answered.)

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `providerId` | `deepseek-account` | Registry key; must match `web.searchProvider` |
| `baseURL` | `https://api.deepseek.com/anthropic/v1` | Anthropic-compatible Messages base, without `/messages` |
| `model` | `deepseek-v4-flash` | Model that runs the search turn |
| `apiVersion` | `2023-06-01` | `anthropic-version` header |
| `maxTokens` | `4096` | Generated-token cap for one search turn |
| `maxUses` | `5` | Maximum `web_search` server-tool uses per request |

All fields are volatile: an edit takes effect on the next search without a
restart.

`baseURL` decides whether search can work at all. The account service issues a
token only for the origin it authenticates — `https://api.deepseek.com` by
default — and returns nothing for any other destination. That refusal is
surfaced as sign-in guidance, never retried against a different endpoint,
because sending the credential somewhere it was not issued for is not a
recovery.

## Requirements

- A signed-in DeepSeek account (Settings → Account).
- An endpoint that actually executes the native `web_search_20250305` server
  tool. A relay that only forwards `openai-completions` cannot, and this plugin
  reports that as a missing `web_search_tool_result` block rather than
  accepting a made-up answer.

## Verify

```bash
npx vitest run packages/web-search-account
```

Six checks, including the one that matters: the request carries
`x-dsh-auth-token` and no `x-api-key`.

Live check — the account endpoint should answer with a real result block:

```bash
curl -s https://api.deepseek.com/anthropic/v1/messages \
  -H "x-dsh-auth-token: $TOKEN" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"deepseek-v4-flash","max_tokens":1024,
       "messages":[{"role":"user","content":"Search the web for: DeepSeek"}],
       "tools":[{"type":"web_search_20250305","name":"web_search","max_uses":2}]}' \
  | jq '.content[].type'
```

Expected output contains `web_search_tool_result`.
