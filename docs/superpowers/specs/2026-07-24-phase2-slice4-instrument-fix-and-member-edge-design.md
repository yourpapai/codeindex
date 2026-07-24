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

**Build, staged by precision (gated by the now-honest FP metric).**

1. **Split the 22 first.** Measure `this.m()` vs `obj.m()` among the genuine member-FN. `this.m()` is
   high-precision (receiver is the unambiguous enclosing class); `obj.m()` is FP-prone (a bare method
   name collides across every class declaring `m`).
2. **Build `this.m()` resolution (safe subset).** In `collectCallReference`, detect a
   `member_expression` function node; when the receiver is `this`, emit a `calls` reference to the
   property name `m`. Resolve it to a `method_definition` symbol named `m` whose parent is the
   enclosing class → `resolved` confidence, near-zero FP.
3. **Decide `obj.m()` against the honest FP metric.** Include cross-object resolution only if it
   clears the FP bar 4a made trustworthy; otherwise emit at `name_only` confidence or defer. This is
   the magnitude-to-risk gate — 4a is what makes the FP number honest enough to gate on.

**Verification.** Extend the committed fixture (which already seeds `member:1/1`) to cover `this.m()`
explicitly. Success = member value-FN drops on the fixture and papai with the honest FP rate not
regressing.

## Success criteria

- 4a: gated codeindex `valueFalseNegativeRate` reflects the honest ~0.10; papai call-FN ≈ 14 and FP
  rate collapsed; memo re-recorded; focused attribution tests green; `bun run check` green.
- 4b: `this.m()` member calls resolve end-to-end; member value-FN measurably reduced on fixture and
  papai; honest FP rate not regressed; `obj.m()` include/defer decision recorded with its measured
  basis.

## Out of scope / deferred

- **namespace (B5)** — `—/—` on real code even after striding; no measured mass to justify a build.
- **construct (`new X()`)** — 1 genuine miss; tracked, not built this slice.
- **barrel re-exports (B4)** — the ~14 genuine call-FN residue may include these; not this slice.
- **bare-value (302)** — genuinely graph-unrecoverable; no edge type applies.
- **A representative population *estimate*** (vs the strided directional sample) — still deferred; the
  stride removes the prefix bias for ranking but is not a statistical population estimate.
