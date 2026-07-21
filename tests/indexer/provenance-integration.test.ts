import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { computeConfigIdentity, loadCodeindexConfig } from '../../src/config.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import { openDatabase } from '../../src/storage/db.js'
import { getIndexProvenance } from '../../src/storage/provenance.js'

const tempDirs: string[] = []

const makeRepo = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-prov-'))
  tempDirs.push(dir)
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const alpha = (): number => 1\n')
  return dir
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('indexCodebase writes provenance', () => {
  test('stamps config identity + timestamp; git fields null for a non-git repo', async () => {
    const repo = makeRepo()
    const config = await loadCodeindexConfig({ configPath: path.join(repo, '.codeindex.json'), repoRoot: repo })
    await indexCodebase({ config, mode: 'full' })
    const db = openDatabase(config.dbPath)
    try {
      const provenance = getIndexProvenance(db)
      expect(provenance).not.toBeNull()
      expect(provenance!.configHash).toBe(computeConfigIdentity(config))
      expect(provenance!.roots).toEqual(['src'])
      expect(provenance!.gitCommit).toBeNull()
      expect(provenance!.gitBranch).toBeNull()
      expect(provenance!.indexedAt.length).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })
})
