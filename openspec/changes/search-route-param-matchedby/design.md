# Design: Search route param + matchedBy provenance

## Context

`code_search` runs `searchSymbols` (`src/search/index.ts`): exact pool (`runExactSearch`)
∪ FTS pool (`runFtsSearch`), deduped by `symbolKey` with the exact row surviving, then
`rerankSearchResults` (`src/search/rank.ts`). Provenance is a free-form `matchReason`
string (`src/types.ts:28`) that `rank.ts` parses with `.includes()` to assign the
exact-tier bonus (export 500 / qualified 450 / local 425) — the string channel is
load-bearing for ranking. The exact pool's file-path branch (`exact.ts:118`) emits
`matchReason: 'exact file_path'` with a zero bonus and `confidence: 'exact'`.

The frozen P3-S1 spec's enum omitted path-prefix hits; the exploration decided the
truthful label is `path_prefix` (not `exact_file_path`). See proposal.md for scope; the
spec requirements are the contract this design implements.

## Goals / Non-Goals

**Goals**

- Typed provenance: `rank.ts` consumes a `matchedBy` enum, no string sniffing.
- Route param with `auto` byte-identical to today; `fused` frozen for benchmark arms.
- RRF fusion utility (`fuseRankedLists(lists, k = 60)`) tested and ready for P4's
  semantic list.

**Non-Goals** (see proposal.md Non-goals for scope-level exclusions; design-level:)

- No change to `findSymbolCandidates` / `code_symbol` routing (it keeps its exact-first
  contract and continues to use the exact pool including path hits).
- No fix for the latent defects below — recorded so they are not rediscovered.
- No query-log schema extension (P3-S3 instrumentation decides `mode`/`matchedBy`
  logging; `queries.db` `user_version` machinery already exists when needed).

## Decisions

### D1 — Replace `matchReason`, don't dual-field

`matchReason: string` is removed from `SearchResult` (`src/types.ts`) and both output
schemas (`RankedSearchResultSchema` in `src/mcp/tools.ts`); `matchedBy` enum takes its
place. Runtime consumers are exactly three: producers (`exact.ts`, `fts.ts`), the
scoring consumer (`rank.ts`), and the zod schema. Bench baselines serialize only
aggregate metrics (`k`, `meanPrecisionAtK`, `meanRecallAtK`, `mrr`) — never
`matchReason` strings — so the rename cannot move baseline bytes. Tests dominate the
remaining references (~6 test files). A transition field was rejected: two provenance
channels in one protocol diff is worse for consumers than one clean break, and the only
MCP consumers are agents reading fresh schemas each session.

**Enum + score table** (replaces `matchScore()` string sniffing in `rank.ts`):

| `matchedBy`         | bonus |
|---------------------|-------|
| `exact_export`      | 500   |
| `exact_qualified`   | 450   |
| `exact_local`       | 425   |
| `path_prefix`       | 0     |
| `fts`               | 0     |

Priority within the exact pool stays: export > qualified > local (a symbol whose export
name and local name both equal the query reports `exact_export`).

### D2 — `path_prefix` relabels in place (Option A of the exploration)

Path-prefix hits keep exact-pool membership, dedup priority, and zero bonus; only the
label changes. Alternatives rejected:

- **Dissolve the branch (B):** code_symbol path queries would fall through to FTS (real
  behavior change in a documented contract), and the de-facto outline use case degrades
  from prefix-precise to token-fuzzy — both unmeasured (the golden corpus has zero
  path-shaped queries, so the IR gate is silent either way).
- **Real third pool (C):** the honest E1/3b outline primitive, but scope creep for an
  S-sized slice; recorded as a P4 candidate.

### D3 — `mode` selects pools; `matchedBy` tells the truth

`mode: "exact"` serves the exact pool *as it exists* — including `path_prefix` members.
The pool name is legacy; agents who want name-exact only filter on `matchedBy`.
Redefining `exact` as name-matches-only would break the spec's "single pools" framing
and complicate the `auto`-is-byte-identical pin for no baseline benefit. Plumbing:
`CodeSearchInputSchema` + `CodeindexToolDeps.codeSearch` gain the param; `searchSymbols`
gains an optional `mode` (default `auto`); `fused` and `auto` share one codepath today —
the distinction is contractual, not behavioral. `code_symbol` is untouched.

### D4 — RRF utility lives in `rank.ts`, uncalled

`fuseRankedLists(lists, k = 60)` with per-hit `matchedBy` provenance is tested but has
no caller — `auto`/`fused` stay on the weighted-sum. This follows the frozen spec
("RRF exists so a future semantic list is a one-line addition"). It must never replace
the exact∪FTS fusion: RRF interleaves lists and would violate exact-before-FTS. New
module rejected — the need is a ranking concern; `rank.ts` already owns list shaping.

## Latent defects recorded, not fixed

1. **LIMIT-before-rank on the path branch** — `loadExactResults` ends
   `GROUP BY symbols.id LIMIT ?` with no `ORDER BY`; name-exact queries rarely exceed
   the limit, path queries ("src") truncate arbitrarily before rerank. Only visible via
   path queries; fixing it changes `auto` output (baseline-relevant) — belongs with
   Option C / E1 work.
2. **BM25 discarded on path-vs-FTS dedup** — when a symbol matches both by path and
   FTS, the exact-pool row survives and drops the FTS twin's `relevance` (exact rows
   carry none), degrading within-tier order for those symbols. Same baseline story.
3. **`confidence: 'exact'` on path hits** — cousin of gap A4 (FTS claiming
   `resolved`). Untouched to keep one semantic field change per protocol diff; revisit
   in the token-economics or confidence pass.

## Impact on search semantics and MCP responses

- `rankScore`, ordering, scope tiers, match-tier selection: byte-identical for `auto`
  (the bonus table reproduces current `matchScore` exactly).
- Text payload and `structuredContent` both move `matchReason` → `matchedBy` and gain
  `mode` echo behavior defined by the spec; freshness marks (`freshness`,
  `indexFreshness`, `watcher`) are orthogonal and unaffected — the existing
  freshness-invariance test (order/`rankScore`/provenance identical with marks on vs
  off) is updated to assert on `matchedBy`.

## Bench gates — like-for-like story

- IR oracle: `bench/baseline.json` (repo-local) and `bench/baseline.papai.json` must
  pass byte-flat — `auto` is pinned identical, and the harness never reads provenance
  strings. No regeneration permitted.
- Impact oracle: `bench/impact-baseline.json` / `.papai.json` — unaffected (no graph
  changes); must pass byte-flat.
- Index baseline: untouched (no storage or indexer changes).

## Test-first interactions

Failing-test-first order gates these files (RED before each GREEN step):

- `tests/search/rank.test.ts` — enum-driven bonus table (existing string-sniff tests
  rewritten first).
- `tests/search/exact.test.ts`, `tests/search/fts.test.ts` — `matchedBy` production per
  branch, path_prefix labeling.
- `tests/search/route-mode.test.ts` (new) — pool selection per mode, `fused ≡ auto`
  byte-identity, exact-before-FTS under every mode.
- `tests/search/fusion.test.ts` (new) — `fuseRankedLists` RRF math (k=60), provenance
  retention, deterministic tie-breaks.
- `tests/mcp/tools.test.ts` + protocol tests — `mode` accepted/rejected at the boundary;
  text + `structuredContent` carry `matchedBy` and no `matchReason`.
- `tests/mcp/freshness.test.ts` — invariance assertion updated from `matchReason` to
  `matchedBy`.

## Migration Plan

No storage or data migration. Single-PR landing: schema change + search layer + tests
together, since the protocol break leaves no compatible intermediate. Rollback is
`git revert` — no persisted state references `matchedBy`. Consumers (agents) re-read
schemas per session; the text-payload shape change is the only external surface.

## Open Questions

None blocking. Deferred by design: whether `matchedBy` becomes a set when future
fused lists overlap (single value matches today's dedup semantics); when RRF gains its
first caller (P4 semantic route); whether S3's instrumentation rides a
`QUERY_LOG_SCHEMA_VERSION` bump.
