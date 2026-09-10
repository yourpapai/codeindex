import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadCodeindexConfig, type CodeindexConfig } from '../../src/config.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import { createWatcher, type IndexWatcher } from '../../src/mcp/watcher.js'
import { findIncomingReferences } from '../../src/search/index.js'
import { openDatabase } from '../../src/storage/db.js'

const tempDirs: string[] = []
const watchers: IndexWatcher[] = []

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const waitForArmed = async (watcher: IndexWatcher): Promise<void> => {
  const deadline = Date.now() + 5000
  while (!watcher.isArmed()) {
    if (Date.now() > deadline) {
      throw new Error(`watcher did not arm: ${JSON.stringify(watcher.getState())}`)
    }
    await delay(15)
  }
}

afterEach(() => {
  for (const watcher of watchers.splice(0)) {
    watcher.stop()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

const makeConfig = (): Promise<CodeindexConfig> => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'codeindex-repair-e2e-'))
  tempDirs.push(repoRoot)
  mkdirSync(path.join(repoRoot, 'src'), { recursive: true })
  writeFileSync(path.join(repoRoot, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
  writeFileSync(path.join(repoRoot, 'src/a.ts'), "import { helper } from './b'\nexport const alpha = helper()\n")
  writeFileSync(path.join(repoRoot, 'src/b.ts'), 'export function helper(): number {\n  return 1\n}\n')
  return loadCodeindexConfig({ configPath: path.join(repoRoot, '.codeindex.json'), repoRoot })
}

const makeConfigWithCallerOnly = (): Promise<CodeindexConfig> => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'codeindex-repair-e2e-'))
  tempDirs.push(repoRoot)
  mkdirSync(path.join(repoRoot, 'src'), { recursive: true })
  writeFileSync(path.join(repoRoot, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
  writeFileSync(path.join(repoRoot, 'src/a.ts'), "import { helper } from './b'\nexport const alpha = helper()\n")
  return loadCodeindexConfig({ configPath: path.join(repoRoot, '.codeindex.json'), repoRoot })
}

interface ImpactRow {
  readonly sourceFilePath: string
  readonly confidence: string
}

const impactOn = (config: CodeindexConfig, qualifiedName: string): readonly ImpactRow[] => {
  const db = openDatabase(config.dbPath)
  try {
    return findIncomingReferences(db, { qualifiedName, limit: 20 }).map((row) => ({
      sourceFilePath: row.sourceFilePath,
      confidence: row.confidence,
    }))
  } finally {
    db.close()
  }
}

const withDb = <T>(config: CodeindexConfig, callback: (db: ReturnType<typeof openDatabase>) => T): T => {
  const db = openDatabase(config.dbPath)
  try {
    return callback(db)
  } finally {
    db.close()
  }
}

const inDegreeOf = (config: CodeindexConfig, qualifiedName: string): number => {
  const db = openDatabase(config.dbPath)
  try {
    return (
      db
        .query<{ in_degree: number }, [string]>('SELECT in_degree FROM symbols WHERE qualified_name = ? COLLATE NOCASE')
        .get(qualifiedName)?.in_degree ?? -1
    )
  } finally {
    db.close()
  }
}

// Reproduce the orphaning a reindex inflicts: the target file's symbols are delete+reinserted and
// every edge pointing at them loses its target binding to ON DELETE SET NULL.
const orphanTargetFileSymbols = (config: CodeindexConfig): void => {
  const db = openDatabase(config.dbPath)
  try {
    const fileId = db.query<{ id: number }, [string]>('SELECT id FROM files WHERE file_path = ?').get('src/b.ts')!.id
    db.run('BEGIN')
    db.query('DELETE FROM symbols WHERE file_id = ?').run(fileId)
    db.query(
      `INSERT INTO symbols (file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line)
       VALUES (?, 'src/b.ts', 'src/b', 'src/b.ts#reinserted', 'helper', 'src/b#helper', 'function_declaration', 'exported', NULL, '["helper"]', '', '', '', 'helper', 1, 1)`,
    ).run(fileId)
    db.run('COMMIT')
  } finally {
    db.close()
  }
}

describe('reference graph durability through reindexes', () => {
  test('an incremental run repairs orphaned edges and counts them in in-degree in the same run', async () => {
    const config = await makeConfig()
    await indexCodebase({ config, mode: 'full' })
    // a.ts produces two resolved edges onto helper — the import binding and the call site.
    expect(impactOn(config, 'src/b#helper')).toEqual([
      { sourceFilePath: 'src/a.ts', confidence: 'resolved' },
      { sourceFilePath: 'src/a.ts', confidence: 'resolved' },
    ])

    orphanTargetFileSymbols(config)
    expect(impactOn(config, 'src/b#helper')).toEqual([])

    const summary = await indexCodebase({ config, mode: 'incremental' })

    // Tier-1 repair re-derives the resolver's scope from stored rows: the imports edge carries the
    // './b' specifier and re-binds; the bare call edge scoped to the source module (its original
    // binding rode the per-file import map, which repair does not reconstruct) stays unbound and
    // invisible to code_impact — honest degradation, measured by the edit fuzzer.
    expect(summary.referencesRepaired).toBe(1)
    expect(impactOn(config, 'src/b#helper')).toEqual([{ sourceFilePath: 'src/a.ts', confidence: 'resolved' }])
    expect(inDegreeOf(config, 'src/b#helper')).toBe(1)
  })

  test('the startup catch-up heals a pre-upgrade orphaned database with no schema bump and no wipe', async () => {
    // Pre-upgrade damage shape: a.ts was indexed before src/b.ts existed, so its edges stored
    // unresolved with no target file binding — invisible to the incremental dependents query, so
    // no batch ever re-parsed a.ts. Only repair can re-link them once b.ts appears.
    const config = await makeConfigWithCallerOnly()
    await indexCodebase({ config, mode: 'full' })
    writeFileSync(path.join(config.repoRoot, 'src/b.ts'), 'export function helper(): number {\n  return 1\n}\n')

    const before = withDb(config, (db) => ({
      userVersion: db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version,
      alphaSymbolId: db
        .query<{ id: number }, [string]>('SELECT id FROM symbols WHERE qualified_name = ? COLLATE NOCASE')
        .get('src/a#alpha')!.id,
    }))

    const watcher = createWatcher(config, ({ mode }) => indexCodebase({ config, mode }))
    watchers.push(watcher)
    await watcher.start()
    await waitForArmed(watcher)

    // The imports edge is uniquely re-matchable (specifier './b' now resolves to a module with a
    // unique local `helper`); its stored confidence rides through untouched.
    expect(impactOn(config, 'src/b#helper')).toEqual([{ sourceFilePath: 'src/a.ts', confidence: 'name_only' }])
    expect(inDegreeOf(config, 'src/b#helper')).toBe(1)
    const after = withDb(config, (db) => ({
      userVersion: db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version,
      alphaSymbolId: db
        .query<{ id: number }, [string]>('SELECT id FROM symbols WHERE qualified_name = ? COLLATE NOCASE')
        .get('src/a#alpha')!.id,
    }))
    expect(after).toEqual(before)
  })
})
