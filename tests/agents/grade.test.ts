import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { gradeAnswer } from '../../bench/agents/grade'
import type { RunRecord } from '../../bench/agents/types'
import { openDatabase } from '../../src/storage/db'
import { ensureSchema } from '../../src/storage/schema'

const makeDb = (): { db: ReturnType<typeof openDatabase>; cleanup: () => void } => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-bench-grade-'))
  const db = openDatabase(path.join(dir, 'index.db'))
  ensureSchema(db)
  db.run(
    `INSERT INTO files (file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at)
     VALUES ('src/storage/db.ts', 'src/storage/db', 'ts', 'h', 'ok', NULL, 1)`,
  )
  const fileId = db.query<{ id: number }, []>('SELECT id FROM files').get()?.id ?? 0
  db.run(
    `INSERT INTO symbols (file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier,
      parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line, in_degree)
     VALUES (?, 'src/storage/db.ts', 'src/storage/db', 'src/storage/db#openDatabase', 'openDatabase', 'src/storage/db#openDatabase',
       'function', 'exported', NULL, '["openDatabase"]', '', '', '', 'openDatabase', 1, 5, 0)`,
    [fileId],
  )
  db.run(
    `INSERT INTO symbols (file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier,
      parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line, in_degree)
     VALUES (?, 'src/storage/db.ts', 'src/storage/db', 'src/storage/db#Database', 'Database', 'src/storage/db#Database',
       'class', 'exported', NULL, '["Database"]', '', '', '', 'Database', 7, 9, 0)`,
    [fileId],
  )
  return {
    db,
    cleanup: () => {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const recordWithAnswer = (answer: string): RunRecord => ({
  taskId: 'locate-openDatabase',
  arm: 'with',
  rep: 0,
  sessionId: 'ses_1',
  agentModel: 'm/m',
  prompt: 'p',
  answer,
  tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  cost: 0,
  toolCalls: [],
  wallTimeMs: 1,
  compacted: false,
  finishedAt: '2026-09-09T12:00:00.000Z',
})

describe('gradeAnswer', () => {
  test('pass when expected symbol appears in the answer', () => {
    const { db, cleanup } = makeDb()
    try {
      const grade = gradeAnswer({
        record: recordWithAnswer('It is `openDatabase` in `src/storage/db.ts`.'),
        expected: ['openDatabase'],
        db,
      })
      expect(grade.pass).toBe(true)
      expect(grade.hallucinated).toBe(false)
    } finally {
      cleanup()
    }
  })

  test('fail when expected symbol is missing', () => {
    const { db, cleanup } = makeDb()
    try {
      const grade = gradeAnswer({
        record: recordWithAnswer('It is in `src/storage/db.ts`.'),
        expected: ['openDatabase'],
        db,
      })
      expect(grade.pass).toBe(false)
      expect(grade.hallucinated).toBe(false)
    } finally {
      cleanup()
    }
  })

  test('flags a named symbol that does not exist in the index', () => {
    const { db, cleanup } = makeDb()
    try {
      const grade = gradeAnswer({
        record: recordWithAnswer('It is `openDatabaseImpl` in `src/storage/db.ts`.'),
        expected: ['openDatabase'],
        db,
      })
      expect(grade.pass).toBe(false)
      expect(grade.hallucinated).toBe(true)
      expect(grade.namedSymbols).toContain('openDatabaseImpl')
    } finally {
      cleanup()
    }
  })

  test('ignores lowercase path fragments and prose words', () => {
    const { db, cleanup } = makeDb()
    try {
      const grade = gradeAnswer({
        record: recordWithAnswer(
          'The answer lives under the storage module; see `src/storage/db.ts` where `Database` is defined.',
        ),
        expected: ['Database'],
        db,
      })
      expect(grade.pass).toBe(true)
      expect(grade.hallucinated).toBe(false)
      expect(grade.namedSymbols).toEqual(['Database'])
    } finally {
      cleanup()
    }
  })

  test('matches qualified names in the index', () => {
    const { db, cleanup } = makeDb()
    try {
      const grade = gradeAnswer({
        record: recordWithAnswer('See `src/storage/db#openDatabase`.'),
        expected: ['openDatabase'],
        db,
      })
      expect(grade.pass).toBe(true)
      expect(grade.hallucinated).toBe(false)
    } finally {
      cleanup()
    }
  })

  test('grade links back to taskId, arm, rep', () => {
    const { db, cleanup } = makeDb()
    try {
      const grade = gradeAnswer({
        record: recordWithAnswer('`openDatabase`'),
        expected: ['openDatabase'],
        db,
      })
      expect(grade.taskId).toBe('locate-openDatabase')
      expect(grade.arm).toBe('with')
      expect(grade.rep).toBe(0)
      expect(grade.expected).toEqual(['openDatabase'])
    } finally {
      cleanup()
    }
  })
})
