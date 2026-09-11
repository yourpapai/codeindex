## Context

See `proposal.md` for why (gap E1/E4, backlog W2). Data from dogfood indexes:

- papai: 1,107 files, 16,465 symbols (44% `local`), 5,110 `module_exports` (486 with `symbol_id` null; 11 pure barrels). Densest files are ~300 lines / 65–77 symbols, of which ~60 can be locals.
- react-ui: theme files with 1,400+ symbols — `limit` must be honest; 50-row caps lie.
- codeindex `query_log` v3 already has `mode` and classifies null `query_text` as `empty`.

Existing modules already cover most plumbing: `src/storage/queries.ts` (`selectAllModuleExports`, `clearFileRows` patterns), `src/search/impact-identity.ts` (JOIN `symbols`/`files`), `src/mcp/freshness.ts`, `src/mcp/query-logging.ts`, `src/mcp/preview.ts`, `src/mcp/tools.ts` schemas + `buildStructuredToolResult`. **Do not** fold enumeration into `searchSymbols` / `runExactSearch` (`src/search/index.ts`, `exact.ts`) — those own ranked exact∪FTS contracts (`mode`, `matchedBy`, `rankScore`).

No schema bump: `symbols`, `module_exports`, `files.file_path` UNIQUE, and `idx_module_exports_file_id` / `idx_symbols_file_id` already exist.

## Goals / Non-Goals

**Goals:**

- One MCP tool, two list intents (`symbols` | `exports`), compact rows, freshness + query-log wired.
- Default outline that is usable on dense papai files (exclude `local`).
- Honest barrels via `module_exports`.
- Test-first: storage/query unit tests gate the SQL; protocol tests gate the tool.

**Non-Goals:**

- Query-optional search, ranking changes, multi-hop, go-to-def, directory maps.
- Module-specifier identity; path-boundary prefix (record A6; not inherited).
- Nested tree format; body/doc defaults; pagination `hasMore`.
- Agent-bench L3/L4 claims; required CLI command.
- Storage migration or `SCHEMA_VERSION` bump.

## Decisions

### D1 — Dedicated `code_outline`, not query-optional search

**Choice:** new tool. **Alt:** optional `query` on `code_search` (rejected: pollutes exact-first/rank contracts; archived `matchedBy` design already deferred outline as its own primitive).

### D2 — One tool, required `mode`, no `both`

**Choice:** `mode: "symbols" | "exports"` required. **Alt:** default mode or `both` (rejected: wrong default is pure token waste; `both` pays for both lists when one was wanted). One tool keeps one freshness/log/protocol surface (H4 is a W5 description problem).

### D3 — Identity is exact `filePath`

**Choice:** exact `files.file_path`. **Alt:** path prefix / bare specifier (rejected for v1: A6 naive `startsWith`; specifier resolution is multi-step). Near-miss paths return empty + guidance, never fuzzy file hits.

### D4 — Default `scopeTiers` = exported | module | member

**Choice:** exclude `local` unless requested. Evidence: papai 44% locals; densest file 77→~17 rows. **Alt:** include all tiers (rejected: outline noise worse than a file read).

### D5 — Exports only from `module_exports`

**Choice:** SELECT `module_exports` JOIN `files`; allow `symbol_id` null. **Alt:** `symbols.export_names` (rejected: pure barrels have zero local symbols). Linked `qualifiedName` is an optional JOIN when `symbol_id` is non-null.

### D6 — Compact columns; body off by default

Symbols rows: name, kind, tier, lines, `symbolKey`, `qualifiedName`, `signatureText`, `exportNames`. Exports rows: name, kind, nullable symbol linkage, nullable specifier. No `body_text`/`doc_text`. Reuse skim text + `structuredContent` (`tools.ts` `buildStructuredToolResult`). `preview` is unused in v1 (no snippet field).

### D7 — Default `limit` high; truncation disclosed

**Choice:** default 200, max 500. Text summary MUST say truncated when rows were cut. **Alt:** 50 like search (rejected: react-ui theme files).

### D8 — Logging: `queryText=filePath`, reuse `mode`

**Choice:** wrap in `withQueryLogging` like other tools; put `symbols`/`exports` in existing `mode` column. Never log null `query_text` for a passed call (avoids `empty` shape). **Alt:** null text (rejected: poisons W13 mining).

### D9 — Module placement

- `src/storage/queries.ts`: `selectFileIdByPath`, `selectSymbolsInFile`, `selectModuleExportsInFile` (or equivalent names).
- `src/search/outline.ts`: thin mapper to output DTOs (not a new ranking path).
- `src/mcp/tools.ts` + `server.ts` + `runtime.ts`/`freshness.ts`/`query-logging.ts`: schema, register, deps, decorate.
- CLI: optional thin `outline` command only if a later task wants dogfood; not gated.

Search semantics impact: **none** — no change to scope-tier ranking, `matchedBy`, or search MCP payloads. Outline is enumeration by file id.

## Risks / Trade-offs

- [Outline still noisy if `indexVariables` floods module-scope consts] → `kinds` filter param exists; default keeps non-local kinds for honesty.
- [Truncation hides tail symbols] → disclosed in text; `hasMore` deferred to W16; agents can raise `limit` or filter kinds.
- [Exact path friction (wrong relative root)] → guidance on empty; freshness/watcher already use relative paths from search hits.
- [Fifth tool adds planning tokens] → force-path descriptions (W5); do not merge into search.
- [Barrel star rows have no `exportName` list expansion] → star row stays one row (`export_kind=star`, specifier); expanding `export *` is resolver work, not W2.

## Migration Plan

None for storage. Existing `.codeindex/index.db` files work as-is. Deploy = ship MCP registration + tests. Rollback = remove tool registration; no data migration.

## Open Questions

- Whether papai dogfood should enable `logQueries` in the same PR as the tool (ops, not spec).
- Exact Zod field names for export rows (`symbolId` vs nested object) — settle in tests; does not change requirement text.
