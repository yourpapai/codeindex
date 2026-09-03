# Phase 2 Slice 7 — Graph Completion Close-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bank the last Phase 2 graph items: C2 false-positive fallback suppression (157 measured false papai edges), call residue #7 (import-then-`export { x }` linking), call residue #4/#5 (nested scope-path agreement), and B5 minimal (star re-export forwarding + namespace import edges) — with **no schema bump**.

**Architecture:** Unit 1 deletes one resolver branch (specified-but-unmatched imports bind nothing). Unit 2 adds a post-extraction pass in `extractReferenceCandidates` that links no-from export rows to their import's specifier, feeding the existing B4 reexport chain. Unit 3 threads "pending path segments" through the reference walk so nested-boundary paths match extract-symbols byte-for-byte. Unit 4 records `export *` as a `'star'` forwarding row the chain follows per-name, and emits a file-resolved namespace-import edge that never name-matches.

**Tech Stack:** Bun, TypeScript, SQLite (bun:sqlite), web-tree-sitter, oxlint/oxfmt.

**Spec:** `docs/superpowers/specs/2026-09-03-phase2-slice7-graph-completion-close-out-design.md`

## Global Constraints

- **No SCHEMA_VERSION bump** — every change lands in existing columns/rows (`export_kind` is free TEXT; the new `'star'` value is a type-union change only).
- IR gate up-or-flat (precision@k + MRR); impact value-FN flat-or-better (expected: papai call residue 3 → 0); FP stays 0. The frozen `IN_DEGREE_WEIGHT = 15` rule is NOT reopened.
- Baselines are regenerated ONLY in Task 5. Intermediate tasks must not write baseline files; adding fixture targets makes `bench:impact:fixture:check` red mid-slice — expected.
- Every fix lands RED→GREEN: the failing test is written and observed failing before the implementation.
- After each task: `bun run lint && bun run typecheck && bun run format:check` clean, targeted tests green. Full `bun run check` only at Task 5.
- Conventional commits matching repo history (`fix(resolver): …`, `fix(indexer): …`, `feat(indexer): …`).
- `extract-references.ts` is near its 300-line lint budget — keep additions minimal; if a task would exceed the budget, extract a helper file (the established Slice 4 Task 1 deviation pattern) and note it in the ledger.

---

### Task 1: C2 suppression — specified-but-unmatched imports bind nothing

**Files:**
- Modify: `src/resolver/resolve-references.ts:112-134` (`resolveByLocalName`)
- Test: `tests/resolver/resolve-references.test.ts`

**Interfaces:**
- Consumes: existing `ReferenceCandidate` shape; the B6 guard at resolve-references.ts:244-245 (unchanged, composes with this).
- Produces: resolution semantics — a reference with `targetModuleSpecifier !== null` that matches no file/alias resolves to `targetSymbolId null` / `confidence 'name_only'`. Bare references (specifier null) keep same-module resolution; matched-file references keep module-scoped resolution. Nothing downstream changes signature.

- [ ] **Step 1: Write the failing tests**

Append to `tests/resolver/resolve-references.test.ts` (inside the existing top-level `describe`):

```ts
  test('specified-but-unmatched import resolves to no symbol (C2 suppression)', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [{ id: 1, qualifiedName: 'src/a#eq', localName: 'eq', moduleKey: 'src/a', exportNames: [] }],
      moduleAliases: [],
      files: [{ id: 10, moduleKey: 'src/a' }],
      references: [
        {
          sourceQualifiedName: null,
          edgeType: 'imports',
          targetName: 'eq',
          targetExportName: 'eq',
          targetModuleSpecifier: 'drizzle-orm',
          lineNumber: 1,
        },
      ],
      currentModuleKey: 'src/b',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: null, confidence: 'name_only', targetFileId: null })
  })

  test('B6 guard and C2 suppression compose: value reference with unmatched specifier binds nothing', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [{ id: 1, qualifiedName: 'src/a#target', localName: 'target', moduleKey: 'src/a', exportNames: [] }],
      moduleAliases: [],
      files: [{ id: 10, moduleKey: 'src/a' }],
      references: [
        {
          sourceQualifiedName: 'src/b#caller',
          edgeType: 'references',
          targetName: 'target',
          targetExportName: null,
          targetModuleSpecifier: 'phantom-pkg',
          lineNumber: 2,
        },
      ],
      currentModuleKey: 'src/b',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: null, confidence: 'name_only' })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/resolver/resolve-references.test.ts`
Expected: both new tests FAIL — the any-module fallback binds `eq` → symbol 1 / `target` → symbol 1. All pre-existing tests in the file stay green.

- [ ] **Step 3: Implement**

Replace `resolveByLocalName` in `src/resolver/resolve-references.ts:112-134`:

```ts
// Last-resort resolution: a symbol whose local name matches, scoped to the matched module (or, for
// a bare reference with no module specifier, the current module). A specified-but-unmatched import
// (bare npm specifier, out-of-root path, typo'd relative) resolves to NOTHING here: the old
// codebase-wide fallback bound `import { eq } from 'drizzle-orm'` to an unrelated local
// `const eq` — measured at 157 false papai edges before C2 suppression (Slice 7). Confidence
// reflects whether the import specifier at least resolved to a file.
const resolveByLocalName = (
  input: Readonly<ResolveReferenceCandidatesInput>,
  matchedFileId: number | null,
  matchedModuleKey: string | null,
  reference: Readonly<ReferenceCandidate>,
): Readonly<{ targetSymbolId: number | null; confidence: ResolvedReference['confidence'] }> => {
  const scopeModuleKey =
    matchedModuleKey ?? (reference.targetModuleSpecifier === null ? input.currentModuleKey : null)
  const resolvedByName =
    scopeModuleKey === null
      ? undefined
      : input.symbols.find(
          (symbol) => symbol.localName === reference.targetName && symbol.moduleKey === scopeModuleKey,
        )
  return {
    targetSymbolId: resolvedByName?.id ?? null,
    confidence: matchedFileId === null ? 'name_only' : 'file_resolved',
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/resolver/ tests/impact.test.ts`
Expected: PASS — all pre-existing resolver tests unchanged (same-module bare refs and matched-file refs keep their behavior).

- [ ] **Step 5: Lint, typecheck, format**

Run: `bun run lint && bun run typecheck && bun run format:check`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/resolver/resolve-references.ts tests/resolver/resolve-references.test.ts
git commit -m "fix(resolver): suppress codebase-wide name_only fallback for unresolvable specifiers (Slice 7, C2)"
```

---

### Task 2: Residue #7 — link import-then-`export { x }` into the B4 chain

**Files:**
- Modify: `src/indexer/extract-references.ts` (post-pass in `extractReferenceCandidates`, at the `return`)
- Test: `tests/indexer/extract-references.test.ts`
- Fixture: `bench/fixtures/impact-demo/src/linked.ts`, `bench/fixtures/impact-demo/src/re-export.ts`, `bench/fixtures/impact-demo/src/reexport-caller.ts` (new files)

**Interfaces:**
- Consumes: `pushExportSpecifier`'s row shape (`exportKind 'named'`, `targetModuleSpecifier null` for no-from exports); imports references carrying `targetName` = local binding name and `targetModuleSpecifier`.
- Produces: no-from `export { x }` rows whose `localName` matches an imported name carry that import's specifier — the existing `buildReexportResolver` chain (resolve-references.ts:86-93) follows them unchanged. Alias forms link on the original name (`export { x as y }` → specifier set via `x`); chain resolution for aliased forwards is out of scope (needs a forwarding-name column — no schema bump this slice). No resolver changes in this task.

- [ ] **Step 1: Write the failing tests**

Append to `tests/indexer/extract-references.test.ts` (inside the existing `describe`):

```ts
  test('import-then-export links the export row to the import specifier (residue #7)', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = ["import { linked } from './linked.js'", 'export { linked }'].join('\n')
    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const { moduleExports } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/re-export.ts',
      moduleKey: 'src/re-export',
    })

    expect(moduleExports).toEqual([
      { exportName: 'linked', exportKind: 'named', localName: 'linked', targetModuleSpecifier: './linked.js' },
    ])
  })

  test('import-then-export links regardless of statement order', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = ['export { linked }', "import { linked } from './linked.js'"].join('\n')
    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const { moduleExports } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/re-export.ts',
      moduleKey: 'src/re-export',
    })

    expect(moduleExports[0]!.targetModuleSpecifier).toBe('./linked.js')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/indexer/extract-references.test.ts`
Expected: both FAIL — `targetModuleSpecifier` is `null` (the row records no forwarding target today).

- [ ] **Step 3: Implement**

In `src/indexer/extract-references.ts`, rename the local accumulator and add the post-pass before the return:

```ts
export const extractReferenceCandidates = (
  input: Readonly<ExtractReferenceCandidatesInput>,
): ExtractReferenceCandidatesResult => {
  const rawModuleExports: ModuleExportCandidate[] = []
  const references: ReferenceCandidate[] = []
  const visit = (node: SyntaxNode, enclosingSymbol: string | null): void => {
    // ... body unchanged in this task ...
  }

  visit(input.tree.rootNode, null)

  // Residue #7: a no-from `export { x }` re-exports an imported binding — x has no local symbol
  // row, so the row lands with a null symbol AND null specifier and the B4 chain dead-ends. Link
  // it to the module x was imported from (order-independent: applied after the whole walk).
  const specifierByImportedName = new Map<string, string>()
  for (const ref of references) {
    if (ref.edgeType === 'imports' && ref.targetModuleSpecifier !== null) {
      specifierByImportedName.set(ref.targetName, ref.targetModuleSpecifier)
    }
  }
  const moduleExports = rawModuleExports.map((moduleExport) =>
    moduleExport.exportKind === 'named' &&
    moduleExport.targetModuleSpecifier === null &&
    moduleExport.localName !== null &&
    specifierByImportedName.has(moduleExport.localName)
      ? { ...moduleExport, targetModuleSpecifier: specifierByImportedName.get(moduleExport.localName) ?? null }
      : moduleExport,
  )
  return { moduleExports, references }
}
```

(Only the accumulator rename and the block between `visit(...)` and `return` are new; the `visit` body is untouched in this task.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/indexer/extract-references.test.ts && bun test tests/indexer/`
Expected: PASS.

- [ ] **Step 5: Add the fixture barrel case**

Create `bench/fixtures/impact-demo/src/linked.ts`:

```ts
export function linked(): number {
  return 1
}
```

Create `bench/fixtures/impact-demo/src/re-export.ts`:

```ts
import { linked } from './linked'

export { linked }
```

Create `bench/fixtures/impact-demo/src/reexport-caller.ts`:

```ts
import { linked } from './re-export'

export function useLinked(): number {
  return linked()
}
```

Verify end-to-end WITHOUT writing a baseline:

Run: `bun run bench/impact-run.ts --repo bench/fixtures/impact-demo`
Expected: the report shows the `linked` call from `useLinked` resolving (`resolved` call edge) — pre-fix this was a call FN through the dead-end barrel row. Baseline file untouched.

- [ ] **Step 6: Lint, typecheck, format**

Run: `bun run lint && bun run typecheck && bun run format:check`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add src/indexer/extract-references.ts tests/indexer/extract-references.test.ts bench/fixtures/impact-demo/src/linked.ts bench/fixtures/impact-demo/src/re-export.ts bench/fixtures/impact-demo/src/reexport-caller.ts
git commit -m "fix(indexer): link import-then-export re-exports into the B4 chain (Slice 7, residue #7)"
```

---

### Task 3: Residue #4/#5 — nested scope-path agreement

**Files:**
- Create: `src/indexer/scope-path.ts` (`isNamedScopeBoundary`, `nextEnclosingSymbol`, `pendingSegmentsFor` move here — extract-references.ts is at its 300-line lint budget after Task 2's post-pass, so the path helpers get their own module)
- Modify: `src/indexer/extract-references.ts` (delete moved helpers, thread `pending` through the walk)
- Test: `tests/indexer/extract-references.test.ts`
- Fixture: `bench/fixtures/impact-demo/src/stream.ts`, `bench/fixtures/impact-demo/src/stream-consumer.ts` (new files)

**Interfaces:**
- Consumes: extract-symbols' path rule — `variable_declarator` is in `declarationTypes` (src/indexer/extract-symbols.ts:48), so its name joins qualified paths even when it is NOT a reference-walk boundary.
- Produces: `src/indexer/scope-path.ts` exporting `isNamedScopeBoundary(node: SyntaxNode): boolean`, `pendingSegmentsFor(node: SyntaxNode, pending: readonly string[]): readonly string[]`, and `nextEnclosingSymbol(moduleKey: string, node: SyntaxNode, enclosingSymbol: string | null, pending: readonly string[]): string | null`. extract-references' internal `visit` gains a third defaulted param `pending: readonly string[] = []` (keeps it assignable to `collectExportCandidates`' 2-param callback; export statements can never sit inside a declarator, so the default is always correct there). Reference sources inside object-literal methods of a non-boundary declarator now attribute to `…>declarator>method` — byte-identical to extract-symbols' symbol paths.

- [ ] **Step 1: Write the failing tests**

Append to `tests/indexer/extract-references.test.ts`:

```ts
  test('calls inside object-literal methods of a non-boundary const attribute through the declarator segment', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = [
      'export function handleEvents(): unknown {',
      '  const stream = new ReadableStream({',
      '    start() { return startCalled() },',
      '    cancel() { return cancelCalled() },',
      '  })',
      '  return stream',
      '}',
      'function startCalled(): number { return 1 }',
      'function cancelCalled(): number { return 1 }',
    ].join('\n')
    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const { references } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/mod.ts',
      moduleKey: 'src/mod',
    })

    const startCall = references.find((ref) => ref.targetName === 'startCalled')
    expect(startCall!.sourceQualifiedName).toBe('src/mod#handleEvents>stream>start')
    const cancelCall = references.find((ref) => ref.targetName === 'cancelCalled')
    expect(cancelCall!.sourceQualifiedName).toBe('src/mod#handleEvents>stream>cancel')
  })

  test('module-level non-boundary const with a nested boundary composes the full path', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = [
      'const stream = new ReadableStream({',
      '  start() { return startCalled() },',
      '})',
      'function startCalled(): number { return 1 }',
    ].join('\n')
    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const { references } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/mod.ts',
      moduleKey: 'src/mod',
    })

    const call = references.find((ref) => ref.targetName === 'startCalled')
    expect(call!.sourceQualifiedName).toBe('src/mod#stream>start')
  })

  test('plain const initializer references stay attributed to the enclosing symbol (4a agreement pin)', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = [
      'export function outer(): unknown {',
      '  const body = readBody()',
      '  return body',
      '}',
      'function readBody(): number { return 1 }',
    ].join('\n')
    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const { references } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/mod.ts',
      moduleKey: 'src/mod',
    })

    const call = references.find((ref) => ref.targetName === 'readBody')
    expect(call!.sourceQualifiedName).toBe('src/mod#outer')
  })
```

(The third test pins existing behavior — it must pass before AND after; it guards the Slice 4a transparency rule.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/indexer/extract-references.test.ts`
Expected: first two FAIL — sources mint as `src/mod#handleEvents>start` / `src/mod#start` (the non-boundary declarator segment is skipped today). Third PASSES (pin).

- [ ] **Step 3: Create `src/indexer/scope-path.ts` with the path helpers**

extract-references.ts is at its 300-line lint budget after Task 2's post-pass, so the path helpers move to their own module. Create `src/indexer/scope-path.ts`:

```ts
import type { Node as SyntaxNode } from 'web-tree-sitter'

// A boundary is a node that OWNS a symbol row (see extract-symbols' declarationTypes). A named
// function expression used as a bare callback (`register(function inner(){})`) is deliberately NOT
// included: extract-symbols emits no symbol for it, so treating it as a boundary here would attribute
// references to a phantom `outer>inner` source that no symbol backs. Such references belong to the
// nearest REAL enclosing symbol. Function/arrow expressions bound to a variable declarator ARE
// boundaries — the declarator itself is the symbol row.
export const isNamedScopeBoundary = (node: SyntaxNode): boolean =>
  node.type === 'function_declaration' ||
  node.type === 'class_declaration' ||
  node.type === 'abstract_class_declaration' ||
  node.type === 'method_definition' ||
  (node.type === 'variable_declarator' &&
    (node.childForFieldName('value')?.type === 'arrow_function' ||
      node.childForFieldName('value')?.type === 'function_expression'))

// A non-boundary variable_declarator still owns a path segment in extract-symbols' qualified names
// (`const stream = new ReadableStream({ start(){…} })` → `…>stream>start`). Its name rides as a
// PENDING segment: it joins the path only when a nested boundary is minted beneath it, so plain
// `const body = f()` stays transparent (the Slice 4a indexer/oracle agreement) and a direct
// reference in the initializer attributes to the enclosing symbol, not the declarator.
export const pendingSegmentsFor = (node: SyntaxNode, pending: readonly string[]): readonly string[] => {
  if (node.type !== 'variable_declarator') return pending
  const name = node.childForFieldName('name')?.text
  return name === undefined ? pending : [...pending, name]
}

// Mint a boundary's qualified name from the enclosing path, the pending declarator segments threaded
// through non-boundary declarators, and the boundary's own name.
export const nextEnclosingSymbol = (
  moduleKey: string,
  node: SyntaxNode,
  enclosingSymbol: string | null,
  pending: readonly string[],
): string | null => {
  const functionName = node.childForFieldName('name')?.text
  if (functionName === undefined) return enclosingSymbol
  const path = pending.length === 0 ? functionName : `${pending.join('>')}>${functionName}`
  return enclosingSymbol === null ? `${moduleKey}#${path}` : `${enclosingSymbol}>${path}`
}
```

- [ ] **Step 4: Thread `pending` through extract-references**

In `src/indexer/extract-references.ts`:

1. Import the moved helpers and delete the local `nextEnclosingSymbol` (lines 35-39) and `isNamedScopeBoundary` with its doc comment (lines 41-54):

```ts
import { isNamedScopeBoundary, nextEnclosingSymbol, pendingSegmentsFor } from './scope-path.js'
```

Change `visitChildren` to thread pending:

```ts
const visitChildren = (
  node: SyntaxNode,
  enclosingSymbol: string | null,
  pending: readonly string[],
  visit: (child: SyntaxNode, childEnclosingSymbol: string | null, childPending: readonly string[]) => void,
): void => {
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index)
    if (child !== null) visit(child, enclosingSymbol, pending)
  }
}
```

In `visit`, add the third defaulted parameter:

```ts
  const visit = (node: SyntaxNode, enclosingSymbol: string | null, pending: readonly string[] = []): void => {
```

Boundary branch (pending consumed at the mint, cleared inside):

```ts
    if (isNamedScopeBoundary(node)) {
      visitChildren(node, nextEnclosingSymbol(input.moduleKey, node, enclosingSymbol, pending), [], visit)
      return
    }
```

Final fall-through (non-boundary declarators push their name):

```ts
    visitChildren(node, enclosingSymbol, pendingSegmentsFor(node, pending), visit)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/indexer/extract-references.test.ts && bun test tests/indexer/ && bun test tests/extract-symbols.test.ts`
Expected: PASS — including all pre-existing attribution tests (arrow-var consts are boundaries; the bare named-function-expression callback pin is unaffected).

- [ ] **Step 6: Add the fixture nested-boundary case**

Create `bench/fixtures/impact-demo/src/stream.ts`:

```ts
export function streamCalled(): number {
  return 1
}
```

Create `bench/fixtures/impact-demo/src/stream-consumer.ts`:

```ts
import { streamCalled } from './stream'

export function handleEvents(): unknown {
  const stream = new ReadableStream({
    start() {
      return streamCalled()
    },
    cancel() {
      return streamCalled()
    },
  })
  return stream
}
```

Verify end-to-end WITHOUT writing a baseline:

Run: `bun run bench/impact-run.ts --repo bench/fixtures/impact-demo`
Expected: the two `streamCalled` calls resolve with sources `src/stream-consumer#handleEvents>stream>start` and `…>cancel` (pre-fix the callers were dropped — phantom source). Baseline file untouched.

- [ ] **Step 7: Lint, typecheck, format**

Run: `bun run lint && bun run typecheck && bun run format:check`
Expected: all clean (extract-references.ts stays under the 300-line budget — the helpers moved to scope-path.ts).

- [ ] **Step 8: Commit**

```bash
git add src/indexer/scope-path.ts src/indexer/extract-references.ts tests/indexer/extract-references.test.ts bench/fixtures/impact-demo/src/stream.ts bench/fixtures/impact-demo/src/stream-consumer.ts
git commit -m "fix(indexer): agree nested scope-path attribution with extract-symbols (Slice 7, residue #4/#5)"
```

---

### Task 4: B5 minimal — star re-export forwarding + namespace import edges

**Files:**
- Modify: `src/types.ts:5` (`ExportKind` union)
- Modify: `src/indexer/collect-export-candidates.ts` (star row + namespace-import collector)
- Modify: `src/indexer/extract-references.ts` (namespace-import dispatch, one line + import)
- Modify: `src/storage/queries.ts:261-285` (`selectAllModuleExports` returns `exportKind`)
- Modify: `src/resolver/resolve-references.ts` (`ModuleExportSummary` gains `exportKind`; star fallback in `buildReexportResolver`; `'*'` marker branch in `findResolvedSymbol`)
- Test: `tests/indexer/extract-references.test.ts`, `tests/resolver/resolve-references.test.ts`, `tests/storage/queries.test.ts`
- Fixture: `bench/fixtures/impact-demo/src/star-target.ts`, `bench/fixtures/impact-demo/src/star-index.ts`, `bench/fixtures/impact-demo/src/star-caller.ts` (new files)

**Interfaces:**
- Produces: `ExportKind = 'named' | 'default' | 'namespace' | 'reexport' | 'star'`; `ModuleExportSummary.exportKind: ExportKind`; `buildReexportResolver` follows per-name misses through a module's star rows (first hit wins, same depth cap); `targetExportName === '*'` marks a namespace import — resolves to `file_resolved` with `targetSymbolId null`, never name-matches.

- [ ] **Step 1: Write the failing tests**

Append to `tests/indexer/extract-references.test.ts`:

```ts
  test('export * from records a star forwarding export row (B5)', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const tree = parsed.parser.parse("export * from './star-target.js'")
    expect(tree).not.toBeNull()

    const { moduleExports } = extractReferenceCandidates({
      source: "export * from './star-target.js'",
      tree: tree!,
      relativeFilePath: 'src/star-index.ts',
      moduleKey: 'src/star-index',
    })

    expect(moduleExports).toEqual([
      { exportName: '*', exportKind: 'star', localName: null, targetModuleSpecifier: './star-target.js' },
    ])
  })

  test('import * as ns records a module-level import edge marked with targetExportName *', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = ["import * as schema from './schema.js'", 'export function run() { return schema.table() }'].join(
      '\n',
    )
    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const { references } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/run.ts',
      moduleKey: 'src/run',
    })

    const nsImport = references.find((ref) => ref.edgeType === 'imports')
    expect(nsImport).toBeDefined()
    expect(nsImport!.targetName).toBe('schema')
    expect(nsImport!.targetExportName).toBe('*')
    expect(nsImport!.targetModuleSpecifier).toBe('./schema.js')
  })
```

Append to `tests/resolver/resolve-references.test.ts` (inside the existing `describe`):

```ts
  test('star barrel: caller resolves a star-forwarded name through the chain (B5)', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        {
          id: 1,
          qualifiedName: 'src/star-target#starCalled',
          localName: 'starCalled',
          moduleKey: 'src/star-target',
          exportNames: ['starCalled'],
        },
      ],
      moduleAliases: [],
      files: [
        { id: 10, moduleKey: 'src/star-index' },
        { id: 11, moduleKey: 'src/star-target' },
      ],
      moduleExports: [
        {
          moduleKey: 'src/star-index',
          exportName: '*',
          exportKind: 'star',
          symbolId: null,
          targetModuleSpecifier: './star-target',
        },
        {
          moduleKey: 'src/star-target',
          exportName: 'starCalled',
          exportKind: 'named',
          symbolId: 1,
          targetModuleSpecifier: null,
        },
      ],
      references: [
        {
          sourceQualifiedName: null,
          edgeType: 'imports',
          targetName: 'starCalled',
          targetExportName: 'starCalled',
          targetModuleSpecifier: './star-index',
          lineNumber: 1,
        },
      ],
      currentModuleKey: 'src/caller',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: 1, confidence: 'resolved' })
  })

  test('namespace import resolves to the file only and never name-matches a same-named local (B5)', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [{ id: 1, qualifiedName: 'src/ns#ns', localName: 'ns', moduleKey: 'src/ns', exportNames: [] }],
      moduleAliases: [],
      files: [{ id: 10, moduleKey: 'src/ns' }],
      moduleExports: [],
      references: [
        {
          sourceQualifiedName: null,
          edgeType: 'imports',
          targetName: 'ns',
          targetExportName: '*',
          targetModuleSpecifier: './ns',
          lineNumber: 1,
        },
      ],
      currentModuleKey: 'src/caller',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: null, confidence: 'file_resolved', targetFileId: 10 })
  })
```

Append to `tests/storage/queries.test.ts` (self-contained raw SQL, matching the file's established raw-INSERT style; add `selectAllModuleExports` to the file's existing `queries.js` import and reuse its `Database`/`ensureSchema` imports):

```ts
describe('selectAllModuleExports', () => {
  test('returns export_kind alongside the other columns', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    db.query(
      `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at) VALUES (1, 'src/star-index.ts', 'src/star-index', 'ts', 'x', 'indexed', NULL, datetime('now'))`,
    ).run()
    db.query(
      `INSERT INTO module_exports (id, file_id, export_name, export_kind, symbol_id, target_module_specifier) VALUES (1, 1, '*', 'star', NULL, './star-target')`,
    ).run()

    const rows = selectAllModuleExports(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      moduleKey: 'src/star-index',
      exportName: '*',
      exportKind: 'star',
      symbolId: null,
      targetModuleSpecifier: './star-target',
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/indexer/extract-references.test.ts tests/resolver/resolve-references.test.ts tests/storage/queries.test.ts`
Expected: FAIL — star form records no row; `import * as` emits no imports edge; star-chain call resolves null; namespace import falls through to name matching; `selectAllModuleExports` omits `exportKind`.

- [ ] **Step 3: Implement**

`src/types.ts:5`:

```ts
export type ExportKind = 'named' | 'default' | 'namespace' | 'reexport' | 'star'
```

`src/indexer/collect-export-candidates.ts` — add a direct-child star detector (verified against the grammar: the bare form has `*` as a DIRECT child of `export_statement`; `export * as ns` nests `*` inside `namespace_export`, so it never matches and stays out of scope):

```ts
const hasStarToken = (node: SyntaxNode): boolean => {
  for (let index = 0; index < node.childCount; index += 1) {
    if (node.child(index)?.type === '*') return true
  }
  return false
}
```

and at the top of `collectExportCandidates`, right after `sourceSpecifier`:

```ts
  // B5: `export * from './y'` forwards every name — recorded as ONE star row the resolver's chain
  // follows per-name. `export * as ns` (namespace re-export) is out of scope (no measured mass).
  if (sourceSpecifier !== null && hasStarToken(node)) {
    moduleExports.push({
      exportName: '*',
      exportKind: 'star',
      localName: null,
      targetModuleSpecifier: sourceSpecifier,
    })
    return
  }
```

Still in `collect-export-candidates.ts`, add the namespace-import collector (lives here to keep extract-references.ts under its 300-line budget):

```ts
// `import * as ns from './m'` (B5): the namespace object itself gets a module-level import edge.
// targetExportName '*' marks the namespace form; the alias is an unnamed identifier child of
// namespace_import (verified against the grammar — no name/alias field). Member access ns.m() is
// obj.m()-adjacent and stays deferred.
export const collectNamespaceImportReference = (node: SyntaxNode, references: ReferenceCandidate[]): void => {
  let localName: string | undefined
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index)
    if (child?.type === 'identifier') localName = child.text
  }
  if (localName === undefined) return
  const importStatement = node.parent?.parent
  references.push({
    sourceQualifiedName: null,
    edgeType: 'imports',
    targetName: localName,
    targetExportName: '*',
    targetModuleSpecifier: normalizeSpecifier(importStatement?.childForFieldName('source')),
    lineNumber: node.startPosition.row + 1,
  })
}
```

`src/indexer/extract-references.ts` — import `collectNamespaceImportReference` alongside `collectExportCandidates` and add one dispatch line next to the `import_specifier` line in `visit`:

```ts
    if (node.type === 'namespace_import') collectNamespaceImportReference(node, references)
```

`src/storage/queries.ts` — `selectAllModuleExports` selects and maps `export_kind` (add `import type { ExportKind } from '../types.js'` if absent):

```ts
export const selectAllModuleExports = (
  db: Database,
): readonly {
  moduleKey: string
  exportName: string
  exportKind: ExportKind
  symbolId: number | null
  targetModuleSpecifier: string | null
}[] =>
  db
    .query<
      {
        module_key: string
        export_name: string
        export_kind: ExportKind
        symbol_id: number | null
        target_module_specifier: string | null
      },
      []
    >(
      `SELECT f.module_key AS module_key, me.export_name AS export_name, me.export_kind AS export_kind,
              me.symbol_id AS symbol_id, me.target_module_specifier AS target_module_specifier
       FROM module_exports me JOIN files f ON f.id = me.file_id
       WHERE f.parse_status = 'indexed'`,
    )
    .all()
    .map((row) => ({
      moduleKey: row.module_key,
      exportName: row.export_name,
      exportKind: row.export_kind,
      symbolId: row.symbol_id,
      targetModuleSpecifier: row.target_module_specifier,
    }))
```

`src/resolver/resolve-references.ts` — `ModuleExportSummary` gains the kind:

```ts
type ModuleExportSummary = {
  readonly moduleKey: string
  readonly exportName: string
  readonly exportKind: 'named' | 'default' | 'namespace' | 'reexport' | 'star'
  readonly symbolId: number | null
  readonly targetModuleSpecifier: string | null
}
```

Update the comment above `buildReexportResolver` (the sentence "or an `export *` star, records no forwarding symbol; B4 covers…" now reads: star rows ARE recorded and followed per-name) and rewrite the builder:

```ts
const buildReexportResolver = (
  moduleExports: readonly ModuleExportSummary[],
): ((moduleKey: string, exportName: string) => number | null) => {
  const byModule = new Map<string, Map<string, ModuleExportSummary>>()
  const starSourcesByModule = new Map<string, string[]>()
  for (const moduleExport of moduleExports) {
    if (moduleExport.exportKind === 'star') {
      if (moduleExport.targetModuleSpecifier === null) continue
      const sources = starSourcesByModule.get(moduleExport.moduleKey) ?? []
      sources.push(moduleExport.targetModuleSpecifier)
      starSourcesByModule.set(moduleExport.moduleKey, sources)
      continue
    }
    const forModule = byModule.get(moduleExport.moduleKey) ?? new Map<string, ModuleExportSummary>()
    forModule.set(moduleExport.exportName, moduleExport)
    byModule.set(moduleExport.moduleKey, forModule)
  }
  const resolve = (moduleKey: string, exportName: string, depth: number): number | null => {
    if (depth > 8) return null
    const entry = byModule.get(moduleKey)?.get(exportName)
    if (entry !== undefined) {
      if (entry.symbolId !== null) return entry.symbolId
      if (entry.targetModuleSpecifier === null) return null
      return resolve(normalizeRelativeModule(moduleKey, entry.targetModuleSpecifier), exportName, depth + 1)
    }
    // B5: no named row — try the module's star sources (`export * from './y'`), first hit wins.
    for (const specifier of starSourcesByModule.get(moduleKey) ?? []) {
      const bridged = resolve(normalizeRelativeModule(moduleKey, specifier), exportName, depth + 1)
      if (bridged !== null) return bridged
    }
    return null
  }
  return (moduleKey, exportName) => resolve(moduleKey, exportName, 0)
}
```

In `findResolvedSymbol`, add the namespace-marker branch right after the importMap lookup (before `matchedModuleKeyForFile`):

```ts
  // B5: a namespace import (`import * as ns`) resolves to its module file only — never to a
  // symbol. A target module declaring a local named `ns` must not capture the import.
  if (reference.targetExportName === '*') {
    return { targetSymbolId: null, confidence: matchedFileId === null ? 'name_only' : 'file_resolved' }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/indexer/ tests/resolver/ tests/storage/ && bun test tests/impact.test.ts`
Expected: PASS — pre-existing tests unaffected (their `moduleExports` inputs omit `exportKind`; the field is only read for `'star'`).

- [ ] **Step 5: Add the fixture star case**

Create `bench/fixtures/impact-demo/src/star-target.ts`:

```ts
export function starCalled(): number {
  return 1
}
```

Create `bench/fixtures/impact-demo/src/star-index.ts`:

```ts
export * from './star-target'
```

Create `bench/fixtures/impact-demo/src/star-caller.ts`:

```ts
import { starCalled } from './star-index'

export function useStar(): number {
  return starCalled()
}
```

Verify end-to-end WITHOUT writing a baseline:

Run: `bun run bench/impact-run.ts --repo bench/fixtures/impact-demo`
Expected: the `starCalled` call from `useStar` resolves through the star chain (pre-fix: call FN). The pre-existing namespace case (`ns.nsCalled()`) stays an FN — `ns.member` is out of scope. Baseline file untouched.

- [ ] **Step 6: Lint, typecheck, format**

Run: `bun run lint && bun run typecheck && bun run format:check`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/indexer/collect-export-candidates.ts src/indexer/extract-references.ts src/storage/queries.ts src/resolver/resolve-references.ts tests/indexer/extract-references.test.ts tests/resolver/resolve-references.test.ts tests/storage/queries.test.ts bench/fixtures/impact-demo/src/star-target.ts bench/fixtures/impact-demo/src/star-index.ts bench/fixtures/impact-demo/src/star-caller.ts
git commit -m "feat(indexer): star re-export forwarding and namespace import edges (Slice 7, B5)"
```

---

### Task 5: Reindex verification, baseline regeneration, full gates, ledger

**Files:**
- Modify: `bench/baseline.json`, `bench/baseline.papai.json`, `bench/impact-baseline.json`, `bench/impact-baseline.papai.json`, `bench/impact-baseline.fixture.json`, `bench/index-baseline.json` (regenerated)
- Modify: `.superpowers/sdd/progress.md` (slice completion entry)

**Interfaces:**
- Consumes: Tasks 1–4.

- [ ] **Step 1: Reindex both working repos and verify the measured fixes in the DBs**

```bash
bun run start index ../papai
bun run start index
```

Then the C2 measured-false-edge check (spec success metric: 157 → 0 on papai):

```bash
sqlite3 ../papai/.codeindex/index.db "SELECT COUNT(*) FROM symbol_references WHERE confidence='name_only' AND target_file_id IS NULL AND target_symbol_id IS NOT NULL AND target_module_specifier IS NOT NULL;"
sqlite3 .codeindex/index.db "SELECT COUNT(*) FROM symbol_references WHERE confidence='name_only' AND target_file_id IS NULL AND target_symbol_id IS NOT NULL AND target_module_specifier IS NOT NULL;"
```

Expected: `0` and `0` (pre-fix: 157 and 0).

Residue #7 linking check (spec: 82 NULL/NULL rows before):

```bash
sqlite3 ../papai/.codeindex/index.db "SELECT COUNT(*) FROM module_exports WHERE export_kind='named' AND symbol_id IS NULL AND target_module_specifier IS NULL;"
```

Expected: a large drop from 82 (residual = export rows whose local name matches no import — record the actual number in the ledger).

- [ ] **Step 2: Regenerate all six baselines at HEAD**

```bash
bun run bench --baseline bench/baseline.json --update-baseline
bun run bench/run.ts --repo ../papai --corpus bench/corpus/papai.json --baseline bench/baseline.papai.json --update-baseline
bun run bench/impact-run.ts --baseline bench/impact-baseline.json --update-baseline
bun run bench/impact-run.ts --repo ../papai --max-targets 300 --baseline bench/impact-baseline.papai.json --update-baseline
bun run bench/impact-run.ts --repo bench/fixtures/impact-demo --baseline bench/impact-baseline.fixture.json --update-baseline
bun run bench/index-bench-run.ts --baseline bench/index-baseline.json --update-baseline
```

Expected: all exit 0; `git status` shows only the baseline JSONs.

- [ ] **Step 3: Verify the gates moved or held**

Inspect the regenerated impact baselines against the committed pre-slice values:
- papai `valueFalseNegativeRate` (was 0.0788): must be flat-or-better — expected improvement, the 3 remaining call FNs (#7 + #4/#5) close. If it REGRESSES, stop and surface to the user before proceeding.
- papai `falsePositiveRate` (was 0): must stay 0.
- fixture value FN: expected to improve (3 new call FNs closed across Tasks 2–4).
- IR search baselines (Step 2 exit codes): up-or-flat is the gate. The C2 removal shifts `in_degree` for ~15 papai symbols — if a papai search metric regressed, STOP and surface to the user: `IN_DEGREE_WEIGHT = 15` is frozen, so a regression here is a user decision, not a knob to turn.

- [ ] **Step 4: Full gate**

Run: `bun run check`
Expected: EXIT 0 — lint 0/0, typecheck clean, format clean, full test suite green, all four `check:bench` commands green against the fresh baselines.

- [ ] **Step 5: Update progress and commit**

Append the Slice 7 completion entry to `.superpowers/sdd/progress.md` in the established format: code range, per-task commit ranges, the measured C2 count (157 → 0), the #7 residual count, the impact gate movement (papai valueFN before/after, FP held 0, call residue 3 → 0), IR gate status, and the note that the type-ref follow-up spec is next (user decision: after Slice 7).

```bash
git add -A
git commit -m "chore(slice7): regenerate baselines, verify graph-completion gates green"
```

---

## Self-Review Notes

- **Spec coverage:** Unit 1 C2 → Task 1; Unit 2 #7 → Task 2 (+ fixture barrel case); Unit 3 #4/#5 → Task 3 (+ fixture stream case, 4a transparency pin); Unit 4 B5 minimal → Task 4 (star row, chain follow, ns import edge, `'*'` no-name-match branch, fixture star case); migration (none) → header constraint; baselines/gates/ledger → Task 5. Out-of-scope items (dedup verified non-issue, `ns.member`, `export * as ns`, `obj.m()`, type-ref spec) have no tasks — correct.
- **Type consistency:** `ExportKind` gains `'star'` and `ModuleExportSummary.exportKind` is introduced and consumed in the same task (Task 4); `isNamedScopeBoundary` / `pendingSegmentsFor` / `nextEnclosingSymbol` (4-arg) live in `src/indexer/scope-path.ts` from Task 3 onward, and `visit`'s defaulted third param is defined and used only within Task 3; `specifierByImportedName` is Task 2-local. Task 4's resolver tests construct `moduleExports` WITH `exportKind` — the field is added in that task's Step 3 (tests written first, observed failing at Step 2).
- **Known coupling:** Tasks 2 and 3 both edit `extract-references.ts` — sequential order enforced; Task 3's `visit` signature change is what Task 4's one-line dispatch leans on (dispatch is pending-independent). Fixture baselines go stale from Task 2 onward — expected mid-slice redness, per Global Constraints.
