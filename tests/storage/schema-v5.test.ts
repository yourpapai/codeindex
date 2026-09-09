import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import { openDatabase } from '../../src/storage/db.js'
import { insertFile, markParseFailure } from '../../src/storage/queries.js'
import { ensureSchema } from '../../src/storage/schema.js'

const tempDirs: string[] = []

const makeTempDbPath = (): { dir: string; dbPath: string } => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-schema-v5-'))
  tempDirs.push(dir)
  return { dir, dbPath: path.join(dir, 'index.db') }
}

const downgradeToV4 = (db: Database): void => {
  db.run('PRAGMA user_version = 4')
}

const readUserVersion = (db: Database): number =>
  db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version

const countRows = (db: Database, table: string): number =>
  db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('schema v5 migration', () => {
  test('opening a v4 database wipes and recreates all tables at v5', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    const fileId = insertFile(db, {
      filePath: 'src/a.ts',
      moduleKey: 'src/a',
      language: 'ts',
      fileHash: 'x',
    })
    db.query(
      `INSERT INTO symbols (id, file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line)
       VALUES (1, ?, 'src/a.ts', 'src/a', 'src/a.ts#1-2', 'thing', 'src/a#thing', 'function_declaration', 'exported', NULL, '[]', '', '', '', 'thing', 1, 2)`,
    ).run(fileId)

    downgradeToV4(db)
    ensureSchema(db)

    expect(readUserVersion(db)).toBe(5)
    expect(countRows(db, 'files')).toBe(0)
    expect(countRows(db, 'symbols')).toBe(0)
    expect(countRows(db, 'symbol_references')).toBe(0)
    expect(countRows(db, 'index_meta')).toBe(0)
  })

  test('fresh databases are created at v5 directly', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    expect(readUserVersion(db)).toBe(5)
  })
})

describe('schema v5 epoch-ms timestamps', () => {
  test('files.indexed_at column is INTEGER typed', () => {
    const db = new Database(':memory:')
    ensureSchema(db)

    const column = db
      .query<{ name: string; type: string }, []>('PRAGMA table_info(files)')
      .all()
      .find((entry) => entry.name === 'indexed_at')!

    expect(column.type).toBe('INTEGER')
  })

  test('insertFile round-trips indexed_at as INTEGER epoch-ms on fresh insert and conflict update', () => {
    const db = new Database(':memory:')
    ensureSchema(db)

    const before = Date.now()
    insertFile(db, { filePath: 'src/a.ts', moduleKey: 'src/a', language: 'ts', fileHash: 'x' })
    const first = db
      .query<{ indexed_at: unknown }, [string]>('SELECT indexed_at FROM files WHERE file_path = ?')
      .get('src/a.ts')!
    expect(typeof first.indexed_at).toBe('number')
    expect(Math.abs(Number(first.indexed_at) - before)).toBeLessThan(10_000)

    insertFile(db, { filePath: 'src/a.ts', moduleKey: 'src/a', language: 'ts', fileHash: 'y' })
    const second = db
      .query<{ indexed_at: unknown }, [string]>('SELECT indexed_at FROM files WHERE file_path = ?')
      .get('src/a.ts')!
    expect(typeof second.indexed_at).toBe('number')
    expect(Math.abs(Number(second.indexed_at) - Date.now())).toBeLessThan(10_000)
  })

  test('markParseFailure writes indexed_at as INTEGER epoch-ms', () => {
    const db = new Database(':memory:')
    ensureSchema(db)

    markParseFailure(db, { relativePath: 'src/broken.ts' }, 'syntax error')
    const row = db
      .query<{ indexed_at: unknown }, [string]>('SELECT indexed_at FROM files WHERE file_path = ?')
      .get('src/broken.ts')!
    expect(typeof row.indexed_at).toBe('number')
    expect(Math.abs(Number(row.indexed_at) - Date.now())).toBeLessThan(10_000)
  })
})

describe('schema v5 WAL behavior across migration', () => {
  test('v4-to-v5 migration keeps WAL mode with -wal and -shm siblings while open', () => {
    const { dir, dbPath } = makeTempDbPath()

    const db = openDatabase(dbPath)
    ensureSchema(db)
    insertFile(db, { filePath: 'src/a.ts', moduleKey: 'src/a', language: 'ts', fileHash: 'x' })

    downgradeToV4(db)
    ensureSchema(db)

    expect(readUserVersion(db)).toBe(5)
    expect(db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()!.journal_mode).toBe('wal')
    expect(countRows(db, 'files')).toBe(0)
    expect(existsSync(`${dbPath}-wal`)).toBe(true)
    expect(existsSync(`${dbPath}-shm`)).toBe(true)

    db.close()
    rmSync(dir, { recursive: true, force: true })
    tempDirs.pop()
  })
})
