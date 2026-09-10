import { describe, expect, test } from 'bun:test'

import { fuseRankedLists } from '../../src/search/rank.js'
import type { MatchedBy } from '../../src/types.js'

interface Item {
  readonly id: string
}

const entry = (id: string, matchedBy: MatchedBy): { item: Item; matchedBy: MatchedBy } => ({
  item: { id },
  matchedBy,
})

describe('fuseRankedLists', () => {
  test('accumulates reciprocal-rank contributions across lists (k=60)', () => {
    const fused = fuseRankedLists<Item>([[entry('a', 'exact_local')], [entry('a', 'fts')]], 60, (i) => i.id)
    expect(fused).toHaveLength(1)
    expect(fused[0]!.rrfScore).toBeCloseTo(1 / 61 + 1 / 61, 12)
  })

  test('an item present only in a later list scores its own contribution', () => {
    const fused = fuseRankedLists<Item>([[entry('a', 'exact_local')], [entry('b', 'fts')]], 60, (i) => i.id)
    const byId = new Map(fused.map((f) => [f.item.id, f]))
    expect(byId.get('b')!.rrfScore).toBeCloseTo(1 / 61, 12)
    expect(byId.get('b')!.matchedBy).toBe('fts')
  })

  test('rank within a list dampens the contribution', () => {
    const fused = fuseRankedLists<Item>(
      [
        [entry('a', 'fts'), entry('b', 'fts')],
        [entry('a', 'fts'), entry('b', 'fts')],
      ],
      60,
      (i) => i.id,
    )
    const byId = new Map(fused.map((f) => [f.item.id, f]))
    expect(byId.get('a')!.rrfScore).toBeCloseTo(1 / 61 + 1 / 61, 12)
    expect(byId.get('b')!.rrfScore).toBeCloseTo(1 / 62 + 1 / 62, 12)
  })

  test('an item in both lists outranks an item in one list', () => {
    const fused = fuseRankedLists<Item>(
      [[entry('both', 'exact_local')], [entry('both', 'fts'), entry('only', 'fts')]],
      60,
      (i) => i.id,
    )
    expect(fused[0]!.item.id).toBe('both')
  })

  test('provenance comes from the first list that surfaced the item', () => {
    const fused = fuseRankedLists<Item>([[entry('a', 'exact_export')], [entry('a', 'fts')]], 60, (i) => i.id)
    expect(fused[0]!.matchedBy).toBe('exact_export')
  })

  test('a custom k shifts the contributions', () => {
    const fused = fuseRankedLists<Item>([[entry('a', 'fts')]], 10, (i) => i.id)
    expect(fused[0]!.rrfScore).toBeCloseTo(1 / 11, 12)
  })

  test('equal scores keep first-seen order (deterministic ties)', () => {
    const fused = fuseRankedLists<Item>([[entry('x', 'fts')], [entry('y', 'fts')]], 60, (i) => i.id)
    expect(fused.map((f) => f.item.id)).toEqual(['x', 'y'])
  })

  test('an empty list set fuses to nothing', () => {
    expect(fuseRankedLists<Item>([], 60, (i) => i.id)).toEqual([])
  })
})
