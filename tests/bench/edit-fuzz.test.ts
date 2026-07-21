import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { RepoFile, RepoModel } from '../../bench/edit-fuzz-types.js'
import { readReferenceState, runEditFuzz } from '../../bench/edit-fuzz.js'
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

// Extracted so a control-flow guard never appears directly inside a `test(...)` body
// (the lint config forbids conditionals in tests).
const requireLastFile = (model: RepoModel): RepoFile => {
  const last = model.files[model.files.length - 1]
  if (last === undefined) {
    throw new Error('expected chain repo to have at least one file')
  }
  return last
}

const countResolved = (state: ReadonlyMap<string, boolean>): number =>
  Array.from(state.values()).filter((resolved) => resolved).length

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

  // 1-hop re-resolution invariant. We use the WEAKER form ("at least one cross-file
  // reference remains resolved after an incremental edit") rather than pinning a single
  // exact reference key: the chain generator's line numbers/qualified names are an
  // implementation detail of `generateChainRepo`/the parser, and pinning one specific key
  // makes the test fragile to unrelated formatting changes. The weaker assertion still
  // guards against the regression this invariant exists to catch: a single leaf edit
  // incrementally reindexed must not orphan every cross-file reference in the repo.
  test('INVARIANT: editing a leaf module leaves at least one cross-file reference resolved after incremental reindex', async () => {
    const dir = makeDir()
    const model = generateChainRepo(dir, 4)
    const config = await loadCodeindexConfig({ configPath: path.join(dir, '.codeindex.json'), repoRoot: dir })
    await indexCodebase({ config, mode: 'full' })

    // Edit only the leaf module (the last file in the chain, mod3 for a 4-file chain):
    // it has no dependents, so this is the smallest possible incremental change.
    const leaf = requireLastFile(model)
    const leafPath = path.join(dir, 'src', `${leaf.name}.ts`)
    writeFileSync(
      leafPath,
      `import { sym${model.files.length - 2} } from './mod${model.files.length - 2}.js'\nexport const ${leaf.symbol} = (): number => sym${model.files.length - 2}() + 100\n`,
    )

    await indexCodebase({ config, mode: 'incremental' })

    const db = openDatabase(config.dbPath)
    const state = readReferenceState(db)
    db.close()

    expect(countResolved(state)).toBeGreaterThanOrEqual(1)
  })
})
