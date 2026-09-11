import type { Database } from 'bun:sqlite'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { IndexSummary } from '../../src/indexer/index-codebase.js'
import type { CodeindexToolDeps } from '../../src/mcp/tools.js'
import { resolveIncomingReferences, findSymbolCandidates, searchSymbols } from '../../src/search/index.js'
import { outlineFile } from '../../src/search/outline.js'

export const connectClient = async (server: McpServer): Promise<Client> => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return client
}

const emptySummary: IndexSummary = {
  filesIndexed: 0,
  filesFailed: 0,
  filesPruned: 0,
  skippedFiles: [],
  skippedFilesTotal: 0,
  symbolsIndexed: 0,
  referencesIndexed: 0,
  referencesUnresolved: 0,
  referencesRepaired: 0,
  elapsedMs: 0,
}

export const emptyOutlineResult = (
  input: Readonly<{ filePath: string; mode: 'symbols' | 'exports' }>,
): Awaited<ReturnType<CodeindexToolDeps['codeOutline']>> =>
  input.mode === 'symbols'
    ? { mode: 'symbols', filePath: input.filePath, resultCount: 0, truncated: false, results: [] }
    : { mode: 'exports', filePath: input.filePath, resultCount: 0, truncated: false, results: [] }

export const makeInMemoryDeps = (db: Database): CodeindexToolDeps => ({
  codeSearch: (input: Parameters<typeof searchSymbols>[1]): Promise<ReturnType<typeof searchSymbols>> =>
    Promise.resolve(searchSymbols(db, input)),
  codeSymbol: (query: string, limit: number): Promise<ReturnType<typeof findSymbolCandidates>> =>
    Promise.resolve(findSymbolCandidates(db, query, limit)),
  codeImpact: (
    input: Parameters<typeof resolveIncomingReferences>[1],
  ): Promise<ReturnType<typeof resolveIncomingReferences>> => Promise.resolve(resolveIncomingReferences(db, input)),
  codeOutline: (input: {
    filePath: string
    mode: 'symbols' | 'exports'
    limit: number
    scopeTiers?: readonly ('exported' | 'module' | 'member' | 'local')[]
    kinds?: readonly string[]
  }): Promise<Awaited<ReturnType<CodeindexToolDeps['codeOutline']>>> => Promise.resolve(outlineFile(db, input)),
  codeIndex: (): Promise<IndexSummary> => Promise.resolve(emptySummary),
})

export interface SeedFile {
  readonly id: number
  readonly filePath: string
  readonly moduleKey: string
}

export const seedFile = (db: Database, file: SeedFile): void => {
  db.query(
    `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at)
     VALUES (?, ?, ?, 'ts', 'x', 'indexed', NULL, datetime('now'))`,
  ).run(file.id, file.filePath, file.moduleKey)
}

export interface SeedSymbol {
  readonly id: number
  readonly fileId: number
  readonly filePath: string
  readonly moduleKey: string
  readonly localName: string
  readonly qualifiedName: string
}

export const seedSymbol = (db: Database, symbol: SeedSymbol): void => {
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
