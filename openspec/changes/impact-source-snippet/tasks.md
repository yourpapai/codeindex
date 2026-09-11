## 1. Extract + candidate lineText (test-first)

- [x] 1.1 RED — extend `tests/extract-references.test.ts` (or sibling): a fixture source with a multi-line call, an import statement, and a >160-char line. Assert each `ReferenceCandidate` carries `lineText`: exact start line for normal calls/imports; clipped with ellipsis at 160 chars; empty string when the line is missing. Watch fail. Verify: `bun test tests/extract-references.test.ts`
- [x] 1.2 GREEN — add `lineText` to `ReferenceCandidate` in `src/indexer/collect-export-candidates.ts`; fill every collector site in `src/indexer/extract-references.ts` from `source.split('\n')` at `lineNumber - 1`, trim end, clip to 160. Verify: `bun test tests/extract-references.test.ts && bun run typecheck`

## 2. Schema v6 + persist (test-first)

- [x] 2.1 RED — storage test: after `ensureSchema`, `symbol_references` has `line_text TEXT NOT NULL` (or equivalent) and `PRAGMA user_version` is 6; inserting a resolved and an unresolved (target null) edge both persist `line_text`. Watch fail. Verify: `bun test tests/storage tests/index-codebase.test.ts`
- [x] 2.2 GREEN — bump `SCHEMA_VERSION` to 6 in `src/storage/schema.ts`; add the column; extend `persistResolvedReferences` INSERT. Verify: `bun test tests/storage tests/index-codebase.test.ts && bun run typecheck`

## 3. Query path + ImpactResult (test-first)

- [x] 3.1 RED — `tests/impact.test.ts`: incoming rows include `snippet` equal to the stored line for calls, type refs, and imports; identity resolution and other fields unchanged; unresolved outcomes still return empty `results`. Watch fail. Verify: `bun test tests/impact.test.ts`
- [x] 3.2 GREEN — add `snippet` to `ImpactResult` in `src/search/impact-types.ts`; SELECT/map `line_text` in `queryIncomingRows` (`src/search/impact-identity.ts`). Verify: `bun test tests/impact.test.ts && bun run typecheck`

## 4. MCP + CLI surface (test-first)

- [x] 4.1 RED — protocol tests: `code_impact` `structuredContent.results[]` each include `snippet`; text payload stays a skim count summary without per-row snippets; no new input fields; identity descriptor unchanged. Watch fail. Verify: `bun test tests/mcp/protocol.test.ts`
- [x] 4.2 GREEN — add `snippet: z.string()` to `ImpactResultSchema` in `src/mcp/tools.ts`; confirm pass-through via `buildStructuredToolResult` and freshness wrapper. Verify: `bun test tests/mcp/protocol.test.ts tests/mcp/freshness.test.ts tests/mcp/response-bytes.test.ts && bun run typecheck`

## 5. Repair keeps stored line

- [x] 5.1 RED — repair integration test: rematching an orphaned reference without re-extract leaves `snippet` as previously stored. Watch fail if persist/repair wipes it. Verify: `bun test tests/indexer/repair-integration.test.ts`
- [x] 5.2 GREEN — confirm repair SQL only remaps target ids; no delete+reinsert of `line_text` without a source re-extract. Verify: `bun test tests/indexer/repair-integration.test.ts && bun run typecheck`

## 6. Closeout

- [x] 6.1 Run full check: `bun run check`. Impact scorer keys on source identity — FN/FP baselines must stay flat; do not regenerate baselines to pass. If `check:bench` fails, investigate shape assumptions before touching `bench/baseline.json`.
- [x] 6.2 `openspec validate --strict` on the change; confirm tasks checkboxes match filesystem state.
