import { z } from 'zod'

export const TaskKindSchema = z.enum(['locate', 'who-uses', 'explain', 'review', 'map'])
export type TaskKind = z.infer<typeof TaskKindSchema>

export const TaskSpecSchema = z.object({
  id: z.string().min(1),
  kind: TaskKindSchema,
  prompt: z.string().min(1),
  groundTruth: z
    .object({
      expected: z.array(z.string().min(1)),
    })
    .optional(),
  judgeNotes: z.string().optional(),
})
export type TaskSpec = z.infer<typeof TaskSpecSchema>

export const TokenUsageSchema = z.object({
  input: z.number().min(0),
  output: z.number().min(0),
  reasoning: z.number().min(0),
  cacheRead: z.number().min(0),
  cacheWrite: z.number().min(0),
})
export type TokenUsage = z.infer<typeof TokenUsageSchema>

export const ToolCallSchema = z.object({
  tool: z.string().min(1),
  status: z.enum(['pending', 'running', 'completed', 'error']),
})
export type ToolCall = z.infer<typeof ToolCallSchema>

export const RunRecordSchema = z.object({
  taskId: z.string().min(1),
  arm: z.enum(['with', 'without']),
  rep: z.number().int().min(0),
  sessionId: z.string().min(1),
  agentModel: z.string().min(1),
  prompt: z.string().min(1),
  answer: z.string(),
  tokens: TokenUsageSchema,
  cost: z.number().min(0),
  toolCalls: z.array(ToolCallSchema),
  wallTimeMs: z.number().min(0),
  compacted: z.boolean(),
  error: z.string().nullable().optional(),
  finishedAt: z.string().min(1),
})
export type RunRecord = z.infer<typeof RunRecordSchema>

export const RubricScoresSchema = z.object({
  correctness: z.number().min(0).max(10),
  completeness: z.number().min(0).max(10),
  specificity: z.number().min(0).max(10),
})
export type RubricScores = z.infer<typeof RubricScoresSchema>

export const JudgeVerdictSchema = z.object({
  taskId: z.string().min(1),
  first: z.enum(['a', 'b', 'tie']),
  second: z.enum(['a', 'b', 'tie']),
  winner: z.enum(['with', 'without', 'tie']),
  presentation: z.enum(['withFirst', 'withoutFirst']),
  scoresWith: RubricScoresSchema,
  scoresWithout: RubricScoresSchema,
})
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>

export const ObjectiveGradeSchema = z.object({
  taskId: z.string().min(1),
  arm: z.enum(['with', 'without']),
  rep: z.number().int().min(0),
  pass: z.boolean(),
  hallucinated: z.boolean(),
  expected: z.array(z.string().min(1)),
  namedSymbols: z.array(z.string().min(1)),
})
export type ObjectiveGrade = z.infer<typeof ObjectiveGradeSchema>

export const ArmSummarySchema = z.object({
  runs: z.number().int().min(0),
  meanTokens: TokenUsageSchema,
  medianTokens: TokenUsageSchema,
  meanCost: z.number().min(0),
  meanWallTimeMs: z.number().min(0),
  medianWallTimeMs: z.number().min(0),
  toolCallCounts: z.record(z.string(), z.number().int().min(1)),
  objectivePassRate: z.number().min(0).max(1),
  hallucinationRate: z.number().min(0).max(1),
})
export type ArmSummary = z.infer<typeof ArmSummarySchema>

export const BaselineComparisonSchema = z.object({
  path: z.string().min(1),
  deltas: z.record(z.string(), z.number()),
})
export type BaselineComparison = z.infer<typeof BaselineComparisonSchema>

export const BenchReportSchema = z.object({
  generatedAt: z.string().min(1),
  repo: z.string().min(1),
  agentModel: z.string().min(1),
  judgeModel: z.string().nullable(),
  reps: z.number().int().min(1),
  arms: z.object({
    with: ArmSummarySchema,
    without: ArmSummarySchema,
  }),
  comparisons: z.array(JudgeVerdictSchema),
  grades: z.array(ObjectiveGradeSchema),
  baseline: BaselineComparisonSchema.nullable(),
})
export type BenchReport = z.infer<typeof BenchReportSchema>
