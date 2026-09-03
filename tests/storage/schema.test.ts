import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { ensureSchema } from '../../src/storage/schema.js'

describe('ensureSchema', () => {
  test('symbol_references table has target_file_id column', () => {
    const db = new Database(':memory:')
    ensureSchema(db)

    const columns = db
      .query<{ name: string }, []>('PRAGMA table_info(symbol_references)')
      .all()
      .map((row) => row.name)

    expect(columns).toContain('target_file_id')
  })

  test('migrates stale database missing target_file_id without error', () => {
    const db = new Database(':memory:')
    // Simulate a pre-migration database: create symbol_references without target_file_id
    db.run(`CREATE TABLE files (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL UNIQUE,
      module_key TEXT NOT NULL UNIQUE,
      language TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      parse_status TEXT NOT NULL,
      parse_error TEXT,
      indexed_at TEXT NOT NULL
    )`)
    db.run(`CREATE TABLE symbol_references (
      id INTEGER PRIMARY KEY,
      source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      target_name TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      confidence TEXT NOT NULL,
      line_number INTEGER NOT NULL
    )`)

    expect(() => ensureSchema(db)).not.toThrow()

    const columns = db
      .query<{ name: string }, []>('PRAGMA table_info(symbol_references)')
      .all()
      .map((row) => row.name)

    expect(columns).toContain('target_file_id')
  })
})

describe('schema v4', () => {
  test('local_name and qualified_name match case-insensitively; in_degree defaults to 0', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    db.query(
      `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at) VALUES (1, 'src/a.ts', 'src/a', 'ts', 'x', 'indexed', NULL, datetime('now'))`,
    ).run()
    db.query(
      `INSERT INTO symbols (id, file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line)
       VALUES (1, 1, 'src/a.ts', 'src/a', 'src/a.ts#1-2', 'getUserById', 'src/a#getUserById', 'function_declaration', 'exported', NULL, '[]', '', '', '', 'get user by id', 1, 2)`,
    ).run()

    const row = db
      .query<{ id: number; in_degree: number }, [string]>('SELECT id, in_degree FROM symbols WHERE local_name = ?')
      .get('getuserbyid')
    expect(row).not.toBeNull()
    expect(row!.in_degree).toBe(0)

    const qualified = db
      .query<{ id: number }, [string]>('SELECT id FROM symbols WHERE qualified_name = ?')
      .get('src/a#getuserbyid')
    expect(qualified).not.toBeNull()

    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(4)
  })

  test('module_exports.export_name matches case-insensitively', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    db.query(
      `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at) VALUES (1, 'src/a.ts', 'src/a', 'ts', 'x', 'indexed', NULL, datetime('now'))`,
    ).run()
    db.query(
      `INSERT INTO module_exports (id, file_id, export_name, export_kind, symbol_id, target_module_specifier) VALUES (1, 1, 'getUserById', 'named', NULL, NULL)`,
    ).run()
    const row = db
      .query<{ id: number }, [string]>('SELECT id FROM module_exports WHERE export_name = ?')
      .get('getuserbyid')
    expect(row).not.toBeNull()
  })
})
