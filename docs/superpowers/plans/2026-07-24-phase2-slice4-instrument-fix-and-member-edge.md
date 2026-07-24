# Phase 2 Slice 4 — Instrument Fix & Member Edge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the code_impact bench instrument honest (stop double-counting a source-attribution mismatch as false negative + false positive), then build the highest-value recoverable graph edge — `this.m()` member calls (B2).

**Architecture:** Two sub-slices. **4a** fixes the oracle (`bench/impact-oracle.ts`) to attribute each true reference to the nearest *named scope boundary* — matching the indexer's `isNamedScopeBoundary` rule — instead of the innermost `symbols`-table entry, so a plain `const x = f()` local no longer steals the attribution from its enclosing function. **4b** teaches the indexer/resolver to resolve `this.m()` calls to the enclosing class's method, recovering the 22 genuine member misses measured on papai.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `web-tree-sitter` (indexer), the `typescript` compiler API (oracle ground truth), `bun:test`.

## Global Constraints

- Runtime/test: **Bun**. Run tests with `bun test <path>`; full gate is `bun run check`.
- Lint/format must stay clean: `bun run lint`, `bun run format:check` (oxlint/oxfmt over `src tests bench`).
- `noUncheckedIndexedAccess` is **on** — guard array/object index access; never use non-null assertions on indexed reads (lint forbids `typescript/non-nullable-type-assertion-style`).
- **TDD**: write the failing test, watch it fail, implement minimally, watch it pass, commit.
- **No DB artifacts committed**: never `git add` `.codeindex/` or `*-wal`/`*-shm`.
- **Deterministic bench**: the oracle sample is a fixed stride; do not introduce `Date.now()`/`Math.random()` into bench code.
- `compareImpact` gates only on `valueFalseNegativeRate` going **up**. Both sub-slices *lower* it, so `bun run check` stays green before baselines are regenerated; regenerating baselines is an explicit "lock the honest floor" step, not a gate-unblock.
- Qualified-name format (from the indexer): module-level symbol `moduleKey#Name`; nested symbol `parentQualifiedName>childName`. A method `m` of class `C` in module `mod` is `mod#C>m`; a call inside that method has source `mod#C>m`.
- Spec: `docs/superpowers/specs/2026-07-24-phase2-slice4-instrument-fix-and-member-edge-design.md`.

---

## Slice 4a — Oracle source-attribution fix

### Task 1: Attribute references to the nearest named scope boundary

**Files:**
- Modify: `bench/impact-oracle.ts` (add `nearestNamedBoundary`; rewire the reference loop in `buildReferenceOracle`)
- Test: `tests/bench/impact-oracle.test.ts` (add a `describe('buildReferenceOracle — source attribution', …)` block)

**Interfaces:**
- Consumes: existing `nodeAtPosition(sf, pos)`, `enclosingQualifiedName(db, filePath, line)`, `classifyPosition`, `classifyShape` in `bench/impact-oracle.ts`.
- Produces: internal helper `nearestNamedBoundary(node: ts.Node): ts.Node | null` (not exported — exercised through `buildReferenceOracle`). No public signature changes.

**Background (why):** For `const body = readBody(res)` inside `fetchBillingDetail`, the oracle currently attributes the `readBody` reference to the innermost symbol `fetchBillingDetail>body`, while code_impact credits the enclosing `fetchBillingDetail`. Measured: codeindex 31/31 call-FN and 31/31 FP are this artifact; papai 93/107 call-FN. The indexer's rule (`src/indexer/extract-references.ts` `isNamedScopeBoundary` + `nextEnclosingSymbol`): a reference's source is the nearest enclosing *named* function/method/class or arrow/function-valued variable declarator; plain `const x = …` declarators and unnamed callbacks are transparent.

- [ ] **Step 1: Write the failing tests**

Append to `tests/bench/impact-oracle.test.ts` (the file already imports `buildReferenceOracle`, `mkdtempSync`, `mkdirSync`, `rmSync`, `writeFileSync`, `tmpdir`, `path`, `loadCodeindexConfig`, `indexCodebase`, `openDatabase`, and pushes temp dirs to `dirs` cleaned in `afterAll`):

```ts
describe('buildReferenceOracle — source attribution (Slice 4a)', () => {
  // Builds a two-file repo: src/a.ts declares `target`, src/b.ts references it inside `callerBody`.
  const makeAttributionRepo = async (callerBody: string): Promise<{ db: ReturnType<typeof openDatabase>; dir: string }> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-oracle-attr-'))
    dirs.push(dir)
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, 'src/a.ts'), 'export function target(): number { return 1 }\n')
    writeFileSync(path.join(dir, 'src/b.ts'), `import { target } from './a'\n${callerBody}\n`)
    writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', strict: true }, include: ['src'] }),
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
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/bench/impact-oracle.test.ts -t "source attribution"`
Expected: FAIL — the plain-var test reports `src/b#caller>x` instead of `src/b#caller` (`toContain('src/b#caller')` fails).

- [ ] **Step 3: Add the `nearestNamedBoundary` helper**

In `bench/impact-oracle.ts`, add this above `buildReferenceOracle` (after `nodeAtPosition`):

```ts
// Mirror the indexer's isNamedScopeBoundary + nextEnclosingSymbol (src/indexer/extract-references.ts):
// a reference's SOURCE is the nearest enclosing NAMED scope boundary — a named function or class, a
// method, or an arrow/function-expression bound to a variable declarator (named by the declarator).
// A plain `const x = f()` declarator and unnamed callbacks contribute no name segment, so the walk
// skips past them. Returns the boundary node (its start line identifies the codeindex symbol), or
// null when the reference sits at module scope — code_impact records a null source there, which the
// scorer excludes. (Known minor, errs safe: a NAMED function expression used as a bare callback —
// `setTimeout(function foo(){}, 0)` — is a boundary in the indexer but skipped here; vanishingly rare.)
const nearestNamedBoundary = (node: ts.Node): ts.Node | null => {
  for (let a: ts.Node | undefined = node.parent; a !== undefined && !ts.isSourceFile(a); a = a.parent) {
    if ((ts.isFunctionDeclaration(a) || ts.isClassDeclaration(a)) && a.name !== undefined) return a
    if (ts.isMethodDeclaration(a)) return a
    if (
      (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) &&
      ts.isVariableDeclaration(a.parent) &&
      ts.isIdentifier(a.parent.name)
    ) {
      return a.parent
    }
  }
  return null
}
```

- [ ] **Step 4: Rewire the reference loop in `buildReferenceOracle`**

In `bench/impact-oracle.ts`, replace this block inside the `for (const entry of entries)` loop:

```ts
      const pos = entry.textSpan.start
      const line = sf.getLineAndCharacterOfPosition(pos).line + 1
      const relPath = path.relative(opts.repoRoot, entry.fileName)
      const enclosing = enclosingQualifiedName(db, relPath, line)
      // Exclude module-scope refs (unnameable by code_impact) and self-references.
      if (enclosing === null || enclosing === symbol.qualifiedName) continue
```

with:

```ts
      const pos = entry.textSpan.start
      const relPath = path.relative(opts.repoRoot, entry.fileName)
      // Attribute the reference to the nearest NAMED scope boundary — the callable/class code_impact
      // records as the edge source — not the innermost symbol. A plain `const x = f()` local is
      // transparent; without this the oracle blames `fn>x` while code_impact credits `fn`, scoring
      // one correct edge as BOTH a false negative and a false positive (Slice 4a).
      const boundary = nearestNamedBoundary(nodeAtPosition(sf, pos))
      if (boundary === null) continue
      const boundaryLine = sf.getLineAndCharacterOfPosition(boundary.getStart(sf)).line + 1
      const enclosing = enclosingQualifiedName(db, relPath, boundaryLine)
      // Exclude self-references (module-scope refs already dropped: boundary === null above).
      if (enclosing === null || enclosing === symbol.qualifiedName) continue
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `bun test tests/bench/impact-oracle.test.ts -t "source attribution"`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the whole oracle test file to verify no regressions**

Run: `bun test tests/bench/impact-oracle.test.ts`
Expected: PASS (all prior tests + 3 new).

- [ ] **Step 7: Commit**

```bash
git add bench/impact-oracle.ts tests/bench/impact-oracle.test.ts
git commit -m "fix(bench): attribute oracle refs to nearest named scope boundary

Stop attributing a reference to the innermost >local symbol (const x = f());
attribute to the enclosing callable/class the indexer records as the edge
source (mirrors isNamedScopeBoundary), keeping arrow-var-local boundaries.
Removes the FN+FP double-count artifact (codeindex 31/31, papai 93/107)."
```

---

### Task 2: Regenerate baselines and record the honest numbers

**Files:**
- Modify: `bench/impact-baseline.json` (codeindex gated baseline — regenerated)
- Modify: `bench/impact-baseline.papai.json` (papai baseline — regenerated)
- Modify: `bench/impact-baseline.fixture.json` (fixture baseline — regenerate; likely unchanged by 4a)
- Modify: `docs/superpowers/specs/2026-07-24-phase2-slice4-instrument-fix-and-member-edge-design.md` (add a "Post-4a measured (artifact-free)" subsection)

**Interfaces:** none (data + docs).

- [ ] **Step 1: Confirm the gate is still green before regenerating (improvement, not regression)**

Run: `bun run bench:impact:check`
Expected: prints `valueFalseNegativeRate: 0.4875 -> <lower> (-…)`, exit 0 (a drop is not a regression).

- [ ] **Step 2: Capture the honest by-shape numbers for all three corpora**

Run each and note `valueFalseNegativeRate` + `valueFalseNegativesByShape`/`valueTrueReferenceCountByShape`:

```bash
bun run bench/impact-run.ts --repo bench/fixtures/impact-demo 2>/dev/null | grep -E '"valueFalseNegativeRate"|ByShape'
bun run bench/impact-run.ts 2>/dev/null | grep -E '"valueFalseNegativeRate"|ByShape'
bun run bench/impact-run.ts --repo ../papai --max-targets 300 2>/dev/null | grep -E '"valueFalseNegativeRate"|ByShape'
```
Expected: codeindex `call` FN now ~0 (its ~0.10 honest value-FN, driven by bare-value 8/8); papai `call` FN ~14, `member` still 22, FP rate collapsed from 0.44.

- [ ] **Step 3: Regenerate the three baselines**

```bash
bun run bench/impact-run.ts --repo bench/fixtures/impact-demo --baseline bench/impact-baseline.fixture.json --update-baseline
bun run bench/impact-run.ts --baseline bench/impact-baseline.json --update-baseline
bun run bench/impact-run.ts --repo ../papai --max-targets 300 --baseline bench/impact-baseline.papai.json --update-baseline
```

- [ ] **Step 4: Verify each regenerated baseline passes its own check**

```bash
bun run bench:impact:fixture:check >/dev/null 2>&1 && echo fixture-ok
bun run bench:impact:check >/dev/null 2>&1 && echo codeindex-ok
bun run bench/impact-run.ts --repo ../papai --max-targets 300 --baseline bench/impact-baseline.papai.json >/dev/null 2>&1 && echo papai-ok
```
Expected: `fixture-ok`, `codeindex-ok`, `papai-ok`.

- [ ] **Step 5: Record the honest numbers in the spec**

Append a subsection to the spec's "The measured finding" area titled **"Post-4a measured (artifact-free)"** with the three `valueFalseNegativeRate` values and the by-shape maps captured in Step 2, plus one line: "codeindex honest value-FN confirmed ~0.10 (bare-value 8/8; call 0); papai call-FN dropped 107→~14, member 22 unchanged; FP rate collapsed." Use the actual measured numbers, not these approximations.

- [ ] **Step 6: Run the full gate**

Run: `bun run check`
Expected: PASS (lint, typecheck, format, tests, all bench gates).

- [ ] **Step 7: Commit**

```bash
git add bench/impact-baseline.json bench/impact-baseline.papai.json bench/impact-baseline.fixture.json docs/superpowers/specs/2026-07-24-phase2-slice4-instrument-fix-and-member-edge-design.md
git commit -m "test(bench): regenerate impact baselines to honest floor (Slice 4a)

Lock in the artifact-free numbers after the oracle attribution fix: codeindex
value-FN 0.4875 -> ~0.10, papai call-FN 107 -> ~14, FP rate collapsed. Record
the post-4a measured table in the spec."
```

---

## Slice 4b — Build the B2 member-call edge (`this.m()`)

### Task 3: Extract `this.m()` calls with a `this` receiver marker

**Files:**
- Modify: `src/indexer/collect-export-candidates.ts` (add `receiver?: 'this'` to `ReferenceCandidate`)
- Modify: `src/indexer/extract-references.ts` (`collectCallReference`: emit the this-member-call form)
- Test: `tests/indexer/extract-references.test.ts` (add a test)

**Interfaces:**
- Produces: `ReferenceCandidate.receiver?: 'this'` — set only for `this.m()` calls; `undefined` everywhere else.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

Append inside `describe('extractReferenceCandidates', …)` in `tests/indexer/extract-references.test.ts`:

```ts
  test('this.m() emits a calls reference to the bare method name with a this receiver', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = ['export class C {', '  foo(): number { return this.bar() }', '  bar(): number { return 1 }', '}'].join('\n')
    const tree = parsed.parser.parse(source)
    const result = extractReferenceCandidates({ source, tree: tree!, relativeFilePath: 'src/c.ts', moduleKey: 'src/c' })

    const thisCall = result.references.find((r) => r.edgeType === 'calls' && r.targetName === 'bar')
    expect(thisCall).toBeDefined()
    expect(thisCall!.receiver).toBe('this')
    expect(thisCall!.sourceQualifiedName).toBe('src/c#C>foo')
  })

  test('obj.m() is left as a whole-member-expression targetName with no receiver (deferred)', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = ['export function run(obj: { baz(): number }): number {', '  return obj.baz()', '}'].join('\n')
    const tree = parsed.parser.parse(source)
    const result = extractReferenceCandidates({ source, tree: tree!, relativeFilePath: 'src/r.ts', moduleKey: 'src/r' })

    const objCall = result.references.find((r) => r.edgeType === 'calls')
    expect(objCall!.targetName).toBe('obj.baz')
    expect(objCall!.receiver).toBeUndefined()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/indexer/extract-references.test.ts -t "this receiver"`
Expected: FAIL — `thisCall` is `undefined` (current code sets `targetName` to `"this.bar"`, so the `=== 'bar'` find misses).

- [ ] **Step 3: Add the `receiver` field to `ReferenceCandidate`**

In `src/indexer/collect-export-candidates.ts`, add the field to the interface:

```ts
export interface ReferenceCandidate {
  readonly sourceQualifiedName: string | null
  readonly edgeType: ReferenceEdgeType
  readonly targetName: string
  readonly targetExportName: string | null
  readonly targetModuleSpecifier: string | null
  readonly receiver?: 'this'
  readonly lineNumber: number
}
```

- [ ] **Step 4: Emit the this-member-call in `collectCallReference`**

In `src/indexer/extract-references.ts`, replace `collectCallReference` with:

```ts
const collectCallReference = (
  node: SyntaxNode,
  enclosingSymbol: string | null,
  references: ReferenceCandidate[],
): void => {
  const functionNode = node.childForFieldName('function')
  // this.m() — a member call whose receiver is `this` resolves to the enclosing class's method (B2).
  // Emit the bare property name plus a `this` receiver marker so the resolver can bind it to
  // <enclosingClass>>m. Non-`this` receivers (obj.m()) are left as the whole member-expression text
  // (unresolved) — deferred.
  if (functionNode?.type === 'member_expression') {
    const object = functionNode.childForFieldName('object')
    const property = functionNode.childForFieldName('property')
    if (object?.type === 'this' && property?.type === 'property_identifier') {
      references.push({
        sourceQualifiedName: enclosingSymbol,
        edgeType: 'calls',
        targetName: property.text,
        targetExportName: null,
        targetModuleSpecifier: null,
        receiver: 'this',
        lineNumber: node.startPosition.row + 1,
      })
      return
    }
  }
  references.push({
    sourceQualifiedName: enclosingSymbol,
    edgeType: 'calls',
    targetName: functionNode?.text ?? node.text,
    targetExportName: null,
    targetModuleSpecifier: null,
    lineNumber: node.startPosition.row + 1,
  })
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/indexer/extract-references.test.ts`
Expected: PASS (all prior + 2 new).

- [ ] **Step 6: Commit**

```bash
git add src/indexer/collect-export-candidates.ts src/indexer/extract-references.ts tests/indexer/extract-references.test.ts
git commit -m "feat(indexer): extract this.m() as a bare-method call with this receiver

member_expression call whose object is `this` now emits a calls candidate to the
property name with receiver:'this' (was the unresolvable literal 'this.m').
obj.m() unchanged (deferred)."
```

---

### Task 4: Resolve `this.m()` to the enclosing class's method

**Files:**
- Modify: `src/resolver/resolve-references.ts` (accept `receiver`; resolve this-calls before the generic path)
- Test: `tests/resolver/resolve-references.test.ts` (add tests)

**Interfaces:**
- Consumes: `ReferenceCandidate.receiver?: 'this'` (Task 3), `SymbolSummary.qualifiedName` + `.localName`.
- Produces: for a `receiver:'this'` reference, a `ResolvedReference` whose `targetSymbolId` is the enclosing-class method (or `null` + `name_only` when no ancestor-class method matches).

- [ ] **Step 1: Write the failing tests**

Append inside `describe('resolveReferenceCandidates', …)` in `tests/resolver/resolve-references.test.ts`:

```ts
  test('this.m() resolves to the enclosing class method, not a same-named method of another class', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        { id: 1, qualifiedName: 'src/c#C>foo', localName: 'foo', moduleKey: 'src/c', exportNames: [] },
        { id: 2, qualifiedName: 'src/c#C>bar', localName: 'bar', moduleKey: 'src/c', exportNames: [] },
        { id: 3, qualifiedName: 'src/c#D>bar', localName: 'bar', moduleKey: 'src/c', exportNames: [] },
      ],
      moduleAliases: [],
      files: [{ id: 10, moduleKey: 'src/c' }],
      references: [
        {
          sourceQualifiedName: 'src/c#C>foo',
          edgeType: 'calls',
          targetName: 'bar',
          targetExportName: null,
          targetModuleSpecifier: null,
          receiver: 'this',
          lineNumber: 2,
        },
      ],
      currentModuleKey: 'src/c',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: 2, confidence: 'resolved' })
  })

  test('this.m() resolves through a nested arrow inside the method', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        { id: 1, qualifiedName: 'src/c#C>foo>cb', localName: 'cb', moduleKey: 'src/c', exportNames: [] },
        { id: 2, qualifiedName: 'src/c#C>bar', localName: 'bar', moduleKey: 'src/c', exportNames: [] },
      ],
      moduleAliases: [],
      files: [{ id: 10, moduleKey: 'src/c' }],
      references: [
        {
          sourceQualifiedName: 'src/c#C>foo>cb',
          edgeType: 'calls',
          targetName: 'bar',
          targetExportName: null,
          targetModuleSpecifier: null,
          receiver: 'this',
          lineNumber: 3,
        },
      ],
      currentModuleKey: 'src/c',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: 2, confidence: 'resolved' })
  })

  test('this.m() with no matching enclosing-class method stays unresolved (no cross-class fallback)', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        { id: 1, qualifiedName: 'src/c#C>foo', localName: 'foo', moduleKey: 'src/c', exportNames: [] },
        { id: 3, qualifiedName: 'src/c#D>bar', localName: 'bar', moduleKey: 'src/c', exportNames: [] },
      ],
      moduleAliases: [],
      files: [{ id: 10, moduleKey: 'src/c' }],
      references: [
        {
          sourceQualifiedName: 'src/c#C>foo',
          edgeType: 'calls',
          targetName: 'bar',
          targetExportName: null,
          targetModuleSpecifier: null,
          receiver: 'this',
          lineNumber: 2,
        },
      ],
      currentModuleKey: 'src/c',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: null, confidence: 'name_only' })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/resolver/resolve-references.test.ts -t "this.m()"`
Expected: FAIL — without the receiver branch, the generic path resolves `bar` by name and may match `D>bar` (id 3) or mis-set confidence.

- [ ] **Step 3: Add the `receiver` field to the resolver's `ReferenceCandidate`**

In `src/resolver/resolve-references.ts`, add the field to the local `ReferenceCandidate` type:

```ts
type ReferenceCandidate = {
  readonly sourceQualifiedName: string | null
  readonly edgeType: 'imports' | 'reexports' | 'calls' | 'extends' | 'implements' | 'references'
  readonly targetName: string
  readonly targetExportName: string | null
  readonly targetModuleSpecifier: string | null
  readonly receiver?: 'this'
  readonly lineNumber: number
}
```

- [ ] **Step 4: Add the this-call resolver helper**

In `src/resolver/resolve-references.ts`, add above `resolveReferenceCandidates`:

```ts
// this.m() → the enclosing class's method. The reference's source is the calling method/scope; its
// enclosing class is any ancestor prefix of that qualified name. Match a symbol `<class>>m` whose
// class prefix is an ancestor of the source, so only the enclosing class chain matches (deterministic,
// near-zero FP). obj.m() never reaches here (no `this` receiver) and stays unresolved — deferred.
const resolveThisMemberCall = (
  symbols: readonly SymbolSummary[],
  source: string,
  methodName: string,
): number | null => {
  const suffix = `>${methodName}`
  const match = symbols.find((symbol) => {
    if (symbol.localName !== methodName || !symbol.qualifiedName.endsWith(suffix)) return false
    const classPrefix = symbol.qualifiedName.slice(0, symbol.qualifiedName.length - suffix.length)
    return source === classPrefix || source.startsWith(`${classPrefix}>`)
  })
  return match?.id ?? null
}
```

- [ ] **Step 5: Branch to it inside `resolveReferenceCandidates`**

In `src/resolver/resolve-references.ts`, at the very top of the `input.references.map((reference) => {` callback body (before `const matchedFileId = …`), add:

```ts
    if (reference.receiver === 'this' && reference.sourceQualifiedName !== null) {
      const targetSymbolId = resolveThisMemberCall(input.symbols, reference.sourceQualifiedName, reference.targetName)
      return {
        sourceSymbolId: sourceSymbols.get(reference.sourceQualifiedName) ?? null,
        ...reference,
        targetSymbolId,
        targetFileId: null,
        confidence: targetSymbolId === null ? 'name_only' : 'resolved',
      }
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/resolver/resolve-references.test.ts`
Expected: PASS (all prior + 3 new).

- [ ] **Step 7: Commit**

```bash
git add src/resolver/resolve-references.ts tests/resolver/resolve-references.test.ts
git commit -m "feat(resolver): resolve this.m() to the enclosing class method (B2)

A receiver:'this' calls reference binds to a method symbol <class>>m whose class
prefix is an ancestor of the call site — only the enclosing class chain matches
(resolved confidence, near-zero FP). No match -> name_only, no cross-class
fallback. obj.m() stays deferred."
```

---

### Task 5: End-to-end proof on the fixture + measure the win

**Files:**
- Modify: `bench/fixtures/impact-demo/src/panel.ts` (comment reflects the now-resolved case)
- Modify: `tests/bench/impact-fixture.test.ts` (member bucket now zeroed, not lit)
- Modify: `bench/impact-baseline.fixture.json` (regenerate — member FN drops)
- Modify: `bench/impact-baseline.papai.json` (regenerate — member 22 recovered)
- Modify: `docs/superpowers/specs/2026-07-24-phase2-slice4-instrument-fix-and-member-edge-design.md` (record the measured 4b win)

**Interfaces:** none (integration + data).

**Background:** The fixture's `Panel.render()` already calls `this.helper()` (a member true-ref currently counted as FN). After Tasks 3–4 it resolves, so the fixture's `member` value-FN goes 1 → 0.

- [ ] **Step 1: Update the fixture demonstration test to expect member RESOLVED**

In `tests/bench/impact-fixture.test.ts`, change the assertion that member stays lit. Replace:

```ts
    expect(report.valueFalseNegativesByShape['member']).toBeGreaterThan(0)
```

with:

```ts
    // Slice 4b: this.helper() now resolves to the enclosing class method, so member is no longer a FN.
    expect(report.valueFalseNegativesByShape['member']).toBeFalsy()
```

And update the test title on line 18 from `…member/namespace/bare-value stay lit` to `…namespace/bare-value stay lit; member now resolved (B2)`.

- [ ] **Step 2: Run the fixture test to verify it fails (proves the edge isn't built yet in this working copy until index rebuild)**

Run: `bun test tests/bench/impact-fixture.test.ts -t "resolved"`
Expected: PASS if the test re-indexes the fixture in-process (it builds a fresh DB each run) — the resolver change is already in `src/`. If it FAILS with member still > 0, the extraction/resolution isn't wired; revisit Tasks 3–4.

- [ ] **Step 3: Update the fixture comment**

In `bench/fixtures/impact-demo/src/panel.ts`, change the top comment:

```ts
// member (B2, resolved via this.m()): a scored method referenced through `this`.
```

- [ ] **Step 4: Regenerate the fixture and papai baselines**

```bash
bun run bench/impact-run.ts --repo bench/fixtures/impact-demo --baseline bench/impact-baseline.fixture.json --update-baseline
bun run bench/impact-run.ts --repo ../papai --max-targets 300 --baseline bench/impact-baseline.papai.json --update-baseline
```

- [ ] **Step 5: Measure the win and confirm FP did not regress**

```bash
bun run bench/impact-run.ts --repo ../papai --max-targets 300 2>/dev/null | grep -E '"valueFalseNegativeRate"|"falsePositiveRate"|ByShape'
```
Expected: papai `member` FN drops from 22 toward 0 by the `this.m()` share; `falsePositiveRate` not higher than the post-4a value. If FP rose, the this-call resolution is over-matching — stop and inspect before continuing.

- [ ] **Step 6: Record the 4b win in the spec**

In the spec, under the 4b section, add a short "Measured (4b)" line: fixture member value-FN 1 → 0; papai member FN 22 → `<measured>`; honest FP rate `<before>` → `<after>` (not regressed). Use actual numbers.

- [ ] **Step 7: Run the full gate**

Run: `bun run check`
Expected: PASS (all).

- [ ] **Step 8: Commit**

```bash
git add bench/fixtures/impact-demo/src/panel.ts tests/bench/impact-fixture.test.ts bench/impact-baseline.fixture.json bench/impact-baseline.papai.json docs/superpowers/specs/2026-07-24-phase2-slice4-instrument-fix-and-member-edge-design.md
git commit -m "test(bench): prove B2 this.m() edge end-to-end (Slice 4b)

Fixture Panel.render -> this.helper() now resolves (member value-FN 1->0);
papai member 22 recovered by the this.m() share with FP not regressed. Fixture
demonstration test and baselines updated; win recorded in the spec."
```

---

## Self-Review

**Spec coverage:**
- 4a oracle attribution fix → Task 1 (code+tests), Task 2 (baselines + honest numbers). ✓
- 4a "regenerate gated baseline, re-record memo" → Task 2. ✓
- 4b `this.m()` extraction → Task 3; resolution → Task 4; end-to-end + measure + FP gate → Task 5. ✓
- `obj.m()` deferred → Task 3 leaves obj.m() as whole-expression text; asserted in Task 3 Step 1 second test. ✓
- Arrow-var-local boundary retained → Task 1 Step 1 second test. ✓

**Placeholder scan:** All steps carry concrete code/commands. The only "use actual measured numbers" notes are in doc-recording steps (Task 2 Step 5, Task 5 Step 6), where the numbers are produced by the immediately-preceding measurement step — not deferred work.

**Type consistency:** `nearestNamedBoundary(node: ts.Node): ts.Node | null` used only in Task 1. `ReferenceCandidate.receiver?: 'this'` added in both the indexer type (Task 3 Step 3) and the resolver type (Task 4 Step 3) — must match. `resolveThisMemberCall(symbols, source, methodName): number | null` (Task 4 Step 4) is called with those exact args in Task 4 Step 5. Qualified-name assumption `mod#C>foo` verified against the indexer's `nextEnclosingSymbol`.

**Known minor (documented in Task 1 helper comment):** a named function expression used as a bare callback is a boundary in the indexer but skipped by `nearestNamedBoundary`; vanishingly rare, errs safe.
