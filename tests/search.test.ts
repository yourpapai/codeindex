import { describe, expect, test } from 'bun:test'

import { rerankSearchResults, scoreSearchResult } from '../src/search.js'
import type { SearchResult } from '../src/types.js'

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
  matchedBy: 'exact_local',
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
  matchedBy: 'exact_export',
  confidence: 'resolved',
  snippet: 'export function helper() {}',
}

describe('scoreSearchResult', () => {
  test('computes scope + match score for an exported exact match', () => {
    const score = scoreSearchResult(exportedResult)
    expect(score).toBe(400 + 500)
  })

  test('computes scope + match score for a local exact match', () => {
    const score = scoreSearchResult(localResult)
    expect(score).toBe(100 + 425)
  })

  test('returns scope-only score when matchedBy is non-exact', () => {
    const ftsResult: SearchResult = {
      ...exportedResult,
      matchedBy: 'fts',
    }
    expect(scoreSearchResult(ftsResult)).toBe(400)
  })
})

describe('rerankSearchResults', () => {
  test('prefers exported and module-level hits over locals', () => {
    const ranked = rerankSearchResults([localResult, exportedResult])

    expect(ranked.map((entry) => entry.symbolKey)).toEqual(['b', 'a'])
  })

  test('attaches rankScore to each result', () => {
    const ranked = rerankSearchResults([localResult, exportedResult])

    expect(ranked[0]!.rankScore).toBe(400 + 500)
    expect(ranked[1]!.rankScore).toBe(100 + 425)
  })

  test('returns RankedSearchResult with all SearchResult fields plus rankScore', () => {
    const ranked = rerankSearchResults([exportedResult])
    const first = ranked[0]!

    expect(first.symbolKey).toBe('b')
    expect(first.qualifiedName).toBe('src/bar#helper')
    expect(first.rankScore).toBe(900)
  })
})
