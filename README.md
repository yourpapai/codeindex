# codeindex

Symbol-first TypeScript/JavaScript indexing and MCP-backed code search for AI agents and maintainers. Instead of grepping text and reading whole files, agents query a local SQLite index of your repo's symbols, exports, and cross-file references — with ranked results and refactor impact analysis in milliseconds.

## Why

Agents that navigate code with grep burn tokens on text noise: comments, strings, substrings, duplicate hits. `codeindex` gives them structured retrieval instead:

- **Symbol-aware** — results carry kind (`function`, `class`, `interface`, …), scope tier (`exported` / `module` / `member` / `local`), qualified name, signature, and body preview from stored source text.
- **Ranked** — every hit has a `rankScore` combining scope tier and match type; `code_symbol` is exact-first (exact local/qualified/export name before FTS fallback).
- **Impact analysis** — `code_impact` returns incoming references for a symbol ("who uses this?"), including JSX usage and `extends`/`implements` edges, with confidence levels.
- **Freshness-honest** — a file watcher triggers incremental reindexes; while a catch-up is in flight, results are marked `possibly_stale` instead of silently served stale.
- **Local & deterministic** — tree-sitter parsing (no type-checker, no `node_modules` install required), no cloud, no embeddings, no API keys.

Resolution is syntactic (name-based with confidence tags), not type-level. For guaranteed-correct navigation (rename through overloads, goto-definition at a position) pair it with an LSP-based tool; they are complementary.

## Quick start

Requires [Bun](https://bun.sh).

```sh
bun run start index      # full index of the current repo
bun run start search createParser
bun run start symbol searchSymbols
bun run start impact searchSymbols
bun run start stats
```

The index lands at `.codeindex/index.db` (SQLite, WAL mode) relative to the repo root. Configure via `.codeindex.json` — see `.codeindex.json.example`:

```json
{
  "roots": ["src", "client"],
  "exclude": ["node_modules", "dist", ".git", "coverage", "**/*.test.*", "**/*.spec.*"],
  "languages": ["ts", "tsx", "js", "jsx"],
  "dbPath": ".codeindex/index.db",
  "indexLocals": true,
  "indexVariables": true,
  "includeDocComments": true,
  "maxStoredBodyLines": 120,
  "tsconfigPaths": ["tsconfig.json"]
}
```

## MCP server

Register per-project (operates on the caller's `cwd`, so each repo keeps its own config and database):

```json
{
  "mcpServers": {
    "codeindex": {
      "command": "bun",
      "args": ["run", "/path/to/codeindex/src/cli.ts", "mcp"]
    }
  }
}
```

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `code_search` | Exploratory search: mix of exact and FTS hits ranked by scope tier; supports `kinds`, `scopeTiers`, `pathPrefix` filters |
| `code_symbol` | Exact-first symbol lookup by local, qualified, or export name |
| `code_impact` | Incoming references for a `symbolKey` or `qualifiedName` |
| `code_index` | Trigger a `full` or `incremental` reindex (serialized with watcher reindexes) |

All tool responses include `structuredContent` alongside text. Empty `code_search` results include a `guidance` string suggesting next steps.

## How it works

1. **Discover** — walk configured roots, honoring excludes and gitignore semantics.
2. **Parse** — tree-sitter (`web-tree-sitter` + TypeScript/JavaScript grammar wasm); incremental mode skips files whose SHA-256 hash is unchanged.
3. **Extract** — symbols (kind, scope tier, signature/body text, export names, identifier terms) and reference candidates, including JSX elements and class heritage.
4. **Resolve** — cross-file reference resolution via module-specifier identity and tsconfig path aliases, tagged with confidence; persisted to `symbol_references` (named so because `REFERENCES` is a SQLite keyword).
5. **Persist** — SQLite with FTS5 (external-content, prefix-indexed, trigger-synced); in-degree backfill for popularity signals; provenance stamped in `index_meta` (git commit/branch, config hash).

Reindexes are serialized through a scheduler; the watcher feeds freshness state into every query response.

## Development

```sh
bun run check              # lint + typecheck + format:check + test + bench checks, in parallel
bun run test
bun run typecheck
bun run lint
bun run format:check
bun run bench              # search benchmarks; see package.json for bench:* variants
bun run start <command>    # CLI: index | reindex | search | symbol | impact | stats | log-stats | mcp
```

- `src/` — implementation; `tests/` mirrors it; `bench/` holds benchmark and fuzz harnesses with baselines.
- Grammar wasm files come from `tree-sitter-javascript` and `tree-sitter-typescript`.
- Research notes, including a self-critical gaps catalog, live in `docs/research/`.

## Limitations

- TypeScript/JavaScript only; Bun runtime required.
- Reference resolution is name-based (no `ts.TypeChecker`), so same-named symbols across scopes can be conflated — confidence tags mitigate, and `code_impact` is best-effort rather than exhaustive.
- Single-hop impact analysis; no recursive call hierarchy or goto-definition-at-position yet.
- Results between an edit and watcher reindex are marked `possibly_stale`; grep is always current by construction.
