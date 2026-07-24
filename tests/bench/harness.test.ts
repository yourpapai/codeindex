import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { parseCorpus } from '../../bench/corpus.js'
import { scoreCorpus } from '../../bench/harness.js'
import { ensureSchema } from '../../src/storage/schema.js'

interface SeedSymbol {
  readonly id: number
  readonly fileId: number
  readonly filePath: string
  readonly moduleKey: string
  readonly localName: string
  readonly qualifiedName: string
}

const insertFile = (db: Database, id: number, filePath: string, moduleKey: string): void => {
  db.query(
    `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at)
     VALUES (?, ?, ?, 'ts', 'x', 'indexed', NULL, datetime('now'))`,
  ).run(id, filePath, moduleKey)
}

const insertSymbol = (db: Database, symbol: SeedSymbol): void => {
  db.query(
    `INSERT INTO symbols (id, file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'variable_declarator', 'exported', NULL, ?, ?, '', ?, ?, 1, 1)`,
  ).run(
    symbol.id,
    symbol.fileId,
    symbol.filePath,
    symbol.moduleKey,
    `${symbol.filePath}#${symbol.id}`,
    symbol.localName,
    symbol.qualifiedName,
    JSON.stringify([symbol.localName]),
    `export const ${symbol.localName} = () => {}`,
    `export const ${symbol.localName} = () => {}`,
    symbol.localName.toLowerCase(),
  )
}

const buildDb = (): Database => {
  const db = new Database(':memory:')
  ensureSchema(db)
  insertFile(db, 1, 'src/storage/db.ts', 'src/storage/db')
  insertFile(db, 2, 'src/cli.ts', 'src/cli')
  insertFile(db, 3, 'src/search/index.ts', 'src/search/index')
  insertSymbol(db, {
    id: 1,
    fileId: 1,
    filePath: 'src/storage/db.ts',
    moduleKey: 'src/storage/db',
    localName: 'openDatabase',
    qualifiedName: 'src/storage/db#openDatabase',
  })
  insertSymbol(db, {
    id: 2,
    fileId: 2,
    filePath: 'src/cli.ts',
    moduleKey: 'src/cli',
    localName: 'withDatabase',
    qualifiedName: 'src/cli#withDatabase',
  })
  insertSymbol(db, {
    id: 3,
    fileId: 3,
    filePath: 'src/search/index.ts',
    moduleKey: 'src/search/index',
    localName: 'searchSymbols',
    qualifiedName: 'src/search/index#searchSymbols',
  })
  db.query(
    `INSERT INTO symbol_references (source_symbol_id, source_file_id, target_symbol_id, target_file_id, target_name, target_export_name, target_module_specifier, edge_type, confidence, line_number)
     VALUES (2, 2, 1, 1, 'openDatabase', NULL, '../storage/db', 'calls', 'resolved', 5)`,
  ).run()
  return db
}

describe('scoreCorpus', () => {
  test('scores a find-symbol query against exact search', () => {
    const db = buildDb()
    try {
      const corpus = parseCorpus({
        name: 't',
        queries: [
          { id: 'q1', kind: 'find-symbol', query: 'searchSymbols', relevant: ['src/search/index#searchSymbols'] },
        ],
      })
      const report = scoreCorpus(db, corpus, 10)
      expect(report.mrr).toBe(1)
      expect(report.meanRecallAtK).toBe(1)
    } finally {
      db.close()
    }
  })

  test('scores a who-uses query against incoming references', () => {
    const db = buildDb()
    try {
      const corpus = parseCorpus({
        name: 't',
        queries: [
          { id: 'q2', kind: 'who-uses', target: 'src/storage/db#openDatabase', relevant: ['src/cli#withDatabase'] },
        ],
      })
      const report = scoreCorpus(db, corpus, 10)
      const first = report.perQuery[0]!
      expect(first.retrieved).toContain('src/cli#withDatabase')
      expect(report.meanRecallAtK).toBe(1)
    } finally {
      db.close()
    }
  })
})
