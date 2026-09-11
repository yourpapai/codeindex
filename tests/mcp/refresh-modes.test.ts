import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadConfigForPath } from '../../src/cli.js'
import type { CodeindexConfig } from '../../src/config.js'
import type { IndexSummary } from '../../src/indexer/index-codebase.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import { withFreshness } from '../../src/mcp/freshness.js'
import { withRefresh } from '../../src/mcp/refresh.js'
import { createReindexScheduler, type ReindexMode, type ReindexScheduler } from '../../src/mcp/reindex-scheduler.js'
import { createCodeindexServer } from '../../src/mcp/server.js'
import {
  CodeImpactInputSchema,
  CodeSearchInputSchema,
  CodeSymbolInputSchema,
  CodeSearchOutputSchema,
} from '../../src/mcp/tools.js'
import type { WatcherState } from '../../src/mcp/tools.js'
import { findSymbolCandidates, searchSymbols } from '../../src/search/index.js'
import { openDatabase } from '../../src/storage/db.js'
import { connectClient } from './harness.js'

const tempDirs: string[] = []

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const emptySummary: IndexSummary = {
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
}

const makeRepo = (symbolName: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-refresh-modes-'))
  tempDirs.push(dir)
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
  writeFileSync(path.join(dir, 'src', 'thing.ts'), `export const ${symbolName} = (): number => 1\n`)
  return dir
}

interface SubmitSpy {
  readonly modes: ReindexMode[]
  readonly run: (input: Readonly<{ mode: ReindexMode }>) => Promise<IndexSummary>
}

const makeSubmitSpy = (delayMs = 0): SubmitSpy => {
  const modes: ReindexMode[] = []
  return {
    modes,
    run: ({ mode }: Readonly<{ mode: ReindexMode }>): Promise<IndexSummary> => {
      modes.push(mode)
      if (delayMs <= 0) {
        return Promise.resolve({ ...emptySummary, filesIndexed: 1 })
      }
      return new Promise((resolve) => {
        setTimeout(() => resolve({ ...emptySummary, filesIndexed: 1 }), delayMs)
      })
    },
  }
}

const makeDirtyRepo = (): { dir: string; filePath: string } => {
  const dir = makeRepo('alphaBeacon')
  const filePath = path.join(dir, 'src', 'thing.ts')
  // mtime far in the future relative to any index run so probeDirty/freshness see drift
  const future = new Date(Date.now() + 60_000)
  utimesSync(filePath, future, future)
  writeFileSync(filePath, 'export const alphaBeacon = (): number => 2\n')
  return { dir, filePath }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('refresh parameter schema', () => {
  test('omitting refresh defaults to background on all three query tools', () => {
    expect(CodeSearchInputSchema.parse({ query: 'alpha' }).refresh).toBe('background')
    expect(CodeSymbolInputSchema.parse({ query: 'alpha' }).refresh).toBe('background')
    expect(CodeImpactInputSchema.parse({ qualifiedName: 'src/thing#alpha' }).refresh).toBe('background')
  })

  test('explicit background, wait, and off are accepted', () => {
    expect(CodeSearchInputSchema.parse({ query: 'alpha', refresh: 'background' }).refresh).toBe('background')
    expect(CodeSearchInputSchema.parse({ query: 'alpha', refresh: 'wait' }).refresh).toBe('wait')
    expect(CodeSearchInputSchema.parse({ query: 'alpha', refresh: 'off' }).refresh).toBe('off')
    expect(CodeSymbolInputSchema.parse({ query: 'alpha', refresh: 'off' }).refresh).toBe('off')
    expect(CodeImpactInputSchema.parse({ qualifiedName: 'src/thing#alpha', refresh: 'wait' }).refresh).toBe('wait')
  })

  test('invalid refresh values are rejected', () => {
    expect(CodeSearchInputSchema.safeParse({ query: 'alpha', refresh: 'now' }).success).toBe(false)
  })
})

describe('default and off do not submit a reindex', () => {
  test('omitting refresh does not submit', async () => {
    const spy = makeSubmitSpy()
    const server = createCodeindexServer({
      codeSearch: () => Promise.resolve([]),
      codeSymbol: () => Promise.resolve([]),
      codeImpact: () => Promise.resolve({ resolution: { status: 'unresolved' as const }, results: [] }),
      codeIndex: spy.run,
      getIndexFreshness: () => 'possibly_stale',
    })
    const client = await connectClient(server)

    const result = await client.callTool({ name: 'code_search', arguments: { query: 'alpha' } })
    expect(result.isError).not.toBe(true)
    expect(spy.modes).toEqual([])
  })

  test('refresh off does not submit', async () => {
    const spy = makeSubmitSpy()
    const server = createCodeindexServer({
      codeSearch: () => Promise.resolve([]),
      codeSymbol: () => Promise.resolve([]),
      codeImpact: () => Promise.resolve({ resolution: { status: 'unresolved' as const }, results: [] }),
      codeIndex: spy.run,
      getIndexFreshness: () => 'possibly_stale',
    })
    const client = await connectClient(server)

    const search = await client.callTool({
      name: 'code_search',
      arguments: { query: 'alpha', refresh: 'off' },
    })
    expect(search.isError).not.toBe(true)
    const symbol = await client.callTool({
      name: 'code_symbol',
      arguments: { query: 'alpha', refresh: 'off' },
    })
    expect(symbol.isError).not.toBe(true)
    const impact = await client.callTool({
      name: 'code_impact',
      arguments: { qualifiedName: 'src/thing#alpha', refresh: 'off' },
    })
    expect(impact.isError).not.toBe(true)
    expect(spy.modes).toEqual([])
  })

  test('default and off still return honest freshness marks on a dirty index', async () => {
    const { dir } = makeDirtyRepo()
    const config = await loadConfigForPath(dir)
    const spy = makeSubmitSpy()
    const deps = withFreshness(
      {
        codeSearch: () => Promise.resolve([]),
        codeSymbol: () => Promise.resolve([]),
        codeImpact: () => Promise.resolve({ resolution: { status: 'unresolved' as const }, results: [] }),
        codeIndex: spy.run,
      },
      config,
      () => ({ indexFreshness: 'possibly_stale' as const }),
    )
    const client = await connectClient(createCodeindexServer(deps))

    const omitted = await client.callTool({ name: 'code_search', arguments: { query: 'alphaBeacon' } })
    expect(omitted.isError).not.toBe(true)
    const omittedPayload = CodeSearchOutputSchema.parse(omitted.structuredContent)
    expect(omittedPayload.indexFreshness).toBe('possibly_stale')

    const off = await client.callTool({
      name: 'code_search',
      arguments: { query: 'alphaBeacon', refresh: 'off' },
    })
    expect(off.isError).not.toBe(true)
    const offPayload = CodeSearchOutputSchema.parse(off.structuredContent)
    expect(offPayload.indexFreshness).toBe('possibly_stale')
    expect(spy.modes).toEqual([])
  })
})

interface WaitFixture {
  readonly dir: string
  readonly config: CodeindexConfig
  readonly scheduler: ReindexScheduler
  readonly modes: ReindexMode[]
  readonly buildServer: (watcherState?: () => WatcherState) => ReturnType<typeof createCodeindexServer>
}

const makeIndexedRepo = async (): Promise<WaitFixture> => {
  const dir = makeRepo('waitBeacon')
  const config = await loadConfigForPath(dir)
  await indexCodebase({ config, mode: 'full' })
  const modes: ReindexMode[] = []
  const scheduler = createReindexScheduler(({ mode }: Readonly<{ mode: ReindexMode }>) => {
    modes.push(mode)
    return indexCodebase({ config, mode })
  })
  const buildServer = (watcherState?: () => WatcherState): ReturnType<typeof createCodeindexServer> => {
    const getState =
      watcherState ??
      ((): WatcherState => ({ status: 'idle', pendingEvents: 0, lastError: null, lastCompletedAt: null }))
    const base = withFreshness(
      {
        codeSearch: (input): Promise<ReturnType<typeof searchSymbols>> => {
          const db = openDatabase(config.dbPath)
          try {
            return Promise.resolve(searchSymbols(db, input))
          } finally {
            db.close()
          }
        },
        codeSymbol: (query, limit): Promise<ReturnType<typeof findSymbolCandidates>> => {
          const db = openDatabase(config.dbPath)
          try {
            return Promise.resolve(findSymbolCandidates(db, query, limit))
          } finally {
            db.close()
          }
        },
        codeImpact: () => Promise.resolve({ resolution: { status: 'unresolved' as const }, results: [] }),
        codeIndex: (input) => scheduler.submit(input),
      },
      config,
      () => ({ indexFreshness: 'fresh' as const }),
    )
    return createCodeindexServer(
      withRefresh(base, config, {
        submit: (input) => scheduler.submit(input),
        getWatcherState: getState,
      }),
    )
  }
  return { dir, config, scheduler, modes, buildServer }
}

const idleWatcherState = (): WatcherState => ({
  status: 'idle',
  pendingEvents: 0,
  lastError: null,
  lastCompletedAt: null,
})

describe('refresh wait', () => {
  test('dirty index + wait submits one incremental then returns the new symbol', async () => {
    const fixture = await makeIndexedRepo()
    writeFileSync(
      path.join(fixture.dir, 'src', 'thing.ts'),
      'export const waitBeacon = (): number => 1\nexport const afterEditBeacon = (): number => 2\n',
    )
    const client = await connectClient(fixture.buildServer(idleWatcherState))

    const result = await client.callTool({
      name: 'code_search',
      arguments: { query: 'afterEditBeacon', refresh: 'wait' },
    })
    expect(result.isError).not.toBe(true)
    expect(fixture.modes).toEqual(['incremental'])
    const payload = CodeSearchOutputSchema.parse(result.structuredContent)
    expect(payload.results.some((row) => row.localName === 'afterEditBeacon')).toBe(true)
  })

  test('clean index + wait submits nothing', async () => {
    const fixture = await makeIndexedRepo()
    const client = await connectClient(fixture.buildServer(idleWatcherState))

    const result = await client.callTool({
      name: 'code_search',
      arguments: { query: 'waitBeacon', refresh: 'wait' },
    })
    expect(result.isError).not.toBe(true)
    expect(fixture.modes).toEqual([])
    const payload = CodeSearchOutputSchema.parse(result.structuredContent)
    expect(payload.indexFreshness).toBe('fresh')
  })

  test('multiple waits on a dirty index never submit full', async () => {
    const fixture = await makeIndexedRepo()
    writeFileSync(
      path.join(fixture.dir, 'src', 'thing.ts'),
      'export const waitBeacon = (): number => 1\nexport const multiWaitBeacon = (): number => 2\n',
    )
    const client = await connectClient(fixture.buildServer(idleWatcherState))

    const [a, b] = await Promise.all([
      client.callTool({ name: 'code_search', arguments: { query: 'multiWaitBeacon', refresh: 'wait' } }),
      client.callTool({ name: 'code_search', arguments: { query: 'multiWaitBeacon', refresh: 'wait' } }),
    ])
    expect(a.isError).not.toBe(true)
    expect(b.isError).not.toBe(true)
    expect(fixture.modes.every((mode) => mode === 'incremental')).toBe(true)
    expect(fixture.modes.length).toBeGreaterThanOrEqual(1)
    expect(fixture.modes.length).toBeLessThanOrEqual(2)
  })

  test('wait while catching_up joins without an extra submit', async () => {
    const dir = makeRepo('joinBeacon')
    const config = await loadConfigForPath(dir)
    const modes: ReindexMode[] = []
    let releaseRun: (() => void) | null = null
    const scheduler = createReindexScheduler(({ mode }: Readonly<{ mode: ReindexMode }>) => {
      modes.push(mode)
      return new Promise<IndexSummary>((resolve) => {
        releaseRun = (): void => {
          resolve(emptySummary)
        }
        // Auto-complete after a short delay so the test cannot hang.
        setTimeout(() => {
          if (releaseRun !== null) {
            const release = releaseRun
            releaseRun = null
            release()
          }
        }, 50)
      })
    })
    // Kick off an active run the wait will join.
    const active = scheduler.submit({ mode: 'incremental' })
    await delay(5)

    const base = withFreshness(
      {
        codeSearch: (): Promise<readonly never[]> => Promise.resolve([]),
        codeSymbol: (): Promise<readonly never[]> => Promise.resolve([]),
        codeImpact: () => Promise.resolve({ resolution: { status: 'unresolved' as const }, results: [] }),
        codeIndex: (input) => scheduler.submit(input),
      },
      config,
      () => ({ indexFreshness: 'fresh' as const }),
    )
    const client = await connectClient(
      createCodeindexServer(
        withRefresh(base, config, {
          submit: (input) => scheduler.submit(input),
          whenSettled: (): Promise<void> => scheduler.whenSettled(),
          getWatcherState: (): WatcherState => ({
            status: 'catching_up',
            pendingEvents: 0,
            lastError: null,
            lastCompletedAt: null,
          }),
        }),
      ),
    )

    // Empty DB is dirty, so after join a probe may still submit one shared follow-up.
    // Join itself must not use submit — total runs stay at most active + one follow-up.
    const result = await client.callTool({ name: 'code_search', arguments: { query: 'joinBeacon', refresh: 'wait' } })
    await active
    expect(result.isError).not.toBe(true)
    expect(modes.every((mode) => mode === 'incremental')).toBe(true)
    expect(modes.length).toBeLessThanOrEqual(2)
  })
})

describe('wait timeout honesty', () => {
  test('slow incremental + wait returns possibly_stale results without hanging or throwing', async () => {
    const dir = makeRepo('slowBeacon')
    const config = await loadConfigForPath(dir)
    const modes: ReindexMode[] = []
    const base = withFreshness(
      {
        codeSearch: (): Promise<readonly never[]> => Promise.resolve([]),
        codeSymbol: (): Promise<readonly never[]> => Promise.resolve([]),
        codeImpact: () => Promise.resolve({ resolution: { status: 'unresolved' as const }, results: [] }),
        codeIndex: (input) => {
          modes.push(input.mode)
          return new Promise<IndexSummary>((resolve) => {
            setTimeout(() => resolve(emptySummary), 400)
          })
        },
      },
      config,
      () => ({ indexFreshness: 'possibly_stale' as const }),
    )
    const server = createCodeindexServer(
      withRefresh(base, config, {
        submit: (input) => {
          modes.push(input.mode)
          return new Promise<IndexSummary>((resolve) => {
            setTimeout(() => resolve(emptySummary), 400)
          })
        },
        getWatcherState: idleWatcherState,
        timeoutMs: 40,
      }),
    )
    const client = await connectClient(server)

    const startedAt = Date.now()
    const result = await client.callTool({
      name: 'code_search',
      arguments: { query: 'slowBeacon', refresh: 'wait' },
    })
    const elapsedMs = Date.now() - startedAt

    expect(result.isError).not.toBe(true)
    expect(elapsedMs).toBeLessThan(300)
    const payload = CodeSearchOutputSchema.parse(result.structuredContent)
    expect(payload.indexFreshness).toBe('possibly_stale')
    expect(modes.every((mode) => mode === 'incremental')).toBe(true)
  })
})
