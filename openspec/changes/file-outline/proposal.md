## Why

Agents cannot enumerate a file or a module's public API: `code_search` and `code_symbol` both require a non-empty `query` (`src/mcp/tools.ts`). Gap E1/E4 and backlog **W2** (priority 90, Cheap axis). Without outline/exports, agents read whole files; papai indexes 1,107 files / 5,110 exports, including 11 pure barrels whose local-symbol outline would be empty.

## What Changes

- Add MCP tool **`code_outline`**: given a repo-relative `filePath` and required `mode` (`symbols` | `exports`), return compact structural rows — not ranked search.
  - `symbols`: rows from `symbols` ordered by `start_line`; default `scopeTiers` exclude `local` (44% of papai symbols are locals).
  - `exports`: rows from `module_exports` (not `symbols.export_names`), allowing `symbolId: null` + `targetModuleSpecifier` for re-exports/stars/barrels.
- Exact `files.file_path` identity in v1 (path-boundary prefix later). Reuse freshness decoration, query-log wrapping, `buildStructuredToolResult`.
- Optional CLI ride-along `codeindex outline <path>` — not required for the capability.
- No indexer or schema changes; `module_exports` and parent-linked `symbols` already exist.

## Capabilities

### New Capabilities

- `file-outline`: Navigation primitive for (1) compact in-file symbol structure and (2) a module's export surface from `module_exports`, token-cheap enough to replace whole-file reads on structure questions.

### Modified Capabilities

None. Freshness marks and query-log rows reuse existing contracts by wiring the new tool into existing decorators (`src/mcp/freshness.ts`, `src/mcp/query-logging.ts`); no requirement text changes.

## Impact

- **Surfaces:** MCP tools (`src/mcp/tools.ts`, `src/mcp/server.ts`, `src/mcp/runtime.ts`); new search/storage read path (e.g. `src/storage/queries.ts` + thin `src/search/outline.ts`); freshness + query-logging wrappers; protocol tests. **Not** indexer, storage schema, or ranking.
- **APIs:** fifth MCP tool `code_outline`; `CodeindexToolDeps` gains `codeOutline`.
- **Telemetry:** log `queryText=filePath` and reuse the existing `mode` column — never null `queryText` (that classifies as `empty`).
- **Verification:** `bun test tests/mcp/ tests/search/`, `bun run typecheck`, `bun run lint`; protocol round-trip for the new tool.

## Non-goals

- Making `query` optional on `code_search` / `code_symbol` (search contracts stay search).
- Directory-wide outline, repo map, go-to-definition at (file, line, col), multi-hop call hierarchy, impact snippets (W3), symbol-filter parity on `code_symbol` (W7).
- Module-specifier / bare `./foo` identity; path-boundary-aware prefix; pagination `hasMore` (W16).
- Nested/tree output format; body/doc payloads by default.
- Agent-bench success claims of "fewer Read calls" (L3/L4) — this change defines success as tests + telemetry wiring only (L0–L2).
- CLI `outline` as a required deliverable (optional ride-along only).
