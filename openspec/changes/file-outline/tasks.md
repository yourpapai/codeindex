## 1. Storage read path (test-first)

- [x] 1.1 RED — add `tests/storage/outline-queries.test.ts`: in-memory DB fixture with (a) mixed local/module/exported/member symbols in one file, (b) pure barrel file (re-export rows, `symbol_id` null, zero local symbols). Assert file-id lookup by exact path; symbols-in-file default excludes `local` and orders by `start_line`; exports-in-file returns re-exports/stars with nullable linkage. Watch fail (queries missing). Verify: `bun test tests/storage/outline-queries.test.ts`
- [x] 1.2 GREEN — implement `selectFileIdByPath` / `selectSymbolsInFile` / `selectModuleExportsInFile` in `src/storage/outline-queries.ts` using existing indexes (`idx_symbols_file_id`, `idx_module_exports_file_id`). Verify: `bun test tests/storage/outline-queries.test.ts && bun run typecheck`

## 2. Search mapper (test-first)

- [x] 2.1 RED — add `tests/search/outline.test.ts`: map storage rows to outline DTOs; symbols default scope filter; exports rows allow `symbolId: null` + `targetModuleSpecifier`; no body/doc fields. Watch fail. Verify: `bun test tests/search/outline.test.ts`
- [x] 2.2 GREEN — implement `src/search/outline.ts` mapper only (no ranking). Verify: `bun test tests/search/outline.test.ts tests/storage/outline-queries.test.ts && bun run typecheck`

## 3. MCP schemas and tool (test-first)

- [x] 3.1 RED — extend `tests/mcp/tools.test.ts` / protocol tests: `CodeOutlineInputSchema` requires `filePath` + `mode`; rejects missing mode; default `limit` 200; max 500. Watch fail. Verify: `bun test tests/mcp/tools.test.ts`
- [x] 3.2 GREEN — add Zod in/out schemas and `codeOutline` on `CodeindexToolDeps` in `src/mcp/tools.ts`. Verify: `bun test tests/mcp/tools.test.ts && bun run typecheck`
- [x] 3.3 RED — protocol round-trip: `code_outline` appears in `listTools`; symbols mode returns ordered compact rows; exports mode on a barrel returns re-exports; unknown path → empty + guidance; text is skim summary; truncation disclosed. Watch fail. Verify: `bun test tests/mcp/protocol.test.ts`
- [x] 3.4 GREEN — register in `src/mcp/server.ts`; wire deps in `src/mcp/runtime.ts`. Verify: `bun test tests/mcp/protocol.test.ts tests/mcp/wiring.test.ts && bun run typecheck`

## 4. Freshness and query-log

- [x] 4.1 RED — freshness decoration on outline hits (`tests/mcp/freshness.test.ts` pattern). Verify: `bun test tests/mcp/freshness.test.ts`
- [x] 4.2 RED — query-log: `tool=code_outline`, `query_text=filePath` (non-null), `mode` = `symbols`|`exports` (`tests/mcp/query-logging.test.ts`). Verify: `bun test tests/mcp/query-logging.test.ts`
- [x] 4.3 GREEN — extend `src/mcp/freshness.ts` and `src/mcp/query-logging.ts` wrappers. Verify: `bun test tests/mcp/freshness.test.ts tests/mcp/query-logging.test.ts && bun run typecheck`

## 5. Description / adoption surface

- [x] 5.1 Tool description states: structure → `mode=symbols`; public API/barrels → `mode=exports`; exact repo-relative path; do not use for ranked name search. Keep description short (W5 is separate). Verify: `bun test tests/mcp/protocol.test.ts && bun run lint`

## 6. Optional CLI ride-along

- [ ] 6.1 OPTIONAL — `codeindex outline <path> [--mode symbols|exports]` thin wrapper over the same storage/search helpers. Skip if time-boxed; not required for capability done. Verify: `bun test tests/cli.test.ts`

## 7. Closeout

- [x] 7.1 Run full check: `bun run check` (includes typecheck, lint, format:check, test, check:bench). Outline is read-only SQL — IR/impact/index baselines must stay flat; do not regenerate baselines to pass.
- [x] 7.2 `openspec validate --strict` on the change; confirm tasks checkboxes match filesystem state before commit.
