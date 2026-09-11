# Proposal: Search route param + matchedBy provenance

## Why

This is the unlanded remainder of P3-S1 (zg-inspired roadmap): freshness shipped via
`freshness-and-background-reindex`, but the route param, RRF fusion scaffold, and
`matchedBy` formalization did not. Today `code_search` behavior cannot be pinned by
callers (the agent A/B rig needs frozen arms), match provenance is a stringly-typed
field that `src/search/rank.ts` parses with `.includes()` to assign the exact-tier
bonus, and path-prefix hits wear an `exact` badge they did not earn.

## What Changes

- `code_search` gains `mode: "auto" | "exact" | "fts" | "fused"`, default `auto` =
  today's exact-pool ∪ FTS union + rerank, byte-identical. `exact`/`fts` serve single
  pools for cheap re-queries; `fused` is the frozen mechanical union the benchmark rig
  pins against (identical to `auto` today, by contract).
- **BREAKING** `matchReason: string` is replaced by
  `matchedBy: "exact_export" | "exact_qualified" | "exact_local" | "path_prefix" | "fts"`
  in the `code_search` / `code_symbol` output schemas (text + structuredContent).
  `rank.ts` consumes the enum directly (500 / 450 / 425 / 0 / 0) instead of string
  sniffing.
- Path-prefix hits (the `file_path LIKE 'query%'` branch) are truthfully labeled
  `path_prefix`. They keep exact-pool membership, dedup priority, and zero score bonus
  — behavior unchanged.
- New `fuseRankedLists(lists, k = 60)` RRF utility in `src/search/rank.ts` — tested but
  uncalled; exists so a future semantic list (P4) is a one-line addition.

## Capabilities

### New Capabilities

- `search-routing`: route selection (`mode`) and truthful per-hit match provenance
  (`matchedBy`) for `code_search`, preserving exact-before-FTS ordering in every mode.

### Modified Capabilities

(none — `openspec/specs/` is empty; no main specs exist yet to modify)

## Impact

- Surfaces: MCP tools (`CodeSearchInputSchema`, `RankedSearchResultSchema`), search
  layer (`src/search/index.ts`, `rank.ts`, `exact.ts`, `fts.ts`), `src/types.ts`.
  No storage, indexer, or CLI changes.
- Bench gates: IR (`bench/baseline.json`) and impact baselines must stay byte-flat —
  `auto` is pinned byte-identical to today; no baseline regeneration.
- Without this change: the A/B rig cannot pin deterministic arms; P3-S3's study cannot
  read which tier served without parsing prose; path hits misreport as `exact`.

## Non-goals

- Query-log ride-along (logging `mode`/`matchedBy`) — deferred to P3-S3
  instrumentation per the frozen phase-3 spec.
- Demoting `path_prefix` hits out of the exact pool — unmeasured behavior change;
  revisit with agenda 3b/E1 (outline primitive).
- Fixing the two latent path-branch defects (LIMIT-before-rank truncation; BM25
  discarded on exact-vs-FTS dedup) — recorded in design.md, not fixed here.
- `confidence` field relabeling on path hits (gap-A4 cousin).
- `mode` on `code_symbol` (its exact-first router is a separate contract).
- Semantic route + sqlite-vec (P4, gated on the S3 memo).
