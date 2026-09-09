import { describe, expect, test } from 'bun:test'

import { buildReport, judgeTally, summarizeArm } from '../../bench/agents/report'
import type { JudgeVerdict, ObjectiveGrade, RunRecord, TokenUsage } from '../../bench/agents/types'

const tokens = (input: number, output: number): TokenUsage => ({
  input,
  output,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
})

const record = (overrides: Partial<RunRecord>): RunRecord => ({
  taskId: 'locate-openDatabase',
  arm: 'with',
  rep: 0,
  sessionId: 'ses',
  agentModel: 'm/m',
  prompt: 'p',
  answer: 'a',
  tokens: tokens(100, 50),
  cost: 0.01,
  toolCalls: [{ tool: 'grep', status: 'completed' }],
  wallTimeMs: 1000,
  compacted: false,
  finishedAt: '2026-09-09T12:00:00.000Z',
  ...overrides,
})

const grade = (overrides: Partial<ObjectiveGrade>): ObjectiveGrade => ({
  taskId: 'locate-openDatabase',
  arm: 'with',
  rep: 0,
  pass: true,
  hallucinated: false,
  expected: ['openDatabase'],
  namedSymbols: [],
  ...overrides,
})

const verdict = (winner: 'with' | 'without' | 'tie'): JudgeVerdict => ({
  taskId: 'map-storage',
  first: 'a',
  second: 'a',
  winner,
  presentation: 'withFirst',
  scoresWith: { correctness: 8, completeness: 7, specificity: 9 },
  scoresWithout: { correctness: 5, completeness: 5, specificity: 4 },
})

describe('summarizeArm', () => {
  test('computes means and medians for tokens, cost, wall time', () => {
    const records = [
      record({ tokens: tokens(100, 50), cost: 0.01, wallTimeMs: 1000 }),
      record({ tokens: tokens(300, 70), cost: 0.03, wallTimeMs: 3000 }),
      record({ tokens: tokens(200, 60), cost: 0.02, wallTimeMs: 2000 }),
    ]
    const summary = summarizeArm(records, [])
    expect(summary.runs).toBe(3)
    expect(summary.meanTokens.input).toBe(200)
    expect(summary.medianTokens.input).toBe(200)
    expect(summary.meanCost).toBeCloseTo(0.02, 6)
    expect(summary.medianWallTimeMs).toBe(2000)
  })

  test('median with even count averages middle values', () => {
    const records = [record({ wallTimeMs: 1000 }), record({ wallTimeMs: 3000 })]
    expect(summarizeArm(records, []).medianWallTimeMs).toBe(2000)
  })

  test('counts tool calls by name across records', () => {
    const records = [
      record({
        toolCalls: [
          { tool: 'grep', status: 'completed' },
          { tool: 'codeindex_code_search', status: 'completed' },
        ],
      }),
      record({ toolCalls: [{ tool: 'grep', status: 'completed' }] }),
    ]
    expect(summarizeArm(records, []).toolCallCounts).toEqual({ grep: 2, codeindex_code_search: 1 })
  })

  test('pass rate and hallucination rate from grades', () => {
    const grades = [grade({ pass: true, hallucinated: false }), grade({ pass: false, hallucinated: true })]
    const summary = summarizeArm([record({}), record({})], grades)
    expect(summary.objectivePassRate).toBeCloseTo(0.5, 6)
    expect(summary.hallucinationRate).toBeCloseTo(0.5, 6)
  })

  test('empty arm yields zeroed summary', () => {
    const summary = summarizeArm([], [])
    expect(summary.runs).toBe(0)
    expect(summary.meanTokens.input).toBe(0)
    expect(summary.objectivePassRate).toBe(0)
  })
})

describe('judgeTally', () => {
  test('counts wins and ties', () => {
    expect(judgeTally([verdict('with'), verdict('with'), verdict('tie'), verdict('without')])).toEqual({
      with: 2,
      without: 1,
      tie: 1,
    })
  })
})

describe('buildReport', () => {
  test('assembles a schema-valid report', () => {
    const report = buildReport({
      generatedAt: '2026-09-09T12:00:00.000Z',
      repo: '/repo',
      agentModel: 'm/m',
      judgeModel: 'j/j',
      reps: 1,
      records: [record({ arm: 'with' }), record({ arm: 'without' })],
      grades: [grade({}), grade({ arm: 'without', pass: false })],
      comparisons: [verdict('with')],
      baseline: null,
    })
    expect(report.arms.with.runs).toBe(1)
    expect(report.arms.without.runs).toBe(1)
    expect(report.judgeModel).toBe('j/j')
  })

  test('computes deltas against baseline', () => {
    const baseline = {
      generatedAt: '2026-09-01T00:00:00.000Z',
      repo: '/repo',
      repoHead: 'abc',
      agentModel: 'm/m',
      reps: 1,
      arms: {
        with: summarizeArm([record({ tokens: tokens(100, 50), wallTimeMs: 1000 })], [grade({})]),
        without: summarizeArm(
          [record({ arm: 'without', tokens: tokens(400, 90), wallTimeMs: 4000 })],
          [grade({ arm: 'without', pass: false })],
        ),
      },
      judge: { with: 1, without: 0, tie: 0 },
    }
    const report = buildReport({
      generatedAt: '2026-09-09T12:00:00.000Z',
      repo: '/repo',
      agentModel: 'm/m',
      judgeModel: null,
      reps: 1,
      records: [record({ tokens: tokens(80, 40), wallTimeMs: 900 })],
      grades: [grade({})],
      comparisons: [],
      baseline: { path: 'bench/agents/baseline.json', data: baseline },
    })
    expect(report.baseline?.deltas['arms.with.tokens.input.mean']).toBeCloseTo(-20, 6)
    expect(report.baseline?.deltas['arms.with.wallTimeMs.mean']).toBeCloseTo(-100, 6)
    // no without records this run
    expect(report.baseline?.deltas['arms.without.tokens.input.mean']).toBeUndefined()
  })
})
