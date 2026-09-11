/**
 * Optional env-gated scorer for unique-export bare names on an external repo index.
 *
 * Usage:
 *   CODEINDEX_BENCH_REPO=/path/to/repo bun run scripts/score-unique-export.ts
 *
 * When CODEINDEX_BENCH_REPO is unset the script exits 0 with a skip message and
 * prints no metrics — CI stays green without a live third-party checkout.
 */
import { loadCodeindexConfig } from '../src/config.js'
import { openDatabase } from '../src/storage/db.js'
import { resolveIncomingReferences } from '../src/search/index.js'

interface SymbolNameRow {
  local_name: string
  export_count: number
  total_count: number
}

const main = async (): Promise<void> => {
  const repoRoot = process.env.CODEINDEX_BENCH_REPO
  if (repoRoot === undefined || repoRoot === '') {
    console.log('skip: CODEINDEX_BENCH_REPO is not set')
    return
  }

  const config = await loadCodeindexConfig({
    configPath: `${repoRoot}/.codeindex.json`,
    repoRoot,
  })
  const db = openDatabase(config.dbPath)
  try {
    const rows = db
      .query<SymbolNameRow, []>(
        `SELECT local_name,
                SUM(CASE WHEN scope_tier = 'exported' THEN 1 ELSE 0 END) AS export_count,
                COUNT(*) AS total_count
         FROM symbols
         GROUP BY local_name
         HAVING export_count = 1 AND total_count > 1`,
      )
      .all()

    let accepted = 0
    let refused = 0
    let wrongTarget = 0
    for (const row of rows) {
      const outcome = resolveIncomingReferences(db, { qualifiedName: row.local_name, limit: 1 })
      if (outcome.resolution.status === 'resolved' || outcome.resolution.status === 'canonical') {
        accepted += 1
        const exportRow = db
          .query<{ qualified_name: string }, [string]>(
            `SELECT qualified_name FROM symbols WHERE local_name = ? AND scope_tier = 'exported' LIMIT 1`,
          )
          .get(row.local_name)
        if (exportRow !== null && outcome.resolution.qualifiedName !== exportRow.qualified_name) {
          wrongTarget += 1
        }
      } else {
        refused += 1
      }
    }

    const total = rows.length
    console.log(
      JSON.stringify(
        {
          repoRoot,
          uniqueExportWithNoise: total,
          accepted,
          refused,
          wrongTarget,
          acceptRate: total === 0 ? 1 : accepted / total,
        },
        null,
        2,
      ),
    )
  } finally {
    db.close()
  }
}

void main()
