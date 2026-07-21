import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runEditFuzz } from '../../bench/edit-fuzz.js'
import { generateChainRepo } from '../../bench/fuzz-repo.js'
import { loadCodeindexConfig } from '../../src/config.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import { openDatabase } from '../../src/storage/db.js'

const tempDirs: string[] = []

const makeDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-editfuzz-'))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('runEditFuzz', () => {
  test('is deterministic and produces a finite orphaning rate in [0,1]', async () => {
    const a = await runEditFuzz({ dir: makeDir(), seed: 2026, fileCount: 5, sequenceCount: 3, editsPerSequence: 3 })
    const b = await runEditFuzz({ dir: makeDir(), seed: 2026, fileCount: 5, sequenceCount: 3, editsPerSequence: 3 })
    expect(a.orphanedReferences).toBe(b.orphanedReferences)
    expect(a.orphaningRate).toBeGreaterThanOrEqual(0)
    expect(a.orphaningRate).toBeLessThanOrEqual(1)
    expect(a.totalReferencesChecked).toBeGreaterThan(0)
  })

  test('INVARIANT: no dangling FK — every non-null target_symbol_id references a real symbol', async () => {
    const report = await runEditFuzz({ dir: makeDir(), seed: 77, fileCount: 6, sequenceCount: 4, editsPerSequence: 4 })
    expect(report.danglingTargets).toBe(0)
  })

  // 1-hop re-resolution invariant. `generateChainRepo` builds mod{i} -> imports sym{i-1}
  // from mod{i-1}, so mod0 is depended on by mod1 (its direct, 1-hop dependent). We edit
  // mod0's content (non-breaking: sym0 keeps its name) and, after an incremental reindex,
  // assert that mod1's cross-file reference to sym0 is still resolved. This genuinely
  // exercises 1-hop re-resolution: mod1 is reprocessed as a dependent of the changed file,
  // and its edge to sym0 must be re-linked to the (re-created) sym0 symbol.
  test('INVARIANT: editing a module leaves its direct dependent reference resolved after incremental reindex', async () => {
    const dir = makeDir()
    generateChainRepo(dir, 3)
    const config = await loadCodeindexConfig({ configPath: path.join(dir, '.codeindex.json'), repoRoot: dir })
    await indexCodebase({ config, mode: 'full' })

    // Append a non-breaking addition to mod0 (the module mod1 directly depends on).
    // sym0 keeps its name, so mod1's import of sym0 continues to be valid.
    const mod0Path = path.join(dir, 'src', 'mod0.ts')
    const original = readFileSync(mod0Path, 'utf8')
    writeFileSync(mod0Path, `${original}\nexport const extra0 = (): number => 0\n`)

    await indexCodebase({ config, mode: 'incremental' })

    const db = openDatabase(config.dbPath)
    try {
      const row = db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM symbol_references WHERE target_name = 'sym0' AND target_symbol_id IS NOT NULL",
        )
        .get()
      expect(row).not.toBeNull()
      expect(row!.n).toBeGreaterThanOrEqual(1)
    } finally {
      db.close()
    }
  })
})
