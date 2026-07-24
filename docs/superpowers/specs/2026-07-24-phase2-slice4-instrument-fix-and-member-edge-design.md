# codeindex Phase 2 Slice 4 — Instrument Fix & Member Edge (Design)

Base: Slice 3 complete (`decf0de..eca7f3a`), final-review-clean. Opened by the Slice 3 → 4
Reassessment Gate memo (`docs/superpowers/specs/2026-07-24-phase2-slice3-prove-and-rerank-design.md`,
"Reassessment Gate" section).

## What opened this slice

The memo recorded one hard prerequisite before any graph win could be ranked: **fix real-repo
sampling**. papai's `--max-targets 300` alphabetical prefix filled its whole budget inside
`client/admin/*`…`client/settings/*` and never reached `client/shared/*`, so member (B2), namespace
(B5) and `construct` targets had **zero** measured mass on real code — the ranking they were supposed
to feed could not be computed.

That prerequisite is done (strided sampling, below). Running it surfaced a second, larger finding
that reshapes the slice: **most of the "call" false-negative mass is a measurement artifact, not a
resolver gap.** So Slice 4 is two sub-slices, in order:

- **4a — Oracle source-attribution fix (instrument honesty).** Remove the artifact so the ranking and
  the gated baseline are honest.
- **4b — Build the B2 member-call edge (the honest #1 recoverable graph win).**

## Prerequisite (done): strided oracle sampling

`buildReferenceOracle` selected targets with `symbols.slice(0, maxTargets)` over an
`ORDER BY qualified_name` list — a contiguous alphabetical prefix. Replaced with `strideSample`: a
deterministic evenly-spaced sample (`index = floor(i * N / M)` for `i` in `[0, M)`) across the whole
sorted list. The stride stays fixed run-over-run (so regression deltas remain attributable to real
changes, the property the prefix was chosen for) while spreading targets into every directory the
sort interleaves — so `client/shared/*` member/namespace/construct targets finally enter the scored
set. No `maxTargets` ⇒ every symbol scored (codeindex's own gated run), so no sampling applies there.

With striding, papai's sampled shape mass became (before the 4a fix): member `22/22`, construct `1/1`,
namespace still `—/—`, bare-value `302/302`, call `107/226`.

## The measured finding — source-attribution artifact

The oracle attributes each true reference to the **innermost** `symbols`-table entry
(`enclosingQualifiedName`, smallest span). For the pervasive `const body = readBody(res)` form that is
the local variable symbol `fn>body`. code_impact attributes the same call to the enclosing callable
`fn` (its extractor's `isNamedScopeBoundary` treats a plain `const x = …` declarator as transparent).
The two disagree on the reference's **source identity**, and the scorer double-counts the
disagreement:

- the oracle's `fn>body` is not among code_impact's reported sources → **false negative**, and
- code_impact's `fn` is not among the oracle's truth sources → **false positive**.

Measured contamination (artifact = an FN whose caller's enclosing-declaration parent *was* reported by
code_impact):

| Repo | shape | raw FN | artifact | genuine miss |
|---|---|---|---|---|
| codeindex | call | 31 | **31** | **0** |
| papai (strided 300) | call | 107 | **93** | **14** |
| papai (strided 300) | member | 22 | 0 | **22** |
| papai (strided 300) | bare-value | 302 | 0 | 302 |

codeindex's honest value-FN is therefore ~**0.10** (its 8 genuine bare-value misses of 80), not the
gated `0.4875`. The same 31 also inflate its FP count 31/31. B2's 22 member-FN are artifact-free —
code_impact emits no edge for member calls, so no enclosing declaration is reported either way.

**Corrected recoverable ranking (artifact removed):** member (B2) 22 — the largest *recoverable*
bucket — then call ~14, then construct 1, namespace 0; bare-value 302 is larger but genuinely
graph-unrecoverable (untyped assignment/destructure origins, no planned edge type).

### Post-4a measured (artifact-free)

After landing the `nearestNamedBoundary` oracle fix (`db1c894`) and regenerating all three gated
baselines, the actual measured numbers (not forecasts):

| Repo | `valueFalseNegativeRate` (before → after) | `falsePositiveRate` (before → after) | `valueTrueReferenceCountByShape` | `valueFalseNegativesByShape` |
|---|---|---|---|---|
| codeindex (full, `bun run bench:impact:check`) | `0.4875 → 0.1000` | `0.4306 → 0` | `{"call":72,"bare-value":8}` | `{"bare-value":8}` |
| papai (strided 300, `bun run bench:impact:papai`) | `0.7864 → 0.4816` | `0.4387 → 0.0047` | `{"call":220,"bare-value":160,"member":22,"property-unknown":1,"other":4}` | `{"bare-value":160,"member":22,"property-unknown":1,"call":9,"other":4}` |
| fixture (`bun run bench:impact:fixture:check`) | `0.5 → 0.5` (unchanged) | `0 → 0` | `{"bare-value":1,"heritage":1,"jsx":1,"namespace":1,"member":1,"call":1}` | `{"bare-value":1,"namespace":1,"member":1}` |

Note: the reported baseline `trueReferenceCount`/`falseNegatives` totals (which include type refs) also
shrank on both real repos — e.g. papai `854 → 605` true references — because the boundary-attribution
fix deduplicates multiple raw reference sites that previously fanned out to distinct innermost-local
sources (the artifact) down onto one shared boundary source; this dedup effect touches non-`call`
shapes too (papai bare-value mass moved `302 → 160`), not just the `call` artifact the design section
above isolated. The **direction and shape-level conclusions are unaffected**: bare-value and member
remain fully unrecovered (100% FN) either way, and the `call` shape shows the same large,
artifact-driven collapse.

codeindex honest value-FN confirmed ~0.10 (bare-value 8/8; call 0); papai call-FN dropped
107 → 9 genuine (even lower than the ~14 forecast), member 22/22 unchanged (artifact-free, confirming
it as the largest recoverable bucket for 4b); FP rate collapsed papai `0.4387 → 0.0047`, codeindex
`0.4306 → 0`. All three regenerated baselines (`bench/impact-baseline.json`,
`bench/impact-baseline.papai.json`, `bench/impact-baseline.fixture.json`) pass their own
`--baseline` check.

## Slice 4a — Oracle source-attribution fix

**Goal.** Attribute a true reference to the same symbol code_impact does: the nearest enclosing
**scope boundary**, matching the extractor's `isNamedScopeBoundary` rule — function / method / class
declarations, and arrow-or-function-valued variable declarators (`const start = () => {}`), but *not*
plain `const body = f()` declarators.

**Why not a pure DB parent-walk.** `kind` in `symbols` is the tree-sitter node type, so
`const body = f()` and `const start = () => {}` are both `variable_declarator` — indistinguishable by
kind. Arrow-var-local boundaries are real and non-trivial (papai: 170 edges / 57 distinct local
sources such as `useScrollSpy>start = (): void => {…}`). A blind "skip all local variable_declarators"
walk would re-introduce the artifact for those 57. The transparent-vs-boundary distinction is only
knowable from the AST.

**Design (reuses existing machinery; stays in the DB qualified-name namespace).**

1. `nearestScopeBoundary(node)` — walk **up the TS AST** from the reference node to the first ancestor
   that is a *named* scope boundary (TS translation of `isNamedScopeBoundary` composed with
   `nextEnclosingSymbol`): a named `FunctionDeclaration | MethodDeclaration | ClassDeclaration`, or an
   `ArrowFunction | FunctionExpression` whose parent is a `VariableDeclaration` (named by the
   declarator). **Unnamed** function expressions / arrow callbacks (`arr.map(x => f(x))`) contribute
   no name segment — the indexer's `nextEnclosingSymbol` returns the enclosing symbol unchanged for a
   node with no `name` — so the walk continues past them to the nearest named boundary, exactly as
   code_impact would attribute the source.
2. Feed that boundary's declaration-name line to the existing `enclosingQualifiedName(db, file, line)`
   — which returns the boundary's codeindex symbol. No name reconstruction, so oracle source names
   still line up exactly with code_impact's qualified names.

For the dominant papai form `export const fetchBillingDetail = async (…) => { const body =
readBody(res) }`, the nearest boundary above the `readBody` call is the arrow-var
`fetchBillingDetail` — the plain `body` declarator is transparent — so the oracle now attributes to
`fetchBillingDetail`, matching code_impact. Both the phantom FN and phantom FP vanish.

**Consequences (recorded honestly).**

- Gated `bench:impact:check` (codeindex) baseline moves `0.4875 → ~0.10`; regenerate it. The drop is
  a correctness fix to the instrument, not a resolver change — documented in the commit and memo.
- papai FP rate collapses (`0.44 → low`); papai call-FN `107 → ~14`. Regenerate the papai baseline.
- Re-record the Reassessment Gate memo table with artifact-free numbers.

**Tests (focused, TS-AST fixtures like the existing `classifyShape`/`classifyPosition` pins).**

- plain `const x = f()` → reference attributed to the enclosing function/arrow-var, not `>x`.
- arrow-var boundary `const start = () => { f() }` → attributed to `start` (boundary retained).
- method / class-declaration boundaries → attributed to the method / a member within the class.
- an oracle-level test on a built repo asserting the `const body = f()` caller resolves to the
  function (the artifact is gone).

## Slice 4b — Build the B2 member-call edge

**Current gap.** `collectCallReference` sets `targetName = functionNode.text`. For `this.m()` /
`obj.m()` the function node is a `member_expression`, so `targetName` is the literal `"this.m"` /
`"obj.m"`, which resolves to nothing — the entire B2 miss.

**Build: `this.m()` only; `obj.m()` deferred.** The committed position (not an open decision):
4b builds `this.m()` and defers `obj.m()`. `this.m()` is high-precision — the receiver is the
unambiguous enclosing class, so the method resolves deterministically. `obj.m()` is FP-prone — a bare
method name collides across every class declaring `m`, and without types there is no principled
receiver resolution — so it is out of scope for 4b and revisited only if a later, typed approach can
clear the honest FP bar. This keeps 4b a clean, near-zero-FP win rather than trading the honesty 4a
just bought back for marginal recall.

1. **Split the 22 to size the target.** Measure `this.m()` vs `obj.m()` among the genuine member-FN,
   so 4b's expected recovery (the `this.m()` share) is known before building and confirmed after.
   This sizes the win; it does **not** reopen the `obj.m()` decision.
2. **Build `this.m()` resolution.** In `collectCallReference`, detect a `member_expression` function
   node; when the receiver is `this`, emit a `calls` reference to the property name `m`. Resolve it to
   a `method_definition` symbol named `m` whose parent is the enclosing class → `resolved` confidence,
   near-zero FP. `obj.m()` (non-`this` receiver) is left unresolved, exactly as today.
3. **Confirm the honest FP rate does not regress.** 4a makes the FP metric trustworthy; 4b must not
   move it — the `this.m()` edge is deterministic, so any FP increase is a bug to fix, not a
   tolerance to accept.

**Verification.** Extend the committed fixture (which already seeds `member:1/1`) to cover `this.m()`
explicitly. Success = member value-FN drops on the fixture and papai with the honest FP rate not
regressing.

**Measured (4b).** Fixture (`Panel.render` → `this.helper()`): member value-FN `1 → 0`
(`bench/impact-baseline.fixture.json`, `valueFalseNegatives` `3 → 2`). Papai (strided 300,
`bench/impact-baseline.papai.json`): member value-FN `22 → 11` (the `this.m()` share resolved; the
remaining 11 are `obj.m()`, deferred per the committed position above), overall `falseNegatives`
`394 → 383`. Honest FP rate not regressed: papai `falsePositiveRate` `0.0047169811320754715 →
0.004484304932735426` (unchanged within noise, not higher); codeindex fixture FP stayed `0 → 0`.
`bun run check` green after the update.

## Success criteria

- 4a: gated codeindex `valueFalseNegativeRate` reflects the honest ~0.10; papai call-FN ≈ 14 and FP
  rate collapsed; memo re-recorded; focused attribution tests green; `bun run check` green.
- 4b: `this.m()` member calls resolve end-to-end; member value-FN reduced on the fixture and papai by
  the measured `this.m()` share of the 22; honest FP rate not regressed; `obj.m()` left unresolved
  (deferred, per the committed position above).

## Out of scope / deferred

- **`obj.m()` member calls (non-`this` receiver)** — FP-prone without types; deferred, revisited only
  behind a typed receiver-resolution approach that can clear the honest FP bar (see 4b).
- **namespace (B5)** — `—/—` on real code even after striding; no measured mass to justify a build.
- **construct (`new X()`)** — 1 genuine miss; tracked, not built this slice.
- **barrel re-exports (B4)** — the ~14 genuine call-FN residue may include these; not this slice.
- **bare-value (302)** — genuinely graph-unrecoverable; no edge type applies.
- **A representative population *estimate*** (vs the strided directional sample) — still deferred; the
  stride removes the prefix bias for ranking but is not a statistical population estimate.
