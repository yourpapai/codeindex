import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import path from 'node:path'

import { buildReferenceOracle } from '../../bench/impact-oracle.js'
import { scoreImpact } from '../../bench/impact-score.js'
import { loadCodeindexConfig } from '../../src/config.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import { openDatabase } from '../../src/storage/db.js'

const repoRoot = path.join(import.meta.dir, '../../bench/fixtures/impact-demo')

afterAll(() => {
  rmSync(path.join(repoRoot, '.codeindex'), { recursive: true, force: true })
})

describe('impact-demo fixture', () => {
  test('B1/B3 zero the jsx & heritage value-FN buckets; member/namespace/bare-value stay lit', async () => {
    const config = await loadCodeindexConfig({
      configPath: path.join(repoRoot, '.codeindex.json'),
      repoRoot,
    })
    await indexCodebase({ config, mode: 'full' })
    const db = openDatabase(config.dbPath)
    try {
      const oracle = buildReferenceOracle(db, {
        repoRoot,
        tsconfigPath: path.join(repoRoot, 'tsconfig.json'),
      })
      const report = scoreImpact(db, oracle, 'impact-demo')
      // B1/B3: jsx and heritage references are present and fully covered (zero FN).
      expect(report.valueTrueReferenceCountByShape['jsx']).toBe(1)
      expect(report.valueFalseNegativesByShape['jsx']).toBeFalsy()
      expect(report.valueTrueReferenceCountByShape['heritage']).toBe(1)
      expect(report.valueFalseNegativesByShape['heritage']).toBeFalsy()
      // The ranked remaining work is lit and separated.
      expect(report.valueFalseNegativesByShape['member']).toBeGreaterThan(0)
      expect(report.valueFalseNegativesByShape['namespace']).toBeGreaterThan(0)
      expect(report.valueFalseNegativesByShape['bare-value']).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })
})
