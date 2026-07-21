import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadCodeindexConfig } from '../../src/config.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import type { IndexPhase } from '../../src/indexer/index-codebase.js'

const tempDirs: string[] = []

const makeRepo = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-phase-'))
  tempDirs.push(dir)
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const alpha = (): number => 1\n')
  return dir
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('indexCodebase onPhase', () => {
  test('emits a timing for every phase', async () => {
    const repo = makeRepo()
    const config = await loadCodeindexConfig({ configPath: path.join(repo, '.codeindex.json'), repoRoot: repo })
    const seen = new Map<IndexPhase, number>()
    await indexCodebase({
      config,
      mode: 'full',
      onPhase: (phase, ms) => {
        seen.set(phase, ms)
      },
    })
    const phases: readonly IndexPhase[] = ['init', 'discover', 'parse', 'persist', 'resolve', 'provenance']
    for (const phase of phases) {
      expect(seen.has(phase)).toBe(true)
      expect(seen.get(phase)!).toBeGreaterThanOrEqual(0)
    }
  })

  test('works without an onPhase callback (backward compatible)', async () => {
    const repo = makeRepo()
    const config = await loadCodeindexConfig({ configPath: path.join(repo, '.codeindex.json'), repoRoot: repo })
    const summary = await indexCodebase({ config, mode: 'full' })
    expect(summary.filesIndexed).toBeGreaterThanOrEqual(1)
  })
})
