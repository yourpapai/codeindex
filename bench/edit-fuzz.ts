import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { loadCodeindexConfig, type CodeindexConfig } from '../src/config.js'
import { indexCodebase } from '../src/indexer/index-codebase.js'
import { openDatabase } from '../src/storage/db.js'
import { compareEdges, compareImpact, countDanglingTargets, loadScopeTables } from './edit-fuzz-oracle.js'
import type { FuzzReport, RepoModel } from './edit-fuzz-types.js'
import { applyRandomEdit } from './fuzz-ops.js'
import { generateChainRepo } from './fuzz-repo.js'
import { createRng } from './fuzz-rng.js'
import type { Rng } from './fuzz-rng.js'

interface SequenceDiff extends ReturnType<typeof compareEdges>, ReturnType<typeof compareImpact> {
  readonly edits: number
  readonly dangling: number
}

const ZERO_DIFF: SequenceDiff = {
  edits: 0,
  dangling: 0,
  checked: 0,
  orphaned: 0,
  missingEdges: 0,
  extraEdges: 0,
  falseResolved: 0,
  unexpectedUnresolved: 0,
  mapRoutedDivergence: 0,
  barrelRoutedDivergence: 0,
  unexpectedImpactDivergence: 0,
  mapRoutedImpactDivergence: 0,
  barrelRoutedImpactDivergence: 0,
}

const addDiffs = (a: SequenceDiff, b: SequenceDiff): SequenceDiff => ({
  edits: a.edits + b.edits,
  dangling: a.dangling + b.dangling,
  checked: a.checked + b.checked,
  orphaned: a.orphaned + b.orphaned,
  missingEdges: a.missingEdges + b.missingEdges,
  extraEdges: a.extraEdges + b.extraEdges,
  falseResolved: a.falseResolved + b.falseResolved,
  unexpectedUnresolved: a.unexpectedUnresolved + b.unexpectedUnresolved,
  mapRoutedDivergence: a.mapRoutedDivergence + b.mapRoutedDivergence,
  barrelRoutedDivergence: a.barrelRoutedDivergence + b.barrelRoutedDivergence,
  unexpectedImpactDivergence: a.unexpectedImpactDivergence + b.unexpectedImpactDivergence,
  mapRoutedImpactDivergence: a.mapRoutedImpactDivergence + b.mapRoutedImpactDivergence,
  barrelRoutedImpactDivergence: a.barrelRoutedImpactDivergence + b.barrelRoutedImpactDivergence,
})

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
  const dangling = countDanglingTargets(incDb)

  const fullConfig: CodeindexConfig = { ...config, dbPath: path.join(repoDir, '.codeindex', 'full.db') }
  await indexCodebase({ config: fullConfig, mode: 'full' })
  const fullDb = openDatabase(fullConfig.dbPath)

  const tables = loadScopeTables(incDb)
  const diff: SequenceDiff = {
    edits,
    dangling,
    ...compareEdges(incDb, fullDb, tables),
    ...compareImpact(incDb, fullDb, tables),
  }
  incDb.close()
  fullDb.close()
  return diff
}

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

  const report: FuzzReport = {
    seed: input.seed,
    sequencesRun: input.sequenceCount,
    totalEdits: total.edits,
    totalReferencesChecked: total.checked,
    orphanedReferences: total.orphaned,
    orphaningRate: total.checked === 0 ? 0 : total.orphaned / total.checked,
    danglingTargets: total.dangling,
    missingEdges: total.missingEdges,
    extraEdges: total.extraEdges,
    falseResolved: total.falseResolved,
    unexpectedUnresolved: total.unexpectedUnresolved,
    mapRoutedDivergence: total.mapRoutedDivergence,
    barrelRoutedDivergence: total.barrelRoutedDivergence,
    unexpectedImpactDivergence: total.unexpectedImpactDivergence,
    mapRoutedImpactDivergence: total.mapRoutedImpactDivergence,
    barrelRoutedImpactDivergence: total.barrelRoutedImpactDivergence,
  }

  // The tier-1 durability gate: everything repair can re-derive from stored rows must match a
  // fresh full reindex exactly. Routed-class divergence is deliberately reported, not gated —
  // it is the measurement feeding the tier-2 decision (design.md, Open Questions).
  const violations =
    report.missingEdges +
    report.extraEdges +
    report.falseResolved +
    report.unexpectedUnresolved +
    report.unexpectedImpactDivergence
  if (violations > 0) {
    throw new Error(
      `durability invariant violated: ${violations} divergence(s) in tier-1-reachable state — ` +
        `missingEdges=${report.missingEdges}, extraEdges=${report.extraEdges}, falseResolved=${report.falseResolved}, ` +
        `unexpectedUnresolved=${report.unexpectedUnresolved}, unexpectedImpactDivergence=${report.unexpectedImpactDivergence}`,
    )
  }
  return report
}
