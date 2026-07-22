# codeindex Phase 2 — Accuracy & Free Wins (Design)

**Date:** 2026-07-22
**Status:** Approved design. Firm commitment covers **Slice 1 only**; Slices 2–3 are provisional
and planned at their gates (opened by the FN oracle Slice 1 builds).
**Source:** Grounded in the Phase 1 baselines (`bench/*.json`, `.superpowers/sdd/progress.md`), the
approved roadmap (`docs/superpowers/specs/2026-07-20-codeindex-roadmap-design.md`), and the research
corpus (`docs/research/01`–`05`).

---

## Purpose

Phase 1 shipped the harness and produced trustworthy baselines. This document is the **Reassessment
Gate output** the roadmap promised: it takes those baselines and decides *what Phase 2 builds, in
what order, and under what conditions*.

The roadmap's Phase 2 structure holds — graph completion is confirmed as the dominant deficit — but
the measured numbers **re-rank the first slice** and expose one blocker: the harness cannot yet
measure the metric Phase 2 exists to move. Slice 1 fixes that first, then banks the wins that are
already measurable; graph completion follows, now provable against a real number.

The operating principle is unchanged: **measure before you commit.** Only Slice 1 is firm. Each later
slice is opened by the FN/FP number the Slice 1 oracle produces.

---

## What Phase 1 measured (the re-ranking evidence)

Cross-checked against both live indexes (`codeindex` self-index and `../papai`):

| Signal | codeindex (lib) | papai (bot+client) | Reading |
|---|---|---|---|
| References unresolved | **64%** (548/855) | **57%** (14 353/24 994) | Graph incompleteness is the dominant deficit — **confirms "graph leads."** |
| Unresolved calls that are `obj.member()` | 96% (487) | 89% (11 710) | The giant bucket — but top receivers are **external** (zod `z` ×112, `db` ×85, `JSON`, `path`, `Promise`, `React`), genuinely unresolvable without a type checker. |
| `this.method()` calls | **0** | 238 | The cleanly-heuristic-resolvable slice is *tiny* — both repos are functional/hooks, not class-OO. |
| JSX component usages | n/a | **230 tags → 0 edges** | B1 is clean, additive, zero-FP — but modest (papai is mostly backend; 32 tsx files). |
| MRR | 0.905 | 0.829 | Ranking is decent; weakness concentrates in **NL-intent** (RR 0.20 / 0.25 / 0.33 for 3 of 4). |
| precision@k | 0.114 | 0.131 | **Artifact, not a deficit** — most queries have 1 relevant item, capping p@10 at 0.10. Ignore as signal. |
| `resolved` vs `name_only` confidence | 174 vs 681 | 7 915 vs 16 682 | Only ~20–32% of edges are file-matched; the rest is `name_only` (where C2 false positives hide). |
| Orphaning rate (fuzzer) | — | **35.8%** | Real freshness deficit — correctly slotted to Phase 3–4. |

### Three adjustments the evidence forces

1. **The harness cannot yet measure the one metric Phase 2 exists to move.** The Phase 1
   who-uses `recall = 1.0` is *circular*: the ground truth was mined from `code_impact`'s own output
   ("every symbol probed via impact returned a resolved reference"). So the harness measures
   **ranking**, not **`code_impact` FN rate** — the safety-critical number graph completion targets.
   The roadmap's own Phase 2 success metric ("measured FN drop on papai") is **currently
   unmeasurable**. This must close first, or the graph work ships blind.

2. **Member-call resolution (B2) is over-weighted as a "cheap win."** The 11 710-edge headline is
   mostly external receivers a heuristic can't and shouldn't touch. The genuinely-cheap slice
   (`this.x()` + known-local receivers) is small (238 on papai, 0 here). The bulk is Phase 3
   type-aware territory or correctly-external. What *is* cheap + additive + zero-FP: **JSX (B1),
   `extends`/`implements` (B3).**

3. **BM25 ranking (1a) targets a weakness the harness can already measure today** (NL-intent MRR),
   is cheap, and ships independently. It earns co-lead status in Slice 1 — but **in-degree ranking
   does not**, because in-degree is a broken signal until the graph is complete (see Slice 1 Unit 2).

---

## Slice 1 — Instrument & Measurable Wins (FIRM)

Three units, independently shippable, zero inter-dependencies. Design goal: make the graph work
*provable*, and bank the accuracy/cheapness wins that are already measurable or certain — without
touching the graph itself.

### Unit 1 — tsc reference oracle + differential FN/FP scorer (`bench/`)

The instrument. Grades the cheap tree-sitter resolver against a heavy type-checker oracle the shipped
tool is not allowed to use.

- **What it does.** Builds a `ts.Program` (via `ts-morph`) over a bench repo, sweeps exported
  symbols, and for each calls `findReferences` to obtain the **true referencing set**. Maps each true
  reference's `(file, position)` to the enclosing codeindex symbol key. Runs the same targets through
  the real `code_impact` path. Emits:
  - **FN rate** — true refs `code_impact` missed (safety-critical).
  - **FP rate** — edges `code_impact` reports that tsc's set does not contain, **bucketed by
    confidence tier** (`name_only` FPs are the interesting ones; the C2 codebase-wide fallback lives
    here).
- **How you use it.** `bench:impact` regenerates the oracle (slow, offline) and writes
  `bench/impact-baseline.<repo>.json`; `bench:impact:check` reads the frozen JSON and fails if FN
  rate regresses past threshold. This mirrors the established generate-slow / commit-JSON / gate-fast
  pattern of `baseline.json`.
- **Depends on.** `ts-morph` as a **bench-only dev dependency, never imported by `src/`** (enforced —
  the shipped indexer stays type-checker-free); the real `code_impact` path; a small
  position→symbol-key helper (shared within `bench/`).
- **Interpretation caveats (baked into the scorer).** FP is noisier than FN: a `code_impact` edge
  absent from tsc's set may be (a) a genuine false positive, (b) a rare tsc miss, or (c) a
  position-mapping artifact. The scorer reports FP **by confidence tier** and does not gate on raw FP
  in Slice 1 — the FP number's first job is to inform Slice 2's C2-suppression and member-call
  go/no-go, not to gate Slice 1.

**Entry.** Phase 1 baselines exist (they do).
**Go/no-go.** If the position→symbol-key mapping proves unreliable enough to make FN untrustworthy,
fall back to a curated target set (≈20–40 symbols across the blind-spot shapes) rather than shipping
a number we don't believe.
**Success.** First trustworthy `code_impact` FN number on papai + codeindex, frozen as a baseline and
wired as a fast CI gate.

### Unit 2 — Ranking: blend BM25 (`src/search/rank.ts`, `src/search/fts.ts`)

Research 1a, minimal scope.

- **What it does.** Threads the FTS BM25 score into `matchScore` (today hardcoded `0` for *every* FTS
  hit, so scope tier alone orders NL results — the measured cause of low NL-intent RR) and de-dups
  the exact pool (overloads / duplicate declarations that currently both survive).
- **Depends on.** Nothing new; the BM25 signal is already produced by the FTS query and discarded.
- **Deliberately deferred: in-degree / centrality ranking.** In-degree ("used by N callers") is a
  strong signal *once the graph is whole* — but 89–96% of call edges are unresolved today, so a
  heavily-used function shows near-zero in-degree. Ranking on it now would rank on a broken signal.
  Sequenced to land **after** Slice 2 completes the graph. This is an evidence call, not an omission.

**Entry.** None (parallel with Units 1 and 3).
**Go/no-go.** Ships only if it does **not regress MRR** on either repo (the existing gate).
**Success.** NL-intent RR rises (from 0.20 / 0.25 / 0.33) with no MRR regression, proven by
`bench:check` / `bench:papai:check`.

### Unit 3 — Token economics: kill the 2× payload (`src/mcp/tools.ts`, `src/mcp/server.ts`)

Research 3a / gap H1.

- **What it does.** Stops emitting the full JSON in both `content[0].text` and `structuredContent`
  (~2× token cost per call). `structuredContent` stays the full payload; `content[0].text` shrinks to
  a compact human summary (result counts + top-k names / paths).
- **Depends on.** Nothing.
- **Deferred.** Pagination / `hasMore` (H2) — a separate, larger item for a later slice.

**Entry.** None (parallel).
**Go/no-go.** Protocol round-trip tests must stay green (structuredContent shape unchanged).
**Success.** Measured token reduction per response (target ≈½); the Phase 1 MCP protocol suite passes
unchanged.

### Slice 1 exit criteria (definition of done)

- `code_impact` FN rate measured on ≥2 repos, frozen as `impact-baseline.*.json`, reproducible from a
  single command, and wired as a CI regression gate.
- FP rate reported by confidence tier (diagnostic; not gated in Slice 1).
- BM25 blended into ranking; NL-intent RR up with **no MRR regression** on either repo.
- Response payload de-duplicated; measured token reduction; protocol suite green.
- `ts-morph` confined to `bench/` (a lint/structure check enforces no `src/` import).

**Deliverable.** The instrument that makes graph completion provable, plus two banked wins
(sharper NL ranking, ~half the response tokens).

---

## Reassessment Gate (Slice 1 → Slice 2)

For the first time the project has a real `code_impact` FN/FP number. It answers questions the
baselines could not:

- How badly does `code_impact` actually under-report, per query shape (JSX vs member vs plain call)?
- Where is the FN concentrated — which blind spot (B1/B2/B3) would move it most?
- What is the current false-positive rate in the `name_only` tier (the C2 fallback's real cost)?

**Decision rule.** Re-rank Slice 2 candidates by *(measured FN contribution × cheapness)*. The drawn
order below — JSX + heritage leading — is the hypothesis; if the oracle says a different blind spot
dominates the FN mass, it leads instead. The gate's output is a prioritized Slice 2 plan, which is
when `writing-plans` is next invoked.

---

## Slice 2 — Complete the graph (provisional)

Candidate pool, ranked by the evidence (re-ranked by the oracle at the gate):

- **JSX usage edges (B1)** — treat JSX tag identifiers as ordinary references. Additive, zero-FP,
  ~230 currently-invisible edges on papai.
- **`extends` / `implements` (B3)** — activate the modeled-but-never-produced edge types via
  `class_heritage` extraction. Cheap, additive, zero-FP.
- **Member-call heuristic (B2), honestly scoped** — resolve **only** `this.x()` against the enclosing
  class's member table, plus intra-module receivers whose local type is a known symbol. The
  external-receiver bulk (zod / `db` / `React` — the 89–96%) is **explicitly out of scope**: handed to
  Phase 3 type-aware resolution or accepted as correctly-external. No overselling a heuristic that
  can't touch the mass.
- **Barrels & namespaces (B4/B5)** — walk `export * from` chains; handle `import * as ns`.
- **Suppress the C2 codebase-wide false-positive fallback** — now **gated on the FP number** the
  oracle provides; ship only if it shows a measured FP drop without a matching FN rise.

**Pre-flight (roadmap-mandated).** Reconcile the dead "tier1" scaffolding before building on it:
`module_exports.resolved_file_id` (always NULL), `symbols.is_exported` (written, never read),
`symbols.start/end_byte` (written, never selected), `module_aliases.precedence` (written, never
breaks a tie). Decide keep-or-drop per item.

**Entry gate.** Slice 1 oracle exists; FN baseline frozen.
**Go/no-go (per item).** Member-call and C2-suppression items ship only if the oracle shows the
intended FN drop **and** FP does not cross threshold.
**Success.** Measured FN-rate drop on the oracle (papai + codeindex); no FP regression past threshold;
no MRR regression. With the graph more complete, **in-degree ranking (deferred from Slice 1)** becomes
a viable follow-on.

---

## Slice 3 — Navigation primitives (provisional)

Research 3b. Pure Cheapness wins — agents fall back to whole-file reads because these primitives are
missing.

- **list-symbols-in-file / outline** (impossible today — `query` is mandatory non-empty).
- **list-exports-of-module** (data already in `module_exports`).
- **snippet / source line on `ImpactResult`** (today an agent must issue a second lookup).
- **multi-hop call hierarchy** — recursive, both directions (`findIncomingReferences` is single-hop,
  incoming-only). **Depends on Slice 2** — a call hierarchy over a 57%-incomplete graph is misleading.

**Entry gate.** Slice 2 landed (call hierarchy needs the completed graph).
**Success.** Measured reduction in follow-up round-trips / whole-file reads on the harness; new
primitives covered by protocol round-trip tests.

---

## Handed forward (Phase 3–4 gates, unchanged from the roadmap)

- **Type-aware resolution (2b)** — now *decidable* with the oracle's precision data. Go/no-go: invest
  only if Slice 2's heuristics leave a large measured gap **and** the oracle shows *precision* (not
  recall) is the bottleneck; otherwise ship a memo and stop.
- **Context bundles (3c)** — needs Slice 2 edges + BM25 ranking + compact formatting (all now in
  place after Slices 1–2).
- **Stable identity + kind fidelity (2c)** — sized by the fuzzer's **35.8% orphaning**; gated on that
  churn actually breaking workflows.
- **Semantic / hybrid search (1c)** — gated on Phase 1 query logs showing a real NL miss rate *after*
  BM25 (Unit 2) lands. Strong YAGNI.

---

## Cross-cutting decisions

- **The oracle is a bench instrument, not a resolver.** `ts-morph` lives in `bench/` only. Using a
  type checker to *grade* the cheap resolver is differential testing; it does **not** commit the
  project to Phase 3's type-aware resolution — it produces the exact data that decision needs.
- **In-degree and type-awareness are both sequenced *after* the graph is whole.** Both consume the
  reference graph; running them on a 57%-incomplete graph produces confidently-wrong signals.
- **FP is a diagnostic in Slice 1, a gate in Slice 2.** Its first job is to inform the C2-suppression
  and member-call go/no-go, not to block the instrument's own landing.

## Non-goals (YAGNI — stated so they don't creep in)

- In-degree / centrality ranking in Slice 1 (deferred until the graph is complete).
- The external-receiver member-call mass in Slice 2 (needs a type checker — Phase 3, gated).
- Pagination / `hasMore` in Slice 1 (later slice).
- Adopting `ts-morph` / the TS compiler into `src/` (bench-only; shipped tool stays type-checker-free
  unless Phase 3 explicitly opens that gate).
- Learned-to-rank, API embeddings, HTTP transport, monorepo/multi-language (roadmap Phase 4+).

---

## Next step

On approval: invoke `writing-plans` to produce the implementation plan for **Slice 1 only** (the three
units above). Slices 2–3 are planned when their gates open, against the oracle's real numbers.
