import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { computeConfigIdentity, loadCodeindexConfig } from '../src/config.js'

const tempDirs: string[] = []

const configFor = (raw: Record<string, unknown>): Promise<Awaited<ReturnType<typeof loadCodeindexConfig>>> => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-identity-'))
  tempDirs.push(dir)
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify(raw))
  return loadCodeindexConfig({ configPath: path.join(dir, '.codeindex.json'), repoRoot: dir })
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('computeConfigIdentity', () => {
  test('is stable for the same behavior-affecting settings', async () => {
    const a = await configFor({ roots: ['src'] })
    const b = await configFor({ roots: ['src'] })
    expect(computeConfigIdentity(a)).toBe(computeConfigIdentity(b))
  })

  test('changes when a behavior-affecting field changes', async () => {
    const a = await configFor({ roots: ['src'] })
    const b = await configFor({ roots: ['src', 'lib'] })
    expect(computeConfigIdentity(a)).not.toBe(computeConfigIdentity(b))
  })
})
