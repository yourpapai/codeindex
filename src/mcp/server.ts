import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { applyPreviewToList } from './preview.js'
import {
  buildStructuredToolResult,
  type CodeImpactInput,
  CodeImpactInputSchema,
  CodeImpactOutputSchema,
  type CodeIndexInput,
  CodeIndexInputSchema,
  CodeIndexOutputSchema,
  type CodeSearchInput,
  CodeSearchInputSchema,
  CodeSearchOutputSchema,
  type CodeSymbolInput,
  CodeSymbolInputSchema,
  CodeSymbolOutputSchema,
  type CodeindexToolDeps,
  type Freshness,
} from './tools.js'

const freshnessSuffix = (results: readonly { readonly freshness?: Freshness }[], indexFreshness: Freshness): string => {
  const staleCount = results.filter((result) => result.freshness === 'possibly_stale').length
  const staleClause = staleCount > 0 ? `; ${staleCount} of ${results.length} hits possibly_stale` : ''
  return ` (indexFreshness: ${indexFreshness}${staleClause})`
}

const registerSearchTool = (server: McpServer, deps: Readonly<CodeindexToolDeps>): void => {
  server.registerTool(
    'code_search',
    {
      description: 'Search indexed symbols',
      inputSchema: CodeSearchInputSchema,
      outputSchema: CodeSearchOutputSchema,
    },
    async ({ query, limit, mode, kinds, scopeTiers, pathPrefix, preview }: CodeSearchInput) => {
      const results = await deps.codeSearch({ query, limit, mode, kinds, scopeTiers, pathPrefix })
      const compacted = applyPreviewToList(results, preview)
      const indexFreshness = deps.getIndexFreshness?.()
      const guidance =
        results.length === 0
          ? 'No symbol matches. Retry with broader terms, relax scopeTiers, or use code_symbol when you know the exact name.'
          : undefined
      const topNames = results
        .slice(0, 5)
        .map((r) => r.qualifiedName)
        .join(', ')
      const summary =
        results.length === 0
          ? (guidance ?? 'No matches.')
          : `${results.length} result(s): ${topNames}${results.length > 5 ? ', …' : ''}`
      const toolResult = buildStructuredToolResult(
        CodeSearchOutputSchema,
        { query, resultCount: results.length, results: [...compacted], guidance, indexFreshness },
        indexFreshness === undefined ? summary : summary + freshnessSuffix(results, indexFreshness),
      )
      deps.logResponseBytes?.('code_search', toolResult.responseBytes)
      return toolResult
    },
  )
}

const registerSymbolTool = (server: McpServer, deps: Readonly<CodeindexToolDeps>): void => {
  server.registerTool(
    'code_symbol',
    {
      description: 'Resolve a query to candidate symbols',
      inputSchema: CodeSymbolInputSchema,
      outputSchema: CodeSymbolOutputSchema,
    },
    async ({ query, limit, preview }: CodeSymbolInput) => {
      const results = await deps.codeSymbol(query, limit)
      const compacted = applyPreviewToList(results, preview)
      const indexFreshness = deps.getIndexFreshness?.()
      const summary = `${results.length} candidate(s): ${results
        .slice(0, 5)
        .map((r) => r.qualifiedName)
        .join(', ')}`
      const toolResult = buildStructuredToolResult(
        CodeSymbolOutputSchema,
        { results: [...compacted], indexFreshness },
        indexFreshness === undefined ? summary : summary + freshnessSuffix(results, indexFreshness),
      )
      deps.logResponseBytes?.('code_symbol', toolResult.responseBytes)
      return toolResult
    },
  )
}

const registerImpactTool = (server: McpServer, deps: Readonly<CodeindexToolDeps>): void => {
  server.registerTool(
    'code_impact',
    {
      description: 'Find incoming references for a symbol',
      inputSchema: CodeImpactInputSchema,
      outputSchema: CodeImpactOutputSchema,
    },
    async ({ symbolKey, qualifiedName, limit }: CodeImpactInput) => {
      const results = await deps.codeImpact({ symbolKey, qualifiedName, limit })
      const indexFreshness = deps.getIndexFreshness?.()
      // Mirrors the code_search contract: an empty result explains itself — an orphan-prone graph
      // can legitimately return zero rows for a real symbol, so point at exact lookup and a full
      // reindex instead of letting agents conclude "no callers" and fall back to grep.
      const guidance =
        results.length === 0
          ? 'No incoming references found. Confirm the symbol name via code_symbol; if results look degraded, run code_index (full reindex) to rebuild the reference graph.'
          : undefined
      const summary =
        results.length === 0 ? (guidance ?? 'No incoming references.') : `${results.length} incoming reference(s)`
      const toolResult = buildStructuredToolResult(
        CodeImpactOutputSchema,
        {
          results: [...results],
          ...(guidance === undefined ? {} : { guidance }),
          indexFreshness,
        },
        indexFreshness === undefined ? summary : summary + freshnessSuffix(results, indexFreshness),
      )
      deps.logResponseBytes?.('code_impact', toolResult.responseBytes)
      return toolResult
    },
  )
}

const registerIndexTool = (server: McpServer, deps: Readonly<CodeindexToolDeps>): void => {
  server.registerTool(
    'code_index',
    {
      description: 'Run full or incremental indexing',
      inputSchema: CodeIndexInputSchema,
      outputSchema: CodeIndexOutputSchema,
    },
    async ({ mode }: CodeIndexInput) => {
      const watcher = deps.getWatcherState?.()
      const summary = await deps.codeIndex({ mode })
      const skippedSuffix = summary.skippedFilesTotal > 0 ? `, ${summary.skippedFilesTotal} skipped` : ''
      const watcherSuffix = watcher !== undefined && watcher.status !== 'idle' ? ` (watcher: ${watcher.status})` : ''
      const summaryText = `Indexed ${summary.filesIndexed} files, ${summary.symbolsIndexed} symbols, ${summary.referencesIndexed} references${skippedSuffix}`
      const payload = { ...summary, skippedFiles: summary.skippedFiles.slice(0, 20), watcher }
      return buildStructuredToolResult(CodeIndexOutputSchema, payload, summaryText + watcherSuffix)
    },
  )
}

export const createCodeindexServer = (deps: Readonly<CodeindexToolDeps>): McpServer => {
  const server = new McpServer({ name: 'codeindex', version: '0.1.0' })
  registerSearchTool(server, deps)
  registerSymbolTool(server, deps)
  registerImpactTool(server, deps)
  registerIndexTool(server, deps)
  return server
}
