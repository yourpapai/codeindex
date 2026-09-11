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
  type CodeOutlineInput,
  CodeOutlineInputSchema,
  CodeOutlineOutputSchema,
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
      description:
        'Search indexed symbols. Optional refresh: "background" (default, serve now), "wait" (bounded incremental catch-up then re-search), or "off" (no catch-up from this call).',
      inputSchema: CodeSearchInputSchema,
      outputSchema: CodeSearchOutputSchema,
    },
    async ({ query, limit, mode, kinds, scopeTiers, pathPrefix, preview, refresh }: CodeSearchInput) => {
      const results = await deps.codeSearch({ query, limit, mode, kinds, scopeTiers, pathPrefix, refresh })
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
      description:
        'Resolve a query to candidate symbols. Optional refresh: "background" (default, serve now), "wait" (bounded incremental catch-up then re-search), or "off" (no catch-up from this call).',
      inputSchema: CodeSymbolInputSchema,
      outputSchema: CodeSymbolOutputSchema,
    },
    async ({ query, limit, preview, refresh }: CodeSymbolInput) => {
      const results = await deps.codeSymbol(query, limit, refresh)
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
      description:
        'Find incoming references for a symbol. Identity forms: exact symbol_key (file#start-end), exact qualified_name (module#name or parent>name), exact repo-unique local name, unique-export local name (accepted when exactly one export holds the name even if members share it), or Module#Name partials (segment-exact module_key). Ambiguous local names (multiple exports, or multiple non-export matches) return unresolved with a capped candidate list rather than a rank-order guess; unknown identities return unresolved instead of fuzzy matches. Optional refresh: "background" (default), "wait", or "off".',
      inputSchema: CodeImpactInputSchema,
      outputSchema: CodeImpactOutputSchema,
    },
    async ({ symbolKey, qualifiedName, limit, refresh }: CodeImpactInput) => {
      const { resolution, results } = await deps.codeImpact({ symbolKey, qualifiedName, limit, refresh })
      const indexFreshness = deps.getIndexFreshness?.()
      // Split empty outcomes honestly: an unresolved identity is a lookup miss — the graph is
      // fine, so never advise a reindex there. A resolved symbol with zero rows can legitimately
      // mean an orphan-prone graph, so the code_symbol confirmation + full code_index advice
      // survives only for that case.
      const identityInput = symbolKey ?? qualifiedName ?? ''
      const unresolvedCandidates = resolution.status === 'unresolved' ? (resolution.candidates ?? []) : []
      const unresolvedGuidance =
        unresolvedCandidates.length > 0
          ? `Identity "${identityInput}" is ambiguous (${unresolvedCandidates.length} candidate(s); showing up to 5). Never rank-order guessed. Retry with a precise identity: ${unresolvedCandidates.map((c) => c.qualifiedName).join(', ')}. Use code_symbol if you need more detail.`
          : `Identity "${identityInput}" did not resolve to an indexed symbol by exact symbol_key, exact qualified_name, or repo-unique local name (unknown or ambiguous). Ambiguous bare local names are never rank-order guessed. Use code_symbol to find the exact identity, then retry with its symbolKey or qualifiedName.`
      const guidance =
        resolution.status === 'unresolved'
          ? unresolvedGuidance
          : results.length === 0
            ? 'Symbol resolved but no incoming references found. Confirm the symbol name via code_symbol; if results look degraded, run code_index (full reindex) to rebuild the reference graph.'
            : undefined
      const summary =
        results.length === 0 ? (guidance ?? 'No incoming references.') : `${results.length} incoming reference(s)`
      const toolResult = buildStructuredToolResult(
        CodeImpactOutputSchema,
        {
          results: [...results],
          identity: resolution,
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

const registerOutlineTool = (server: McpServer, deps: Readonly<CodeindexToolDeps>): void => {
  server.registerTool(
    'code_outline',
    {
      description:
        'List one file\'s structure by exact repo-relative path. mode=symbols: in-file symbols ordered by start line (defaults exclude local). mode=exports: module_exports surface (re-exports/barrels). Not for ranked name search — use code_search/code_symbol. Optional refresh: "background" (default), "wait", or "off".',
      inputSchema: CodeOutlineInputSchema,
      outputSchema: CodeOutlineOutputSchema,
    },
    async ({ filePath, mode, limit, scopeTiers, kinds, refresh }: CodeOutlineInput) => {
      const outcome = await deps.codeOutline({ filePath, mode, limit, scopeTiers, kinds, refresh })
      const indexFreshness = deps.getIndexFreshness?.()
      const truncatedClause = outcome.truncated ? '; truncated' : ''
      const guidanceClause = outcome.guidance === undefined ? '' : ` — ${outcome.guidance}`
      const summary = `Outline ${outcome.resultCount} ${mode} row(s) for ${filePath}${truncatedClause}${guidanceClause}`
      const toolResult = buildStructuredToolResult(
        CodeOutlineOutputSchema,
        {
          ...outcome,
          ...(indexFreshness === undefined ? {} : { indexFreshness }),
        },
        indexFreshness === undefined ? summary : summary + freshnessSuffix(outcome.results, indexFreshness),
      )
      deps.logResponseBytes?.('code_outline', toolResult.responseBytes)
      return toolResult
    },
  )
}

export const createCodeindexServer = (deps: Readonly<CodeindexToolDeps>): McpServer => {
  const server = new McpServer({ name: 'codeindex', version: '0.1.0' })
  registerSearchTool(server, deps)
  registerSymbolTool(server, deps)
  registerImpactTool(server, deps)
  registerOutlineTool(server, deps)
  registerIndexTool(server, deps)
  return server
}
