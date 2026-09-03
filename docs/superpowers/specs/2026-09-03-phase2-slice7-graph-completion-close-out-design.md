# codeindex Phase 2 Slice 7 — Graph Completion Close-Out (Design)

**Date:** 2026-09-03
**Status:** Draft pending user approval.
**Source:** The Slice 6 "Deliberately out of scope (deferred, not forgotten)" list, the Slice 5
call-FN memo (residue #7, #4/#5), the Phase 2 candidate pool in
`docs/superpowers/specs/2026-07-20-codeindex-roadmap-design.md`, and the gap catalog
`docs/research/04-gaps-and-opportunities.md`. Every unit re-verified against current code and both
live databases on 2026-09-03 (see "Current state" per unit — numbers are measured today, not
inherited from the roadmap prose).

---

## Purpose

Phase 2's value-FN gate sits at 0.0788 with FP 0. What remains of the Phase 2 *graph* pool is a
floor of small, verified items: the codebase-wide false-positive fallback that is already emitting
measurably false edges outside the gate's view (C2), the two call-FN residues left open by Slice 5
(#7 import-then-export, #4/#5 nested scope-path), and the last unbridged barrel forms (B5 star
re-export / namespace import). This slice banks all of them so the Phase 2 graph is complete before
Slice 8 (token economics) and before the type-ref follow-up spec (user decision 2026-09-03:
type-ref is its OWN spec, written *after* Slice 7 so it is designed against the settled resolver —
C2 suppression and the #7 chains both change the graph state a type-ref edge would build on).

**Approach decisions (user-approved 2026-09-03):**

- **C2 builds** on a measured-false-edge justification (157 false edges in papai), not an FP-rate
  drop — the roadmap's original go/no-go wording ("must show a measured FP drop") is unsatisfiable
  because the gate's FP is already 0 *because* these edges are invisible to it.
- **B5 builds minimal**: star-forwarding rows + resolver chain follow, and a module-level
  `import * as ns` edge (file_resolved). `ns.member` resolution stays out (obj.m()-adjacent).
- **Dedup ride-along is dropped**: the NOCASE JOIN multiplication shape measured **0 occurrences**
  in both real DBs; recorded as a verified non-issue in "Deliberately out of scope".
- **No SCHEMA_VERSION bump**: every change lands in existing columns/rows. `export_kind` is a free
  TEXT column (src/storage/schema.ts:45) — the new `'star'` value is a type-union change only.

---

## Unit 1 — C2 fallback suppression

**Current state (verified 2026-09-03).** `resolveByLocalName`
(src/resolver/resolve-references.ts:115-134) is the last-resort name match. When an import carries a
module specifier but no file/alias matches it (`matchedModuleKey === null` while
`targetModuleSpecifier !== null` — bare npm specifiers, out-of-root paths, typo'd relatives), the
`: true` branch (line 127) matches **any** same-named symbol codebase-wide. Measured today on the
papai DB: **157 `imports` edges with this signature** (`confidence='name_only' AND
target_file_id IS NULL AND target_symbol_id IS NOT NULL AND target_module_specifier IS NOT NULL`),
resolving to 15 unrelated local targets — `import { eq } from 'drizzle-orm'` →
`src/dashboard-auth/cookie#readSessionCookie>eq` (60 rows), `delay` from `msw` →
`src/chat/kontur-talk/index#delay` (7), `sql` → a migration local (34), plus 12 more targets
including one `type_alias_declaration` and one `method_definition`. Self DB: 0. The impact gate's
FP is 0 **because these edges are invisible to it**: they are module-scope imports with
`source_symbol_id NULL`, so they never surface as caller sources. The damage is real but
unscored: they pollute `code_impact` output (the rows DO match `findIncomingReferences`' target
join, returning garbage "incoming references" with null source), and they inflate `in_degree`
(backfill counts refs regardless of confidence — the Slice 6 ranking signal) for ~15 papai symbols.

**Fix.** Delete the any-module branch: a specified-but-unmatched import resolves to
`targetSymbolId null` with `confidence 'name_only'` (row still inserted, invisible to
`findIncomingReferences` — the exact semantics of the B6 guard at resolve-references.ts:244-245).
The same-module branch for **bare** references (`targetModuleSpecifier === null` → restrict to
`currentModuleKey`) is unchanged — measured FP-free and load-bearing for local calls. Implementation
note: C6 (non-wildcard tsconfig `paths` dropped) is the *legit* channel this fallback was
accidentally impersonating; suppression stops the impersonation without fixing C6 (unchanged, still
a Phase 3/4 item).

**Honest justification (replaces the unsatisfiable FP-drop rule).** Success metric: papai
false-edge count 157 → 0 (same SQL signature, post-fix), affected `in_degree` values return to
truth, `code_impact` output for the 15 targets loses its null-source garbage rows. Gate effect:
these edges were never creditable (module-scope, source-less), so value FN and FP must both stay
flat-or-better — suppression can only remove edges.

**Risk to watch.** `in_degree` shifts for ~15 papai symbols can move IR search baselines (the
ranking signal added in Slice 6). The frozen `IN_DEGREE_WEIGHT = 15` rule is NOT reopened; the
regression gate (precision@k + MRR up-or-flat) adjudicates at the final baseline task, and any
measured shift is recorded in the ledger.

---

## Unit 2 — Residue #7: import-then-`export { x }` linking

**Current state (verified 2026-09-03).** For `import { x } from './a'; export { x }` (no
from-clause), `pushExportSpecifier` (src/indexer/collect-export-candidates.ts:31-54) records
`targetModuleSpecifier: null`, and `persistModuleExports` (src/storage/queries.ts:209-220) finds no
stored symbol whose `localName` is `x` (it is imported, not declared) — so the row lands
`symbol_id NULL, target_module_specifier NULL`, and the B4 reexport chain dead-ends by design
(resolve-references.ts:91). Measured: **82 such rows in papai** (`export_kind='named' AND
symbol_id IS NULL AND target_module_specifier IS NULL`), dominated by *type* re-export barrels —
`client/debug/dashboard-types.ts` alone forwards 41 domain types via
`import type {…} …; export {…}`. Self DB: 2 rows. Gated call-FN payout: the memo's residue #7
(`llm-orchestrator-logging#logProcessMessage` ← `llm-orchestrator#processMessage`); the type-barrel
population is also exactly what the upcoming type-ref spec needs traversable.

**Fix (indexer-only; the resolver chain already handles the rest).** After the reference walk in
`extractReferenceCandidates` (src/indexer/extract-references.ts), a post-pass builds a
`localName → module specifier` map from the collected `imports` references (order-independent, so
an `export` appearing before its `import` in source still links) and sets
`targetModuleSpecifier` on every no-from `export { … }` row whose `localName` (the `name` field,
alias-aware: `export { x as y }` links on `x`) matches an imported name. `symbol_id` stays NULL —
the chain follows the specifier exactly as it does for direct `export { x } from './y'` rows.
No `reexports` reference edge is emitted for the linked form (resolution needs only the
`module_exports` row; keep minimal). Alias conflict note: if the same `localName` is imported twice
from different modules (type+value merge — rare), first-import-wins; recorded, not special-cased.

---

## Unit 3 — Residue #4/#5: nested scope-path agreement

**Current state (verified 2026-09-03).** For a non-arrow/non-function `variable_declarator`
containing a nested named boundary — `const stream = new ReadableStream({ start(){…},
cancel(){…} })` — the two extractors disagree on the path: extract-symbols includes the declarator
name (`variable_declarator` is in `declarationTypes`, src/indexer/extract-symbols.ts:48) and emits
`handleEvents>stream>start`, while extract-references treats the declarator as transparent
(`isNamedScopeBoundary`, src/indexer/extract-references.ts:47-54) and mints `handleEvents>start` —
a qualified name no symbol backs → `sourceSymbolId null` → the caller is dropped (papai's two
remaining "real miss" call FNs, Slice 5 memo #4/#5: `debug/state-collector#removeClient` ←
`handleEvents>stream>start` and `…>cancel`). Self/fixture: 0.

**Fix (extract-references only; extract-symbols and the oracle are untouched).** Thread *pending
path segments* through the walk: when descending into a named `variable_declarator` that is NOT a
scope boundary, push its name-field text onto a pending list instead of the path. The pending
segments are consumed only when a boundary is minted beneath (`nextEnclosingSymbol` appends them
before the boundary name) and clear inside that boundary. Consequences by case:

- `const body = readBody(res)` — no boundary beneath → pending never consumed → the reference stays
  attributed to the enclosing symbol. The Slice 4a indexer/oracle agreement is preserved (pinning
  test).
- `const stream = new ReadableStream({ start(){…}, cancel(){…} })` — both methods mint with the
  `stream` segment: `handleEvents>stream>start`, `handleEvents>stream>cancel` — byte-identical to
  extract-symbols. Both FNs close; no FP (the oracle already attributes truth to those exact names).
- Nested accumulation composes (`const a = wrap({ m(){ const t = new Q({ n(){…} }) } })` →
  `…>a>m>t>n`), matching extract-symbols' path construction by construction. Destructuring-pattern
  declarators follow the same rule via the name-field text, mirroring `nameForNode` output.

Implementation note: extract-references.ts is at 270 lines against a 300-line lint budget — the
pending-segment threading must go in a small extracted helper (the established Slice 4 Task 1
deviation pattern), not inline growth.

---

## Unit 4 — B5 minimal: star barrels + namespace imports

**Current state (verified 2026-09-03).** (a) `export * from './y'` records nothing:
`collectExportCandidates` (src/indexer/collect-export-candidates.ts:133-172) has no
`namespace_export` / bare-`*` handling, and the resolver comment
(src/resolver/resolve-references.ts:74-76) documents star chains dead-ending by design. (b)
`import * as ns` emits no edge: `namespace_import` sits in `NON_VALUE_REFERENCE_PARENTS`
(src/indexer/extract-references.ts:138) with no collector. Measured mass: papai **0** `export *`
and 3 `import * as` (2 external npm/node, 1 relative `./schema` in `src/db/drizzle.ts`); self 2
star barrels (e.g. `src/extract-symbols.ts:1`) and 1 external ns import. Namespace-qualified
heritage / member-JSX forms (deferred "with B5" in code comments): **0 occurrences** in papai. B5
therefore ships as a completeness/precision item for star-using repos — including codeindex itself
— not a gate-moving win; recorded as such.

**Fix.**

- **Star forwarding rows.** `export * from './y'` records a `module_exports` row
  `{ exportName: '*', exportKind: 'star', localName: null, targetModuleSpecifier: './y' }`
  (`'star'` added to the `ExportKind` union; the column is free TEXT — no schema bump). The B4
  resolver (`buildReexportResolver`, resolve-references.ts:77-95) gains a star fallback: on a
  per-name miss for a module, consult that module's star rows (several possible — first hit wins)
  and continue the chain from each star source under the same depth cap. The stale dead-end comment
  is updated.
- **Namespace import edge.** `import * as ns from './m'` emits an `imports` reference with
  `targetName = ns`, `targetExportName = '*'` (namespace marker). Resolution resolves the module
  file (`file_resolved`, `target_file_id` set) and **never falls through to name matching** — an
  explicit pre-fallback branch returns null `targetSymbolId` for the `'*'` marker, so a target
  module that happens to declare `const ns` cannot produce a false bind (same FP discipline as
  Units 1/B6). External specifiers (`import * as ts from 'typescript'`) resolve to null rows —
  consistent with named npm imports after Unit 1.

---

## Migration

None. No new columns, no collation changes, no backfill semantics change. `export_kind` gains a
value; existing rows change content (Unit 1 nulls 157 papai targets; Unit 2 adds specifiers to 82
papai rows) — index-content changes only, picked up by normal reindex. All three bench baselines
(codeindex, papai, fixture) are regenerated at HEAD in the final task, per the established
workflow.

---

## Global constraints

- IR gate up-or-flat (precision@k + MRR); impact value-FN flat-or-better (expected improvement: up
  to 3 papai call FNs close across Units 2–3, taking call residue 3 → 0); FP stays 0 (gate and
  measured-false-edge count).
- Baselines regenerated ONLY in the final task of the plan.
- No resolver/graph changes outside Units 1–4 as specified above.
- Every fix lands RED→GREEN; `bun run lint && bun run typecheck && bun run format:check` clean per
  task; full `bun run check` at the final task.
- Conventional commits matching repo history (`fix(resolver): …`, `feat(indexer): …`).

---

## Testing & verification

| Unit | Test |
|---|---|
| 1 C2 | `import { eq } from 'unresolvable-pkg'` inserts a null-target row (no any-module bind); bare same-module reference still resolves; B6 guard interaction pinned |
| 2 #7 | import-then-`export { x }` row gains the import's specifier; caller importing through the barrel resolves to the real symbol (`resolved`); `export { x as y }` alias form links on `x` |
| 3 #4/#5 | `new ReadableStream({ start(){}, cancel(){} })` callers attribute to `…>stream>start`/`…>cancel`; `const body = f()` transparency pin (4a agreement) still holds |
| 4 B5 | `export * from './y'` star row recorded; caller importing a star-forwarded name resolves through the chain; multi-star first-hit + depth cap; `import * as ns` → file_resolved with null symbol; ns import never binds a same-named local in the target module |

Fixture (`bench/fixtures/impact-demo`): extend with one star barrel + caller, one
import-then-export barrel + caller, one nested `new ReadableStream` caller, one namespace import.
Committed-fixture baselines update only in the final task.

**Definition of done.** `bun run check` green (lint 0/0, typecheck, format, full test suite); all
bench gates pass with regenerated baselines; IR precision@k/MRR up-or-flat; papai value-FN
flat-or-better (expected: call residue 3 → 0) with FP 0; measured C2 false-edge count 0 on both
corpora; slice marked complete in `.superpowers/sdd/progress.md`.

---

## Deliberately out of scope (deferred, not forgotten)

- **Type-ref edge (~197 named-type-ref gaps)** — its OWN follow-up spec, written after Slice 7 per
  user decision; the Unit 0 memo's recommendation stands (cosmetic `bare-value`→`named-type` bench
  relabel rides with it).
- **`ns.member` usage resolution** — obj.m()-adjacent property-access resolution; Phase 3, gated
  with 2b.
- **`export * as ns from './y'`** (namespace re-export form) — 0 measured occurrences; B5 covers
  the bare star and plain namespace-import forms only.
- **`obj.m()` member calls** — Phase 3, gated with 2b (unchanged committed position).
- **Intra-pool dedup (D8 / NOCASE JOIN multiplication)** — **verified non-issue 2026-09-03**: the
  multiplication shape (same symbol × case-variant export names) has 0 occurrences in both real
  DBs, and remaining "duplicates" are legitimately distinct symbols (overloads, different files).
  Dropped from the roadmap pool.
- **C6 non-wildcard tsconfig `paths`** — the legit channel C2 was impersonating; remains a
  Phase 3/4 reach item, unchanged.
