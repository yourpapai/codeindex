import { describe, expect, test } from 'bun:test'

import { mean, precisionAtK, recallAtK, reciprocalRank } from '../../bench/metrics.js'

describe('precisionAtK', () => {
  test('counts distinct relevant hits in the top k over k', () => {
    expect(precisionAtK(['a', 'x', 'b', 'y'], new Set(['a', 'b']), 4)).toBe(0.5)
  })

  test('returns 0 when k is 0', () => {
    expect(precisionAtK(['a'], new Set(['a']), 0)).toBe(0)
  })
})

describe('recallAtK', () => {
  test('is the share of the relevant set found in the top k', () => {
    expect(recallAtK(['a', 'b', 'z'], new Set(['a', 'b', 'c']), 10)).toBeCloseTo(2 / 3)
  })

  test('returns 0 when the relevant set is empty', () => {
    expect(recallAtK(['a'], new Set<string>(), 10)).toBe(0)
  })
})

describe('reciprocalRank', () => {
  test('is 1 over the 1-based rank of the first relevant hit', () => {
    expect(reciprocalRank(['x', 'a', 'b'], new Set(['a']))).toBe(1 / 2)
  })

  test('returns 0 when no relevant item appears', () => {
    expect(reciprocalRank(['x', 'y'], new Set(['a']))).toBe(0)
  })
})

describe('mean', () => {
  test('averages the values', () => {
    expect(mean([1, 0, 0.5])).toBeCloseTo(0.5)
  })

  test('returns 0 for an empty list', () => {
    expect(mean([])).toBe(0)
  })
})
