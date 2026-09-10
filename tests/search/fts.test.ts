import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { runFtsSearch } from '../../src/search/fts.js'
import { ensureSchema } from '../../src/storage/schema.js'

const makeDb = (localName: string): Database => {
  const db = new Database(':memory:')
  ensureSchema(db)
  db.run(
    `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at)
     VALUES (1, 'src/db/drizzle.ts', 'src/db/drizzle', 'ts', 'x', 'indexed', NULL, datetime('now'))`,
  )
  db.run(
    `INSERT INTO symbols (id, file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line)
     VALUES (1, 1, 'src/db/drizzle.ts', 'src/db/drizzle', 'src/db/drizzle.ts#0-20', ?, ?, 'function_declaration', 'exported', NULL, ?, '', '', '', ?, 1, 1)`,
    [localName, `src/db/drizzle#${localName}`, JSON.stringify([localName]), localName],
  )
  return db
}

describe('runFtsSearch', () => {
  test('returns results for a plain identifier query', () => {
    const db = makeDb('getDrizzleDb')
    const results = runFtsSearch(db, 'getDrizzleDb', 10, {})
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.localName).toBe('getDrizzleDb')
  })

  test('does not throw for a call-expression query like getDrizzleDb()', () => {
    const db = makeDb('getDrizzleDb')
    expect(() => runFtsSearch(db, 'getDrizzleDb()', 10, {})).not.toThrow()
  })

  test('strips trailing parens and still matches the symbol', () => {
    const db = makeDb('getDrizzleDb')
    const results = runFtsSearch(db, 'getDrizzleDb()', 10, {})
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.localName).toBe('getDrizzleDb')
  })

  test('returns empty array instead of throwing for a query of only metacharacters', () => {
    const db = makeDb('getDrizzleDb')
    expect(() => runFtsSearch(db, '()', 10, {})).not.toThrow()
    expect(runFtsSearch(db, '()', 10, {})).toEqual([])
  })

  test('does not throw for a query with an unbalanced double-quote', () => {
    const db = makeDb('getDrizzleDb')
    expect(() => runFtsSearch(db, '"getDrizzleDb', 10, {})).not.toThrow()
  })

  test('does not throw for a path query like src/db/drizzle', () => {
    const db = makeDb('getDrizzleDb')
    expect(() => runFtsSearch(db, 'src/db/drizzle', 10, {})).not.toThrow()
  })

  test('does not throw for a qualified-name query like src/db/drizzle#getDrizzleDb', () => {
    const db = makeDb('getDrizzleDb')
    expect(() => runFtsSearch(db, 'src/db/drizzle#getDrizzleDb', 10, {})).not.toThrow()
  })

  test('strips path separators and still matches by identifier', () => {
    const db = makeDb('getDrizzleDb')
    const results = runFtsSearch(db, 'src/db/drizzle#getDrizzleDb', 10, {})
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.localName).toBe('getDrizzleDb')
  })

  test('applies filters to fts results', () => {
    const db = makeDb('getDrizzleDb')
    const results = runFtsSearch(db, 'getDrizzleDb', 10, { kinds: ['variable_declaration'] })
    expect(results).toEqual([])
  })

  test('FTS results carry a defined, non-negative bm25 relevance', () => {
    const db = makeDb('getDrizzleDb')
    const results = runFtsSearch(db, 'getDrizzleDb', 10, {})
    expect(results.length).toBeGreaterThan(0)
    expect(typeof results[0]!.relevance).toBe('number')
    expect(results[0]!.relevance!).toBeGreaterThanOrEqual(0)
  })

  test('fts results carry matchedBy fts', () => {
    const db = makeDb('getDrizzleDb')
    const results = runFtsSearch(db, 'getDrizzleDb', 10, {})
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.matchedBy).toBe('fts')
  })
})

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
    kind: string
    scopeTier: string
    exportNames: string
    signatureText: string
    docText: string
    bodyText: string
    identifierTerms: string
    startLine: number
    endLine: number
  },
): void => {
  db.query(
    `INSERT INTO symbols (id, file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.fileId,
    opts.filePath,
    opts.moduleKey,
    opts.symbolKey,
    opts.localName,
    opts.qualifiedName,
    opts.kind,
    opts.scopeTier,
    opts.exportNames,
    opts.signatureText,
    opts.docText,
    opts.bodyText,
    opts.identifierTerms,
    opts.startLine,
    opts.endLine,
  )
}

describe('runFtsSearch snippet', () => {
  test('snippets signature_text when doc_text is empty', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    insertFile(db, 1, 'src/helper.ts', 'src/helper')
    insertSymbol(db, {
      id: 1,
      fileId: 1,
      filePath: 'src/helper.ts',
      moduleKey: 'src/helper',
      symbolKey: 'src/helper.ts#1-2',
      localName: 'helper',
      qualifiedName: 'src/helper#helper',
      kind: 'function_declaration',
      scopeTier: 'exported',
      exportNames: '["helper"]',
      signatureText: 'export function helper()',
      docText: '',
      bodyText: 'function helper() {\n  return 1\n}',
      identifierTerms: 'helper',
      startLine: 1,
      endLine: 2,
    })

    const results = runFtsSearch(db, 'helper', 10, {})
    expect(results).toHaveLength(1)
    expect(results[0]!.snippet.replaceAll('[', '').replaceAll(']', '')).toContain('export function helper')
  })
})

describe('runFtsSearch prefix matching', () => {
  test('partial identifier matches via token prefix', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    insertFile(db, 1, 'src/user.ts', 'src/user')
    insertSymbol(db, {
      id: 1,
      fileId: 1,
      filePath: 'src/user.ts',
      moduleKey: 'src/user',
      symbolKey: 'src/user.ts#1-2',
      localName: 'getUserById',
      qualifiedName: 'src/user#getUserById',
      kind: 'function_declaration',
      scopeTier: 'exported',
      exportNames: '["getUserById"]',
      signatureText: 'export function getUserById()',
      docText: '',
      bodyText: 'x',
      identifierTerms: 'get user by id',
      startLine: 1,
      endLine: 2,
    })

    const results = runFtsSearch(db, 'getuser', 10, {})
    expect(results).toHaveLength(1)
  })

  test('multi-token queries are not prefix-expanded', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    insertFile(db, 1, 'src/user.ts', 'src/user')
    insertSymbol(db, {
      id: 1,
      fileId: 1,
      filePath: 'src/user.ts',
      moduleKey: 'src/user',
      symbolKey: 'src/user.ts#1-2',
      localName: 'getUserById',
      qualifiedName: 'src/user#getUserById',
      kind: 'function_declaration',
      scopeTier: 'exported',
      exportNames: '["getUserById"]',
      signatureText: '',
      docText: '',
      bodyText: '',
      identifierTerms: 'get user by id',
      startLine: 1,
      endLine: 2,
    })

    const results = runFtsSearch(db, 'get user', 10, {})
    expect(results).toHaveLength(1)
  })
})
