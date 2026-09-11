import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'

import type { CodeindexConfig } from '../config.js'
import { discoverSourceFiles } from '../indexer/discover.js'
import { openDatabase } from '../storage/db.js'

interface StoredFileRow {
  readonly file_path: string
  readonly indexed_at: number
}

// Boot probe: pure structure + mtime truth. discoverSourceFiles supplies the current
// file set; stored rows supply the indexed set and epoch-ms timestamps. No file reads,
// no hashing — the catch-up reindex itself re-derives content hashes. Missing or
// unreadable DB, dropped rows, or a mtime past the stored timestamp all mean drift.
export const probeDirty = async (config: CodeindexConfig): Promise<boolean> => {
  const { files: discovered } = await discoverSourceFiles({
    repoRoot: config.repoRoot,
    roots: config.roots,
    exclude: config.exclude,
    languages: config.languages,
    maxFileSizeBytes: config.maxFileSizeBytes,
  })
  const discoveredPaths = new Set(discovered.map((file) => file.relativePath))
  if (!existsSync(config.dbPath)) {
    return true
  }
  const db = openDatabase(config.dbPath)
  try {
    let stored: readonly StoredFileRow[]
    try {
      stored = db.query<StoredFileRow, []>('SELECT file_path, indexed_at FROM files').all()
    } catch {
      return true
    }
    const storedPaths = new Set(stored.map((row) => row.file_path))
    for (const discoveredPath of discoveredPaths) {
      if (!storedPaths.has(discoveredPath)) {
        return true
      }
    }
    const mtimeDrift = await Promise.all(
      stored.map(async (row): Promise<boolean> => {
        if (!discoveredPaths.has(row.file_path)) {
          return true
        }
        try {
          const mtimeMs = (await stat(path.join(config.repoRoot, row.file_path))).mtimeMs
          return !(mtimeMs <= row.indexed_at)
        } catch {
          return true
        }
      }),
    )
    return mtimeDrift.some((drift) => drift)
  } finally {
    db.close()
  }
}
