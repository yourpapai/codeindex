import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'

import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { TextContent } from '@modelcontextprotocol/sdk/types.js'

import { createCodeindexServer } from '../../src/mcp/server.js'
import { CodeImpactOutputSchema, CodeSearchOutputSchema, CodeSymbolOutputSchema } from '../../src/mcp/tools.js'
import { ensureSchema } from '../../src/storage/schema.js'
import { connectClient, makeInMemoryDeps, seedFile, seedSymbol } from './harness.js'

const openDbs: Database[] = []

const buildSeededDb = (): Database => {
  const db = new Database(':memory:')
  openDbs.push(db)
  ensureSchema(db)
  seedFile(db, { id: 1, filePath: 'src/search/index.ts', moduleKey: 'src/search/index' })
  seedFile(db, { id: 2, filePath: 'src/storage/db.ts', moduleKey: 'src/storage/db' })
  seedSymbol(db, {
    id: 1,
    fileId: 1,
    filePath: 'src/search/index.ts',
    moduleKey: 'src/search/index',
    localName: 'searchSymbols',
    qualifiedName: 'src/search/index#searchSymbols',
  })
  seedSymbol(db, {
    id: 2,
    fileId: 2,
    filePath: 'src/storage/db.ts',
    moduleKey: 'src/storage/db',
    localName: 'openDatabase',
    qualifiedName: 'src/storage/db#openDatabase',
  })
  db.query(
    `INSERT INTO symbol_references (source_symbol_id, source_file_id, target_symbol_id, target_file_id, target_name, target_export_name, target_module_specifier, edge_type, confidence, line_number)
     VALUES (1, 1, 2, 2, 'openDatabase', NULL, '../storage/db', 'calls', 'resolved', 5)`,
  ).run()
  return db
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    db.close()
  }
})

describe('MCP protocol boundary', () => {
  test('listTools exposes all four tools', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const listed = await client.listTools()
    const names = listed.tools.map((tool) => tool.name).sort()
    expect(names).toEqual(['code_impact', 'code_index', 'code_search', 'code_symbol'])
  })

  test('code_search returns a structured hit for a known symbol', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const result = await client.callTool({ name: 'code_search', arguments: { query: 'searchSymbols' } })
    expect(result.isError).not.toBe(true)
    const payload = CodeSearchOutputSchema.parse(result.structuredContent)
    expect(payload.resultCount).toBeGreaterThanOrEqual(1)
    expect(payload.results.some((row) => row.qualifiedName === 'src/search/index#searchSymbols')).toBe(true)
    expect(payload.guidance).toBeUndefined()
  })

  test('code_search on no match returns the guidance string', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const result = await client.callTool({ name: 'code_search', arguments: { query: 'zzz_nonexistent_symbol' } })
    const payload = CodeSearchOutputSchema.parse(result.structuredContent)
    expect(payload.resultCount).toBe(0)
    expect(typeof payload.guidance).toBe('string')
    expect(payload.guidance).toContain('No symbol matches')
  })

  test('code_symbol returns candidates with no guidance field', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const result = await client.callTool({ name: 'code_symbol', arguments: { query: 'openDatabase' } })
    const payload = CodeSymbolOutputSchema.parse(result.structuredContent)
    expect(payload.results.some((row) => row.qualifiedName === 'src/storage/db#openDatabase')).toBe(true)
    expect(result.structuredContent).not.toHaveProperty('guidance')
  })

  test('code_impact resolves incoming references by qualifiedName', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const result = await client.callTool({
      name: 'code_impact',
      arguments: { qualifiedName: 'src/storage/db#openDatabase' },
    })
    const payload = CodeImpactOutputSchema.parse(result.structuredContent)
    expect(payload.results.some((row) => row.sourceQualifiedName === 'src/search/index#searchSymbols')).toBe(true)
  })

  test('code_impact without symbolKey or qualifiedName is a tool error', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const result = await client.callTool({ name: 'code_impact', arguments: { limit: 5 } })
    expect(result.isError).toBe(true)
    const parsed = CallToolResultSchema.parse(result)
    const block = parsed.content.find((entry): entry is TextContent => entry.type === 'text')
    expect(block).toBeDefined()
    expect(block!.text).toContain('symbolKey or qualifiedName')
  })

  test('code_search with a missing query is a validation error', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const result = await client.callTool({ name: 'code_search', arguments: {} })
    expect(result.isError).toBe(true)
  })
})
