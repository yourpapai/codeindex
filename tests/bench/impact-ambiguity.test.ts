import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import path from 'node:path'

import { loadCodeindexConfig } from '../../src/config.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import { resolveIncomingReferences } from '../../src/search/index.js'
import { openDatabase } from '../../src/storage/db.js'

const repoRoot = path.join(import.meta.dir, '../../bench/fixtures/impact-ambiguity')

afterAll(() => {
  rmSync(path.join(repoRoot, '.codeindex'), { recursive: true, force: true })
})

const identityOf = (
  outcome: ReturnType<typeof resolveIncomingReferences>,
): {
  status: string
  matchedBy?: string
  qualifiedName?: string
  reason?: string
  candidates?: readonly { qualifiedName: string }[]
} =>
  outcome.resolution.status === 'unresolved'
    ? {
        status: outcome.resolution.status,
        reason: outcome.resolution.reason,
        candidates: outcome.resolution.candidates?.map((c) => ({ qualifiedName: c.qualifiedName })),
      }
    : {
        status: outcome.resolution.status,
        matchedBy: outcome.resolution.matchedBy,
        qualifiedName: outcome.resolution.qualifiedName,
      }

describe('impact-ambiguity fixture identity levers', () => {
  test('unique-export accept, multi-export refuse+candidates, Module#Name partial accept', async () => {
    const config = await loadCodeindexConfig({
      configPath: path.join(repoRoot, '.codeindex.json'),
      repoRoot,
    })
    await indexCodebase({ config, mode: 'full' })
    const db = openDatabase(config.dbPath)
    try {
      // Lever A: unique-export bare name despite member noise.
      const uniqueExport = resolveIncomingReferences(db, { qualifiedName: 'alpha', limit: 20 })
      expect(uniqueExport.resolution).toMatchObject({
        status: 'resolved',
        matchedBy: 'local_name',
      })
      expect(
        uniqueExport.resolution.status === 'resolved' && uniqueExport.resolution.qualifiedName.endsWith('#alpha'),
      ).toBe(true)

      // Lever B: two exports named Helper stay unresolved with candidates, no auto-pick.
      const multiExport = resolveIncomingReferences(db, { qualifiedName: 'Helper', limit: 20 })
      expect(multiExport.results).toEqual([])
      expect(multiExport.resolution.status).toBe('unresolved')
      expect(multiExport.resolution.status === 'unresolved' && multiExport.resolution.reason).toBe('ambiguous')
      const candidates = multiExport.resolution.status === 'unresolved' ? (multiExport.resolution.candidates ?? []) : []
      expect(candidates.length).toBe(2)
      const candidateNames = candidates.map((c) => c.qualifiedName)
      expect(candidateNames.some((name) => name.includes('helper-a#Helper'))).toBe(true)
      expect(candidateNames.some((name) => name.includes('helper-b#Helper'))).toBe(true)
      expect(candidates.every((c) => c.scopeTier === 'exported')).toBe(true)

      // Lever C: Module#Name partial resolves the Toast Action, not Button's.
      const partial = resolveIncomingReferences(db, { qualifiedName: 'Toast#Action', limit: 20 })
      expect(identityOf(partial)).toMatchObject({
        status: 'resolved',
        matchedBy: 'module_name',
      })
      expect(partial.resolution.status === 'resolved' && partial.resolution.qualifiedName).toContain('Toast>Action')
    } finally {
      db.close()
    }
  })
})
