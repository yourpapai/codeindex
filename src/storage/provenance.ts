import type { Database } from 'bun:sqlite'

import { parseStringArray } from './queries.js'

export interface IndexProvenance {
  readonly gitCommit: string | null
  readonly gitBranch: string | null
  readonly configHash: string
  readonly roots: readonly string[]
  readonly languages: readonly string[]
  readonly indexedAt: string
}

export const writeIndexProvenance = (db: Database, provenance: IndexProvenance): void => {
  db.query(
    `INSERT OR REPLACE INTO index_meta (id, git_commit, git_branch, config_hash, roots, languages, indexed_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    provenance.gitCommit,
    provenance.gitBranch,
    provenance.configHash,
    JSON.stringify(provenance.roots),
    JSON.stringify(provenance.languages),
    provenance.indexedAt,
  )
}

interface IndexMetaRow {
  readonly git_commit: string | null
  readonly git_branch: string | null
  readonly config_hash: string
  readonly roots: string
  readonly languages: string
  readonly indexed_at: string
}

export const getIndexProvenance = (db: Database): IndexProvenance | null => {
  const row = db
    .query<IndexMetaRow, []>(
      'SELECT git_commit, git_branch, config_hash, roots, languages, indexed_at FROM index_meta WHERE id = 1',
    )
    .get()
  if (row === null) {
    return null
  }
  return {
    gitCommit: row.git_commit,
    gitBranch: row.git_branch,
    configHash: row.config_hash,
    roots: parseStringArray(row.roots),
    languages: parseStringArray(row.languages),
    indexedAt: row.indexed_at,
  }
}
