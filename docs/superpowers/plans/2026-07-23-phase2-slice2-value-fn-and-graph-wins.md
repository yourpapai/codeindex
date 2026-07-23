# Phase 2 Slice 2 — Value-FN Breakdown + Certain Graph Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the `code_impact` false-negative metric into a gated `valueFalseNegativeRate` and a diagnostic `typeFalseNegativeRate`, then bank the two zero-FP graph wins (JSX usage edges, class `extends`/`implements` edges) so the value-FN visibly drops on papai.

**Architecture:** Unchanged shipped resolver. The bench oracle (raw `typescript`) now classifies each true reference value-position vs type-position; the scorer buckets false-negatives accordingly and gates on the value bucket. Two new reference kinds are produced by `src/indexer/extract-references.ts` alone — the resolver/indexer/schema carry arbitrary edge types unchanged, so the wins are purely additive.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, web-tree-sitter (ts/tsx/js/jsx grammars in `src/`), raw `typescript` LanguageService (bench-only), zod, oxlint/oxfmt, `bun test`.

## Global Constraints

- **`typescript` stays bench-only.** `src/` uses only web-tree-sitter; never import `typescript` or construct a TS checker in `src/`. The existing guard `tests/bench/impact-guard.test.ts` enforces this — it must stay green.
- **No schema change.** `symbol_references.edge_type` is free-form `TEXT` (no CHECK); new edge types `references` / `extends` / `implements` persist with no migration. Do **not** bump `SCHEMA_VERSION`.
- **Gate semantics:** no-regression, tolerance `1e-9`. After this slice the gated field is **`valueFalseNegativeRate`** (an increase past tolerance fails); total FN, `typeFalseNegativeRate`, and FP-by-tier are diagnostics (printed, not gated).
- **`'both'`-position sources count as value.** A source that references the target in both a value and a type position lands in the value denominator; the type diagnostic counts **type-only** sources (this is the correct B7 sizing, and the gated `valueFN` is invariant to the choice).
- **Classifier fail-safe:** when position is uncertain, default to `value` (never hide a value false-negative).
- **oxlint (denyWarnings):** no unsafe type assertions — validate JSON via `ImpactBaselineSchema.parse`, never `as`. Imperative `let`/`for` is gate-clean (no functional plugin), and the files edited here already use it — match the surrounding style.
- **Baselines:** generate-slow / commit-JSON / gate-fast. Re-freeze `bench/impact-baseline.json` (codeindex) and `bench/impact-baseline.papai.json` (papai) whenever the metric shape or the produced edges change. The papai oracle run takes ~30s and needs the `../papai` sibling checked out.
- **Commits:** one per task, into the current branch (`master`), conventional-commit style.

## Pre-flight reconciliation (memo of record)

Roadmap-mandated reconciliation of the dead "tier1" scaffolding. Decisions recorded here; **only the `extends`/`implements` edge types are acted on this slice** (activated by Task 5). The rest intersect deferred work and are reconciled when that work lands.

| Dead-scaffolding item | Decision | Acted on in Slice 2? |
|---|---|---|
| `edge_type` `extends` / `implements` (modeled, never produced) | **Keep — activate** | **Yes (Task 5)** |
| `module_exports.resolved_file_id` (always NULL) | Decide at the barrels/namespaces slice (B4) | No |
| `symbols.is_exported` (written, never read) | Lean drop; confirm at that slice's pre-flight | No |
| `symbols.start_byte` / `end_byte` (written, never selected) | Lean drop — UTF-8 byte offsets ≠ TS UTF-16 positions (Slice 1 finding), so not a drop-in position source | No |
| `module_aliases.precedence` (written, never breaks a tie) | Decide at the resolution slice | No |

---

## Task 1: Oracle — value/type position classifier + `OracleSource`

Teach the oracle to label each true reference value-position vs type-position. The classifier is the trust-critical logic; a fixture test pins it against real tsc output.

**Files:**
- Modify: `bench/impact-types.ts` (`OracleSource`, `OracleTarget.trueSources` shape)
- Modify: `bench/impact-oracle.ts` (add `nodeAtPosition`, `classifyPosition`; aggregate per source)
- Modify: `bench/impact-score.ts` (read `s.name` — keep total-FN behavior; value/type added in Task 2)
- Test: `tests/bench/impact-oracle.test.ts` (update `.name`; add a heritage classification test)

**Interfaces:**
- Produces:
  - `interface OracleSource { readonly name: string; readonly position: 'value' | 'type' | 'both' }`
  - `interface OracleTarget { readonly target: string; readonly trueSources: readonly OracleSource[] }`
  - `buildReferenceOracle(db, opts)` — unchanged signature; each `trueSources` element is now an `OracleSource`.

- [ ] **Step 1: Update the two existing oracle assertions to the new shape**

In `tests/bench/impact-oracle.test.ts`, both existing tests assert `foo!.trueSources.some((s) => s.endsWith('#bar'))` (and `#unrelatedHolder`). Change each `s` to `s.name`:

```ts
expect(foo!.trueSources.some((s) => s.name.endsWith('#bar'))).toBe(true)
```
```ts
expect(foo!.trueSources.some((s) => s.name.endsWith('#bar'))).toBe(true)
expect(foo!.trueSources.some((s) => s.name.endsWith('#unrelatedHolder'))).toBe(false)
```

- [ ] **Step 2: Add a classification test (append inside the `buildReferenceOracle` describe block)**

```ts
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
    JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', strict: true }, include: ['src'] }),
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
```

- [ ] **Step 3: Run the oracle tests — verify they fail**

Run: `bun test tests/bench/impact-oracle.test.ts`
Expected: FAIL — `.name` is undefined on `string` (type error / runtime undefined) and `position` does not exist yet.

- [ ] **Step 4: Update the types in `bench/impact-types.ts`**

Replace the current `OracleTarget` (top of file) with:

```ts
export interface OracleSource {
  readonly name: string
  readonly position: 'value' | 'type' | 'both'
}

export interface OracleTarget {
  readonly target: string
  readonly trueSources: readonly OracleSource[]
}
```

- [ ] **Step 5: Add the classifier and aggregate per source in `bench/impact-oracle.ts`**

Update the import of `OracleTarget` to also pull `OracleSource`:

```ts
import type { OracleSource, OracleTarget } from './impact-types.js'
```

Add these two helpers above `buildReferenceOracle` (the file already `import ts from 'typescript'`):

```ts
// Descend to the innermost node whose span contains `pos` (the reference identifier token).
const nodeAtPosition = (sf: ts.SourceFile, pos: number): ts.Node => {
  const find = (node: ts.Node): ts.Node => {
    const child = node.getChildren(sf).find((c) => pos >= c.getStart(sf) && pos < c.getEnd())
    return child === undefined ? node : find(child)
  }
  return find(sf)
}

// Classify a reference position as value or type. A HeritageClause ANYWHERE up the chain
// decides first: `implements` (and an interface's `extends`) are type; a class's `extends`
// is value — even though its base sits inside an ExpressionWithTypeArguments, which is
// itself a type-node (verified against tsc). Otherwise any type-node ancestor means type.
// Default value: the fail-safe never hides a value false-negative.
const classifyPosition = (sf: ts.SourceFile, pos: number): 'value' | 'type' => {
  const node = nodeAtPosition(sf, pos)
  for (let a: ts.Node | undefined = node; a !== undefined && !ts.isSourceFile(a); a = a.parent) {
    if (ts.isHeritageClause(a)) {
      if (a.token === ts.SyntaxKind.ImplementsKeyword) return 'type'
      return ts.isClassDeclaration(a.parent) || ts.isClassExpression(a.parent) ? 'value' : 'type'
    }
  }
  for (let a: ts.Node | undefined = node; a !== undefined && !ts.isSourceFile(a); a = a.parent) {
    if (ts.isTypeNode(a)) return 'type'
  }
  return 'value'
}
```

Replace the body of the `selected.map((symbol) => { ... })` callback (the `const sources = new Set<string>()` block) with:

```ts
    const absFile = path.resolve(opts.repoRoot, symbol.filePath)
    const offset = declarationOffset(program, absFile, symbol.localName, symbol.startLine)
    const entries = offset === null ? [] : (service.getReferencesAtPosition(absFile, offset) ?? [])
    const byName = new Map<string, { value: boolean; type: boolean }>()
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
      const agg = byName.get(enclosing) ?? { value: false, type: false }
      if (position === 'value') agg.value = true
      else agg.type = true
      byName.set(enclosing, agg)
    }
    const trueSources: readonly OracleSource[] = [...byName].map(([name, agg]) => ({
      name,
      position: agg.value && agg.type ? 'both' : agg.value ? 'value' : 'type',
    }))
    return { target: symbol.qualifiedName, trueSources }
```

- [ ] **Step 6: Keep the scorer compiling (read `s.name`, total-FN behavior preserved)**

In `bench/impact-score.ts`, inside `scoreImpact`'s `oracle.map`, replace the `const truth = new Set(entry.trueSources)` line and its uses:

```ts
    const truthNames = new Set(entry.trueSources.map((s) => s.name))
    const reported = impactSources(db, entry.target)
    const reportedNames = new Set(reported.map((r) => r.name))

    const fn = [...truthNames].filter((n) => !reportedNames.has(n)).length
    const fpRows = reported.filter((r) => !truthNames.has(r.name))
```

and change the two `truth.size` occurrences to `entry.trueSources.length`:

```ts
    trueReferenceCount += entry.trueSources.length
```
```ts
      trueSourceCount: entry.trueSources.length,
```

- [ ] **Step 7: Run the oracle tests — verify they pass**

Run: `bun test tests/bench/impact-oracle.test.ts tests/bench/impact-score.test.ts`
Expected: PASS (heritage test proves `extends`→`value`, `implements`→`type`; score test unchanged behavior).

- [ ] **Step 8: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add bench/impact-types.ts bench/impact-oracle.ts bench/impact-score.ts tests/bench/impact-oracle.test.ts
git commit -m "feat(bench): classify oracle references value vs type position"
```

---

## Task 2: Scorer — value/type false-negative rates + baseline schema

Bucket false-negatives by position and expose the value/type rates through the report, baseline, and zod schema. Migrate the two frozen baselines to the new shape (still gating total FN — the flip is Task 3).

**Files:**
- Modify: `bench/impact-types.ts` (report + baseline + schema fields)
- Modify: `bench/impact-score.ts` (value/type accumulation)
- Modify: `bench/impact-run.ts` (`toBaseline` carries the new fields)
- Modify: `bench/impact-baseline.json`, `bench/impact-baseline.papai.json` (regenerate)
- Test: `tests/bench/impact-score.test.ts` (update the full-report literal; add a value/type assertion)

**Interfaces:**
- Consumes: `OracleSource`, `OracleTarget` (Task 1).
- Produces: `ImpactBenchReport` gains `valueTrueReferenceCount`, `valueFalseNegatives`, `valueFalseNegativeRate`, `typeTrueReferenceCount`, `typeFalseNegatives`, `typeFalseNegativeRate`. `ImpactBaseline` + `ImpactBaselineSchema` gain `valueFalseNegativeRate`, `typeFalseNegativeRate`.

- [ ] **Step 1: Add value/type asserts to the score test**

In `tests/bench/impact-score.test.ts`, inside the existing `scoreImpact` test (after the `baz` asserts, before the `finally`), add:

```ts
      // baz's only true source (qux, via ns.baz()) is a value-position call code_impact
      // misses → it must land in the value bucket, not merely the total.
      expect(report.valueTrueReferenceCount).toBeGreaterThan(0)
      expect(report.valueFalseNegatives).toBeGreaterThanOrEqual(1)
      expect(report.valueFalseNegativeRate).toBeGreaterThan(0)
```

Then update the `reportWithTargetsScored` helper literal (below the describe) to include the six new fields:

```ts
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
  perTarget: [],
})
```

- [ ] **Step 2: Run the score test — verify it fails**

Run: `bun test tests/bench/impact-score.test.ts`
Expected: FAIL — `valueTrueReferenceCount` etc. do not exist on the report yet.

- [ ] **Step 3: Extend the report + baseline types in `bench/impact-types.ts`**

Add the six fields to `ImpactBenchReport` immediately before `perTarget`:

```ts
  readonly valueTrueReferenceCount: number
  readonly valueFalseNegatives: number
  readonly valueFalseNegativeRate: number
  readonly typeTrueReferenceCount: number
  readonly typeFalseNegatives: number
  readonly typeFalseNegativeRate: number
```

Add two fields to `ImpactBaseline`:

```ts
  readonly valueFalseNegativeRate: number
  readonly typeFalseNegativeRate: number
```

Add the same two to `ImpactBaselineSchema`:

```ts
export const ImpactBaselineSchema = z.object({
  targetsScored: z.number(),
  trueReferenceCount: z.number(),
  falseNegatives: z.number(),
  falseNegativeRate: z.number(),
  falsePositiveRate: z.number(),
  valueFalseNegativeRate: z.number(),
  typeFalseNegativeRate: z.number(),
})
```

- [ ] **Step 4: Accumulate value/type FN in `bench/impact-score.ts`**

Add four accumulators beside the existing ones:

```ts
  let valueTrueReferenceCount = 0
  let valueFalseNegatives = 0
  let typeTrueReferenceCount = 0
  let typeFalseNegatives = 0
```

Replace the `const fn = [...truthNames]...` line with a loop that buckets by position:

```ts
    let fn = 0
    for (const source of entry.trueSources) {
      const covered = reportedNames.has(source.name)
      if (!covered) fn += 1
      if (source.position === 'value' || source.position === 'both') {
        valueTrueReferenceCount += 1
        if (!covered) valueFalseNegatives += 1
      } else {
        typeTrueReferenceCount += 1
        if (!covered) typeFalseNegatives += 1
      }
    }
```

Add the six computed fields to the returned report object, immediately before `perTarget`:

```ts
    valueTrueReferenceCount,
    valueFalseNegatives,
    valueFalseNegativeRate: valueTrueReferenceCount === 0 ? 0 : valueFalseNegatives / valueTrueReferenceCount,
    typeTrueReferenceCount,
    typeFalseNegatives,
    typeFalseNegativeRate: typeTrueReferenceCount === 0 ? 0 : typeFalseNegatives / typeTrueReferenceCount,
```

- [ ] **Step 5: Carry the new fields into the frozen baseline in `bench/impact-run.ts`**

Update `toBaseline`:

```ts
const toBaseline = (r: ImpactBenchReport): ImpactBaseline => ({
  targetsScored: r.targetsScored,
  trueReferenceCount: r.trueReferenceCount,
  falseNegatives: r.falseNegatives,
  falseNegativeRate: r.falseNegativeRate,
  falsePositiveRate: r.falsePositiveRate,
  valueFalseNegativeRate: r.valueFalseNegativeRate,
  typeFalseNegativeRate: r.typeFalseNegativeRate,
})
```

- [ ] **Step 6: Run the score test + typecheck — verify pass**

Run: `bun test tests/bench/impact-score.test.ts && bun run typecheck`
Expected: PASS / clean.

- [ ] **Step 7: Regenerate both frozen baselines (new schema, pre-graph-win numbers)**

Run:
```bash
bun run bench:impact:check --update-baseline
bun run bench:impact:papai --update-baseline
```
Expected: each writes its baseline JSON and prints the report. Confirm both files now contain `valueFalseNegativeRate` and `typeFalseNegativeRate`:
```bash
cat bench/impact-baseline.json bench/impact-baseline.papai.json
```
Note the `valueFalseNegativeRate` values — these are the pre-graph-win floors (codeindex's is the project's first real value-FN number).

- [ ] **Step 8: Verify the gate is green against the fresh baselines**

Run: `bun run bench:impact:check`
Expected: exit 0; `falseNegativeRate` delta `0.0000` (still gating total FN until Task 3).

- [ ] **Step 9: Commit**

```bash
git add bench/impact-types.ts bench/impact-score.ts bench/impact-run.ts bench/impact-baseline.json bench/impact-baseline.papai.json tests/bench/impact-score.test.ts
git commit -m "feat(bench): value/type false-negative rates + baseline schema"
```

---

## Task 3: Gate on `valueFalseNegativeRate`

Flip the regression gate from total FN to the value bucket; keep type/total/FP as printed diagnostics.

**Files:**
- Modify: `bench/impact-compare.ts` (gate on `valueFalseNegativeRate`)
- Modify: `bench/impact-run.ts` (gate log)
- Test: `tests/bench/impact-compare.test.ts` (vary `valueFalseNegativeRate`)

**Interfaces:**
- Consumes: `ImpactBenchReport.valueFalseNegativeRate`, `ImpactBaseline.valueFalseNegativeRate` (Task 2).
- Produces: `compareImpact` gates on the value bucket (same `ImpactComparison` shape).

- [ ] **Step 1: Rewrite the compare test literals + assertions**

Replace the `baseline` and `report` literals and both tests in `tests/bench/impact-compare.test.ts`:

```ts
const baseline: ImpactBaseline = {
  targetsScored: 10,
  trueReferenceCount: 100,
  falseNegatives: 30,
  falseNegativeRate: 0.3,
  falsePositiveRate: 0.1,
  valueFalseNegativeRate: 0.5,
  typeFalseNegativeRate: 0.9,
}
const report = (valueFnRate: number): ImpactBenchReport => ({
  repo: 'x',
  targetsScored: 10,
  trueReferenceCount: 100,
  impactReferenceCount: 90,
  falseNegatives: 30,
  falseNegativeRate: 0.3,
  falsePositives: 9,
  falsePositiveRate: 0.1,
  falsePositivesByConfidence: {},
  valueTrueReferenceCount: 50,
  valueFalseNegatives: Math.round(valueFnRate * 50),
  valueFalseNegativeRate: valueFnRate,
  typeTrueReferenceCount: 50,
  typeFalseNegatives: 45,
  typeFalseNegativeRate: 0.9,
  perTarget: [],
})

describe('compareImpact', () => {
  test('value FN rate increasing past tolerance is a regression', () => {
    expect(compareImpact(report(0.55), baseline, 1e-9).regressed).toBe(true)
  })
  test('value FN rate dropping is an improvement, not a regression', () => {
    expect(compareImpact(report(0.4), baseline, 1e-9).regressed).toBe(false)
  })
})
```

- [ ] **Step 2: Run the compare test — verify it fails**

Run: `bun test tests/bench/impact-compare.test.ts`
Expected: FAIL — `compareImpact` still reads `falseNegativeRate` (0.3 vs 0.3 → both report `regressed:false`), so the increasing-value case wrongly returns `false`.

- [ ] **Step 3: Gate on the value bucket in `bench/impact-compare.ts`**

```ts
// Value-position FN going UP means code_impact newly misses more real (value) usages —
// a regression. Type-only FN, total FN, and FP are diagnostics, not gated (Slice 2).
export const compareImpact = (
  report: ImpactBenchReport,
  baseline: ImpactBaseline,
  tolerance: number,
): ImpactComparison => {
  const delta = report.valueFalseNegativeRate - baseline.valueFalseNegativeRate
  return { regressed: delta > tolerance, delta }
}
```

- [ ] **Step 4: Update the gate log in `bench/impact-run.ts`**

Replace the two `console.error` diagnostic lines in the `args.baseline !== null && existsSync` block with:

```ts
    console.error(
      `valueFalseNegativeRate: ${baseline.valueFalseNegativeRate.toFixed(4)} -> ${report.valueFalseNegativeRate.toFixed(4)} (${comparison.delta >= 0 ? '+' : ''}${comparison.delta.toFixed(4)})`,
    )
    console.error(
      `typeFalseNegativeRate (diagnostic, sizes B7): ${report.typeFalseNegativeRate.toFixed(4)} | totalFN ${report.falseNegativeRate.toFixed(4)}`,
    )
    console.error(
      `falsePositiveRate (diagnostic): ${report.falsePositiveRate.toFixed(4)} by confidence ${JSON.stringify(report.falsePositivesByConfidence)}`,
    )
```

- [ ] **Step 5: Run the compare test + the gate — verify pass**

Run: `bun test tests/bench/impact-compare.test.ts && bun run bench:impact:check`
Expected: test PASS; gate exit 0 with `valueFalseNegativeRate` delta `0.0000`.

- [ ] **Step 6: Commit**

```bash
git add bench/impact-compare.ts bench/impact-run.ts tests/bench/impact-compare.test.ts
git commit -m "feat(bench): gate code_impact on value-position false-negative rate"
```

---

## Task 4: B1 — JSX usage edges

Emit a `references` edge from the enclosing symbol to each capitalized JSX component tag. Intrinsic (lowercase) and member-expression (`<Foo.Bar/>`) tags are skipped.

**Files:**
- Modify: `src/indexer/extract-references.ts` (handle `jsx_opening_element` / `jsx_self_closing_element`)
- Test: `tests/indexer/extract-references.test.ts` (tsx cases)

**Interfaces:**
- Consumes: existing `ReferenceCandidate` (its `edgeType` union already includes `references`), `enclosingSymbol` tracking, `importMap` resolution (unchanged).
- Produces: reference candidates with `edgeType: 'references'` for component tags — resolved downstream exactly like a plain call (via the import map / local-name fallback), no resolver change.

- [ ] **Step 1: Write the JSX extraction tests (append to the describe block)**

```ts
test('captures capitalized JSX tags as reference edges; skips intrinsic and member tags', async () => {
  const loader = await createParserLoader()
  const parsed = await loader.createParserForExtension('.tsx')
  const source = [
    "import { Button } from './button.js'",
    'export function App() {',
    '  return <div><Button /><Panel>hi</Panel></div>',
    '}',
  ].join('\n')
  const tree = parsed.parser.parse(source)
  expect(tree).not.toBeNull()
  const { references } = extractReferenceCandidates({
    source,
    tree: tree!,
    relativeFilePath: 'src/app.tsx',
    moduleKey: 'src/app',
  })
  const jsx = references.filter((ref) => ref.edgeType === 'references')
  const names = jsx.map((ref) => ref.targetName)
  expect(names).toContain('Button')
  expect(names).toContain('Panel') // closing tag must NOT double-count
  expect(names.filter((n) => n === 'Panel')).toHaveLength(1)
  expect(names).not.toContain('div')
  expect(jsx.find((ref) => ref.targetName === 'Button')!.sourceQualifiedName).toBe('src/app#App')
})

test('skips member-expression JSX tags (namespace case, deferred to B5)', async () => {
  const loader = await createParserLoader()
  const parsed = await loader.createParserForExtension('.tsx')
  const source = ["import * as UI from './ui.js'", 'export function App() {', '  return <UI.Panel />', '}'].join('\n')
  const tree = parsed.parser.parse(source)
  expect(tree).not.toBeNull()
  const { references } = extractReferenceCandidates({
    source,
    tree: tree!,
    relativeFilePath: 'src/app.tsx',
    moduleKey: 'src/app',
  })
  expect(references.filter((ref) => ref.edgeType === 'references')).toHaveLength(0)
})
```

- [ ] **Step 2: Run the JSX tests — verify they fail**

Run: `bun test tests/indexer/extract-references.test.ts`
Expected: FAIL — no `references`-edge candidates are produced yet (`names` empty).

- [ ] **Step 3: Implement JSX extraction in `src/indexer/extract-references.ts`**

Add a collector above `extractReferenceCandidates`:

```ts
const collectJsxReference = (node: SyntaxNode, enclosingSymbol: string | null, references: ReferenceCandidate[]): void => {
  const nameNode = node.childForFieldName('name')
  // Only bare, capitalized identifiers are component references. Lowercase tags are
  // intrinsic host elements (<div>); member-expression tags (<Foo.Bar/>) are the
  // namespace case, deferred with B5.
  if (nameNode === null || nameNode.type !== 'identifier') return
  const tag = nameNode.text
  const first = tag.charAt(0)
  if (first === '' || first !== first.toUpperCase()) return
  references.push({
    sourceQualifiedName: enclosingSymbol,
    edgeType: 'references',
    targetName: tag,
    targetExportName: null,
    targetModuleSpecifier: null,
    lineNumber: node.startPosition.row + 1,
  })
}
```

Inside the `visit` function, add this handling before the final `visitChildren(node, enclosingSymbol, visit)` call (mirroring how `call_expression` emits then recurses so nested refs in attributes/children are still visited):

```ts
    if (node.type === 'jsx_opening_element' || node.type === 'jsx_self_closing_element') {
      collectJsxReference(node, enclosingSymbol, references)
    }
```

- [ ] **Step 4: Run the JSX tests — verify pass**

Run: `bun test tests/indexer/extract-references.test.ts`
Expected: PASS (both new tests; existing tests unaffected).

- [ ] **Step 5: Typecheck + lint + format**

Run: `bun run typecheck && bun run lint && bun run format:check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/indexer/extract-references.ts tests/indexer/extract-references.test.ts
git commit -m "feat(indexer): emit reference edges for JSX component usage (B1)"
```

---

## Task 5: B3 — `extends` / `implements` edges

Activate the modeled-but-never-produced `extends` (value) and `implements` (type) edge types from class heritage.

**Files:**
- Modify: `src/indexer/extract-references.ts` (handle `extends_clause` / `implements_clause`)
- Test: `tests/indexer/extract-references.test.ts` (heritage case)

**Interfaces:**
- Consumes: `ReferenceCandidate` (its `edgeType` union already includes `extends` / `implements`), `enclosingSymbol` (the class qualified name at the heritage node), `importMap`/local-name resolution (unchanged).
- Produces: one `extends` edge (from the class to its base identifier) and one `implements` edge per implemented interface — resolved downstream like any named reference.

- [ ] **Step 1: Write the heritage extraction test (append to the describe block)**

```ts
test('captures class extends and implements as heritage edges', async () => {
  const loader = await createParserLoader()
  const parsed = await loader.createParserForExtension('.ts')
  const source = [
    "import { Base } from './base.js'",
    "import { Left, Right } from './ifaces.js'",
    'export class Widget extends Base implements Left, Right {}',
  ].join('\n')
  const tree = parsed.parser.parse(source)
  expect(tree).not.toBeNull()
  const { references } = extractReferenceCandidates({
    source,
    tree: tree!,
    relativeFilePath: 'src/widget.ts',
    moduleKey: 'src/widget',
  })
  const ext = references.filter((ref) => ref.edgeType === 'extends')
  expect(ext).toHaveLength(1)
  expect(ext[0]!.targetName).toBe('Base')
  expect(ext[0]!.sourceQualifiedName).toBe('src/widget#Widget')
  const impl = references.filter((ref) => ref.edgeType === 'implements')
  expect(impl.map((ref) => ref.targetName)).toEqual(['Left', 'Right'])
  expect(impl[0]!.sourceQualifiedName).toBe('src/widget#Widget')
})
```

- [ ] **Step 2: Run the heritage test — verify it fails**

Run: `bun test tests/indexer/extract-references.test.ts`
Expected: FAIL — no `extends` / `implements` candidates produced.

- [ ] **Step 3: Implement heritage extraction in `src/indexer/extract-references.ts`**

Add a collector above `extractReferenceCandidates`:

```ts
const collectHeritageReferences = (node: SyntaxNode, enclosingSymbol: string | null, references: ReferenceCandidate[]): void => {
  if (node.type === 'extends_clause') {
    // Class `extends` — value position. `value` is the base identifier (skip
    // member-expression bases like `extends Foo.Bar`, handled with namespaces later).
    const base = node.childForFieldName('value')
    if (base !== null && base.type === 'identifier') {
      references.push({
        sourceQualifiedName: enclosingSymbol,
        edgeType: 'extends',
        targetName: base.text,
        targetExportName: null,
        targetModuleSpecifier: null,
        lineNumber: base.startPosition.row + 1,
      })
    }
    return
  }
  // implements_clause — type position; one edge per implemented interface identifier.
  for (let i = 0; i < node.namedChildCount; i += 1) {
    const child = node.namedChild(i)
    if (child?.type === 'type_identifier') {
      references.push({
        sourceQualifiedName: enclosingSymbol,
        edgeType: 'implements',
        targetName: child.text,
        targetExportName: null,
        targetModuleSpecifier: null,
        lineNumber: child.startPosition.row + 1,
      })
    }
  }
}
```

Inside `visit`, add this handling before the final `visitChildren(node, enclosingSymbol, visit)` call:

```ts
    if (node.type === 'extends_clause' || node.type === 'implements_clause') {
      collectHeritageReferences(node, enclosingSymbol, references)
    }
```

- [ ] **Step 4: Run the heritage test — verify pass**

Run: `bun test tests/indexer/extract-references.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint + format**

Run: `bun run typecheck && bun run lint && bun run format:check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/indexer/extract-references.ts tests/indexer/extract-references.test.ts
git commit -m "feat(indexer): produce extends/implements heritage edges (B3)"
```

---

## Task 6: End-to-end integration + re-freeze the value-FN floor

Prove JSX/heritage edges survive indexing + resolution and are reported by `code_impact`, then re-freeze both baselines to lock the improved value-FN as the new floor.

**Files:**
- Test: `tests/indexer/index-codebase.test.ts` (append an end-to-end JSX + heritage impact test)
- Modify: `bench/impact-baseline.json`, `bench/impact-baseline.papai.json` (regenerate — post-graph-win)

**Interfaces:**
- Consumes: `indexCodebase`, `openDatabase`, `findIncomingReferences` (all existing).

- [ ] **Step 1: Write the end-to-end impact test**

Append to `tests/indexer/index-codebase.test.ts` (match the file's existing import/harness style; it already indexes tmpdir repos). Use this test body:

```ts
test('code_impact reports JSX component usage and class heritage end-to-end', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-s2-e2e-'))
  try {
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, 'src/button.tsx'), 'export function Button() { return null }\n')
    writeFileSync(path.join(dir, 'src/base.ts'), 'export class Base {}\n')
    writeFileSync(
      path.join(dir, 'src/app.tsx'),
      "import { Button } from './button.js'\n" +
        "import { Base } from './base.js'\n" +
        'export class App extends Base {}\n' +
        'export function Screen() { return <Button /> }\n',
    )
    writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
    const config = await loadCodeindexConfig({ configPath: path.join(dir, '.codeindex.json'), repoRoot: dir })
    await indexCodebase({ config, mode: 'full' })
    const db = openDatabase(config.dbPath)
    try {
      const buttonRefs = findIncomingReferences(db, { qualifiedName: 'src/button#Button', limit: 100 })
      expect(buttonRefs.some((r) => r.edgeType === 'references' && r.sourceQualifiedName === 'src/app#Screen')).toBe(true)
      const baseRefs = findIncomingReferences(db, { qualifiedName: 'src/base#Base', limit: 100 })
      expect(baseRefs.some((r) => r.edgeType === 'extends' && r.sourceQualifiedName === 'src/app#App')).toBe(true)
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

If any of `mkdtempSync`, `mkdirSync`, `writeFileSync`, `rmSync`, `tmpdir`, `path`, `loadCodeindexConfig`, `openDatabase`, or `findIncomingReferences` is not already imported in this file, add the import (mirror `tests/bench/impact-oracle.test.ts`, which imports all of them; `findIncomingReferences` comes from `../../src/search/index.js`).

- [ ] **Step 2: Run the integration test — verify pass**

Run: `bun test tests/indexer/index-codebase.test.ts`
Expected: PASS — the JSX (`references`) and `extends` edges resolve to `Button` / `Base` and are returned by `code_impact`. (This is genuinely RED before Tasks 4–5; run it here to confirm the wins wired all the way through.)

- [ ] **Step 3: Re-freeze both baselines (post-graph-win floor)**

Run:
```bash
bun run bench:impact:papai --update-baseline
bun run bench:impact:check --update-baseline
```
Expected: papai's `valueFalseNegativeRate` is **lower** than the value frozen in Task 2 Step 7 (JSX + heritage now covered); codeindex's is **unchanged** (no `.tsx`, no classes — expect a byte-identical `impact-baseline.json`).

- [ ] **Step 4: Confirm the drop and the gate**

Run: `git diff --stat bench/impact-baseline.json bench/impact-baseline.papai.json`
Expected: `impact-baseline.papai.json` changed (value-FN dropped); `impact-baseline.json` unchanged (no diff). Then:
Run: `bun run bench:impact:check && bun run bench:impact:papai`
Expected: both exit 0 with `valueFalseNegativeRate` delta `0.0000` against the fresh floors.

- [ ] **Step 5: Commit**

```bash
git add tests/indexer/index-codebase.test.ts bench/impact-baseline.papai.json bench/impact-baseline.json
git commit -m "test(indexer): e2e JSX+heritage impact; refreeze value-FN floor"
```

---

## Task 7: Anti-rot gate — `check:bench` folded into `bun run check`

Make the self-runnable bench gates part of the one command everyone runs, so they can no longer silently rot (the Slice 1 lesson). papai gates stay manual (sibling dependency).

**Files:**
- Modify: `package.json` (`check:bench` script; add it to `check`)

**Interfaces:**
- Consumes: existing `bench:check`, `bench:index:check`, `bench:impact:check` scripts.

- [ ] **Step 1: Add `check:bench` and fold it into `check`**

In `package.json` `scripts`, add `check:bench` (sequential — the three gates each reindex the self `.codeindex/index.db`, so they must not run concurrently) and append it to `check`:

```json
    "check:bench": "bun run bench:check && bun run bench:index:check && bun run bench:impact:check",
    "check": "bun run --parallel lint typecheck format:check test check:bench",
```

- [ ] **Step 2: Run `check:bench` alone — verify green**

Run: `bun run check:bench`
Expected: all three gates exit 0 (IR MRR, index count, value-FN). Note the wall-clock it adds (it reindexes codeindex + builds the tsc oracle over ~31 files).

- [ ] **Step 3: Run the full `check` — verify green**

Run: `bun run check`
Expected: lint, typecheck, format, test, and the three bench gates all pass.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: fold self bench gates into check (anti-rot)"
```

---

## Self-Review

**1. Spec coverage** (`docs/superpowers/specs/2026-07-23-phase2-slice2-value-fn-and-graph-wins-design.md`):

- Unit 1 value/type breakdown → Tasks 1–3 (classifier, scorer buckets, gate flip). ✓
- `'both'`→value + invariance + type-only diagnostic → Task 2 Step 4 (`else` branch = type-only; value counts value+both). ✓
- Raw `typescript`, fail-toward-value → Task 1 Step 5 (classifier default `value`). ✓
- Unit 2 B1 JSX (`references` edge; capitalized identifiers only; member/intrinsic skipped) → Task 4. ✓
- Unit 3 B3 `extends`(value)/`implements`(type), activates dead edge types → Task 5. ✓
- Re-freeze baselines after graph wins; measured papai drop; codeindex byte-identical → Task 6. ✓
- Anti-rot `check:bench` folded into `check`; papai manual → Task 7. ✓
- Pre-flight memo (act only on extends/implements) → memo section + Task 5. ✓
- Exit criteria: value/type frozen + gated (T2–3), edges unit+e2e tested (T4–6), no MRR/FP regression (T6 gates + `bench:check` in T7), `typescript` bench-only (Global Constraints; guard untouched). ✓

**2. Placeholder scan:** none — every code/step is concrete.

**3. Type consistency:** `OracleSource`/`OracleTarget` (T1) consumed verbatim in T2 scorer; six report fields + two baseline/schema fields defined in T2 and consumed in T3 compare/run and the T3 test literal; edge-type strings `references`/`extends`/`implements` all already in `ReferenceEdgeType` (`src/types.ts:7`). `findIncomingReferences` signature (T6) matches `src/search/index.ts`.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-23-phase2-slice2-value-fn-and-graph-wins.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batched with checkpoints for review.

Which approach?
