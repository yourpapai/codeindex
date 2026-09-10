# Tasks: impact-identity-resolution

## 1. Resolution semantics in the search layer (failing-test-first)

- [ ] 1.1 Write failing tests in `tests/impact.test.ts` for `resolveIncomingReferences`: canonical `symbol_key` and canonical `qualified_name` inputs resolve with rows identical to `findIncomingReferences`; the qualified-name form sent as `symbolKey` resolves via `qualified_name`; a bare local name sent as `qualifiedName` resolves via `local_name`; a shared local name resolves to the rank-first candidate with the resolved identity echoed; an unknown identity returns `unresolved` with empty rows; `findIncomingReferences` still returns `[]` on a miss (bench/CLI contract). Watch them fail. Verify: `bun test tests/impact.test.ts` (red)
- [ ] 1.2 Implement `resolveIncomingReferences` + `ImpactIdentityResolution`/`ImpactLookupOutcome` in `src/search/index.ts` per design D1–D3 (exact stage of the router only — `runExactSearch` + `rerankSearchResults`, accept `exact_qualified`/`exact_local`; shared incoming-rows helper with `findIncomingReferences`, which stays byte-identical); re-export from `src/impact.ts`. Verify: `bun test tests/impact.test.ts tests/search/ tests/bench/impact-oracle.test.ts` (green)

## 2. MCP contract: deps shape, guidance split, tool description (failing-test-first)

- [ ] 2.1 Write failing tests in `tests/mcp/`: `code_impact` `structuredContent` carries the `identity` descriptor (status/matchedBy/resolved symbolKey+qualifiedName); unresolved input gets guidance that names the accepted forms and suggests `code_symbol` without any reindex advice; found-but-empty keeps the `code_index` advice; tool description documents the accepted identity forms; freshness still decorates rows and query-logging still logs `resultCount`/`topQualifiedNames` from the outcome shape. Watch them fail. Verify: `bun test tests/mcp/` (red)
- [ ] 2.2 Implement: `CodeindexToolDeps.codeImpact` returns `{ resolution, results }` (design D4) and `CodeImpactOutputSchema` gains optional `identity` (D5); update `withFreshness`, `wrapCodeImpact`, `buildMcpDeps`, and `registerImpactTool` (guidance split + description); update stub deps in `tests/mcp.test.ts`, `tests/mcp/harness.ts`, `tests/mcp/server.test.ts`, `tests/mcp/preview-modes.test.ts`, `tests/mcp/response-bytes.test.ts`, `tests/mcp/query-logging.test.ts`, `tests/mcp/protocol.test.ts`, `tests/mcp/freshness.test.ts`. Verify: `bun test tests/mcp/ && bun run typecheck` (green)

## 3. Compatibility + full check

- [ ] 3.1 Confirm canonical-key compatibility: `tests/impact.test.ts`, `tests/cli.test.ts`, `tests/bench/*` green without edits to bench callers; CLI `impact` output shape untouched. Verify: `bun test tests/ tests/bench/impact-oracle.test.ts`
- [ ] 3.2 Lint, format, and full check with bench gates flat (baselines must not be regenerated to pass). Verify: `bun run lint && bun run format:check && bun run check`
