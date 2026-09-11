import { z } from 'zod'

import type { IndexSummary } from '../indexer/index-codebase.js'
import type { ImpactIdentityResolution, ImpactLookupInput, ImpactResult } from '../search/index.js'
import type { OutlineExport, OutlineMode, OutlineSymbol } from '../search/outline.js'
import type { RankedSearchResult, SearchMode, SearchResult } from '../types.js'

export const FreshnessSchema = z.enum(['fresh', 'possibly_stale'])
export type Freshness = z.infer<typeof FreshnessSchema>

export const RefreshModeSchema = z.enum(['background', 'wait', 'off'])
export type RefreshMode = z.infer<typeof RefreshModeSchema>

export type FreshnessMark = Readonly<{ freshness?: Freshness }>

export type OutlineSymbolResult = OutlineSymbol & FreshnessMark
export type OutlineExportResult = OutlineExport & FreshnessMark

export type OutlineToolOutcome =
  | Readonly<{
      mode: 'symbols'
      filePath: string
      resultCount: number
      truncated: boolean
      results: readonly OutlineSymbolResult[]
      guidance?: string
    }>
  | Readonly<{
      mode: 'exports'
      filePath: string
      resultCount: number
      truncated: boolean
      results: readonly OutlineExportResult[]
      guidance?: string
    }>

export interface CodeindexToolDeps {
  readonly codeSearch: (input: {
    query: string
    limit: number
    mode?: SearchMode
    kinds?: readonly string[]
    scopeTiers?: readonly SearchResult['scopeTier'][]
    pathPrefix?: string
    refresh?: RefreshMode
  }) => Promise<readonly (RankedSearchResult & FreshnessMark)[]>
  readonly codeSymbol: (
    query: string,
    limit: number,
    refresh?: RefreshMode,
  ) => Promise<readonly (SearchResult & FreshnessMark)[]>
  readonly codeImpact: (input: ImpactLookupInput & { refresh?: RefreshMode }) => Promise<{
    resolution: ImpactIdentityResolution
    results: readonly (ImpactResult & FreshnessMark)[]
  }>
  readonly codeOutline: (input: {
    filePath: string
    mode: OutlineMode
    limit: number
    scopeTiers?: readonly SearchResult['scopeTier'][]
    kinds?: readonly string[]
    refresh?: RefreshMode
  }) => Promise<OutlineToolOutcome>
  readonly codeIndex: (input: { mode: 'full' | 'incremental' }) => Promise<IndexSummary>
  readonly getIndexFreshness?: () => Freshness
  readonly getWatcherState?: () => WatcherState
  readonly logResponseBytes?: (tool: string, bytes: number) => void
}

export const CodeSearchInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).default(10),
  mode: z.enum(['auto', 'exact', 'fts', 'fused']).optional(),
  kinds: z.array(z.string().min(1)).optional(),
  scopeTiers: z.array(z.enum(['exported', 'module', 'member', 'local'])).optional(),
  pathPrefix: z.string().min(1).optional(),
  preview: z.enum(['none', 'short', 'full']).default('none'),
  refresh: RefreshModeSchema.default('background'),
})
export type CodeSearchInput = z.infer<typeof CodeSearchInputSchema>

export const CodeSymbolInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).default(10),
  preview: z.enum(['none', 'short', 'full']).default('none'),
  refresh: RefreshModeSchema.default('background'),
})
export type CodeSymbolInput = z.infer<typeof CodeSymbolInputSchema>

export const CodeImpactInputSchema = z
  .object({
    symbolKey: z.string().min(1).optional(),
    qualifiedName: z.string().min(1).optional(),
    limit: z.number().int().positive().max(100).default(20),
    refresh: RefreshModeSchema.default('background'),
  })
  .refine((value) => value.symbolKey !== undefined || value.qualifiedName !== undefined, {
    message: 'Either symbolKey or qualifiedName is required',
  })
export type CodeImpactInput = z.infer<typeof CodeImpactInputSchema>

export const CodeIndexInputSchema = z.object({
  mode: z.enum(['full', 'incremental']).default('incremental'),
})
export type CodeIndexInput = z.infer<typeof CodeIndexInputSchema>

export const CodeOutlineInputSchema = z.object({
  filePath: z.string().min(1),
  mode: z.enum(['symbols', 'exports']),
  limit: z.number().int().positive().max(500).default(200),
  scopeTiers: z.array(z.enum(['exported', 'module', 'member', 'local'])).optional(),
  kinds: z.array(z.string().min(1)).optional(),
  refresh: RefreshModeSchema.default('background'),
})
export type CodeOutlineInput = z.infer<typeof CodeOutlineInputSchema>

export const WatcherStatusSchema = z.enum(['idle', 'catching_up', 'error'])
export type WatcherStatus = z.infer<typeof WatcherStatusSchema>

export const WatcherStateSchema = z.object({
  status: WatcherStatusSchema,
  pendingEvents: z.number().int(),
  lastError: z.string().nullable(),
  lastCompletedAt: z.number().nullable(),
})
export type WatcherState = z.infer<typeof WatcherStateSchema>

const RankedSearchResultSchema = z.object({
  symbolKey: z.string(),
  qualifiedName: z.string(),
  localName: z.string(),
  kind: z.string(),
  scopeTier: z.enum(['exported', 'module', 'member', 'local']),
  filePath: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  exportNames: z.array(z.string()),
  matchedBy: z.enum(['exact_export', 'exact_qualified', 'exact_local', 'path_prefix', 'fts']),
  confidence: z.string(),
  snippet: z.string(),
  rankScore: z.number(),
  freshness: FreshnessSchema.optional(),
})

export const CodeSearchOutputSchema = z.object({
  query: z.string(),
  resultCount: z.number(),
  results: z.array(RankedSearchResultSchema),
  guidance: z.string().optional(),
  indexFreshness: FreshnessSchema.optional(),
})

export const CodeSymbolOutputSchema = z.object({
  results: z.array(RankedSearchResultSchema),
  indexFreshness: FreshnessSchema.optional(),
})

const ImpactResultSchema = z.object({
  sourceQualifiedName: z.string().nullable(),
  sourceFilePath: z.string(),
  edgeType: z.string(),
  confidence: z.string(),
  lineNumber: z.number(),
  freshness: FreshnessSchema.optional(),
})

export const ImpactIdentityCandidateSchema = z.object({
  symbolKey: z.string(),
  qualifiedName: z.string(),
  scopeTier: z.string(),
  filePath: z.string(),
})

export const ImpactIdentitySchema = z.object({
  status: z.enum(['canonical', 'resolved', 'unresolved']),
  matchedBy: z.enum(['symbol_key', 'qualified_name', 'local_name', 'module_name']).optional(),
  symbolKey: z.string().optional(),
  qualifiedName: z.string().optional(),
  reason: z.enum(['unknown', 'ambiguous']).optional(),
  candidates: z.array(ImpactIdentityCandidateSchema).optional(),
})

export const CodeImpactOutputSchema = z.object({
  results: z.array(ImpactResultSchema),
  identity: ImpactIdentitySchema.optional(),
  guidance: z.string().optional(),
  indexFreshness: FreshnessSchema.optional(),
})

export const CodeIndexOutputSchema = z.object({
  filesIndexed: z.number(),
  filesFailed: z.number(),
  filesPruned: z.number(),
  skippedFiles: z.array(z.string()),
  skippedFilesTotal: z.number(),
  symbolsIndexed: z.number(),
  referencesIndexed: z.number(),
  referencesUnresolved: z.number(),
  elapsedMs: z.number(),
  watcher: WatcherStateSchema.optional(),
})

const OutlineSymbolResultSchema = z.object({
  symbolKey: z.string(),
  qualifiedName: z.string(),
  localName: z.string(),
  kind: z.string(),
  scopeTier: z.enum(['exported', 'module', 'member', 'local']),
  filePath: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  signatureText: z.string(),
  exportNames: z.array(z.string()),
  freshness: FreshnessSchema.optional(),
})

const OutlineExportResultSchema = z.object({
  exportName: z.string(),
  exportKind: z.enum(['named', 'default', 'namespace', 'reexport', 'star']),
  symbolId: z.number().nullable(),
  qualifiedName: z.string().nullable(),
  targetModuleSpecifier: z.string().nullable(),
  filePath: z.string(),
  freshness: FreshnessSchema.optional(),
})

export const CodeOutlineOutputSchema = z.object({
  mode: z.enum(['symbols', 'exports']),
  filePath: z.string(),
  resultCount: z.number(),
  truncated: z.boolean(),
  // Row shape follows `mode`: symbols rows vs export rows. A single object
  // (not discriminatedUnion) keeps MCP SDK outputSchema conversion working.
  results: z.array(z.union([OutlineSymbolResultSchema, OutlineExportResultSchema])),
  guidance: z.string().optional(),
  indexFreshness: FreshnessSchema.optional(),
})

export const buildStructuredToolResult = <S extends z.ZodType>(
  schema: S,
  output: unknown,
  summaryText: string,
): {
  content: Array<{ type: 'text'; text: string }>
  structuredContent: z.output<S>
  responseBytes: number
} => {
  const parsed = schema.parse(output)
  const responseBytes = Buffer.byteLength(summaryText, 'utf8') + Buffer.byteLength(JSON.stringify(parsed), 'utf8')
  return {
    content: [{ type: 'text', text: summaryText }],
    structuredContent: parsed,
    responseBytes,
  }
}
