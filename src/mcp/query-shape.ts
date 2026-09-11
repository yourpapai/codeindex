export type QueryShape = 'identifier' | 'multi_token_lexical' | 'nl' | 'empty'

const STRUCTURAL_SEPARATORS = /[#[\]>./]/

const CODEISH_TOKEN = /^[A-Za-z_@][\w./#>-]*$/

/**
 * Deterministic, advisory classifier for query-log telemetry.
 * Cheap enough to run on every logged call; refined only if the study memo needs it.
 */
export const classifyQueryShape = (queryText: string | null | undefined): QueryShape => {
  if (queryText === null || queryText === undefined) {
    return 'empty'
  }
  const trimmed = queryText.trim()
  if (trimmed === '') {
    return 'empty'
  }
  // Identity forms and module paths (module#name, parent>name, a/b.ts) are identifiers.
  if (STRUCTURAL_SEPARATORS.test(trimmed)) {
    return 'identifier'
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  if (tokens.length === 1) {
    return 'identifier'
  }
  if (tokens.length >= 3) {
    return 'nl'
  }
  // Two tokens: lexical if both look like short code-ish tokens, else natural language.
  const allShortLexical = tokens.every((token) => token.length <= 24 && CODEISH_TOKEN.test(token))
  return allShortLexical ? 'multi_token_lexical' : 'nl'
}

/** Weak when fewer hits than requested, or below the absolute floor when no limit is available. */
export const isZeroOrWeakResult = (resultCount: number, limit?: number | null): boolean => {
  if (resultCount <= 0) {
    return true
  }
  if (limit !== undefined && limit !== null && limit > 0) {
    return resultCount < limit
  }
  return resultCount < 3
}
