import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runIndexBench } from '../../bench/index-bench.js'
import { loadCodeindexConfig } from '../../src/config.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'

const tempDirs: string[] = []

const makeRepo = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-idxbench-'))
  tempDirs.push(dir)
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const alpha = (): number => 1\n')
  writeFileSync(
    path.join(dir, 'src', 'b.ts'),
    "import { alpha } from './a.js'\nexport const beta = (): number => alpha() + 1\n",
  )
  return dir
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('runIndexBench', () => {
  test('reports counts matching indexCodebase, plus phase timings, DB size, throughput', async () => {
    const repo = makeRepo()
    const config = await loadCodeindexConfig({ configPath: path.join(repo, '.codeindex.json'), repoRoot: repo })
    const report = await runIndexBench(config, 'full')

    // Counts match a direct index of the same repo (re-run is deterministic on an unchanged repo).
    const direct = await indexCodebase({ config, mode: 'full' })
    expect(report.filesIndexed).toBe(direct.filesIndexed)
    expect(report.symbolsIndexed).toBe(direct.symbolsIndexed)

    expect(report.filesIndexed).toBeGreaterThanOrEqual(2)
    expect(report.dbSizeBytes).toBeGreaterThan(0)
    for (const phase of ['init', 'discover', 'parse', 'persist', 'resolve', 'provenance'] as const) {
      expect(report.phaseMs[phase]).toBeGreaterThanOrEqual(0)
    }
    // Sum of phases should not exceed total (with a small tolerance for Date.now granularity + inter-phase gaps).
    const phaseSum = Object.values(report.phaseMs).reduce((total, ms) => total + ms, 0)
    expect(phaseSum).toBeLessThanOrEqual(report.elapsedMs + 50)
    expect(report.filesPerSecond).toBeGreaterThanOrEqual(0)
    expect(report.cpuCount).toBeGreaterThanOrEqual(1)
    expect(report.bunVersion.length).toBeGreaterThan(0)
  })
})
