import type { Database } from 'bun:sqlite'

import { computeConfigIdentity, relativizeRoots, type CodeindexConfig } from '../config.js'
import { writeIndexProvenance } from '../storage/provenance.js'
import { readGitInfo } from './git-info.js'

export const stampIndexProvenance = (db: Database, config: CodeindexConfig): void => {
  const gitInfo = readGitInfo(config.repoRoot)
  writeIndexProvenance(db, {
    gitCommit: gitInfo.commit,
    gitBranch: gitInfo.branch,
    configHash: computeConfigIdentity(config),
    roots: relativizeRoots(config),
    languages: config.languages,
    indexedAt: new Date().toISOString(),
  })
}
