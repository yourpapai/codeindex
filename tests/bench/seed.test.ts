import { describe, expect, test } from 'bun:test'

import { loadCorpus } from '../../bench/corpus.js'

describe('seed corpus', () => {
  test('parses and contains all three query kinds', async () => {
    const corpus = await loadCorpus('bench/corpus/seed.json')
    const kinds = new Set(corpus.queries.map((query) => query.kind))
    expect(kinds.has('find-symbol')).toBe(true)
    expect(kinds.has('nl-intent')).toBe(true)
    expect(kinds.has('who-uses')).toBe(true)
    expect(corpus.queries.length).toBeGreaterThanOrEqual(6)
  })
})
