# codeindex — Deep-Research Agenda for the Next Iteration

> The prioritized, forward-looking agenda. Grounded in the inventories (`01`–`03`) and the gaps
> catalog (`04`). Calibrated to: foreground **Retrieval quality + Index accuracy & depth +
> Ergonomics/scenarios**; **in-process deps OK** (TS compiler/LSP, local embedding models
> acceptable if self-contained); **Reach & scale** secondary.

## Context

**What codeindex is.** A standalone Bun tool that builds a symbol-first index of a TS/JS repo
into SQLite and exposes it to AI agents over MCP (`code_search`, `code_symbol`, `code_impact`,
`code_index`). Recently extracted from a monorepo; git history ("tier1 workspace") hints at an
unwritten tiered roadmap.

**Core goal (north star).** Help AI coding agents (and maintainers) retrieve the *right* code
context — **accurately** and **cheaply** — and answer "where is X / who uses X" without reading
whole files. Everything below is measured against that goal, decomposed into four axes:
**Accuracy** (right symbols/edges), **Cheapness** (few tokens & round-trips),
**Freshness/coverage** (complete & current index), **Reach** (languages/repos).

**The gap this agenda targets.** The index is *lexically* strong but *semantically shallow*, and
nothing measures its quality: name-only resolution with a codebase-wide false-positive fallback;
a reference graph that misses JSX / method calls / `extends`-`implements` / barrels (so
`code_impact` under-reports); ranking that ignores in-degree and BM25 magnitude it already has; no
evaluation harness; and a thin, token-heavy agent surface. See `04-gaps-and-opportunities.md` for
the full catalog.

**What this document is.** A *research* agenda — investigations to run, each with a hypothesis, an
evaluation method, benefit/effort/risk, a comparison against alternatives, and the scenarios it
unlocks. It decides *what to learn and build next*, in what order — not yet an implementation plan.

---

## Track 0 (Foundational) — Evaluation & correctness harness

**Thesis.** Directions 1 and 2 both ultimately ask "did this improve retrieval accuracy?" — a
question that is **currently unanswerable**. This track is the single highest-leverage bet because
it converts the rest of the agenda from opinion into measurement, and it gates the two directions
foregrounded most.

**Research questions**
- **Which metric actually matters for an *agent* caller?** Classic IR precision@k / MRR / NDCG vs.
  downstream *task success* (did the agent complete the edit correctly). These diverge; choosing
  wrong invalidates every downstream conclusion. Investigate a small task-success rig alongside a
  labeled relevance set.
- **Build a golden-query corpus** on 2–3 real repos (this repo + one large React/TS app + one
  library): "find symbol", "who uses X", natural-language intents → expected symbols. Establish
  baseline precision@k / MRR for today's ranking.
- **Close the protocol-boundary test gap** — real `Client`/`StdioClientTransport` round-trip tests
  (none exist today; `tests/mcp/*` only shape zod payloads).
- **Property-based edit-sequence fuzzer** (rename/move/delete) asserting `symbol_references`
  integrity, to quantify the multi-hop FK-cascade orphaning gap in `index-codebase.ts`.
- **Indexing throughput/latency benchmark** on a 10k+ file repo — real numbers before optimizing
  (today: no transaction batching; O(references × total-symbols) in-memory resolution scan).

**Benefit** Accuracy ✓✓ (trustworthy) · Freshness ✓. **Effort** M. **Risk** Picking the wrong
success metric. **Files** new `bench/` + `tests/mcp/`. **Deliverable** baseline numbers + a
regression gate every other track measures against.

---

## Direction 1 — Retrieval quality & relevance  *(foregrounded)*

### 1a — Structural ranking upgrade  *(quick win)*
**Thesis.** `rank.ts` is a two-factor heuristic that discards the two best signals it has access
to. Cheap, high-return, measurable once Track 0 exists.
- Blend **normalized BM25** into the composite score (today `matchScore = 0` for *every* FTS hit,
  so scope tier always dominates lexical relevance).
- Add a **symbol in-degree / centrality term** ("used by N callers") — derivable *today* from
  `symbol_references`, never consulted. Investigate simple in-degree vs. PageRank-style weighting.
- Add **kind-awareness** and de-dup within the exact pool (overloads/duplicate declarations
  currently both survive).
- **Compare** against: leaving ranking static (baseline), vs. learned-to-rank (rejected for now —
  needs training data the harness would first have to produce).

**Benefit** Accuracy ✓✓, Cheapness ✓. **Effort** S. **Risk** "improving" an unvalidated metric →
do after/with Track 0. **Files** `src/search/rank.ts`, `src/search/index.ts`.

### 1b — Query understanding & lexical correctness  *(quick win)*
**Thesis.** Several correctness bugs silently suppress good matches; fixing them is nearly free.
- **Case-sensitivity mismatch**: exact tier is BINARY, FTS lowercases — a case-mismatched query
  silently skips the high-scoring exact tier. Research `COLLATE NOCASE` impact.
- **Tokenization**: `identifier_terms` derives from `localName` only and never splits acronym runs
  (`XMLParser`); raw FTS columns keep `snake_case`/`kebab-case` glued via `tokenchars '_-'`.
  Research a code-aware tokenization/term-expansion pass.
- **Activate the dead `prefix='2 3'` indexes** for partial-identifier queries.
- **Typo tolerance**: research SQLite `spellfix1`/edit-distance for `code_symbol`'s exact tier — a
  far cheaper fix than semantic search.
- **Fix the FTS snippet bug** (hardcoded to the usually-empty `doc_text` column).

**Benefit** Accuracy ✓✓. **Effort** S. **Risk** low. **Files** `src/search/fts.ts`,
`src/search/exact.ts`, `src/indexer/extract-symbols.ts`, `src/storage/schema.ts`.

### 1c — Semantic / hybrid retrieval  *(bigger bet — gated)*
**Thesis.** Search is 100% lexical. The honest open question is **whether agent callers hit this
gap often enough to justify the cost** — agents often already query in identifier-shaped terms, so
this risks solving a hypothetical problem.
- **Research-first, build-second**: mine real agent sessions (replay) to measure how often
  exact+FTS return nothing useful for natural-language-shaped queries. **Only proceed if the miss
  rate is real** after 1a/1b land.
- If warranted: **local in-process embedding model** over `signature_text` / `doc_text` /
  `body_text`, stored in a vector table, fused with BM25 (hybrid / reciprocal-rank fusion) and
  structural rank.
- **Compare** approaches against an explicit cost/latency/footprint budget: local model vs. API
  (excluded per "self-contained" preference) vs. *just better tokenization* (1b) which may capture
  most of the benefit for a fraction of the cost.

**Benefit** Accuracy ✓, Reach ✓. **Effort** L. **Risk** cost/latency regression for unproven
benefit (YAGNI). **Files** new `src/search/semantic.ts`, `src/storage/schema.ts`. **Gate** Track 0
query-log evidence + 1b results.

---

## Direction 2 — Index accuracy & depth  *(foregrounded)*

### 2a — Complete the reference graph  *(highest-impact accuracy win)*
**Thesis.** `code_impact`'s core promise ("who uses this") is broken for the patterns that
dominate real TS/React code. Most fixes are **heuristic and cheap** — no type checker required —
and this is likely the best accuracy-per-effort in the whole agenda.
- **JSX usage**: `<Button/>` produces zero edges today. Treat JSX tag identifiers as ordinary
  references.
- **Member/method calls**: `collectCallReference` stores `obj.method`/`this.foo` as opaque text
  that can never match a bare `local_name`. Research resolving `this.x`/member calls against the
  enclosing class's member table.
- **Activate `extends`/`implements`** (already-modeled-but-never-produced edge types) via
  `class_heritage` extraction — likely the single cheapest fidelity win.
- **Barrels & namespaces**: transitively walk `export * from` chains and handle `import * as ns`.
- **Suppress the false-positive fallback**: the "unresolvable specifier → match any same-named
  symbol codebase-wide" branch should prefer *no guess* over a wrong one; study its FP rate.

**Benefit** Accuracy ✓✓✓ (fixes the flagship tool). **Effort** M. **Risk** heuristic member-call
resolution may over-match → measure with Track 0. **Files** `src/indexer/extract-references.ts`,
`src/resolver/resolve-references.ts`.

### 2b — Type-aware resolution  *(big bet — explicit go/no-go)*
**Thesis.** Every resolution is string equality; a `ts.TypeChecker` would raise the ceiling toward
"go-to-definition"-grade. "In-process deps OK" makes this viable, but it may conflict with
codeindex's fast-local-tool identity — treat it as a *measured decision*, not an assumed build.
- Prototype a `ts.Program` / Language-Service resolution pass on the benchmark repos; measure
  precision/recall delta vs. the heuristic resolver (**meaningless without Track 0**).
- Research a **lazy/hybrid** model: keep tree-sitter for fast indexing, invoke type-checking
  **on-demand per `code_impact` query** — measure per-query latency and `ts.Program` construction
  cost.
- **Decision rule**: invest only if 2a's cheap heuristics still leave a large gap *and* the harness
  shows *precision* (not recall) is the bottleneck. Otherwise deliver a recommendation memo and
  stop.

**Benefit** Accuracy ✓✓✓ (enables safe automated refactors). **Effort** L. **Risk** startup/latency
cost vs. tool identity. **Files** new `src/resolver/type-aware.ts`. **Gate** 2a + Track 0.

### 2c — Symbol-kind fidelity & stable identity
**Thesis.** Two structural papercuts undermine agent trust across edit loops.
- **Kind fidelity**: arrow-fn-as-`const` is indexed as `variable_declarator` (this repo: 286 of
  them, 0 `function`/`class`); React components/hooks are indistinguishable; interface/enum members
  aren't extracted as symbols. Research deriving a *semantic* kind (function/component/hook/method)
  instead of the raw tree-sitter node type.
- **Stable identity**: `symbolKey` is byte-offset-based, so any earlier edit churns keys and IDs; a
  caller holding a `symbolKey` across an edit silently gets `[]`. Research a content/AST-shape-hash
  identity that survives unrelated edits — and quantify how often churn actually breaks workflows.

**Benefit** Accuracy ✓, Cheapness ✓ (stable handles across turns). **Effort** M. **Files**
`src/indexer/extract-symbols.ts`, `src/storage/schema.ts`.

---

## Direction 3 — Agent ergonomics & interface  *(foregrounded)*

### 3a — Token economics  *(quick win — directly serves "cheap")*
- **Payload duplication**: every response emits full JSON in *both* `content[0].text` and
  `structuredContent` (~2×). Research whether the text channel is load-bearing for any real MCP
  host, or can shrink to a short summary.
- **Pagination / `hasMore`**: none exists. Research whether agents page or just re-query narrower.
- **Tool-selection cost**: `code_search` vs `code_symbol` overlap and an undocumented, unconstrained
  `kind` vocabulary impose *planning-time* tokens before any response — measure separately;
  consider consolidating/documenting tools.

**Benefit** Cheapness ✓✓✓. **Effort** S. **Files** `src/mcp/tools.ts`, `src/mcp/server.ts`.

### 3b — Navigation primitives
**Thesis.** Agents fall back to reading whole files because the primitives they expect are missing.
- Research adding: **file outline / list-symbols-in-file** (impossible today — `query` is mandatory
  non-empty), **go-to-definition at (file, line, col)**, **list-exports-of-module** (data already in
  `module_exports`), **multi-hop call hierarchy** (`findIncomingReferences` is single-hop,
  incoming-only), **find-implementations** (needs 2a's `extends`/`implements`).
- Add source-line/snippet to `ImpactResult` (today an agent must issue a second lookup).

**Benefit** Cheapness ✓✓ (fewer full-file reads), Accuracy ✓. **Effort** M. **Files** `src/mcp/*`,
`src/search/index.ts`.

### 3c — Task-oriented context bundles
**Thesis.** The most agent-native capability: given a task/symbol and a **token budget**, assemble
"just enough" code context (target + high-confidence callers + type deps), deduped and ranked, in
one call.
- Research budget-aware snippet selection and a single `context_bundle` tool. Builds on 2a (edges),
  1a (ranking), 3a (compact formatting).

**Benefit** Cheapness ✓✓✓, Accuracy ✓✓. **Effort** M. **Gate** 2a + 1a.

### 3d — Onboarding & observability  *(quick win)*
- **Onboarding**: no `init`/scaffold (config must pre-exist or ENOENT), no `--help`. Research a
  zero-config default + `init` command.
- **Observability**: no query telemetry. Research logging queries + hit/miss to *feed* Track 0's
  golden set (a self-improving evaluation loop) and to surface errors as actionable hints.

**Benefit** Adoption, Freshness of eval data. **Effort** S. **Files** `src/cli.ts`,
`src/config.ts`, `src/mcp/server.ts`.

---

## Direction 4 — Reach, freshness & scale  *(secondary — per calibration)*

- **4a Freshness & performance**: file-**watch** mode; mtime/fs-event change detection (incremental
  still hashes *every* file each run); multi-hop invalidation repair (2+-hop refs silently orphan to
  NULL until full reindex); **transaction batching** and **indexed resolution** (replace the
  O(references × total-symbols) in-memory scan) — batching is "measure-and-do", not open research.
  *(Serves Freshness ✓✓, Cheapness ✓.)*
- **4b Monorepo/workspace awareness**: `node_modules` + `package.json` `exports` resolution, TS
  project-reference / `workspaces` auto-discovery, non-wildcard tsconfig `paths` (dropped today),
  per-package partitioning. *(Serves Reach ✓, Accuracy ✓ for cross-package refs.)*
- **4c Multi-language**: tree-sitter grammar plugin mechanism (hardcoded to ts/tsx/js/jsx in
  `parser.ts`); first assess whether the `kind`/schema layer is even language-agnostic-capable.
  *(Lower priority — finishing JSX/TS accuracy in 2a matters more to likely users than a new
  language.)*

---

## Comparison matrix (evaluation of potential benefits)

| Track | Serves (Acc/Cheap/Fresh/Reach) | Effort | Risk / uncertainty | Depends on → Unlocks |
|---|---|---|---|---|
| **0 · Eval & correctness harness** | Acc✓✓ Fresh✓ | M | Wrong success metric invalidates downstream | — → gates 1, 2, 4a |
| **1a · Ranking upgrade** | Acc✓✓ Cheap✓ | S | Tuning an unvalidated metric | 0 |
| **1b · Query understanding/fixes** | Acc✓✓ | S | Low | — |
| **1c · Semantic/hybrid** | Acc✓ Reach✓ | L | YAGNI; cost/latency regression | 0,1b (gate) |
| **2a · Complete the graph** | Acc✓✓✓ | M | Heuristic over-match | 0 → dead-code, in-degree, bundles |
| **2b · Type-aware resolution** | Acc✓✓✓ | L | Startup/latency vs. tool identity | 0,2a (gate) → safe refactor |
| **2c · Kind fidelity & stable IDs** | Acc✓ Cheap✓ | M | Schema/key redesign | → session-delta scenarios |
| **3a · Token economics** | Cheap✓✓✓ | S | Schema API churn | — |
| **3b · Navigation primitives** | Cheap✓✓ Acc✓ | M | Tool-surface bloat | 2a (call-hierarchy) |
| **3c · Context bundles** | Cheap✓✓✓ Acc✓✓ | M | — | 1a,2a,3a |
| **3d · Onboarding/observability** | Adoption, eval data | S | — | → feeds 0 |
| **4a · Freshness/perf** | Fresh✓✓ Cheap✓ | S→L | Identity redesign for deep parts | 0 (fuzzer) |
| **4b · Monorepo** | Reach✓ Acc✓ | M | Audience-dependent | — |
| **4c · Multi-language** | Reach✓ | S→L | Premature horizontal expansion | 2a first |

---

## Recommended sequencing (phased)

- **Phase 1 — Foundation & free wins (parallel, no gates):** **Track 0** (protocol round-trip tests
  + golden-query baseline on 2–3 real repos) · **1b** (case/tokenization/prefix/snippet fixes) ·
  **3a** (payload duplication) · **4a transaction batching** (audit-and-fix). *Establishes
  measurement + banks cheap Accuracy/Cheapness wins.*
- **Phase 2 — Foregrounded high-ROI (informed by Phase 1):** **2a** (complete the graph — the top
  accuracy-per-effort bet) · **1a** (ranking with in-degree + BM25) · **3b** (navigation
  primitives). *Now measurable against the harness.*
- **Phase 3 — Gated big bets:** **2b** type-aware resolution (go/no-go using 2a + harness precision
  data) · **3c** context bundles (needs 2a+1a) · **2c** stable identity (sized by Phase-1 fuzzer
  data).
- **Phase 4 — Conditional / secondary:** **1c** semantic (only if query-log evidence shows a real
  miss rate) · **4b/4c** monorepo & multi-language (strategy-driven, after JSX/TS accuracy is
  solid) · **3d** onboarding as adoption grows.

**Single highest-leverage bet: Track 0.** It is an explicit or implicit dependency for six other
tracks — without it, every accuracy claim here is an informed guess. **Fastest shippable win in
parallel: 3a + 1b.** **Best accuracy-per-effort feature: 2a.**

---

## Additional scenarios the project could expand into

| Scenario | What it enables | Requires |
|---|---|---|
| **Impact-aware code review** | Full blast-radius context on a diff, confidence-weighted | Multi-hop traversal (3b) + confidence surfacing |
| **Dead-code / safe-deletion** | Flag zero-in-degree exported symbols | **2a first** — today zero in-degree often just means "JSX edges missing" (a forcing function for 2a) |
| **Codebase onboarding / architecture Q&A** | "How does auth work here" by walking outward from entry points | **Outgoing**-edge + recursive traversal (`impact.ts` is incoming-only) |
| **Test-impact selection** | Which tests to run for a diff | Index test files (**default config excludes `**/*.test.*`** — the feature needs data defaults throw away) + outgoing multi-hop |
| **Safe automated rename/refactor** | Execute, not just advise | Near-type-checker recall (**2b**) — a missed usage silently breaks the build |
| **Cross-repo / org-wide "go to definition"** | Resolve into published packages | Bare-package resolution (4b) + federated/shared index |
| **Session-scoped delta queries** | "What changed since I last queried" | Stable identity (2c) + an index-generation/snapshot concept |
| **Multi-agent / swarm on one index** | Subagents query while one reindexes | Concurrency research (see risks) + snapshot isolation |

---

## How this improves the main project goals

- **"Right code" (Accuracy):** 2a fixes the graph for real TS/React patterns; 1a/1b sharpen ranking
  with signals already stored; 2b raises the ceiling toward go-to-definition grade; Track 0 makes
  all of it verifiable.
- **"Cheaply" (Cheapness):** 3a halves payload cost; 3b/3c cut whole-file reads by giving agents
  outline/definition/bundle primitives; better top-k (1a) means fewer follow-up round-trips.
- **"Complete & current" (Freshness):** 4a's watch/mtime/invalidation work keeps the index live
  through agent edit loops; 2c stops stale-handle failures.
- **"More repos" (Reach):** 4b/4c and 1c broaden where codeindex is useful — deliberately secondary
  until accuracy is trustworthy.

---

## Cross-cutting risks & blind spots (must inform every track)

- **False negatives in `code_impact` are safety-critical, not cosmetic** — a missed "who calls
  this" is what lets an agent confidently ship a breaking change. Research whether to over-report
  `name_only` matches by default and how to surface confidence.
- **Evaluation methodology is itself a research question** (IR relevance vs. agent task-success) —
  resolve in Track 0 *before* building the harness around the wrong metric.
- **Stale-index / branch-drift / worktree drift has no owner** — nothing records which git
  commit/branch/worktree or `.codeindex.json` an index reflects.
- **Concurrent multi-agent DB access is unstudied** — no `busy_timeout`, fresh connection per call,
  no pooling.
- **Robustness on hostile/huge input** — no file-size guard, unescaped `LIKE` wildcards.
- **Reconcile the implied "tier1" roadmap** — unused `extends`/`implements`/`references` edge types
  and unpopulated `resolved_file_id` look like unfinished scaffolding; confirm there isn't an
  existing plan this agenda should build on.

---

## How to evaluate research outcomes (verification)

The **Track 0 harness is the verification backbone** for the whole agenda:
1. **Baseline, then A/B** every ranking/graph change against the golden-query set (precision@k, MRR)
   on 2–3 real repos; gate merges on no regression.
2. **Protocol round-trip tests** (`Client`/`StdioClientTransport`) verify each new/changed MCP tool
   end-to-end.
3. **Edit-sequence fuzzer** verifies `symbol_references` integrity across rename/move/delete and
   quantifies multi-hop orphaning (sizes 2c/4a).
4. **Indexing benchmark** on a 10k+ file repo tracks throughput/latency/DB-size as perf work lands.
5. **Task-success rig** (stretch) measures whether real agent tasks complete more often/cheaply.
6. Per track, run its own success check (e.g., 2a: measured drop in `code_impact` false-negative
   rate on a labeled React repo; 3a: measured token reduction per response).
