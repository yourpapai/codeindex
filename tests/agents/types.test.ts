import { describe, expect, test } from 'bun:test'

import {
  BenchReportSchema,
  JudgeVerdictSchema,
  ObjectiveGradeSchema,
  RunRecordSchema,
  TaskSpecSchema,
  TokenUsageSchema,
  ToolCallSchema,
} from '../../bench/agents/types'

const validTokens = {
  input: 100,
  output: 50,
  reasoning: 10,
  cacheRead: 200,
  cacheWrite: 20,
}

const validRunRecord = {
  taskId: 'locate-openDatabase',
  arm: 'with',
  rep: 0,
  sessionId: 'ses_123',
  agentModel: 'opencode-go/glm-5.3-flash',
  prompt: 'Where is openDatabase implemented?',
  answer: 'It is in src/storage/db.ts.',
  tokens: validTokens,
  cost: 0.01,
  toolCalls: [{ tool: 'codeindex_code_search', status: 'completed' }],
  wallTimeMs: 4200,
  compacted: false,
  finishedAt: '2026-09-09T12:00:00.000Z',
}

describe('TaskSpecSchema', () => {
  test('accepts a ground-truth task', () => {
    const parsed = TaskSpecSchema.parse({
      id: 'locate-openDatabase',
      kind: 'locate',
      prompt: 'Where is openDatabase implemented?',
      groundTruth: { expected: ['openDatabase'] },
    })
    expect(parsed.kind).toBe('locate')
  })

  test('accepts a subjective task without ground truth', () => {
    const parsed = TaskSpecSchema.parse({
      id: 'map-storage',
      kind: 'map',
      prompt: 'Summarize the storage layer.',
      judgeNotes: 'Check it names the SQLite WAL setup.',
    })
    expect(parsed.groundTruth).toBeUndefined()
  })

  test('rejects unknown kind', () => {
    expect(() => TaskSpecSchema.parse({ id: 'x', kind: 'vibes', prompt: 'p' })).toThrow()
  })

  test('rejects empty prompt', () => {
    expect(() => TaskSpecSchema.parse({ id: 'x', kind: 'map', prompt: '' })).toThrow()
  })
})

describe('RunRecordSchema', () => {
  test('accepts a complete record', () => {
    const parsed = RunRecordSchema.parse(validRunRecord)
    expect(parsed.arm).toBe('with')
    expect(parsed.tokens.input).toBe(100)
  })

  test('rejects unknown arm', () => {
    expect(() => RunRecordSchema.parse({ ...validRunRecord, arm: 'maybe' })).toThrow()
  })

  test('rejects negative wall time', () => {
    expect(() => RunRecordSchema.parse({ ...validRunRecord, wallTimeMs: -1 })).toThrow()
  })

  test('rejects negative token counts', () => {
    expect(() =>
      RunRecordSchema.parse({
        ...validRunRecord,
        tokens: { ...validTokens, input: -5 },
      }),
    ).toThrow()
  })

  test('rejects negative rep', () => {
    expect(() => RunRecordSchema.parse({ ...validRunRecord, rep: -1 })).toThrow()
  })

  test('rejects negative cost', () => {
    expect(() => RunRecordSchema.parse({ ...validRunRecord, cost: -0.1 })).toThrow()
  })
})

describe('TokenUsageSchema and ToolCallSchema', () => {
  test('tokens require all five kinds', () => {
    expect(() => TokenUsageSchema.parse({ input: 1, output: 1, reasoning: 0, cacheRead: 0 })).toThrow()
  })

  test('tool call requires name and status', () => {
    const parsed = ToolCallSchema.parse({ tool: 'grep', status: 'error' })
    expect(parsed.tool).toBe('grep')
    expect(parsed.status).toBe('error')
  })

  test('tool call rejects unknown status', () => {
    expect(() => ToolCallSchema.parse({ tool: 'grep', status: 'finished' })).toThrow()
  })
})

describe('JudgeVerdictSchema', () => {
  const scores = { correctness: 8, completeness: 7, specificity: 9 }

  test('consistent winner resolves to an arm', () => {
    const parsed = JudgeVerdictSchema.parse({
      taskId: 'map-storage',
      first: 'a',
      second: 'a',
      winner: 'with',
      presentation: 'withFirst',
      scoresWith: scores,
      scoresWithout: scores,
    })
    expect(parsed.winner).toBe('with')
  })

  test('tie is a valid outcome', () => {
    const parsed = JudgeVerdictSchema.parse({
      taskId: 'map-storage',
      first: 'a',
      second: 'b',
      winner: 'tie',
      presentation: 'withFirst',
      scoresWith: scores,
      scoresWithout: scores,
    })
    expect(parsed.winner).toBe('tie')
  })

  test('rejects unknown winner', () => {
    expect(() =>
      JudgeVerdictSchema.parse({
        taskId: 'x',
        first: 'a',
        second: 'a',
        winner: 'both',
        presentation: 'withFirst',
        scoresWith: scores,
        scoresWithout: scores,
      }),
    ).toThrow()
  })

  test('rejects out-of-range rubric scores', () => {
    expect(() =>
      JudgeVerdictSchema.parse({
        taskId: 'x',
        first: 'a',
        second: 'a',
        winner: 'tie',
        presentation: 'withFirst',
        scoresWith: { correctness: 11, completeness: 5, specificity: 5 },
        scoresWithout: scores,
      }),
    ).toThrow()
  })
})

describe('ObjectiveGradeSchema', () => {
  test('accepts a passing grade', () => {
    const parsed = ObjectiveGradeSchema.parse({
      taskId: 'locate-openDatabase',
      arm: 'with',
      rep: 0,
      pass: true,
      hallucinated: false,
      expected: ['openDatabase'],
      namedSymbols: ['openDatabase', 'Database'],
    })
    expect(parsed.pass).toBe(true)
  })

  test('requires arm and rep to link back to the run record', () => {
    expect(() =>
      ObjectiveGradeSchema.parse({
        taskId: 'x',
        pass: true,
        hallucinated: false,
        expected: [],
        namedSymbols: [],
      }),
    ).toThrow()
  })
})

describe('BenchReportSchema', () => {
  test('accepts an aggregated report with baseline deltas', () => {
    const parsed = BenchReportSchema.parse({
      generatedAt: '2026-09-09T12:00:00.000Z',
      repo: '/repo',
      agentModel: 'opencode-go/glm-5.3-flash',
      judgeModel: 'opencode-go/glm-5.3',
      reps: 3,
      arms: {
        with: {
          runs: 3,
          meanTokens: validTokens,
          medianTokens: validTokens,
          meanCost: 0.01,
          medianWallTimeMs: 4200,
          meanWallTimeMs: 4300,
          toolCallCounts: { codeindex_code_search: 9, grep: 1 },
          objectivePassRate: 1,
          hallucinationRate: 0,
        },
        without: {
          runs: 3,
          meanTokens: validTokens,
          medianTokens: validTokens,
          meanCost: 0.02,
          medianWallTimeMs: 5200,
          meanWallTimeMs: 5300,
          toolCallCounts: { grep: 12, read: 4 },
          objectivePassRate: 0.5,
          hallucinationRate: 0.1,
        },
      },
      comparisons: [],
      grades: [],
      baseline: null,
    })
    expect(parsed.arms.with.runs).toBe(3)
  })

  test('requires exactly the two arms', () => {
    expect(() =>
      BenchReportSchema.parse({
        generatedAt: '2026-09-09T12:00:00.000Z',
        repo: '/repo',
        agentModel: 'm',
        judgeModel: null,
        reps: 3,
        arms: {},
        comparisons: [],
        grades: [],
        baseline: null,
      }),
    ).toThrow()
  })
})
