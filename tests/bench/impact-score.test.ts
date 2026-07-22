import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { buildReferenceOracle } from '../../bench/impact-oracle.js'
import { scoreImpact } from '../../bench/impact-score.js'
import { loadCodeindexConfig } from '../../src/config.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import { openDatabase } from '../../src/storage/db.js'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const build = async (): Promise<{ db: import('bun:sqlite').Database; dir: string }> => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-score-'))
  dirs.push(dir)
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  // Two exported functions. `foo` is called plainly (code_impact resolves it → FN 0).
  // `baz` is called only via a namespace member access `ns.baz()`, which code_impact
  // stores as opaque text 'ns.baz' and cannot resolve, and `import * as ns` produces no
  // edge — so code_impact misses it while tsc finds it. Both targets are unambiguously
  // exported (no reliance on member-tier behavior).
  writeFileSync(
    path.join(dir, 'src/a.ts'),
    'export function foo(): number { return 1 }\nexport function baz(): number { return 2 }\n',
  )
  writeFileSync(
    path.join(dir, 'src/b.ts'),
    "import { foo } from './a'\nimport * as ns from './a'\n" +
      'export function bar(): number { return foo() }\n' +
      'export function qux(): number { return ns.baz() }\n',
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
  return { db: openDatabase(config.dbPath), dir }
}

describe('scoreImpact', () => {
  test('FN is zero for a resolved call and positive for a missed namespace member call', async () => {
    const { db, dir } = await build()
    try {
      const oracle = buildReferenceOracle(db, { repoRoot: dir, tsconfigPath: path.join(dir, 'tsconfig.json') })
      const report = scoreImpact(db, oracle, 'fixture')
      expect(report.trueReferenceCount).toBeGreaterThan(0)
      expect(report.falseNegativeRate).toBeGreaterThanOrEqual(0)
      expect(report.falseNegativeRate).toBeLessThanOrEqual(1)
      // foo() is resolved → not a false negative.
      const foo = report.perTarget.find((t) => t.target.endsWith('#foo'))
      expect(foo!.falseNegatives).toBe(0)
      // ns.baz() is missed → baz has a true source (qux) code_impact does not report.
      const baz = report.perTarget.find((t) => t.target.endsWith('#baz'))
      expect(baz!.trueSourceCount).toBeGreaterThan(0)
      expect(baz!.falseNegatives).toBeGreaterThan(0)
      expect(report.falseNegatives).toBeGreaterThanOrEqual(1)
    } finally {
      db.close()
    }
  })
})
