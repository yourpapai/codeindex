# codeindex Phase 2 — Slice 2: Value-FN Breakdown + Certain Graph Wins (Design)

**Date:** 2026-07-23
**Status:** Approved design (Slice 2, **firm**). Opened by the Slice 1 → Slice 2 reassessment gate.
**Scope decision:** **Option 1** — instrument the value-position FN, then bank the two *zero-FP*
graph wins (B1 JSX, B3 `extends`/`implements`). The FP-risky / ranking-dependent items
(B2 member-call, B4/B5 barrels & namespaces, C2 suppression) are **deferred to the Slice 2 → 3
gate**, which reads the numbers this slice produces.
**Source:** Slice 1 outcomes (`.superpowers/sdd/progress.md`, `bench/impact-baseline*.json`), the
Phase 2 gate design (`docs/superpowers/specs/2026-07-22-phase2-accuracy-free-wins-design.md`),
research gaps B1 / B3 / B7 (`docs/research/04-gaps-and-opportunities.md`).

---

## Purpose

Slice 1 built the FN/FP instrument and froze the first trustworthy `code_impact` baselines
(codeindex FN **0.828**, papai FN **0.867**). But those headline numbers are
**type-position-dominated** — ~41/101 codeindex targets are `interface`/`type` declarations whose
references are all type-position (gap **B7**, which the tsc oracle counts but `code_impact` is not
designed to track). So the number Slice 2 exists to move — the **value-position FN** — is still
**unmeasured** (Slice 1 estimated it at 40–55%).

This slice does two things, in this order:

1. **Instrument the value-FN.** Split the oracle's FN into `valueFalseNegativeRate` (**gated**) and
   `typeFalseNegativeRate` (**diagnostic**; sizes B7), so the gate measures what graph completion
   actually targets instead of the type-polluted total.
2. **Bank the two graph wins that are provably safe to ship blind** — JSX usage edges (B1) and
   `extends`/`implements` edges (B3). Both are **additive and zero-FP**: they can only convert
   existing false-negatives into covered edges; they cannot regress FN or FP.

This is the same discipline Slice 1 followed — build the instrument, bank the certain wins, defer
the signal-dependent bets. It also **dogfoods the new gate**: landing B1 on papai makes the fresh
`valueFN` visibly drop in the same slice that defines it.

---

## Why this scope (the reassessment-gate reasoning)

Three facts force Option 1 over "complete the whole graph in one slice":

1. **Chicken-and-egg.** The value/type breakdown is what *produces* the ranking data for the rest of
   the pool. Committing B2 / B4-5 / C2 now would set their priority *before* we can see where the
   value-FN concentrates — the exact "commit before measure" anti-pattern the project rejects.

2. **Only B1 and B3 are safe to commit blind.** They are additive and zero-FP (`<Button/>` *is* a
   real reference to `Button`; `class X extends Y` *is* a real reference to `Y`). Every other pool
   item either moves FP (B2 can resolve `this.foo()` to the wrong `foo`; C2 suppression can raise FN)
   or needs the breakdown's numbers to justify its priority.

3. **The certain wins are near-zero on codeindex and modest on papai** — so their value is real but
   bounded, and the value-FN *location* is genuinely unknown until measured:

   | Signal (grep/index estimate) | codeindex | papai | Note |
   |---|---|---|---|
   | Classes / heritage clauses (B3) | 0 / 0 | ~29 / ~21 | B3 lands only on papai |
   | JSX component tags (B1) | 0 | **~230** (index-derived, Slice 1) | B1 lands only on papai |
   | `this.method()` (B2, deferred) | 0 | ~238 | deferred — needs FP gate |
   | `export * from` (B4) / `import * as` (B5) | 1 / 1 | 0 / 3 | deferred — tiny, resolution-correctness |

   codeindex's 82.8% FN is types **plus** value-ref misses of *unknown shape* (plain-call or
   member-expression misses that only the breakdown will reveal). Measuring first is the point.

---

## Unit 1 — Value/type FN breakdown (`bench/`)

The instrument change. Turns the type-polluted total FN into the metric Slice 2 gates on, plus the
diagnostic that sizes B7.

### What it does

- **Oracle** (`impact-oracle.ts`): for each true reference `getReferencesAtPosition` returns,
  classify its **position** by walking the TS AST up from the reference identifier:
  - **type** — under a type annotation, a type-argument list, a `typeof`/type-query, an
    `implements` heritage clause, or an **interface's** `extends`.
  - **value** — a call, `new`, a JSX tag, a **class's** `extends`, or a plain value identifier.

  Stays on **raw `typescript`** (already a devDependency; what Slice 1's oracle uses — *not*
  ts-morph). Each true source now carries a position label:

  ```ts
  interface OracleSource { readonly name: string; readonly position: 'value' | 'type' | 'both' }
  interface OracleTarget { readonly target: string; readonly trueSources: readonly OracleSource[] }
  ```

  A source that references the target in both positions is labelled `'both'`.

- **Scorer** (`impact-score.ts`): `code_impact` does not distinguish position, so *coverage* is the
  existing position-agnostic check (did `code_impact` report an edge `source → target`?). The split
  lives entirely on the truth/denominator side:
  - **`valueFalseNegativeRate`** (**gated**) — over sources with a value use (`position ∈ {value, both}`).
  - **`typeFalseNegativeRate`** (**diagnostic**) — over **type-only** sources (`position === 'type'`).
  - Total FN and FP-by-confidence-tier stay in the report as diagnostics.

### The invariance property (why `'both'` counts as value)

A `'both'` source sits in the **value** denominator either way, so the **gated `valueFN` is
invariant** to how we treat it. The only thing the choice moves is the diagnostic `typeFN`. We keep
the type diagnostic to **type-only** sources deliberately: that is exactly the reference mass gap B7
(type-position tracking) would *uniquely* recover — a source that also uses the symbol in value
position is already recoverable by value-tracking, so counting it as "type FN" would overstate B7.

### Gate + baselines

- `impact-compare.ts` / `impact-run.ts`: flip the gated field from total FN → **`valueFalseNegativeRate`**,
  keeping the established **no-regression** semantics and `1e-9` tolerance. `typeFN`, total FN, and
  FP-by-tier print as diagnostics.
- `impact-types.ts`: extend `ImpactBenchReport`, `ImpactBaseline`, and `ImpactBaselineSchema` with
  the value/type fields (and their supporting counts). **Both frozen baselines are re-captured**
  after Units 2–3 land, so the improved `valueFN` becomes the new floor.

**Depends on.** The Slice 1 oracle (`declarationOffset`, `enclosingQualifiedName`), raw `typescript`,
the real `findIncomingReferences` path. No `src/` changes.

**Entry.** Slice 1 baselines exist (they do).

**Go/no-go.** The position classifier is the new trust-critical logic (as `declarationOffset` was in
Slice 1). It needs a focused fixture test covering value-call, `new`, JSX tag, class-`extends`,
interface-`implements`, `: T` annotation, `Array<T>` generic arg, `typeof X`, and interface-`extends`.
If classification proves unreliable, **default unknown → value** (fail *toward* the gated denominator,
never hiding value-FN) and record the caveat rather than shipping a number we don't believe.

**Success.** First trustworthy **`valueFN`** on both repos, frozen and gated; `typeFN` reported to
size B7.

---

## Unit 2 — B1: JSX usage edges (`src/indexer/extract-references.ts`)

### What it does

- Handle `jsx_opening_element` and `jsx_self_closing_element`. Emit an edge from the **enclosing
  symbol** (existing `enclosingSymbol` tracking) to the tag's component identifier, reusing the
  **existing call-resolution path** — the tag name resolves through the same `importMap` a plain
  `foo()` call does. No new resolution logic.
- **Edge type: `references`** *(locked)* — activates the modeled-but-never-produced `references`
  edge type; avoids conflating component usage with function-`calls`.
- **Honest scoping.** Only **capitalized identifier** tags produce edges — the React convention where
  a capitalized tag is a component reference and a lowercase tag (`<div>`) is an intrinsic host
  element (not a reference). Member-expression tags (`<Foo.Bar/>`) are the namespace case and are
  **deferred with B5**; note the skip so it is not mistaken for a bug.

### Position + expected effect

JSX usage is **value-position**, so it lands in the `valueFN` denominator. B1 converts papai's ~230
currently-invisible JSX references from FN → covered — the slice's demonstrable value-FN drop. Zero
effect on codeindex (no `.tsx`).

**Depends on.** Nothing new. **Entry.** Parallel with Units 1 and 3.
**Go/no-go.** No FP regression (Unit 1's diagnostic watches it) and no MRR regression (existing IR gate).
**Success.** papai `valueFN` drops with JSX edges resolving to their imported components.

---

## Unit 3 — B3: `extends` / `implements` edges (`src/indexer/extract-references.ts`)

### What it does

- Handle class heritage (`class_heritage` → `extends_clause` / `implements_clause`; exact grammar
  node names verified against `tree-sitter-typescript` in the plan). Emit:
  - an **`extends`** edge from the class symbol to the extended base — **value-position**.
  - an **`implements`** edge from the class symbol to each implemented interface — **type-position**.
- Resolves via the existing import/name path. Activates the remaining modeled-but-never-produced edge
  types (`extends`, `implements`) — one of the pre-flight dead-scaffolding items, resolved by *use*.

### Consistency with Unit 1

The `extends` (value) vs `implements` (type) distinction is exactly the one Unit 1's classifier must
draw, so B3's two edge kinds land in the two different denominators: **`extends` reduces `valueFN`,
`implements` reduces `typeFN`** (honest B7-sizing, not a value claim). papai gains a modest number of
edges (~21 heritage clauses); codeindex has none.

**Depends on.** Nothing new. **Entry.** Parallel with Units 1 and 2.
**Go/no-go.** Zero-FP by construction; no MRR regression.
**Success.** Heritage edges produced and resolved; "who extends/implements this" is answerable.

---

## Slice hygiene — anti-rot gate + pre-flight reconciliation

### Anti-rot gate

Slice 1 surfaced that `bench:*:check` gates run **nowhere automatically** — there is **no CI at all**
(no `.github/workflows`, no husky) and `bun run check` is only `lint / typecheck / format / test`.
That is why the stale `who-uses-ensureSchema` golden query rotted unnoticed. Compounding it, the
**papai gates require the `../papai` sibling**, so they cannot run in hosted CI regardless.

**Decision (locked):** add a **`check:bench` aggregate** of the *self-runnable* gates —
`bench:check` + `bench:impact:check` + `bench:index:check` (all against codeindex itself) — and
**fold it into `bun run check`**, accepting the few seconds it adds to index + build the oracle over
codeindex's ~31 files. The one command everyone already runs then catches gate drift. The **papai
gates stay manual** (documented), since no runner has the sibling repo. A hosted GitHub Actions
workflow is explicitly *not* in scope (blocked for the papai gates; no remote assumed).

### Pre-flight reconciliation (roadmap-mandated)

**Decision (locked):** record a **keep/drop decision for all four** dead "tier1" items as a short memo
in the plan, but **act only on the one Slice 2 touches**:

| Dead-scaffolding item | Decision recorded now | Acted on in Slice 2? |
|---|---|---|
| `edge_type` `extends` / `implements` (modeled, never produced) | **Keep — activate** | **Yes** (Unit 3 produces them) |
| `module_exports.resolved_file_id` (always NULL) | Decide at B4 (barrels) | No — B4 deferred |
| `symbols.is_exported` (written, never read) | Lean drop; confirm at pre-flight of deferred slice | No |
| `symbols.start_byte` / `end_byte` (written, never selected) | Lean drop — Slice 1 confirmed UTF-8 byte offsets ≠ TS UTF-16 positions, so not a drop-in position source | No |
| `module_aliases.precedence` (written, never breaks a tie) | Decide at the resolution slice | No |

Rationale: the roadmap requires reconciliation *before building on* an item. Slice 2 builds only on
the edge-type scaffolding (via B3); the rest intersect deferred work and are reconciled when that work
lands, with the decision recorded so nothing is re-derived or contradicted.

---

## Decisions locked

1. **JSX edge type** → `references` (activates dead scaffolding; not `calls`).
2. **Anti-rot** → `check:bench` aggregate of self-gates, folded into `bun run check`; papai gates
   manual; no hosted CI this slice.
3. **Pre-flight** → memo all four dead items; act only on `extends`/`implements`.
4. **`'both'`-position sources count as value** — gated `valueFN` is invariant to this; the type
   diagnostic is kept to type-only sources (correct B7 sizing).
5. **Gate** → no-regression on `valueFalseNegativeRate`, `1e-9` tolerance; re-freeze both baselines
   after Units 2–3.

---

## Slice 2 exit criteria (definition of done)

- `valueFalseNegativeRate` + `typeFalseNegativeRate` measured on **≥2 repos**, frozen as
  `impact-baseline*.json`, reproducible from one command, and wired as a fast **`valueFN` regression
  gate**.
- **B1** (JSX) and **B3** (`extends`/`implements`) edges produced and resolved; covered by unit tests
  and the protocol/integration suite.
- Measured **`valueFN` drop on papai** from B1 + B3; **no FP regression** (watched per confidence
  tier); **no MRR regression** (`bench:check` / `bench:papai:check`).
- **`check:bench`** exists and is included in `bun run check`; the self-runnable gates can no longer
  silently rot.
- `typescript` remains **bench-only** (existing structural guard); no `src/` type-checker import.

**Deliverable.** The gate now measures the *value*-FN Slice 2 targets, two provably-safe graph wins
are banked (JSX + heritage edges), and the fast gates are protected from silent drift.

---

## Deferred to the Slice 2 → 3 gate

For the first time the project will have a **value-FN** number and a **type-only FN** number. The gate
then re-ranks the remaining pool by *(measured value-FN contribution × cheapness)*:

- **Member-call heuristic (B2)** — `this.x()` + intra-module known-local receivers only; external
  receivers (zod / `db` / `React`) stay out of scope. **Ships only if** the oracle shows the intended
  value-FN drop **and** FP does not cross threshold.
- **Barrels & namespaces (B4/B5)** — `export * from` chains; `import * as ns` (and the deferred
  `<Foo.Bar/>` member-expression JSX from Unit 2). Reconciles `module_exports.resolved_file_id`.
- **C2 suppression** — suppress the codebase-wide same-name fallback; **gated on the FP-by-tier
  number** this slice produces (ship only on a measured FP drop without a matching FN rise).
- **Instrument enrichment** — the breakdown gains **per-shape categorization** (label each *missed*
  value reference JSX vs member-call vs barrel) *here*, when it is needed to rank B2/B4/B5 — not
  before. Remaining pre-flight items are reconciled as their owning work lands.

With the graph more complete, **in-degree ranking** (deferred from Slice 1) becomes viable as a
follow-on.

---

## Non-goals (YAGNI — stated so they don't creep in)

- B2 member-call, B4/B5 barrels/namespaces, C2 suppression **in this slice** (deferred to the gate).
- Per-shape FN categorization **now** (added at the gate, when ranking needs it).
- `<Foo.Bar/>` member-expression JSX and lowercase intrinsic tags (namespace case / non-references).
- A hosted GitHub Actions workflow (blocked for papai gates; no remote assumed).
- Full removal/rewiring of the non-`extends`/`implements` dead-scaffolding columns (decisions recorded,
  action deferred).
- Adopting `ts-morph` / the TS compiler into `src/` (bench-only; the shipped resolver stays
  type-checker-free unless Phase 3 opens that gate).

---

## Next step

On approval: invoke **`writing-plans`** to produce the Slice 2 implementation plan (Units 1–3 +
slice hygiene above). Slice 3 and the deferred pool are planned when the Slice 2 → 3 gate opens,
against this slice's real `valueFN` / `typeFN` / FP-by-tier numbers.
