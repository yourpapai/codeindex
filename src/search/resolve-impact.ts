import type { Database } from 'bun:sqlite'

import {
  findSymbolsByLocalName,
  queryIncomingRows,
  resolveCanonicalTarget,
  resolveExactOrPartialCandidate,
  unresolvedFromLocalNameMatches,
} from './impact-identity.js'
import type { ImpactLookupInput, ImpactLookupOutcome } from './impact-types.js'

export const resolveIncomingReferences = (db: Database, input: Readonly<ImpactLookupInput>): ImpactLookupOutcome => {
  if (input.symbolKey === undefined && input.qualifiedName === undefined) {
    throw new Error('Either symbolKey or qualifiedName is required')
  }

  const canonical = resolveCanonicalTarget(db, input)
  if (canonical !== undefined) {
    return { resolution: canonical.resolution, results: queryIncomingRows(db, canonical.id, input.limit) }
  }

  const identityInputs: readonly string[] = [input.symbolKey, input.qualifiedName].filter(
    (value): value is string => value !== undefined,
  )
  for (const identity of identityInputs) {
    const outcome = resolveExactOrPartialCandidate(db, identity)
    if (outcome?.kind === 'resolved') {
      return { resolution: outcome.target.resolution, results: queryIncomingRows(db, outcome.target.id, input.limit) }
    }
    if (outcome?.kind === 'ambiguous_partial') {
      return { resolution: unresolvedFromLocalNameMatches(outcome.rows), results: [] }
    }
  }

  // Lever B: honest multi-match candidates. Prefer the identity that actually
  // produced local-name hits so agents can pick a precise retry key.
  for (const identity of identityInputs) {
    const matches = findSymbolsByLocalName(db, identity)
    if (matches.length > 0) {
      return { resolution: unresolvedFromLocalNameMatches(matches), results: [] }
    }
  }

  return { resolution: { status: 'unresolved', reason: 'unknown' }, results: [] }
}
