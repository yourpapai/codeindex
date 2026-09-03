import type { Database } from 'bun:sqlite'

import { findIncomingReferences } from '../src/search/index.js'
import type { ImpactBenchReport, ImpactTargetScore, OracleTarget, Shape } from './impact-types.js'

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
  readonly valueTrueByShape: Readonly<Record<string, number>>
  readonly valueFalseNegativesByShape: Readonly<Record<string, number>>
  readonly typeTrueByShape: Readonly<Record<string, number>>
  readonly typeFalseNegativesByShape: Readonly<Record<string, number>>
  readonly fpByConfidence: Readonly<Record<string, number>>
}

// Counts every shape a source uses into `trueByShape`, and again into
// `falseNegativesByShape` when code_impact does not cover the source. Value and type
// tiers share the loop; extracted purely to keep scoreTarget under max-lines-per-function.
const addShapeCounts = (
  shapes: readonly Shape[],
  covered: boolean,
  trueByShape: Record<string, number>,
  falseNegativesByShape: Record<string, number>,
): void => {
  for (const shape of shapes) {
    trueByShape[shape] = (trueByShape[shape] ?? 0) + 1
    if (!covered) falseNegativesByShape[shape] = (falseNegativesByShape[shape] ?? 0) + 1
  }
}

// Tallies false positives (reported sources that are not true sources) by confidence.
// Extracted purely to keep scoreTarget under max-lines-per-function.
const fpCountsByConfidence = (
  reported: readonly ImpactSource[],
  truthNames: ReadonlySet<string>,
): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const fp of reported) {
    if (truthNames.has(fp.name)) continue
    counts[fp.confidence] = (counts[fp.confidence] ?? 0) + 1
  }
  return counts
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
  const valueTrueByShape: Record<string, number> = {}
  const valueFalseNegativesByShape: Record<string, number> = {}
  const typeTrueByShape: Record<string, number> = {}
  const typeFalseNegativesByShape: Record<string, number> = {}
  for (const source of entry.trueSources) {
    const covered = reportedNames.has(source.name)
    if (!covered) fn += 1
    if (source.position === 'value' || source.position === 'both') {
      valueTrue += 1
      if (!covered) valueFalseNegatives += 1
      addShapeCounts(source.shapes, covered, valueTrueByShape, valueFalseNegativesByShape)
    } else {
      typeTrue += 1
      if (!covered) typeFalseNegatives += 1
      addShapeCounts(source.shapes, covered, typeTrueByShape, typeFalseNegativesByShape)
    }
  }

  const fpRows = reported.filter((r) => !truthNames.has(r.name))
  const fpByConfidence = fpCountsByConfidence(reported, truthNames)

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
    valueTrueByShape,
    valueFalseNegativesByShape,
    typeTrueByShape,
    typeFalseNegativesByShape,
    fpByConfidence,
  }
}

// Merges a per-target shape/confidence bucket into the running aggregate. Extracted
// purely to stay under max-lines-per-function in scoreImpact.
const addCounts = (totals: Record<string, number>, counts: Readonly<Record<string, number>>): void => {
  for (const [key, count] of Object.entries(counts)) totals[key] = (totals[key] ?? 0) + count
}

// Sums a numeric field across tallies. Extracted alongside addCounts so scoreImpact's
// aggregation reads as a list of independent folds rather than a wall of `let`s.
const sumBy = <T>(items: readonly T[], pick: (item: T) => number): number =>
  items.reduce((total, item) => total + pick(item), 0)

export const scoreImpact = (db: Database, oracle: readonly OracleTarget[], repo: string): ImpactBenchReport => {
  const tallies = oracle.map((entry) => scoreTarget(db, entry))
  const perTarget = tallies.map((tally) => tally.score)

  const fpByConfidence: Record<string, number> = {}
  const valueTrueReferenceCountByShape: Record<string, number> = {}
  const valueFalseNegativesByShape: Record<string, number> = {}
  const typeTrueReferenceCountByShape: Record<string, number> = {}
  const typeFalseNegativesByShape: Record<string, number> = {}
  for (const tally of tallies) {
    addCounts(fpByConfidence, tally.fpByConfidence)
    addCounts(valueTrueReferenceCountByShape, tally.valueTrueByShape)
    addCounts(valueFalseNegativesByShape, tally.valueFalseNegativesByShape)
    addCounts(typeTrueReferenceCountByShape, tally.typeTrueByShape)
    addCounts(typeFalseNegativesByShape, tally.typeFalseNegativesByShape)
  }

  const trueReferenceCount = sumBy(oracle, (entry) => entry.trueSources.length)
  const impactReferenceCount = sumBy(tallies, (tally) => tally.score.impactSourceCount)
  const falseNegatives = sumBy(tallies, (tally) => tally.score.falseNegatives)
  const falsePositives = sumBy(tallies, (tally) => tally.score.falsePositives)
  const valueTrueReferenceCount = sumBy(tallies, (tally) => tally.valueTrue)
  const valueFalseNegatives = sumBy(tallies, (tally) => tally.valueFalseNegatives)
  const typeTrueReferenceCount = sumBy(tallies, (tally) => tally.typeTrue)
  const typeFalseNegatives = sumBy(tallies, (tally) => tally.typeFalseNegatives)

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
    valueTrueReferenceCountByShape,
    valueFalseNegativesByShape,
    typeTrueReferenceCountByShape,
    typeFalseNegativesByShape,
    perTarget,
  }
}
