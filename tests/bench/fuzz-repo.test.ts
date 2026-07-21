import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { generateChainRepo } from '../../bench/fuzz-repo.js'
import { loadCodeindexConfig } from '../../src/config.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'

const tempDirs: string[] = []

const makeDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-fuzzrepo-'))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('generateChainRepo', () => {
  test('writes a chain of modules that index with resolved cross-file references', async () => {
    const dir = makeDir()
    const model = generateChainRepo(dir, 4)
    expect(model.files.length).toBe(4)
    expect(existsSync(path.join(dir, '.codeindex.json'))).toBe(true)
    expect(existsSync(path.join(dir, 'src', 'mod0.ts'))).toBe(true)

    const config = await loadCodeindexConfig({ configPath: path.join(dir, '.codeindex.json'), repoRoot: dir })
    const summary = await indexCodebase({ config, mode: 'full' })
    expect(summary.filesIndexed).toBe(4)
    // A 4-module chain has 3 cross-file references (mod1->mod0, mod2->mod1, mod3->mod2), all resolvable.
    expect(summary.referencesIndexed).toBeGreaterThanOrEqual(3)
  })
})
