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

Slice 3 closes that gap and makes the *rest* of the graph work evidence-driven. It does three things:

1. **Prove** — a committed fixture corpus that contains every reference shape, so the B1/B3 wins
   *demonstrably* zero their value-FN buckets while the un-built shapes stay lit.
2. **Make B2 visible** — broaden the oracle's target set from `exported`-only to `exported` **+
   `member`** tier. This is forced by an empirical finding (below): member calls (`this.m()`,
   `obj.m()` — the entire B2 candidate) resolve to **method** symbols, which are `member` tier and
   were never scored, so B2 was invisible to the instrument. Broadening the target set — *not* the
   resolver — is what lets B2 be measured.
3. **Re-rank** — a value-FN **by reference shape** breakdown that ranks the remaining graph
   candidates (B2 member calls vs B4/B5 namespaces vs bare-value refs) by *measured* contribution.

**No graph win is shipped this slice.** Broadening the *oracle's* target set is an instrument change
(bench-only), not a resolver/graph change — the shipped tool is untouched. The operating principle is
unchanged from the Phase 2 design: *measure before you commit.* The Slice 3 output is the ranked
evidence that opens Slice 4; the next win is picked from that evidence, not drawn in advance.

### Empirical finding forcing the target-set broadening

Probed during planning (2026-07-24): the oracle scores `scope_tier='exported'` symbols only. (a) Class
methods are `member` tier, so `this.helper()` / `obj.method()` — the whole B2 mass — target unscored
symbols. (b) You cannot manufacture a `member` miss over an *exported* target either: `tsc`'s
references for an exported `memberCalled` are the declaration, the import, and a shorthand
`{ memberCalled }` — **never** `api.memberCalled()`. So over the exported-only oracle the `member`
bucket is ≈0 and B2 is unmeasurable. Blast radius of broadening to `member` tier: **codeindex is
byte-identical** (it is functional — 0 member-tier symbols), and the **fixture** carries a deterministic
member case.

> **Superseded by measurement (see the Reassessment Gate below).** This planning-time forecast
> predicted papai's `member` bucket would populate from the `--max-targets 300` sample. It did **not**:
> that alphabetical sample fills up inside `client/settings/*` before reaching `client/shared/*` where
> methods start, so **0 member targets enter papai's sample** and its baseline came back byte-identical
> too. B2 ends up measurable only on the fixture. This is the finding that makes representative
> sampling the Slice 4 prerequisite recorded in the memo.

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
- **Target-set broadening re-baselines papai only.** Scoring `member`-tier symbols is a *redefinition*
  of the scored set, so `bench/impact-baseline.papai.json` is re-frozen (its `valueFalseNegativeRate`
  legitimately shifts — not a regression). `bench/impact-baseline.json` (codeindex) must come back
  **byte-identical** (0 member-tier symbols); a diff there means the broadening leaked something and
  is a bug to investigate, not to re-freeze away.
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
  - `'construct'` — a class instantiation, `new Foo()` (a `NewExpression`, distinct from a
    `CallExpression`). `code_impact` does **not** emit an edge for `new_expression` today, so these are
    **missed** — but recoverable by extending call-edge resolution to `new_expression`, so a distinct
    candidate from the truly-unrecoverable `bare-value`. (Added during the final review — a `new X()`
    ref was otherwise mislabelled `bare-value`.)
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
  | 'call' | 'construct' | 'member' | 'namespace' | 'jsx' | 'heritage'
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
`valueFalseNegativesByShape.namespace`**, **`construct`** is a separate recoverable candidate (extend
call-edge resolution to `new_expression`), and the truly un-recoverable-by-graph residue ≈ `bare-value`
+ `property-unknown`. The relative magnitudes are the re-rank. (See the Reassessment Gate memo for the
measured values; `construct` was split out of `bare-value` during the final review.)

---

## Unit 3 — Broaden the oracle target set to `member` tier (`bench/impact-oracle.ts`)

The change that makes B2 measurable. `loadExportedSymbols` selects `scope_tier='exported'` only;
Slice 3 broadens it to `scope_tier IN ('exported','member')` (rename to `loadScoredSymbols`). Nothing
else in the oracle changes — `declarationOffset` already handles method declarations (`isNamedDeclaration`
includes `ts.isMethodDeclaration`), and a method's `local_name` (`helper`) locates via the same
name-proximity path.

### What it does

- Adds method symbols (`Class>method`) to the scored targets. A `this.helper()` reference to such a
  method is stored by `code_impact` as opaque call text (`this.helper`) with no edge → **missed** →
  it lands in the `member` bucket. B2 becomes a real number.
- `member`-tier **properties** (non-method members) are also `member` tier; they are scored too and
  fall out naturally (most have zero true sources or `bare-value` refs). No special-casing.

### Blast radius (measured during planning)

- **codeindex** — 0 member-tier symbols (functional codebase); `bench/impact-baseline.json` re-freezes
  **byte-identical**. A non-empty diff is a bug signal (see Global Constraints), not a re-freeze.
- **papai** — 402 member methods; the `--max-targets 300` alphabetical prefix now includes some, so
  `bench/impact-baseline.papai.json` re-freezes with a shifted `valueFalseNegativeRate` and a populated
  `member` bucket. Legitimate redefinition, not a regression.

### Interfaces

- Modifies: `loadExportedSymbols` → `loadScoredSymbols(db)` (same row shape; wider `WHERE`).
- No change to `OracleTarget` / scorer / report — this unit only widens *which* targets flow through.

**Go/no-go.** If member scoring makes the papai oracle run unacceptably slow or floods the sample with
test-stub methods, cap with the existing `--max-targets` and record the composition caveat in the memo
(the sampling is already documented as biased). It does not block the slice.

---

## Unit 4 — Committed fixture corpus + gate (`bench/fixtures/impact-demo/`)

A small, version-controlled repo whose scored symbols are each referenced through a **single, known
shape** — so the by-shape table has a designed, stable ground truth and the B1/B3 wins demonstrably
zero their buckets.

### Composition

`bench/fixtures/impact-demo/src/`, each target exercised by exactly one shape. The `member` case uses
a **scored method referenced via `this`** (per the empirical finding — a property-access onto an
*exported* symbol does **not** register as a member reference, so B2 must be a method target reached
through `this`/an instance):

| Scored target | Referenced via | Shape | `code_impact` today |
|---|---|---|---|
| `Button` (`.tsx`) | `<Button/>` | `jsx` | **resolved** (B1) |
| `Base` (class) | `class Widget extends Base` | `heritage` | **resolved** (B3) |
| `Iface` (interface) | `class Widget implements Iface` | *type* (B7) | missed (type — diagnostic) |
| `plainCalled` | `plainCalled()` | `call` | resolved |
| `Panel>helper` (method) | `this.helper()` inside `Panel>render` | `member` | **missed** (B2) |
| `nsCalled` | `import * as ns; ns.nsCalled()` | `namespace` | **missed** (B5) |
| `bareUsed` | `const g = bareUsed` | `bare-value` | **missed** |

Ships `tsconfig.json` and `.codeindex.json`. The bench indexes it in place; its `.codeindex/` DB
directory is already covered by the repo's global `.gitignore` (`.codeindex/`, `*.db*`), so the
committed source is never polluted by generated artifacts — no temp-DB override needed (this matches
how the codeindex self-bench indexes into its own gitignored `.codeindex/`).

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
- **Fixture DB isolation** → indexed into the fixture's own `.codeindex/`, already covered by the
  repo's global `.gitignore` (`.codeindex/`, `*.db*`); committed source is never tracked-dirty.
- **Member target with zero true sources** → contributes only to denominators (or nothing); never
  fabricates an FN. `assertScored` still guards a wholly-empty run.
- **Zero-target guard** → the existing `assertScored` still runs; a broken fixture run throws rather
  than gating on a suspiciously-perfect empty score.
- **Type-position refs** → carry no shape; they remain the `typeFalseNegativeRate` diagnostic (B7),
  unchanged.

---

## Testing

- **Unit 1:** focused test over `classifyShape` — one case per shape, including a namespace-import
  receiver, a local-object receiver, `this`, a bare value use, and an unresolved receiver
  (`property-unknown`). Because receiver resolution needs a real checker, the cases live in **one small
  in-tmpdir `tsc` program** (via `createTsProject`, no `indexCodebase`), positions located by a
  helper that skips import-binding and declaration-name identifiers — fast, and lighter than a full
  oracle run.
- **Unit 2:** scorer test with a hand-built oracle — a source using two shapes counts in both buckets;
  a covered source contributes to `…ByShape` denominators but not FN; the by-shape FN sums are
  consistent with the scalar `valueFalseNegatives`.
- **Unit 3 (broaden targets):** verified through the papai re-baseline (member bucket becomes
  non-zero) and the codeindex byte-identical re-freeze; no dedicated unit test (it is a one-line
  `WHERE` widening), but the fixture's `member > 0` assertion (Unit 4) exercises the path end-to-end.
- **Unit 4:** the demonstration test above; plus the fixture gate exercised via
  `bench:impact:fixture:check`.
- **Regression:** the three existing gates (`bench:check` IR MRR, `bench:index:check`,
  `bench:impact:check`) stay green; the `typescript`-in-`src` guard stays green.

---

## Exit criteria (definition of done)

- `classifyShape` implemented and exported; value-position refs carry a `Shape`; member/namespace
  split via checker receiver-resolution, with the neutral `property-unknown` fail-safe.
- `valueFalseNegativesByShape` / `valueTrueReferenceCountByShape` on `ImpactBenchReport`, printed as
  diagnostics on all three repos; the gated field stays the scalar `valueFalseNegativeRate`.
- Oracle target set broadened to `exported` + `member` tier; `bench/impact-baseline.papai.json`
  re-frozen (member bucket now non-zero), `bench/impact-baseline.json` re-frozen **byte-identical**.
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
  to retire. (Broadening the *oracle's* target set to `member` tier is an instrument change, not a
  resolver change — the shipped tool produces no new edges this slice.)
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

---

## Reassessment Gate: Slice 3 → 4 (recorded 2026-07-24; corrected 2026-07-24 post-review)

Value-FN by reference shape (FN / true-refs), from `valueFalseNegativesByShape` over
`valueTrueReferenceCountByShape`. Real-repo rows use the biased alphabetical-prefix sample
(strided/seeded sampling deferred — the memo's primary caveat).

**Post-review correction:** the first recording of this memo classified `new X()` (a
`ts.NewExpression`) as `'bare-value'`, because `classifyShape` fell through its `ts.isCallExpression`
check (a `NewExpression` is not a `CallExpression`) straight to the `bare-value` default. That
silently folded constructor-call misses into the "graph-unrecoverable" bucket below, which is wrong:
`code_impact` doesn't resolve `new X()` today (no `new_expression` handling yet), but it is
**recoverable** by extending the existing call-edge resolution to `new_expression` — a materially
different, and likely cheaper, fix than genuine `bare-value` misses (untyped assignment/destructure
origins, for which no planned edge type applies). `classifyShape` now emits a distinct `'construct'`
shape for `new X()`, and the table below adds that column. The three repos' `bare-value` and `call`
cells are **numerically unchanged** from the first recording — re-running all three memo commands
after the fix shows `construct` is `—/—` (absent) on every sampled repo this run, i.e. none of the
already-measured `bare-value` or `call` FNs were actually mislabeled constructor calls in this
particular alphabetical-prefix sample. The relabeling is a **correction to the taxonomy and its
prose**, not a change to any gated number (`valueFalseNegativeRate` deltas were `0.0000` on all three
repos, confirmed below) or to the underlying `bare-value` counts.

| Repo | member (B2) | namespace (B5) | bare-value | construct | jsx (B1) | heritage (B3) | call |
|---|---|---|---|---|---|---|---|
| impact-demo (fixture) | 1/1 | 1/1 | 1/1 | —/— | 0/1 | 0/1 | 0/1 |
| codeindex | —/— | —/— | 8/8 | —/— | —/— | —/— | 31/72 |
| papai (300, exported+member) | —/— | —/— | 131/131 | —/— | —/— | —/— | 11/63 |

Convention: `—/—` means the shape is **absent** from both `valueFalseNegativesByShape` and
`valueTrueReferenceCountByShape` on that repo — i.e. zero true references of that shape entered the
sample at all — distinct from an `N/M` cell, where the shape is present and measured. Raw readings
(`bun run bench:impact:fixture:check`, `bun run bench:impact:check`, `bun run bench:impact:papai`,
each piped through `grep -E 'valueFalseNegativesByShape|valueFalseNegativeRate'`), captured after the
`construct` fix:

- fixture: `valueFalseNegativesByShape (diagnostic): {"bare-value":1,"namespace":1,"member":1} of
  {"bare-value":1,"heritage":1,"jsx":1,"namespace":1,"member":1,"call":1}`, rate `0.5000` (unchanged;
  the fixture has no `new` expressions). No `construct` key present.
- codeindex: `valueFalseNegativesByShape (diagnostic): {"call":31,"bare-value":8} of
  {"call":72,"bare-value":8}`, rate `0.4875` (unchanged). No `construct` key present — codeindex has
  0 exported classes, so no `new X()` on any scored target's incoming edges could exist.
- papai: `valueFalseNegativesByShape (diagnostic): {"bare-value":131,"call":11} of
  {"bare-value":131,"call":63}`, rate `0.7320` (unchanged). No `construct` key present — papai does
  have exported classes reached via `new` (e.g. `client/shared/fetcher-helpers#FetchError`), but the
  alphabetical `--max-targets 300` cutoff fills up inside `client/settings/*` and never reaches
  `client/shared/*`, so none entered this sample either. This is the same sampling-composition gap
  already noted for B2/B5 below, now also confirmed to hide `construct`.

**Reading / ranking for Slice 4:**

- **B1/B3 demonstrated:** jsx and heritage FN are **0** on the fixture (covered), proving the Slice 2
  edges land end-to-end. On codeindex and papai, jsx and heritage are `—/—` — entirely absent from
  the shape map, not merely zero-FN. codeindex's true refs are 100% `call`/`bare-value` (no JSX
  consumption or class-heritage refs turned up among its 80 true value refs this run); papai's
  alphabetical-prefix sample (`client/admin/*` … `client/settings/*`) never reaches its
  component-heavy directories either. This is corpus/sampling composition, not a regression of the
  B1/B3 wins — the fixture is the only place they're currently exercised on real graph output.
- **B2 vs B5 — the head-to-head this slice set out to unlock, and what the data actually shows:**
  **member (B2) is measurable only on the fixture, not on either real repo.** Confirmed directly by
  inspecting the target lists: 0 of codeindex's 103 targets and 0 of papai's 300 targets match the
  member-tier `File#Class.method` shape. codeindex is a functional codebase — it has 0 member-tier
  symbols to sample, full stop. papai's `--max-targets 300` walks targets in alphabetical order and
  fills the entire 300-slot budget inside `client/admin/*` through `client/settings/*`; it never
  reaches `client/shared/*`, where papai's methods start (and those methods skew stub-heavy anyway).
  **namespace (B5) is equally `—/—` on both real repos in this sample** — it is not only B2 that's
  blank; with the current alphabetical sampling, *neither* B2 nor B5 has any measured real-code mass.
  The fixture's `member:1/1` vs `namespace:1/1` is **1:1 by construction** (one seeded instance of
  each, chosen so the demonstration test can assert both are lit and separated) — it proves the
  instrument *separates* B2 from B5, but it cannot and does not rank their real-code magnitude. That
  ranking needs targets that neither real-repo sample currently contains.
- **Residue, corrected — `bare-value` is not monolithically graph-unrecoverable:** `bare-value` FN is
  the one shape both real repos actually measure, and it is 100% FN on each: codeindex `8/8`, papai
  `131/131`. Sized against each repo's total true value refs, bare-value is 8 of 80 (10%) on codeindex
  but 131 of 194 (68%) on papai — and against each repo's total FN mass, it's 8 of 39 (21%) of
  codeindex's FN but 131 of 142 (92%) of papai's FN. The first recording of this memo characterized
  all of that mass as "no planned edge type recovers" — that was too strong: it silently included any
  `new X()` constructor calls, which are **not** graph-unrecoverable, they're recoverable by extending
  the existing call-edge resolution to `new_expression`. Now that `classifyShape` splits those into
  their own `construct` shape, the `8/8` and `131/131` counts above are confirmed to be *genuine*
  bare-value misses (untyped assignment/destructure origins, no call/property/heritage/jsx/construct
  form) — `construct` came back `—/—` on both real repos this run, meaning none of the currently
  sampled bare-value mass was actually a mislabeled constructor call. That keeps codeindex `8/8` and
  papai `131/131` as the honest, still-unrecovered floor for *this* sample, but the finding is now
  scoped correctly: a future sample that does reach class-heavy directories (see the sampling caveat
  below) could turn up `construct` misses, and those would be a cheap, distinct recovery target from
  true bare-value — not more of the same unrecoverable residue.
- **Opens Slice 4 with:** **representative (strided/seeded) sampling of papai is the concrete Slice 4
  prerequisite** — not a pre-drawn B2-vs-B5 winner. Current evidence cannot rank B2 against B5: B2 has
  zero real-code data points (0/300 papai, 0/103 codeindex) and B5 has zero real-code data points on
  papai's current sample too. The same sampling gap hides `construct`: papai has at least one
  exported, `new`-instantiated class (`client/shared/fetcher-helpers#FetchError`) that the current
  alphabetical cutoff never reaches, so `construct`'s real-code magnitude — and whether extending
  call-edge resolution to `new_expression` is worth prioritizing — is likewise unmeasured, not zero.
  Until sampling reaches `client/shared/*` and codeindex-equivalent class-bearing directories, this
  table's `member`/`namespace`/`construct` columns stay `—/—` on real code and any
  claimed ranking between them would be invented, not measured. Fix sampling first; re-run this memo's
  three commands to get the numbers that can actually rank B2 vs B5.

**Caveats:** real-repo rows are an alphabetical-prefix sample (biased, documented in
`impact-oracle.ts`); papai's member tier skews toward test-stub methods that sort early — but at
`--max-targets 300` it doesn't even reach them, since `client/admin/*`…`client/settings/*` alone fill
the budget before `client/shared/*`. Directional, not a population estimate; not a ranking of B2 vs B5
until sampling is fixed.
