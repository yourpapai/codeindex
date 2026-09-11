# Tasks: Semantic gate study + local-name impact acceptance

## 1. Impact local-name uniqueness (test-first)

- [x] 1.1 Write failing tests in `tests/search/impact-identity.test.ts` (or extend the existing impact-identity suite): repo-unique bare local name resolves; ambiguous bare local name is unresolved with no rank-order guess; unknown identity stays unresolved; exact `symbol_key` / `qualified_name` paths remain byte-identical. Verify: `bun test tests/search/impact-identity.test.ts` (red)
- [x] 1.2 Replace FTS-candidate local-name acceptance in `resolveCanonicalTarget` (`src/search/index.ts`) with exact SQL `local_name` lookup: unique → accept (`matchedBy: local_name`); 0 or >1 → unresolved. Leave canonical branches untouched. Verify: `bun test tests/search/impact-identity.test.ts` (green)
- [x] 1.3 Update `code_impact` tool description and unresolved guidance to state repo-unique local names and ambiguity behavior. Verify: `bun test tests/mcp` and focused description/guidance assertions
- [x] 1.4 Confirm impact benches/CLI: run `bun run bench:impact:check` (and papai/fixture variants if locally configured) without regenerating baselines; confirm only non-canonical bare-local behavior changed. Verify: `bun run bench:impact:check && bun run bench:impact:fixture:check`

## 2. Query log v3 telemetry (test-first)

- [x] 2.1 Write failing tests for schema v3 in `tests/storage/query-log.test.ts` (or successor): in-place bump preserves existing rows; new columns present; fresh DB has full schema. Verify: `bun test tests/storage/query-log.test.ts` (red)
- [x] 2.2 Implement additive migration in `src/storage/query-log.ts`: `query_shape`, `zero_or_weak`, `mode`, `matched_by`; bump `QUERY_LOG_SCHEMA_VERSION`; never wipe history. Verify: `bun test tests/storage/query-log.test.ts` (green)
- [x] 2.3 Write failing classifier tests (`identifier` / `multi_token_lexical` / `nl` / `empty`) for a pure helper beside query logging. Verify: `bun test tests/mcp/query-logging.test.ts` (red for classifier cases)
- [x] 2.4 Implement deterministic classifier + weak-result flag derivation (`result_count` vs limit/floor). Verify: `bun test tests/mcp/query-logging.test.ts` (green)
- [x] 2.5 Ride-along logging: record `mode` when the caller passed it; record top/dominant `matchedBy` when results carry provenance; log write failures stay non-fatal. Verify: `bun test tests/mcp/query-logging.test.ts tests/mcp/server.test.ts`

## 3. Study corpus freeze + decision memo

- [x] 3.1 Add a small offline aggregate script or documented SQL (under `docs/research/` or `bench/`) that computes tool × shape × zero/weak counts from a `queries.db` path. Verify: script runs against `.codeindex/queries.db` and prints totals matching known counts (~216 self)
- [x] 3.2 Freeze two-repo evidence snapshot (self + papai worktree paths, counts, date ranges) as a committed JSON/markdown inventory next to the memo. Verify: file exists and cites real paths/counts from this session’s mining
- [x] 3.3 Write `docs/research/06-semantic-gate-decision.md`: miss taxonomy, semantic **no-go** as default route, reopen criteria (precision gaps after ranking work + still-poor top-k), primary actionable finding = local-name impact identity. Verify: memo exists, links corpus inventory, states go/no-go explicitly
- [x] 3.4 Cross-link memo from `docs/research/README.md` or agenda pointer if that index exists. Verify: `rg semantic-gate docs/research`

## 4. Gate

- [x] 4.1 Run full `bun run check` (lint, typecheck, format:check, test, check:bench). Fix fallout; do not re-stamp baselines to silence failures. Verify: `bun run check` exits 0
