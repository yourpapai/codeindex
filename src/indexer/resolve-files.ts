import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type { CodeindexConfig } from '../config.js'
import { findDependentsOfDeletedFiles, pruneDeletedFiles } from '../storage/queries.js'
import { discoverSourceFiles, type DiscoveredFile } from './discover.js'

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const findIncrementalFileSet = async (db: Database, files: readonly DiscoveredFile[]): Promise<ReadonlySet<string>> => {
  const fileHashes = await Promise.all(
    files.map(async (file) => ({
      file,
      fileHash: sha256(await readFile(file.absolutePath, 'utf8')),
    })),
  )

  const changedFiles = fileHashes
    .filter(({ file, fileHash }) => {
      const existing = db
        .query<{ file_hash: string }, [string]>('SELECT file_hash FROM files WHERE file_path = ?')
        .get(file.relativePath)
      return existing === null || existing.file_hash !== fileHash
    })
    .map(({ file }) => file.relativePath)

  const dependentFiles = changedFiles.flatMap((changedFilePath) =>
    db
      .query<{ file_path: string }, [string]>(
        `SELECT DISTINCT source_files.file_path
         FROM symbol_references
         JOIN files AS source_files ON source_files.id = symbol_references.source_file_id
         JOIN files AS target_files ON target_files.file_path = ?
         LEFT JOIN symbols AS target_symbols ON target_symbols.id = symbol_references.target_symbol_id
         WHERE target_symbols.file_id = target_files.id
            OR symbol_references.target_file_id = target_files.id`,
      )
      .all(changedFilePath)
      .map((row) => row.file_path),
  )

  return new Set([...changedFiles, ...dependentFiles])
}

export const resolveFilesToProcess = async (
  db: Database,
  config: CodeindexConfig,
  mode: 'full' | 'incremental',
): Promise<
  Readonly<{ filesToProcess: readonly DiscoveredFile[]; filesPruned: number; filesSkipped: readonly string[] }>
> => {
  const { files: discoveredFiles, skippedFiles } = await discoverSourceFiles({
    repoRoot: config.repoRoot,
    roots: config.roots,
    exclude: config.exclude,
    languages: config.languages,
    maxFileSizeBytes: config.maxFileSizeBytes,
  })
  const discoveredPathSet = new Set(discoveredFiles.map((f) => f.relativePath))
  const deletedFileDependents = mode === 'incremental' ? findDependentsOfDeletedFiles(db, discoveredPathSet) : null
  const filesPruned = pruneDeletedFiles(db, discoveredPathSet)
  const baseIncrementalSet = mode === 'incremental' ? await findIncrementalFileSet(db, discoveredFiles) : null
  const incrementalSet =
    baseIncrementalSet !== null && deletedFileDependents !== null
      ? new Set([...baseIncrementalSet, ...deletedFileDependents])
      : baseIncrementalSet
  const filesToProcess =
    incrementalSet === null ? discoveredFiles : discoveredFiles.filter((file) => incrementalSet.has(file.relativePath))
  return { filesToProcess, filesPruned, filesSkipped: skippedFiles }
}
