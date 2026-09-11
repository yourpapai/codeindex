# 06 — Semantic gate decision (P3-S3)

**Date:** 2026-09-11  
**Status:** Gate closed — semantic route is a **no-go** as a default build  
**Corpus inventory:** [`corpus/semantic-gate-evidence.json`](./corpus/semantic-gate-evidence.json)  
**Reproduce aggregates:** `bun run docs/research/aggregate-query-log.ts <queries.db> ...`

## Decision

**Do not build a default semantic/embedding route for codeindex.**

The P3-S3 gate asked for a miss-rate memo before any embedding work. Two-repo
dogfood (708 real agent queries) does not support that investment as a default
path. The dominant miss is **identity**, not recall-zero lexical failure — and
the primary identity miss is already fixed in this change (`semantic-gate-study`).

Reopen only if the criteria in [Reopen criteria](#reopen-criteria) are met.

## Corpus

| Corpus | Path | Window | Rows |
|---|---|---|---|
| Self (`codeindex`) | `codeindex/.codeindex/queries.db` | 2026-09-09 → 2026-09-10 | 216 |
| papai memory worktree | `papai/.worktrees/memory-vector-graph-research/.codeindex/queries.db` | 2026-07-22 → 2026-07-26 | 247 |
| papai analytics worktree | `papai/.worktrees/analytics-metrics-research-plan/.codeindex/queries.db` | 2026-07-23 | 236 |
| papai codeindex-integration | `papai/.worktrees/codeindex-integration/.codeindex/queries.db` | 2026-09-10 | 9 |
| **Combined** | see inventory JSON | — | **708** |

Full counts, shape mixes, and papai index uniqueness stats live in the
inventory JSON. Historical `query_log` rows predate schema v3, so shape was
derived on the fly with the same deterministic classifier now stored live
(`src/mcp/query-shape.ts`).

## Headline numbers

| Slice | Count | Share |
|---|---|---|
| Combined queries | 708 | 100% |
| Identifier-shaped | 398 | 56% |
| NL-shaped | 253 | 36% |
| Multi-token lexical | 57 | 8% |
| Zero-result rows | 150 | 21% |
| Weak-result rows (`result_count < max(limit, 3)` heuristic) | 375 | 53% |

Self corpus is identifier-dominated (168/216 = 78%). The memory worktree is
NL-heavy on `code_search` (102/173 search rows). That mix difference is
expected (two different agent tasks), not a ranking failure signal by itself.

## Miss taxonomy

### 1. Identity miss (primary, actionable, shipped)

On the self corpus, **44/48 `code_impact` calls zeroed**. Sample zeros are bare
local names and near-canonical forms:

- `openDatabase`
- `src/storage/db#openDatabase`
- `ensureSchema`
- `storage/db.openDatabase`
- `src/storage/schema.ensureSchema`

These are not graph degradation. They are **identity resolution misses**: the
agent asked for a symbol that exists in the index under a form the old
FTS-candidate path refused (or rank-guessed). On papai, **93.8% of exported
symbols have a repo-unique `local_name`** (4,380 / 4,699 exports; 16,465 total
symbols). Bare local names are the form agents actually send.

**Embeddings would not fix this path.** Exact SQL uniqueness does:

- unique `local_name` → resolve (`matchedBy: local_name`)
- ambiguous or unknown → unresolved with guidance to `code_symbol`
- canonical `symbol_key` / `qualified_name` paths unchanged

Shipped in this change (`resolveCanonicalTarget` / `resolveExactCandidate` in
`src/search/index.ts`).

### 2. NL precision (secondary, deferred)

Self `code_search` rarely zeros (6/88). Papai search zeros (34/173 memory,
30/142 analytics) include historical concept queries (`memory`,
`conversation history`, `compaction`) that may resolve on today's index and
are a **precision / top-k quality** problem more than a recall-zero problem.

That is a ranking/precision track, not an embedding track. Telemetry
(`query_shape`, `zero_or_weak`, `mode`, `matched_by` on `query_log` v3) makes
it measurable going forward without wiping the corpus.

### 3. Weak pages without zeros (ambient)

53% of rows are weak under the limit/floor heuristic. Many are intentional
(short candidate lists, tight limits). Treat as a distribution, not a defect
rate; re-read after S1/S2 ranking work.

### 4. Historical zeros vs today's index

Several papai zeros are from July windows against older indexes. They inform
the *shape* of agent traffic, not a live precision score. Forward-looking
telemetry plus a re-mine after ranking changes is the honest measurement path.

## Why semantic is a no-go as default

1. **Identity dominates self impact misses.** Embeddings do not resolve
   `openDatabase` → `src/storage/db#openDatabase`.
2. **Identifier-shaped traffic is majority (56% combined; 78% self).** Lexical
   exact-first already serves that shape well when identity is honest.
3. **NL zeros are concentrated and concept-shaped**, better addressed by
   ranking/precision (in-degree, BM25 magnitude, preview quality — already
   named in research notes) than by a parallel vector index.
4. **Cost.** sqlite-vec + embedding pipeline + eval harness is a large default
   surface for a local developer tool whose agents mostly type identifiers.

RRF fusion (`fuseRankedLists`) already exists as the optional hook if a
semantic route is ever justified later. Do not make it the default path.

## Reopen criteria

Revisit a semantic route **only after** ranking/precision work lands and the
same telemetry still shows poor top-k for NL queries. All of the following:

1. Identifier impact identity is shipping and verified (this change).
2. Ranking/precision improvements (S1/S2 or successor) have landed and are
   measured with `query_log` v3 (`query_shape` / `zero_or_weak` / `matched_by`).
3. Re-mine dogfood (or a larger agent benchmark) shows **persistent NL
   precision gaps** — e.g. top-k still wrong for concept queries — not just
   historical zeros.
4. A staged experiment (RRF secondary list, offline eval) beats lexical-only
   on a frozen NL slice without regressing identifier traffic.

Until then: **no-go**.

## Primary actionable finding

**Local-name impact identity.** Bare local names that are repo-unique must
resolve; ambiguous ones must return unresolved, never a rank-order guess.
That is the accuracy win attached to this memo and is implemented in
`semantic-gate-study`.

## Instrumentation shipped with this decision

| Surface | Change |
|---|---|
| `query_log` schema | v3 in-place: `query_shape`, `zero_or_weak`, `mode`, `matched_by` |
| Classifier | `src/mcp/query-shape.ts` — deterministic, advisory |
| Ride-along logging | `src/mcp/query-logging.ts` records mode (only when caller passed it) and top `matchedBy` |
| Aggregate tool | `docs/research/aggregate-query-log.ts` |
| Impact identity | exact SQL `local_name` uniqueness in `src/search/index.ts` |

History is preserved. Older wrappers leave new columns NULL; the aggregate
script classifies historical rows on the fly for this memo.
