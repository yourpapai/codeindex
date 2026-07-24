# codeindex Phase 2 Slice 5 — Call-FN Sizing & Oracle Precision (Sizing memo)

Base: Slice 4 complete (`8e21ea0..77b7f5f`). Opened by the Slice 4 follow-ups (the two carried
into Slice 5) and the Phase 2 candidate pool's measurement-first next step: **size the ~9 call-FN
residue on papai to confirm how much is B4 barrel re-exports before designing the edge.**

This is a **bench-only measurement** (no shipped-code change). It does what was scoped — and, like
Slice 4's own opener, running it surfaced a larger finding that reshapes the slice.

## Follow-up #1 (oracle re-measurement): CLOSED

The named-function-expression-callback fix (`7c55ceb`) and the tier1 schema drop (`77b7f5f`, which
also resolves follow-up #2) both landed *after* the papai baseline was captured (`33b6d16`). Re-ran
all three impact benches against current HEAD:

| Repo | valueFalseNegativeRate (committed → HEAD) | Δ |
|---|---|---|
| codeindex (self) | 0.1000 → 0.1000 | 0 |
| fixture | 0.3333 → 0.3333 | 0 |
| papai (strided 300) | 0.4545 → 0.4545 | 0 |

The baselines are an honest floor against current HEAD — B4's numbers are **not** measured against
an approximate mirror for the named-fn-expr reason. (They *were*, however, distorted by two *other*
oracle approximations 4a never addressed — see "Oracle precision" below. That is the reshaping
finding, and it is the modern form of the same follow-up-#1 lesson: trust the gate only after the
mirror is honest.)

## The scoped result: the 9 call-FNs, categorised

papai's `valueFalseNegativesByShape` (strided 300): `bare-value 160/160 · call 9/220 · member 11/22
· other 4/4 · property-unknown 1/1` (185/407 = 0.4545). The `call` residue is exactly **9 of 220**
(96% of calls already resolve). Each of the 9 was traced to its raw `symbol_references` rows and the
actual papai source:

| # | target | true caller (oracle) | category |
|---|---|---|---|
| 1 | `attachments/resolver#selectAttachmentsForTurn` | `#buildUserTurnMessages` | **B4 barrel** |
| 3 | `commands/dashboard#registerDashboardCommand` | `bot#registerCommands` | **B4 barrel** |
| 6 | `error-analysis#getAgentGuidance` | `tool-failure#buildToolFailureResult` | **B4 barrel** |
| 7 | `llm-orchestrator-logging#logProcessMessage` | `llm-orchestrator#processMessage` | **B4 barrel** (import-then-export form) |
| 8 | `long-term-memory/provisional-store#promoteProvisionalToActive` | `promotion#evaluatePromotion` | **B4 barrel** |
| 9 | `tools/list-deferred-prompts#makeListDeferredPromptsTool` | `deferred-tools-builder#addDeferredPromptTools` | **B4 barrel** |
| 2 | `chat/mattermost/api-fetch#makeMattermostApiFetch` | `MattermostChatProvider` | **oracle artifact** (code_impact is correct) |
| 4 | `debug/state-collector#removeClient` | `handleEvents>stream>start` | **real miss** — nested scope-path |
| 5 | `debug/state-collector#removeClient` | `handleEvents>stream>cancel` | **real miss** — nested scope-path |

**B4 barrel re-exports = 6 of 9 — the plurality, as hypothesised.** Verified against source: in every
case the caller imports the name from a barrel index (`from './commands/index.js'`,
`'./errors.js'`, `'./attachments/index.js'`, …) that re-exports it from the real file, e.g.
`export { registerDashboardCommand } from './dashboard.js'`. code_impact resolves the caller's import
to the barrel *file* (`file_resolved`, `target_symbol_id = null`) and never follows the barrel's
re-export to the real symbol, so the call stays `name_only` and no edge links caller → target.

Precision/effort intel for the eventual B4 edge:
- **5 of 6** (`#1,#3,#6,#8,#9`) are the `export { name } from './file'` form. The indexer **already
  emits a resolved `reexports` edge** to the real target symbol (`edge=reexports conf=resolved
  tgtId=<real>`). The fix is purely resolver-side: bridge `caller → barrel-file import → reexports
  edge → real target`. High precision (follows an explicit export edge, no guessing).
- **1 of 6** (`#7`) is the import-then-`export { name }` form (`import {x} from './a'; export {x}`).
  No `reexports` edge exists today — this form additionally needs indexer extraction.

## Oracle precision — two artifacts still inflating the gate (the reshaping finding)

Tracing the 9 call-FNs and sampling the 160 `bare-value` FNs exposed **two oracle-mirror
imprecisions that survive 4a** and together dominate the reported deficit:

1. **Interface-member find-references over-count (large).** 3 of the sampled member-tier targets are
   database-migration `up` methods. Each accrues ~34 "callers" that are *other* migrations' `up`
   methods — `migration009>up` "uses" `migration008>up`, etc. Migrations never call each other; this
   is `tsc` `getReferencesAtPosition` unifying all implementations of the shared `Migration.up`
   interface member. **102 of the 160 `bare-value` FNs (64%) are this one artifact** across just 3
   targets. code_impact is *correct* not to report them (reporting them would be a false positive).
2. **Constructor boundary skip (small).** `#2` above: the call sits in a `constructor` body;
   `nearestNamedBoundary` handles `MethodDeclaration` but not `ConstructorDeclaration`, so the oracle
   attributes the caller to the *class* while code_impact correctly reports
   `MattermostChatProvider>constructor`. 1 spurious call-FN.

Stripping both (102 from numerator+denominator, 1 from numerator) gives the honest picture:

| metric | reported | honest (artifacts stripped) |
|---|---|---|
| valueFalseNegativeRate | **0.4545** (185/407) | **0.2689** (82/305) |

The migration artifact alone is ~**18 points** of the reported value gate — larger than any single
graph feature in the candidate pool. Per follow-up #1's lesson, **the gate is not trustworthy until
these are removed**.

Fix for #1 (verified empirically, `isDefinition` ruled out — all 293 refs of migration008's `up` are
`isDefinition=false`): `tsc` unifies every `up` into one symbol via `interface Migration { up() }`, so
`getReferencesAtPosition` returns the interface signature **plus every sibling implementation's `up`
declaration site** (`002_…:384` is the `up` in `up(db): void {` — a *declaration name*), plus the one
genuine polymorphic call `migration.up(db)` in the runner. The spurious 102 are **declaration-name
positions, not uses**. The fix is to skip reference entries whose position is a declaration name — the
exact `isDeclarationName` predicate the oracle's *test* harness already carries
(`impact-oracle.test.ts`), lifted into `buildReferenceOracle`'s entry loop. A declaration is never a
use, so this is a general correctness fix, not a papai-specific patch.

The 2 "real miss" call cases (`#4/#5`) are a third, genuinely-broken path but *not* B4: the call
resolves to the target fine, but the caller sits in an object-literal method inside
`new ReadableStream({ start(){…}, cancel(){…} })`. `extract-references.nextEnclosingSymbol` mints
`handleEvents>start` (it only appends *boundary* names, skipping the non-boundary `stream`
declarator) while `extract-symbols` emits `handleEvents>stream>start` — a qualified-name **path**
disagreement → phantom source → `source=null` → the caller is dropped. Same family as follow-up #1
(extractor scope-path agreement), on the indexer side.

## Honest deficit ranking (real code_impact misses, artifacts removed)

| rank | bucket | honest FN | nature | cheapness / risk |
|---|---|---|---|---|
| 1 | **bare-value (B6)** | ~58 | zero-edge category: a symbol referenced as a *value* (Zod schema, Drizzle table, config object, fn-as-callback) — indexer emits edges only for call/JSX/heritage/import | cheap, type-free; **higher FP risk** (needs a precise "resolves to a known symbol" guard) |
| 2 | member | 11 | half are `obj.m()` (Phase-3 gated, `2b`) + `this.m` residue | mixed |
| 3 | **call → B4 barrel** | 6 | caller imports via a re-export barrel | **cheap, high-precision**; 5/6 need resolver-only (data present) |
| 3 | call → nested scope-path | 2 | object-literal-method source attribution (indexer path bug) | small, isolated |
| — | other / property-unknown | 4 / 1 | element-access / unresolved-receiver long tail | ambiguous, low value |

## Recommendation / decision needed

The scoped question is answered: **B4 = 6 refs, the plurality of the call residue, cheap and
high-precision.** But measurement-first did its job and flipped two assumptions:

- The reported value gate (`0.4545`) is **~18 points inflated** by an oracle artifact; the honest
  floor is **~0.27**. This should be corrected *first* (mandatory instrument hygiene, per follow-up
  #1) — it is bigger than any feature and makes every subsequent A/B honest.
- B4's gate movement is small (**−0.02** on the honest value rate). The genuine value-FN *mass* is
  `bare-value` (**B6, ~58**, −0.19), not barrels.

Recommended Slice 5 shape, in order:
1. **Oracle precision fix (instrument):** skip declaration-name reference entries (kills the 102-ref
   migration artifact) + `ConstructorDeclaration` in `nearestNamedBoundary` (kills 1). Re-baseline to
   the honest floor. Mandatory before ranking/gating any new edge.
2. **Then one graph edge.** Two candidates, a real scope choice for the user:
   - **B4 barrel bridging** — small (6), safe, high-precision, mostly resolver-only. A clean banked
     win that closes the call bucket to ~2 (the nested-scope pair).
   - **B6 bare-value edges** — the actual deficit mass (~58), cheap and type-free, but the highest
     FP-risk edge in the pool; needs a precise resolves-to-known-symbol guard and its own FP gate.

The nested-scope path bug (`#4/#5`) is a cheap indexer follow-up (extractor path agreement) that can
ride along with the oracle-precision work or be recorded for Slice 6.
