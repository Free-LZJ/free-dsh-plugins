/**
 * The two things this plugin mounts besides the mention route.
 *
 * Both run through `ctx.inject`, which is the part worth pinning: a deployment
 * without a skill registry or a tool registry must lose that one capability and
 * keep the rest, never fail the whole plugin.
 */

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { MCP_SERVER_NAME, mountBrowserTools, registerSkill } from '../src/index.ts'
import { BROWSER_SKILL } from '../src/skill.ts'

/** One recorded effect or plugin call, plus the fake context that made it. */
interface Bench {
  readonly ctx: Context
  /** Injectable service names this plugin asked to wait for. */
  readonly waited: string[][]
  /** Skill registrations the fake registry received. */
  readonly skills: unknown[]
  /** Plugin mounts that reached the MCP client module. */
  readonly plugins: unknown[]
}

/**
 * Build a context that answers exactly the calls this plugin makes.
 *
 * `inject` runs its callback immediately, as Cordis does once every named
 * service exists — so the bench exercises the mounted path, and a missing
 * service is modelled by leaving the name out of the callback's own context.
 * @param services - service names the fake context serves.
 * @returns the fake context and what it recorded.
 */
function bench(services: readonly string[]): Bench {
  const waited: string[][] = []
  const skills: unknown[] = []
  const plugins: unknown[] = []
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined },
    inject: (deps: string[], callback: (inner: unknown) => void) => {
      waited.push(deps)
      callback(ctx)
    },
    plugin: (mod: unknown, config: unknown) => {
      plugins.push({ mod, config })
      return () => undefined
    },
    effect: (fn: () => unknown) => {
      fn()
      return () => undefined
    },
    get: (name: string) => (services.includes(name) ? {} : undefined),
    skills: {
      register: (skill: unknown) => {
        skills.push(skill)
        return () => undefined
      },
    },
  } as unknown as Context
  return { ctx, waited, skills, plugins }
}

describe('registerSkill', () => {
  it('registers the bundled browser skill', () => {
    const b = bench(['skills'])
    registerSkill(b.ctx)
    expect(b.skills).toEqual([BROWSER_SKILL])
  })

  it('waits for the skill registry instead of reading it eagerly', () => {
    const b = bench(['skills'])
    registerSkill(b.ctx)
    expect(b.waited).toEqual([['skills']])
  })
})

describe('mountBrowserTools', () => {
  it('mounts the MCP client under the bsk server name', () => {
    const b = bench(['tools', 'systemPrompt'])
    mountBrowserTools(b.ctx)
    expect(b.waited).toEqual([['tools', 'systemPrompt']])
    expect(b.plugins).toHaveLength(1)
    const mounted = b.plugins[0] as { config: { serverName: string; transport: string; args: string[] } }
    expect(mounted.config.serverName).toBe(MCP_SERVER_NAME)
    expect(mounted.config.transport).toBe('stdio')
    expect(mounted.config.args).toEqual(['mcp'])
  })
})
