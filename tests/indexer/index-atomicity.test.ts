import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadCodeindexConfig } from '../../src/config.js'
import { indexCodebase, type IndexPhase } from '../../src/indexer/index-codebase.js'
import { openDatabase } from '../../src/storage/db.js'

const boomOnResolve = (phase: IndexPhase): void => {
  if (phase === 'resolve') throw new Error('boom')
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) {
    Bun.spawnSync(['rm', '-rf', dir])
  }
  dirs.length = 0
})

const makeFixture = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-atomic-'))
  dirs.push(dir)
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
  writeFileSync(path.join(dir, 'src/a.ts'), "import { helper } from './b'\nexport const alpha = helper()\n")
  writeFileSync(path.join(dir, 'src/b.ts'), 'export function helper(): number {\n  return 1\n}\n')
  return dir
}

const snapshot = (
  dbPath: string,
): { files: number; symbols: number; references: number; aliases: number; hash: string | null } => {
  const db = openDatabase(dbPath)
  try {
    const counts = db
      .query<{ files: number; symbols: number; references: number; aliases: number }, []>(
        `SELECT (SELECT COUNT(*) FROM files) AS files,
                (SELECT COUNT(*) FROM symbols) AS symbols,
                (SELECT COUNT(*) FROM symbol_references) AS "references",
                (SELECT COUNT(*) FROM module_aliases) AS aliases`,
      )
      .get()!
    const hash =
      db.query<{ file_hash: string }, [string]>('SELECT file_hash FROM files WHERE file_path = ?').get('src/a.ts')
        ?.file_hash ?? null
    return { ...counts, hash }
  } finally {
    db.close()
  }
}

describe('indexCodebase atomicity', () => {
  test('a mid-run failure rolls back — the previous index stays byte-intact', async () => {
    const dir = makeFixture()
    const config = await loadCodeindexConfig({ configPath: path.join(dir, '.codeindex.json'), repoRoot: dir })
    await indexCodebase({ config, mode: 'full' })
    const before = snapshot(config.dbPath)

    writeFileSync(path.join(dir, 'src/a.ts'), "import { helper } from './b'\nexport const alpha = helper() + 1\n")
    await expect(
      indexCodebase({
        config,
        mode: 'incremental',
        onPhase: boomOnResolve,
      }),
    ).rejects.toThrow('boom')

    expect(snapshot(config.dbPath)).toEqual(before)
  })
})
