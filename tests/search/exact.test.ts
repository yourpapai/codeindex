import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { runExactSearch } from '../../src/search/exact.js'
import { ensureSchema } from '../../src/storage/schema.js'

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

describe('runExactSearch snippet preview', () => {
  test('uses first 3 lines of body_text for snippet', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    insertFile(db, 1, 'src/helper.ts', 'src/helper')
    insertSymbol(db, {
      id: 1,
      fileId: 1,
      filePath: 'src/helper.ts',
      moduleKey: 'src/helper',
      symbolKey: 'src/helper.ts#0-50',
      localName: 'helper',
      qualifiedName: 'src/helper#helper',
      kind: 'function_declaration',
      scopeTier: 'exported',
      exportNames: '["helper"]',
      signatureText: 'export function helper()',
      docText: '',
      bodyText: 'line1\nline2\nline3\nline4\nline5',
      identifierTerms: 'helper',
      startLine: 1,
      endLine: 5,
    })

    const results = runExactSearch(db, 'helper', 10, {})
    expect(results).toHaveLength(1)
    const first = results[0]!
    expect(first.snippet).toBe('line1\nline2\nline3')
  })

  test('falls back to signature_text when body_text is empty', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    insertFile(db, 1, 'src/helper.ts', 'src/helper')
    insertSymbol(db, {
      id: 1,
      fileId: 1,
      filePath: 'src/helper.ts',
      moduleKey: 'src/helper',
      symbolKey: 'src/helper.ts#0-20',
      localName: 'helper',
      qualifiedName: 'src/helper#helper',
      kind: 'function_declaration',
      scopeTier: 'exported',
      exportNames: '["helper"]',
      signatureText: 'export function helper()',
      docText: '',
      bodyText: '',
      identifierTerms: 'helper',
      startLine: 1,
      endLine: 1,
    })

    const results = runExactSearch(db, 'helper', 10, {})
    expect(results).toHaveLength(1)
    const first = results[0]!
    expect(first.snippet).toBe('export function helper()')
  })

  test('falls back to qualified_name when body_text and signature_text are both empty', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    insertFile(db, 1, 'src/helper.ts', 'src/helper')
    insertSymbol(db, {
      id: 1,
      fileId: 1,
      filePath: 'src/helper.ts',
      moduleKey: 'src/helper',
      symbolKey: 'src/helper.ts#0-20',
      localName: 'helper',
      qualifiedName: 'src/helper#helper',
      kind: 'function_declaration',
      scopeTier: 'exported',
      exportNames: '["helper"]',
      signatureText: '',
      docText: '',
      bodyText: '',
      identifierTerms: 'helper',
      startLine: 1,
      endLine: 1,
    })

    const results = runExactSearch(db, 'helper', 10, {})
    expect(results).toHaveLength(1)
    const first = results[0]!
    expect(first.snippet).toBe('src/helper#helper')
  })
})

describe('runExactSearch case-insensitive matching', () => {
  test('case-mismatched query still hits the exact tier', () => {
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

    const results = runExactSearch(db, 'getuserbyid', 10, {})
    expect(results).toHaveLength(1)
    expect(results[0]!.matchReason).toBe('exact local_name')
    expect(results[0]!.confidence).toBe('exact')
  })
})

describe('runExactSearch LIKE escaping', () => {
  const seed = (db: Database): void => {
    ensureSchema(db)
    insertFile(db, 1, 'src/foo_bar.ts', 'src/foo_bar')
    insertSymbol(db, {
      id: 1,
      fileId: 1,
      filePath: 'src/foo_bar.ts',
      moduleKey: 'src/foo_bar',
      symbolKey: 'src/foo_bar.ts#1-2',
      localName: 'widget',
      qualifiedName: 'src/foo_bar#widget',
      kind: 'function_declaration',
      scopeTier: 'exported',
      exportNames: '["widget"]',
      signatureText: 'export function widget()',
      docText: '',
      bodyText: 'x',
      identifierTerms: 'widget',
      startLine: 1,
      endLine: 2,
    })
  }

  test('underscore in query matches literally, not as wildcard', () => {
    const db = new Database(':memory:')
    seed(db)
    expect(runExactSearch(db, 'fooXbar', 10, {})).toHaveLength(0)
  })

  test('percent wildcard in query matches literally, not as wildcard', () => {
    const db = new Database(':memory:')
    seed(db)
    expect(runExactSearch(db, 'src/foo%', 10, {})).toHaveLength(0)
  })

  test('literal underscore query still matches the file path', () => {
    const db = new Database(':memory:')
    seed(db)
    const results = runExactSearch(db, 'src/foo_bar', 10, {})
    expect(results).toHaveLength(1)
    expect(results[0]!.matchReason).toBe('exact file_path')
  })
})

describe('runExactSearch short-query prefix guard', () => {
  const seed = (db: Database): void => {
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
  }

  test('queries shorter than 3 chars do not hit the file_path prefix arm', () => {
    const db = new Database(':memory:')
    seed(db)
    const results = runExactSearch(db, 's', 10, {})
    expect(results.every((r) => r.matchReason !== 'exact file_path')).toBe(true)
    expect(results).toHaveLength(0)
  })

  test('queries of 3+ chars still match file paths', () => {
    const db = new Database(':memory:')
    seed(db)
    const results = runExactSearch(db, 'src', 10, {})
    expect(results.some((r) => r.matchReason === 'exact file_path')).toBe(true)
  })
})

describe('runExactSearch LIKE escape pins', () => {
  const seed = (db: Database): void => {
    ensureSchema(db)
    insertFile(db, 1, 'src/foo_bar.ts', 'src/foo_bar')
    insertSymbol(db, {
      id: 1,
      fileId: 1,
      filePath: 'src/foo_bar.ts',
      moduleKey: 'src/foo_bar',
      symbolKey: 'src/foo_bar.ts#1-2',
      localName: 'widget',
      qualifiedName: 'src/foo_bar#widget',
      kind: 'function_declaration',
      scopeTier: 'exported',
      exportNames: '["widget"]',
      signatureText: 'export function widget()',
      docText: '',
      bodyText: 'x',
      identifierTerms: 'widget',
      startLine: 1,
      endLine: 2,
    })
    insertFile(db, 2, 'src/fooXbar.ts', 'src/fooXbar')
    insertSymbol(db, {
      id: 2,
      fileId: 2,
      filePath: 'src/fooXbar.ts',
      moduleKey: 'src/fooXbar',
      symbolKey: 'src/fooXbar.ts#1-2',
      localName: 'gadget',
      qualifiedName: 'src/fooXbar#gadget',
      kind: 'function_declaration',
      scopeTier: 'exported',
      exportNames: '["gadget"]',
      signatureText: 'export function gadget()',
      docText: '',
      bodyText: 'x',
      identifierTerms: 'gadget',
      startLine: 1,
      endLine: 2,
    })
    insertFile(db, 3, 'src/ab.ts', 'src/ab')
    insertSymbol(db, {
      id: 3,
      fileId: 3,
      filePath: 'src/ab.ts',
      moduleKey: 'src/ab',
      symbolKey: 'src/ab.ts#1-2',
      localName: 'anchor',
      qualifiedName: 'src/ab#anchor',
      kind: 'function_declaration',
      scopeTier: 'exported',
      exportNames: '["anchor"]',
      signatureText: 'export function anchor()',
      docText: '',
      bodyText: 'x',
      identifierTerms: 'anchor',
      startLine: 1,
      endLine: 2,
    })
  }

  test('underscore in the query does not wildcard-match other characters', () => {
    const db = new Database(':memory:')
    seed(db)
    const results = runExactSearch(db, 'src/foo_bar', 10, {})
    expect(results).toHaveLength(1)
    expect(results[0]!.filePath).toBe('src/foo_bar.ts')
  })

  test('backslash in the query does not act as an escape or wildcard', () => {
    const db = new Database(':memory:')
    seed(db)
    const results = runExactSearch(db, 'a\\b', 10, {})
    expect(results).toHaveLength(0)
  })
})

describe('runExactSearch in_degree', () => {
  test('exact results carry in_degree from storage', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    insertFile(db, 1, 'src/hot.ts', 'src/hot')
    insertSymbol(db, {
      id: 1,
      fileId: 1,
      filePath: 'src/hot.ts',
      moduleKey: 'src/hot',
      symbolKey: 'src/hot.ts#1-2',
      localName: 'hot',
      qualifiedName: 'src/hot#hot',
      kind: 'function_declaration',
      scopeTier: 'exported',
      exportNames: '["hot"]',
      signatureText: '',
      docText: '',
      bodyText: '',
      identifierTerms: 'hot',
      startLine: 1,
      endLine: 2,
    })
    db.query('UPDATE symbols SET in_degree = 7 WHERE id = 1').run()

    const results = runExactSearch(db, 'hot', 10, {})
    expect(results[0]!.inDegree).toBe(7)
  })
})
