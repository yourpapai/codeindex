import { Database } from 'bun:sqlite'

const BUSY_TIMEOUT_MS = 5000

export const openDatabase = (dbPath: string): Database => {
  const db = new Database(dbPath, { create: true })
  db.run('PRAGMA journal_mode = WAL;')
  db.run('PRAGMA foreign_keys = ON;')
  db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`)
  return db
}
