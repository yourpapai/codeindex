import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { discoverSourceFiles } from '../src/indexer/discover.js'

const tempDirs: string[] = []

const makeTempRepo = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-discover-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('discoverSourceFiles', () => {
  test('respects gitignore and explicit excludes', async () => {
    const repoRoot = makeTempRepo()
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true })
    mkdirSync(path.join(repoRoot, 'coverage'), { recursive: true })
    writeFileSync(path.join(repoRoot, '.gitignore'), 'ignored.ts\n')
    writeFileSync(path.join(repoRoot, 'src', 'kept.ts'), 'export const kept = 1\n')
    writeFileSync(path.join(repoRoot, 'ignored.ts'), 'export const ignored = 1\n')
    writeFileSync(path.join(repoRoot, 'coverage', 'skip.ts'), 'export const skip = 1\n')
    writeFileSync(path.join(repoRoot, 'src', 'skip.test.ts'), 'export const testOnly = 1\n')

    const result = await discoverSourceFiles({
      repoRoot,
      roots: [path.join(repoRoot, 'src')],
      exclude: ['coverage', '**/*.test.*'],
      languages: ['ts', 'tsx', 'js', 'jsx'],
      maxFileSizeBytes: 1_000_000,
    })

    expect(result.files.map((entry) => path.relative(repoRoot, entry.absolutePath))).toEqual(['src/kept.ts'])
  })

  test('skips files over maxFileSizeBytes and reports them', async () => {
    const repoRoot = makeTempRepo()
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true })
    writeFileSync(path.join(repoRoot, 'src', 'small.ts'), 'export const small = 1\n')
    writeFileSync(path.join(repoRoot, 'src', 'huge.ts'), 'x'.repeat(64))

    const result = await discoverSourceFiles({
      repoRoot,
      roots: [path.join(repoRoot, 'src')],
      exclude: [],
      languages: ['ts'],
      maxFileSizeBytes: 32,
    })

    expect(result.files.map((entry) => entry.relativePath)).toEqual(['src/small.ts'])
    expect(result.skippedFiles).toEqual(['src/huge.ts'])
  })

  test('an unreadable .gitignore warns but discovery proceeds', async () => {
    const repoRoot = makeTempRepo()
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true })
    writeFileSync(path.join(repoRoot, 'src', 'kept.ts'), 'export const kept = 1\n')
    mkdirSync(path.join(repoRoot, '.gitignore'))
    const errSpy = spyOn(console, 'error')
    try {
      const result = await discoverSourceFiles({
        repoRoot,
        roots: [path.join(repoRoot, 'src')],
        exclude: [],
        languages: ['ts'],
        maxFileSizeBytes: 1_000_000,
      })
      expect(result.files.length).toBeGreaterThan(0)
      const output = errSpy.mock.calls.map((call) => call.join(' ')).join('\n')
      expect(output).toContain('.gitignore')
    } finally {
      errSpy.mockRestore()
    }
  })
})
