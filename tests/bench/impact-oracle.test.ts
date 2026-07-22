import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { buildReferenceOracle, createTsProject } from '../../bench/impact-oracle.js'
import { loadCodeindexConfig } from '../../src/config.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import { openDatabase } from '../../src/storage/db.js'

const dirs: string[] = []
const makeRepo = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-oracle-'))
  dirs.push(dir)
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, 'src/a.ts'), 'export function foo(): number { return 1 }\n')
  writeFileSync(
    path.join(dir, 'src/b.ts'),
    "import { foo } from './a'\nexport function bar(): number { return foo() }\n",
  )
  writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { module: 'esnext', moduleResolution: 'bundler', strict: true },
      include: ['src'],
    }),
  )
  return dir
}
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('createTsProject', () => {
  test('constructs a program over the repo tsconfig', () => {
    const dir = makeRepo()
    const { program } = createTsProject(path.join(dir, 'tsconfig.json'))
    const files = program.getSourceFiles().map((s) => path.basename(s.fileName))
    expect(files).toContain('a.ts')
    expect(files).toContain('b.ts')
  })
})

describe('buildReferenceOracle', () => {
  test('maps true references back to the enclosing codeindex symbol', async () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
    const config = await loadCodeindexConfig({ configPath: path.join(dir, '.codeindex.json'), repoRoot: dir })
    await indexCodebase({ config, mode: 'full' })
    const db = openDatabase(config.dbPath)
    try {
      const oracle = buildReferenceOracle(db, { repoRoot: dir, tsconfigPath: path.join(dir, 'tsconfig.json') })
      const foo = oracle.find((t) => t.target.endsWith('#foo'))
      expect(foo).toBeDefined()
      expect(foo!.trueSources.some((s) => s.endsWith('#bar'))).toBe(true)
    } finally {
      db.close()
    }
  })
})
