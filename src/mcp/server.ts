import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

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
} from './tools.js'

const registerSearchTool = (server: McpServer, deps: Readonly<CodeindexToolDeps>): void => {
  server.registerTool(
    'code_search',
    {
      description: 'Search indexed symbols',
      inputSchema: CodeSearchInputSchema,
      outputSchema: CodeSearchOutputSchema,
    },
    async ({ query, limit, kinds, scopeTiers, pathPrefix }: CodeSearchInput) => {
      const results = await deps.codeSearch({ query, limit, kinds, scopeTiers, pathPrefix })
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
      return buildStructuredToolResult(
        CodeSearchOutputSchema,
        { query, resultCount: results.length, results: [...results], guidance },
        summary,
      )
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
    async ({ query, limit }: CodeSymbolInput) => {
      const results = await deps.codeSymbol(query, limit)
      const summary = `${results.length} candidate(s): ${results
        .slice(0, 5)
        .map((r) => r.qualifiedName)
        .join(', ')}`
      return buildStructuredToolResult(CodeSymbolOutputSchema, { results: [...results] }, summary)
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
      const summary = `${results.length} incoming reference(s)`
      return buildStructuredToolResult(CodeImpactOutputSchema, { results: [...results] }, summary)
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
      const summary = await deps.codeIndex({ mode })
      const summaryText = `Indexed ${summary.filesIndexed} files, ${summary.symbolsIndexed} symbols, ${summary.referencesIndexed} references`
      return buildStructuredToolResult(CodeIndexOutputSchema, summary, summaryText)
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
