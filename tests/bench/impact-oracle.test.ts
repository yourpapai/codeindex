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
      expect(foo!.trueSources.some((s) => s.name.endsWith('#bar'))).toBe(true)
    } finally {
      db.close()
    }
  })

  test('does not lock onto an unrelated same-text identifier near the declaration line', async () => {
    // `unrelatedHolder`'s parameter is named `foo`, one line above the real `foo`
    // declaration and referenced in its own body — an identifier that shares
    // localName and is within the +/-1 start_line proximity window of the real
    // declaration below, but is NOT that declaration's name. A position heuristic
    // that matches "any identifier with this text near this line" (instead of
    // requiring the identifier to BE the declaration name) locks onto this
    // parameter instead, fabricating a spurious source (`unrelatedHolder`, whose
    // enclosing scope contains the hijacked position) and dropping the real one
    // (`bar`, which actually calls `foo()`).
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-oracle-decoy-'))
    dirs.push(dir)
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(
      path.join(dir, 'src/a.ts'),
      'export function unrelatedHolder(foo: string): string { return foo }\n' +
        'export function foo(): number { return 1 }\n',
    )
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
    writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
    const config = await loadCodeindexConfig({ configPath: path.join(dir, '.codeindex.json'), repoRoot: dir })
    await indexCodebase({ config, mode: 'full' })
    const db = openDatabase(config.dbPath)
    try {
      const oracle = buildReferenceOracle(db, { repoRoot: dir, tsconfigPath: path.join(dir, 'tsconfig.json') })
      const foo = oracle.find((t) => t.target.endsWith('#foo'))
      expect(foo).toBeDefined()
      // The genuine caller must still be found...
      expect(foo!.trueSources.some((s) => s.name.endsWith('#bar'))).toBe(true)
      // ...and the decoy parameter's enclosing function must not be fabricated as a source.
      expect(foo!.trueSources.some((s) => s.name.endsWith('#unrelatedHolder'))).toBe(false)
    } finally {
      db.close()
    }
  })

  test('classifies class extends as value and implements as type', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-oracle-heritage-'))
    dirs.push(dir)
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, 'src/base.ts'), 'export class Base {}\nexport interface Iface {}\n')
    writeFileSync(
      path.join(dir, 'src/widget.ts'),
      "import { Base, Iface } from './base'\nexport class Widget extends Base implements Iface {}\n",
    )
    writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { module: 'esnext', moduleResolution: 'bundler', strict: true },
        include: ['src'],
      }),
    )
    writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
    const config = await loadCodeindexConfig({ configPath: path.join(dir, '.codeindex.json'), repoRoot: dir })
    await indexCodebase({ config, mode: 'full' })
    const db = openDatabase(config.dbPath)
    try {
      const oracle = buildReferenceOracle(db, { repoRoot: dir, tsconfigPath: path.join(dir, 'tsconfig.json') })
      const base = oracle.find((t) => t.target.endsWith('#Base'))
      expect(base!.trueSources.find((s) => s.name.endsWith('#Widget'))!.position).toBe('value')
      const iface = oracle.find((t) => t.target.endsWith('#Iface'))
      expect(iface!.trueSources.find((s) => s.name.endsWith('#Widget'))!.position).toBe('type')
    } finally {
      db.close()
    }
  })
})
