# Phase 2 follow-up — Type-Ref Edge (B7 closure) Design

**Date:** 2026-09-04
**Status:** Approved design (brainstorm 2026-09-04). Next step: implementation plan per the
standing cadence.
**Precondition:** Slice 7 landed (`9d13b8b`) — this edge is designed against the settled resolver
(C2 suppression, #7 import-then-export chains, B5 star rows, pending-segment scope paths), as the
Slice 7 spec required.
**Sizes against:** Slice 6 Unit 0 memo (`2026-09-03-phase2-slice6-honest-gates-and-lexical-wins-design.md`,
"Findings" section): papai `typeFalseNegativeRate 0.9923` post-Slice-7, 197/198 named-type-ref
false negatives (40 same-file, 157 cross-file), zero edges emitted at type positions today.

---

## Goal

Close the B7 gap: type-position identifier references (`: Task` annotations, `Promise<T>`
generics, type-alias RHS, as-casts, call type-args) currently emit **no** `symbol_references`
rows, so ~197 genuine dependency-bearing type usages are uncoverable at the function granularity
both `code_impact` and the oracle share. A new `type_refs` edge makes them first-class graph rows,
resolved through the same machinery as existing edges, with a kind filter keeping same-module
binds precise.

**User-approved dials (brainstorm 2026-09-04):**

1. **Coverage:** full closure (~197 refs) — import-backed cross-file refs AND same-module refs.
2. **Precision dial:** same-module `name_only` binds are allowed ONLY to type-shaped symbols
   (kind ∈ `interface_declaration` | `type_alias_declaration` | `enum_declaration` |
   `class_declaration`) — a type annotation must not bind to a function or variable that happens
   to share the name.
3. **Extraction breadth:** ALL bare `type_identifier` nodes in the walk (one dispatch rule),
   excluding heritage-clause children (B3 already emits those as `extends`/`implements`).
4. **Edge identity:** new `ReferenceEdgeType` value `'type_refs'` — auditable in the DB (type
   coverage measurable separately, matching how B7 was sized), with a dedicated resolver arm.

## No schema bump

`symbol_references.edge_type` is free TEXT with no CHECK constraint (src/storage/schema.ts:49-61).
Adding a new value is a type-union change only — same bar as B1/B3/B6 (`'references'`,
`'extends'`, `'implements'` all landed without version movement). Two type sites change:
`src/types.ts:7` (`ReferenceEdgeType`) and the resolver's local `ReferenceCandidate` union copy
(src/resolver/resolve-references.ts:32).

---

## Unit 1 — Extraction: bare type_identifiers emit type_refs candidates

**Mechanics established by exploration:** the reference walk already ENTERS type-annotation
subtrees (the fall-through recurses into every non-boundary node) but `type_identifier` matches no
dispatch branch, so it is inert. Extraction is one new collector + one dispatch line, copying the
heritage pattern (`collectHeritageReferences`, src/indexer/extract-references.ts:168-211).

- `collectTypeReference(node, enclosingSymbol, references)` fires on `node.type ===
  'type_identifier'`; emits
  `{ sourceQualifiedName: enclosingSymbol, edgeType: 'type_refs', targetName: node.text,
    targetExportName: null, targetModuleSpecifier: null, lineNumber: node.startPosition.row + 1 }`.
- **Heritage exclusion:** skip when the parent is `extends_clause` or `implements_clause`
  (double-row guard — B3's collectors already emit those children). The exclusion is parent-level
  only: type arguments nested inside a heritage clause (e.g. `implements Foo<Bar>`) have a
  non-clause parent, emit as `type_refs`, and are NOT double-counted (B3 emits only bare direct
  children — generic `implements Foo` itself stays B3-deferred). Interface `extends_type_clause`
  children are NOT excluded: they are genuine named type refs, previously deferred by the comment
  at extract-references.ts:173-176, and this rule covers them.
- **What naturally stays out (no code needed, pinned by tests):**
  - Builtins — `string`/`number`/`boolean`/`void` are `predefined_type`/`builtin_type` nodes, not
    `type_identifier`.
  - Qualified `ns.Task` — bare-only rule mirrors `implements_clause`'s bare-children iteration;
    qualified types stay out of scope (no measured mass).
  - `typeof X` operands — grammar hands them over as value-position `identifier` nodes (the one
    accidentally-covered Slice 6 memo case keeps its existing bare-value path; no double emit).
  - Value references — the value branch dispatches on `identifier`, a disjoint node type; no
    `NON_VALUE_REFERENCE_PARENTS` change required.
- **Attribution rides Slice 7's scope paths:** a type ref inside a method of a non-boundary
  declarator attributes through the declarator segment (`…>declarator>method`), byte-identical to
  extract-symbols — same `enclosingSymbol` every other reference form uses.

## Unit 2 — Resolution: type_refs arm with the kind filter

Resolver branch order for a `'type_refs'` reference (src/resolver/resolve-references.ts,
`findResolvedSymbol`), reusing existing paths wherever they already apply:

1. **importMap** (unchanged): a name imported by the same file resolves with confidence
   `'resolved'` — covers the 157 cross-file cases at high precision, including `import type`
   forms (today's import extraction already emits plain `'imports'` rows for `import type { X }`
   and `import { type X }`; no type-only awareness is added or needed).
2. **`'*'` namespace branch** (unchanged): namespace markers never name-match.
3. **Matched-file export path + B4/B5 reexport chain** (unchanged, naturally inert here):
   `type_refs` candidates carry no specifier (Unit 1), so `matchedFileId` is always null for them;
   the branch exists in shared code and skips. Import resolution happens at the `imports`-row
   level (B4/B5 chains resolve import rows; importMap then holds the final symbolId), so barrels
   and star re-exports already work for imported types with no new code.
4. **NEW — same-module arm with the kind filter:** a reference with NO module specifier scopes to
   `currentModuleKey` (C2 semantics: only specifier-less references get same-module scope; a
   reference carrying an unmatched specifier binds nothing, see step 5). The local-name match is
   additionally gated on `symbol.kind` ∈ type-shaped kinds — `interface_declaration`,
   `type_alias_declaration`, `enum_declaration`, `class_declaration`,
   `abstract_class_declaration` (the declarationTypes set minus function/method/variable kinds,
   extract-symbols.ts:38-49). A match binds with confidence `'name_only'` and a non-null
   `targetSymbolId` (same convention as extends/implements same-module binds); a non-type-shaped
   same-name symbol refuses to bind → target `null`. The filter is edgeType-specific: extends/
   implements keep today's unfiltered same-module behavior; no existing edge changes.
5. **C2 composes:** a type ref carrying a specifier that matches no file/alias binds nothing
   (C2 suppression) — a phantom `import type { X } from 'phantom-pkg'` cannot name-match.
6. **B6 guard untouched:** the `references`+`name_only` nulling guard remains edgeType-specific
   ('references' only). `'type_refs'` is not subject to it — by design, since same-module binds
   under the kind filter are the point of dial 2.

## Unit 3 — Bench honesty: named-type label + measured closure

- **Diagnostic relabel (memo's caveat, ride-along):** type-tier fall-throughs currently report as
  `bare-value` in `valueFalseNegativesByShape`/`typeTrueReferenceCountByShape`; when the tier is
  worked, the label becomes `named-type`. Bench-only, diagnostic-only, no gate impact — the oracle
  matches by source+target and never by edge_type (bench/impact-score.ts:15-27, 101-116).
- **Expected movement:** papai `typeFalseNegativeRate` 0.9923 → ~0 (197 FNs close: 157
  import-backed + 40 kind-filtered same-module); fixture gains the type-ref case below.
- **Gates (unchanged hierarchy):** `valueFalseNegativeRate` flat-or-better; `falsePositiveRate`
  stays 0 (the kind filter is the FP defense for same-module binds; import-backed binds ride the
  mechanisms that held FP at 0 through B3/B4/B5/B6); IR search precision@k + MRR up-or-flat.
- **in_degree shift is expected and bounded:** `backfillSymbolInDegree` counts every
  `symbol_references` row regardless of edge_type (src/storage/queries.ts:107-115), so ~200 new
  rows land on type-target symbols. `IN_DEGREE_WEIGHT = 15` stays frozen; ranking displacement is
  capped (+15, log1p-dampened, within-scope-tier only). Baselines regenerate in the final task;
  if a papai search metric regresses, STOP and surface — same protocol as Slice 7 Task 5.

## Unit 4 — Fixture + baselines + ledger

- **Fixture (types.ts-cluster pattern):** `bench/fixtures/impact-demo/src/shape-types.ts`
  (`export interface Shape { … }`) + a consumer with an import-backed type annotation (`p: Shape`)
  so the resolved type-ref edge is observable end-to-end via `bun run bench/impact-run.ts --repo
  bench/fixtures/impact-demo` — no baseline write until the final task (established mid-slice
  rule).
- **Final task:** reindex self + papai, verify measured counts in the DBs (type-ref row counts,
  typeFN before/after), regenerate all six baselines at HEAD, run `bun run check`, record the
  slice in `.superpowers/sdd/progress.md`.

## Global constraints

- **No SCHEMA_VERSION bump** — free-TEXT edge_type value; type-union change only (two sites).
- Every fix lands RED→GREEN: the failing test is written and observed failing before the
  implementation.
- After each task: `bun run lint && bun run typecheck && bun run format:check` clean, targeted
  tests green. Full `bun run check` only in the final task.
- Intermediate tasks must not write baseline files.
- Conventional commits matching repo history (`feat(indexer): …`, `feat(resolver): …`,
  `chore(slice7b): …` — slice label decided at plan time).
- `extract-references.ts` is near its 300-line lint budget (276/300 after Slice 7): if the
  addition exceeds a function budget, extract a helper (established Slice 4/7 deviation pattern)
  and note it in the ledger.

## Testing shape (per unit, TDD)

- **Extraction:** annotation/generic/type-alias-RHS/as-cast/call-type-arg each emit one `type_refs`
  candidate with the enclosing symbol as source; heritage children do NOT double-emit;
  `extends_type_clause` (interface extends) DOES; builtin/qualified/typeof forms absent;
  nested-declarator attribution matches extract-symbols paths.
- **Resolver:** importMap hit → `resolved`; matched-file path → `resolved`; same-module
  `interface Task` binds (`name_only`, non-null target); same-module function named `Task` refuses
  (kind filter — target null); C2 unmatched-specifier type ref binds nothing; B6 `references`
  regression pin (existing behavior unchanged); `'*'` namespace never name-matches.
- **Bench:** `named-type` label appears in the diagnostic shape map; papai/fixture typeFN movement
  recorded at the final task.

## Explicitly out of scope

- Qualified type refs (`ns.Task`) — no measured mass; bare-only mirrors implements_clause.
- Type-only import distinction in stored rows (`import type` records as a plain `imports` row) —
  the importMap mechanism does not need the distinction.
- `typeof` operand handling — already covered by the bare-value path; no change.
- Type-tier edge work beyond named refs (conditional types, indexed access, mapped types) — the
  generic bare-`type_identifier` rule covers whatever appears in practice; exotic forms carry no
  measured mass.
- `obj.m()` member-call resolution — stays Phase 3, gated with 2b (Slice 6 deferral table).
- Phase 3 (freshness, token economics, server) — gated on Slice 8 (deferral pool), which stays
  next after this slice per the roadmap precondition.
