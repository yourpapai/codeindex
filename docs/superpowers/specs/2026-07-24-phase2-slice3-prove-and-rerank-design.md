# codeindex Phase 2 Slice 3 — Prove & Re-rank (Design)

**Date:** 2026-07-24
**Status:** Approved design.
**Source:** Grounded in the Slice 1 & Slice 2 outcomes (`bench/impact-baseline*.json`,
`docs/superpowers/specs/2026-07-22-phase2-accuracy-free-wins-design.md`,
`docs/superpowers/specs/2026-07-23-phase2-slice2-value-fn-and-graph-wins-design.md`) and the
research corpus (`docs/research/01`–`05`).

---

## Purpose

Slice 2 **banked** the value-FN instrument (a gated `valueFalseNegativeRate`, a diagnostic
`typeFalseNegativeRate` sizing B7) and the two certain graph wins — JSX usage edges (B1) and class
`extends`/`implements` heritage edges (B3). Both wins are provably correct (an end-to-end test proves
they flow through `code_impact`), but **neither bench corpus showed a value-FN drop attributable to
them**: codeindex has no JSX or classes at all, and papai's alphabetical 300-target sample does not
capture its JSX (its client is Svelte-heavy, and Svelte does not use `.tsx`). So the honest state
entering Slice 3 is: a durable instrument and correct edges, but **no demonstrated metric movement**.

Slice 3 closes that gap and makes the *rest* of the graph work evidence-driven. It does two things:

1. **Prove** — a committed fixture corpus that contains every reference shape, so the B1/B3 wins
   *demonstrably* zero their value-FN buckets while the un-built shapes stay lit.
2. **Re-rank** — a value-FN **by reference shape** breakdown that ranks the remaining graph
   candidates (B2 member calls vs B4/B5 namespaces vs bare-value refs) by *measured* contribution.

**No graph win is shipped this slice.** The operating principle is unchanged from the Phase 2 design:
*measure before you commit.* The Slice 3 output is the ranked evidence that opens Slice 4; the next
win is picked from that evidence, not drawn in advance.

### Naming / roadmap reconciliation

The Phase 2 design doc (`2026-07-22`) named a provisional "Slice 3 — Navigation primitives." This
slice **reorders that**: an evidence slice runs first (it is cheap, it de-risks every subsequent graph
decision, and it retires the one honest gap Slice 2 left open). Navigation primitives move behind it,
unchanged in content, re-opened at their own gate. This reconciliation is recorded here so the roadmap
stays coherent; nothing about the navigation-primitives scope changes.

---

## Global constraints

- **`typescript` stays bench-only.** `src/` uses only web-tree-sitter; never import `typescript` or
  construct a TS checker in `src/`. The guard `tests/bench/impact-guard.test.ts` must stay green.
- **No `src/` change.** This slice is entirely `bench/`, `tests/bench/`, `package.json`, and a new
  committed `bench/fixtures/` directory. The shipped indexer/resolver/schema are untouched.
- **Gate semantics unchanged.** The gated field stays the scalar `valueFalseNegativeRate`
  (no-regression, tolerance `1e-9`). The new by-shape breakdown and `typeFalseNegativeRate` are
  **printed diagnostics**, not gated.
- **Fixture is deterministic and committed.** Because it has no sibling-checkout dependency (unlike
  papai), its gate `bench:impact:fixture:check` is folded into `check:bench` and therefore rides
  `bun run check` — the Slice 1 anti-rot lesson (self-runnable gates must be in the one command
  everyone runs).
- **Classifier fail-safes never bias a candidate.** An unresolved receiver lands in a neutral
  `property-unknown` bucket, never silently in `member` (B2) or `namespace` (B5). This mirrors the
  Slice 2 rule that an uncertain *position* fails toward `value`.
- **oxlint (denyWarnings) / oxfmt.** No unsafe type assertions; validate JSON via zod `.parse`, never
  `as`. Match the surrounding imperative style in `bench/`.

---

## Unit 1 — Reference *shape* classifier (`bench/impact-oracle.ts`)

The instrument extension. Slice 2's oracle labels each true reference **value** vs **type**
(`classifyPosition`). Slice 3 adds, for **value-position references only**, a **shape** label — the
syntactic form that explains *why* `code_impact` does or does not resolve it.

### What it does

- **`Shape`** = one of:
  - `'call'` — a bare identifier in call position, `foo()`. `code_impact` resolves this today (a
    `calls` edge) — typically **not** a false negative.
  - `'member'` — a property-access call/reference whose receiver is a **local value / parameter /
    `this`**, e.g. `local.foo()`. The honestly-scoped **B2** territory.
  - `'namespace'` — a property-access whose receiver is an **`import * as ns`** binding, e.g.
    `ns.foo()`. The **B5** territory.
  - `'jsx'` — a JSX component tag, `<Foo/>`. **B1** — now resolved (a `references` edge).
  - `'heritage'` — a **class's** `extends` base, `class X extends Base`. **B3** — now resolved (an
    `extends` edge). (An `implements` / interface `extends` reference is **type** position and is
    handled by `classifyPosition`, not here — it is B7, not a value shape.)
  - `'bare-value'` — a bare identifier used as a **value but not called and not a JSX tag**, e.g.
    `const g = foo`, `arr.map(foo)`, `<X prop={foo}/>`. No `code_impact` edge kind covers this — a
    distinct miss shape.
  - `'property-unknown'` — a property-access whose receiver symbol the checker could not resolve.
    The neutral fail-safe bucket (does not count toward B2 or B5).
  - `'other'` — anything else (element-access `obj['foo']`, unusual positions).

- **Member vs namespace split (the *fine* taxonomy).** For a `PropertyAccessExpression` reference,
  take the receiver expression and call `checker.getSymbolAtLocation(receiver)` (the checker is
  already live in the oracle — `program.getTypeChecker()`). If any declaration of that symbol is a
  `ts.NamespaceImport` (`import * as ns from …`) → `'namespace'`; if the receiver is `this` or resolves
  to a local value/parameter/variable → `'member'`; if the symbol is absent → `'property-unknown'`.

- **Where it runs.** Alongside `classifyPosition`, in the oracle's per-reference loop. Only invoked
  when the reference is value-position (type-position refs are the B7 diagnostic and carry no shape).

### Interfaces

```ts
type Shape =
  | 'call' | 'member' | 'namespace' | 'jsx' | 'heritage'
  | 'bare-value' | 'property-unknown' | 'other'

// classifyShape(sf, pos, checker): Shape   — value-position refs only
```

`OracleSource` gains the shapes a source uses (see Unit 2). `classifyShape` is **exported** for a
focused fixture test (the same pattern Slice 2's `classifyPosition` follows) — the trust-critical
receiver-resolution logic is pinned directly against hand-built ASTs.

### Depends on / does not touch

Depends on the Slice 2 oracle (`classifyPosition`, `declarationOffset`, `enclosingQualifiedName`) and
the live `ts.Program`/checker. No `src/` change. `typescript` stays bench-only.

**Go/no-go.** The receiver-resolution logic is the new trust-critical piece. It is pinned by a focused
fixture test over each shape (call / member / namespace / jsx / heritage / bare-value / element-access
/ unresolved-receiver). If a shape proves unreliable, it falls into `'other'` or `'property-unknown'`
(never a candidate bucket) and the caveat is recorded — the same fail-toward-neutral discipline as
Slice 2.

---

## Unit 2 — Value-FN *by shape* (`bench/impact-score.ts`, `bench/impact-types.ts`)

Buckets value-position false-negatives by reference shape, so the remaining graph candidates can be
ranked by measured contribution.

### What it does

- **Per-source shape set.** The Slice 2 oracle aggregates each true source to `position ∈
  {value, type, both}`. Slice 3 additionally records, per source, the **set of value-reference shapes**
  that source uses (`shapes: readonly Shape[]`, deduped). A source may reference the target via more
  than one shape (e.g. both a `member` call and a `bare-value` use).

- **Overlapping by-shape buckets.** For each **value** source (`position ∈ {value, both}`):
  - `valueTrueReferenceCountByShape[s] += 1` for each shape `s` the source uses.
  - if the source→target pair is **uncovered** by `code_impact`, `valueFalseNegativesByShape[s] += 1`
    for each shape `s`.

  Buckets **overlap by construction** — a source using both `member` and `namespace` counts in both
  denominators and (if missed) both FN buckets. This is the deliberate analogue of the Slice 2 rule
  that a `'both'`-position source counts as value: the by-shape table is read for **relative mass**,
  not a partition. The overlap is documented at the definition site.

- **Exposed as a diagnostic.** `ImpactBenchReport` gains
  `valueTrueReferenceCountByShape` / `valueFalseNegativesByShape` (`Record<Shape, number>`). These are
  **printed**, not gated — the gated scalar stays `valueFalseNegativeRate`. The by-shape map is **not**
  added to the gated `ImpactBaseline` / `ImpactBaselineSchema` (the baseline stays gate-focused); it is
  a report-only diagnostic, surfaced in the run log and the re-rank memo.

### Interfaces

- Consumes: `Shape`, per-source `shapes` (Unit 1).
- Produces: the two `Record<Shape, number>` fields on `ImpactBenchReport`; the run log prints a
  compact by-shape value-FN line under the existing diagnostics.

### Ranking read-out

For each candidate: **B2 ≈ `valueFalseNegativesByShape.member`**, **B5 ≈
`valueFalseNegativesByShape.namespace`**, and the un-recoverable-by-graph residue ≈ `bare-value` +
`property-unknown`. The relative magnitudes are the re-rank.

---

## Unit 3 — Committed fixture corpus + gate (`bench/fixtures/impact-demo/`)

A small, version-controlled repo whose exported symbols are each referenced through a **single,
known shape** — so the by-shape table has a designed, stable ground truth and the B1/B3 wins
demonstrably zero their buckets.

### Composition

`bench/fixtures/impact-demo/src/`, each target exercised by exactly one shape:

| Exported target | Referenced via | Shape | `code_impact` today |
|---|---|---|---|
| `Button` (`.tsx`) | `<Button/>` | `jsx` | **resolved** (B1) |
| `Base` (class) | `class Widget extends Base` | `heritage` | **resolved** (B3) |
| `Iface` (interface) | `class Widget implements Iface` | *type* (B7) | missed (type — diagnostic) |
| `plainCalled` | `plainCalled()` | `call` | resolved |
| `memberCalled` | `const api = {…}; api.memberCalled()` | `member` | **missed** (B2) |
| `nsCalled` | `import * as ns; ns.nsCalled()` | `namespace` | **missed** (B5) |
| `bareUsed` | `const g = bareUsed` | `bare-value` | **missed** |

Ships `tsconfig.json` and `.codeindex.json`. The bench indexes it into a **temp DB** (config `dbPath`
override) so the committed directory is never mutated; `bench/fixtures/**/.codeindex/` is gitignored
as a belt-and-suspenders guard.

### Scripts & gate

- `bench:impact:fixture` — regenerate `bench/impact-baseline.fixture.json` (generate-slow / commit-JSON).
- `bench:impact:fixture:check` — read the frozen JSON, fail if `valueFalseNegativeRate` regresses
  (gate-fast).
- **Folded into `check:bench`** (sequential, after the existing three self-gates) → rides `bun run
  check`. Because the fixture *contains* JSX and classes, this gate is a **stronger anti-rot guard for
  B1/B3 than the real repos**: break JSX-edge production and the fixture's `jsx` FN rises → its
  `valueFalseNegativeRate` rises → `bun run check` fails.

### Demonstration test (`tests/bench/impact-fixture.test.ts`)

Indexes the fixture, builds the oracle, scores it, and asserts the by-shape value-FN:

- `valueFalseNegativesByShape.jsx === 0` and `.heritage === 0` — B1/B3 **provably** landed.
- `.member > 0` and `.namespace > 0` — the ranked remaining work is **lit** and separated.
- `.bare-value > 0` — the graph-unrecoverable residue is visible.

This is the "prove": a live assertion that the wins zeroed their buckets and the rest is measurable,
not merely a frozen number.

---

## Deliverable — the re-rank memo (opens Slice 4)

A recorded section, **"Reassessment Gate: Slice 3 → 4"**, appended to this spec (or committed
alongside), holding the value-FN-by-shape table from **all three repos**:

- **fixture** — the designed, deterministic demonstration (every shape present and separated).
- **codeindex** and **papai** — the real-distribution read, over their **existing alphabetical-prefix
  sample**. This sampling is biased (documented in `impact-oracle.ts`); replacing it with strided /
  seeded sampling is **explicitly deferred** (a scope call for this slice) and noted as the memo's
  primary caveat.

The table ranks `member` (B2) vs `namespace` (B5) vs `bare-value` by measured value-FN contribution.
That ranking — not a pre-drawn order — is the input `writing-plans` consumes when Slice 4 opens.

---

## Data flow

```
fixture/real repo
   │  indexCodebase (shipped path, unchanged)          ┌── src/ untouched ──┐
   ▼                                                    │                    │
codeindex .db ──► buildReferenceOracle (bench)          tsc Program/checker  │
                    │  per true ref:                    (bench-only)         │
                    │    classifyPosition → value|type ─┘                    │
                    │    classifyShape(receiver via checker) → Shape         │
                    ▼                                                        │
              OracleSource{ name, position, shapes[] }                       │
                    │                                                        │
              scoreImpact (bench) ── buckets value-FN by shape (overlapping) │
                    ▼                                                        │
   ImpactBenchReport{ valueFalseNegativeRate (GATED),                        │
                      valueFalseNegativesByShape (DIAGNOSTIC), … }           │
                    │                                                        │
      ┌─────────────┼───────────────────────────┐                           │
      ▼             ▼                           ▼                            │
 fixture gate   real-repo diagnostics     demonstration test                │
 (check:bench)  (printed by-shape table)  (jsx/heritage == 0, member/ns > 0) │
      └──────────────────────► re-rank memo (opens Slice 4) ◄────────────────┘
```

---

## Error handling & edge cases

- **Unresolved receiver** → `property-unknown` (neutral bucket), never a candidate. Logged count so
  the caveat is visible.
- **Multi-shape source** → counts in every shape it uses (overlapping buckets, documented).
- **Fixture DB isolation** → indexed into a temp `dbPath`; committed dir never mutated;
  `.codeindex/` gitignored.
- **Zero-target guard** → the existing `assertScored` still runs; a broken fixture run throws rather
  than gating on a suspiciously-perfect empty score.
- **Type-position refs** → carry no shape; they remain the `typeFalseNegativeRate` diagnostic (B7),
  unchanged.

---

## Testing

- **Unit 1:** focused fixture test over `classifyShape` — one case per shape, including a
  namespace-import receiver, a local-object receiver, `this`, a bare value use, and an unresolved
  receiver (`property-unknown`). Pinned against hand-built ASTs (fast, no full oracle run), mirroring
  Slice 2's `classifyPosition` test.
- **Unit 2:** scorer test with a hand-built oracle — a source using two shapes counts in both buckets;
  a covered source contributes to `…ByShape` denominators but not FN; the by-shape FN sums are
  consistent with the scalar `valueFalseNegatives`.
- **Unit 3:** the demonstration test above; plus the fixture gate exercised via
  `bench:impact:fixture:check`.
- **Regression:** the three existing gates (`bench:check` IR MRR, `bench:index:check`,
  `bench:impact:check`) stay green; the `typescript`-in-`src` guard stays green.

---

## Exit criteria (definition of done)

- `classifyShape` implemented and exported; value-position refs carry a `Shape`; member/namespace
  split via checker receiver-resolution, with the neutral `property-unknown` fail-safe.
- `valueFalseNegativesByShape` / `valueTrueReferenceCountByShape` on `ImpactBenchReport`, printed as
  diagnostics on all three repos; the gated field stays the scalar `valueFalseNegativeRate`.
- `bench/fixtures/impact-demo/` committed; `bench:impact:fixture` / `:check` scripts; the fixture gate
  folded into `check:bench` and green under `bun run check`.
- Demonstration test proves `jsx == 0` and `heritage == 0` while `member > 0` and `namespace > 0`.
- The re-rank memo recorded (fixture + both real repos), with the alphabetical-prefix sampling caveat
  and the deferred strided-sampling note.
- `typescript` confined to `bench/`; no `src/` change; no regression on the existing gates.

**Deliverable.** A *demonstrated* value-FN instrument (the B1/B3 wins visibly move a real gate on a
committed corpus) plus the measured value-FN-by-shape ranking that opens Slice 4.

---

## Non-goals (YAGNI — stated so they don't creep in)

- **Shipping any graph win (B2 / B4 / B5 / C2-suppression).** Slice 3 measures and ranks; Slice 4
  builds the winner. Drawing a win in now would repeat the "ship blind" risk the whole slice exists
  to retire.
- **Fixing real-repo sampling bias (strided / seeded).** Deliberately deferred — the fixture is this
  slice's demonstration vehicle; the biased-prefix real-repo numbers are directional, caveated input
  to the memo. Sampling can be revisited when a real-repo *estimate* (not just a ranking) is needed.
- **Adding a third real component-heavy repo.** The committed fixture is the deterministic
  demonstration; a real React/TSX sibling was considered and set aside (external-checkout dependency,
  drifting numbers) in favor of the fixture.
- **Navigation primitives.** Reordered behind this slice; unchanged in scope; re-opened at its gate.
- **Type-position (B7) tracking.** Still a distinct, later gap; this slice only *sizes* it via the
  existing `typeFalseNegativeRate`.

---

## Next step

On approval of this written spec: invoke `writing-plans` to produce the task-by-task implementation
plan for the three units + the memo. This is the terminal step of brainstorming.
