# Codeindex

## Purpose

`codeindex` is a standalone Bun project for symbol-first TypeScript/JavaScript indexing and MCP-backed code search. It is local developer tooling for AI agents and maintainers — run it against any repo via the MCP server or CLI.

## Layout

- `src/` — implementation
- `tests/` — bun tests, mirrors `src/`
- `.codeindex.json` — default config when running against this repo itself

## Storage

- The default database path is `.codeindex/index.db` relative to the indexed repo root.
- When the MCP server is invoked from another project, the DB lands at `<that-repo>/.codeindex/index.db`.
- SQLite runs in WAL mode via `openDatabase()`, so expect sibling `-wal` and `-shm` files while the database is open.
- The incoming-reference table is named `symbol_references`, not `references`, because `REFERENCES` is a SQLite keyword.

## Scripts

Run from this directory:

- `bun run test`
- `bun run typecheck`
- `bun run lint`
- `bun run format:check`
- `bun run check` — all of the above in parallel
- `bun run mcp` — start MCP server on stdio
- `bun run start <command>` — CLI entry (index, reindex, stats, etc.)

## MCP Usage

The MCP server is registered globally in `~/.claude.json` and per-project in consumer repos. It always operates on the **caller's `cwd`** (the project Claude Code is opened in), so each repo can have its own `.codeindex.json` and `.codeindex/index.db`.

## Parser Setup

- `web-tree-sitter` bootstraps the parser runtime.
- Grammar wasm files come from `tree-sitter-javascript` and `tree-sitter-typescript`.

## Search Semantics

- `code_symbol` is exact-first: returns exact local-name, qualified-name, and export-name matches before falling back to broader FTS search.
- `code_search` is the exploratory entrypoint and returns a mix of exact and FTS hits ranked by scope tier and match quality.
- Search results include a `rankScore` field reflecting the structural ranking (scope tier + match type).
- Exact-match previews come from stored source text (`body_text` / `signature_text`), not just `qualifiedName`.
- MCP tool responses include `structuredContent` alongside text so hosts can consume results without reparsing JSON.
- Empty `code_search` results include a `guidance` string suggesting next steps.
