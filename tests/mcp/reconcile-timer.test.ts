import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadConfigForPath } from '../../src/cli.js'
import type { CodeindexConfig } from '../../src/config.js'
import type { IndexSummary } from '../../src/indexer/index-codebase.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import type { ReindexMode } from '../../src/mcp/reindex-scheduler.js'
import { createWatcher, type IndexWatcher } from '../../src/mcp/watcher.js'
import { openDatabase } from '../../src/storage/db.js'

const tempDirs: string[] = []
const watchers: IndexWatcher[] = []

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const makeRepo = (symbolName: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-reconcile-'))
  tempDirs.push(dir)
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
  writeFileSync(path.join(dir, 'src', 'thing.ts'), `export const ${symbolName} = (): number => 1\n`)
  return dir
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

// Simulate a missed fs.watch event: age stored indexed_at without touching files,
// so only probeDirty (not the watch stream) can see the drift.
const ageIndexedTimestamps = (config: CodeindexConfig): void => {
  const db = openDatabase(config.dbPath)
  try {
    db.query('UPDATE files SET indexed_at = 1').run()
  } finally {
    db.close()
  }
}

interface ReconcileFixture {
  readonly dir: string
  readonly config: CodeindexConfig
  readonly modes: ReindexMode[]
  readonly watcher: IndexWatcher
}

const makeReconcileFixture = async (options: { reconcileIntervalMs: number }): Promise<ReconcileFixture> => {
  const dir = makeRepo('reconcileBeacon')
  const config = await loadConfigForPath(dir)
  await indexCodebase({ config, mode: 'full' })
  const modes: ReindexMode[] = []
  const watcher = createWatcher(
    config,
    ({ mode }: Readonly<{ mode: ReindexMode }>): Promise<IndexSummary> => {
      modes.push(mode)
      return indexCodebase({ config, mode })
    },
    { reconcileIntervalMs: options.reconcileIntervalMs },
  )
  watchers.push(watcher)
  return { dir, config, modes, watcher }
}

afterEach(() => {
  for (const watcher of watchers.splice(0)) {
    watcher.stop()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('hourly reconcile timer', () => {
  test('dirty probe at tick submits an incremental reindex without file events', async () => {
    const fixture = await makeReconcileFixture({ reconcileIntervalMs: 40 })
    await fixture.watcher.start()
    await waitForArmed(fixture.watcher)
    // Drop any boot catch-up submits from the spy before aging timestamps.
    fixture.modes.length = 0

    ageIndexedTimestamps(fixture.config)

    const deadline = Date.now() + 2000
    while (fixture.modes.length === 0) {
      if (Date.now() > deadline) {
        throw new Error(
          `reconcile did not submit: modes=${JSON.stringify(fixture.modes)} state=${JSON.stringify(fixture.watcher.getState())}`,
        )
      }
      await delay(15)
    }
    expect(fixture.modes).toContain('incremental')
  })

  test('clean reconcile is a no-op', async () => {
    const fixture = await makeReconcileFixture({ reconcileIntervalMs: 40 })
    await fixture.watcher.start()
    await waitForArmed(fixture.watcher)
    fixture.modes.length = 0

    // Stay clean; give several ticks time to fire.
    await delay(150)
    expect(fixture.modes).toEqual([])
    expect(fixture.watcher.getState().status).toBe('idle')
  })

  test('stop clears the reconcile timer', async () => {
    const fixture = await makeReconcileFixture({ reconcileIntervalMs: 40 })
    await fixture.watcher.start()
    await waitForArmed(fixture.watcher)
    fixture.watcher.stop()
    fixture.modes.length = 0

    ageIndexedTimestamps(fixture.config)

    await delay(150)
    expect(fixture.modes).toEqual([])
  })
})
