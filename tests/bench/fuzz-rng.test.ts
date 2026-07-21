import { describe, expect, test } from 'bun:test'

import { createRng, pick, randomInt } from '../../bench/fuzz-rng.js'

describe('createRng', () => {
  test('is deterministic for a given seed', () => {
    const a = createRng(42)
    const b = createRng(42)
    const seqA = [a(), a(), a()]
    const seqB = [b(), b(), b()]
    expect(seqA).toEqual(seqB)
  })

  test('differs across seeds', () => {
    expect(createRng(1)()).not.toBe(createRng(2)())
  })

  test('produces values in [0, 1)', () => {
    const rng = createRng(7)
    for (let index = 0; index < 100; index += 1) {
      const value = rng()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  test('randomInt stays in range and pick returns a member', () => {
    const rng = createRng(9)
    for (let index = 0; index < 50; index += 1) {
      const n = randomInt(rng, 5)
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThan(5)
    }
    expect(['a', 'b', 'c']).toContain(pick(createRng(3), ['a', 'b', 'c']))
  })
})
