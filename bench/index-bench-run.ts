import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { loadCodeindexConfig } from '../src/config.js'
import { readRepoHead, warnOnCorpusDrift } from './git-stamp.js'
import { compareIndexCounts } from './index-bench-compare.js'
import type { IndexBaselineCounts, IndexBenchReport } from './index-bench-types.js'
import { runIndexBench } from './index-bench.js'

const IndexBaselineCountsSchema = z.object({
  filesIndexed: z.number(),
  symbolsIndexed: z.number(),
  referencesIndexed: z.number(),
  referencesUnresolved: z.number(),
  repoHead: z.string().nullable().optional(),
})

interface IndexBenchArgs {
  readonly repo: string
  readonly mode: 'full' | 'incremental'
  readonly baseline: string | null
  readonly updateBaseline: boolean
}

const parseArgs = (argv: readonly string[]): IndexBenchArgs => {
  let repo = process.cwd()
  let mode: 'full' | 'incremental' = 'full'
  let baseline: string | null = null
  let updateBaseline = false
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--repo' && value !== undefined) {
      repo = path.resolve(value)
      index += 1
    } else if (flag === '--mode' && value !== undefined) {
      mode = value === 'incremental' ? 'incremental' : 'full'
      index += 1
    } else if (flag === '--baseline' && value !== undefined) {
      baseline = path.resolve(value)
      index += 1
    } else if (flag === '--update-baseline') {
      updateBaseline = true
    }
  }
  return { repo, mode, baseline, updateBaseline }
}

// The count baseline is a snapshot of the target repo's indexed counts at a point in time;
// regenerate it (--update-baseline) in the same change that legitimately alters those counts.
const toBaselineCounts = (report: IndexBenchReport, repoHead: string | null): IndexBaselineCounts => ({
  filesIndexed: report.filesIndexed,
  symbolsIndexed: report.symbolsIndexed,
  referencesIndexed: report.referencesIndexed,
  referencesUnresolved: report.referencesUnresolved,
  repoHead,
})

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))
  const repoHead = readRepoHead(args.repo)
  const config = await loadCodeindexConfig({
    configPath: path.join(args.repo, '.codeindex.json'),
    repoRoot: args.repo,
  })
  const report = await runIndexBench(config, args.mode)
  console.log(JSON.stringify(report, null, 2))

  if (args.updateBaseline && args.baseline === null) {
    console.error('--update-baseline requires --baseline <path>; no baseline written.')
  }

  if (args.updateBaseline && args.baseline !== null) {
    writeFileSync(args.baseline, `${JSON.stringify(toBaselineCounts(report, repoHead), null, 2)}\n`)
    console.error(`Index baseline written to ${args.baseline}`)
    return
  }

  if (args.baseline !== null && existsSync(args.baseline)) {
    const baseline = IndexBaselineCountsSchema.parse(JSON.parse(readFileSync(args.baseline, 'utf8')) as unknown)
    warnOnCorpusDrift(baseline.repoHead, repoHead, 'index_counts')
    const comparison = compareIndexCounts(report, baseline, 0)
    for (const entry of comparison.deltas) {
      const sign = entry.delta >= 0 ? '+' : ''
      console.error(`${entry.metric}: ${entry.baseline} -> ${entry.current} (${sign}${entry.delta})`)
    }
    if (comparison.regressed) {
      console.error('Index count regression detected against baseline.')
      process.exit(1)
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
