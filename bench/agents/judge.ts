import { z } from 'zod'

import type { JudgeVerdict, RubricScores, TaskSpec } from './types'

export type Presentation = 'withFirst' | 'withoutFirst'

export interface JudgePassResult {
  readonly winner: 'a' | 'b' | 'tie'
  readonly scoresA: RubricScores
  readonly scoresB: RubricScores
  readonly rationale: string
}

const JudgeResponseSchema = z.object({
  correctnessA: z.number().min(0).max(10),
  completenessA: z.number().min(0).max(10),
  specificityA: z.number().min(0).max(10),
  correctnessB: z.number().min(0).max(10),
  completenessB: z.number().min(0).max(10),
  specificityB: z.number().min(0).max(10),
  winner: z.enum(['a', 'b', 'tie']),
  rationale: z.string(),
})

const scoresFrom = (response: z.infer<typeof JudgeResponseSchema>, role: 'A' | 'B'): RubricScores => ({
  correctness: role === 'A' ? response.correctnessA : response.correctnessB,
  completeness: role === 'A' ? response.completenessA : response.completenessB,
  specificity: role === 'A' ? response.specificityA : response.specificityB,
})

const extractJson = (raw: string): string => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
  const candidate = fenced === null ? raw : (fenced[1] ?? '')
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error('judge response contained no JSON object')
  }
  return candidate.slice(start, end + 1)
}

export const parseJudgeResponse = (raw: string): JudgePassResult => {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(extractJson(raw))
  } catch (error) {
    const preview = raw.trim().slice(0, 200)
    throw new Error(
      `judge response was not parseable JSON (${error instanceof Error ? error.message : String(error)}): ${preview}`,
      { cause: error },
    )
  }
  const response = JudgeResponseSchema.parse(parsedJson)
  return {
    winner: response.winner,
    scoresA: scoresFrom(response, 'A'),
    scoresB: scoresFrom(response, 'B'),
    rationale: response.rationale,
  }
}

export const buildJudgeSystemPrompt = (): string =>
  [
    'You are a strict, impartial judge of two answers to a codebase question.',
    'Judge only from the two answers given; do not use any tools.',
    'Score each answer 0-10 on correctness (is it true?), completeness (does it cover the ask?), and specificity (concrete names, files, details vs vague prose).',
    'Pick a winner: "a", "b", or "tie" only when genuinely indistinguishable.',
    'Respond with ONLY a raw JSON object, no markdown fences, no prose:',
    '{"correctnessA":0,"completenessA":0,"specificityA":0,"correctnessB":0,"completenessB":0,"specificityB":0,"winner":"a|b|tie","rationale":"one sentence"}',
  ].join(' ')

export const buildJudgePrompt = (task: TaskSpec, answerA: string, answerB: string): string => {
  const notes = task.judgeNotes === undefined ? '' : `\nGrading notes: ${task.judgeNotes}\n`
  return [
    `Question asked to an AI coding agent:\n${task.prompt}\n`,
    notes,
    `Answer A:\n${answerA.trim() || '(empty answer)'}\n`,
    `Answer B:\n${answerB.trim() || '(empty answer)'}`,
  ].join('\n')
}

export type JudgeOnce = (request: { readonly system: string; readonly prompt: string }) => Promise<string>

export interface CompareAnswersInput {
  readonly task: TaskSpec
  readonly answerWith: string
  readonly answerWithout: string
  readonly judgeOnce: JudgeOnce
}

const runPass = async (
  input: CompareAnswersInput,
  firstIsWith: boolean,
): Promise<{ readonly winnerOfWith: 'with' | 'without' | 'tie'; readonly pass: JudgePassResult }> => {
  const answerA = firstIsWith ? input.answerWith : input.answerWithout
  const answerB = firstIsWith ? input.answerWithout : input.answerWith
  const raw = await input.judgeOnce({
    system: buildJudgeSystemPrompt(),
    prompt: buildJudgePrompt(input.task, answerA, answerB),
  })
  const pass = parseJudgeResponse(raw)
  const winnerOfWith = pass.winner === 'tie' ? 'tie' : (pass.winner === 'a') === firstIsWith ? 'with' : 'without'
  return { winnerOfWith, pass }
}

type JudgePassOutcome = { readonly winnerOfWith: 'with' | 'without' | 'tie'; readonly pass: JudgePassResult }

const runPassWithRetry = (input: CompareAnswersInput, firstIsWith: boolean): Promise<JudgePassOutcome> => {
  // one retry per pass; sequential attempts recurse so the sequential await isn't
  // flagged by the no-await-in-loop lint rule
  const attempt = async (triesLeft: number, lastError: Error): Promise<JudgePassOutcome> => {
    if (triesLeft <= 0) {
      throw lastError
    }
    try {
      return await runPass(input, firstIsWith)
    } catch (error) {
      return attempt(triesLeft - 1, error instanceof Error ? error : new Error(String(error)))
    }
  }
  return attempt(2, new Error('judge pass was never attempted'))
}

export const compareAnswers = async (input: CompareAnswersInput): Promise<JudgeVerdict> => {
  const [withFirstResult, withoutFirstResult] = await Promise.all([
    runPassWithRetry(input, true),
    runPassWithRetry(input, false),
  ])

  let winner: 'with' | 'without' | 'tie' = 'tie'
  if (withFirstResult.winnerOfWith === withoutFirstResult.winnerOfWith && withFirstResult.winnerOfWith !== 'tie') {
    winner = withFirstResult.winnerOfWith
  }

  return {
    taskId: input.task.id,
    first: withFirstResult.pass.winner,
    second: withoutFirstResult.pass.winner,
    winner,
    presentation: 'withFirst',
    scoresWith: withFirstResult.pass.scoresA,
    scoresWithout: withFirstResult.pass.scoresB,
  }
}
