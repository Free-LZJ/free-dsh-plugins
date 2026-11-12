/**
 * The provider registry is the seam that makes `@` extensible, so its two
 * promises are pinned here: registration order is menu order, and one failing
 * provider never costs the user the rest of the menu.
 */

import { describe, expect, it } from 'vitest'
import { MentionRegistry, type MentionProvider } from '../src/mention.ts'

/** A provider that answers one item labelled with its own id. */
function provider(id: string, options: { readonly fails?: boolean } = {}): MentionProvider {
  return {
    id,
    label: id,
    async candidates() {
      if (options.fails === true) throw new Error(`${id} is down`)
      return [{ ref: `${id}:1`, label: `${id} row` }]
    },
  }
}

describe('MentionRegistry', () => {
  it('answers groups in registration order', async () => {
    const registry = new MentionRegistry()
    registry.register(provider('browser'))
    registry.register(provider('apps'))
    const collected = await registry.collect('', new AbortController().signal)
    expect(collected.groups.map(group => group.id)).toEqual(['browser', 'apps'])
  })

  it('refuses a duplicate id', () => {
    const registry = new MentionRegistry()
    registry.register(provider('browser'))
    expect(() => registry.register(provider('browser'))).toThrow(/already registered/)
  })

  it('drops a provider from the disposer', async () => {
    const registry = new MentionRegistry()
    const dispose = registry.register(provider('browser'))
    dispose()
    const collected = await registry.collect('', new AbortController().signal)
    expect(collected.groups).toEqual([])
  })

  it('serves the rest of the menu when one provider fails', async () => {
    const registry = new MentionRegistry()
    registry.register(provider('browser'))
    registry.register(provider('apps', { fails: true }))
    const collected = await registry.collect('', new AbortController().signal)
    expect(collected.groups.map(group => group.id)).toEqual(['browser'])
    expect(collected.failures).toEqual(['apps: apps is down'])
  })

  it('leaves out a provider with nothing to offer', async () => {
    const registry = new MentionRegistry()
    registry.register({
      id: 'empty',
      label: 'Empty',
      async candidates() { return [] },
    })
    const collected = await registry.collect('', new AbortController().signal)
    expect(collected.groups).toEqual([])
  })
})
