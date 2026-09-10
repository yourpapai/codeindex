# Tasks: compact-output-token-economics

## 1. Preview mapper (failing-test-first)

- [ ] 1.1 Write `tests/mcp/preview-modes.test.ts`: default `preview` is `none` (single-line snippet ≤160 chars, ellipsis when truncated); `short` ≤10 lines with middle elision; `full` passes snippet through; same query's `symbolKey` order and `rankScore` identical across all three previews; exact hits still precede FTS-only hits at `none`. Watch it fail. Verify: `bun test tests/mcp/preview-modes.test.ts` (red)
- [ ] 1.2 Implement `applyPreview` (pure helper next to the MCP result builders — no new package; extend `src/mcp/tools.ts` or a sibling `src/mcp/preview.ts`) and wire `preview: z.enum(['none','short','full']).default('none')` into `CodeSearchInputSchema` and `CodeSymbolInputSchema`. Verify: `bun test tests/mcp/preview-modes.test.ts` (green)
- [ ] 1.3 Confirm ranking/exact-first and `mode` routing unchanged: existing search + protocol tests stay green. Verify: `bun test tests/mcp/ tests/search/ && bun run typecheck`

## 2. Response bytes + query-log migration (failing-test-first)

- [ ] 2.1 Write `tests/mcp/response-bytes.test.ts`: successful `code_search` logs `response_bytes > 0` equal to text+structured UTF-8 size; pre-upgrade `queries.db` rows keep NULL after open; logging failure does not fail the tool call. Watch it fail. Verify: `bun test tests/mcp/response-bytes.test.ts` (red)
- [ ] 2.2 Bump query-log schema to v2 with in-place `ALTER TABLE query_log ADD COLUMN response_bytes INTEGER` (no wipe); extend `QueryLogEntry` / insert path. Verify: `bun test tests/storage/ tests/mcp/response-bytes.test.ts` (green)
- [ ] 2.3 Return `responseBytes` from `buildStructuredToolResult`; add optional `logResponseBytes` dep; supply it from `withQueryLogging` for `code_search` / `code_symbol` / `code_impact`. Verify: `bun test tests/mcp/response-bytes.test.ts && bun run typecheck`

## 3. Channel contract + protocol fixtures

- [ ] 3.1 Update MCP protocol/fixture tests that assumed default full snippets to pin `preview: "full"` or assert the new default explicitly — no weakened ranking assertions. Verify: `bun test tests/mcp/`
- [ ] 3.2 Assert text payload remains a skim summary (top names + count + freshness + guidance) and does not embed full result objects; `structuredContent` remains authoritative. Verify: `bun test tests/mcp/`

## 4. Lint / format / full check

- [ ] 4.1 Lint and format new/changed files. Verify: `bun run lint && bun run format:check`
- [ ] 4.2 Full check with bench gates (search response shape moved; IR/impact/index baselines must stay flat — do not regenerate to pass). Verify: `bun run check`

## 5. Advisory acceptance (A/B vs stamped baseline)

- [ ] 5.1 Run the agent A/B rig and compare input tokens / cost on `who-uses-*` and `explain-*` against the reps=3 stamp committed with this change's scaffold (`913bc90`). Locates must not regress. Record the delta in the change folder or commit message — advisory only, no CI gate. Verify: `bun run bench:agent:baseline`
