import type { Database } from 'bun:sqlite'

import { findIncomingReferences } from '../src/search/index.js'
import type { ImpactBenchReport, ImpactTargetScore, OracleTarget } from './impact-types.js'

const IMPACT_LIMIT = 100000

interface ImpactSource {
  readonly name: string
  readonly confidence: string
}

// Distinct incoming sources code_impact reports for a target, excluding module-scope
// (null) sources and self-references — matching the oracle's exclusions.
const impactSources = (db: Database, target: string): readonly ImpactSource[] => {
  const byName = new Map<string, string>()
  for (const row of findIncomingReferences(db, { qualifiedName: target, limit: IMPACT_LIMIT })) {
    if (row.sourceQualifiedName === null || row.sourceQualifiedName === target) continue
    // Keep the strongest confidence seen for this source.
    const rank = (c: string): number => (c === 'resolved' ? 3 : c === 'file_resolved' ? 2 : 1)
    const existing = byName.get(row.sourceQualifiedName)
    if (existing === undefined || rank(row.confidence) > rank(existing)) {
      byName.set(row.sourceQualifiedName, row.confidence)
    }
  }
  return [...byName].map(([name, confidence]) => ({ name, confidence }))
}

// A zero-target scan is a broken run (bad --max-targets, an empty/unresolved oracle,
// a repo with no exported symbols), not a real result — both falseNegativeRate and
// falsePositiveRate default to 0 in that case (see the 0-denominator guards below),
// which reads as a suspiciously perfect score. Callers MUST call this before
// printing/gating a report and treat a throw as a hard failure, not a pass.
export const assertScored = (report: ImpactBenchReport): void => {
  if (report.targetsScored === 0) {
    throw new Error(
      'code_impact bench: 0 targets scored — broken run (check --max-targets and oracle resolution); refusing to gate on it.',
    )
  }
}

// Per-target tally: the report row plus the value/type and fp-by-confidence buckets
// scoreImpact accumulates across all targets. Split out of scoreImpact purely to stay
// under max-lines-per-function — behavior is identical to inlining this in a .map.
interface TargetTally {
  readonly score: ImpactTargetScore
  readonly valueTrue: number
  readonly valueFalseNegatives: number
  readonly typeTrue: number
  readonly typeFalseNegatives: number
  readonly fpByConfidence: Readonly<Record<string, number>>
}

const scoreTarget = (db: Database, entry: OracleTarget): TargetTally => {
  const truthNames = new Set(entry.trueSources.map((s) => s.name))
  const reported = impactSources(db, entry.target)
  const reportedNames = new Set(reported.map((r) => r.name))

  let fn = 0
  let valueTrue = 0
  let valueFalseNegatives = 0
  let typeTrue = 0
  let typeFalseNegatives = 0
  for (const source of entry.trueSources) {
    const covered = reportedNames.has(source.name)
    if (!covered) fn += 1
    if (source.position === 'value' || source.position === 'both') {
      valueTrue += 1
      if (!covered) valueFalseNegatives += 1
    } else {
      typeTrue += 1
      if (!covered) typeFalseNegatives += 1
    }
  }

  const fpRows = reported.filter((r) => !truthNames.has(r.name))
  const fpByConfidence: Record<string, number> = {}
  for (const fp of fpRows) fpByConfidence[fp.confidence] = (fpByConfidence[fp.confidence] ?? 0) + 1

  return {
    score: {
      target: entry.target,
      trueSourceCount: entry.trueSources.length,
      impactSourceCount: reported.length,
      falseNegatives: fn,
      falsePositives: fpRows.length,
    },
    valueTrue,
    valueFalseNegatives,
    typeTrue,
    typeFalseNegatives,
    fpByConfidence,
  }
}

export const scoreImpact = (db: Database, oracle: readonly OracleTarget[], repo: string): ImpactBenchReport => {
  const fpByConfidence: Record<string, number> = {}
  let trueReferenceCount = 0
  let impactReferenceCount = 0
  let falseNegatives = 0
  let falsePositives = 0
  let valueTrueReferenceCount = 0
  let valueFalseNegatives = 0
  let typeTrueReferenceCount = 0
  let typeFalseNegatives = 0
  const perTarget: ImpactTargetScore[] = []

  for (const entry of oracle) {
    const tally = scoreTarget(db, entry)
    perTarget.push(tally.score)
    trueReferenceCount += entry.trueSources.length
    impactReferenceCount += tally.score.impactSourceCount
    falseNegatives += tally.score.falseNegatives
    falsePositives += tally.score.falsePositives
    valueTrueReferenceCount += tally.valueTrue
    valueFalseNegatives += tally.valueFalseNegatives
    typeTrueReferenceCount += tally.typeTrue
    typeFalseNegatives += tally.typeFalseNegatives
    for (const [confidence, count] of Object.entries(tally.fpByConfidence)) {
      fpByConfidence[confidence] = (fpByConfidence[confidence] ?? 0) + count
    }
  }

  return {
    repo,
    targetsScored: oracle.length,
    trueReferenceCount,
    impactReferenceCount,
    falseNegatives,
    falseNegativeRate: trueReferenceCount === 0 ? 0 : falseNegatives / trueReferenceCount,
    falsePositives,
    falsePositiveRate: impactReferenceCount === 0 ? 0 : falsePositives / impactReferenceCount,
    falsePositivesByConfidence: fpByConfidence,
    valueTrueReferenceCount,
    valueFalseNegatives,
    valueFalseNegativeRate: valueTrueReferenceCount === 0 ? 0 : valueFalseNegatives / valueTrueReferenceCount,
    typeTrueReferenceCount,
    typeFalseNegatives,
    typeFalseNegativeRate: typeTrueReferenceCount === 0 ? 0 : typeFalseNegatives / typeTrueReferenceCount,
    perTarget,
  }
}
