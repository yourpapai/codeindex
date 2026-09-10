import { describe, expect, test } from 'bun:test'

import { rerankSearchResults, scoreSearchResult } from '../../src/search/rank.js'
import type { MatchedBy, SearchResult } from '../../src/types.js'

const baseResult: Omit<SearchResult, 'matchedBy' | 'scopeTier' | 'symbolKey' | 'qualifiedName' | 'localName'> = {
  kind: 'function_declaration',
  filePath: 'src/foo.ts',
  startLine: 1,
  endLine: 1,
  exportNames: [],
  confidence: 'exact',
  snippet: 'function helper() {}',
}

const withMatchedBy = (
  symbolKey: string,
  matchedBy: MatchedBy,
  scopeTier: SearchResult['scopeTier'],
): SearchResult => ({
  ...baseResult,
  symbolKey,
  qualifiedName: `src/foo#${symbolKey}`,
  localName: symbolKey,
  matchedBy,
  scopeTier,
})

describe('scoreSearchResult', () => {
  test('exact_export earns a 500 bonus over scope', () => {
    expect(scoreSearchResult(withMatchedBy('helper', 'exact_export', 'exported'))).toBe(400 + 500)
  })

  test('exact_qualified earns a 450 bonus over scope', () => {
    expect(scoreSearchResult(withMatchedBy('helper', 'exact_qualified', 'exported'))).toBe(400 + 450)
  })

  test('exact_local earns a 425 bonus over scope', () => {
    expect(scoreSearchResult(withMatchedBy('helper', 'exact_local', 'local'))).toBe(100 + 425)
  })

  test('path_prefix earns no bonus', () => {
    expect(scoreSearchResult(withMatchedBy('helper', 'path_prefix', 'exported'))).toBe(400)
  })

  test('fts earns no bonus', () => {
    expect(scoreSearchResult(withMatchedBy('helper', 'fts', 'exported'))).toBe(400)
  })
})

describe('rerankSearchResults', () => {
  test('attaches rankScore to each result', () => {
    const ranked = rerankSearchResults([
      withMatchedBy('a', 'exact_local', 'local'),
      withMatchedBy('b', 'exact_export', 'exported'),
    ])
    expect(ranked[0]!.rankScore).toBe(900)
    expect(ranked[1]!.rankScore).toBe(525)
  })

  test('sorts by descending rankScore', () => {
    const ranked = rerankSearchResults([
      withMatchedBy('a', 'exact_local', 'local'),
      withMatchedBy('b', 'exact_export', 'exported'),
    ])
    expect(ranked.map((r) => r.symbolKey)).toEqual(['b', 'a'])
  })
})

test('blends relevance: within a tier, higher bm25 relevance ranks higher', () => {
  const weak = { ...withMatchedBy('weak', 'fts', 'exported'), relevance: 1 }
  const strong = { ...withMatchedBy('strong', 'fts', 'exported'), relevance: 9 }
  const ranked = rerankSearchResults([weak, strong])
  expect(ranked[0]!.symbolKey).toBe('strong')
})

test('an exact match still outranks a strong FTS hit', () => {
  const exact = withMatchedBy('z', 'exact_local', 'local')
  const fts = { ...withMatchedBy('y', 'fts', 'exported'), relevance: 999 }
  const ranked = rerankSearchResults([fts, exact])
  expect(ranked[0]!.symbolKey).toBe('z')
})

describe('in-degree blending', () => {
  test('within a tier, the more-referenced symbol ranks higher', () => {
    const low = { ...withMatchedBy('low', 'fts', 'exported'), relevance: 0, inDegree: 0 }
    const high = { ...withMatchedBy('high', 'fts', 'exported'), relevance: 0, inDegree: 25 }
    const ranked = rerankSearchResults([low, high])
    expect(ranked[0]!.symbolKey).toBe('high')
  })

  test('missing inDegree contributes nothing (scores unchanged)', () => {
    const ranked = rerankSearchResults([withMatchedBy('only', 'fts', 'exported')])
    expect(ranked[0]!.rankScore).toBe(400)
  })
})
