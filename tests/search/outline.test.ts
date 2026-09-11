import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'

import type { ExtractedSymbol } from '../../src/indexer/extract-symbols.js'
import { outlineFile } from '../../src/search/outline.js'
import { persistSymbols } from '../../src/storage/queries.js'
import { ensureSchema } from '../../src/storage/schema.js'

const makeDb = (): Database => {
  const db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  ensureSchema(db)
  return db
}

const seedFile = (db: Database, filePath: string): number => {
  db.query(
    `INSERT INTO files (file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at)
     VALUES (?, ?, 'ts', 'abc', 'indexed', NULL, ?)`,
  ).run(filePath, filePath.replace(/\.[^.]+$/, ''), Date.now())
  return db.query<{ id: number }, [string]>('SELECT id FROM files WHERE file_path = ?').get(filePath)!.id
}

const makeSymbol = (
  overrides: Partial<ExtractedSymbol> & Pick<ExtractedSymbol, 'symbolKey' | 'qualifiedName' | 'localName'>,
): ExtractedSymbol => ({
  kind: 'function_declaration',
  scopeTier: 'exported',
  exportNames: [],
  signatureText: '',
  docText: '',
  bodyText: 'BODY_SHOULD_NOT_APPEAR',
  identifierTerms: '',
  startLine: 1,
  endLine: 1,
  parentQualifiedName: null,
  ...overrides,
})

describe('outlineFile', () => {
  let db: Database

  beforeEach(() => {
    db = makeDb()
    const denseId = seedFile(db, 'src/dense.ts')
    persistSymbols(db, denseId, 'src/dense.ts', 'src/dense', [
      makeSymbol({
        symbolKey: 'src/dense.ts#10-20',
        qualifiedName: 'src/dense#localHelper',
        localName: 'localHelper',
        scopeTier: 'local',
        startLine: 10,
        endLine: 20,
      }),
      makeSymbol({
        symbolKey: 'src/dense.ts#1-3',
        qualifiedName: 'src/dense#exportedFn',
        localName: 'exportedFn',
        exportNames: ['exportedFn'],
        scopeTier: 'exported',
        startLine: 1,
        endLine: 3,
        signatureText: 'export function exportedFn() {}',
      }),
      makeSymbol({
        symbolKey: 'src/dense.ts#5-8',
        qualifiedName: 'src/dense#moduleFn',
        localName: 'moduleFn',
        scopeTier: 'module',
        startLine: 5,
        endLine: 8,
      }),
    ])

    const barrelId = seedFile(db, 'src/index.ts')
    db.query(
      `INSERT INTO module_exports (file_id, export_name, export_kind, symbol_id, target_module_specifier)
       VALUES (?, 'helper', 'reexport', NULL, './helper')`,
    ).run(barrelId)
    db.query(
      `INSERT INTO module_exports (file_id, export_name, export_kind, symbol_id, target_module_specifier)
       VALUES (?, '*', 'star', NULL, './impl')`,
    ).run(barrelId)
  })

  test('symbols mode defaults exclude locals and order by start line', () => {
    const outcome = outlineFile(db, { filePath: 'src/dense.ts', mode: 'symbols' })
    expect(outcome.mode).toBe('symbols')
    expect(outcome.filePath).toBe('src/dense.ts')
    expect(outcome.resultCount).toBe(2)
    expect(outcome.truncated).toBe(false)
    if (outcome.mode !== 'symbols') {
      throw new Error('expected symbols outcome')
    }
    expect(outcome.results.map((row) => row.localName)).toEqual(['exportedFn', 'moduleFn'])
    expect(outcome.results.every((row) => row.scopeTier !== 'local')).toBe(true)
    const first = outcome.results[0]!
    expect(first).toEqual({
      symbolKey: 'src/dense.ts#1-3',
      qualifiedName: 'src/dense#exportedFn',
      localName: 'exportedFn',
      kind: 'function_declaration',
      scopeTier: 'exported',
      filePath: 'src/dense.ts',
      startLine: 1,
      endLine: 3,
      signatureText: 'export function exportedFn() {}',
      exportNames: ['exportedFn'],
    })
    expect(first).not.toHaveProperty('bodyText')
    expect(first).not.toHaveProperty('docText')
    expect(first).not.toHaveProperty('snippet')
    expect(first).not.toHaveProperty('rankScore')
    expect(first).not.toHaveProperty('matchedBy')
    expect(outcome.guidance).toBeUndefined()
  })

  test('exports mode returns barrel re-exports with nullable linkage', () => {
    const outcome = outlineFile(db, { filePath: 'src/index.ts', mode: 'exports' })
    expect(outcome.mode).toBe('exports')
    expect(outcome.resultCount).toBe(2)
    if (outcome.mode !== 'exports') {
      throw new Error('expected exports outcome')
    }
    expect(outcome.results[0]!.exportName).toBe('helper')
    expect(outcome.results[0]!.symbolId).toBeNull()
    expect(outcome.results[0]!.targetModuleSpecifier).toBe('./helper')
    expect(outcome.results[1]!.exportKind).toBe('star')
  })

  test('unknown path returns empty results with guidance', () => {
    const outcome = outlineFile(db, { filePath: 'src/missing.ts', mode: 'symbols' })
    expect(outcome.resultCount).toBe(0)
    expect(outcome.results).toEqual([])
    expect(typeof outcome.guidance).toBe('string')
    expect(outcome.guidance).toContain('not indexed')
    expect(outcome.guidance).toContain('src/missing.ts')
  })

  test('near-miss path is not fuzzy-matched', () => {
    const outcome = outlineFile(db, { filePath: 'src/dense', mode: 'symbols' })
    expect(outcome.resultCount).toBe(0)
    expect(outcome.guidance).toBeDefined()
  })

  test('limit truncates and sets truncated', () => {
    const outcome = outlineFile(db, { filePath: 'src/dense.ts', mode: 'symbols', limit: 1 })
    expect(outcome.resultCount).toBe(1)
    expect(outcome.truncated).toBe(true)
  })

  test('does not set truncated when the file fits within limit', () => {
    const outcome = outlineFile(db, { filePath: 'src/dense.ts', mode: 'symbols', limit: 10 })
    expect(outcome.truncated).toBe(false)
  })

  test('requested locals can be included', () => {
    const outcome = outlineFile(db, {
      filePath: 'src/dense.ts',
      mode: 'symbols',
      scopeTiers: ['exported', 'module', 'member', 'local'],
    })
    if (outcome.mode !== 'symbols') {
      throw new Error('expected symbols outcome')
    }
    expect(outcome.results.map((row) => row.localName)).toContain('localHelper')
  })
})
