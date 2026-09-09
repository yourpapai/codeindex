import { z } from 'zod'

import type { IndexSummary } from '../indexer/index-codebase.js'
import type { ImpactResult } from '../search/index.js'
import type { RankedSearchResult, SearchResult } from '../types.js'

export const FreshnessSchema = z.enum(['fresh', 'possibly_stale'])
export type Freshness = z.infer<typeof FreshnessSchema>

export type FreshnessMark = Readonly<{ freshness?: Freshness }>

export interface CodeindexToolDeps {
  readonly codeSearch: (input: {
    query: string
    limit: number
    kinds?: readonly string[]
    scopeTiers?: readonly SearchResult['scopeTier'][]
    pathPrefix?: string
  }) => Promise<readonly (RankedSearchResult & FreshnessMark)[]>
  readonly codeSymbol: (query: string, limit: number) => Promise<readonly (SearchResult & FreshnessMark)[]>
  readonly codeImpact: (input: {
    symbolKey?: string
    qualifiedName?: string
    limit: number
  }) => Promise<readonly (ImpactResult & FreshnessMark)[]>
  readonly codeIndex: (input: { mode: 'full' | 'incremental' }) => Promise<IndexSummary>
  readonly getIndexFreshness?: () => Freshness
  readonly getWatcherState?: () => WatcherState
}

export const CodeSearchInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).default(10),
  kinds: z.array(z.string().min(1)).optional(),
  scopeTiers: z.array(z.enum(['exported', 'module', 'member', 'local'])).optional(),
  pathPrefix: z.string().min(1).optional(),
})
export type CodeSearchInput = z.infer<typeof CodeSearchInputSchema>

export const CodeSymbolInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).default(10),
})
export type CodeSymbolInput = z.infer<typeof CodeSymbolInputSchema>

export const CodeImpactInputSchema = z
  .object({
    symbolKey: z.string().min(1).optional(),
    qualifiedName: z.string().min(1).optional(),
    limit: z.number().int().positive().max(100).default(20),
  })
  .refine((value) => value.symbolKey !== undefined || value.qualifiedName !== undefined, {
    message: 'Either symbolKey or qualifiedName is required',
  })
export type CodeImpactInput = z.infer<typeof CodeImpactInputSchema>

export const CodeIndexInputSchema = z.object({
  mode: z.enum(['full', 'incremental']).default('incremental'),
})
export type CodeIndexInput = z.infer<typeof CodeIndexInputSchema>

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
  matchReason: z.string(),
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

export const CodeImpactOutputSchema = z.object({
  results: z.array(ImpactResultSchema),
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

export const buildStructuredToolResult = <S extends z.ZodType>(
  schema: S,
  output: unknown,
  summaryText: string,
): { content: Array<{ type: 'text'; text: string }>; structuredContent: z.output<S> } => {
  const parsed = schema.parse(output)
  return {
    content: [{ type: 'text', text: summaryText }],
    structuredContent: parsed,
  }
}
