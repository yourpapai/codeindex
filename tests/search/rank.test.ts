import { describe, expect, test } from 'bun:test'

import { rerankSearchResults, scoreSearchResult } from '../../src/search/rank.js'
import type { SearchResult } from '../../src/types.js'

const localResult: SearchResult = {
  symbolKey: 'a',
  qualifiedName: 'src/foo#helper',
  localName: 'helper',
  kind: 'function_declaration',
  scopeTier: 'local',
  filePath: 'src/foo.ts',
  startLine: 1,
  endLine: 1,
  exportNames: [],
  matchReason: 'exact local_name',
  confidence: 'resolved',
  snippet: 'function helper() {}',
}

const exportedResult: SearchResult = {
  symbolKey: 'b',
  qualifiedName: 'src/bar#helper',
  localName: 'helper',
  kind: 'function_declaration',
  scopeTier: 'exported',
  filePath: 'src/bar.ts',
  startLine: 1,
  endLine: 1,
  exportNames: ['helper'],
  matchReason: 'exact export_names',
  confidence: 'resolved',
  snippet: 'export function helper() {}',
}

describe('scoreSearchResult', () => {
  test('computes scope + match score for an exported exact match', () => {
    expect(scoreSearchResult(exportedResult)).toBe(400 + 500)
  })

  test('computes scope + match score for a local exact match', () => {
    expect(scoreSearchResult(localResult)).toBe(100 + 425)
  })

  test('returns scope-only score when matchReason is non-exact', () => {
    const ftsResult: SearchResult = { ...exportedResult, matchReason: 'fts identifier_terms' }
    expect(scoreSearchResult(ftsResult)).toBe(400)
  })
})

describe('rerankSearchResults', () => {
  test('attaches rankScore to each result', () => {
    const ranked = rerankSearchResults([localResult, exportedResult])
    expect(ranked[0]!.rankScore).toBe(900)
    expect(ranked[1]!.rankScore).toBe(525)
  })

  test('sorts by descending rankScore', () => {
    const ranked = rerankSearchResults([localResult, exportedResult])
    expect(ranked.map((r) => r.symbolKey)).toEqual(['b', 'a'])
  })
})

test('blends relevance: within a tier, higher bm25 relevance ranks higher', () => {
  const base = {
    symbolKey: 'k',
    qualifiedName: 'm#a',
    localName: 'a',
    kind: 'function',
    scopeTier: 'exported' as const,
    filePath: 'm.ts',
    startLine: 1,
    endLine: 2,
    exportNames: [],
    matchReason: 'fts identifier_terms/doc_text/body_text',
    confidence: 'resolved' as const,
    snippet: '',
  }
  const weak = { ...base, symbolKey: 'weak', qualifiedName: 'm#weak', relevance: 1 }
  const strong = { ...base, symbolKey: 'strong', qualifiedName: 'm#strong', relevance: 9 }
  const ranked = rerankSearchResults([weak, strong])
  expect(ranked[0]!.symbolKey).toBe('strong')
})

test('an exact match still outranks a strong FTS hit', () => {
  const exact = {
    symbolKey: 'exact',
    qualifiedName: 'm#z',
    localName: 'z',
    kind: 'function',
    scopeTier: 'local' as const,
    filePath: 'm.ts',
    startLine: 1,
    endLine: 2,
    exportNames: [],
    matchReason: 'exact local_name',
    confidence: 'exact' as const,
    snippet: '',
  }
  const fts = {
    symbolKey: 'fts',
    qualifiedName: 'm#y',
    localName: 'y',
    kind: 'function',
    scopeTier: 'exported' as const,
    filePath: 'm.ts',
    startLine: 1,
    endLine: 2,
    exportNames: [],
    matchReason: 'fts identifier_terms/doc_text/body_text',
    confidence: 'resolved' as const,
    snippet: '',
    relevance: 999,
  }
  const ranked = rerankSearchResults([fts, exact])
  expect(ranked[0]!.symbolKey).toBe('exact')
})
