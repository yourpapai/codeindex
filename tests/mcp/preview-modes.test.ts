import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'

import type { IndexSummary } from '../../src/indexer/index-codebase.js'
import { createCodeindexServer } from '../../src/mcp/server.js'
import { CodeSearchOutputSchema, CodeSymbolOutputSchema, type CodeindexToolDeps } from '../../src/mcp/tools.js'
import { ensureSchema } from '../../src/storage/schema.js'
import type { RankedSearchResult } from '../../src/types.js'
import { connectClient, makeInMemoryDeps, seedFile, seedSymbol } from './harness.js'

const ANCHOR_MAX_CHARS = 160
const SHORT_MAX_LINES = 10

const openDbs: Database[] = []

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    db.close()
  }
})

const rankedResult = (
  overrides: Partial<RankedSearchResult> & Pick<RankedSearchResult, 'snippet'>,
): RankedSearchResult => ({
  symbolKey: overrides.symbolKey ?? 'src/foo#helper',
  qualifiedName: overrides.qualifiedName ?? 'src/foo#helper',
  localName: overrides.localName ?? 'helper',
  kind: overrides.kind ?? 'function_declaration',
  scopeTier: overrides.scopeTier ?? 'exported',
  filePath: overrides.filePath ?? 'src/foo.ts',
  startLine: overrides.startLine ?? 1,
  endLine: overrides.endLine ?? 1,
  exportNames: overrides.exportNames ?? ['helper'],
  matchedBy: overrides.matchedBy ?? 'exact_export',
  confidence: overrides.confidence ?? 'exact',
  snippet: overrides.snippet,
  rankScore: overrides.rankScore ?? 900,
})

const stubDeps = (results: readonly RankedSearchResult[]): CodeindexToolDeps => ({
  codeSearch: (): ReturnType<CodeindexToolDeps['codeSearch']> => Promise.resolve(results),
  codeSymbol: (): ReturnType<CodeindexToolDeps['codeSymbol']> => Promise.resolve(results),
  codeImpact: (): ReturnType<CodeindexToolDeps['codeImpact']> => Promise.resolve([]),
  codeIndex: (): ReturnType<CodeindexToolDeps['codeIndex']> =>
    Promise.resolve({
      filesIndexed: 0,
      filesFailed: 0,
      filesPruned: 0,
      skippedFiles: [],
      skippedFilesTotal: 0,
      symbolsIndexed: 0,
      referencesIndexed: 0,
      referencesUnresolved: 0,
      referencesRepaired: 0,
      elapsedMs: 0,
    } satisfies IndexSummary),
})

const callSearch = async (
  deps: CodeindexToolDeps,
  args: Record<string, unknown>,
): Promise<ReturnType<typeof CodeSearchOutputSchema.parse>> => {
  const client = await connectClient(createCodeindexServer(deps))
  const result = await client.callTool({ name: 'code_search', arguments: { query: 'helper', ...args } })
  expect(result.isError).not.toBe(true)
  return CodeSearchOutputSchema.parse(result.structuredContent)
}

const callSymbol = async (
  deps: CodeindexToolDeps,
  args: Record<string, unknown>,
): Promise<ReturnType<typeof CodeSymbolOutputSchema.parse>> => {
  const client = await connectClient(createCodeindexServer(deps))
  const result = await client.callTool({ name: 'code_symbol', arguments: { query: 'helper', ...args } })
  expect(result.isError).not.toBe(true)
  return CodeSymbolOutputSchema.parse(result.structuredContent)
}

const buildSeededDb = (): Database => {
  const db = new Database(':memory:')
  openDbs.push(db)
  ensureSchema(db)
  seedFile(db, { id: 1, filePath: 'src/exact.ts', moduleKey: 'src/exact' })
  seedFile(db, { id: 2, filePath: 'src/fts-only.ts', moduleKey: 'src/fts-only' })
  seedSymbol(db, {
    id: 1,
    fileId: 1,
    filePath: 'src/exact.ts',
    moduleKey: 'src/exact',
    localName: 'previewAnchor',
    qualifiedName: 'src/exact#previewAnchor',
  })
  db.query(`UPDATE symbols SET body_text = ?, signature_text = ? WHERE id = 1`).run(
    Array.from(
      { length: 20 },
      (_, i) => `// body-line-${i} for previewAnchor padding to force multi-line snippets`,
    ).join('\n'),
    'export function previewAnchor(): void',
  )
  db.query(`UPDATE symbols SET identifier_terms = 'previewanchor helper' WHERE id = 1`).run()
  // Keep FTS in sync with the updated body (the insert trigger already ran).
  db.query(`INSERT INTO symbol_fts(symbol_fts) VALUES('rebuild')`).run()
  seedSymbol(db, {
    id: 2,
    fileId: 2,
    filePath: 'src/fts-only.ts',
    moduleKey: 'src/fts-only',
    localName: 'unrelatedHelper',
    qualifiedName: 'src/fts-only#unrelatedHelper',
  })
  db.query(`UPDATE symbols SET identifier_terms = 'previewanchor fts only mention' WHERE id = 2`).run()
  db.query(`INSERT INTO symbol_fts(symbol_fts) VALUES('rebuild')`).run()
  return db
}

describe('preview mode selects snippet density', () => {
  test('default preview is none: single-line snippet ≤160 chars with ellipsis when truncated', async () => {
    const longLine = `export function helper() { ${'x'.repeat(200)} }`
    const multiLine = [longLine, 'const a = 1', 'const b = 2'].join('\n')
    const payload = await callSearch(stubDeps([rankedResult({ snippet: multiLine })]), {})

    expect(payload.results).toHaveLength(1)
    const snippet = payload.results[0]!.snippet
    expect(snippet).not.toContain('\n')
    expect(snippet.length).toBeLessThanOrEqual(ANCHOR_MAX_CHARS)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet.startsWith('export function helper()')).toBe(true)
  })

  test('default preview none keeps a short first line intact without ellipsis', async () => {
    const multiLine = ['export function helper() {}', 'const leftover = 1'].join('\n')
    const payload = await callSearch(stubDeps([rankedResult({ snippet: multiLine })]), {})
    expect(payload.results[0]!.snippet).toBe('export function helper() {}')
  })

  test('preview short is at most 10 lines with middle elision on longer bodies', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`)
    const payload = await callSearch(stubDeps([rankedResult({ snippet: lines.join('\n') })]), {
      preview: 'short',
    })
    const outLines = payload.results[0]!.snippet.split('\n')
    expect(outLines.length).toBeLessThanOrEqual(SHORT_MAX_LINES)
    expect(outLines).toContain('…')
    expect(outLines[0]).toBe('line-0')
    expect(outLines[outLines.length - 1]).toBe('line-19')
    // Middle elision: head kept, tail kept, middle dropped.
    expect(outLines).not.toContain('line-10')
  })

  test('preview short passes through a snippet that already fits in 10 lines', async () => {
    const lines = Array.from({ length: 8 }, (_, i) => `line-${i}`)
    const payload = await callSearch(stubDeps([rankedResult({ snippet: lines.join('\n') })]), {
      preview: 'short',
    })
    expect(payload.results[0]!.snippet).toBe(lines.join('\n'))
  })

  test('preview full passes the snippet through unchanged', async () => {
    const multiLine = ['export function helper() {', '  return 1', '}'].join('\n')
    const payload = await callSearch(stubDeps([rankedResult({ snippet: multiLine })]), {
      preview: 'full',
    })
    expect(payload.results[0]!.snippet).toBe(multiLine)
  })

  test('code_symbol applies the same preview default and modes', async () => {
    const longLine = `export function helper() { ${'y'.repeat(180)} }`
    const defaultPayload = await callSymbol(stubDeps([rankedResult({ snippet: longLine })]), {})
    expect(defaultPayload.results[0]!.snippet).not.toContain('\n')
    expect(defaultPayload.results[0]!.snippet.length).toBeLessThanOrEqual(ANCHOR_MAX_CHARS)

    const fullPayload = await callSymbol(stubDeps([rankedResult({ snippet: longLine })]), { preview: 'full' })
    expect(fullPayload.results[0]!.snippet).toBe(longLine)
  })
})

describe('preview does not change ranking', () => {
  const multiRank = [
    rankedResult({
      symbolKey: 'src/a#alpha',
      qualifiedName: 'src/a#alpha',
      localName: 'alpha',
      snippet: ['export const alpha = 1', 'export const alphaExtra = 2'].join('\n'),
      rankScore: 950,
    }),
    rankedResult({
      symbolKey: 'src/b#beta',
      qualifiedName: 'src/b#beta',
      localName: 'beta',
      snippet: ['export const beta = 1', 'export const betaExtra = 2', 'export const more = 3'].join('\n'),
      rankScore: 800,
    }),
  ]

  test('same query keeps symbolKey order and rankScore across none/short/full', async () => {
    const none = await callSearch(stubDeps(multiRank), { preview: 'none' })
    const short = await callSearch(stubDeps(multiRank), { preview: 'short' })
    const full = await callSearch(stubDeps(multiRank), { preview: 'full' })

    const keys = (payload: typeof none): string[] => payload.results.map((row) => row.symbolKey)
    const scores = (payload: typeof none): number[] => payload.results.map((row) => row.rankScore)

    expect(keys(none)).toEqual(keys(short))
    expect(keys(none)).toEqual(keys(full))
    expect(keys(none)).toEqual(['src/a#alpha', 'src/b#beta'])
    expect(scores(none)).toEqual(scores(short))
    expect(scores(none)).toEqual(scores(full))
    expect(scores(none)).toEqual([950, 800])
  })
})

describe('exact-first is preserved under preview none', () => {
  test('exact hits still precede FTS-only hits at default preview', async () => {
    const db = buildSeededDb()
    const payload = await callSearch(makeInMemoryDeps(db), { query: 'previewAnchor' })

    expect(payload.results.length).toBeGreaterThanOrEqual(1)
    const matched = payload.results.map((row) => row.matchedBy)
    const firstFts = matched.indexOf('fts')
    if (firstFts !== -1) {
      const lastExact =
        matched
          .map((m, i) => (m === 'fts' ? -1 : i))
          .filter((i) => i !== -1)
          .pop() ?? -1
      expect(lastExact).toBeLessThan(firstFts)
    }
    expect(payload.results[0]!.matchedBy).not.toBe('fts')
    expect(payload.results[0]!.snippet).not.toContain('\n')
  })
})
