import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { findSymbolCandidates } from '../../src/search/index.js'
import { ensureSchema } from '../../src/storage/schema.js'

describe('findSymbolCandidates', () => {
  test('returns exact-only results when exact matches exist', () => {
    const db = new Database(':memory:')
    ensureSchema(db)

    db.query(
      `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at) VALUES (1, 'src/app.ts', 'src/app', 'ts', 'x', 'indexed', NULL, datetime('now'))`,
    ).run()
    db.query(
      `INSERT INTO symbols (id, file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line) VALUES (1, 1, 'src/app.ts', 'src/app', 'src/app.ts#0-20', 'helper', 'src/app#helper', 'function_declaration', 'exported', NULL, '["helper"]', 'function helper()', '', 'function helper() {}', 'helper', 1, 1)`,
    ).run()
    db.query(
      `INSERT INTO symbols (id, file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line) VALUES (2, 1, 'src/app.ts', 'src/app', 'src/app.ts#20-40', 'helperUtil', 'src/app#helperUtil', 'function_declaration', 'module', NULL, '[]', 'function helperUtil()', '', 'function helperUtil() {}', 'helperUtil helper', 2, 2)`,
    ).run()

    const results = findSymbolCandidates(db, 'helper', 10)
    expect(results.every((r) => r.matchedBy.startsWith('exact'))).toBe(true)
  })

  test('falls back to broad search when no exact match', () => {
    const db = new Database(':memory:')
    ensureSchema(db)

    db.query(
      `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at) VALUES (1, 'src/app.ts', 'src/app', 'ts', 'x', 'indexed', NULL, datetime('now'))`,
    ).run()
    db.query(
      `INSERT INTO symbols (id, file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line) VALUES (1, 1, 'src/app.ts', 'src/app', 'src/app.ts#0-20', 'helperUtil', 'src/app#helperUtil', 'function_declaration', 'exported', NULL, '["helperUtil"]', 'function helperUtil()', '', 'function helperUtil() {}', 'helperUtil helper', 1, 1)`,
    ).run()

    const results = findSymbolCandidates(db, 'helper', 10)
    expect(results.length).toBeGreaterThanOrEqual(1)
    const first = results[0]!
    expect(first.matchedBy).toBe('fts')
  })
})
