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

export const scoreImpact = (db: Database, oracle: readonly OracleTarget[], repo: string): ImpactBenchReport => {
  const fpByConfidence: Record<string, number> = {}
  let trueReferenceCount = 0
  let impactReferenceCount = 0
  let falseNegatives = 0
  let falsePositives = 0

  const perTarget: readonly ImpactTargetScore[] = oracle.map((entry) => {
    const truth = new Set(entry.trueSources)
    const reported = impactSources(db, entry.target)
    const reportedNames = new Set(reported.map((r) => r.name))

    const fn = [...truth].filter((s) => !reportedNames.has(s)).length
    const fpRows = reported.filter((r) => !truth.has(r.name))
    for (const fp of fpRows) fpByConfidence[fp.confidence] = (fpByConfidence[fp.confidence] ?? 0) + 1

    trueReferenceCount += truth.size
    impactReferenceCount += reported.length
    falseNegatives += fn
    falsePositives += fpRows.length

    return {
      target: entry.target,
      trueSourceCount: truth.size,
      impactSourceCount: reported.length,
      falseNegatives: fn,
      falsePositives: fpRows.length,
    }
  })

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
    perTarget,
  }
}
