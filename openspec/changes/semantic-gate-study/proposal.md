# Proposal: Semantic gate study (P3-S3) + local-name impact acceptance

## Why

P3-S3 is the only firm Phase 3 slice still open. The gate always demanded a
miss-rate memo before any embedding work. Two-repo dogfood (~708 real agent
queries across `codeindex` and papai worktrees) already inverts the original
thesis: identifier-shaped traffic dominates, `code_search` rarely zeros, and
`code_impact` zeros are identity misses — bare local names like `openDatabase`
still return `unresolved` even after `impact-identity-resolution`, because
FTS candidates are accepted only when `candidate.qualifiedName === input`.
On papai, **0/30** unique exported locals resolve for impact while
`code_search` finds them via `exact_export`. Semantic embeddings would not
fix that path.

## What Changes

- **Query telemetry (`query_log` v3, in-place):** add `query_shape`
  (`identifier` | `multi_token_lexical` | `nl` | `empty`), `zero_or_weak`,
  and ride-along `mode` / `matchedBy` on search. Do **not** wipe history —
  the existing corpus is the study material.
- **Impact local-name acceptance:** replace FTS-based uniqueness with an
  exact SQL `local_name` lookup. Accept a bare local name only when it is
  **repo-unique**; ambiguous names are `unresolved` with candidates/guidance
  (never a rank-order guess). Canonical `symbol_key` / `qualified_name`
  paths stay byte-identical.
- **Study corpus + decision memo:** freeze the two-repo evidence in
  `docs/research/` — semantic route is a **no-go** as a default build;
  identity miss and NL precision (not recall-zero) are the actionable
  findings.

## Capabilities

### New Capabilities

- `query-telemetry`: durable per-query shape/weak-result/mode instrumentation
  and the preserved dogfood corpus the memo is measured against. Extends
  `src/storage/query-log.ts` + `src/mcp/query-logging.ts` (already owns
  `response_bytes`); no new package.

### Modified Capabilities

- `impact-lookup`: bare local-name resolution becomes exact-SQL uniqueness
  (accept iff exactly one `local_name` match). Ambiguous or unknown →
  unresolved. Supersedes the rank-order tie-break and FTS-candidate
  acceptance in `impact-identity-resolution`.

## Impact

- Surfaces: storage (`query_log` v3), MCP (`code_search`/`code_symbol`/
  `code_impact` logging + impact identity), search (`resolveCanonicalTarget`
  in `src/search/index.ts`), docs (memo). No indexer, HTTP, or ranking rewrite.
- Without the identity fix: agents keep burning turns on bare-name impact
  misses (44/48 `code_impact` zeros in the self corpus; 0/30 unique exports
  on papai) and the memo has no shipping accuracy win attached.
- Without instrumentation: the memo cannot be re-run post-S1/S2 and the P4
  gate stays opinion-shaped.

## Non-goals

- Semantic route / embeddings / sqlite-vec — **declined for now**; memo may
  reopen only as a later optional route behind the existing RRF hook.
- Ranking/precision upgrades for NL concept queries — separate change once
  telemetry shows top-k quality gaps.
- Wiping or migrating away dogfood `query_log` history.
- HTTP transport, auth, refresh modes — P3-S5 remainder.
- Expanding the A/B task set / judging — bench-hygiene change.
- Multi-hop call hierarchy / outgoing edges — agenda 3b, not this slice.
