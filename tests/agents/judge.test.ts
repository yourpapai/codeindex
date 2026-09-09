import { describe, expect, test } from 'bun:test'

import { buildJudgePrompt, buildJudgeSystemPrompt, compareAnswers, parseJudgeResponse } from '../../bench/agents/judge'
import type { TaskSpec } from '../../bench/agents/types'

const task: TaskSpec = {
  id: 'map-storage',
  kind: 'map',
  prompt: 'Map the storage layer.',
  judgeNotes: 'Names real modules.',
}

const goodAnswerJson = (winner: string): string =>
  JSON.stringify({
    correctnessA: 8,
    completenessA: 7,
    specificityA: 9,
    correctnessB: 5,
    completenessB: 5,
    specificityB: 4,
    winner,
    rationale: 'A is specific.',
  })

describe('parseJudgeResponse', () => {
  test('parses plain JSON', () => {
    const parsed = parseJudgeResponse(goodAnswerJson('a'))
    expect(parsed.winner).toBe('a')
    expect(parsed.scoresA.correctness).toBe(8)
  })

  test('parses JSON inside markdown fences', () => {
    const parsed = parseJudgeResponse('```json\n' + goodAnswerJson('tie') + '\n```')
    expect(parsed.winner).toBe('tie')
  })

  test('parses JSON with surrounding prose', () => {
    const parsed = parseJudgeResponse('Here is my judgment:\n' + goodAnswerJson('b') + '\nDone.')
    expect(parsed.winner).toBe('b')
  })

  test('rejects invalid winner values', () => {
    expect(() => parseJudgeResponse(goodAnswerJson('both'))).toThrow()
  })

  test('rejects responses without JSON', () => {
    expect(() => parseJudgeResponse('I cannot decide.')).toThrow()
  })
})

describe('buildJudgePrompt', () => {
  test('presents answers blind with A/B labels', () => {
    const prompt = buildJudgePrompt(task, 'answer one', 'answer two')
    expect(prompt).toContain('Answer A:')
    expect(prompt).toContain('Answer B:')
    expect(prompt).toContain('answer one')
    expect(prompt).toContain('answer two')
    expect(prompt).not.toContain('with-arm')
    expect(prompt).not.toContain('without')
  })

  test('includes judge notes when present', () => {
    const prompt = buildJudgePrompt(task, 'a1', 'a2')
    expect(prompt).toContain('Names real modules.')
  })

  test('system prompt forbids tool use and demands raw JSON', () => {
    const system = buildJudgeSystemPrompt()
    expect(system).toContain('do not use any tools')
    expect(system).toContain('JSON')
  })
})

describe('compareAnswers', () => {
  const judgeOnceFrom = (firstResponse: string, secondResponse: string) => {
    let call = 0
    return (): Promise<string> => {
      const response = call === 0 ? firstResponse : secondResponse
      call += 1
      return Promise.resolve(response)
    }
  }

  test('consistent winner maps to the winning arm across swapped presentations', async () => {
    // pass 1 (with first): judge picks a (= with); pass 2 (without first): judge picks b (= with)
    const verdict = await compareAnswers({
      task,
      answerWith: 'good answer',
      answerWithout: 'weak answer',
      judgeOnce: judgeOnceFrom(goodAnswerJson('a'), goodAnswerJson('b')),
    })
    expect(verdict.winner).toBe('with')
    expect(verdict.first).toBe('a')
    expect(verdict.second).toBe('b')
  })

  test('disagreement after swap becomes a tie', async () => {
    const verdict = await compareAnswers({
      task,
      answerWith: 'x',
      answerWithout: 'y',
      judgeOnce: judgeOnceFrom(goodAnswerJson('a'), goodAnswerJson('a')),
    })
    expect(verdict.winner).toBe('tie')
  })

  test('scores are mapped back to arms regardless of presentation order', async () => {
    const verdict = await compareAnswers({
      task,
      answerWith: 'x',
      answerWithout: 'y',
      judgeOnce: judgeOnceFrom(goodAnswerJson('a'), goodAnswerJson('b')),
    })
    expect(verdict.presentation).toBe('withFirst')
    expect(verdict.scoresWith.specificity).toBe(9)
    expect(verdict.scoresWithout.specificity).toBe(4)
  })

  test('without arm winning both swapped presentations maps to without', async () => {
    // pass 1: picks b (= without); pass 2 (swapped): picks a (= without)
    const verdict = await compareAnswers({
      task,
      answerWith: 'x',
      answerWithout: 'y',
      judgeOnce: judgeOnceFrom(goodAnswerJson('b'), goodAnswerJson('a')),
    })
    expect(verdict.winner).toBe('without')
    expect(verdict.first).toBe('b')
    expect(verdict.second).toBe('a')
  })
})
