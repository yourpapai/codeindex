import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'

import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { TextContent } from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod'

import type { IndexSummary } from '../../src/indexer/index-codebase.js'
import { withFreshness, type IndexFreshnessStateProvider } from '../../src/mcp/freshness.js'
import { createReindexScheduler } from '../../src/mcp/reindex-scheduler.js'
import { createCodeindexServer } from '../../src/mcp/server.js'
import {
  CodeImpactOutputSchema,
  CodeIndexOutputSchema,
  CodeSearchOutputSchema,
  CodeSymbolOutputSchema,
  type CodeindexToolDeps,
  type WatcherState,
} from '../../src/mcp/tools.js'
import { ensureSchema } from '../../src/storage/schema.js'
import { connectClient, makeInMemoryDeps, seedFile, seedSymbol } from './harness.js'

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const openDbs: Database[] = []

const buildSeededDb = (): Database => {
  const db = new Database(':memory:')
  openDbs.push(db)
  ensureSchema(db)
  seedFile(db, { id: 1, filePath: 'src/search/index.ts', moduleKey: 'src/search/index' })
  seedFile(db, { id: 2, filePath: 'src/storage/db.ts', moduleKey: 'src/storage/db' })
  seedSymbol(db, {
    id: 1,
    fileId: 1,
    filePath: 'src/search/index.ts',
    moduleKey: 'src/search/index',
    localName: 'searchSymbols',
    qualifiedName: 'src/search/index#searchSymbols',
  })
  seedSymbol(db, {
    id: 2,
    fileId: 2,
    filePath: 'src/storage/db.ts',
    moduleKey: 'src/storage/db',
    localName: 'openDatabase',
    qualifiedName: 'src/storage/db#openDatabase',
  })
  db.query(
    `INSERT INTO symbol_references (source_symbol_id, source_file_id, target_symbol_id, target_file_id, target_name, target_export_name, target_module_specifier, edge_type, confidence, line_number)
     VALUES (1, 1, 2, 2, 'openDatabase', NULL, '../storage/db', 'calls', 'resolved', 5)`,
  ).run()
  return db
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    db.close()
  }
})

describe('MCP protocol boundary', () => {
  test('listTools exposes all four tools', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const listed = await client.listTools()
    const names = listed.tools.map((tool) => tool.name).sort()
    expect(names).toEqual(['code_impact', 'code_index', 'code_search', 'code_symbol'])
  })

  test('code_search returns a structured hit for a known symbol', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const result = await client.callTool({ name: 'code_search', arguments: { query: 'searchSymbols' } })
    expect(result.isError).not.toBe(true)
    const payload = CodeSearchOutputSchema.parse(result.structuredContent)
    expect(payload.resultCount).toBeGreaterThanOrEqual(1)
    expect(payload.results.some((row) => row.qualifiedName === 'src/search/index#searchSymbols')).toBe(true)
    expect(payload.guidance).toBeUndefined()
  })

  test('code_search on no match returns the guidance string', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const result = await client.callTool({ name: 'code_search', arguments: { query: 'zzz_nonexistent_symbol' } })
    const payload = CodeSearchOutputSchema.parse(result.structuredContent)
    expect(payload.resultCount).toBe(0)
    expect(typeof payload.guidance).toBe('string')
    expect(payload.guidance).toContain('No symbol matches')
  })

  test('code_symbol returns candidates with no guidance field', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const result = await client.callTool({ name: 'code_symbol', arguments: { query: 'openDatabase' } })
    const payload = CodeSymbolOutputSchema.parse(result.structuredContent)
    expect(payload.results.some((row) => row.qualifiedName === 'src/storage/db#openDatabase')).toBe(true)
    expect(result.structuredContent).not.toHaveProperty('guidance')
  })

  test('code_impact resolves incoming references by qualifiedName', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const result = await client.callTool({
      name: 'code_impact',
      arguments: { qualifiedName: 'src/storage/db#openDatabase' },
    })
    const payload = CodeImpactOutputSchema.parse(result.structuredContent)
    expect(payload.results.some((row) => row.sourceQualifiedName === 'src/search/index#searchSymbols')).toBe(true)
  })

  test('code_impact without symbolKey or qualifiedName is a tool error', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const result = await client.callTool({ name: 'code_impact', arguments: { limit: 5 } })
    expect(result.isError).toBe(true)
    const parsed = CallToolResultSchema.parse(result)
    const block = parsed.content.find((entry): entry is TextContent => entry.type === 'text')
    expect(block).toBeDefined()
    expect(block!.text).toContain('symbolKey or qualifiedName')
  })

  test('code_search with an invalid mode is rejected at the boundary', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const result = await client.callTool({
      name: 'code_search',
      arguments: { query: 'searchSymbols', mode: 'semantic' },
    })
    expect(result.isError).toBe(true)
  })

  test('code_search mode flows through to the search pool', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    for (const mode of ['exact', 'fts', 'fused'] as const) {
      const result = await client.callTool({ name: 'code_search', arguments: { query: 'searchSymbols', mode } })
      expect(result.isError).not.toBe(true)
      const payload = CodeSearchOutputSchema.parse(result.structuredContent)
      const expected = mode === 'fts' ? 'fts' : undefined
      for (const row of payload.results) {
        if (expected === 'fts') {
          expect(row.matchedBy).toBe('fts')
        } else {
          expect(row.matchedBy).not.toBe('fts')
        }
      }
    }
  })

  test('code_search results carry matchedBy and no matchReason in structuredContent', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const result = await client.callTool({ name: 'code_search', arguments: { query: 'searchSymbols' } })
    expect(result.isError).not.toBe(true)
    const structured = CodeSearchOutputSchema.parse(result.structuredContent)
    expect(structured.results.length).toBeGreaterThanOrEqual(1)
    expect(structured.results.every((row) => typeof row.matchedBy === 'string')).toBe(true)
    expect(structured.results.every((row) => !('matchReason' in row))).toBe(true)
    const textBlock = CallToolResultSchema.parse(result).content.find(
      (entry): entry is TextContent => entry.type === 'text',
    )
    expect(textBlock).toBeDefined()
    expect(textBlock!.text).toContain('src/search/index#searchSymbols')
  })

  test('code_symbol results carry matchedBy and no matchReason', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const result = await client.callTool({ name: 'code_symbol', arguments: { query: 'openDatabase' } })
    expect(result.isError).not.toBe(true)
    const structured = CodeSymbolOutputSchema.parse(result.structuredContent)
    expect(structured.results.length).toBeGreaterThanOrEqual(1)
    expect(structured.results.every((row) => typeof row.matchedBy === 'string')).toBe(true)
    expect(structured.results.every((row) => !('matchReason' in row))).toBe(true)
  })

  test('code_search with a missing query is a validation error', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const result = await client.callTool({ name: 'code_search', arguments: {} })
    expect(result.isError).toBe(true)
  })
})

describe('watcher state reporting', () => {
  const watcherState: WatcherState = {
    status: 'catching_up',
    pendingEvents: 3,
    lastError: null,
    lastCompletedAt: 42,
  }

  const depsWithWatcher = (summary: IndexSummary): CodeindexToolDeps => ({
    codeSearch: (): ReturnType<CodeindexToolDeps['codeSearch']> => Promise.resolve([]),
    codeSymbol: (): ReturnType<CodeindexToolDeps['codeSymbol']> => Promise.resolve([]),
    codeImpact: (): ReturnType<CodeindexToolDeps['codeImpact']> => Promise.resolve([]),
    codeIndex: (): ReturnType<CodeindexToolDeps['codeIndex']> => Promise.resolve(summary),
    getWatcherState: (): WatcherState => watcherState,
  })

  test('code_index carries watcher state in text and structuredContent', async () => {
    const summary: IndexSummary = {
      filesIndexed: 1,
      filesFailed: 0,
      filesPruned: 0,
      skippedFiles: [],
      skippedFilesTotal: 0,
      symbolsIndexed: 2,
      referencesIndexed: 1,
      referencesUnresolved: 0,
      elapsedMs: 1,
    }
    const client = await connectClient(createCodeindexServer(depsWithWatcher(summary)))
    const result = CallToolResultSchema.parse(
      await client.callTool({ name: 'code_index', arguments: { mode: 'incremental' } }),
    )
    const payload = CodeIndexOutputSchema.parse(result.structuredContent)
    expect(payload.watcher).toEqual(watcherState)
    const text = textBlockOf(result)
    expect(text).toContain('(watcher: catching_up)')
  })

  test('a code_index call during an active run joins the queue and reports catching_up', async () => {
    let runCount = 0
    let releaseFirst: (() => void) | null = null
    const summary: IndexSummary = {
      filesIndexed: 1,
      filesFailed: 0,
      filesPruned: 0,
      skippedFiles: [],
      skippedFilesTotal: 0,
      symbolsIndexed: 0,
      referencesIndexed: 0,
      referencesUnresolved: 0,
      elapsedMs: 1,
    }
    const runner = async (): Promise<IndexSummary> => {
      runCount += 1
      if (runCount === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
      }
      return summary
    }
    const scheduler = createReindexScheduler(runner)
    const deps: CodeindexToolDeps = {
      codeSearch: (): ReturnType<CodeindexToolDeps['codeSearch']> => Promise.resolve([]),
      codeSymbol: (): ReturnType<CodeindexToolDeps['codeSymbol']> => Promise.resolve([]),
      codeImpact: (): ReturnType<CodeindexToolDeps['codeImpact']> => Promise.resolve([]),
      codeIndex: ({ mode }): ReturnType<CodeindexToolDeps['codeIndex']> => scheduler.submit({ mode }),
      getWatcherState: (): WatcherState => watcherState,
    }
    const client = await connectClient(createCodeindexServer(deps))

    void scheduler.submit({ mode: 'incremental' })
    const pending = client.callTool({ name: 'code_index', arguments: { mode: 'incremental' } })
    await delay(50)
    expect(runCount).toBe(1)
    expect(scheduler.isBusy()).toBe(true)

    releaseFirst!()
    const result = CallToolResultSchema.parse(await pending)
    const payload = CodeIndexOutputSchema.parse(result.structuredContent)
    expect(payload.watcher).toEqual(watcherState)
    expect(runCount).toBe(2)
    const text = textBlockOf(result)
    expect(text).toContain('(watcher: catching_up)')
  })
})

describe('code_index payload honesty', () => {
  const depsWithIndexSummary = (summary: IndexSummary): CodeindexToolDeps => ({
    codeSearch: (): ReturnType<CodeindexToolDeps['codeSearch']> => Promise.resolve([]),
    codeSymbol: (): ReturnType<CodeindexToolDeps['codeSymbol']> => Promise.resolve([]),
    codeImpact: (): ReturnType<CodeindexToolDeps['codeImpact']> => Promise.resolve([]),
    codeIndex: (): ReturnType<CodeindexToolDeps['codeIndex']> => Promise.resolve(summary),
  })

  interface CodeIndexToolResult {
    readonly structuredContent: z.output<typeof CodeIndexOutputSchema>
    readonly content: readonly { readonly type: string; readonly text: string }[]
  }

  const callCodeIndexTool = async (
    deps: CodeindexToolDeps,
    args: { mode: 'full' | 'incremental' },
  ): Promise<CodeIndexToolResult> => {
    const client = await connectClient(createCodeindexServer(deps))
    const result = CallToolResultSchema.parse(await client.callTool({ name: 'code_index', arguments: args }))
    const block = result.content.find((entry): entry is TextContent => entry.type === 'text')
    return {
      structuredContent: CodeIndexOutputSchema.parse(result.structuredContent),
      content: [{ type: 'text', text: block?.text ?? '' }],
    }
  }

  test('code_index caps skippedFiles in the payload and reports the total', async () => {
    const skipped = Array.from({ length: 25 }, (_, i) => `src/skip-${i}.ts`)
    const summary: IndexSummary = {
      filesIndexed: 1,
      filesFailed: 0,
      filesPruned: 0,
      skippedFiles: skipped,
      skippedFilesTotal: 25,
      symbolsIndexed: 1,
      referencesIndexed: 0,
      referencesUnresolved: 0,
      elapsedMs: 1,
    }
    const result = await callCodeIndexTool(depsWithIndexSummary(summary), { mode: 'incremental' })
    expect(result.structuredContent).toMatchObject({ skippedFilesTotal: 25 })
    expect(result.structuredContent.skippedFiles).toHaveLength(20)
    expect(result.content[0]!.type).toBe('text')
    expect(result.content[0]!.text).toContain(', 25 skipped')
  })

  test('code_index summaryText omits the skipped suffix when nothing is skipped', async () => {
    const summary: IndexSummary = {
      filesIndexed: 3,
      filesFailed: 0,
      filesPruned: 0,
      skippedFiles: [],
      skippedFilesTotal: 0,
      symbolsIndexed: 10,
      referencesIndexed: 5,
      referencesUnresolved: 0,
      elapsedMs: 1,
    }
    const result = await callCodeIndexTool(depsWithIndexSummary(summary), { mode: 'incremental' })
    expect(result.content[0]!.text).toBe('Indexed 3 files, 10 symbols, 5 references')
  })
})

const possiblyStaleProvider: IndexFreshnessStateProvider = () => ({ indexFreshness: 'possibly_stale' })

const wrappedFreshnessDeps = (
  db: Database,
  stateProvider: IndexFreshnessStateProvider = possiblyStaleProvider,
): CodeindexToolDeps => withFreshness(makeInMemoryDeps(db), { repoRoot: tmpdir(), dbPath: ':memory:' }, stateProvider)

const textBlockOf = (result: {
  readonly content: readonly { readonly type: string; readonly text?: string }[]
}): string => result.content.find((entry) => entry.type === 'text')?.text ?? ''

describe('freshness protocol surface', () => {
  test('code_search carries per-result freshness and response-level indexFreshness in both payloads', async () => {
    const client = await connectClient(createCodeindexServer(wrappedFreshnessDeps(buildSeededDb())))
    const result = await client.callTool({ name: 'code_search', arguments: { query: 'searchSymbols' } })
    const payload = CodeSearchOutputSchema.parse(result.structuredContent)
    expect(payload.indexFreshness).toBe('possibly_stale')
    expect(payload.results.length).toBeGreaterThanOrEqual(1)
    expect(payload.results.every((row) => row.freshness === 'possibly_stale')).toBe(true)
    const text = textBlockOf(CallToolResultSchema.parse(result))
    expect(text).toContain('(indexFreshness: possibly_stale')
    expect(text).toContain(`; ${payload.results.length} of ${payload.results.length} hits possibly_stale`)
  })

  test('code_search carries fresh response-level state from the provider', async () => {
    const client = await connectClient(
      createCodeindexServer(wrappedFreshnessDeps(buildSeededDb(), () => ({ indexFreshness: 'fresh' }))),
    )
    const result = await client.callTool({ name: 'code_search', arguments: { query: 'zzz_nonexistent_symbol' } })
    const payload = CodeSearchOutputSchema.parse(result.structuredContent)
    expect(payload.indexFreshness).toBe('fresh')
    const text = textBlockOf(CallToolResultSchema.parse(result))
    expect(text).toContain('(indexFreshness: fresh)')
  })

  test('code_symbol carries freshness fields and keeps exact matches before FTS', async () => {
    const client = await connectClient(createCodeindexServer(wrappedFreshnessDeps(buildSeededDb())))
    const result = await client.callTool({ name: 'code_symbol', arguments: { query: 'searchSymbols' } })
    const payload = CodeSymbolOutputSchema.parse(result.structuredContent)
    expect(payload.indexFreshness).toBe('possibly_stale')
    expect(payload.results.length).toBeGreaterThanOrEqual(1)
    expect(payload.results.every((row) => row.freshness === 'possibly_stale')).toBe(true)
    expect(payload.results[0]!.qualifiedName).toBe('src/search/index#searchSymbols')
    const text = textBlockOf(CallToolResultSchema.parse(result))
    expect(text).toContain('(indexFreshness: possibly_stale')
  })

  test('code_impact carries freshness fields in both payloads', async () => {
    const client = await connectClient(createCodeindexServer(wrappedFreshnessDeps(buildSeededDb())))
    const result = await client.callTool({
      name: 'code_impact',
      arguments: { qualifiedName: 'src/storage/db#openDatabase' },
    })
    const payload = CodeImpactOutputSchema.parse(result.structuredContent)
    expect(payload.indexFreshness).toBe('possibly_stale')
    expect(payload.results.length).toBeGreaterThanOrEqual(1)
    expect(payload.results.every((row) => row.freshness === 'possibly_stale')).toBe(true)
    const text = textBlockOf(CallToolResultSchema.parse(result))
    expect(text).toContain('(indexFreshness: possibly_stale')
  })
})
