# Phase 2 Slice 8 — Type-Ref Edge (B7 closure) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the B7 gap — type-position identifier references (`: Task` annotations, `Promise<T>` generics, type-alias RHS, as-casts, call/new type arguments, interface `extends_type_clause`) emit a new `'type_refs'` edge resolved through the existing import map plus a kind-filtered same-module arm, collapsing papai `typeFalseNegativeRate` 1.0 → ~0 with **no schema bump**.

**Architecture:** Unit 1 adds one collector + one dispatch line to the reference walk (type positions are already traversed but `type_identifier` matches no branch today — inert). Unit 2 threads `kind` through `selectAllSymbols` and adds a type-ref resolver arm (new file `src/resolver/resolve-type-refs.ts` — resolve-references.ts is at its line budget) that binds bare type refs only to type-shaped symbols (`interface_declaration` | `type_alias_declaration` | `enum_declaration` | `class_declaration` | `abstract_class_declaration`). Unit 3 relabels type-tier bench shapes `bare-value` → `named-type` (diagnostic-only) and adds the fixture case. Unit 4 reindexes, measures, regenerates all six baselines, runs the full gate.

**Tech Stack:** Bun, TypeScript, SQLite (bun:sqlite), web-tree-sitter, TypeScript compiler API (bench oracle), oxlint/oxfmt.

**Spec:** `docs/superpowers/specs/2026-09-04-phase2-typeref-edge-b7-design.md`

**Slice numbering note:** this is Phase 2 Slice 8. The Phase 3 roadmap's "Slice 8 (remaining deferral pool)" precondition now refers to a Slice 9 (payload economics / navigation / transaction batching + accumulated minors) — the pool itself is unchanged and still gates Phase 3.

## Global Constraints

- **No SCHEMA_VERSION bump** — `edge_type` is free TEXT (no CHECK); a new value is a type-union change only (two sites: `src/types.ts:7` and the resolver's local union copy). Adding `kind` to a SELECT is not DDL — the column already exists.
- Gates: papai `valueFalseNegativeRate` flat-or-better (0.0685); `falsePositiveRate` stays 0 (**the risk gate** — kind-filtered same-module binds are the only new FP surface); IR search precision@k + MRR up-or-flat; papai `typeFalseNegativeRate` (1.0) and self (0.9923) must improve materially — that improvement is the point of the slice. `IN_DEGREE_WEIGHT = 15` is frozen — in_degree WILL grow (~hundreds of type_refs rows); if a search metric regresses, STOP and surface (user decision, same protocol as Slice 7 Task 5).
- Baselines are regenerated ONLY in Task 4. Intermediate tasks must not write baseline files; the fixture files added in Task 3 make the fixture gate stale — expected, verified WITHOUT `--update-baseline`.
- Every fix lands RED→GREEN: the failing test is written and observed failing before the implementation.
- After each task: `bun run lint && bun run typecheck && bun run format:check` clean, targeted tests green. Full `bun run check` only in Task 4.
- Conventional commits matching repo history (`feat(indexer): …`, `feat(resolver): …`, `chore(slice8): …`).
- Line budgets: `src/indexer/extract-references.ts` 278/300, `src/resolver/resolve-references.ts` 279/300, `src/storage/queries.ts` 294/300 — all tight. The plan's additions are sized to fit; if a task trips `max-lines` or `max-lines-per-function` (50), extract a helper file (established Slice 4 Task 1 / scope-path.ts deviation pattern) and note it in the ledger. Do NOT restructure beyond that remedy.
- `bun run start index ../papai` is INFEASIBLE (the CLI ignores positional args — src/cli.ts:101 always indexes cwd). Task 4 uses the corrected cwd-based invocation.

---

### Task 1: Extraction — bare `type_identifier` nodes emit `type_refs` candidates

**Files:**
- Modify: `src/types.ts:7` (`ReferenceEdgeType` union)
- Modify: `src/indexer/extract-references.ts` (new `collectTypeReference` + one dispatch line; heritage comment update)
- Test: `tests/indexer/extract-references.test.ts`

**Interfaces:**
- Consumes: the existing walk (`visit` at extract-references.ts:241; the fall-through already recurses into type-annotation subtrees, but `type_identifier` matches no branch and is inert today).
- Produces: `ReferenceCandidate`s with `edgeType: 'type_refs'`, `targetName` = the bare type identifier's text, `sourceQualifiedName` = the enclosing symbol (Slice 7 scope paths), `targetExportName: null`, `targetModuleSpecifier: null`, `lineNumber`. Heritage-clause DIRECT children are excluded (their `extends`/`implements` edges already exist); type arguments nested inside a heritage clause (`implements Foo<Bar>` → `Bar`) are NOT excluded and emit here (no double-count: B3 emits only bare direct children). Builtins (`string`, `number` — `predefined_type` nodes), qualified types (`ns.Task` — `nested_type_identifier`), and `typeof X` operands (value `identifier`s) never reach this collector.

- [ ] **Step 1: Write the failing tests**

Append inside the existing top-level `describe` of `tests/indexer/extract-references.test.ts` (after the last test, before the closing `})`):

```ts
  test('type annotations emit type_refs candidates attributed to the enclosing symbol (B7)', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = ['export function process(task: Task): Task {', '  return task', '}'].join('\n')
    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const { references } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/task-user.ts',
      moduleKey: 'src/task-user',
    })

    const typeRefs = references.filter((ref) => ref.edgeType === 'type_refs')
    expect(typeRefs).toHaveLength(2)
    expect(typeRefs[0]).toMatchObject({
      sourceQualifiedName: 'src/task-user#process',
      targetName: 'Task',
      targetExportName: null,
      targetModuleSpecifier: null,
    })
  })

  test('generic type arguments emit type_refs; builtin types stay out by node type (B7)', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = 'const cache = new Map<string, Task>()'
    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const { references } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/mod.ts',
      moduleKey: 'src/mod',
    })

    const typeRefs = references.filter((ref) => ref.edgeType === 'type_refs')
    expect(typeRefs.map((ref) => ref.targetName)).toEqual(['Map', 'Task'])
  })

  test('heritage-clause children do not double-emit; interface extends_type_clause emits type_refs (B7)', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = ['class Widget implements Shape {}', 'interface Base {}', 'interface Derived extends Base {}'].join(
      '\n',
    )
    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const { references } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/mod.ts',
      moduleKey: 'src/mod',
    })

    const typeRefs = references.filter((ref) => ref.edgeType === 'type_refs')
    expect(typeRefs.map((ref) => ref.targetName)).toEqual(['Base'])
    const implementsRefs = references.filter((ref) => ref.edgeType === 'implements')
    expect(implementsRefs.map((ref) => ref.targetName)).toEqual(['Shape'])
  })

  test('qualified types and typeof operands stay out of type_refs (B7)', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = [
      'import { makeApi } from "./api"',
      'let config: ns.Settings',
      'const factory: typeof makeApi = makeApi',
    ].join('\n')
    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const { references } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/mod.ts',
      moduleKey: 'src/mod',
    })

    const typeRefs = references.filter((ref) => ref.edgeType === 'type_refs')
    expect(typeRefs).toEqual([])
  })

  test('as-cast types emit type_refs (B7)', async () => {
    const loader = await createParserLoader()
    const parsed = await loader.createParserForExtension('.ts')
    const source = 'const y = input as Task'
    const tree = parsed.parser.parse(source)
    expect(tree).not.toBeNull()

    const { references } = extractReferenceCandidates({
      source,
      tree: tree!,
      relativeFilePath: 'src/mod.ts',
      moduleKey: 'src/mod',
    })

    const typeRefs = references.filter((ref) => ref.edgeType === 'type_refs')
    expect(typeRefs.map((ref) => ref.targetName)).toEqual(['Task'])
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/indexer/extract-references.test.ts`
Expected: the five new tests FAIL. If TypeScript rejects `'type_refs'` (not yet in the `ReferenceEdgeType` union) and blocks the run, apply ONLY the union hunk from Step 3 first, then re-run and observe the behavioral RED: zero `type_refs` rows are emitted because no collector exists. All pre-existing tests stay green.

- [ ] **Step 3: Implement**

`src/types.ts:7` — replace the union:

```ts
export type ReferenceEdgeType =
  | 'imports'
  | 'reexports'
  | 'calls'
  | 'extends'
  | 'implements'
  | 'references'
  | 'type_refs'
```

`src/indexer/extract-references.ts` — insert after `collectHeritageReferences` (ends line 211), before `linkImportedSpecifiers`:

```ts
// B7: a bare `type_identifier` in type position is a named type reference (`: Task` annotations,
// `Promise<T>` generics, as-casts, call/new type args, interface `extends_type_clause`). Builtins
// (`string`…) are `predefined_type` nodes and qualified `ns.Task` is `nested_type_identifier` —
// both stay out by node type. Heritage-clause DIRECT children are excluded:
// collectHeritageReferences already emits them; nested type args inside a heritage clause still
// emit here (no double-count — B3 emits only bare direct children).
const collectTypeReference = (
  node: SyntaxNode,
  enclosingSymbol: string | null,
  references: ReferenceCandidate[],
): void => {
  const parent = node.parent
  if (parent !== null && (parent.type === 'implements_clause' || parent.type === 'extends_clause')) return
  references.push({
    sourceQualifiedName: enclosingSymbol,
    edgeType: 'type_refs',
    targetName: node.text,
    targetExportName: null,
    targetModuleSpecifier: null,
    lineNumber: node.startPosition.row + 1,
  })
}
```

Add one dispatch line next to the heritage dispatch (after the `extends_clause`/`implements_clause` block, before the fall-through):

```ts
    if (node.type === 'type_identifier') collectTypeReference(node, enclosingSymbol, references)
```

Update the stale heritage comment (extract-references.ts:173-176) — the `extends_type_clause` deferral is now closed:

```ts
  // Only class heritage reaches here: a class's `extends` is an `extends_clause`, its
  // `implements` an `implements_clause`. An interface's `extends` is an `extends_type_clause`
  // (type position) — its bare type identifiers emit as `type_refs` via collectTypeReference (B7).
```

Line-budget note: the file starts at 278; additions are +1 (dispatch) +23 (collector incl. comment) −1 (comment trim) ≈ 301. If lint trips `max-lines`, condense the collector's doc comment to three lines (keep every factual claim: node-type exclusions, parent-level heritage exclusion, no-double-count rationale). Do not extract a helper file unless condensation is insufficient.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/indexer/ && bun test tests/extract-symbols.test.ts`
Expected: PASS — all five new tests green, all pre-existing extraction tests unchanged (heritage/JSX/value paths untouched; `type_identifier` never reached the value branch).

- [ ] **Step 5: Lint, typecheck, format**

Run: `bun run lint && bun run typecheck && bun run format:check`
Expected: all clean; extract-references.ts ≤ 300 lines.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/indexer/extract-references.ts tests/indexer/extract-references.test.ts
git commit -m "feat(indexer): emit type_refs candidates for bare type-position identifiers (Slice 8, B7)"
```

---

### Task 2: Resolution — kind-filtered same-module bind for type refs

**Files:**
- Modify: `src/storage/queries.ts:224-244` (`selectAllSymbols` gains `kind`)
- Modify: `src/resolver/resolve-references.ts` (`SymbolSummary.kind?`, local union, import, dispatch in `findResolvedSymbol`)
- Create: `src/resolver/resolve-type-refs.ts` (`TYPE_SHAPED_KINDS` + `resolveTypeReference` — resolve-references.ts is at its line budget and `findResolvedSymbol` at 42/50 function lines)
- Test: `tests/resolver/resolve-references.test.ts`

**Interfaces:**
- Consumes: Task 1's `'type_refs'` candidates (no specifier, bare targetName). The resolver's importMap (built from `'imports'` rows, resolve-references.ts:257-259) — `import type { X }` and `import { type X }` already produce normal imports rows, so import-backed type refs resolve there with NO new code.
- Produces: `SymbolSummary.kind?: string` (optional — pre-existing test fixtures omit it; `undefined` is treated as non-type-shaped and refuses to bind; production `selectAllSymbols` always supplies it). `resolveTypeReference(input, reference): Readonly<{ targetSymbolId: number | null; confidence: 'name_only' }>` — same-module bind ONLY when the reference has no specifier AND a symbol with `localName === targetName`, `moduleKey === currentModuleKey`, and `kind` ∈ `TYPE_SHAPED_KINDS` exists. `findResolvedSymbol` dispatches to it just before the `resolveByLocalName` fall-through; the B6 guard (edgeType `'references'` only) and C2 suppression are untouched and compose.

- [ ] **Step 1: Write the failing tests**

Append inside the existing top-level `describe` of `tests/resolver/resolve-references.test.ts` (before the closing `})`):

```ts
  test('import-backed type reference resolves through the import map (B7)', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        {
          id: 1,
          qualifiedName: 'src/task-types#Task',
          localName: 'Task',
          moduleKey: 'src/task-types',
          exportNames: ['Task'],
          kind: 'interface_declaration',
        },
      ],
      moduleAliases: [],
      files: [{ id: 10, moduleKey: 'src/task-types' }],
      references: [
        {
          sourceQualifiedName: null,
          edgeType: 'imports',
          targetName: 'Task',
          targetExportName: 'Task',
          targetModuleSpecifier: './task-types',
          lineNumber: 1,
        },
        {
          sourceQualifiedName: 'src/task-user#process',
          edgeType: 'type_refs',
          targetName: 'Task',
          targetExportName: null,
          targetModuleSpecifier: null,
          lineNumber: 3,
        },
      ],
      currentModuleKey: 'src/task-user',
    })
    expect(resolved[1]).toMatchObject({
      targetSymbolId: 1,
      confidence: 'resolved',
      edgeType: 'type_refs',
      targetFileId: null,
    })
  })

  test('same-module type reference binds to a type-shaped symbol (B7 kind filter)', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        {
          id: 1,
          qualifiedName: 'src/mod#Task',
          localName: 'Task',
          moduleKey: 'src/mod',
          exportNames: [],
          kind: 'interface_declaration',
        },
      ],
      moduleAliases: [],
      files: [],
      references: [
        {
          sourceQualifiedName: 'src/mod#process',
          edgeType: 'type_refs',
          targetName: 'Task',
          targetExportName: null,
          targetModuleSpecifier: null,
          lineNumber: 2,
        },
      ],
      currentModuleKey: 'src/mod',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: 1, confidence: 'name_only' })
  })

  test('same-module type reference refuses non-type-shaped and kind-less symbols (B7 kind filter)', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        {
          id: 1,
          qualifiedName: 'src/mod#Task',
          localName: 'Task',
          moduleKey: 'src/mod',
          exportNames: [],
          kind: 'function_declaration',
        },
        { id: 2, qualifiedName: 'src/mod#Task', localName: 'Task', moduleKey: 'src/mod', exportNames: [] },
      ],
      moduleAliases: [],
      files: [],
      references: [
        {
          sourceQualifiedName: 'src/mod#process',
          edgeType: 'type_refs',
          targetName: 'Task',
          targetExportName: null,
          targetModuleSpecifier: null,
          lineNumber: 2,
        },
      ],
      currentModuleKey: 'src/mod',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: null, confidence: 'name_only' })
  })

  test('C2 composes with type refs: an unmatched specifier binds nothing (B7)', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        {
          id: 1,
          qualifiedName: 'src/mod#Task',
          localName: 'Task',
          moduleKey: 'src/mod',
          exportNames: [],
          kind: 'interface_declaration',
        },
      ],
      moduleAliases: [],
      files: [],
      references: [
        {
          sourceQualifiedName: 'src/mod#process',
          edgeType: 'type_refs',
          targetName: 'Task',
          targetExportName: null,
          targetModuleSpecifier: 'phantom-pkg',
          lineNumber: 2,
        },
      ],
      currentModuleKey: 'src/mod',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: null, confidence: 'name_only', targetFileId: null })
  })
```

- [ ] **Step 2: Run tests to verify they fail (or document the pin shape)**

Run: `bun test tests/resolver/resolve-references.test.ts`
Expected, per test:
- "refuses non-type-shaped and kind-less symbols" — **must FAIL (the discriminating RED)**: today a `type_refs` reference falls through to `resolveByLocalName`, which binds the same-module localName regardless of kind → `targetSymbolId: 1` ≠ null.
- "binds to a type-shaped symbol" — likely PASSES pre-change (the generic same-module bind coincidentally satisfies it); it becomes a real assertion only after the arm routes through the kind filter. Record its pre-change state.
- "import-backed … import map" and "C2 composes" — likely PASS pre-change (importMap resolution is edge-type-agnostic; C2 suppression is already active). Accepted composition-pin shape, same as Slice 7 Task 1's second test. Record each test's pre-change state in the report; the kind-filter RED is the behavioral gate.
All pre-existing tests stay green.

- [ ] **Step 3: Implement**

Create `src/resolver/resolve-type-refs.ts`:

```ts
// B7: the type-ref arm of reference resolution, extracted to its own module (resolve-references.ts
// is near its line budget). A bare `type_identifier` reference (no module specifier) binds ONLY to
// a type-shaped symbol in the current module — interface/type-alias/enum/class declarations —
// never to a same-named function or variable (the kind filter is the FP defense for same-module
// type binds). Import-backed type refs resolve earlier via the import map and never reach here.
// C2 composes upstream: a reference carrying a specifier that matched no file already binds
// nothing; this arm keeps that contract by refusing any reference that still carries a specifier.
const TYPE_SHAPED_KINDS: ReadonlySet<string> = new Set([
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'class_declaration',
  'abstract_class_declaration',
])

type TypeRefInput = {
  readonly symbols: readonly {
    readonly id: number
    readonly localName: string
    readonly moduleKey: string
    readonly kind?: string
  }[]
  readonly currentModuleKey: string
}

type TypeRefCandidate = {
  readonly targetName: string
  readonly targetModuleSpecifier: string | null
}

export const resolveTypeReference = (
  input: Readonly<TypeRefInput>,
  reference: Readonly<TypeRefCandidate>,
): Readonly<{ targetSymbolId: number | null; confidence: 'name_only' }> => {
  if (reference.targetModuleSpecifier !== null) {
    return { targetSymbolId: null, confidence: 'name_only' }
  }
  const resolvedByKind = input.symbols.find(
    (symbol) =>
      symbol.localName === reference.targetName &&
      symbol.moduleKey === input.currentModuleKey &&
      symbol.kind !== undefined &&
      TYPE_SHAPED_KINDS.has(symbol.kind),
  )
  return { targetSymbolId: resolvedByKind?.id ?? null, confidence: 'name_only' }
}
```

`src/storage/queries.ts` — `selectAllSymbols` (lines 224-244) selects and maps `kind` (the column already exists; NOT a DDL change):

```ts
export const selectAllSymbols = (
  db: Database,
): readonly {
  id: number
  qualifiedName: string
  localName: string
  moduleKey: string
  exportNames: readonly string[]
  kind: string
}[] =>
  db
    .query<
      {
        id: number
        qualified_name: string
        local_name: string
        module_key: string
        export_names: string
        kind: string
      },
      []
    >('SELECT id, qualified_name, local_name, module_key, export_names, kind FROM symbols')
    .all()
    .map((row) => ({
      id: row.id,
      qualifiedName: row.qualified_name,
      localName: row.local_name,
      moduleKey: row.module_key,
      exportNames: parseStringArray(row.export_names),
      kind: row.kind,
    }))
```

(The file is at 294/300 — this is +4 net. If lint trips `max-lines`, extract the anonymous row type into a named `type SymbolRow = { … }` declared just above the function; do not touch other functions.)

`src/resolver/resolve-references.ts` — three edits:

1. `SymbolSummary` (lines 3-9) gains the optional kind:

```ts
type SymbolSummary = {
  readonly id: number
  readonly qualifiedName: string
  readonly localName: string
  readonly moduleKey: string
  readonly exportNames: readonly string[]
  // Optional: pre-existing test fixtures omit it; production selectAllSymbols always supplies it.
  // Only read for the 'type_refs' kind filter — undefined refuses to bind (safe default).
  readonly kind?: string
}
```

2. The local `ReferenceCandidate` union (line 32) gains the member:

```ts
type ReferenceCandidate = {
  readonly sourceQualifiedName: string | null
  readonly edgeType:
    | 'imports'
    | 'reexports'
    | 'calls'
    | 'extends'
    | 'implements'
    | 'references'
    | 'type_refs'
  readonly targetName: string
  readonly targetExportName: string | null
  readonly targetModuleSpecifier: string | null
  readonly receiver?: 'this'
  readonly lineNumber: number
}
```

3. Import the arm and dispatch in `findResolvedSymbol` right before the final fall-through (`return resolveByLocalName(...)` at line 193) — after the B4 block, so importMap resolution keeps priority:

```ts
import { resolveTypeReference } from './resolve-type-refs.js'
```

```ts
  // B7: a bare type reference binds only through the import map (checked above) or to a
  // type-shaped symbol in the current module. Type refs carry no specifier, so the matched-file
  // and reexport arms above are inert for them.
  if (reference.edgeType === 'type_refs') {
    return resolveTypeReference(input, reference)
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/resolver/ && bun test tests/indexer/ && bun test tests/storage/`
Expected: PASS — all four new tests green; all pre-existing resolver/indexer/storage tests unchanged (their `symbols` inputs omit `kind`; the field is only read for `'type_refs'`).

- [ ] **Step 5: Lint, typecheck, format**

Run: `bun run lint && bun run typecheck && bun run format:check`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/resolver/resolve-type-refs.ts src/resolver/resolve-references.ts src/storage/queries.ts tests/resolver/resolve-references.test.ts
git commit -m "feat(resolver): kind-filtered same-module binding for type_refs (Slice 8, B7)"
```

---

### Task 3: Bench honesty — `named-type` shape label + fixture case

**Files:**
- Modify: `bench/impact-types.ts:3-12` (`Shape` union gains `'named-type'`)
- Modify: `bench/impact-ast.ts` (new `shapeLabelForPosition` helper after `classifyShape`)
- Modify: `bench/impact-oracle.ts:265` (aggregation uses the relabel)
- Create: `tests/bench/impact-ast.test.ts` (unit tests for the helper)
- Create: `bench/fixtures/impact-demo/src/task-types.ts`, `bench/fixtures/impact-demo/src/task-user.ts` (fixture type-ref case)

**Interfaces:**
- Consumes: `classifyPosition`'s per-ref `'value' | 'type'` (impact-ast.ts:25-37) and `classifyShape`'s `Shape` result (impact-ast.ts:57-77, unchanged itself — existing classifyShape pins at tests/bench/impact-oracle.test.ts:226-228 stay green).
- Produces: `shapeLabelForPosition(position: 'value' | 'type', shape: Shape): Shape` — type-position refs report `'named-type'` EXCEPT heritage (`'heritage'` is preserved for `implements`/interface-extends, which `classifyShape` returns for any HeritageClause ancestor). The oracle's per-source shape sets and the four `*ByShape` diagnostic maps may now contain `'named-type'` keys (including value-tier maps via `'both'`-position sources — diagnostic only, no gate reads them).

- [ ] **Step 1: Write the failing test**

Create `tests/bench/impact-ast.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

import { shapeLabelForPosition } from '../../bench/impact-ast.js'

describe('shapeLabelForPosition', () => {
  test('type-position refs report as named-type (B7 relabel)', () => {
    expect(shapeLabelForPosition('type', 'bare-value')).toBe('named-type')
    expect(shapeLabelForPosition('type', 'call')).toBe('named-type')
  })

  test('value-position refs keep their classified shape', () => {
    expect(shapeLabelForPosition('value', 'bare-value')).toBe('bare-value')
    expect(shapeLabelForPosition('value', 'call')).toBe('call')
    expect(shapeLabelForPosition('value', 'heritage')).toBe('heritage')
  })

  test('type-position heritage keeps the heritage label (implements / interface extends)', () => {
    expect(shapeLabelForPosition('type', 'heritage')).toBe('heritage')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bench/impact-ast.test.ts`
Expected: FAIL — `shapeLabelForPosition` does not exist (import error).

- [ ] **Step 3: Implement**

`bench/impact-types.ts` — the union gains the member:

```ts
export type Shape =
  | 'call'
  | 'construct'
  | 'member'
  | 'namespace'
  | 'jsx'
  | 'heritage'
  | 'named-type'
  | 'bare-value'
  | 'property-unknown'
  | 'other'
```

`bench/impact-ast.ts` — append after `classifyShape` (ends line 77):

```ts
// B7 relabel: type-position refs used to fall through classifyShape's value-form checks to
// 'bare-value' (the Slice 6 Unit 0 memo's labeling caveat). With the type-ref edge landed, the
// type tier reports as 'named-type'. Heritage keeps its own label (classifyShape returns it for
// any HeritageClause ancestor, including type-position implements / interface extends).
// Diagnostic-only — shape maps size coverage; no gate reads them.
export const shapeLabelForPosition = (position: 'value' | 'type', shape: Shape): Shape =>
  position === 'type' && shape !== 'heritage' ? 'named-type' : shape
```

`bench/impact-oracle.ts` — the aggregation line (line 265) applies the relabel. Update the import (line 6) to include it:

```ts
import { classifyPosition, classifyShape, nodeAtPosition, shapeLabelForPosition } from './impact-ast.js'
```

and replace `agg.shapes.add(classifyShape(sf, pos, checker))` with:

```ts
      agg.shapes.add(shapeLabelForPosition(position, classifyShape(sf, pos, checker)))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/bench/`
Expected: PASS — new helper tests green; impact-oracle.test.ts (classifyShape table + heritage oracle test assert positions/`classifyShape` directly, both unaffected), impact-score.test.ts (consumes pre-computed sources) and impact-fixture.test.ts all green.

- [ ] **Step 5: Add the fixture type-ref case**

Create `bench/fixtures/impact-demo/src/task-types.ts`:

```ts
export interface Task {
  id: string
}
```

Create `bench/fixtures/impact-demo/src/task-user.ts`:

```ts
import type { Task } from './task-types'

export function process(task: Task): Task {
  return task
}
```

Verify end-to-end WITHOUT writing a baseline:

Run: `bun run bench/impact-run.ts --repo bench/fixtures/impact-demo`
Expected: the report shows the `Task` target covered — the source `src/task-user#process` surfaces via the import-backed `type_refs` edge (`resolved`), and the type tier improves (the `Task` ref was a type FN pre-slice). `git status` must NOT show `bench/impact-baseline.fixture.json` modified.

- [ ] **Step 6: Lint, typecheck, format**

Run: `bun run lint && bun run typecheck && bun run format:check`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add bench/impact-types.ts bench/impact-ast.ts bench/impact-oracle.ts tests/bench/impact-ast.test.ts bench/fixtures/impact-demo/src/task-types.ts bench/fixtures/impact-demo/src/task-user.ts
git commit -m "feat(bench): named-type shape label and type-ref fixture case (Slice 8, B7)"
```

---

### Task 4: Reindex, measure, baselines, full gate, ledger

**Files:**
- Modify: `bench/baseline.json`, `bench/baseline.papai.json`, `bench/impact-baseline.json`, `bench/impact-baseline.papai.json`, `bench/impact-baseline.fixture.json`, `bench/index-baseline.json` (regenerated)
- Modify: `.superpowers/sdd/progress.md` (slice completion entry — controller-owned; the implementer does NOT touch it)

**Interfaces:**
- Consumes: Tasks 1-3.

- [ ] **Step 1: Reindex both working repos and verify type-ref rows in the DBs**

IMPORTANT: `bun run start index ../papai` does NOT work (the CLI ignores positional args — src/cli.ts:101 always indexes its cwd). Run the CLI from the papai directory instead, then index self:

```bash
(cd ../papai && bun ../codeindex/src/cli.ts index)
bun run start index
```

Then verify the type-ref population landed (record the actual numbers):

```bash
sqlite3 ../papai/.codeindex/index.db "SELECT confidence, COUNT(*) FROM symbol_references WHERE edge_type='type_refs' GROUP BY confidence;"
sqlite3 ../papai/.codeindex/index.db "SELECT COUNT(*) FROM symbol_references WHERE edge_type='type_refs' AND target_symbol_id IS NOT NULL;"
sqlite3 .codeindex/index.db "SELECT COUNT(*) FROM symbol_references WHERE edge_type='type_refs' AND target_symbol_id IS NOT NULL;"
```

Expected: papai shows hundreds of `type_refs` rows, majority `resolved` (the 157 import-backed cases) plus `name_only` rows WITH non-null targets (the ~40 kind-filtered same-module binds) and some null-target rows (ambient/unimported types like `Promise` — inert). Record all counts.

- [ ] **Step 2: Regenerate all six baselines at HEAD**

```bash
bun run bench --baseline bench/baseline.json --update-baseline
bun run bench/run.ts --repo ../papai --corpus bench/corpus/papai.json --baseline bench/baseline.papai.json --update-baseline
bun run bench/impact-run.ts --baseline bench/impact-baseline.json --update-baseline
bun run bench/impact-run.ts --repo ../papai --max-targets 300 --baseline bench/impact-baseline.papai.json --update-baseline
bun run bench/impact-run.ts --repo bench/fixtures/impact-demo --baseline bench/impact-baseline.fixture.json --update-baseline
bun run bench/index-bench-run.ts --baseline bench/index-baseline.json --update-baseline
```

Expected: all exit 0; `git status` shows only the six baseline JSONs modified.

- [ ] **Step 3: Verify the gates moved or held**

Inspect the regenerated impact baselines against the committed pre-slice values:
- papai `typeFalseNegativeRate` (was 1.0): must improve materially — expected ~0 (197 FNs close: 157 import-backed + ~40 kind-filtered same-module; residual = qualified types + oracle-dropped module-level refs). If it does NOT improve, STOP and surface.
- papai `valueFalseNegativeRate` (was 0.0685): must be flat-or-better (expected flat — type-only sources do not enter the value tier).
- papai `falsePositiveRate` (was 0): must stay 0. If it regresses, STOP and surface — the kind filter is the FP defense and its behavior is the slice's risk.
- self (codeindex) `typeFalseNegativeRate` (was 0.9923): expected ~0 — the diagnostic that justifies the slice.
- fixture value FN (was 0.1): flat-or-better; fixture type tier improves (new `Task` target covered).
- Diagnostic note (expected, not a defect): `valueFalseNegativesByShape` maps may gain `named-type` keys via `'both'`-position sources after the relabel.
- IR search baselines (Step 2 exit codes): up-or-flat is the gate. The ~200+ new type_refs rows raise type targets' in_degree; ranking displacement is capped (+15, log1p-dampened, within-scope-tier). If a papai search metric REGRESSED, STOP and surface to the user: `IN_DEGREE_WEIGHT = 15` is frozen, so a regression here is a user decision, not a knob to turn.

- [ ] **Step 4: Full gate**

Run: `bun run check`
Expected: EXIT 0 — lint 0/0, typecheck clean, format clean, full test suite green, all four `check:bench` commands green against the fresh baselines.

- [ ] **Step 5: Controller ledger entry + commit**

The controller appends the Slice 8 completion entry to `.superpowers/sdd/progress.md` (code range, per-task commits, measured type-ref counts, typeFN before/after, FP/valueFN/IR gate status) and commits:

```bash
git add -A
git commit -m "chore(slice8): regenerate baselines, verify type-ref gates green"
```

---

## Self-Review Notes

- **Spec coverage:** Unit 1 (extraction) → Task 1; Unit 2 (resolution + kind filter) → Task 2; Unit 3 (bench relabel + measured closure) → Tasks 3-4; Unit 4 (fixture + baselines + ledger) → Tasks 3-4. Out-of-scope items (qualified types, `import type` row distinction, typeof, exotic type forms, `obj.m()`, Phase 3) have no tasks — correct.
- **Type consistency:** `'type_refs'` added to both union sites in the tasks that need them (types.ts in Task 1, resolver's local copy in Task 2 — the resolver test in Task 2 Step 1 writes `edgeType: 'type_refs'` in literals, which typechecks only after Task 2's union edit; tests are written first and observed failing at Step 2, matching the established RED→GREEN ordering). `SymbolSummary.kind?` optional introduced and consumed in Task 2; `shapeLabelForPosition` defined in Task 3 and consumed in the same task.
- **Known coupling:** Task 2 depends on Task 1's union member; Task 3's oracle relabel depends on nothing from Tasks 1-2 (pure diagnostic) but its fixture verification depends on both; Task 4 depends on all. Fixture baseline goes stale from Task 3 onward — expected mid-slice, per Global Constraints.
- **Pre-existing test compatibility (verified against current code):** tests/indexer/index-codebase.test.ts asserts only directional reference counts and its fixtures contain no type annotations — unaffected. tests/bench/impact-oracle.test.ts pins `classifyShape` (unchanged) and oracle positions (unaffected by the relabel). tests/bench/impact-score.test.ts consumes pre-computed oracle sources (unaffected). tests/storage/queries.test.ts has no strict `selectAllSymbols` row assertions. tests/resolver tests construct symbols without `kind` — why `kind` is optional.
