import { describe, expect, test } from 'bun:test'

import { parseCorpus } from '../../bench/corpus.js'

describe('parseCorpus', () => {
  test('accepts a corpus with find and who-uses queries', () => {
    const corpus = parseCorpus({
      name: 'sample',
      queries: [
        { id: 'q1', kind: 'find-symbol', query: 'searchSymbols', relevant: ['src/search/index#searchSymbols'] },
        { id: 'q2', kind: 'who-uses', target: 'src/storage/db#openDatabase', relevant: ['src/cli#withDatabase'] },
      ],
    })
    expect(corpus.queries.length).toBe(2)
  })

  test('rejects a who-uses query missing a target', () => {
    expect(() => parseCorpus({ name: 'bad', queries: [{ id: 'q1', kind: 'who-uses', relevant: [] }] })).toThrow()
  })

  test('rejects an unknown query kind', () => {
    expect(() =>
      parseCorpus({ name: 'bad', queries: [{ id: 'q1', kind: 'grep', query: 'x', relevant: [] }] }),
    ).toThrow()
  })
})
