import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { loadCodeindexConfig } from '../src/config.js'
import { indexCodebase } from '../src/indexer/index-codebase.js'
import { openDatabase } from '../src/storage/db.js'
import { compareImpact } from './impact-compare.js'
import { buildReferenceOracle } from './impact-oracle.js'
import { assertScored, scoreImpact } from './impact-score.js'
import { type ImpactBaseline, ImpactBaselineSchema, type ImpactBenchReport } from './impact-types.js'

interface Args {
  readonly repo: string
  readonly tsconfig: string
  readonly baseline: string | null
  readonly updateBaseline: boolean
  readonly maxTargets: number | undefined
}

const parseArgs = (argv: readonly string[]): Args => {
  let repo = process.cwd()
  let tsconfig: string | null = null
  let baseline: string | null = null
  let updateBaseline = false
  let maxTargets: number | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--repo' && value !== undefined) {
      repo = path.resolve(value)
      i += 1
    } else if (flag === '--tsconfig' && value !== undefined) {
      tsconfig = path.resolve(value)
      i += 1
    } else if (flag === '--baseline' && value !== undefined) {
      baseline = path.resolve(value)
      i += 1
    } else if (flag === '--max-targets' && value !== undefined) {
      const parsed = Number.parseInt(value, 10)
      if (Number.isNaN(parsed)) {
        throw new Error(`Invalid --max-targets value: ${value} (expected an integer)`)
      }
      maxTargets = parsed
      i += 1
    } else if (flag === '--update-baseline') {
      updateBaseline = true
    }
  }
  return { repo, tsconfig: tsconfig ?? path.join(repo, 'tsconfig.json'), baseline, updateBaseline, maxTargets }
}

const toBaseline = (r: ImpactBenchReport): ImpactBaseline => ({
  targetsScored: r.targetsScored,
  trueReferenceCount: r.trueReferenceCount,
  falseNegatives: r.falseNegatives,
  falseNegativeRate: r.falseNegativeRate,
  falsePositiveRate: r.falsePositiveRate,
  valueFalseNegativeRate: r.valueFalseNegativeRate,
  typeFalseNegativeRate: r.typeFalseNegativeRate,
})

// Prints the baseline comparison and diagnostics, and exits nonzero on regression.
// Extracted purely to stay under max-lines-per-function in main.
const compareAgainstBaseline = (report: ImpactBenchReport, baselinePath: string): void => {
  const baseline = ImpactBaselineSchema.parse(JSON.parse(readFileSync(baselinePath, 'utf8')) as unknown)
  const comparison = compareImpact(report, baseline, 1e-9)
  console.error(
    `valueFalseNegativeRate: ${baseline.valueFalseNegativeRate.toFixed(4)} -> ${report.valueFalseNegativeRate.toFixed(4)} (${comparison.delta >= 0 ? '+' : ''}${comparison.delta.toFixed(4)})`,
  )
  console.error(
    `typeFalseNegativeRate (diagnostic, sizes B7): ${report.typeFalseNegativeRate.toFixed(4)} | totalFN ${report.falseNegativeRate.toFixed(4)}`,
  )
  console.error(
    `valueFalseNegativesByShape (diagnostic): ${JSON.stringify(report.valueFalseNegativesByShape)} of ${JSON.stringify(report.valueTrueReferenceCountByShape)}`,
  )
  console.error(
    `falsePositiveRate: ${baseline.falsePositiveRate.toFixed(4)} -> ${report.falsePositiveRate.toFixed(4)} (${comparison.fpDelta >= 0 ? '+' : ''}${comparison.fpDelta.toFixed(4)}) by confidence ${JSON.stringify(report.falsePositivesByConfidence)}`,
  )
  if (comparison.regressed) {
    console.error('code_impact regressed against baseline (value false-negative rate or false-positive rate rose).')
    process.exit(1)
  }
}

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))
  const config = await loadCodeindexConfig({ configPath: path.join(args.repo, '.codeindex.json'), repoRoot: args.repo })
  await indexCodebase({ config, mode: 'full' })
  const db = openDatabase(config.dbPath)
  const report = ((): ImpactBenchReport => {
    try {
      const oracle = buildReferenceOracle(db, {
        repoRoot: args.repo,
        tsconfigPath: args.tsconfig,
        maxTargets: args.maxTargets,
      })
      return scoreImpact(db, oracle, path.basename(args.repo))
    } finally {
      db.close()
    }
  })()
  // A zero-target scan is a broken run, not a valid (perfect-looking) result — refuse
  // to print/gate on it rather than silently reporting a 0.0 false-negative rate.
  assertScored(report)
  console.log(JSON.stringify(report, null, 2))

  if (args.updateBaseline && args.baseline === null) {
    console.error('--update-baseline requires --baseline <path>; no baseline written.')
  }
  if (args.updateBaseline && args.baseline !== null) {
    writeFileSync(args.baseline, `${JSON.stringify(toBaseline(report), null, 2)}\n`)
    console.error(`Impact baseline written to ${args.baseline}`)
    return
  }
  if (args.baseline !== null && existsSync(args.baseline)) {
    compareAgainstBaseline(report, args.baseline)
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
