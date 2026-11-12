/**
 * A picked row becomes an atomic mention chip, and the chip's serialized form is
 * the only thing the model sees. The scheme rewrite is what keeps a tab id from
 * reading like a path.
 */

import { describe, expect, it } from 'vitest'
import { mentionAddress } from '../src/client/index.ts'

describe('mentionAddress', () => {
  it('turns a provider ref into a mention scheme', () => {
    expect(mentionAddress('browser:299872133')).toBe('dsh-browser:299872133')
  })

  it('keeps a ref without a provider prefix addressable', () => {
    expect(mentionAddress('299872133')).toBe('dsh-299872133')
  })
})
