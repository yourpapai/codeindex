import path from 'node:path'

import type { OpencodeClient } from '@opencode-ai/sdk'

import { openDatabase } from '../../src/storage/db.js'
import type { ModelRef } from './args'
import { gradeAnswer } from './grade'
import { compareAnswers, type JudgeOnce } from './judge'
import { textFromParts, withTimeout } from './session-run'
import type { JudgeVerdict, ObjectiveGrade, RunRecord, TaskSpec } from './types'

export const SUBJECTIVE_KINDS: ReadonlySet<TaskSpec['kind']> = new Set(['explain', 'review', 'map'])

export const makeJudgeOnce =
  (client: OpencodeClient, directory: string, judgeModel: ModelRef, turnTimeoutMs: number): JudgeOnce =>
  async ({ system, prompt }) => {
    const created = await client.session.create({ query: { directory } })
    if (created.data === undefined) {
      throw new Error(`judge session creation failed: ${JSON.stringify(created.error)}`)
    }
    const result = await withTimeout(
      client.session.prompt({
        path: { id: created.data.id },
        body: {
          model: { providerID: judgeModel.providerID, modelID: judgeModel.modelID },
          system,
          parts: [{ type: 'text', text: prompt }],
        },
      }),
      turnTimeoutMs,
      'judge prompt',
    )
    if (result.data === undefined) {
      throw new Error(`judge prompt failed: ${JSON.stringify(result.error)}`)
    }
    return textFromParts(result.data.parts)
  }

export const gradeRecords = (
  records: readonly RunRecord[],
  tasks: readonly TaskSpec[],
  dbPath: string,
): readonly ObjectiveGrade[] => {
  const expectedByTask = new Map(
    tasks.filter((task) => task.groundTruth !== undefined).map((task) => [task.id, task.groundTruth?.expected ?? []]),
  )
  if (expectedByTask.size === 0) {
    return []
  }
  const db = openDatabase(dbPath)
  try {
    const grades: ObjectiveGrade[] = []
    for (const record of records) {
      const expected = expectedByTask.get(record.taskId)
      if (expected === undefined) {
        continue
      }
      grades.push(gradeAnswer({ record, expected, db }))
    }
    return grades
  } finally {
    db.close()
  }
}

const judgeRemaining = async (
  remaining: readonly TaskSpec[],
  options: {
    readonly records: readonly RunRecord[]
    readonly judgeOnce: JudgeOnce
    readonly collected: JudgeVerdict[]
  },
): Promise<readonly JudgeVerdict[]> => {
  const [head, ...tail] = remaining
  if (head === undefined) {
    return options.collected
  }
  const withAnswer = options.records.find((record) => record.taskId === head.id && record.arm === 'with')?.answer ?? ''
  const withoutAnswer =
    options.records.find((record) => record.taskId === head.id && record.arm === 'without')?.answer ?? ''
  try {
    options.collected.push(
      await compareAnswers({
        task: head,
        answerWith: withAnswer,
        answerWithout: withoutAnswer,
        judgeOnce: options.judgeOnce,
      }),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`WARNING: judge failed for ${head.id}, skipping comparison: ${message}\n`)
  }
  return judgeRemaining(tail, options)
}

export const judgeSubjectiveTasks = (options: {
  readonly tasks: readonly TaskSpec[]
  readonly records: readonly RunRecord[]
  readonly judgeOnce: JudgeOnce
}): Promise<readonly JudgeVerdict[]> => {
  const ranTaskIds = new Set(options.records.map((record) => record.taskId))
  const subjectiveRanTasks = options.tasks.filter((task) => SUBJECTIVE_KINDS.has(task.kind) && ranTaskIds.has(task.id))
  return judgeRemaining(subjectiveRanTasks, { records: options.records, judgeOnce: options.judgeOnce, collected: [] })
}

export const gradeDbPath = (repo: string): string => path.join(repo, '.codeindex/index.db')
