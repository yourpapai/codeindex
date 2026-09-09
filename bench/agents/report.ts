import { z } from 'zod'

import {
  ArmSummarySchema,
  BenchReportSchema,
  type ArmSummary,
  type BenchReport,
  type JudgeVerdict,
  type ObjectiveGrade,
  type RunRecord,
  type TokenUsage,
} from './types'

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

const mean = (values: readonly number[]): number => (values.length === 0 ? 0 : sum(values) / values.length)

const median = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const lower = sorted[middle - 1]
  const upper = sorted[middle]
  if (sorted.length % 2 === 1 || lower === undefined || upper === undefined) {
    return sorted[middle] ?? 0
  }
  return (lower + upper) / 2
}

export const summarizeArm = (records: readonly RunRecord[], grades: readonly ObjectiveGrade[]): ArmSummary => {
  const toolCallCounts: Record<string, number> = {}
  for (const record of records) {
    for (const call of record.toolCalls) {
      toolCallCounts[call.tool] = (toolCallCounts[call.tool] ?? 0) + 1
    }
  }
  const arm = records[0]?.arm ?? 'with'
  const armGrades = grades.filter((entry) => entry.arm === arm)

  const meanTokens: TokenUsage = {
    input: mean(records.map((record) => record.tokens.input)),
    output: mean(records.map((record) => record.tokens.output)),
    reasoning: mean(records.map((record) => record.tokens.reasoning)),
    cacheRead: mean(records.map((record) => record.tokens.cacheRead)),
    cacheWrite: mean(records.map((record) => record.tokens.cacheWrite)),
  }

  return ArmSummarySchema.parse({
    runs: records.length,
    meanTokens,
    medianTokens: {
      input: median(records.map((record) => record.tokens.input)),
      output: median(records.map((record) => record.tokens.output)),
      reasoning: median(records.map((record) => record.tokens.reasoning)),
      cacheRead: median(records.map((record) => record.tokens.cacheRead)),
      cacheWrite: median(records.map((record) => record.tokens.cacheWrite)),
    },
    meanCost: mean(records.map((record) => record.cost)),
    meanWallTimeMs: mean(records.map((record) => record.wallTimeMs)),
    medianWallTimeMs: median(records.map((record) => record.wallTimeMs)),
    toolCallCounts,
    objectivePassRate: armGrades.length === 0 ? 0 : armGrades.filter((entry) => entry.pass).length / armGrades.length,
    hallucinationRate:
      armGrades.length === 0 ? 0 : armGrades.filter((entry) => entry.hallucinated).length / armGrades.length,
  })
}

export const judgeTally = (
  comparisons: readonly JudgeVerdict[],
): { readonly with: number; readonly without: number; readonly tie: number } => ({
  with: comparisons.filter((verdict) => verdict.winner === 'with').length,
  without: comparisons.filter((verdict) => verdict.winner === 'without').length,
  tie: comparisons.filter((verdict) => verdict.winner === 'tie').length,
})

const BaselineFileSchema = z.object({
  generatedAt: z.string(),
  repo: z.string(),
  repoHead: z.string().nullable(),
  agentModel: z.string(),
  reps: z.number().int().min(1),
  arms: z.object({ with: ArmSummarySchema, without: ArmSummarySchema }),
  judge: z.object({ with: z.number(), without: z.number(), tie: z.number() }),
})

export type BaselineFile = z.infer<typeof BaselineFileSchema>

export interface BuildReportInput {
  readonly generatedAt: string
  readonly repo: string
  readonly agentModel: string
  readonly judgeModel: string | null
  readonly reps: number
  readonly records: readonly RunRecord[]
  readonly grades: readonly ObjectiveGrade[]
  readonly comparisons: readonly JudgeVerdict[]
  readonly baseline: { readonly path: string; readonly data: unknown } | null
}

const DELTA_SPECS: readonly { readonly key: string; readonly pick: (arm: ArmSummary) => number }[] = [
  { key: 'tokens.input.mean', pick: (arm) => arm.meanTokens.input },
  { key: 'tokens.output.mean', pick: (arm) => arm.meanTokens.output },
  { key: 'tokens.reasoning.mean', pick: (arm) => arm.meanTokens.reasoning },
  { key: 'tokens.cacheRead.mean', pick: (arm) => arm.meanTokens.cacheRead },
  { key: 'tokens.cacheWrite.mean', pick: (arm) => arm.meanTokens.cacheWrite },
  { key: 'cost.mean', pick: (arm) => arm.meanCost },
  { key: 'wallTimeMs.mean', pick: (arm) => arm.meanWallTimeMs },
  { key: 'wallTimeMs.median', pick: (arm) => arm.medianWallTimeMs },
  { key: 'passRate', pick: (arm) => arm.objectivePassRate },
  { key: 'hallucinationRate', pick: (arm) => arm.hallucinationRate },
]

const buildDeltas = (
  current: { with: ArmSummary; without: ArmSummary },
  baseline: BaselineFile,
): Record<string, number> => {
  const deltas: Record<string, number> = {}
  for (const arm of ['with', 'without'] as const) {
    if (current[arm].runs === 0) {
      continue
    }
    for (const spec of DELTA_SPECS) {
      deltas[`arms.${arm}.${spec.key}`] = spec.pick(current[arm]) - spec.pick(baseline.arms[arm])
    }
  }
  return deltas
}

export const buildReport = (input: BuildReportInput): BenchReport => {
  const arms = {
    with: summarizeArm(
      input.records.filter((record) => record.arm === 'with'),
      input.grades,
    ),
    without: summarizeArm(
      input.records.filter((record) => record.arm === 'without'),
      input.grades,
    ),
  }

  let baseline: BenchReport['baseline'] = null
  if (input.baseline !== null && input.baseline.data !== null) {
    const parsed = BaselineFileSchema.safeParse(input.baseline.data)
    if (parsed.success) {
      baseline = { path: input.baseline.path, deltas: buildDeltas(arms, parsed.data) }
    }
  }

  return BenchReportSchema.parse({
    generatedAt: input.generatedAt,
    repo: input.repo,
    agentModel: input.agentModel,
    judgeModel: input.judgeModel,
    reps: input.reps,
    arms,
    comparisons: input.comparisons,
    grades: input.grades,
    baseline,
  })
}

export const formatReportText = (report: BenchReport): string => {
  const lines: string[] = []
  lines.push(`agent benchmark — ${report.repo}`)
  lines.push(`agent model: ${report.agentModel}  judge: ${report.judgeModel ?? 'none'}  reps: ${report.reps}`)
  for (const arm of ['with', 'without'] as const) {
    const armSummary = report.arms[arm]
    lines.push(
      `${arm}: runs=${armSummary.runs} tokens(in/out)=${Math.round(armSummary.meanTokens.input)}/${Math.round(armSummary.meanTokens.output)} ` +
        `cost=$${armSummary.meanCost.toFixed(4)} wall=${Math.round(armSummary.medianWallTimeMs)}ms(med) ` +
        `pass=${(armSummary.objectivePassRate * 100).toFixed(0)}% halluc=${(armSummary.hallucinationRate * 100).toFixed(0)}%`,
    )
    lines.push(`  tools: ${JSON.stringify(armSummary.toolCallCounts)}`)
  }
  const tally = judgeTally(report.comparisons)
  lines.push(`judge: with=${tally.with} without=${tally.without} tie=${tally.tie}`)
  if (report.baseline !== null) {
    lines.push(`baseline deltas (${report.baseline.path}):`)
    for (const [key, delta] of Object.entries(report.baseline.deltas)) {
      lines.push(`  ${key}: ${delta >= 0 ? '+' : ''}${Math.round(delta * 100) / 100}`)
    }
  }
  return lines.join('\n')
}
