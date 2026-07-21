import { statSync } from 'node:fs'
import { cpus } from 'node:os'

import type { CodeindexConfig } from '../src/config.js'
import { indexCodebase } from '../src/indexer/index-codebase.js'
import type { IndexPhase } from '../src/indexer/index-codebase.js'
import type { IndexBenchReport } from './index-bench-types.js'

const perSecond = (count: number, elapsedMs: number): number => (elapsedMs <= 0 ? 0 : count / (elapsedMs / 1000))

export const runIndexBench = async (
  config: CodeindexConfig,
  mode: 'full' | 'incremental',
): Promise<IndexBenchReport> => {
  const phaseMs: Record<IndexPhase, number> = {
    init: 0,
    discover: 0,
    parse: 0,
    persist: 0,
    resolve: 0,
    provenance: 0,
  }
  const summary = await indexCodebase({
    config,
    mode,
    onPhase: (phase, ms) => {
      phaseMs[phase] = ms
    },
  })
  // DB size assumes the index db was closed (indexCodebase closes it in its finally) so WAL is
  // checkpointed; a concurrent connection (e.g. a running MCP server) could make this understate size.
  const dbSizeBytes = statSync(config.dbPath).size
  return {
    repo: config.repoRoot,
    mode,
    filesIndexed: summary.filesIndexed,
    filesFailed: summary.filesFailed,
    filesPruned: summary.filesPruned,
    symbolsIndexed: summary.symbolsIndexed,
    referencesIndexed: summary.referencesIndexed,
    referencesUnresolved: summary.referencesUnresolved,
    elapsedMs: summary.elapsedMs,
    phaseMs,
    dbSizeBytes,
    filesPerSecond: perSecond(summary.filesIndexed, summary.elapsedMs),
    symbolsPerSecond: perSecond(summary.symbolsIndexed, summary.elapsedMs),
    referencesPerSecond: perSecond(summary.referencesIndexed, summary.elapsedMs),
    bunVersion: Bun.version,
    cpuCount: cpus().length,
  }
}
