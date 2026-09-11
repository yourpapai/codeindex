import { describe, expect, test } from 'bun:test'

import type { IndexSummary } from '../../src/indexer/index-codebase.js'
import { createReindexScheduler, type ReindexMode } from '../../src/mcp/reindex-scheduler.js'

const summary = (filesIndexed: number): IndexSummary => ({
  filesIndexed,
  filesFailed: 0,
  filesPruned: 0,
  skippedFiles: [],
  skippedFilesTotal: 0,
  symbolsIndexed: 0,
  referencesIndexed: 0,
  referencesUnresolved: 0,
  referencesRepaired: 0,
  elapsedMs: 1,
})

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

describe('reindex scheduler', () => {
  test('concurrent triggers serialize — at most one run is active', async () => {
    let active = 0
    let maxActive = 0
    const runner = async ({ mode }: Readonly<{ mode: ReindexMode }>): Promise<IndexSummary> => {
      expect(mode).toBe('incremental')
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(20)
      active -= 1
      return summary(1)
    }
    const scheduler = createReindexScheduler(runner)

    const results = await Promise.all([
      scheduler.submit({ mode: 'incremental' }),
      scheduler.submit({ mode: 'incremental' }),
      scheduler.submit({ mode: 'incremental' }),
    ])

    expect(maxActive).toBe(1)
    expect(results).toHaveLength(3)
  })

  test('triggers during an active run coalesce into at most one follow-up', async () => {
    let calls = 0
    const runner = async (): Promise<IndexSummary> => {
      calls += 1
      await delay(30)
      return summary(calls * 10)
    }
    const scheduler = createReindexScheduler(runner)

    const first = scheduler.submit({ mode: 'incremental' })
    await delay(5)
    const second = scheduler.submit({ mode: 'incremental' })
    const third = scheduler.submit({ mode: 'incremental' })
    const [r1, r2, r3] = await Promise.all([first, second, third])

    expect(calls).toBe(2)
    expect(r1.filesIndexed).toBe(10)
    expect(r2).toEqual(r3)
    expect(r2.filesIndexed).toBe(20)
  })

  test('follow-up re-derives the incremental set — no stale queued snapshot', async () => {
    let latest = 0
    const observedAtRunStart: number[] = []
    const runner = async (): Promise<IndexSummary> => {
      observedAtRunStart.push(latest)
      await delay(30)
      return summary(1)
    }
    const scheduler = createReindexScheduler(runner)

    const first = scheduler.submit({ mode: 'incremental' })
    const second = scheduler.submit({ mode: 'incremental' })
    latest = 42
    await Promise.all([first, second])

    expect(observedAtRunStart).toEqual([0, 42])
  })

  test('a queued full request promotes the coalesced follow-up to full mode', async () => {
    const observedModes: ReindexMode[] = []
    const runner = async ({ mode }: Readonly<{ mode: ReindexMode }>): Promise<IndexSummary> => {
      observedModes.push(mode)
      await delay(20)
      return summary(1)
    }
    const scheduler = createReindexScheduler(runner)

    const first = scheduler.submit({ mode: 'incremental' })
    const second = scheduler.submit({ mode: 'full' })
    const third = scheduler.submit({ mode: 'incremental' })
    await Promise.all([first, second, third])

    expect(observedModes).toEqual(['incremental', 'full'])
  })

  test('a failed active run still drains the queued follow-up', async () => {
    let calls = 0
    const runner = async (): Promise<IndexSummary> => {
      calls += 1
      if (calls === 1) {
        throw new Error('boom')
      }
      await delay(10)
      return summary(calls)
    }
    const scheduler = createReindexScheduler(runner)

    const first = scheduler.submit({ mode: 'incremental' })
    const second = scheduler.submit({ mode: 'incremental' })

    await expect(first).rejects.toThrow('boom')
    expect((await second).filesIndexed).toBe(2)
    expect(calls).toBe(2)
  })

  test('whenSettled resolves immediately when idle', async () => {
    const scheduler = createReindexScheduler(() => Promise.resolve(summary(1)))
    await scheduler.whenSettled()
  })

  test('whenSettled awaits an active run without enqueueing another', async () => {
    let calls = 0
    const runner = async (): Promise<IndexSummary> => {
      calls += 1
      await delay(40)
      return summary(calls)
    }
    const scheduler = createReindexScheduler(runner)

    const active = scheduler.submit({ mode: 'incremental' })
    await delay(5)
    await scheduler.whenSettled()
    await active
    expect(calls).toBe(1)
  })

  test('whenSettled during busy+pending waits for the coalesced follow-up', async () => {
    let calls = 0
    const runner = async (): Promise<IndexSummary> => {
      calls += 1
      await delay(30)
      return summary(calls)
    }
    const scheduler = createReindexScheduler(runner)

    const first = scheduler.submit({ mode: 'incremental' })
    await delay(5)
    const second = scheduler.submit({ mode: 'incremental' })
    await scheduler.whenSettled()
    await Promise.all([first, second])
    expect(calls).toBe(2)
  })

  test('two wait joiners during an active run coalesce into at most one follow-up', async () => {
    let calls = 0
    const modes: ReindexMode[] = []
    const runner = async ({ mode }: Readonly<{ mode: ReindexMode }>): Promise<IndexSummary> => {
      modes.push(mode)
      calls += 1
      await delay(30)
      return summary(calls)
    }
    const scheduler = createReindexScheduler(runner)

    const active = scheduler.submit({ mode: 'incremental' })
    await delay(5)
    // Two wait-style joins: they must not each force a private sequential run.
    const joinA = scheduler.whenSettled()
    const joinB = scheduler.whenSettled()
    // A dirty probe after settle may still submit one shared follow-up.
    const followUp = scheduler.submit({ mode: 'incremental' })
    await Promise.all([active, followUp, joinA, joinB])

    expect(calls).toBe(2)
    expect(modes).toEqual(['incremental', 'incremental'])
  })
})
