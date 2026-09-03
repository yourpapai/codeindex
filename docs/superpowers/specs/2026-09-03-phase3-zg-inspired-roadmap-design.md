# codeindex Phase 3 — zg-Inspired Roadmap (Design)

**Date:** 2026-09-03
**Status:** Approved design. Slices P3-S1–S3 are **firm** scope; P3-S4–S5 are **firm in scope,
refined per-slice** (each still gets its own spec + plan per the standing cadence).
**Precondition:** Phase 2 closes first — Slice 7 (`export *`/`import * as` bridging, C2
FP-fallback suppression, call residue) and Slice 8 (remaining deferral pool) land before this
phase starts.
**Source:** Brainstorm session 2026-09-03, grounded in a source inspection of
[zvec-ai/zvec-grep](https://github.com/zvec-ai/zvec-grep) (`81a80f4`, shallow clone) and a
codeindex state audit (Phase 2 Slices 1–6 complete as of `75ac5fd`; all bench gates green).

---

## Purpose

Phase 2 made codeindex *accurate* (papai value FN rate 0.455 → 0.079, calibrated ranking). Phase 3
makes it *fresh, token-frugal, and live*: the index reports its own staleness, responses stop
paying for bytes agents don't read, indexing keeps up with edit loops without a manual reindex,
and a benchmark rig finally measures the thing the query-level harness cannot — whether agents
actually complete tasks better, cheaper, and faster with codeindex attached.

Everything is borrowed from zvec-grep ("zg") — a local-first ripgrep + BM25 + vector search layer
— which has field-tested each mechanism. zg and codeindex are **complementary, not competing**: zg
owns retrieval *breadth* (many languages, formats, semantic routes); codeindex owns structural
*depth* (symbol graph, impact, resolution confidence). Notably, zg's roadmap direction 2 —
"knowledge-graph construction and graph retrieval" — is codeindex's core competency, and zg has
**no graph implementation today** (breadcrumbs only, `extraction/code/extractor.ts:196`). Phase 3's
posture: deepen the moat, and make it *measured, cheap, and live* before that convergence matters.

### What zg does per mechanism (anchors for the borrowing)

| # | Mechanism | zg implementation (file anchors) |
|---|---|---|
| 1 | Freshness | Per-hit `fresh`/`possibly_stale` via query-time `statSync()` mtime vs stored `indexedTime`, falling back to sha256 compare (`engine/service/zvec-grep.ts:2141-2167`); response-level staleness from watcher/job state only, `fresh` when no drift evidence (`daemon/backend.ts:557-562`) |
| 2 | Query routes | `auto/server/direct` mode router (`client/mode-router.ts`); `--hybrid/--fts/--vector/--rg` routes + `--fuse` group fusion; RRF with `K = 60` (`engine/pipeline/search/index.ts:77,1154`) |
| 3 | Compact output | Agent default `preview: "none"` = single anchor line truncated to 160 chars; `short` = 10-line window; metadata lines elided when the preview already names the symbol (`cli/format/context.ts:624-633,868-898,750-752`); MCP drops heavy structured content to protect context (`mcp/tools.ts:466-508`) |
| 4 | Benchmarks | Paired A/B (baseline vs treatment, everything else constant), blind LLM judge with references outside the agent workspace, judge + input-token + tool-call + wall-time deltas (`benchmarks/README.md:21-118`) |
| 5 | Semantic | 256-dim Model2Vec static embeddings (`local/potion-code-16m-v2`) loaded into a plain typed array, pure-JS mean-pooling, optional SharedArrayBuffer worker pool — no ONNX/Python (`engine/models/backends/model2vec.ts:59-95`); fused with BM25 via RRF |
| 6 | Server | Loopback Streamable HTTP MCP + bearer auth (`timingSafeEqual`), FS watcher debounced + hourly reconcile (watchers silently miss events), refresh modes `background/wait/off` with a `wait_for_fresh` settle→probe→reindex→re-search loop (`daemon/*`, `client/search-policy.ts:13-31`) |

### User-approved decisions (this session)

1. **Sequencing:** Phase 3 starts after Phase 2 Slice 7/8; zg work does not interleave with the
   deferral pool.
2. **Semantic gate (agenda 1c):** stays gated. Phase 3 builds only the *fusion scaffolding*
   (lexical-only) and runs the *miss-rate study* the gate always demanded. Embeddings remain a P4
   candidate contingent on the memo.
3. **Server ambition:** full zg-style server — loopback Streamable HTTP MCP, bearer auth, refresh
   modes, watcher + hourly reconcile. Stdio is never removed; no daemon auto-start.
4. **Output economics:** full zg-style — preview modes with agent-default `none`, metadata
   elision, no field duplicated across text and structured channels.
5. **Benchmark rigor:** a live agent-level paired A/B rig lands in this phase (small pinned task
   set, cost-capped).
6. **Structure:** Approach A "engine first, server last" — dependency-ordered slices; the server
   multiplies everything beneath it, so it lands on a stable, compact, fresh engine.

---

## Guiding principles (zg's guardrails merged with codeindex's values)

1. **Local-first, no hosted service.** Server is loopback-only; stdio remains a first-class
   transport.
2. **Compact context is a feature.** Token cost is a first-class, measured metric — response bytes
   are logged and gated.
3. **Freshness with evidence, not optimism.** Report `possibly_stale` only on observed drift
   (mtime/hash/git); never guess. `fresh` is the default state, conservative only when signals are
   missing.
4. **Measure before building.** The 1c gate pattern extends to the whole phase: the semantic route
   and the task rig both earn their build with evidence.
5. **Structural depth is the moat.** Do not follow zg into formats, languages, GUI, or mobile.
   Every slice below strengthens accuracy, economy, freshness, or measurement of the existing
   symbol-first engine.

---

## Phase map

| Slice | Theme | Borrows | Status |
|---|---|---|---|
| P3-S1 | Freshness + route param + fusion scaffold | zg #1, #2 | firm |
| P3-S2 | Compact output (token economics) | zg #3 | firm |
| P3-S3 | Semantic gate study (parallel with S2) | zg #5 | firm (research) |
| P3-S4 | Task-success benchmark rig | zg #4 | firm in scope, own spec |
| P3-S5 | Server & watcher | zg #6 (+ #1 response-level) | firm in scope, own spec |

Cadence unchanged from Phase 2: per-slice spec → plan → implement → `bun run check` + bench gates
green → `.superpowers/sdd/progress.md` entry.

---

## P3-S1 — Freshness + route param + fusion scaffold

**What.** Three coupled engine changes, no default-behavior change.

### Freshness signals

- **Per-hit, at query time:** `stat()` the hit's file — `indexed_at >= mtimeMs` → `fresh`; on
  mtime mismatch, compare `sha256` against the already-stored content hash → `fresh` if equal;
  file missing or stat fails → `possibly_stale`. Cheap by construction (result sets ≤ `limit`).
  Requires one schema change: a per-file `indexed_at` column (schema v5; today only index-wide
  provenance exists in `index_meta`).
- **Response-level:** compare current git HEAD/branch against the provenance stamp (already
  recorded by `stamp-provenance.ts`). Drift → `indexFreshness: "possibly_stale"` regardless of
  per-hit checks. This finally gives branch/worktree drift an owner (gap catalog §L).
- New zod fields: `freshness: "fresh" | "possibly_stale"` per result; `indexFreshness` per
  response. Protocol tests cover all three per-hit states plus git-drift.

### Route param + fusion scaffold

- `code_search` gains `mode: "auto" | "exact" | "fts" | "fused"`, default `auto` = today's
  exact-pool ∪ FTS behavior (byte-identical results). `exact`/`fts` serve single pools for cheap
  re-queries; `fused` is the explicit name for the current union+rerank path.
- Refactor `src/search/rank.ts`: extract list fusion into a `fuseRankedLists(lists, k = 60)`
  utility (zg's RRF constant) with per-hit `matchedBy` provenance. The calibrated weighted-sum
  behavior for `auto`/`fused` is untouched — RRF exists so a future semantic list is a one-line
  addition (P4).
- Formalize `matchedBy: "exact_local" | "exact_qualified" | "exact_export" | "fts"` replacing the
  ad-hoc `matchReason` string chain (gap A5) while keeping the exact-vs-FTS priority guarantee
  (exact matches can never be overtaken).

**Gates.** All bench baselines unchanged; freshness unit tests (touch → `possibly_stale` →
revert → `fresh`); protocol round-trips for the new fields; `mode` values all exercised.

---

## P3-S2 — Compact output (token economics)

**What.** Reshape the MCP response contract around bytes-per-answer.

- `code_search` gains `preview: "none" | "short" | "full"`, **default `none`**: the `snippet`
  field is replaced by a single anchor line (the match-bearing line from body/signature text,
  truncated ~160 chars). `short` = ~10-line window around the anchor with elision; `full` =
  today's behavior.
- **Metadata elision** (zg's `previewLinesContain`): when the anchor line already contains the
  symbol's local name, the redundant name/kind lines are dropped — emit only what the preview
  doesn't show.
- **Payload contract:** the text channel becomes the compact artifact; `structuredContent` remains
  the authoritative machine payload (protocol tests depend on it). No field is fully duplicated
  across both — this settles gap H1 definitively (verify current duplication state during the
  slice spec; the contract, not the current bug, is the requirement).
- Query log records `response_bytes` (cheap token proxy) so this slice's win and P3-S4's rig share
  one metric.

**Gates.** ≥40% median response-size reduction on bench corpora at default settings; hit-rate and
ranking unchanged; protocol tests for all three preview modes.

---

## P3-S3 — Semantic gate study (research slice, parallel with S2)

**What.** Run the study agenda 1c always demanded, before any embedding code exists.

- **Instrument (ride-along quality, small):** extend the query log with (a) query token-shape
  classification (identifier-shaped vs natural-language), (b) zero/weak-result events
  (`resultCount < limit`), (c) which tier served (`exact`/`fts`), (d) `response_bytes` (shared
  with S2).
- **Study:** after S1+S2 are in daily use, measure the miss rate: what fraction of natural-
  language-shaped queries produce zero/weak lexical results *after* Phase 2's 1a/1b improvements?
- **Known limitation (stated up front):** MCP cannot observe what an agent did with results, so
  "acceptance" is proxied by follow-up query patterns. The task-success rig (S4) is the eventual
  acceptance instrument; this study is the demand instrument.
- **Deliverable: a decision memo** in `docs/research/` — go/no-go for a semantic route, either
  outcome counts as success. If the gate opens: P4 candidate, and zg already proved the shape —
  256-dim static potion-style embeddings in a plain typed array with pure-JS mean-pooling
  (Bun-friendly, no ONNX/Python), fused via the RRF utility from S1, stored via sqlite-vec in the
  existing SQLite database. No new DB engine.

**Scope rule.** This slice produces a memo, not a route. A "go" outcome spawns a P4 spec; it does
not expand Phase 3.

---

## P3-S4 — Task-success benchmark rig

**What.** The agent-level paired A/B harness, borrowing zg's protocol
(`benchmarks/README.md:21-118`).

- **Pinned task set:** 5–10 repository-comprehension questions over 2–3 repos (self, papai, one
  larger OSS TS repo), in zg's case-study taxonomy: *architecture exploration*, *data/control-flow
  tracing*, *design rationale*. Tasks, commits, and reference answers pinned and committed.
- **Paired protocol:** baseline = agent with standard tools (grep/read); treatment = same agent +
  codeindex MCP tools + usage guidance. Held constant: model, reasoning effort, agent framework,
  base prompt, task set, trial count (2–3/task). Index prep excluded from agent wall time.
  Cost cap per task/profile; smoke-verify tool access before each run; guardrail: general-purpose
  prompts, no benchmark-tailored tool rules.
- **Blind judge:** separate LLM judge scores correctness/completeness/relevance against reference
  answers kept outside the agent workspace; it never sees which profile produced an answer.
- **Metrics:** judge delta (treatment − baseline), input-token delta, tool-call delta, wall-time
  delta. The query-level harness (precision@k/MRR) keeps gating merges — this rig measures what
  that cannot.
- Runs stored as reproducible JSON in `bench/`; harness scripts alongside the existing bench
  tooling.

**Gates.** Rig runs end-to-end on the pinned set within the cost cap and produces paired numbers.
This rig becomes the acceptance instrument for P3-S5 and any future semantic route.

---

## P3-S5 — Server & watcher

**What.** Full zg-style serving infrastructure, on the now-stable engine.

- **`codeindex serve`:** loopback-only Streamable HTTP MCP endpoint wrapping the *same* tool
  handlers as stdio — handlers extracted to a shared module (one source of truth; stdio and HTTP
  are transports, not codepaths). Session handling via `mcp-session-id`.
- **Bearer auth:** optional; ≥32-char token via env or token file, `timingSafeEqual` comparison,
  401 + `WWW-Authenticate: Bearer`. Off by default — the local trust boundary is loopback.
- **Watcher:** `fs.watch` on the repo root, debounced + directory-scoped, submits an incremental
  reindex through the existing `reindex` path. The reindex job queue is the **single DB writer**
  (serialized); readers ride WAL (`busy_timeout` landed in Phase 1). Hourly reconciliation timer
  (watchers silently miss events) plus a resume-from-sleep check; reconcile first *probes*
  freshness and no-ops if clean.
- **Refresh modes** on search tools: `refresh: "background" | "wait" | "off"`. `background`
  (default): serve immediately, refresh async, response-level `indexFreshness` reflects watcher
  state (`possibly_stale` only with drift evidence: pending events or an active job).
  `wait`: block on a settle→probe→reindex→re-search loop until fresh. `off`: serve as-is.
- **Stdio unchanged**; no daemon auto-start — transport choice is explicit configuration.
- **Ride-along:** the missing `StdioClientTransport` round-trip tests land here, since both
  transports get exercised together.

**Gates.** Real MCP `Client` round-trips over Streamable HTTP; auth rejection paths; watcher unit
tests on temp dirs (debounce, reconcile no-op when clean); edit-loop fuzzer extension asserting
the index stays fresh across rename/move/delete sequences; stdio regression green.

---

## Phase gates & success criteria

| Slice | Gate |
|---|---|
| P3-S1 | Bench baselines unchanged; freshness unit + protocol tests green |
| P3-S2 | ≥40% median response-size reduction at defaults, hit-rate unchanged |
| P3-S3 | Decision memo published — either outcome counts |
| P3-S4 | Rig runs end-to-end on the pinned set within cost cap; paired numbers produced |
| P3-S5 | HTTP + auth + watcher tests green; stdio regression green; fuzzer stays fresh |

---

## Explicitly out of scope (P4 candidates, not commitments)

- **Semantic route implementation + sqlite-vec** — pending the P3-S3 memo.
- **Daemon auto-start / `auto` mode probing** — transport choice stays explicit.
- **Multi-hop call hierarchy, outgoing edges** — stays agenda 3b (E3), tracked separately.
- **GUI, more formats, more languages, monorepo awareness** — stays agenda 4b/4c. The moat is
  depth, not breadth.

## Risks & notes

- **Interface churn is ordered away, not managed:** slices land before the server exists, so the
  HTTP surface wraps a frozen result contract (S1's freshness + S2's preview fields are schema
  inputs to S5, not outputs of it).
- **Single-writer discipline:** the watcher serializes through the existing reindex path; any
  future parallel writers must revisit WAL concurrency (Phase 1 ride-along covers readers).
- **Rig cost:** live agent runs cost real money — the cost cap and pinned small task set are
  structural, not advisory.
- **Acceptance observability:** MCP cannot see what agents do with results; demand-side logs (S3)
  plus the offline rig (S4) together cover the gap, with the limitation stated in every readout.
