import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadCodeindexConfig } from '../src/config.js'
import { indexCodebase } from '../src/indexer/index-codebase.js'
import { findIncomingReferences } from '../src/search/index.js'
import { openDatabase } from '../src/storage/db.js'

const tempDirs: string[] = []

const makeRepo = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-index-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('indexCodebase', () => {
  test('indexes a small repo and reports counts', async () => {
    const repoRoot = makeRepo()
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true })
    writeFileSync(path.join(repoRoot, 'src', 'helper.ts'), 'export function helper() { return 1 }\n')
    writeFileSync(
      path.join(repoRoot, 'src', 'run-task.ts'),
      "import { helper } from './helper'\nexport function runTask() { return helper() }\n",
    )
    writeFileSync(path.join(repoRoot, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))

    const config = await loadCodeindexConfig({
      configPath: path.join(repoRoot, '.codeindex.json'),
      repoRoot,
    })

    const summary = await indexCodebase({ config, mode: 'full' })

    expect(summary.filesIndexed).toBe(2)
    expect(summary.symbolsIndexed).toBeGreaterThanOrEqual(2)
    expect(summary.referencesIndexed).toBeGreaterThanOrEqual(1)
    expect(summary.filesFailed).toBe(0)
  })

  test('B4: code_impact links a caller that imports a symbol through a barrel re-export', async () => {
    const repoRoot = makeRepo()
    mkdirSync(path.join(repoRoot, 'src', 'commands'), { recursive: true })
    // Real declaration.
    writeFileSync(
      path.join(repoRoot, 'src', 'commands', 'dashboard.ts'),
      'export function registerDashboardCommand(): number {\n  return 1\n}\n',
    )
    // Barrel: `export { registerDashboardCommand } from './dashboard.js'`.
    writeFileSync(
      path.join(repoRoot, 'src', 'commands', 'index.ts'),
      "export { registerDashboardCommand } from './dashboard.js'\n",
    )
    // Caller imports from the barrel and calls it.
    writeFileSync(
      path.join(repoRoot, 'src', 'bot.ts'),
      "import { registerDashboardCommand } from './commands/index.js'\n" +
        'export function registerCommands(): number {\n  return registerDashboardCommand()\n}\n',
    )
    writeFileSync(path.join(repoRoot, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
    const config = await loadCodeindexConfig({ configPath: path.join(repoRoot, '.codeindex.json'), repoRoot })
    await indexCodebase({ config, mode: 'full' })

    const db = openDatabase(config.dbPath)
    try {
      const incoming = findIncomingReferences(db, {
        qualifiedName: 'src/commands/dashboard#registerDashboardCommand',
        limit: 100,
      })
      const callEdges = incoming
        .filter((r) => r.edgeType === 'calls')
        .filter((r) => r.sourceQualifiedName === 'src/bot#registerCommands')
      // Exactly one bridged call edge, resolved (a real symbol resolution, not a name-only guess).
      expect(callEdges.map((r) => r.confidence)).toEqual(['resolved'])
    } finally {
      db.close()
    }
  })

  test('incremental mode reindexes changed files and narrow dependents without full rebuild', async () => {
    const repoRoot = makeRepo()
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true })
    writeFileSync(path.join(repoRoot, 'src', 'helper.ts'), 'export function helper() { return 1 }\n')
    writeFileSync(
      path.join(repoRoot, 'src', 'run-task.ts'),
      "import { helper } from './helper'\nexport function runTask() { return helper() }\n",
    )
    writeFileSync(path.join(repoRoot, 'src', 'unrelated.ts'), 'export const unrelated = 1\n')
    writeFileSync(path.join(repoRoot, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))

    const config = await loadCodeindexConfig({
      configPath: path.join(repoRoot, '.codeindex.json'),
      repoRoot,
    })

    await indexCodebase({ config, mode: 'full' })

    writeFileSync(path.join(repoRoot, 'src', 'helper.ts'), 'export function helperRenamed() { return 2 }\n')

    const summary = await indexCodebase({ config, mode: 'incremental' })
    expect(summary.filesIndexed).toBe(2)
    expect(summary.filesFailed).toBe(0)
  })
})
