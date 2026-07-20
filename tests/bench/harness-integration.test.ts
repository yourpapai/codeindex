import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { parseCorpus } from '../../bench/corpus.js'
import { scoreCorpus } from '../../bench/harness.js'
import { loadCodeindexConfig } from '../../src/config.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import { openDatabase } from '../../src/storage/db.js'

const tempDirs: string[] = []

const makeRepo = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-bench-'))
  tempDirs.push(dir)
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
  writeFileSync(path.join(dir, 'src', 'math.ts'), 'export const addNumbers = (a: number, b: number): number => a + b\n')
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('scoreCorpus end-to-end', () => {
  test('finds a symbol in a freshly indexed repo', async () => {
    const repo = makeRepo()
    const config = await loadCodeindexConfig({ configPath: path.join(repo, '.codeindex.json'), repoRoot: repo })
    await indexCodebase({ config, mode: 'full' })
    const db = openDatabase(config.dbPath)
    try {
      const corpus = parseCorpus({
        name: 'e2e',
        queries: [{ id: 'q', kind: 'find-symbol', query: 'addNumbers', relevant: ['src/math#addNumbers'] }],
      })
      const report = scoreCorpus(db, corpus, 10)
      expect(report.mrr).toBe(1)
    } finally {
      db.close()
    }
  })
})
