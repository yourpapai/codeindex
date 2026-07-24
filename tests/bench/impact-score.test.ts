import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { buildReferenceOracle } from '../../bench/impact-oracle.js'
import { assertScored, scoreImpact } from '../../bench/impact-score.js'
import type { ImpactBenchReport, OracleTarget } from '../../bench/impact-types.js'
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
      // baz's only true source (qux, via ns.baz()) is a value-position call code_impact
      // misses → it must land in the value bucket, not merely the total.
      expect(report.valueTrueReferenceCount).toBeGreaterThan(0)
      expect(report.valueFalseNegatives).toBeGreaterThanOrEqual(1)
      expect(report.valueFalseNegativeRate).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  test("buckets 'both'-position sources as value and type-only sources as type", async () => {
    const { db } = await build()
    try {
      // Hand-built oracle over synthetic targets that have NO incoming edges in the DB, so
      // every true source is a false negative — this isolates the value/type bucketing from
      // code_impact's coverage. Pins the spec's invariance property: a source used in BOTH a
      // value and a type position lands in the value denominator (and never the type one),
      // while the type diagnostic counts type-only sources.
      const oracle: OracleTarget[] = [
        { target: 'synthetic#Both', trueSources: [{ name: 'synthetic#User', position: 'both', shapes: ['member'] }] },
        { target: 'synthetic#TypeOnly', trueSources: [{ name: 'synthetic#User', position: 'type', shapes: [] }] },
        {
          target: 'synthetic#Value',
          trueSources: [{ name: 'synthetic#User', position: 'value', shapes: ['namespace'] }],
        },
      ]
      const report = scoreImpact(db, oracle, 'fixture')
      // 'both' + 'value' → 2 value-denominator refs, both uncovered → value FN.
      expect(report.valueTrueReferenceCount).toBe(2)
      expect(report.valueFalseNegatives).toBe(2)
      expect(report.valueFalseNegativeRate).toBe(1)
      // 'both' must NOT inflate the type diagnostic — only the type-only source counts.
      expect(report.typeTrueReferenceCount).toBe(1)
      expect(report.typeFalseNegatives).toBe(1)
      expect(report.typeFalseNegativeRate).toBe(1)
      // Total is the union of both buckets.
      expect(report.trueReferenceCount).toBe(3)
      expect(report.falseNegatives).toBe(3)
      // Overlapping by-shape buckets: 'both'→member, 'value'→namespace, both uncovered → FN.
      expect(report.valueFalseNegativesByShape['member']).toBe(1)
      expect(report.valueFalseNegativesByShape['namespace']).toBe(1)
      expect(report.valueTrueReferenceCountByShape['member']).toBe(1)
      expect(report.valueTrueReferenceCountByShape['namespace']).toBe(1)
      // The type-only source contributes no shape.
      expect(report.valueFalseNegativesByShape['jsx']).toBeUndefined()
    } finally {
      db.close()
    }
  })

  test('a single uncovered source with multiple shapes increments every shape bucket', async () => {
    const { db } = await build()
    try {
      // A single OracleSource can legitimately carry more than one shape when the same
      // enclosing symbol references the target through more than one syntactic form
      // (e.g. both `x.member` and `ns.member` sites within one function). Every shape
      // on that one source must land in the by-shape maps, not just the first.
      const oracle: OracleTarget[] = [
        {
          target: 'synthetic#MultiShape',
          trueSources: [{ name: 'synthetic#User', position: 'value', shapes: ['member', 'namespace'] }],
        },
      ]
      const report = scoreImpact(db, oracle, 'fixture')
      expect(report.valueFalseNegativesByShape['member']).toBe(1)
      expect(report.valueFalseNegativesByShape['namespace']).toBe(1)
      expect(report.valueTrueReferenceCountByShape['member']).toBe(1)
      expect(report.valueTrueReferenceCountByShape['namespace']).toBe(1)
    } finally {
      db.close()
    }
  })
})

const reportWithTargetsScored = (targetsScored: number): ImpactBenchReport => ({
  repo: 'fixture',
  targetsScored,
  trueReferenceCount: 0,
  impactReferenceCount: 0,
  falseNegatives: 0,
  falseNegativeRate: 0,
  falsePositives: 0,
  falsePositiveRate: 0,
  falsePositivesByConfidence: {},
  valueTrueReferenceCount: 0,
  valueFalseNegatives: 0,
  valueFalseNegativeRate: 0,
  typeTrueReferenceCount: 0,
  typeFalseNegatives: 0,
  typeFalseNegativeRate: 0,
  valueTrueReferenceCountByShape: {},
  valueFalseNegativesByShape: {},
  perTarget: [],
})

describe('assertScored', () => {
  test('throws on a zero-target report instead of letting a broken run gate silently', () => {
    expect(() => assertScored(reportWithTargetsScored(0))).toThrow()
  })

  test('does not throw when at least one target was scored', () => {
    expect(() => assertScored(reportWithTargetsScored(1))).not.toThrow()
  })
})
