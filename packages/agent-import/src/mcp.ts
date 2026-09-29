/**
 * Mounting of imported MCP servers through `@deepseek-ai/dsh-mcp-client`.
 *
 * A foreign server name is not necessarily a legal dsh server namespace, because
 * dsh derives model-facing tool names (`mcp__<serverName>__<tool>`) from a
 * `[A-Za-z0-9_-]{1,32}` grammar. {@link allocateServerName} therefore keeps a
 * conforming name verbatim and derives a stable, collision-free replacement for
 * every other name, so two Codex servers that differ only by punctuation still
 * mount as two distinct tool sets.
 *
 * @module @deepseek-ai/dsh-agent-import/mcp
 */

import { createHash } from 'node:crypto'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { ForeignMcpServer } from './types.ts'

/** Maximum length of a dsh server namespace. */
const MAX_SERVER_NAME = 32

/** Length of the digest appended when a foreign name has to be shortened. */
const DIGEST_LENGTH = 6

/** One imported declaration together with the namespace it mounts under. */
export interface ServerMount {
  /** The normalized foreign declaration. */
  readonly declaration: ForeignMcpServer
  /** dsh server namespace, unique among the servers this plugin mounts. */
  readonly serverName: string
}

/**
 * Reserve a unique dsh server namespace for one foreign server name.
 * @param preferred - server name as the declaring tool writes it.
 * @param used - namespaces already reserved; the allocated name is added to it.
 * @returns a legal dsh namespace, unchanged when the foreign name already conforms.
 */
export function allocateServerName(preferred: string, used: Set<string>): string {
  const base = slug(preferred)
  let candidate = base
  let counter = 2
  while (used.has(candidate)) {
    const suffix = `-${String(counter)}`
    candidate = `${base.slice(0, MAX_SERVER_NAME - suffix.length)}${suffix}`
    counter += 1
  }
  used.add(candidate)
  return candidate
}

/**
 * Mount every planned server as an `mcp-client` child of the calling context.
 * @param ctx - context that owns the mounted children.
 * @param mounts - servers to mount, in declaration order.
 * @param failOnStartupError - whether a server that fails to start rejects this plugin's activation.
 * @returns the mounted children, in declaration order, so a later import generation can unmount them.
 */
export async function mountForeignServers(
  ctx: Context,
  mounts: readonly ServerMount[],
  failOnStartupError: boolean,
): Promise<readonly Fiber[]> {
  const mounted: Fiber[] = []
  for (const { declaration, serverName } of mounts) {
    const config = declaration.transport === 'stdio'
      ? McpClient.Config({
        transport: 'stdio',
        serverName,
        command: declaration.command,
        args: [...declaration.args],
        env: { ...declaration.env },
        failOnStartupError,
      })
      : McpClient.Config({
        transport: 'streamable-http',
        serverName,
        url: declaration.url,
        headers: { ...declaration.headers },
        failOnStartupError,
      })
    try {
      mounted.push(await ctx.plugin(McpClient, config))
    } catch (error: unknown) {
      for (const fiber of mounted) await fiber.dispose()
      throw error
    }
  }
  return mounted
}

/** Reduce a foreign server name to the dsh namespace grammar. */
function slug(name: string): string {
  const cleaned = name.normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[_-]+|[_-]+$/g, '')
  if (cleaned.length === 0) return 'server'
  if (cleaned.length <= MAX_SERVER_NAME) return cleaned
  const digest = createHash('sha256').update(name).digest('hex').slice(0, DIGEST_LENGTH)
  return `${cleaned.slice(0, MAX_SERVER_NAME - DIGEST_LENGTH - 1)}-${digest}`
}
