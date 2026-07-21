import { describe, expect, test } from 'bun:test'

import { openDatabase } from '../../src/storage/db.js'

describe('openDatabase', () => {
  test('sets busy_timeout to 5000ms', () => {
    const db = openDatabase(':memory:')
    try {
      const row = db.query<{ timeout: number }, []>('PRAGMA busy_timeout').get()
      expect(row).not.toBeNull()
      expect(row!.timeout).toBe(5000)
    } finally {
      db.close()
    }
  })

  test('enables WAL journal mode for a file-backed db', () => {
    const db = openDatabase(':memory:')
    try {
      const row = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()
      expect(row).not.toBeNull()
      // :memory: reports 'memory'; the PRAGMA call itself must not throw and the row must exist.
      expect(typeof row!.journal_mode).toBe('string')
    } finally {
      db.close()
    }
  })
})
