import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { loadCodeindexConfig } from '../src/config.js'
import { indexCodebase } from '../src/indexer/index-codebase.js'
import { openDatabase } from '../src/storage/db.js'
import { compareToBaseline } from './baseline-compare.js'
import { loadCorpus } from './corpus.js'
import { scoreCorpus } from './harness.js'
import type { BaselineMetrics, CorpusReport } from './types.js'

const BaselineMetricsSchema = z.object({
  k: z.number(),
  meanPrecisionAtK: z.number(),
  meanRecallAtK: z.number(),
  mrr: z.number(),
})

interface BenchArgs {
  readonly repo: string
  readonly corpus: string
  readonly k: number
  readonly baseline: string | null
  readonly updateBaseline: boolean
}

const parseArgs = (argv: readonly string[]): BenchArgs => {
  let repo = process.cwd()
  let corpus = path.join(process.cwd(), 'bench/corpus/seed.json')
  let k = 10
  let baseline: string | null = null
  let updateBaseline = false
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--repo' && value !== undefined) {
      repo = path.resolve(value)
      index += 1
    } else if (flag === '--corpus' && value !== undefined) {
      corpus = path.resolve(value)
      index += 1
    } else if (flag === '--k' && value !== undefined) {
      k = Number.parseInt(value, 10)
      index += 1
    } else if (flag === '--baseline' && value !== undefined) {
      baseline = path.resolve(value)
      index += 1
    } else if (flag === '--update-baseline') {
      updateBaseline = true
    }
  }
  return { repo, corpus, k, baseline, updateBaseline }
}

const toBaselineMetrics = (report: CorpusReport): BaselineMetrics => ({
  k: report.k,
  meanPrecisionAtK: report.meanPrecisionAtK,
  meanRecallAtK: report.meanRecallAtK,
  mrr: report.mrr,
})

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))
  const config = await loadCodeindexConfig({
    configPath: path.join(args.repo, '.codeindex.json'),
    repoRoot: args.repo,
  })
  await indexCodebase({ config, mode: 'full' })
  const corpus = await loadCorpus(args.corpus)
  const db = openDatabase(config.dbPath)
  const report = ((): CorpusReport => {
    try {
      return scoreCorpus(db, corpus, args.k)
    } finally {
      db.close()
    }
  })()
  console.log(JSON.stringify(report, null, 2))

  if (args.updateBaseline && args.baseline !== null) {
    writeFileSync(args.baseline, `${JSON.stringify(toBaselineMetrics(report), null, 2)}\n`)
    console.error(`Baseline written to ${args.baseline}`)
    return
  }

  if (args.baseline !== null && existsSync(args.baseline)) {
    const baseline: BaselineMetrics = BaselineMetricsSchema.parse(
      JSON.parse(readFileSync(args.baseline, 'utf8')) as unknown,
    )
    const comparison = compareToBaseline(report, baseline, 1e-9)
    for (const entry of comparison.deltas) {
      const sign = entry.delta >= 0 ? '+' : ''
      console.error(
        `${entry.metric}: ${entry.baseline.toFixed(4)} -> ${entry.current.toFixed(4)} (${sign}${entry.delta.toFixed(4)})`,
      )
    }
    if (comparison.regressed) {
      console.error('Regression detected against baseline.')
      process.exit(1)
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
