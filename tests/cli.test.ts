import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadConfigForPath, resolveRepoRoot } from '../src/cli.js'
import { openDatabase } from '../src/storage/db.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) {
    Bun.spawnSync(['rm', '-rf', dir])
  }
  dirs.length = 0
})

const tempDirs: string[] = []

const makeTempDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-cli-'))
  tempDirs.push(dir)
  return dir
}

describe('cli config resolution', () => {
  test('resolveRepoRoot defaults to process.cwd()', () => {
    expect(resolveRepoRoot()).toBe(process.cwd())
  })

  test('resolveRepoRoot uses explicit targetPath when provided', () => {
    const tempDir = makeTempDir()
    expect(resolveRepoRoot(tempDir)).toBe(tempDir)
  })

  test('loadConfigForPath with explicit path loads from that directory', async () => {
    const repoRoot = makeTempDir()
    writeFileSync(path.join(repoRoot, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))

    const config = await loadConfigForPath(repoRoot)
    expect(config.repoRoot).toBe(repoRoot)
    expect(config.configPath).toBe(path.join(repoRoot, '.codeindex.json'))
    expect(config.roots).toEqual([path.join(repoRoot, 'src')])
  })

  test('loadConfigForPath defaults to repo root config', async () => {
    const config = await loadConfigForPath()
    expect(config.configPath).toBe(path.resolve(resolveRepoRoot(), '.codeindex.json'))
  })

  test('index resolves a positional path to that repo and its config', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-cli-path-'))
    dirs.push(dir)
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
    writeFileSync(path.join(dir, 'src/mod.ts'), 'export const marker = 1\n')

    const result = Bun.spawnSync(['bun', path.resolve(import.meta.dir, '../src/cli.ts'), 'index', dir], {
      cwd: import.meta.dir,
    })
    expect(result.exitCode).toBe(0)

    const db = openDatabase(path.join(dir, '.codeindex', 'index.db'))
    try {
      const row = db
        .query<{ files: number }, [string]>('SELECT COUNT(*) AS files FROM files WHERE parse_status = ?')
        .get('indexed')
      expect(row?.files).toBe(1)
    } finally {
      db.close()
    }
  })

  test('reindex also honors the positional path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-cli-reindex-'))
    dirs.push(dir)
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
    writeFileSync(path.join(dir, 'src/mod.ts'), 'export const marker = 1\n')
    Bun.spawnSync(['bun', path.resolve(import.meta.dir, '../src/cli.ts'), 'index', dir], { cwd: import.meta.dir })

    const result = Bun.spawnSync(['bun', path.resolve(import.meta.dir, '../src/cli.ts'), 'reindex', dir], {
      cwd: import.meta.dir,
    })
    expect(result.exitCode).toBe(0)
  })
})
