import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { sha256 } from '../../src/indexer/resolve-files.js'
import { withFreshness } from '../../src/mcp/freshness.js'
import type { IndexFreshnessStateProvider } from '../../src/mcp/freshness.js'
import { ensureSchema } from '../../src/storage/schema.js'
import { makeInMemoryDeps, seedFile, seedSymbol } from './harness.js'

const tempDirs: string[] = []

interface Fixture {
  readonly dir: string
  readonly dbPath: string
  readonly db: Database
}

let fixture: Fixture

const moduleKeyFor = (filePath: string): string => filePath.replace(/\.[^.]+$/, '')

const writeIndexedFile = (
  db: Database,
  input: Readonly<{ filePath: string; content: string; indexedAt: number }>,
): number => {
  const absolutePath = path.join(fixture.dir, input.filePath)
  mkdirSync(path.dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, input.content)
  seedFile(db, {
    id: countSeedFiles(db) + 1,
    filePath: input.filePath,
    moduleKey: moduleKeyFor(input.filePath),
  })
  db.query('UPDATE files SET file_hash = ?, indexed_at = ? WHERE file_path = ?').run(
    sha256(input.content),
    input.indexedAt,
    input.filePath,
  )
  const row = db.query<{ id: number }, [string]>('SELECT id FROM files WHERE file_path = ?').get(input.filePath)!
  return row.id
}

const countSeedFiles = (db: Database): number => db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM files').get()!.n

const makeFixture = (): Fixture => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-freshness-'))
  tempDirs.push(dir)
  const dbPath = path.join(dir, 'index.db')
  const db = new Database(dbPath)
  ensureSchema(db)
  return { dir, dbPath, db }
}

const touchFile = (filePath: string, mtimeMs: number): void => {
  const date = new Date(mtimeMs)
  utimesSync(path.join(fixture.dir, filePath), date, date)
}

const readIndexedAt = (filePath: string): number =>
  fixture.db.query<{ indexed_at: number }, [string]>('SELECT indexed_at FROM files WHERE file_path = ?').get(filePath)!
    .indexed_at

const searchWith = (
  stateProvider: IndexFreshnessStateProvider,
): ReturnType<ReturnType<typeof withFreshness>['codeSearch']> => {
  const deps = withFreshness(
    makeInMemoryDeps(fixture.db),
    { repoRoot: fixture.dir, dbPath: fixture.dbPath },
    stateProvider,
  )
  return deps.codeSearch({ query: 'alpha', limit: 10 })
}

beforeEach(() => {
  fixture = makeFixture()
  const indexedAt = Date.now()
  const alphaFileId = writeIndexedFile(fixture.db, {
    filePath: 'src/a.ts',
    content: 'export const alpha = (): number => 1\n',
    indexedAt,
  })
  const betaFileId = writeIndexedFile(fixture.db, {
    filePath: 'src/b.ts',
    content: 'export const beta = (): number => 2\n',
    indexedAt,
  })
  seedSymbol(fixture.db, {
    id: 1,
    fileId: alphaFileId,
    filePath: 'src/a.ts',
    moduleKey: 'src/a',
    localName: 'alpha',
    qualifiedName: 'src/a#alpha',
  })
  seedSymbol(fixture.db, {
    id: 2,
    fileId: betaFileId,
    filePath: 'src/b.ts',
    moduleKey: 'src/b',
    localName: 'beta',
    qualifiedName: 'src/b#beta',
  })
  fixture.db
    .query(
      `INSERT INTO symbol_references (source_symbol_id, source_file_id, target_symbol_id, target_file_id, target_name, target_export_name, target_module_specifier, edge_type, confidence, line_number)
       VALUES (1, ?, 2, ?, 'beta', NULL, './b', 'calls', 'resolved', 1)`,
    )
    .run(alphaFileId, betaFileId)
})

afterEach(() => {
  fixture.db.close()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('withFreshness per-hit rules', () => {
  test('hit whose indexed_at is at or after mtimeMs is fresh', async () => {
    touchFile('src/a.ts', readIndexedAt('src/a.ts') - 10_000)
    const results = await searchWith(() => ({ indexFreshness: 'fresh' }))
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.find((row) => row.filePath === 'src/a.ts')!.freshness).toBe('fresh')
  })

  test('touched file with unchanged content stays fresh via hash fallback', async () => {
    const newerThanIndexedAt = readIndexedAt('src/a.ts') + 10_000
    touchFile('src/a.ts', newerThanIndexedAt)
    const results = await searchWith(() => ({ indexFreshness: 'fresh' }))
    expect(results.find((row) => row.filePath === 'src/a.ts')!.freshness).toBe('fresh')
  })

  test('content-changed file is possibly_stale', async () => {
    const newerThanIndexedAt = readIndexedAt('src/a.ts') + 10_000
    writeFileSync(path.join(fixture.dir, 'src/a.ts'), 'export const alpha = (): number => 999\n')
    touchFile('src/a.ts', newerThanIndexedAt)
    const results = await searchWith(() => ({ indexFreshness: 'fresh' }))
    expect(results.find((row) => row.filePath === 'src/a.ts')!.freshness).toBe('possibly_stale')
  })

  test('deleted file (stat failure) is possibly_stale', async () => {
    rmSync(path.join(fixture.dir, 'src/a.ts'))
    const results = await searchWith(() => ({ indexFreshness: 'fresh' }))
    expect(results.find((row) => row.filePath === 'src/a.ts')!.freshness).toBe('possibly_stale')
  })

  test('code_impact marks incoming-reference results by source file', async () => {
    const deps = withFreshness(makeInMemoryDeps(fixture.db), { repoRoot: fixture.dir, dbPath: fixture.dbPath }, () => ({
      indexFreshness: 'fresh',
    }))
    rmSync(path.join(fixture.dir, 'src/a.ts'))
    const outcome = await deps.codeImpact({ qualifiedName: 'src/b#beta', limit: 20 })
    expect(outcome.results.length).toBeGreaterThanOrEqual(1)
    expect(outcome.results[0]!.freshness).toBe('possibly_stale')
  })

  test('code_outline symbols rows are decorated by file freshness', async () => {
    const deps = withFreshness(makeInMemoryDeps(fixture.db), { repoRoot: fixture.dir, dbPath: fixture.dbPath }, () => ({
      indexFreshness: 'fresh',
    }))
    touchFile('src/a.ts', readIndexedAt('src/a.ts') - 10_000)
    const outcome = await deps.codeOutline({ filePath: 'src/a.ts', mode: 'symbols', limit: 200 })
    expect(outcome.resultCount).toBeGreaterThanOrEqual(1)
    for (const row of outcome.results) {
      expect(row.freshness).toBe('fresh')
    }
  })

  test('code_outline marks rows possibly_stale when the file content changed', async () => {
    const deps = withFreshness(makeInMemoryDeps(fixture.db), { repoRoot: fixture.dir, dbPath: fixture.dbPath }, () => ({
      indexFreshness: 'fresh',
    }))
    const newerThanIndexedAt = readIndexedAt('src/a.ts') + 10_000
    writeFileSync(path.join(fixture.dir, 'src/a.ts'), 'export const alpha = (): number => 999\n')
    touchFile('src/a.ts', newerThanIndexedAt)
    const outcome = await deps.codeOutline({ filePath: 'src/a.ts', mode: 'symbols', limit: 200 })
    expect(outcome.resultCount).toBeGreaterThanOrEqual(1)
    for (const row of outcome.results) {
      expect(row.freshness).toBe('possibly_stale')
    }
  })
})

describe('withFreshness response-level state', () => {
  test('getIndexFreshness reports the injected state provider value', () => {
    const deps = withFreshness(makeInMemoryDeps(fixture.db), { repoRoot: fixture.dir, dbPath: fixture.dbPath }, () => ({
      indexFreshness: 'possibly_stale',
    }))
    expect(deps.getIndexFreshness!()).toBe('possibly_stale')
  })

  test('a fresh provider reports fresh', () => {
    const deps = withFreshness(makeInMemoryDeps(fixture.db), { repoRoot: fixture.dir, dbPath: fixture.dbPath }, () => ({
      indexFreshness: 'fresh',
    }))
    expect(deps.getIndexFreshness!()).toBe('fresh')
  })
})

describe('freshness never affects ranking', () => {
  test('result order, rankScore, and matchReason are identical with freshness on vs off', async () => {
    const stateProvider: IndexFreshnessStateProvider = () => ({ indexFreshness: 'possibly_stale' })
    const wrapped = withFreshness(
      makeInMemoryDeps(fixture.db),
      { repoRoot: fixture.dir, dbPath: fixture.dbPath },
      stateProvider,
    )

    const withMarks = await wrapped.codeSearch({ query: 'alpha', limit: 10 })
    const withoutMarks = await makeInMemoryDeps(fixture.db).codeSearch({ query: 'alpha', limit: 10 })

    const strip = (rows: readonly object[]): readonly object[] =>
      rows.map((row) => {
        const { freshness: _freshness, ...rest } = row as { freshness?: string }
        return rest
      })

    expect(strip(withMarks)).toEqual(withoutMarks)
    expect(withMarks.map((row) => row.rankScore)).toEqual(withoutMarks.map((row) => row.rankScore))
    expect(withMarks.map((row) => row.matchedBy)).toEqual(withoutMarks.map((row) => row.matchedBy))
  })

  test('fixture sanity: indexed files still exist before deletion scenarios run', () => {
    expect(existsSync(path.join(fixture.dir, 'src/a.ts'))).toBe(true)
  })
})
