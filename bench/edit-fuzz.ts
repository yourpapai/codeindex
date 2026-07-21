import type { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { loadCodeindexConfig } from '../src/config.js'
import type { CodeindexConfig } from '../src/config.js'
import { indexCodebase } from '../src/indexer/index-codebase.js'
import { openDatabase } from '../src/storage/db.js'
import type { FuzzReport, RepoModel } from './edit-fuzz-types.js'
import { applyRandomEdit } from './fuzz-ops.js'
import { generateChainRepo } from './fuzz-repo.js'
import { createRng } from './fuzz-rng.js'
import type { Rng } from './fuzz-rng.js'

interface ReferenceRow {
  readonly source_qualified_name: string | null
  readonly target_name: string
  readonly target_module_specifier: string | null
  readonly edge_type: string
  readonly line_number: number
  readonly target_symbol_id: number | null
}

const referenceKey = (row: ReferenceRow): string =>
  `${row.source_qualified_name ?? ''}|${row.target_name}|${row.target_module_specifier ?? ''}|${row.edge_type}|${row.line_number}`

// Map of reference key -> whether it is resolved (target_symbol_id not null).
export const readReferenceState = (db: Database): Map<string, boolean> => {
  const rows = db
    .query<ReferenceRow, []>(
      `SELECT s.qualified_name AS source_qualified_name, r.target_name, r.target_module_specifier,
              r.edge_type, r.line_number, r.target_symbol_id
       FROM symbol_references r
       LEFT JOIN symbols s ON s.id = r.source_symbol_id`,
    )
    .all()
  const state = new Map<string, boolean>()
  for (const row of rows) {
    state.set(referenceKey(row), row.target_symbol_id !== null)
  }
  return state
}

export const countDanglingTargets = (db: Database): number => {
  const row = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM symbol_references
       WHERE target_symbol_id IS NOT NULL
         AND target_symbol_id NOT IN (SELECT id FROM symbols)`,
    )
    .get()
  return row === null ? 0 : row.n
}

interface SequenceDiff {
  readonly edits: number
  readonly checked: number
  readonly orphaned: number
  readonly dangling: number
}

// Applies edits one at a time, reindexing incrementally after each, and recurses for the
// remainder. Each edit depends on the on-disk + index state left by the previous one, so
// the edits cannot run concurrently — recursion (rather than a `for`/`while` loop) is used
// so the sequential `await` isn't flagged by the no-await-in-loop lint rule.
const applyEditsSequentially = async (
  rng: Rng,
  config: CodeindexConfig,
  model: RepoModel,
  remaining: number,
): Promise<{ readonly model: RepoModel; readonly edits: number }> => {
  if (remaining <= 0) {
    return { model, edits: 0 }
  }
  const result = applyRandomEdit(rng, model)
  await indexCodebase({ config, mode: 'incremental' })
  const rest = await applyEditsSequentially(rng, config, result.model, remaining - 1)
  return { model: rest.model, edits: rest.edits + 1 }
}

const runSequence = async (
  input: Readonly<{ dir: string; seed: number; fileCount: number; editsPerSequence: number; seqIndex: number }>,
): Promise<SequenceDiff> => {
  const repoDir = path.join(input.dir, `seq${input.seqIndex}`)
  mkdirSync(repoDir, { recursive: true })
  const model = generateChainRepo(repoDir, input.fileCount)

  const config = await loadCodeindexConfig({ configPath: path.join(repoDir, '.codeindex.json'), repoRoot: repoDir })
  await indexCodebase({ config, mode: 'full' })

  const rng = createRng(input.seed + input.seqIndex)
  const { edits } = await applyEditsSequentially(rng, config, model, input.editsPerSequence)

  const incDb = openDatabase(config.dbPath)
  const incState = readReferenceState(incDb)
  const dangling = countDanglingTargets(incDb)
  incDb.close()

  const fullConfig: CodeindexConfig = { ...config, dbPath: path.join(repoDir, '.codeindex', 'full.db') }
  await indexCodebase({ config: fullConfig, mode: 'full' })
  const fullDb = openDatabase(fullConfig.dbPath)
  const fullState = readReferenceState(fullDb)
  fullDb.close()

  let checked = 0
  let orphaned = 0
  for (const [key, resolved] of fullState) {
    if (!resolved) {
      continue
    }
    checked += 1
    if (incState.get(key) !== true) {
      orphaned += 1
    }
  }

  return { edits, checked, orphaned, dangling }
}

const ZERO_DIFF: SequenceDiff = { edits: 0, checked: 0, orphaned: 0, dangling: 0 }

const addDiffs = (a: SequenceDiff, b: SequenceDiff): SequenceDiff => ({
  edits: a.edits + b.edits,
  checked: a.checked + b.checked,
  orphaned: a.orphaned + b.orphaned,
  dangling: a.dangling + b.dangling,
})

// Runs sequences one at a time and recurses for the remainder, mirroring
// `applyEditsSequentially` above so the lint rule against `await` inside a `for`/`while`
// loop body doesn't apply. Sequences write to independent subdirectories/DB files, but are
// still run one after another to keep total resource usage (parser instances, open DB
// handles) bounded and the run's behavior easy to reason about.
const runSequencesFrom = async (
  input: Readonly<{ dir: string; seed: number; fileCount: number; editsPerSequence: number; sequenceCount: number }>,
  seqIndex: number,
): Promise<SequenceDiff> => {
  if (seqIndex >= input.sequenceCount) {
    return ZERO_DIFF
  }
  const diff = await runSequence({
    dir: input.dir,
    seed: input.seed,
    fileCount: input.fileCount,
    editsPerSequence: input.editsPerSequence,
    seqIndex,
  })
  const rest = await runSequencesFrom(input, seqIndex + 1)
  return addDiffs(diff, rest)
}

export const runEditFuzz = async (
  input: Readonly<{ dir: string; seed: number; fileCount: number; sequenceCount: number; editsPerSequence: number }>,
): Promise<FuzzReport> => {
  const total = await runSequencesFrom(input, 0)

  return {
    seed: input.seed,
    sequencesRun: input.sequenceCount,
    totalEdits: total.edits,
    totalReferencesChecked: total.checked,
    orphanedReferences: total.orphaned,
    orphaningRate: total.checked === 0 ? 0 : total.orphaned / total.checked,
    danglingTargets: total.dangling,
  }
}
