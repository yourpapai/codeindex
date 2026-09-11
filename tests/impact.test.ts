import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { findIncomingReferences, findSymbolCandidates, resolveIncomingReferences } from '../src/impact.js'
import { ensureSchema } from '../src/storage/schema.js'

describe('symbol resolution and impact', () => {
  test('returns symbol candidates and module-level importers', () => {
    const db = new Database(':memory:')
    ensureSchema(db)

    db.query(
      `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at) VALUES (1, 'src/helper.ts', 'src/helper', 'ts', 'x', 'indexed', NULL, datetime('now'))`,
    ).run()
    db.query(
      `INSERT INTO symbols (id, file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line) VALUES (1, 1, 'src/helper.ts', 'src/helper', 'src/helper.ts#0-20', 'helper', 'src/helper#helper', 'function_declaration', 'exported', NULL, '["helper"]', 'export function helper()', '', 'export function helper() {}', 'helper', 1, 1)`,
    ).run()
    db.query(
      `INSERT INTO symbol_references (source_symbol_id, source_file_id, target_symbol_id, target_name, target_export_name, target_module_specifier, edge_type, confidence, line_number) VALUES (NULL, 1, 1, 'helper', 'helper', './helper', 'imports', 'resolved', 1)`,
    ).run()

    expect(findSymbolCandidates(db, 'helper', 5)[0]?.qualifiedName).toBe('src/helper#helper')
    expect(findIncomingReferences(db, { qualifiedName: 'src/helper#helper', limit: 10 })[0]?.edgeType).toBe('imports')
  })
})

interface SeedSymbolInput {
  readonly id: number
  readonly fileId: number
  readonly filePath: string
  readonly moduleKey: string
  readonly symbolKey: string
  readonly localName: string
  readonly qualifiedName: string
  readonly scopeTier: 'exported' | 'module' | 'member'
}

const seedFile = (db: Database, id: number, filePath: string, moduleKey: string): void => {
  db.query(
    `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at)
     VALUES (?, ?, ?, 'ts', 'x', 'indexed', NULL, datetime('now'))`,
  ).run(id, filePath, moduleKey)
}

const seedSymbol = (db: Database, symbol: SeedSymbolInput): void => {
  db.query(
    `INSERT INTO symbols (id, file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'function_declaration', ?, NULL, ?, ?, '', ?, ?, 1, 1)`,
  ).run(
    symbol.id,
    symbol.fileId,
    symbol.filePath,
    symbol.moduleKey,
    symbol.symbolKey,
    symbol.localName,
    symbol.qualifiedName,
    symbol.scopeTier,
    JSON.stringify([symbol.localName]),
    `export function ${symbol.localName}()`,
    `export function ${symbol.localName}() {}`,
    symbol.localName.toLowerCase(),
  )
}

const seedReference = (db: Database, sourceSymbolId: number, sourceFileId: number, targetSymbolId: number): void => {
  db.query(
    `INSERT INTO symbol_references (source_symbol_id, source_file_id, target_symbol_id, target_name, target_export_name, target_module_specifier, edge_type, confidence, line_number)
     VALUES (?, ?, ?, ?, ?, ?, 'calls', 'resolved', 5)`,
  ).run(sourceSymbolId, sourceFileId, targetSymbolId, 'openDatabase', 'openDatabase', './db')
}

// Mirrors the live-trap fixture from the proposal: `openDatabase` in src/storage/db.ts
// with one resolved incoming edge from src/mcp/session.ts.
const seedOpenDatabaseFixture = (db: Database): void => {
  seedFile(db, 1, 'src/storage/db.ts', 'src/storage/db')
  seedFile(db, 2, 'src/mcp/session.ts', 'src/mcp/session')
  seedSymbol(db, {
    id: 1,
    fileId: 1,
    filePath: 'src/storage/db.ts',
    moduleKey: 'src/storage/db',
    symbolKey: 'src/storage/db.ts#120-190',
    localName: 'openDatabase',
    qualifiedName: 'src/storage/db#openDatabase',
    scopeTier: 'exported',
  })
  seedSymbol(db, {
    id: 2,
    fileId: 2,
    filePath: 'src/mcp/session.ts',
    moduleKey: 'src/mcp/session',
    symbolKey: 'src/mcp/session.ts#10-40',
    localName: 'openSession',
    qualifiedName: 'src/mcp/session#openSession',
    scopeTier: 'module',
  })
  seedReference(db, 2, 2, 1)
}

describe('resolveIncomingReferences', () => {
  test('canonical symbol_key resolves with rows identical to findIncomingReferences', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedOpenDatabaseFixture(db)

    const input = { symbolKey: 'src/storage/db.ts#120-190', limit: 10 }
    expect(resolveIncomingReferences(db, input)).toEqual({
      resolution: {
        status: 'canonical',
        matchedBy: 'symbol_key',
        symbolKey: 'src/storage/db.ts#120-190',
        qualifiedName: 'src/storage/db#openDatabase',
      },
      results: findIncomingReferences(db, input),
    })
  })

  test('canonical qualified_name resolves', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedOpenDatabaseFixture(db)

    expect(resolveIncomingReferences(db, { qualifiedName: 'src/storage/db#openDatabase', limit: 10 })).toEqual({
      resolution: {
        status: 'canonical',
        matchedBy: 'qualified_name',
        symbolKey: 'src/storage/db.ts#120-190',
        qualifiedName: 'src/storage/db#openDatabase',
      },
      results: findIncomingReferences(db, { qualifiedName: 'src/storage/db#openDatabase', limit: 10 }),
    })
  })

  test('qualified-name form sent as symbolKey resolves via qualified_name', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedOpenDatabaseFixture(db)

    expect(resolveIncomingReferences(db, { symbolKey: 'src/storage/db#openDatabase', limit: 10 })).toEqual({
      resolution: {
        status: 'resolved',
        matchedBy: 'qualified_name',
        symbolKey: 'src/storage/db.ts#120-190',
        qualifiedName: 'src/storage/db#openDatabase',
      },
      results: findIncomingReferences(db, { qualifiedName: 'src/storage/db#openDatabase', limit: 10 }),
    })
  })

  test('bare local name sent as qualifiedName resolves via local_name', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedOpenDatabaseFixture(db)

    expect(resolveIncomingReferences(db, { qualifiedName: 'openDatabase', limit: 10 })).toEqual({
      resolution: {
        status: 'resolved',
        matchedBy: 'local_name',
        symbolKey: 'src/storage/db.ts#120-190',
        qualifiedName: 'src/storage/db#openDatabase',
      },
      results: findIncomingReferences(db, { qualifiedName: 'src/storage/db#openDatabase', limit: 10 }),
    })
  })

  test('repo-unique bare local name resolves via exact local_name, not FTS cardinality', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedOpenDatabaseFixture(db)
    // Extra unrelated symbols must not steal uniqueness; the bare name is still exact-SQL unique.
    seedFile(db, 3, 'src/other.ts', 'src/other')
    seedSymbol(db, {
      id: 5,
      fileId: 3,
      filePath: 'src/other.ts',
      moduleKey: 'src/other',
      symbolKey: 'src/other.ts#0-9',
      localName: 'openDatabaseHelper',
      qualifiedName: 'src/other#openDatabaseHelper',
      scopeTier: 'module',
    })
    seedSymbol(db, {
      id: 6,
      fileId: 3,
      filePath: 'src/other.ts',
      moduleKey: 'src/other',
      symbolKey: 'src/other.ts#10-20',
      localName: 'closeDatabase',
      qualifiedName: 'src/other#closeDatabase',
      scopeTier: 'module',
    })

    expect(resolveIncomingReferences(db, { qualifiedName: 'openDatabase', limit: 10 })).toEqual({
      resolution: {
        status: 'resolved',
        matchedBy: 'local_name',
        symbolKey: 'src/storage/db.ts#120-190',
        qualifiedName: 'src/storage/db#openDatabase',
      },
      results: findIncomingReferences(db, { qualifiedName: 'src/storage/db#openDatabase', limit: 10 }),
    })
  })

  test('bare name unique among exports resolves despite member/local noise', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedFile(db, 1, 'src/colors.ts', 'src/colors')
    seedFile(db, 2, 'src/theme.ts', 'src/theme')
    seedSymbol(db, {
      id: 1,
      fileId: 1,
      filePath: 'src/colors.ts',
      moduleKey: 'src/colors',
      symbolKey: 'src/colors.ts#0-9',
      localName: 'alpha',
      qualifiedName: 'src/colors#alpha',
      scopeTier: 'exported',
    })
    seedSymbol(db, {
      id: 2,
      fileId: 2,
      filePath: 'src/theme.ts',
      moduleKey: 'src/theme',
      symbolKey: 'src/theme.ts#10-20',
      localName: 'alpha',
      qualifiedName: 'src/theme#ColorObject>alpha',
      scopeTier: 'member',
    })
    seedSymbol(db, {
      id: 3,
      fileId: 2,
      filePath: 'src/theme.ts',
      moduleKey: 'src/theme',
      symbolKey: 'src/theme.ts#21-30',
      localName: 'alpha',
      qualifiedName: 'src/theme#alpha',
      scopeTier: 'module',
    })

    expect(resolveIncomingReferences(db, { qualifiedName: 'alpha', limit: 10 })).toEqual({
      resolution: {
        status: 'resolved',
        matchedBy: 'local_name',
        symbolKey: 'src/colors.ts#0-9',
        qualifiedName: 'src/colors#alpha',
      },
      results: [],
    })
  })

  test('two exports sharing a bare name stay unresolved with ambiguous candidates', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedFile(db, 1, 'src/a.ts', 'src/a')
    seedFile(db, 2, 'src/b.ts', 'src/b')
    seedFile(db, 3, 'src/z.ts', 'src/z')
    seedSymbol(db, {
      id: 1,
      fileId: 1,
      filePath: 'src/a.ts',
      moduleKey: 'src/a',
      symbolKey: 'src/a.ts#0-9',
      localName: 'Helper',
      qualifiedName: 'src/a#Helper',
      scopeTier: 'exported',
    })
    seedSymbol(db, {
      id: 2,
      fileId: 2,
      filePath: 'src/b.ts',
      moduleKey: 'src/b',
      symbolKey: 'src/b.ts#0-9',
      localName: 'Helper',
      qualifiedName: 'src/b#Helper',
      scopeTier: 'exported',
    })
    seedSymbol(db, {
      id: 3,
      fileId: 3,
      filePath: 'src/z.ts',
      moduleKey: 'src/z',
      symbolKey: 'src/z.ts#0-9',
      localName: 'Helper',
      qualifiedName: 'src/z#Helper',
      scopeTier: 'module',
    })

    expect(resolveIncomingReferences(db, { qualifiedName: 'Helper', limit: 10 })).toEqual({
      resolution: {
        status: 'unresolved',
        reason: 'ambiguous',
        candidates: [
          {
            symbolKey: 'src/a.ts#0-9',
            qualifiedName: 'src/a#Helper',
            scopeTier: 'exported',
            filePath: 'src/a.ts',
          },
          {
            symbolKey: 'src/b.ts#0-9',
            qualifiedName: 'src/b#Helper',
            scopeTier: 'exported',
            filePath: 'src/b.ts',
          },
          {
            symbolKey: 'src/z.ts#0-9',
            qualifiedName: 'src/z#Helper',
            scopeTier: 'module',
            filePath: 'src/z.ts',
          },
        ],
      },
      results: [],
    })
  })

  test('ambiguous bare local name with zero exports stays unresolved with candidates', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedFile(db, 1, 'src/a.ts', 'src/a')
    seedFile(db, 2, 'src/b.ts', 'src/b')
    seedSymbol(db, {
      id: 3,
      fileId: 1,
      filePath: 'src/a.ts',
      moduleKey: 'src/a',
      symbolKey: 'src/a.ts#0-9',
      localName: 'dup',
      qualifiedName: 'src/a#dup',
      scopeTier: 'module',
    })
    seedSymbol(db, {
      id: 4,
      fileId: 2,
      filePath: 'src/b.ts',
      moduleKey: 'src/b',
      symbolKey: 'src/b.ts#0-9',
      localName: 'dup',
      qualifiedName: 'src/b#dup',
      scopeTier: 'module',
    })

    expect(resolveIncomingReferences(db, { qualifiedName: 'dup', limit: 10 })).toEqual({
      resolution: {
        status: 'unresolved',
        reason: 'ambiguous',
        candidates: [
          {
            symbolKey: 'src/a.ts#0-9',
            qualifiedName: 'src/a#dup',
            scopeTier: 'module',
            filePath: 'src/a.ts',
          },
          {
            symbolKey: 'src/b.ts#0-9',
            qualifiedName: 'src/b#dup',
            scopeTier: 'module',
            filePath: 'src/b.ts',
          },
        ],
      },
      results: [],
    })
  })

  test('ambiguous candidates cap at 5 with exported first then qualifiedName ASC', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    for (let i = 1; i <= 7; i += 1) {
      seedFile(db, i, `src/m${i}.ts`, `src/m${i}`)
      seedSymbol(db, {
        id: i,
        fileId: i,
        filePath: `src/m${i}.ts`,
        moduleKey: `src/m${i}`,
        symbolKey: `src/m${i}.ts#0-9`,
        localName: 'crowded',
        qualifiedName: `src/m${i}#crowded`,
        scopeTier: 'module',
      })
    }
    // Two exports sort first, then remaining modules by qualifiedName ASC.
    seedFile(db, 8, 'src/zz.ts', 'src/zz')
    seedFile(db, 9, 'src/aa.ts', 'src/aa')
    seedSymbol(db, {
      id: 8,
      fileId: 8,
      filePath: 'src/zz.ts',
      moduleKey: 'src/zz',
      symbolKey: 'src/zz.ts#0-9',
      localName: 'crowded',
      qualifiedName: 'src/zz#crowded',
      scopeTier: 'exported',
    })
    seedSymbol(db, {
      id: 9,
      fileId: 9,
      filePath: 'src/aa.ts',
      moduleKey: 'src/aa',
      symbolKey: 'src/aa.ts#0-9',
      localName: 'crowded',
      qualifiedName: 'src/aa#crowded',
      scopeTier: 'exported',
    })

    const outcome = resolveIncomingReferences(db, { qualifiedName: 'crowded', limit: 10 })
    expect(outcome.resolution.status).toBe('unresolved')
    expect(outcome.resolution.status === 'unresolved' && outcome.resolution.reason).toBe('ambiguous')
    const candidates = outcome.resolution.status === 'unresolved' ? (outcome.resolution.candidates ?? []) : []
    expect(candidates).toHaveLength(5)
    expect(candidates.map((c) => c.qualifiedName)).toEqual([
      'src/aa#crowded',
      'src/zz#crowded',
      'src/m1#crowded',
      'src/m2#crowded',
      'src/m3#crowded',
    ])
  })

  test('unknown identity is unresolved with reason unknown and no candidates', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedOpenDatabaseFixture(db)

    expect(resolveIncomingReferences(db, { qualifiedName: 'doesNotExist', limit: 10 })).toEqual({
      resolution: { status: 'unresolved', reason: 'unknown' },
      results: [],
    })
  })

  test('bare local name also resolves when passed as symbolKey', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedOpenDatabaseFixture(db)

    expect(resolveIncomingReferences(db, { symbolKey: 'openDatabase', limit: 10 })).toEqual({
      resolution: {
        status: 'resolved',
        matchedBy: 'local_name',
        symbolKey: 'src/storage/db.ts#120-190',
        qualifiedName: 'src/storage/db#openDatabase',
      },
      results: findIncomingReferences(db, { qualifiedName: 'src/storage/db#openDatabase', limit: 10 }),
    })
  })

  test('identity resolution does not fall back to fuzzy or path-prefix matches', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedOpenDatabaseFixture(db)

    // 'src/storage/db' prefix-matches the file path in the exact stage and would also hit
    // FTS, but it is not an exact symbol_key/qualified_name/local_name — so it must stay unresolved.
    expect(resolveIncomingReferences(db, { qualifiedName: 'src/storage/db', limit: 10 })).toEqual({
      resolution: { status: 'unresolved', reason: 'unknown' },
      results: [],
    })
  })

  test('findIncomingReferences keeps returning empty rows on a miss', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedOpenDatabaseFixture(db)

    expect(findIncomingReferences(db, { symbolKey: 'src/storage/db#openDatabase', limit: 10 })).toEqual([])
    expect(findIncomingReferences(db, { qualifiedName: 'openDatabase', limit: 10 })).toEqual([])
  })

  test('Module#Name partial resolves when exactly one segment-exact module match exists', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedFile(db, 1, 'src/ui/toast.tsx', 'src/ui/toast')
    seedFile(db, 2, 'src/ui/button.tsx', 'src/ui/button')
    seedSymbol(db, {
      id: 1,
      fileId: 1,
      filePath: 'src/ui/toast.tsx',
      moduleKey: 'src/ui/toast',
      symbolKey: 'src/ui/toast.tsx#0-9',
      localName: 'Action',
      qualifiedName: 'src/ui/toast#Toast>Action',
      scopeTier: 'member',
    })
    seedSymbol(db, {
      id: 2,
      fileId: 2,
      filePath: 'src/ui/button.tsx',
      moduleKey: 'src/ui/button',
      symbolKey: 'src/ui/button.tsx#0-9',
      localName: 'Action',
      qualifiedName: 'src/ui/button#Button>Action',
      scopeTier: 'member',
    })

    expect(resolveIncomingReferences(db, { qualifiedName: 'Toast#Action', limit: 10 })).toEqual({
      resolution: {
        status: 'resolved',
        matchedBy: 'module_name',
        symbolKey: 'src/ui/toast.tsx#0-9',
        qualifiedName: 'src/ui/toast#Toast>Action',
      },
      results: [],
    })
  })

  test('Module#Name does not over-match sibling modules or substring segments', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedFile(db, 1, 'src/my-module.ts', 'src/my-module')
    seedFile(db, 2, 'src/module-helper.ts', 'src/module-helper')
    seedSymbol(db, {
      id: 1,
      fileId: 1,
      filePath: 'src/my-module.ts',
      moduleKey: 'src/my-module',
      symbolKey: 'src/my-module.ts#0-9',
      localName: 'Name',
      qualifiedName: 'src/my-module#Name',
      scopeTier: 'module',
    })
    seedSymbol(db, {
      id: 2,
      fileId: 2,
      filePath: 'src/module-helper.ts',
      moduleKey: 'src/module-helper',
      symbolKey: 'src/module-helper.ts#0-9',
      localName: 'Name',
      qualifiedName: 'src/module-helper#Name',
      scopeTier: 'module',
    })

    // Neither MyModule nor module-helper is a segment-exact Module match, so the partial
    // stage does not resolve and the full identity has no local_name hits.
    expect(resolveIncomingReferences(db, { qualifiedName: 'Module#Name', limit: 10 })).toEqual({
      resolution: { status: 'unresolved', reason: 'unknown' },
      results: [],
    })
  })

  test('ambiguous Module#Name partial stays unresolved with candidates', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedFile(db, 1, 'src/a/toast.ts', 'src/a/toast')
    seedFile(db, 2, 'src/b/toast.ts', 'src/b/toast')
    seedSymbol(db, {
      id: 1,
      fileId: 1,
      filePath: 'src/a/toast.ts',
      moduleKey: 'src/a/toast',
      symbolKey: 'src/a/toast.ts#0-9',
      localName: 'Action',
      qualifiedName: 'src/a/toast#Action',
      scopeTier: 'module',
    })
    seedSymbol(db, {
      id: 2,
      fileId: 2,
      filePath: 'src/b/toast.ts',
      moduleKey: 'src/b/toast',
      symbolKey: 'src/b/toast.ts#0-9',
      localName: 'Action',
      qualifiedName: 'src/b/toast#Action',
      scopeTier: 'module',
    })

    const outcome = resolveIncomingReferences(db, { qualifiedName: 'Toast#Action', limit: 10 })
    expect(outcome.resolution.status).toBe('unresolved')
    expect(outcome.resolution.status === 'unresolved' && outcome.resolution.reason).toBe('ambiguous')
    expect(outcome.resolution.status === 'unresolved' && outcome.resolution.candidates?.map((c) => c.qualifiedName)).toEqual(
      ['src/a/toast#Action', 'src/b/toast#Action'],
    )
  })

  test('canonical full qualified_name still wins over Module#Name partial', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedFile(db, 1, 'src/toast.ts', 'src/toast')
    seedFile(db, 2, 'src/other.ts', 'src/other')
    seedSymbol(db, {
      id: 1,
      fileId: 1,
      filePath: 'src/toast.ts',
      moduleKey: 'src/toast',
      symbolKey: 'src/toast.ts#0-9',
      localName: 'Toast#Action',
      qualifiedName: 'Toast#Action',
      scopeTier: 'module',
    })
    seedSymbol(db, {
      id: 2,
      fileId: 2,
      filePath: 'src/other.ts',
      moduleKey: 'Toast',
      symbolKey: 'src/other.ts#0-9',
      localName: 'Action',
      qualifiedName: 'Toast#Action#member',
      scopeTier: 'module',
    })

    // Exact qualified_name match for the literal string wins before the partial stage.
    expect(resolveIncomingReferences(db, { qualifiedName: 'Toast#Action', limit: 10 })).toEqual({
      resolution: {
        status: 'canonical',
        matchedBy: 'qualified_name',
        symbolKey: 'src/toast.ts#0-9',
        qualifiedName: 'Toast#Action',
      },
      results: [],
    })
  })
})
