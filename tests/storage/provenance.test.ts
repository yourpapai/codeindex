import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { getIndexProvenance, writeIndexProvenance } from '../../src/storage/provenance.js'
import { ensureSchema } from '../../src/storage/schema.js'

describe('index provenance storage', () => {
  test('getIndexProvenance returns null before any stamp', () => {
    const db = new Database(':memory:')
    try {
      ensureSchema(db)
      expect(getIndexProvenance(db)).toBeNull()
    } finally {
      db.close()
    }
  })

  test('write then read round-trips all fields', () => {
    const db = new Database(':memory:')
    try {
      ensureSchema(db)
      writeIndexProvenance(db, {
        gitCommit: 'abc123',
        gitBranch: 'main',
        configHash: 'hash-xyz',
        roots: ['src', 'lib'],
        languages: ['ts', 'tsx'],
        indexedAt: '2026-07-21T00:00:00.000Z',
      })
      const provenance = getIndexProvenance(db)
      expect(provenance).not.toBeNull()
      expect(provenance!.gitCommit).toBe('abc123')
      expect(provenance!.gitBranch).toBe('main')
      expect(provenance!.configHash).toBe('hash-xyz')
      expect(provenance!.roots).toEqual(['src', 'lib'])
      expect(provenance!.languages).toEqual(['ts', 'tsx'])
      expect(provenance!.indexedAt).toBe('2026-07-21T00:00:00.000Z')
    } finally {
      db.close()
    }
  })

  test('writing again replaces the single row (id stays 1)', () => {
    const db = new Database(':memory:')
    try {
      ensureSchema(db)
      writeIndexProvenance(db, {
        gitCommit: null,
        gitBranch: null,
        configHash: 'h1',
        roots: ['src'],
        languages: ['ts'],
        indexedAt: 't1',
      })
      writeIndexProvenance(db, {
        gitCommit: 'c2',
        gitBranch: 'b2',
        configHash: 'h2',
        roots: ['src'],
        languages: ['ts'],
        indexedAt: 't2',
      })
      const count = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM index_meta').get()
      expect(count).not.toBeNull()
      expect(count!.n).toBe(1)
      expect(getIndexProvenance(db)!.configHash).toBe('h2')
    } finally {
      db.close()
    }
  })
})
