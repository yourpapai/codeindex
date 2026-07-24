import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import ts from 'typescript'

import {
  buildReferenceOracle,
  classifyPosition,
  classifyShape,
  createTsProject,
  strideSample,
} from '../../bench/impact-oracle.js'
import type { Shape } from '../../bench/impact-types.js'
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

// Parse a fixture standalone (no type-checking needed — the classifier is purely syntactic)
// and classify the first identifier token whose text is `needle`. Each fixture places that
// identifier exactly once in the position under test.
const classifyIn = (source: string, needle: string, ext: '.ts' | '.tsx'): 'value' | 'type' => {
  // setParentNodes must be true — classifyPosition walks node.parent up to the SourceFile.
  const sf = ts.createSourceFile(
    `fixture${ext}`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ext === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  let pos = -1
  const walk = (node: ts.Node): void => {
    if (pos !== -1) return
    if (ts.isIdentifier(node) && node.text === needle) {
      pos = node.getStart(sf)
      return
    }
    node.forEachChild(walk)
  }
  walk(sf)
  if (pos === -1) throw new Error(`identifier '${needle}' not found in fixture`)
  return classifyPosition(sf, pos)
}

describe('classifyPosition', () => {
  // The nine positions the Slice 2 spec's go/no-go names for the trust-critical classifier:
  // value-call, `new`, JSX tag, class-`extends`, interface-`implements`, `: T`, `Array<T>`,
  // `typeof X`, interface-`extends`. Pinned directly so a regression in the syntactic walk
  // (heritage-first, then any type-node ancestor) surfaces without a full oracle run.
  const cases: ReadonlyArray<{
    readonly label: string
    readonly source: string
    readonly needle: string
    readonly ext: '.ts' | '.tsx'
    readonly expected: 'value' | 'type'
  }> = [
    { label: 'value call foo()', source: 'foo()', needle: 'foo', ext: '.ts', expected: 'value' },
    { label: 'new Foo()', source: 'new Foo()', needle: 'Foo', ext: '.ts', expected: 'value' },
    { label: 'JSX tag <Foo/>', source: 'const x = <Foo />', needle: 'Foo', ext: '.tsx', expected: 'value' },
    {
      label: "class's extends (value)",
      source: 'class W extends Base {}',
      needle: 'Base',
      ext: '.ts',
      expected: 'value',
    },
    {
      label: 'class implements (type)',
      source: 'class W implements Iface {}',
      needle: 'Iface',
      ext: '.ts',
      expected: 'type',
    },
    { label: 'annotation : T', source: 'let x: T', needle: 'T', ext: '.ts', expected: 'type' },
    { label: 'generic arg Array<T>', source: 'let x: Array<T>', needle: 'T', ext: '.ts', expected: 'type' },
    { label: 'typeof X query', source: 'let x: typeof X', needle: 'X', ext: '.ts', expected: 'type' },
    {
      label: "interface's extends (type)",
      source: 'interface I extends Base {}',
      needle: 'Base',
      ext: '.ts',
      expected: 'type',
    },
  ]
  for (const c of cases) {
    test(`classifies ${c.label} as ${c.expected}`, () => {
      expect(classifyIn(c.source, c.needle, c.ext)).toBe(c.expected)
    })
  }
})

describe('classifyShape', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-shape-'))
  dirs.push(dir)
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, 'src/mod.ts'), 'export function nsFn(): number {\n  return 1\n}\n')
  writeFileSync(
    path.join(dir, 'src/main.tsx'),
    [
      "import * as api from './mod'",
      'class BaseCls {}',
      'function CompFn(): null {',
      '  return null',
      '}',
      'function plainFn(): number {',
      '  return 1',
      '}',
      'function bareFn(): number {',
      '  return 2',
      '}',
      'function helperFn(): { ghostProp: number } {',
      '  return { ghostProp: 1 }',
      '}',
      'const bag: Record<string, number> = { k: 1 }',
      'const keyVar = "k"',
      'class Holder {',
      '  hitFn(): number {',
      '    return 1',
      '  }',
      '  useThis(): number {',
      '    return this.hitFn()',
      '  }',
      '}',
      'const obj = {',
      '  omFn(): number {',
      '    return 1',
      '  },',
      '}',
      'class WidgetX extends BaseCls {}',
      'class NewOnly {}',
      'export function outer(): unknown {',
      '  const g = bareFn',
      '  return [api.nsFn(), obj.omFn(), plainFn(), helperFn().ghostProp, bag[keyVar], g, new Holder(), <CompFn />, WidgetX, new NewOnly()]',
      '}',
    ].join('\n'),
  )
  writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { module: 'esnext', moduleResolution: 'bundler', strict: true, jsx: 'react-jsx' },
      include: ['src'],
    }),
  )
  const { program } = createTsProject(path.join(dir, 'tsconfig.json'))
  const checker = program.getTypeChecker()
  // Match by basename — tmpdir paths symlink-normalize on macOS (/var → /private/var), so an
  // exact-path getSourceFile can miss.
  const sf = program.getSourceFiles().find((s) => s.fileName.endsWith('main.tsx'))!

  const inImport = (node: ts.Node): boolean => {
    for (let a: ts.Node | undefined = node; a !== undefined; a = a.parent) if (ts.isImportDeclaration(a)) return true
    return false
  }
  // True when `id` IS the name of its parent declaration (function/class/method/var/param/
  // property/interface/enum/type-alias) — the position to skip when finding the reference site.
  const isDeclarationName = (id: ts.Identifier): boolean => {
    const p = id.parent
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isClassDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isShorthandPropertyAssignment(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodSignature(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isEnumDeclaration(p) ||
      ts.isTypeAliasDeclaration(p)
    ) {
      return p.name === id
    }
    return false
  }
  const posOf = (needle: string): number => {
    const hits: number[] = []
    const walk = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === needle && !inImport(node) && !isDeclarationName(node)) {
        hits.push(node.getStart(sf))
      }
      node.forEachChild(walk)
    }
    walk(sf)
    if (hits.length !== 1) throw new Error(`expected exactly 1 reference of '${needle}', found ${hits.length}`)
    return hits[0]!
  }

  const cases: ReadonlyArray<{ needle: string; expected: Shape }> = [
    // api.nsFn() — receiver is `import * as api`
    { needle: 'nsFn', expected: 'namespace' },
    // obj.omFn() — receiver is a local const
    { needle: 'omFn', expected: 'member' },
    // this.hitFn()
    { needle: 'hitFn', expected: 'member' },
    // plainFn()
    { needle: 'plainFn', expected: 'call' },
    // <CompFn />
    { needle: 'CompFn', expected: 'jsx' },
    // class WidgetX extends BaseCls
    { needle: 'BaseCls', expected: 'heritage' },
    // const g = bareFn
    { needle: 'bareFn', expected: 'bare-value' },
    // helperFn().ghostProp — receiver is a call
    { needle: 'ghostProp', expected: 'property-unknown' },
    // bag[keyVar] — element access
    { needle: 'keyVar', expected: 'other' },
    // new NewOnly() — constructor call, distinct from a plain call
    { needle: 'NewOnly', expected: 'construct' },
  ]
  for (const c of cases) {
    test(`classifies ${c.needle} as ${c.expected}`, () => {
      expect(classifyShape(sf, posOf(c.needle), checker)).toBe(c.expected)
    })
  }
})

describe('strideSample', () => {
  test('returns the whole list untouched when maxTargets >= length', () => {
    const items = [0, 1, 2, 3, 4]
    expect(strideSample(items, 5)).toBe(items)
    expect(strideSample(items, 99)).toBe(items)
  })

  test('returns nothing for a non-positive budget', () => {
    expect(strideSample([1, 2, 3], 0)).toEqual([])
    expect(strideSample([1, 2, 3], -1)).toEqual([])
  })

  test('picks exactly maxTargets distinct items', () => {
    const items = Array.from({ length: 1000 }, (_, i) => i)
    const sample = strideSample(items, 37)
    expect(sample).toHaveLength(37)
    expect(new Set(sample).size).toBe(37)
  })

  test('spreads across the WHOLE list, not a prefix', () => {
    // The bug this replaces: `.slice(0, maxTargets)` only ever returns items[0..N),
    // so anything that sorts past the cutoff (papai's client/shared/* member,
    // namespace and construct targets) never gets sampled. A strided sample must
    // reach deep into the tail.
    const items = Array.from({ length: 1000 }, (_, i) => i)
    const sample = strideSample(items, 10)
    expect(sample[0]).toBe(0)
    // Last pick lands in the final tenth of the list — a prefix slice would top out at 9.
    expect(sample.at(-1)).toBeGreaterThanOrEqual(900)
    // Coverage is monotonic and evenly spaced across the range.
    expect(sample).toEqual([...sample].sort((a, b) => a - b))
  })

  test('is deterministic — same inputs give byte-identical output (regression-comparison invariant)', () => {
    const items = Array.from({ length: 500 }, (_, i) => `sym-${i}`)
    expect(strideSample(items, 42)).toEqual(strideSample(items, 42))
  })
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

describe('buildReferenceOracle — source attribution (Slice 4a)', () => {
  // Builds a two-file repo: src/a.ts declares `target`, src/b.ts references it inside `callerBody`.
  const makeAttributionRepo = async (
    callerBody: string,
  ): Promise<{ db: ReturnType<typeof openDatabase>; dir: string }> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-oracle-attr-'))
    dirs.push(dir)
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, 'src/a.ts'), 'export function target(): number { return 1 }\n')
    writeFileSync(path.join(dir, 'src/b.ts'), `import { target } from './a'\n${callerBody}\n`)
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

  test('a plain `const x = f()` local is transparent — attributes to the enclosing function', async () => {
    const { db, dir } = await makeAttributionRepo(
      'export function caller(): number {\n  const x = target()\n  return x\n}',
    )
    try {
      const oracle = buildReferenceOracle(db, { repoRoot: dir, tsconfigPath: path.join(dir, 'tsconfig.json') })
      const sources = oracle.find((t) => t.target.endsWith('#target'))!.trueSources.map((s) => s.name)
      expect(sources).toContain('src/b#caller')
      expect(sources).not.toContain('src/b#caller>x')
    } finally {
      db.close()
    }
  })

  test('an arrow-var-local boundary is retained — attributes to the arrow-var, not its parent', async () => {
    const { db, dir } = await makeAttributionRepo(
      'export function outer(): () => number {\n  const handler = (): number => target()\n  return handler\n}',
    )
    try {
      const oracle = buildReferenceOracle(db, { repoRoot: dir, tsconfigPath: path.join(dir, 'tsconfig.json') })
      const sources = oracle.find((t) => t.target.endsWith('#target'))!.trueSources.map((s) => s.name)
      expect(sources).toContain('src/b#outer>handler')
      expect(sources).not.toContain('src/b#outer')
    } finally {
      db.close()
    }
  })

  test('a method boundary is attributed to the method, not an inner local', async () => {
    const { db, dir } = await makeAttributionRepo(
      'export class Widget {\n  run(): number {\n    const y = target()\n    return y\n  }\n}',
    )
    try {
      const oracle = buildReferenceOracle(db, { repoRoot: dir, tsconfigPath: path.join(dir, 'tsconfig.json') })
      const sources = oracle.find((t) => t.target.endsWith('#target'))!.trueSources.map((s) => s.name)
      expect(sources).toContain('src/b#Widget>run')
      expect(sources).not.toContain('src/b#Widget>run>y')
    } finally {
      db.close()
    }
  })

  // Indexer/oracle agreement: a NAMED function expression used as a bare callback owns no symbol
  // row, so neither extract-references (isNamedScopeBoundary) nor nearestNamedBoundary treats it as a
  // boundary — the reference attributes to the nearest REAL enclosing symbol on both sides. This
  // pins that agreement (extract-references.test.ts pins the indexer half directly).
  test('a named function-expression bare callback attributes to the enclosing real symbol (indexer/oracle agree)', async () => {
    const { db, dir } = await makeAttributionRepo(
      'export function outer(): void {\n  setTimeout(function handler(): void {\n    target()\n  }, 0)\n}',
    )
    try {
      const oracle = buildReferenceOracle(db, { repoRoot: dir, tsconfigPath: path.join(dir, 'tsconfig.json') })
      const sources = oracle.find((t) => t.target.endsWith('#target'))!.trueSources.map((s) => s.name)
      expect(sources).toContain('src/b#outer')
      expect(sources).not.toContain('src/b#outer>handler')
    } finally {
      db.close()
    }
  })
})
