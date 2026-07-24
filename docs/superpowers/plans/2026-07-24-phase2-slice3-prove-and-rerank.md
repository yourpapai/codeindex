# Phase 2 Slice 3 — Prove & Re-rank Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Demonstrate Slice 2's banked value-FN wins (B1 JSX, B3 heritage) on a committed fixture corpus and produce a measured value-FN-**by-reference-shape** breakdown — with `member` (B2) split from `namespace` (B5) via the oracle's tsc checker — that ranks the remaining graph candidates and opens Slice 4.

**Architecture:** Entirely `bench/` + `tests/bench/` + `package.json` + a new committed `bench/fixtures/` directory. The shipped `src/` indexer/resolver/schema are untouched. The oracle gains a per-reference `Shape` label (Unit 1), the scorer buckets value-FN by shape (Unit 2), the oracle target set widens from `exported`-only to `exported`+`member` so B2 becomes measurable (Unit 3), a committed fixture corpus gates the wins under `bun run check` (Unit 4), and a demonstration test + re-rank memo close it out (Unit 5).

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, web-tree-sitter (shipped indexer), raw `typescript` LanguageService + checker (bench-only), zod, oxlint/oxfmt, `bun test`.

## Global Constraints

- **`typescript` stays bench-only.** Never import `typescript` or construct a TS checker in `src/`. The guard `tests/bench/impact-guard.test.ts` must stay green.
- **No `src/` change.** Only `bench/`, `tests/bench/`, `package.json`, `bench/fixtures/`, and the two design/plan docs are touched.
- **Gate semantics unchanged.** The gated field stays the scalar `valueFalseNegativeRate` (no-regression, tolerance `1e-9`). The by-shape breakdown and `typeFalseNegativeRate` are **printed diagnostics**, never gated. The by-shape map is **not** added to `ImpactBaseline`/`ImpactBaselineSchema`.
- **Target-set broadening re-baselines papai only.** `bench/impact-baseline.papai.json` re-freezes (legit shift); `bench/impact-baseline.json` (codeindex) must come back **byte-identical** (0 member-tier symbols) — a diff there is a bug to investigate, not to re-freeze away.
- **Classifier fail-safe never biases a candidate.** An unresolved property-access receiver → `property-unknown`, never `member` or `namespace`.
- **oxlint (denyWarnings) / oxfmt.** No unsafe `as` type assertions — narrow with `ts.is*` type guards, validate JSON via zod `.parse`. Match the imperative `let`/`for` style already in `bench/`.
- **Commits:** one per task, into the current branch (`master`), conventional-commit style.

---

## Task 1: Oracle — per-reference `Shape` classifier

Add a value-position **shape** label to each true reference. `classifyShape` is the trust-critical new logic; a focused test over a single in-tmpdir `tsc` program pins every shape.

**Files:**
- Modify: `bench/impact-types.ts` (add `Shape`; extend `OracleSource`)
- Modify: `bench/impact-oracle.ts` (add `classifyReceiver`, `classifyShape`; populate per-source `shapes`)
- Modify: `tests/bench/impact-score.test.ts` (add `shapes` to the hand-built `OracleSource` literals so they still compile)
- Test: `tests/bench/impact-oracle.test.ts` (focused `classifyShape` test)

**Interfaces:**
- Produces:
  - `type Shape = 'call' | 'member' | 'namespace' | 'jsx' | 'heritage' | 'bare-value' | 'property-unknown' | 'other'`
  - `interface OracleSource { readonly name: string; readonly position: 'value' | 'type' | 'both'; readonly shapes: readonly Shape[] }`
  - `classifyShape(sf: ts.SourceFile, pos: number, checker: ts.TypeChecker): Shape` (exported)
  - `buildReferenceOracle` unchanged signature; each `OracleSource` now carries `shapes` (the value-reference shapes that source uses; empty for a type-only source).

- [ ] **Step 1: Add the `Shape` type and extend `OracleSource` in `bench/impact-types.ts`**

Replace the current `OracleSource` interface (top of file) with:

```ts
export type Shape =
  | 'call'
  | 'member'
  | 'namespace'
  | 'jsx'
  | 'heritage'
  | 'bare-value'
  | 'property-unknown'
  | 'other'

export interface OracleSource {
  readonly name: string
  readonly position: 'value' | 'type' | 'both'
  readonly shapes: readonly Shape[]
}
```

- [ ] **Step 2: Keep the score test compiling — add `shapes` to its hand-built `OracleSource` literals**

In `tests/bench/impact-score.test.ts`, the `buckets 'both'-position sources…` test builds an `OracleTarget[]` with `{ name, position }` sources. `shapes` is now required. Update those three literals:

```ts
      const oracle: OracleTarget[] = [
        { target: 'synthetic#Both', trueSources: [{ name: 'synthetic#User', position: 'both', shapes: ['member'] }] },
        { target: 'synthetic#TypeOnly', trueSources: [{ name: 'synthetic#User', position: 'type', shapes: [] }] },
        { target: 'synthetic#Value', trueSources: [{ name: 'synthetic#User', position: 'value', shapes: ['namespace'] }] },
      ]
```

- [ ] **Step 3: Write the focused `classifyShape` test**

In `tests/bench/impact-oracle.test.ts`, add `classifyShape` to the existing oracle import:

```ts
import { buildReferenceOracle, classifyPosition, classifyShape, createTsProject } from '../../bench/impact-oracle.js'
```

Then append this `describe` block (after the existing `classifyPosition` block). It builds ONE tsc program (receiver resolution needs a real checker) and locates each reference by its single non-import, non-declaration-name occurrence:

```ts
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
      'export function outer(): unknown {',
      '  const g = bareFn',
      '  return [api.nsFn(), obj.omFn(), plainFn(), helperFn().ghostProp, bag[keyVar], g, new Holder(), <CompFn />, WidgetX]',
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

  const cases: ReadonlyArray<{ needle: string; expected: string }> = [
    { needle: 'nsFn', expected: 'namespace' }, // api.nsFn() — receiver is `import * as api`
    { needle: 'omFn', expected: 'member' }, // obj.omFn() — receiver is a local const
    { needle: 'hitFn', expected: 'member' }, // this.hitFn()
    { needle: 'plainFn', expected: 'call' }, // plainFn()
    { needle: 'CompFn', expected: 'jsx' }, // <CompFn />
    { needle: 'BaseCls', expected: 'heritage' }, // class WidgetX extends BaseCls
    { needle: 'bareFn', expected: 'bare-value' }, // const g = bareFn
    { needle: 'ghostProp', expected: 'property-unknown' }, // helperFn().ghostProp — receiver is a call
    { needle: 'keyVar', expected: 'other' }, // bag[keyVar] — element access
  ]
  for (const c of cases) {
    test(`classifies ${c.needle} as ${c.expected}`, () => {
      expect(classifyShape(sf, posOf(c.needle), checker)).toBe(c.expected)
    })
  }
})
```

- [ ] **Step 4: Run the tests — verify they fail**

Run: `bun test tests/bench/impact-oracle.test.ts`
Expected: FAIL — `classifyShape` is not exported yet (import error / undefined).

- [ ] **Step 5: Implement `classifyReceiver` + `classifyShape` in `bench/impact-oracle.ts`**

Update the type import to add `Shape`:

```ts
import type { OracleSource, OracleTarget, Shape } from './impact-types.js'
```

Add these two functions immediately after `classifyPosition` (which ends with `return 'value'\n}`):

```ts
// Classify the receiver of a property access: an `import * as ns` binding is a namespace
// reference (B5); `this` or a local value/parameter/variable is a member reference (B2);
// an unresolved receiver is neutral `property-unknown` (never biases a candidate bucket).
const classifyReceiver = (receiver: ts.Expression, checker: ts.TypeChecker): Shape => {
  if (receiver.kind === ts.SyntaxKind.ThisKeyword) return 'member'
  const symbol = checker.getSymbolAtLocation(receiver)
  if (symbol === undefined) return 'property-unknown'
  const declarations = symbol.declarations ?? []
  if (declarations.some((d) => ts.isNamespaceImport(d))) return 'namespace'
  return 'member'
}

// Classify a VALUE-position reference by its syntactic form — the reason code_impact does or
// does not resolve it. Only called for refs classifyPosition labelled 'value'. Heritage is
// checked first (a class's `extends` base sits under an ExpressionWithTypeArguments); then JSX
// tag, property-access (member/namespace via the receiver), element-access, bare call, and
// finally a bare value identifier.
export const classifyShape = (sf: ts.SourceFile, pos: number, checker: ts.TypeChecker): Shape => {
  const node = nodeAtPosition(sf, pos)
  for (let a: ts.Node | undefined = node; a !== undefined && !ts.isSourceFile(a); a = a.parent) {
    if (ts.isHeritageClause(a)) return 'heritage'
  }
  const parent = node.parent
  if (
    parent !== undefined &&
    (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) &&
    parent.tagName === node
  ) {
    return 'jsx'
  }
  if (parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return classifyReceiver(parent.expression, checker)
  }
  if (parent !== undefined && ts.isElementAccessExpression(parent)) return 'other'
  if (parent !== undefined && ts.isCallExpression(parent) && parent.expression === node) return 'call'
  return 'bare-value'
}
```

- [ ] **Step 6: Populate per-source `shapes` in `buildReferenceOracle`**

In `bench/impact-oracle.ts`, in `buildReferenceOracle`, add a checker beside the existing project construction:

```ts
  const { program, service } = createTsProject(opts.tsconfigPath)
  const checker = program.getTypeChecker()
```

Then replace the `byName` aggregation block and the `trueSources` mapping (the `const byName = new Map…` through the `return { target: symbol.qualifiedName, trueSources }`) with:

```ts
    const byName = new Map<string, { value: boolean; type: boolean; shapes: Set<Shape> }>()
    for (const entry of entries) {
      const sf = program.getSourceFile(entry.fileName)
      if (sf === undefined) continue
      const pos = entry.textSpan.start
      const line = sf.getLineAndCharacterOfPosition(pos).line + 1
      const relPath = path.relative(opts.repoRoot, entry.fileName)
      const enclosing = enclosingQualifiedName(db, relPath, line)
      // Exclude module-scope refs (unnameable by code_impact) and self-references.
      if (enclosing === null || enclosing === symbol.qualifiedName) continue
      const position = classifyPosition(sf, pos)
      const agg = byName.get(enclosing) ?? { value: false, type: false, shapes: new Set<Shape>() }
      if (position === 'value') {
        agg.value = true
        agg.shapes.add(classifyShape(sf, pos, checker))
      } else {
        agg.type = true
      }
      byName.set(enclosing, agg)
    }
    const trueSources: readonly OracleSource[] = [...byName].map(([name, agg]) => ({
      name,
      position: agg.value && agg.type ? 'both' : agg.value ? 'value' : 'type',
      shapes: [...agg.shapes],
    }))
    return { target: symbol.qualifiedName, trueSources }
```

- [ ] **Step 7: Run the tests — verify they pass**

Run: `bun test tests/bench/impact-oracle.test.ts tests/bench/impact-score.test.ts`
Expected: PASS (all 9 `classifyShape` cases; existing oracle + score tests unaffected).

- [ ] **Step 8: Typecheck + lint + format**

Run: `bun run typecheck && bun run lint && bun run format:check`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add bench/impact-types.ts bench/impact-oracle.ts tests/bench/impact-oracle.test.ts tests/bench/impact-score.test.ts
git commit -m "feat(bench): classify each true reference by value-position shape"
```

---

## Task 2: Scorer — value-FN by shape (diagnostic)

Bucket value-position false-negatives by shape and surface them on the report + run log. Diagnostic only — the gated scalar is untouched.

**Files:**
- Modify: `bench/impact-types.ts` (two report fields)
- Modify: `bench/impact-score.ts` (per-shape accumulation)
- Modify: `bench/impact-run.ts` (print the by-shape diagnostic)
- Modify: `tests/bench/impact-compare.test.ts` (add the two fields to its `ImpactBenchReport` literal)
- Test: `tests/bench/impact-score.test.ts` (by-shape assertions + `reportWithTargetsScored` literal)

**Interfaces:**
- Consumes: `Shape`, per-source `shapes` (Task 1).
- Produces: `ImpactBenchReport` gains `valueTrueReferenceCountByShape` and `valueFalseNegativesByShape` (`Readonly<Record<string, number>>`, overlapping buckets — a source counts in every shape it uses).

- [ ] **Step 1: Add by-shape assertions to the score test**

In `tests/bench/impact-score.test.ts`, inside the `buckets 'both'-position sources…` test, after the existing `expect(report.falseNegatives).toBe(3)` line (before the `finally`), add:

```ts
      // Overlapping by-shape buckets: 'both'→member, 'value'→namespace, both uncovered → FN.
      expect(report.valueFalseNegativesByShape.member).toBe(1)
      expect(report.valueFalseNegativesByShape.namespace).toBe(1)
      expect(report.valueTrueReferenceCountByShape.member).toBe(1)
      expect(report.valueTrueReferenceCountByShape.namespace).toBe(1)
      // The type-only source contributes no shape.
      expect(report.valueFalseNegativesByShape.jsx ?? 0).toBe(0)
```

Then extend the `reportWithTargetsScored` helper literal (below the describe) — add the two fields immediately before `perTarget: [],`:

```ts
  valueTrueReferenceCountByShape: {},
  valueFalseNegativesByShape: {},
```

- [ ] **Step 2: Add the two fields to the compare test's report literal**

In `tests/bench/impact-compare.test.ts`, in the `report` helper, add the two fields immediately before `perTarget: [],`:

```ts
  valueTrueReferenceCountByShape: {},
  valueFalseNegativesByShape: {},
```

- [ ] **Step 3: Run the score test — verify it fails**

Run: `bun test tests/bench/impact-score.test.ts`
Expected: FAIL — `valueFalseNegativesByShape` does not exist on the report yet.

- [ ] **Step 4: Extend `ImpactBenchReport` in `bench/impact-types.ts`**

Add these two fields to `ImpactBenchReport` immediately before `perTarget`:

```ts
  readonly valueTrueReferenceCountByShape: Readonly<Record<string, number>>
  readonly valueFalseNegativesByShape: Readonly<Record<string, number>>
```

- [ ] **Step 5: Accumulate per-shape buckets in `bench/impact-score.ts`**

Add two fields to the `TargetTally` interface (after `typeFalseNegatives`):

```ts
  readonly valueTrueByShape: Readonly<Record<string, number>>
  readonly valueFalseNegativesByShape: Readonly<Record<string, number>>
```

In `scoreTarget`, add two accumulators beside the existing `let typeFalseNegatives = 0`:

```ts
  const valueTrueByShape: Record<string, number> = {}
  const valueFalseNegativesByShape: Record<string, number> = {}
```

Inside the `for (const source of entry.trueSources)` loop, in the `if (source.position === 'value' || source.position === 'both')` branch, after `if (!covered) valueFalseNegatives += 1`, add:

```ts
      for (const shape of source.shapes) {
        valueTrueByShape[shape] = (valueTrueByShape[shape] ?? 0) + 1
        if (!covered) valueFalseNegativesByShape[shape] = (valueFalseNegativesByShape[shape] ?? 0) + 1
      }
```

Add the two records to the returned `TargetTally` object (after `typeFalseNegatives,`):

```ts
    valueTrueByShape,
    valueFalseNegativesByShape,
```

In `scoreImpact`, add two aggregate records beside the existing `let typeFalseNegatives = 0`:

```ts
  const valueTrueReferenceCountByShape: Record<string, number> = {}
  const valueFalseNegativesByShape: Record<string, number> = {}
```

Inside the `for (const entry of oracle)` loop, after the `for (const [confidence, count] of Object.entries(tally.fpByConfidence))` block, add:

```ts
    for (const [shape, count] of Object.entries(tally.valueTrueByShape)) {
      valueTrueReferenceCountByShape[shape] = (valueTrueReferenceCountByShape[shape] ?? 0) + count
    }
    for (const [shape, count] of Object.entries(tally.valueFalseNegativesByShape)) {
      valueFalseNegativesByShape[shape] = (valueFalseNegativesByShape[shape] ?? 0) + count
    }
```

Add the two fields to the returned report object, immediately before `perTarget`:

```ts
    valueTrueReferenceCountByShape,
    valueFalseNegativesByShape,
```

- [ ] **Step 6: Print the by-shape diagnostic in `bench/impact-run.ts`**

In `bench/impact-run.ts`, in the `if (args.baseline !== null && existsSync(args.baseline))` block, after the `typeFalseNegativeRate` `console.error(...)` call, add:

```ts
    console.error(
      `valueFalseNegativesByShape (diagnostic): ${JSON.stringify(report.valueFalseNegativesByShape)} of ${JSON.stringify(report.valueTrueReferenceCountByShape)}`,
    )
```

- [ ] **Step 7: Run the score test + typecheck — verify pass**

Run: `bun test tests/bench/impact-score.test.ts tests/bench/impact-compare.test.ts && bun run typecheck`
Expected: PASS / clean.

- [ ] **Step 8: Verify the existing gates are still green (no gated-number change)**

Run: `bun run bench:impact:check`
Expected: exit 0; `valueFalseNegativeRate` delta `0.0000`; the new `valueFalseNegativesByShape (diagnostic)` line prints. (By-shape is diagnostic — the gated scalar is unchanged, so no re-freeze here.)

- [ ] **Step 9: Commit**

```bash
git add bench/impact-types.ts bench/impact-score.ts bench/impact-run.ts tests/bench/impact-score.test.ts tests/bench/impact-compare.test.ts
git commit -m "feat(bench): bucket value-position false-negatives by reference shape"
```

---

## Task 3: Broaden the oracle target set to `member` tier

Make B2 measurable by scoring methods, not just exported symbols. codeindex must stay byte-identical (0 members); papai re-baselines.

**Files:**
- Modify: `bench/impact-oracle.ts` (`loadExportedSymbols` → `loadScoredSymbols`, wider `WHERE`)
- Modify: `bench/impact-baseline.papai.json` (regenerate — sibling `../papai` required)
- Modify: `bench/impact-baseline.json` (regenerate — must be byte-identical)

**Interfaces:**
- Modifies: the internal `loadExportedSymbols(db)` helper — same row shape, `WHERE scope_tier IN ('exported','member')`. No public-interface change.

- [ ] **Step 1: Widen the scored-symbol query in `bench/impact-oracle.ts`**

Rename `loadExportedSymbols` to `loadScoredSymbols` and widen its `WHERE`. Replace:

```ts
const loadExportedSymbols = (db: Database): readonly DbExportedSymbol[] =>
  db
    .query<{ qualified_name: string; local_name: string; file_path: string; start_line: number }, []>(
      `SELECT qualified_name, local_name, file_path, start_line
       FROM symbols WHERE scope_tier = 'exported' ORDER BY qualified_name`,
    )
```

with:

```ts
// Scored targets are `exported` symbols PLUS `member`-tier methods. Members are included so
// this.method() / obj.method() misses (B2) are measurable — they resolve to member-tier symbols
// that exported-only scoring never saw. Functional repos (0 members) are unaffected.
const loadScoredSymbols = (db: Database): readonly DbExportedSymbol[] =>
  db
    .query<{ qualified_name: string; local_name: string; file_path: string; start_line: number }, []>(
      `SELECT qualified_name, local_name, file_path, start_line
       FROM symbols WHERE scope_tier IN ('exported', 'member') ORDER BY qualified_name`,
    )
```

Then update its one call site in `buildReferenceOracle`:

```ts
  const symbols = loadScoredSymbols(db)
```

- [ ] **Step 2: Typecheck + run the bench tests**

Run: `bun run typecheck && bun test tests/bench/impact-oracle.test.ts tests/bench/impact-score.test.ts`
Expected: clean / PASS (the fixtures in those tests are functional or class-based; the query change does not break them).

- [ ] **Step 3: Re-freeze the codeindex baseline — MUST be byte-identical**

Confirm the baseline is committed-clean first, regenerate, then diff:
```bash
git diff --exit-code bench/impact-baseline.json && echo "clean before regen"
bun run bench:impact:check --update-baseline
git diff --stat bench/impact-baseline.json
```
Expected: `git diff --stat` shows **no change** to `bench/impact-baseline.json` (codeindex has 0 member-tier symbols, so the scored set and every number are identical). If it changed, STOP — the broadening leaked something; investigate before continuing (do not commit a shifted codeindex baseline). Do not use `git stash` here — it would disturb the untracked working tree.

- [ ] **Step 4: Re-freeze the papai baseline (member bucket now populated)**

Requires the `../papai` sibling checkout. Run:
```bash
bun run bench:impact:papai --update-baseline
git diff --stat bench/impact-baseline.papai.json
```
Expected: `bench/impact-baseline.papai.json` **changes** — `valueFalseNegativeRate` shifts as ~member methods enter the alphabetical 300-target sample. The run also prints `valueFalseNegativesByShape (diagnostic)` with a non-zero `member` entry (record this line for the Task 5 memo).

- [ ] **Step 5: Confirm both gates pass against the fresh baselines**

Run: `bun run bench:impact:check && bun run bench:impact:papai`
Expected: both exit 0 with `valueFalseNegativeRate` delta `0.0000`.

- [ ] **Step 6: Commit**

```bash
git add bench/impact-oracle.ts bench/impact-baseline.papai.json bench/impact-baseline.json
git commit -m "feat(bench): score member-tier targets so B2 (member calls) is measurable"
```

---

## Task 4: Committed fixture corpus + gate

A deterministic TSX+class fixture exercising every shape, gated in `check:bench`.

**Files:**
- Create: `bench/fixtures/impact-demo/.codeindex.json`
- Create: `bench/fixtures/impact-demo/tsconfig.json`
- Create: `bench/fixtures/impact-demo/src/button.tsx`
- Create: `bench/fixtures/impact-demo/src/base.ts`
- Create: `bench/fixtures/impact-demo/src/plain.ts`
- Create: `bench/fixtures/impact-demo/src/ns-target.ts`
- Create: `bench/fixtures/impact-demo/src/bare.ts`
- Create: `bench/fixtures/impact-demo/src/app.tsx`
- Create: `bench/impact-baseline.fixture.json` (generated)
- Modify: `package.json` (`bench:impact:fixture`, `bench:impact:fixture:check`; fold into `check:bench`)

**Interfaces:**
- Consumes: `bench/impact-run.ts` (unchanged — invoked with `--repo bench/fixtures/impact-demo`).
- Produces: `bench/impact-baseline.fixture.json` (same `ImpactBaseline` shape as the others); the `bench:impact:fixture:check` gate.

- [ ] **Step 1: Create the fixture config + tsconfig**

`bench/fixtures/impact-demo/.codeindex.json`:

```json
{
  "roots": ["src"],
  "languages": ["ts", "tsx"],
  "logQueries": false
}
```

`bench/fixtures/impact-demo/tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "react-jsx"
  },
  "include": ["src"]
}
```

- [ ] **Step 2: Create the fixture source files**

`bench/fixtures/impact-demo/src/button.tsx`:

```tsx
export function Button(): null {
  return null
}
```

`bench/fixtures/impact-demo/src/base.ts`:

```ts
export class Base {}

export interface Iface {
  readonly id: number
}
```

`bench/fixtures/impact-demo/src/plain.ts`:

```ts
export function plainCalled(): number {
  return 1
}
```

`bench/fixtures/impact-demo/src/ns-target.ts`:

```ts
export function nsCalled(): number {
  return 1
}
```

`bench/fixtures/impact-demo/src/bare.ts`:

```ts
export function bareUsed(): number {
  return 1
}
```

`bench/fixtures/impact-demo/src/app.tsx` — every reference lives inside a named symbol so its enclosing source is nameable:

```tsx
import { Button } from './button'
import { Base, Iface } from './base'
import { plainCalled } from './plain'
import { bareUsed } from './bare'
import * as ns from './ns-target'

// jsx (B1, resolved) + call (resolved) + namespace (B5, missed) + bare-value (missed).
export function Screen(): unknown {
  const g = bareUsed
  return [<Button />, plainCalled(), ns.nsCalled(), g]
}

// heritage `extends` (B3, resolved value) + `implements` (type — B7 diagnostic).
export class Widget extends Base implements Iface {
  readonly id = 1
}

// member (B2, missed): a scored method referenced via `this`.
export class Panel {
  helper(): number {
    return 1
  }
  render(): number {
    return this.helper()
  }
}
```

- [ ] **Step 3: Add the fixture scripts to `package.json`**

In `scripts`, add after the `bench:impact:papai` line:

```json
    "bench:impact:fixture": "bun run bench/impact-run.ts --repo bench/fixtures/impact-demo",
    "bench:impact:fixture:check": "bun run bench/impact-run.ts --repo bench/fixtures/impact-demo --baseline bench/impact-baseline.fixture.json",
```

- [ ] **Step 4: Generate the fixture baseline**

Run:
```bash
bun run bench:impact:fixture:check --update-baseline
cat bench/impact-baseline.fixture.json
```
Expected: writes `bench/impact-baseline.fixture.json`. Confirm `valueFalseNegativeRate` is **0.5** (6 value sources: jsx/call/heritage covered, namespace/bare-value/member missed → 3/6). The printed `valueFalseNegativesByShape` should read `{"namespace":1,"bare-value":1,"member":1}`. If `member` is absent, the `Panel>helper` target is not being scored — re-check Task 3 landed (member-tier scoring) before proceeding.

- [ ] **Step 5: Fold the fixture gate into `check:bench`**

In `package.json`, replace the `check:bench` script:

```json
    "check:bench": "bun run bench:check && bun run bench:index:check && bun run bench:impact:check && bun run bench:impact:fixture:check",
```

- [ ] **Step 6: Verify the fixture gate + full check are green**

Run: `bun run bench:impact:fixture:check`
Expected: exit 0; `valueFalseNegativeRate` delta `0.0000`.

Run: `bun run check:bench`
Expected: all four gates exit 0.

- [ ] **Step 7: Commit**

```bash
git add bench/fixtures/impact-demo package.json bench/impact-baseline.fixture.json
git commit -m "feat(bench): committed fixture corpus gating B1/B3 in check:bench"
```

---

## Task 5: Demonstration test + re-rank memo

Prove (as a live assertion) that B1/B3 zero their buckets while member/namespace/bare-value stay lit, then record the ranked evidence that opens Slice 4.

**Files:**
- Create: `tests/bench/impact-fixture.test.ts`
- Modify: `docs/superpowers/specs/2026-07-24-phase2-slice3-prove-and-rerank-design.md` (append the memo section)

**Interfaces:**
- Consumes: `indexCodebase`, `openDatabase`, `loadCodeindexConfig`, `buildReferenceOracle`, `scoreImpact` (all existing).

- [ ] **Step 1: Write the demonstration test**

`tests/bench/impact-fixture.test.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import path from 'node:path'

import { buildReferenceOracle } from '../../bench/impact-oracle.js'
import { scoreImpact } from '../../bench/impact-score.js'
import { loadCodeindexConfig } from '../../src/config.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import { openDatabase } from '../../src/storage/db.js'

const repoRoot = path.join(import.meta.dir, '../../bench/fixtures/impact-demo')

afterAll(() => {
  rmSync(path.join(repoRoot, '.codeindex'), { recursive: true, force: true })
})

describe('impact-demo fixture', () => {
  test('B1/B3 zero the jsx & heritage value-FN buckets; member/namespace/bare-value stay lit', async () => {
    const config = await loadCodeindexConfig({
      configPath: path.join(repoRoot, '.codeindex.json'),
      repoRoot,
    })
    await indexCodebase({ config, mode: 'full' })
    const db = openDatabase(config.dbPath)
    try {
      const oracle = buildReferenceOracle(db, {
        repoRoot,
        tsconfigPath: path.join(repoRoot, 'tsconfig.json'),
      })
      const report = scoreImpact(db, oracle, 'impact-demo')
      // B1/B3: jsx and heritage references are present and fully covered (zero FN).
      expect(report.valueTrueReferenceCountByShape.jsx).toBe(1)
      expect(report.valueFalseNegativesByShape.jsx ?? 0).toBe(0)
      expect(report.valueTrueReferenceCountByShape.heritage).toBe(1)
      expect(report.valueFalseNegativesByShape.heritage ?? 0).toBe(0)
      // The ranked remaining work is lit and separated.
      expect(report.valueFalseNegativesByShape.member).toBeGreaterThan(0)
      expect(report.valueFalseNegativesByShape.namespace).toBeGreaterThan(0)
      expect(report.valueFalseNegativesByShape['bare-value']).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })
})
```

- [ ] **Step 2: Run the demonstration test — verify pass**

Run: `bun test tests/bench/impact-fixture.test.ts`
Expected: PASS — jsx/heritage covered (FN 0), member/namespace/bare-value FN > 0. (This is genuinely RED without Tasks 1–4; run it to confirm the wins wire through and the shapes separate.)

- [ ] **Step 3: Collect the by-shape numbers for the memo**

Run each and note the `valueFalseNegativesByShape (diagnostic)` / `valueTrueReferenceCountByShape` line:
```bash
bun run bench:impact:fixture:check 2>&1 | grep -E 'valueFalseNegativesByShape|valueFalseNegativeRate'
bun run bench:impact:check 2>&1 | grep -E 'valueFalseNegativesByShape|valueFalseNegativeRate'
bun run bench:impact:papai 2>&1 | grep -E 'valueFalseNegativesByShape|valueFalseNegativeRate'
```
Expected: three by-shape maps (fixture, codeindex, papai). codeindex's `member`/`namespace` are the real-distribution read (biased alphabetical prefix); papai's `member` is now non-zero.

- [ ] **Step 4: Append the re-rank memo to the design spec**

Append this section to `docs/superpowers/specs/2026-07-24-phase2-slice3-prove-and-rerank-design.md` (fill the bracketed numbers from Step 3 — do not leave brackets):

```markdown
---

## Reassessment Gate: Slice 3 → 4 (recorded 2026-07-24)

Value-FN by reference shape (FN / true-refs), from `valueFalseNegativesByShape` over
`valueTrueReferenceCountByShape`. Real-repo rows use the biased alphabetical-prefix sample
(strided/seeded sampling deferred — the memo's primary caveat).

| Repo | member (B2) | namespace (B5) | bare-value | jsx (B1) | heritage (B3) | call |
|---|---|---|---|---|---|---|
| impact-demo (fixture) | 1/1 | 1/1 | 1/1 | 0/1 | 0/1 | 0/1 |
| codeindex | [fill] | [fill] | [fill] | [fill] | [fill] | [fill] |
| papai (300, exported+member) | [fill] | [fill] | [fill] | [fill] | [fill] | [fill] |

**Reading / ranking for Slice 4:**

- **B1/B3 demonstrated:** jsx and heritage FN are **0** on the fixture (covered), proving the Slice 2
  edges land end-to-end. [Note codeindex/papai jsx/heritage — expected ~0 or absent given corpus.]
- **B2 vs B5 (the head-to-head this slice unlocked):** [state which of member / namespace carries the
  larger measured FN mass on papai, with the numbers].
- **Graph-unrecoverable residue:** `bare-value` + `property-unknown` FN — [size it]; no planned edge
  type recovers these, so they bound the achievable value-FN floor.
- **Opens Slice 4 with:** [the ranked candidate — e.g. "B5 leads on measured papai contribution" — as
  the evidence writing-plans consumes; not a pre-drawn order].

**Caveats:** real-repo rows are an alphabetical-prefix sample (biased, documented in
`impact-oracle.ts`); papai's member tier skews toward test-stub methods that sort early. Directional,
not a population estimate.
```

- [ ] **Step 5: Run the full check — verify everything green**

Run: `bun run check`
Expected: lint, typecheck, format, test (now including `impact-fixture.test.ts`), and the four bench gates all pass.

- [ ] **Step 6: Commit**

```bash
git add tests/bench/impact-fixture.test.ts docs/superpowers/specs/2026-07-24-phase2-slice3-prove-and-rerank-design.md
git commit -m "test(bench): demonstrate B1/B3 on fixture; record Slice 3->4 re-rank memo"
```

---

## Self-Review

**1. Spec coverage** (`docs/superpowers/specs/2026-07-24-phase2-slice3-prove-and-rerank-design.md`):

- Unit 1 shape classifier (`Shape`, `classifyShape`, member/namespace via receiver, `property-unknown` fail-safe, exported for test) → Task 1. ✓
- Unit 2 value-FN by shape (overlapping buckets, diagnostic-only, not in gated baseline, run-log print) → Task 2. ✓
- Unit 3 broaden target set to `exported`+`member`; codeindex byte-identical; papai re-baseline → Task 3. ✓
- Unit 4 committed fixture corpus (member case = `this.helper()` method target), scripts, gitignored DB, folded into `check:bench` → Task 4. ✓
- Demonstration test (jsx/heritage == 0, member/namespace/bare-value > 0) → Task 5 Step 1. ✓
- Re-rank memo (fixture + both real repos, sampling caveat, ranks B2 vs B5) → Task 5 Step 4. ✓
- Exit criteria: classifyShape exported + tested (T1), by-shape on report printed (T2), target set broadened + baselines re-frozen (T3), fixture gated in check (T4), demonstration + memo (T5), `typescript` bench-only + no `src/` change (Global Constraints; guard untouched). ✓

**2. Placeholder scan:** the memo table's `[fill]` / bracketed readings in Task 5 Step 4 are **runtime data**, captured in Step 3 and required to be filled before the Step 6 commit — not code placeholders. Every code step is concrete.

**3. Type consistency:** `Shape` (T1) consumed by the scorer buckets (T2) and the report fields (T2); `OracleSource.shapes` (T1) read in `scoreTarget` (T2); `valueTrueReferenceCountByShape` / `valueFalseNegativesByShape` named identically across `impact-types.ts`, `impact-score.ts`, `impact-run.ts`, and both tests; `loadScoredSymbols` (T3) replaces `loadExportedSymbols` at its single call site; `bench:impact:fixture:check` (T4) referenced in `check:bench` (T4) and the memo collection (T5).

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-24-phase2-slice3-prove-and-rerank.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batched with checkpoints for review.

Which approach?
