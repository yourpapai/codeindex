import type { Database } from 'bun:sqlite'

import type { ObjectiveGrade, RunRecord } from './types'

const IDENTIFIER_PATTERN = /[A-Za-z_$][A-Za-z0-9_$]*/g

const hasCaseTransition = (identifier: string): boolean => {
  for (let index = 1; index < identifier.length; index += 1) {
    const previous = identifier[index - 1]
    const current = identifier[index]
    if (
      previous !== undefined &&
      current !== undefined &&
      previous >= 'a' &&
      previous <= 'z' &&
      current >= 'A' &&
      current <= 'Z'
    ) {
      return true
    }
  }
  return identifier.length > 1 && identifier[0] !== undefined && identifier[0] >= 'A' && identifier[0] <= 'Z'
}

export const extractNamedSymbols = (answer: string): readonly string[] => {
  const backtickSegments = [...answer.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '')
  const candidates = new Set<string>()
  for (const segment of backtickSegments) {
    for (const match of segment.matchAll(IDENTIFIER_PATTERN)) {
      const identifier = match[0]
      if (identifier !== undefined && hasCaseTransition(identifier)) {
        candidates.add(identifier)
      }
    }
  }
  for (const match of answer.matchAll(/(?:function|const|class|method)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    const identifier = match[1]
    if (identifier !== undefined) {
      candidates.add(identifier)
    }
  }
  return [...candidates]
}

const symbolExists = (db: Database, candidate: string): boolean => {
  const row = db
    .query<unknown, [string, string, string]>(
      'SELECT 1 FROM symbols WHERE local_name = ? OR qualified_name = ? OR qualified_name LIKE ? LIMIT 1',
    )
    .get(candidate, candidate, `%#${candidate}`)
  return row !== null && row !== undefined
}

export interface GradeInput {
  readonly record: RunRecord
  readonly expected: readonly string[]
  readonly db: Database
}

export const gradeAnswer = (input: GradeInput): ObjectiveGrade => {
  const namedSymbols = extractNamedSymbols(input.record.answer)
  const hallucinatedSymbols = namedSymbols.filter((symbol) => !symbolExists(input.db, symbol))
  const pass =
    input.expected.length > 0 &&
    input.expected.every((symbol) => input.record.answer.includes(symbol)) &&
    hallucinatedSymbols.length === 0
  return {
    taskId: input.record.taskId,
    arm: input.record.arm,
    rep: input.record.rep,
    pass,
    hallucinated: hallucinatedSymbols.length > 0,
    expected: [...input.expected],
    namedSymbols: [...namedSymbols],
  }
}
