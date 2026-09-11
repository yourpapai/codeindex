# Proposal: Reference graph durability

## Why

Dogfooding broke `code_impact` in real use: 6 of 7 logged impact queries returned nothing while the index held resolved edges for every queried symbol. Root cause: per-file delete+reinsert on incremental and watcher reindexes orphans FK endpoints (`ON DELETE SET NULL`) — 3,071 of 3,821 edges (80%) in the live DB have `target_symbol_id IS NULL` (plus 580 source-side NULLs) — and resolution only runs for newly parsed files, so existing edges are never re-linked. A manual full reindex heals it; ordinary editing silently rots the graph again within a session. `code_impact` is blind exactly during the edit loop it exists for, so agents fall back to grep.

## What Changes

- Post-batch repair pass: after every indexing run (full, incremental, watcher — through the existing serialized reindex scheduler), re-link edges whose `target_symbol_id` went NULL by matching the already-persisted `target_name` (+ `target_file_id` when resolution had bound a file), restoring `resolved` confidence only when the match is unambiguous.
- One-time backfill: the same repair runs at open/startup catch-up, healing existing databases (today's 3,071 orphans) with no wipe-and-rebuild and no schema change.
- Empty `code_impact` responses carry a `guidance` string (text + structuredContent), matching the established `code_search` convention — today agents get a bare `[]` with no hint that the graph may be degraded or that a full reindex heals it.
- No **BREAKING** changes: no schema migration, no request/response shape change beyond the added `guidance`, no `symbolKey` format change.

## Capabilities

### New Capabilities

- `reference-durability`: the durability contract for the reference graph — cross-file edges survive incremental and watcher reindexes; orphaned endpoints are repaired from stored target identity; unresolvable repairs degrade honestly; empty impact results explain themselves.

### Modified Capabilities

(none — `openspec/specs/` has no established capabilities yet; impact/search contracts land as deltas with this and future changes)

## Impact

- **Indexer**: extends `src/indexer/persist-resolved-references.ts` (owns the reference write path) with a repair step; name-matching reuses `src/resolver/resolve-references.ts`; trigger points wired into the serialized scheduler and startup catch-up from `freshness-and-background-reindex`.
- **Storage**: no schema change; repair reads existing `symbol_references.target_name` / `target_file_id` columns.
- **MCP tools**: `code_impact` empty-result `guidance` in both payload forms.
- **CLI**: no surface change; repair rides existing index/reindex/watcher paths.
- **Bench harness**: `impact-baseline.json` gate — repair raises resolved-edge counts on the corpus, so the like-for-like story needs pinning in design.md; `index-baseline.json` must absorb the per-batch repair cost.
- Source-side NULL provenance (580 rows) is investigated in design.md; repair scope for source endpoints is decided there.

## Non-goals

- Stable symbol identity — byte-range `symbol_key` churn across edits (F4) stays; that is agenda item 2c, a separate breaking change.
- Reference-graph completeness — JSX/member-call/heritage extraction (agenda 2a) is separate; this change only makes whatever the graph holds survive.
- Global re-resolution rewrite or resolution-perf work (G2); repair is targeted re-linking, not re-resolution.
- Graph-health metrics in tool responses — declined; if repair keeps orphans near zero, a health signal is an anticipated need, not a present one.
