import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadCodeindexConfig } from '../src/config.js'

const tempDirs: string[] = []

const loadWith = (raw: Record<string, unknown>): Promise<Awaited<ReturnType<typeof loadCodeindexConfig>>> => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-qlcfg-'))
  tempDirs.push(dir)
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify(raw))
  return loadCodeindexConfig({ configPath: path.join(dir, '.codeindex.json'), repoRoot: dir })
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('query-log config', () => {
  test('defaults logQueries to true and queriesPath under .codeindex', async () => {
    const config = await loadWith({ roots: ['src'] })
    expect(config.logQueries).toBe(true)
    expect(config.queriesPath.endsWith(path.join('.codeindex', 'queries.db'))).toBe(true)
    expect(path.isAbsolute(config.queriesPath)).toBe(true)
  })

  test('respects an explicit logQueries: false', async () => {
    const config = await loadWith({ roots: ['src'], logQueries: false })
    expect(config.logQueries).toBe(false)
  })

  test('respects a custom queriesPath', async () => {
    const config = await loadWith({ roots: ['src'], queriesPath: '.codeindex/custom-queries.db' })
    expect(config.queriesPath.endsWith('custom-queries.db')).toBe(true)
  })
})
