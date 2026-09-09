import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { CodeindexConfig } from '../../src/config.js'
import { loadCodeindexConfig } from '../../src/config.js'
import type { IndexSummary } from '../../src/indexer/index-codebase.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import type { ReindexMode } from '../../src/mcp/reindex-scheduler.js'
import { DEFAULT_DEBOUNCE_MS, createWatcher, type IndexWatcher } from '../../src/mcp/watcher.js'
import { openDatabase } from '../../src/storage/db.js'
import { ensureSchema } from '../../src/storage/schema.js'

const tempDirs: string[] = []
const watchers: IndexWatcher[] = []

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

// Extra wait after an observed idle state so late-delivered FSEvents stragglers and a
// pending debounce timer are absorbed before assertions run.
const SETTLE_MARGIN_MS = 450

interface RunnerSpy {
  readonly calls: ReindexMode[]
  readonly failNext: () => void
  readonly run: (input: Readonly<{ mode: ReindexMode }>) => Promise<IndexSummary>
}

const makeRunnerSpy = (config: CodeindexConfig): RunnerSpy => {
  const calls: ReindexMode[] = []
  let failNext = false
  return {
    calls,
    failNext: (): void => {
      failNext = true
    },
    run: (input: Readonly<{ mode: ReindexMode }>): Promise<IndexSummary> => {
      calls.push(input.mode)
      if (failNext) {
        failNext = false
        throw new Error('injected runner failure')
      }
      return indexCodebase({ config, mode: input.mode })
    },
  }
}

const waitForArmed = async (watcher: IndexWatcher): Promise<void> => {
  const deadline = Date.now() + 5000
  while (!watcher.isArmed()) {
    if (Date.now() > deadline) {
      throw new Error(`watcher did not arm: ${JSON.stringify(watcher.getState())}`)
    }
    await delay(15)
  }
}

const waitForStatus = async (watcher: IndexWatcher, status: 'idle' | 'catching_up' | 'error'): Promise<void> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const state = watcher.getState()
    if (state.status === status) {
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`watcher did not reach ${status}: ${JSON.stringify(state)}`)
    }
    await delay(15)
  }
}

const waitForCatchUpSettled = async (watcher: IndexWatcher): Promise<void> => {
  const deadline = Date.now() + 10_000
  for (;;) {
    const state = watcher.getState()
    if (state.status === 'idle' && state.pendingEvents === 0 && watcher.isArmed()) {
      await delay(SETTLE_MARGIN_MS)
      const after = watcher.getState()
      if (after.status === 'idle' && after.pendingEvents === 0) {
        return
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`watcher catch-up did not settle: ${JSON.stringify(watcher.getState())}`)
    }
    await delay(15)
  }
}

const waitForRecovered = async (watcher: IndexWatcher): Promise<void> => {
  const deadline = Date.now() + 5000
  for (;;) {
    const state = watcher.getState()
    if (state.status === 'idle' && state.lastError === null) {
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`watcher did not recover: ${JSON.stringify(state)}`)
    }
    await delay(15)
  }
}

const makeRepo = (): Promise<CodeindexConfig> => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-watcher-'))
  tempDirs.push(dir)
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({}))
  return loadCodeindexConfig({ configPath: path.join(dir, '.codeindex.json'), repoRoot: dir })
}

const writeSource = (config: CodeindexConfig, filePath: string, content: string): void => {
  const absolutePath = path.join(config.repoRoot, filePath)
  mkdirSync(path.dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, content)
}

const countIndexedFiles = (config: CodeindexConfig): number => {
  const db = openDatabase(config.dbPath)
  try {
    return db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM files').get()!.n
  } finally {
    db.close()
  }
}

const listIndexedFiles = (config: CodeindexConfig): readonly string[] => {
  const db = openDatabase(config.dbPath)
  try {
    return db
      .query<{ file_path: string }, []>('SELECT file_path FROM files')
      .all()
      .map((row) => row.file_path)
  } finally {
    db.close()
  }
}

const buildWatcher = (config: CodeindexConfig, runner: RunnerSpy): IndexWatcher => {
  const watcher = createWatcher(config, (input): Promise<IndexSummary> => runner.run(input))
  watchers.push(watcher)
  return watcher
}

afterEach(() => {
  for (const watcher of watchers.splice(0)) {
    watcher.stop()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('watcher boot probe', () => {
  test('clean index skips the catch-up reindex and stays idle', async () => {
    const config = await makeRepo()
    writeSource(config, 'src/a.ts', 'export const alpha = 1\n')
    await indexCodebase({ config, mode: 'full' })
    const runner = makeRunnerSpy(config)
    const watcher = buildWatcher(config, runner)

    await watcher.start()
    await waitForArmed(watcher)

    expect(runner.calls).toEqual([])
    expect(watcher.getState().status).toBe('idle')
    expect(watcher.getIndexFreshness().indexFreshness).toBe('fresh')
  })

  test('dirty index (mtime newer than indexed_at) runs the catch-up in the background', async () => {
    const config = await makeRepo()
    writeSource(config, 'src/a.ts', 'export const alpha = 1\n')
    await indexCodebase({ config, mode: 'full' })
    writeSource(config, 'src/a.ts', 'export const alpha = 2\n')
    const runner = makeRunnerSpy(config)
    const watcher = buildWatcher(config, runner)

    await watcher.start()
    await waitForArmed(watcher)

    expect(runner.calls).toEqual(['incremental'])
    expect(watcher.getState().lastCompletedAt).not.toBeNull()
    expect(watcher.getIndexFreshness().indexFreshness).toBe('fresh')
  })

  test('wiped DB (tables present, zero rows) with files on disk runs the catch-up', async () => {
    const config = await makeRepo()
    writeSource(config, 'src/a.ts', 'export const alpha = 1\n')
    await indexCodebase({ config, mode: 'full' })
    // simulate the wipe-and-rebuild window: schema reset to empty
    const db = openDatabase(config.dbPath)
    db.run('PRAGMA foreign_keys = OFF')
    db.run('DROP TABLE files')
    ensureSchema(db)
    db.close()

    const runner = makeRunnerSpy(config)
    const watcher = buildWatcher(config, runner)

    await watcher.start()
    await waitForArmed(watcher)

    expect(runner.calls).toEqual(['incremental'])
    const summary = await indexCodebase({ config, mode: 'incremental' })
    expect(summary.filesIndexed).toBe(0)
  })

  test('missing DB runs the catch-up (cold-start full index via incremental path)', async () => {
    const config = await makeRepo()
    writeSource(config, 'src/a.ts', 'export const alpha = 1\n')
    expect(existsSync(config.dbPath)).toBe(false)
    const runner = makeRunnerSpy(config)
    const watcher = buildWatcher(config, runner)

    await watcher.start()
    await waitForArmed(watcher)

    expect(runner.calls).toEqual(['incremental'])
    expect(countIndexedFiles(config)).toBe(1)
  })
})

describe('watcher event handling', () => {
  test('events outside configured roots, excludes, or languages are ignored', async () => {
    const config = await makeRepo()
    writeSource(config, 'src/a.ts', 'export const alpha = 1\n')
    await indexCodebase({ config, mode: 'full' })
    const runner = makeRunnerSpy(config)
    const watcher = buildWatcher(config, runner)

    await watcher.start()
    await waitForArmed(watcher)
    writeSource(config, 'notes/ignored.ts', 'export const ignored = 1\n')
    writeSource(config, 'src/ignored.test.ts', 'export const ignoredTest = 1\n')
    writeSource(config, 'src/notes.md', '# not a language\n')
    await delay(SETTLE_MARGIN_MS)

    expect(runner.calls).toEqual([])
    expect(watcher.getState().pendingEvents).toBe(0)
    expect(watcher.getState().status).toBe('idle')
  })

  test('debounce coalesces an edit burst into exactly one incremental reindex', async () => {
    const config = await makeRepo()
    writeSource(config, 'src/a.ts', 'export const alpha = 1\n')
    await indexCodebase({ config, mode: 'full' })
    const runner = makeRunnerSpy(config)
    const watcher = buildWatcher(config, runner)

    await watcher.start()
    await waitForArmed(watcher)
    writeSource(config, 'src/x1.ts', 'export const x1 = 1\n')
    writeSource(config, 'src/x2.ts', 'export const x2 = 2\n')
    writeSource(config, 'src/x3.ts', 'export const x3 = 3\n')
    await waitForCatchUpSettled(watcher)

    expect(runner.calls).toEqual(['incremental'])
    expect(watcher.getState().pendingEvents).toBe(0)
    const paths = listIndexedFiles(config)
    expect(paths).toContain('src/x1.ts')
    expect(paths).toContain('src/x2.ts')
    expect(paths).toContain('src/x3.ts')
  })

  test('rename, move, and delete sequences converge to the discovered file set', async () => {
    const config = await makeRepo()
    writeSource(config, 'src/a.ts', 'export const alpha = 1\n')
    writeSource(config, 'src/b.ts', 'export const beta = 2\n')
    await indexCodebase({ config, mode: 'full' })
    const runner = makeRunnerSpy(config)
    const watcher = buildWatcher(config, runner)

    await watcher.start()
    await waitForArmed(watcher)
    renameSync(path.join(config.repoRoot, 'src/a.ts'), path.join(config.repoRoot, 'src/c.ts'))
    unlinkSync(path.join(config.repoRoot, 'src/b.ts'))
    writeSource(config, 'src/d.ts', 'export const delta = 4\n')
    await waitForCatchUpSettled(watcher)
    await delay(SETTLE_MARGIN_MS)

    const paths = listIndexedFiles(config)
    expect(paths).toContain('src/c.ts')
    expect(paths).toContain('src/d.ts')
    expect(paths).not.toContain('src/a.ts')
    expect(paths).not.toContain('src/b.ts')
  })

  test('a failed reindex records error state and the next event retries', async () => {
    const config = await makeRepo()
    writeSource(config, 'src/a.ts', 'export const alpha = 1\n')
    await indexCodebase({ config, mode: 'full' })
    const runner = makeRunnerSpy(config)
    const watcher = buildWatcher(config, runner)

    await watcher.start()
    await waitForArmed(watcher)
    runner.failNext()
    writeSource(config, 'src/b.ts', 'export const beta = 2\n')
    await waitForStatus(watcher, 'error')
    expect(watcher.getState().lastError).toContain('injected runner failure')

    writeSource(config, 'src/c.ts', 'export const gamma = 3\n')
    await waitForRecovered(watcher)
    const paths = listIndexedFiles(config)
    expect(paths).toContain('src/c.ts')
  })
})

describe('watcher lifecycle', () => {
  test('the watcher starts and stops with the server session — events after stop are ignored', async () => {
    const config = await makeRepo()
    writeSource(config, 'src/a.ts', 'export const alpha = 1\n')
    await indexCodebase({ config, mode: 'full' })
    const runner = makeRunnerSpy(config)
    const watcher = buildWatcher(config, runner)

    await watcher.start()
    watcher.stop()
    writeSource(config, 'src/after-stop.ts', 'export const afterStop = 1\n')
    await delay(SETTLE_MARGIN_MS)

    expect(runner.calls).toEqual([])
  })

  test('watcher debounce defaults to 300 ms', () => {
    expect(DEFAULT_DEBOUNCE_MS).toBe(300)
  })
})
