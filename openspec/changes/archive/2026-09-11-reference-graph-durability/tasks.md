# Tasks: reference-graph-durability

## 1. Repair core (failing-test-first)

- [x] 1.1 Write `tests/indexer/repair-references.test.ts` with fixture-DB scenarios: orphaned edge with unique same-module name re-links (target_symbol_id + target_file_id restored); ambiguous local name left NULL; specified-but-unmatched module stays NULL; stored confidence preserved on re-match; never-resolved edge gets the same re-match. Run and watch it fail (module does not exist). Verify: `bun test tests/indexer/repair-references.test.ts` (red)
- [x] 1.2 Export `normalizeRelativeModule` from `src/resolver/resolve-references.ts` (no behavior change). Verify: `bun test tests/resolver/ && bun run typecheck`
- [x] 1.3 Implement `src/indexer/repair-references.ts`: re-match NULL-target edges from stored rows (source file → module; `target_module_specifier` → aliases/files → scope; unique `local_name` match binds, zero/multiple stays NULL, confidence untouched). Verify: `bun test tests/indexer/repair-references.test.ts` (green)
- [x] 1.4 Lint and format the new module. Verify: `bun run lint && bun run format:check`

## 2. Indexer wiring (failing-test-first)

- [x] 2.1 Write integration test: build index, simulate orphaning (delete+reinsert a target file's symbols as a reindex does), run incremental reindex, assert `code_impact` returns the edge again and in-degree counts it in the same run. Watch it fail. Verify: `bun test tests/indexer/` (red)
- [x] 2.2 Wire repair into `src/indexer/index-codebase.ts` between `persistResolvedReferences` and `backfillSymbolInDegree`, inside the existing `BEGIN`/`COMMIT`; return repaired-edge count in the summary. Verify: `bun test tests/indexer/` (green)
- [x] 2.3 Test the startup catch-up path heals a pre-upgrade DB with orphaned edges (no schema bump, no wipe). Verify: `bun test tests/mcp/ tests/indexer/`

## 3. Empty-impact guidance (failing-test-first)

- [x] 3.1 Write MCP-level test: `code_impact` with zero results emits `guidance` in text payload AND `structuredContent`; non-empty result has no `guidance` field. Watch it fail. Verify: `bun test tests/mcp/` (red)
- [x] 3.2 Add `guidance` to the impact tool response path (zod schema + emission, mirroring the `code_search` mechanism; static message: verify name via `code_symbol`, full reindex rebuilds the graph). Verify: `bun test tests/mcp/` (green) && `bun run typecheck`

## 4. Durability invariant in the edit fuzzer

- [x] 4.1 Extend `bench/edit-fuzz.ts` with the invariant: after an N-edit sequence through incremental reindexes, edge set and `code_impact` results equal a fresh full reindex's ground truth; report (not assert) barrel-routed divergence for the tier-2 decision. Verify: `bun run bench/edit-fuzz-run.ts`

## 5. Bench gates

- [x] 5.1 Confirm repair cost is absorbed: run the index bench gate and compare against the stamped baseline (regenerate only if repair changes the corpus/intent, never to pass). Verify: `bun run bench:index:check`
- [x] 5.2 Regenerate the three impact baselines as a declared intent change (oracle now measures a repaired graph; rationale in the commit), then confirm gates pass. Verify: `bun run bench:impact:check && bun run bench:impact:fixture:check && bun run bench:impact:papai`

## 6. Full verification

- [x] 6.1 Full check including bench gates (indexing behavior moved, so bench is in scope). Verify: `bun run check`
