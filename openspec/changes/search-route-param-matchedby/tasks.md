# Tasks: Search route param + matchedBy provenance

Test-first throughout: every implementation task is preceded by its failing test
(RED → GREEN per test-driven-development). Design reference: D1–D4; spec:
`specs/search-routing/spec.md`.

## 1. matchedBy — typed provenance replaces matchReason (D1)

- [x] 1.1 RED — rewrite `tests/search/rank.test.ts`: results carry `matchedBy` (enum:
      `exact_export` | `exact_qualified` | `exact_local` | `path_prefix` | `fts`); bonus
      table 500/450/425/0/0 replaces string sniffing; no `matchReason` anywhere. Watch
      it fail. Verify: `bun test tests/search/rank.test.ts`
- [x] 1.2 RED — extend `tests/search/exact.test.ts` and `tests/search/fts.test.ts`:
      exact pool emits per-branch `matchedBy` with export > qualified > local priority,
      path branch emits `path_prefix`, FTS emits `fts`. Watch them fail. Verify:
      `bun test tests/search/exact.test.ts tests/search/fts.test.ts`
- [x] 1.3 GREEN — `src/types.ts`: `matchedBy` union replaces `matchReason` on
      `SearchResult`; `src/search/rank.ts`: `matchScore` consumes the enum;
      `src/search/exact.ts` / `fts.ts`: emit `matchedBy`. Re-run 1.1 + 1.2 → pass.
      Verify: `bun test tests/search && bun run typecheck`
- [x] 1.4 Update remaining non-MCP `matchReason` fixtures (`tests/search/index.test.ts`,
      `tests/search.test.ts`, `tests/types.test.ts`). Verify: `bun test && bun run lint`

## 2. Route mode — pool selection (D3)

- [ ] 2.1 RED — write `tests/search/route-mode.test.ts`: omitted mode ≡ `auto`;
      `exact` serves only exact-family results; `fts` serves only FTS results;
      `fused` is byte-identical to `auto` (results, order, `rankScore`, `matchedBy`);
      exact-before-FTS holds under every mode. Watch it fail. Verify:
      `bun test tests/search/route-mode.test.ts`
- [ ] 2.2 GREEN — `searchSymbols` (`src/search/index.ts`) gains optional `mode`
      (default `auto`); route the pools; `auto`/`fused` share one codepath. Verify:
      `bun test tests/search && bun run typecheck`

## 3. RRF fusion utility — tested, uncalled (D4)

- [ ] 3.1 RED — write `tests/search/fusion.test.ts`: `fuseRankedLists(lists, k = 60)`
      RRF math on fixture lists, per-hit `matchedBy` provenance retained, deterministic
      tie-breaks. Watch it fail. Verify: `bun test tests/search/fusion.test.ts`
- [ ] 3.2 GREEN — implement `fuseRankedLists` in `src/search/rank.ts`; no callers wired
      (auto/fused stay on the weighted-sum). Verify:
      `bun test tests/search/fusion.test.ts && bun run typecheck`

## 4. MCP surface — schema + protocol (D1/D3)

- [ ] 4.1 RED — extend `tests/mcp/tools.test.ts` + protocol tests:
      `CodeSearchInputSchema` accepts `mode` and rejects invalid values at the boundary;
      output schemas carry `matchedBy` (enum) and no `matchReason`, in text payload AND
      `structuredContent`, for `code_search` and `code_symbol`. Watch it fail. Verify:
      `bun test tests/mcp`
- [ ] 4.2 GREEN — `src/mcp/tools.ts`: `mode` on `CodeSearchInputSchema` +
      `CodeindexToolDeps.codeSearch`; `matchedBy` on `RankedSearchResultSchema`; wire
      `mode` through the server/CLI deps. Update MCP fixtures still using
      `matchReason`. Verify: `bun test tests/mcp && bun run typecheck && bun run lint`
- [ ] 4.3 RED→GREEN — `tests/mcp/freshness.test.ts`: invariance assertion (order,
      `rankScore`, provenance identical with freshness marks on vs off) moves from
      `matchReason` to `matchedBy`. Verify: `bun test tests/mcp/freshness.test.ts`

## 5. Bench gates + full verification

- [ ] 5.1 Byte-flat gates, no regeneration: IR repo-local + papai
      (`bench/baseline.json`, `bench/baseline.papai.json`) and impact
      (`bench/impact-baseline.json`, `bench/impact-baseline.papai.json`) pass
      unchanged. Verify: `bun run check:bench`
- [ ] 5.2 Final gate. Verify: `bun run check`
