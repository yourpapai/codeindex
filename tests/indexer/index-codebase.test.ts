import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadCodeindexConfig } from '../../src/config.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import { findIncomingReferences } from '../../src/search/index.js'
import { openDatabase } from '../../src/storage/db.js'
import { ensureSchema } from '../../src/storage/schema.js'

const tempDirs: string[] = []

const makeRepo = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-prune-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('indexCodebase pruning', () => {
  test('full mode removes stale file row and its symbols when a file is deleted', async () => {
    const repoRoot = makeRepo()
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true })
    writeFileSync(path.join(repoRoot, 'src', 'helper.ts'), 'export function helper() { return 1 }\n')
    writeFileSync(path.join(repoRoot, 'src', 'main.ts'), 'export function main() { return 2 }\n')
    writeFileSync(path.join(repoRoot, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))

    const config = await loadCodeindexConfig({
      configPath: path.join(repoRoot, '.codeindex.json'),
      repoRoot,
    })

    await indexCodebase({ config, mode: 'full' })

    unlinkSync(path.join(repoRoot, 'src', 'helper.ts'))

    const summary = await indexCodebase({ config, mode: 'full' })

    expect(summary.filesPruned).toBe(1)
    expect(summary.filesIndexed).toBe(1)

    const db = openDatabase(config.dbPath)
    ensureSchema(db)
    const rows = db
      .query<{ file_path: string }, []>('SELECT file_path FROM files')
      .all()
      .map((r) => r.file_path)
    db.close()

    expect(rows).not.toContain('src/helper.ts')
    expect(rows).toContain('src/main.ts')
  })

  test('incremental mode removes stale file rows when a file is deleted', async () => {
    const repoRoot = makeRepo()
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true })
    writeFileSync(path.join(repoRoot, 'src', 'helper.ts'), 'export function helper() { return 1 }\n')
    writeFileSync(path.join(repoRoot, 'src', 'main.ts'), 'export function main() { return 2 }\n')
    writeFileSync(path.join(repoRoot, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))

    const config = await loadCodeindexConfig({
      configPath: path.join(repoRoot, '.codeindex.json'),
      repoRoot,
    })

    await indexCodebase({ config, mode: 'full' })

    unlinkSync(path.join(repoRoot, 'src', 'helper.ts'))

    const summary = await indexCodebase({ config, mode: 'incremental' })

    expect(summary.filesPruned).toBe(1)

    const db = openDatabase(config.dbPath)
    ensureSchema(db)
    const rows = db
      .query<{ file_path: string }, []>('SELECT file_path FROM files')
      .all()
      .map((r) => r.file_path)
    db.close()

    expect(rows).not.toContain('src/helper.ts')
  })

  test('incremental mode reindexes importers of a deleted file', async () => {
    const repoRoot = makeRepo()
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true })
    writeFileSync(path.join(repoRoot, 'src', 'helper.ts'), 'export function helper() { return 1 }\n')
    writeFileSync(
      path.join(repoRoot, 'src', 'main.ts'),
      "import { helper } from './helper.js'\nexport function main() { return helper() }\n",
    )
    writeFileSync(path.join(repoRoot, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))

    const config = await loadCodeindexConfig({
      configPath: path.join(repoRoot, '.codeindex.json'),
      repoRoot,
    })

    await indexCodebase({ config, mode: 'full' })

    unlinkSync(path.join(repoRoot, 'src', 'helper.ts'))

    const summary = await indexCodebase({ config, mode: 'incremental' })

    expect(summary.filesPruned).toBe(1)
    expect(summary.filesIndexed).toBe(1)
  })

  test('incremental mode reindexes callers when previously-unresolved import becomes resolvable', async () => {
    const repoRoot = makeRepo()
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true })
    writeFileSync(path.join(repoRoot, 'src', 'helper.ts'), 'export function other() { return 0 }\n')
    writeFileSync(
      path.join(repoRoot, 'src', 'main.ts'),
      "import { myFunc } from './helper.js'\nexport function run() { return myFunc() }\n",
    )
    writeFileSync(path.join(repoRoot, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))

    const config = await loadCodeindexConfig({
      configPath: path.join(repoRoot, '.codeindex.json'),
      repoRoot,
    })

    const fullSummary = await indexCodebase({ config, mode: 'full' })
    expect(fullSummary.referencesUnresolved).toBeGreaterThan(0)

    writeFileSync(
      path.join(repoRoot, 'src', 'helper.ts'),
      'export function other() { return 0 }\nexport function myFunc() { return 1 }\n',
    )

    const incrementalSummary = await indexCodebase({ config, mode: 'incremental' })

    expect(incrementalSummary.filesIndexed).toBe(2)
    expect(incrementalSummary.referencesUnresolved).toBe(0)
  })

  test('no pruning occurs when all files still exist', async () => {
    const repoRoot = makeRepo()
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true })
    writeFileSync(path.join(repoRoot, 'src', 'helper.ts'), 'export function helper() { return 1 }\n')
    writeFileSync(path.join(repoRoot, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))

    const config = await loadCodeindexConfig({
      configPath: path.join(repoRoot, '.codeindex.json'),
      repoRoot,
    })

    await indexCodebase({ config, mode: 'full' })
    const summary = await indexCodebase({ config, mode: 'full' })

    expect(summary.filesPruned).toBe(0)
  })
})

test('code_impact reports JSX component usage and class heritage end-to-end', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-s2-e2e-'))
  try {
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, 'src/button.tsx'), 'export function Button() { return null }\n')
    writeFileSync(path.join(dir, 'src/base.ts'), 'export class Base {}\n')
    writeFileSync(
      path.join(dir, 'src/app.tsx'),
      "import { Button } from './button.js'\n" +
        "import { Base } from './base.js'\n" +
        'export class App extends Base {}\n' +
        'export function Screen() { return <Button /> }\n',
    )
    writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
    const config = await loadCodeindexConfig({ configPath: path.join(dir, '.codeindex.json'), repoRoot: dir })
    await indexCodebase({ config, mode: 'full' })
    const db = openDatabase(config.dbPath)
    try {
      const buttonRefs = findIncomingReferences(db, { qualifiedName: 'src/button#Button', limit: 100 })
      const screenReference = buttonRefs.find((r) => r.sourceQualifiedName === 'src/app#Screen')
      expect(screenReference?.edgeType).toBe('references')
      const baseRefs = findIncomingReferences(db, { qualifiedName: 'src/base#Base', limit: 100 })
      const appReference = baseRefs.find((r) => r.sourceQualifiedName === 'src/app#App')
      expect(appReference?.edgeType).toBe('extends')
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
