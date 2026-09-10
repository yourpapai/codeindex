import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { searchSymbols } from '../../src/search/index.js'
import { ensureSchema } from '../../src/storage/schema.js'
import type { RankedSearchResult } from '../../src/types.js'

const insertFile = (db: Database, id: number, filePath: string, moduleKey: string): void => {
  db.query(
    `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at) VALUES (?, ?, ?, 'ts', 'x', 'indexed', NULL, datetime('now'))`,
  ).run(id, filePath, moduleKey)
}

const insertSymbol = (
  db: Database,
  opts: {
    id: number
    fileId: number
    filePath: string
    moduleKey: string
    symbolKey: string
    localName: string
    qualifiedName: string
    bodyText: string
  },
): void => {
  db.query(
    `INSERT INTO symbols (id, file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?, 'function_declaration', 'exported', NULL, ?, '', '', ?, ?, 1, 2)`,
  ).run(
    opts.id,
    opts.fileId,
    opts.filePath,
    opts.moduleKey,
    opts.symbolKey,
    opts.localName,
    opts.qualifiedName,
    JSON.stringify([opts.localName]),
    opts.bodyText,
    opts.localName,
  )
}

const makeDb = (): Database => {
  const db = new Database(':memory:')
  ensureSchema(db)
  insertFile(db, 1, 'src/search/index.ts', 'src/search/index')
  insertSymbol(db, {
    id: 1,
    fileId: 1,
    filePath: 'src/search/index.ts',
    moduleKey: 'src/search/index',
    symbolKey: 'src/search/index.ts#1-2',
    localName: 'searchSymbols',
    qualifiedName: 'src/search/index#searchSymbols',
    bodyText: 'function searchSymbols() {}',
  })
  insertFile(db, 2, 'src/rank/other.ts', 'src/rank/other')
  insertSymbol(db, {
    id: 2,
    fileId: 2,
    filePath: 'src/rank/other.ts',
    moduleKey: 'src/rank/other',
    symbolKey: 'src/rank/other.ts#1-2',
    localName: 'rerankHelper',
    qualifiedName: 'src/rank/other#rerankHelper',
    bodyText: 'calls searchSymbols internally',
  })
  return db
}

const snapshot = (rows: readonly RankedSearchResult[]): string =>
  JSON.stringify(rows.map((r) => ({ key: r.symbolKey, score: r.rankScore, by: r.matchedBy })))

describe('searchSymbols route mode', () => {
  test('omitted mode is byte-identical to mode auto', () => {
    const db = makeDb()
    const omitted = searchSymbols(db, { query: 'searchSymbols', limit: 10 })
    const auto = searchSymbols(db, { query: 'searchSymbols', limit: 10, mode: 'auto' })
    expect(snapshot(auto)).toBe(snapshot(omitted))
  })

  test('mode exact serves only the exact pool', () => {
    const db = makeDb()
    const results = searchSymbols(db, { query: 'searchSymbols', limit: 10, mode: 'exact' })
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.every((r) => r.matchedBy !== 'fts')).toBe(true)
    expect(results.some((r) => r.localName === 'searchSymbols')).toBe(true)
    expect(results.some((r) => r.localName === 'rerankHelper')).toBe(false)
  })

  test('mode fts serves only the fts pool', () => {
    const db = makeDb()
    const results = searchSymbols(db, { query: 'searchSymbols', limit: 10, mode: 'fts' })
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.every((r) => r.matchedBy === 'fts')).toBe(true)
  })

  test('mode fused is byte-identical to mode auto', () => {
    const db = makeDb()
    const auto = searchSymbols(db, { query: 'searchSymbols', limit: 10, mode: 'auto' })
    const fused = searchSymbols(db, { query: 'searchSymbols', limit: 10, mode: 'fused' })
    expect(snapshot(fused)).toBe(snapshot(auto))
  })

  test('exact matches precede fts-only matches in auto and fused', () => {
    const db = makeDb()
    for (const mode of ['auto', 'fused'] as const) {
      const results = searchSymbols(db, { query: 'searchSymbols', limit: 10, mode })
      const exactIdx = results.findIndex((r) => r.localName === 'searchSymbols')
      const ftsOnlyIdx = results.findIndex((r) => r.localName === 'rerankHelper')
      expect(exactIdx).toBeGreaterThanOrEqual(0)
      expect(ftsOnlyIdx).toBeGreaterThanOrEqual(0)
      expect(exactIdx).toBeLessThan(ftsOnlyIdx)
    }
  })

  test('exact-before-fts holds in single-pool modes trivially', () => {
    const db = makeDb()
    const exact = searchSymbols(db, { query: 'searchSymbols', limit: 10, mode: 'exact' })
    const fts = searchSymbols(db, { query: 'searchSymbols', limit: 10, mode: 'fts' })
    expect(exact.every((r) => r.matchedBy !== 'fts')).toBe(true)
    expect(fts.every((r) => r.matchedBy === 'fts')).toBe(true)
  })
})
