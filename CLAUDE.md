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

The MCP server is registered per-project, not globally. This repo registers it for its own coding agents (`.mcp.json` for Claude Code, `opencode.json` for opencode); consumer repos register it the same way (papai uses a vendored `scripts/codeindex-cli.ts` wrapper). It always operates on the **caller's `cwd`**, so each repo has its own `.codeindex.json` and `.codeindex/index.db`.

### Transports

- **stdio (default):** `bun run mcp` / `codeindex mcp`. Each host process gets its own watcher and writer.
- **loopback HTTP (optional):** `codeindex serve [--port N]` starts a Streamable HTTP MCP endpoint at `http://127.0.0.1:3456/mcp` (default port `3456`, override with `--port`). Multiple MCP hosts pointed at the same URL share one process-level reindex queue, watcher, and freshness state — preferred when several hosts use one worktree. Path is always `/mcp`; non-`/mcp` routes 404.
- **Optional bearer auth (HTTP only):** set `CODEINDEX_TOKEN` (≥32 chars) or `CODEINDEX_TOKEN_FILE` before starting `serve`. Requests must send `Authorization: Bearer <token>`. Stdio ignores these variables.

### Transports

- **stdio (default):** `bun run mcp` / `codeindex mcp`. Each host process gets its own watcher and writer.
- **loopback HTTP (optional):** `codeindex serve [--port N]` starts a Streamable HTTP MCP endpoint at `http://127.0.0.1:3456/mcp` (default port `3456`, override with `--port`). Multiple MCP hosts pointed at the same URL share one process-level reindex queue, watcher, and freshness state — preferred when several hosts use one worktree. Path is always `/mcp`; non-`/mcp` routes 404.
- **Optional bearer auth (HTTP only):** set `CODEINDEX_TOKEN` (≥32 chars) or `CODEINDEX_TOKEN_FILE` before starting `serve`. Requests must send `Authorization: Bearer <token>`. Stdio ignores these variables.

## Dogfooding

Agents working in this repo should prefer `code_search` / `code_symbol` over grep for symbol lookups — registered MCP server first, grep only for non-symbol needs (todos, prose, config). Responses carry freshness marks (`fresh` / `possibly_stale`) and an `indexFreshness` state; while a startup catch-up or edit-triggered watcher reindex is in flight the index is marked stale instead of served silently. Call `code_index` to refresh explicitly (it joins the serialized writer queue with watcher reindexes). For symbol lookups in worktrees, a per-worktree DB starts cold and self-heals via startup catch-up, so the honesty marks apply there too.

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

## Workflow

Planning runs on OpenSpec in this repo: code-behavior work enters through
`/opsx:explore` / `/opsx:propose` and lives under `openspec/changes/<name>/`;
`brainstorming` keeps non-code creative work only. Superpowers skills stay in
force for everything else they own (TDD, verification, debugging, code
review, worktrees, branch finishing). When the harness supports
`obra/superpowers` skills, load `using-superpowers` at session start before
acting; load any other applicable skill before responding, editing, or
running commands.

| Trigger | Route |
| --- | --- |
| "Let's build / add / change X" (code behavior) | `/opsx:explore` or `/opsx:propose` — **not** brainstorming |
| Non-code creative work (docs, process, writing) | brainstorming (unchanged) |
| Bug / test failure | systematic-debugging; if root cause becomes a change, `/opsx:propose` |
| Inside `/opsx:apply` | test-driven-development, verification-before-completion |
| Plan drifted from code | syncing-plan-with-code against `openspec/changes/<name>/` artifacts |
