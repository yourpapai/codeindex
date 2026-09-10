import type { MatchedBy, RankedSearchResult, SearchResult } from '../types.js'

const scopeScore = (scopeTier: SearchResult['scopeTier']): number => {
  switch (scopeTier) {
    case 'exported':
      return 400
    case 'module':
      return 300
    case 'member':
      return 200
    case 'local':
      return 100
    default:
      throw new Error(`Unsupported scope tier: ${String(scopeTier)}`)
  }
}

const MATCH_SCORES: Record<MatchedBy, number> = {
  exact_export: 500,
  exact_qualified: 450,
  exact_local: 425,
  path_prefix: 0,
  fts: 0,
}

// BM25 relevance is blended as a bounded term so lexical strength reorders results
// *within* a scope tier (the measured NL-intent weakness) without ever letting an FTS
// hit overtake an exact-name match. Normalized to [0,1] across the current result set.
const RELEVANCE_WEIGHT = 100

const maxRelevance = (results: readonly SearchResult[]): number =>
  results.reduce((max, r) => (r.relevance !== undefined && r.relevance > max ? r.relevance : max), 0)

const relevanceScore = (result: Readonly<SearchResult>, max: number): number =>
  result.relevance === undefined || max <= 0 ? 0 : (result.relevance / max) * RELEVANCE_WEIGHT

// In-degree is blended like BM25: bounded and normalized across the current result set, so a
// popular symbol reorders *within* its tier without overtaking exact-name matches. log1p
// dampens hubs; IN_DEGREE_WEIGHT is calibrated once against the IR gate (Slice 6).
const IN_DEGREE_WEIGHT = 15

const maxInDegree = (results: readonly SearchResult[]): number =>
  results.reduce((max, r) => (r.inDegree !== undefined && r.inDegree > max ? r.inDegree : max), 0)

const inDegreeScore = (result: Readonly<SearchResult>, max: number): number =>
  result.inDegree === undefined || max <= 0 ? 0 : (Math.log1p(result.inDegree) / Math.log1p(max)) * IN_DEGREE_WEIGHT

export const scoreSearchResult = (result: Readonly<SearchResult>): number =>
  scopeScore(result.scopeTier) + MATCH_SCORES[result.matchedBy]

export const rerankSearchResults = (results: readonly SearchResult[]): readonly RankedSearchResult[] => {
  const maxRel = maxRelevance(results)
  const maxDeg = maxInDegree(results)
  return [...results]
    .map((result) => ({
      ...result,
      rankScore: scoreSearchResult(result) + relevanceScore(result, maxRel) + inDegreeScore(result, maxDeg),
    }))
    .sort((left, right) => right.rankScore - left.rankScore)
}
