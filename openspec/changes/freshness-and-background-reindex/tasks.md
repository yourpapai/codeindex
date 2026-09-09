# Tasks: Freshness and background reindex

Test-first throughout: every implementation task is preceded by its failing
test (RED → GREEN per test-driven-development). Design reference: D1–D8;
spec references: `specs/index-freshness/spec.md`,
`specs/background-reindex/spec.md`.

## 1. Schema v5 — epoch-ms timestamps + rebuild trigger (D1)

- [x] 1.1 RED — write `tests/storage/schema-v5.test.ts`: opening a v4 DB wipes and recreates all tables at v5; `files.indexed_at` round-trips as INTEGER epoch-ms (both success upsert and `markParseFailure` path); DB stays in WAL mode with `-wal`/`-shm` siblings after migration. Watch it fail.
- [x] 1.2 GREEN — bump `SCHEMA_VERSION` to 5 with a comment recording the deliberate rebuild trigger (identifier_terms drift close-out); switch `indexed_at` writes in `src/storage/queries.ts` (both upserts + `markParseFailure`) to JS-supplied `Date.now()` epoch-ms.
- [x] 1.3 Verify: `bun test tests/storage && bun run typecheck`

## 2. Freshness marks (index-freshness capability, D2/D6)

- [x] 2.1 RED — write `tests/mcp/freshness.test.ts`: per-hit rules (fresh at `indexed_at >= mtimeMs`; hash-equal stays fresh after touch; hash-differ → `possibly_stale`; stat/read failure → `possibly_stale`); response-level `indexFreshness` derived from an injected state provider; assertion that result order, `rankScore`, and match types are byte-identical with freshness on vs off.
- [x] 2.2 GREEN — implement `src/mcp/freshness.ts` `withFreshness(deps, config, stateProvider)`: batch file-row lookup by hit `filePath`, per-hit `stat()`, `sha256` fallback (reuse `src/indexer/resolve-files.ts` `sha256`), no search-layer changes.
- [x] 2.3 RED — extend MCP protocol tests: text payload AND `structuredContent` carry per-result `freshness` and response-level `indexFreshness` for `code_search`, `code_symbol`, `code_impact`; exact-first semantics unchanged (exact matches still precede FTS).
- [x] 2.4 GREEN — add the zod fields to the three output schemas in `src/mcp/tools.ts`; wire `withFreshness` into `buildMcpDeps` (`src/cli.ts`) with a neutral state provider (watcher lands in §4).
- [x] 2.5 Verify: `bun test tests/mcp && bun run typecheck && bun run lint`

## 3. Reindex scheduler — single writer (D4)

- [ ] 3.1 RED — write `tests/mcp/reindex-scheduler.test.ts`: concurrent triggers serialize (one active run); triggers during an active run coalesce into at most one follow-up; follow-up re-derives the incremental set (no stale queued sets).
- [ ] 3.2 GREEN — implement `src/mcp/reindex-scheduler.ts`; route `deps.codeIndex` through it in `src/cli.ts` (agent-triggered `code_index` and future watcher submissions share one queue).
- [ ] 3.3 Verify: `bun test tests/mcp/reindex-scheduler.test.ts && bun run typecheck`

## 4. Watcher — probe, watch, state (background-reindex capability, D3/D7/D8)

- [ ] 4.1 RED — write `tests/mcp/watcher.test.ts` on temp dirs: boot probe dirty/clean/wiped-DB/missing-DB; events outside configured roots/excludes/languages ignored; debounce coalesces an edit burst into exactly one incremental reindex; rename/move/delete sequences converge; failure records error state and next event retries; watcher starts and stops with the server; no daemon introduced.
- [ ] 4.2 GREEN — implement `src/mcp/watcher.ts`: boot probe = `discoverSourceFiles` structure diff + mtime-vs-`indexed_at` scan (no reads, no hashing); `fs.watch(repoRoot, { recursive: true })` filtered by the discover predicates; 300 ms debounce; submit through the scheduler; state `{ status, pendingEvents, lastError, lastCompletedAt }`.
- [ ] 4.3 Verify: `bun test tests/mcp/watcher.test.ts && bun run typecheck`

## 5. Server assembly + `code_index` watcher reporting (D5)

- [ ] 5.1 RED — protocol tests: `code_index` response carries `watcher` (`status`/`pendingEvents`/`lastError`/`lastCompletedAt`) in text + `structuredContent`; a call during an active run reports `catching_up` and joins the queue. Integration test: server boot in a temp-dir repo with dirty index → serves immediately with `indexFreshness: "possibly_stale"` → flips to `fresh` after catch-up completes.
- [ ] 5.2 GREEN — extend `CodeIndexOutputSchema` with the `watcher` object; assemble in `runMcpCommand` (`src/cli.ts`): create scheduler + watcher, feed state into `withFreshness`, wire `deps.codeIndex` to the scheduler.
- [ ] 5.3 Verify: `bun test tests/mcp && bun test tests/cli && bun run typecheck && bun run lint`

## 6. Bench gates + full verification

- [ ] 6.1 Confirm flat gates: `bun run bench:check && bun run bench:impact:check` (IR search + impact baselines byte-flat per D6 — do NOT regenerate to make them pass); regenerate only `bench/index-baseline.json` (schema v5 intent change) and confirm corpus counts match the pre-change baseline exactly.
- [ ] 6.2 Final gate: `bun run check && bun run check:bench`
