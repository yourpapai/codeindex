# Inventory 03 — MCP / CLI / Config / Testing Surface

Detailed technical inventory of the user-facing surface: `src/mcp/server.ts`, `src/mcp/tools.ts`,
`src/mcp.ts`, `src/cli.ts`, `src/config.ts`, `src/search.ts`, the `tests/` tree,
`.codeindex.json`(`.example`), `tsconfig.json`, and `.oxlintrc.json`.

---

## 1. MCP surface

**Wiring.** `createCodeindexServer(deps)` (`src/mcp/server.ts:89-96`) builds a
`new McpServer({ name: 'codeindex', version: '0.1.0' })` and registers exactly **4 tools**:
`code_search`, `code_symbol`, `code_impact`, `code_index` (`server.ts:91-94`). It is invoked
once, at process start, from `runMcpCommand` (`src/cli.ts:86-91`), which connects a
`StdioServerTransport` only — there is no HTTP/SSE transport option anywhere in the code.
`main()`'s `mcp` case (`cli.ts:116-118`) is reached via `bun run src/cli.ts mcp` / the `mcp`
package.json script (`package.json:13`).

**cwd/repo resolution.** `resolveRepoRoot(targetPath?)` (`cli.ts:12-15`) defaults to
`process.cwd()`. `main()` calls `loadConfigForPath()` with **no argument** once, before the
command switch (`cli.ts:95`), so the entire MCP server (and every CLI command) is bound to
whatever the process's cwd was at launch — matching `CLAUDE.md:34` ("always operates on the
caller's cwd"). This binding happens **once at process start**, not per MCP request: none of
`CodeSearchInputSchema`, `CodeSymbolInputSchema`, `CodeImpactInputSchema` has a path/cwd field
(`src/mcp/tools.ts:27-51`), so an agent cannot repoint `code_search`/`code_symbol`/`code_impact`
at a different repo without restarting the server process.

**`code_index` is wired inconsistently with the other three tools.** In `buildMcpDeps`
(`cli.ts:65-84`): `codeSearch`, `codeSymbol`, `codeImpact` all close over the single
startup-time `config` via `withDatabase(config, ...)` (`cli.ts:66-73`). But `codeIndex` ignores
that captured `config` and instead calls `loadConfigForPath(targetPath)` to build a fresh
`targetConfig` from the caller-supplied `path` (`cli.ts:74-83`). **Consequence:** calling
`code_index` with a `path` different from the server's own cwd indexes a *different* database
than the one `code_search`/`code_symbol`/`code_impact` will keep querying — those three never
see the reindex.

> **Update (2026-07-21):** This bug has since been fixed. `code_index`'s `path` parameter was
> removed; it now indexes the server-bound repo (the closed-over startup `config`) exactly like
> the other three tools, matching `CLAUDE.md`'s "always operates on the caller's cwd" contract.
> Guarded by the end-to-end `tests/mcp/wiring.test.ts` (commit `959136a`). The tool-by-tool table
> below reflects the pre-fix state as of the research date.

**Tool-by-tool detail:**

| Tool | Registration | Input schema | Output schema | Deps call |
|---|---|---|---|---|
| `code_search` | `server.ts:20-42`, desc "Search indexed symbols" | `tools.ts:27-33`: `query` (required, min 1), `limit` (int 1-50, default 10), `kinds?` (string[]), `scopeTiers?` (enum `'exported'\|'module'\|'member'\|'local'`[]), `pathPrefix?` | `tools.ts:75-80`: `{query, resultCount, results: RankedSearchResult[], guidance?}` | `deps.codeSearch` → `searchSymbols` |
| `code_symbol` | `server.ts:44-57`, desc "Resolve a query to candidate symbols" | `tools.ts:36-39`: **only** `query` + `limit` (max 50, default 10) — no `kinds`/`scopeTiers`/`pathPrefix` (asymmetric with `code_search`) | `tools.ts:82-84`: `{results: RankedSearchResult[]}` — no `guidance` field exists in the schema at all | `deps.codeSymbol` → `findSymbolCandidates` |
| `code_impact` | `server.ts:59-72`, desc "Find incoming references for a symbol" | `tools.ts:42-51`: `symbolKey?`, `qualifiedName?` (zod `.refine` requires at least one), `limit` (max 100, default 20) | `tools.ts:94-96`: `{results: ImpactResult[]}` — no `guidance` field | `deps.codeImpact` → `findIncomingReferences` |
| `code_index` | `server.ts:74-87`, desc "Run full or incremental indexing" | `tools.ts:53-56`: `path` (required, min 1), `mode` (enum `full\|incremental`, default `incremental`) | `tools.ts:98-106`: `{filesIndexed, filesFailed, filesPruned, symbolsIndexed, referencesIndexed, referencesUnresolved, elapsedMs}` | `deps.codeIndex` → `indexCodebase` |

**`RankedSearchResultSchema`** (`tools.ts:59-73`): `symbolKey, qualifiedName, localName, kind,
scopeTier, filePath, startLine, endLine, exportNames[], matchReason, confidence, snippet,
rankScore`.

**`ImpactResultSchema`** (`tools.ts:86-92`): `sourceQualifiedName (nullable), sourceFilePath,
edgeType, confidence, lineNumber` — notably **no `snippet`/source-line text**, unlike search
results.

**Output shape / structuredContent.** `buildStructuredToolResult(schema, output)`
(`tools.ts:108-117`) zod-parses the output and returns
`{ content: [{ type: 'text', text: JSON.stringify(parsed) }], structuredContent: parsed }` —
every response is emitted twice (stringified text channel + structured channel), per
`CLAUDE.md:47`.

**Empty-result guidance.** Only `registerSearchTool` computes it:
`results.length === 0 ? 'No symbol matches. Retry with broader terms, relax scopeTiers, or use
code_symbol when you know the exact name.' : undefined` (`server.ts:30-33`). `code_symbol` and
`code_impact` never produce guidance — and structurally can't, since their output schemas don't
declare the field (`tools.ts:82-96`).

**Error surfacing.** codeindex itself has **no try/catch** in any tool handler
(`server.ts:28-86`). Errors (e.g., `findIncomingReferences` throwing `'Either symbolKey or
qualifiedName is required'` at `src/search/index.ts:45`, zod input-validation failures, raw
SQLite errors) propagate up to the `@modelcontextprotocol/sdk`'s generic handler, which catches
everything and returns `{ content: [{ type: 'text', text: errorMessage }], isError: true }`
(`node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:135-141,152-161`). There is no
codeindex-specific error formatting, recovery hinting, or error codes — the agent only ever sees
the raw `error.message` string.

---

## 2. CLI surface

Entry point `src/cli.ts:93-127`. Invoked as `bun run src/cli.ts <command> <arg>` (`package.json`
has **no `bin` field**, so there is no globally installed executable — only `start`/`mcp`
scripts, `package.json:12-13`). Argument parsing is purely positional:
`const [, , command = 'index', rawArg] = process.argv` (`cli.ts:94`) — **no named flags at all**
(no `--limit`, `--json`, `--root`, `--help`). `loadConfigForPath()` (no arg) runs
unconditionally before the switch (`cli.ts:95`), so every command — including `mcp`/`stats` —
fails immediately if `.codeindex.json` is missing/invalid in cwd.

| Command | Code | Behavior |
|---|---|---|
| `index` (default) | `cli.ts:98-100` | `indexCodebase({config, mode:'full'})`, prints `IndexSummary` via `logJson` (`cli.ts:34-36`, `JSON.stringify(value, null, 2)`) |
| `reindex` | `cli.ts:101-103` | `indexCodebase({config, mode:'incremental'})` |
| `search <query>` | `cli.ts:104-106` → `runSearchCommand` (`cli.ts:38-40`) | `searchSymbols(db, {query, limit: 10})` — **limit hardcoded to 10**, not CLI-configurable |
| `symbol <query>` | `cli.ts:107-109` → `runSymbolCommand` (`cli.ts:42-44`) | `findSymbolCandidates(db, query, 10)` — hardcoded limit 10 |
| `impact <qualifiedName>` | `cli.ts:110-112` → `runImpactCommand` (`cli.ts:46-48`) | `findIncomingReferences(db, {qualifiedName, limit: 20})` — **only accepts `qualifiedName`**, no CLI way to pass `symbolKey` (the MCP tool accepts either) |
| `stats` | `cli.ts:113-115` → `runStatsCommand` (`cli.ts:50-63`) | Raw SQL: `COUNT(*)` of `files WHERE parse_status='indexed'`, `symbols`, `symbol_references`. Does not report `filesFailed`/`filesPruned`. |
| `mcp` | `cli.ts:116-118` → `runMcpCommand` (`cli.ts:86-91`) | Starts stdio MCP server; logs `'codeindex MCP server listening on stdio'` to stderr (`cli.ts:90`) |
| anything else | `cli.ts:119-120` | `throw new Error('Unknown command: ' + command)` — no usage/help text printed anywhere |

Global error handler (`cli.ts:124-127`): prints `error.message` (or `String(error)`) to stderr,
`process.exit(1)` — no stack trace, no `--verbose`/debug flag exists anywhere in `src/`.

---

## 3. Config (`.codeindex.json`)

Schema: `CodeindexConfigSchema` (`src/config.ts:6-18`), zod-validated, all keys optional with
defaults, so `{}` is a valid file — but the **file itself must exist**: `loadCodeindexConfig`
(`config.ts:35-53`) unconditionally `readFile`s the path (`config.ts:39`) and throws `ENOENT` if
absent, with no fallback-to-defaults and no `init`/scaffold CLI command. A consumer must manually
copy `.codeindex.json.example` → `.codeindex.json`.

| Key | Default (`config.ts` line) | Effect |
|---|---|---|
| `roots` | `['src']` (`config.ts:7`) | Dirs walked by `discoverSourceFiles` (`src/indexer/discover.ts:62-84`); resolved to absolute paths against `repoRoot` (`config.ts:50`) |
| `exclude` | `['node_modules','dist','.git','coverage','**/*.test.*','**/*.spec.*']` (`config.ts:8-10`) | Fed into the `ignore` npm package's matcher **alongside** the repo's `.gitignore` contents (`discover.ts:65-67`) — entries must be gitignore-syntax, not arbitrary glob |
| `languages` | `['ts','tsx','js','jsx']` (`config.ts:11`) | Enum-constrained; no `.mts/.cts/.mjs/.cjs`, no Vue/Svelte, no JSON support anywhere |
| `dbPath` | `.codeindex/index.db` (`config.ts:12`) | Resolved absolute against `repoRoot` (`config.ts:41`); parent dir `mkdir -p`'d (`config.ts:43`) |
| `indexLocals` | `true` (`config.ts:13`) | Gate: `input.indexLocals \|\| symbol.scopeTier !== 'local'` (`extract-symbols.ts:173`) |
| `indexVariables` | `true` (`config.ts:14`) | Gate: `input.indexVariables \|\| symbol.kind !== 'variable_declarator' \|\| symbol.scopeTier === 'exported'` (`extract-symbols.ts:174`) |
| `includeDocComments` | `true` (`config.ts:15`) | Controls whether `readLeadingDocComment` runs (`extract-symbols.ts:127`, fn at `66-84`) |
| `maxStoredBodyLines` | `120` (`config.ts:16`) | `clipBody` truncates stored `bodyText` (`extract-symbols.ts:64`) |
| `tsconfigPaths` | `['tsconfig.json']` (`config.ts:17`) | Files read for `compilerOptions.paths`/`baseUrl` (`src/resolver/tsconfig-paths.ts:20-43`) to build alias rules |

Derived fields added post-parse (not in the zod schema): `repoRoot`, `configPath`, absolute
`dbPath`, absolute `roots[]`, absolute `tsconfigPaths[]` (`config.ts:45-52`).

Repo's own `.codeindex.json` sets only `roots:["src"]` explicitly; everything else matches
defaults. `.codeindex.json.example` differs only by `roots:["src","client"]` — it's the sole
"getting started" template; there's no config documentation besides `CLAUDE.md`.

Not configurable anywhere: which tree-sitter `kind`s to index/exclude, MCP transport choice,
telemetry/logging, symlink handling, max file size, concurrency, cache TTL, per-root exclude
overrides.

---

## 4. Testing

**Inventory.** 29 test files under `tests/`, 2375 total lines, **97 `test(...)` cases**, all
using Bun's built-in `bun:test` (`describe/test/expect/afterEach`) run via `bun test tests`
(`package.json:6`). No Vitest/Jest despite `.oxlintrc.json:3` applying a `vitest` lint plugin
(bun:test's API is Vitest/Jest-shaped, so the plugin still applies).

**Directory is fragmented / mid-migration.** Two parallel layouts coexist: legacy flat files
directly in `tests/` alongside a newer `tests/{indexer,mcp,resolver,search,storage}/*.test.ts`
tree mirroring `src/`'s subdirectories. Diffing name-colliding pairs shows they are **not
duplicates** in most cases but disjoint scenarios for the same module — e.g.
`tests/discover.test.ts` (42 lines: gitignore+excludes case) vs `tests/indexer/discover.test.ts`
(37 lines: missing-root case); `tests/index-codebase.test.ts` (71 lines, 2 tests) vs
`tests/indexer/index-codebase.test.ts` (160 lines, 5 tests, all about pruning/deleted-file
dependents). One pair is genuinely redundant: `tests/mcp.test.ts` (imports via the `../src/mcp.js`
barrel) vs `tests/mcp/server.test.ts` (imports directly) — both run essentially the same single
assertion.

**Style/patterns:**
- Many "unit" tests bypass the indexing pipeline and seed a `new Database(':memory:')` (after
  `ensureSchema(db)`) with hand-written raw `INSERT INTO symbols/files (...) VALUES (...)` SQL
  strings that duplicate the production column list (e.g. `tests/search/index.test.ts:12-20`,
  `tests/storage/queries.test.ts:13-20`) — must be kept in sync manually with `schema.ts`/
  `queries.ts`.
- Other tests exercise the real pipeline end-to-end via
  `mkdtempSync(path.join(tmpdir(), 'codeindex-...'))` + `writeFileSync` to build a throwaway
  repo on disk, then call `loadCodeindexConfig`/`indexCodebase` for real, cleaned up in
  `afterEach` with `rmSync` (`tests/index-codebase.test.ts:11-21`, `tests/cli.test.ts:10-14`,
  `tests/config.test.ts:10-20`).
- The largest and most thorough file is `tests/indexer/extract-references.test.ts` (404 lines, 15
  test cases) — inline tree-sitter source snippets asserting exact
  `ReferenceCandidate`/`ExtractedSymbol` fields (aliased imports, default/anonymous-default
  exports, abstract classes, arrow-function-in-const attribution, etc.).
- **MCP-layer tests are shallow and don't cross the protocol boundary.** `tests/mcp/tools.test.ts`
  (`tools.test.ts:13-119`) only validates that the zod output schemas accept/reject sample
  payloads and that `buildStructuredToolResult` shapes `{content, structuredContent}` correctly —
  it never calls the registered handlers (so `guidance` logic, `code_index`'s path/mode wiring,
  and error paths are untested here). `tests/mcp/server.test.ts` only asserts
  `createCodeindexServer({...stub deps})` returns a truthy object. A repo-wide grep for
  `callTool`, `Client(`, `StdioClientTransport`, `listTools` across `tests/` returns **zero
  matches** — there is no test that actually drives a tool call through the real MCP SDK
  request/response/validation pipeline.

**Retrieval-quality / benchmark testing: none.** A repo-wide grep across `src/` and `tests/` for
`fixture|benchmark|golden|snapshot|eval|recall@|precision@|ndcg` returns zero matches, and
`find . -iname "*fixture*"` (excluding `node_modules`) returns nothing. `tests/search/rank.test.ts`
(62 lines) and its near-duplicate in `tests/search.test.ts:36-77` test the
`scoreSearchResult`/`rerankSearchResults` scoring functions with a handful of synthetic inputs,
but there is no corpus-level evaluation harness (no labeled query set, no precision/recall/MRR/
NDCG measurement, no regression check against a real-world repo's search quality). There is also
no `README.md` anywhere in the repo — `CLAUDE.md` (49 lines) is the only prose documentation.

**Tooling gates.** `package.json:11` `check` script runs `lint` (oxlint), `typecheck`
(`tsgo`/TypeScript native-preview), `format:check` (oxfmt), `test` in parallel. `.oxlintrc.json`
sets `typeAware/typeCheck: true` and `denyWarnings: true`; `tsconfig.json` enables `strict`,
`noUncheckedIndexedAccess`, `noImplicitOverride`, `noUnusedLocals/Parameters`,
`noPropertyAccessFromIndexSignature`. Test files get relaxed rules via an override block
(`.oxlintrc.json:52-64`, e.g. `max-lines-per-function: off`).

---

## 5. Concrete limitations & gaps

**Tool surface**
- Exactly 4 MCP tools, no more: `code_search`, `code_symbol`, `code_impact`, `code_index`
  (`server.ts:91-94`). No "list symbols in file" tool — and it cannot be emulated with
  `code_search`, because `query` is mandatory non-empty (`z.string().min(1)`, `tools.ts:28`);
  `pathPrefix` can only narrow an existing text search, not enumerate.
- No "go to definition" / "symbol at position (file, line, col)" lookup anywhere in
  `src/search/index.ts` or `src/storage/queries.ts`.
- No "call hierarchy" / multi-hop traversal: `findIncomingReferences` (`src/search/index.ts:43-90`)
  issues a single non-recursive SQL `JOIN` — one hop only, no recursive CTE, no "who calls the
  callers of X" or outgoing-calls direction.
- No "list exports of module X" tool, despite the `module_exports` table existing
  (`src/storage/schema.ts:43-51`) — it's only used internally for exact-match resolution
  (`src/search/exact.ts:105`), never exposed as its own query.
- `code_symbol` has no `kinds`/`scopeTiers`/`pathPrefix` filters, unlike `code_search`
  (`tools.ts:36-39` vs `27-33`) — an unexplained asymmetry.
- `ImpactResultSchema` (`tools.ts:86-92`) has no `snippet`/source-line text field, unlike search
  results — an agent tracing impact must issue a separate lookup to see the calling code.

**Reference/edge-type coverage.** `ReferenceEdgeType` (`src/types.ts:7`) declares
`'imports' | 'reexports' | 'calls' | 'extends' | 'implements' | 'references'`, but
`src/indexer/extract-references.ts` only ever constructs `'imports'`, `'reexports'`, `'calls'` —
no handling of `class_heritage`/`extends_clause`/`implements_clause` node types exists anywhere.
So `code_impact` can never answer "who extends this class" or "who implements this interface."

**Indexing / freshness**
- No filesystem watch mode: repo-wide grep for `chokidar|fs\.watch|watch\(` in `src/` returns
  nothing. Reindexing is only ever explicit (`code_index` MCP tool or `index`/`reindex` CLI).
- "Incremental" mode is not truly incremental: `findIncrementalFileSet`
  (`src/indexer/index-codebase.ts:145-178`) still `readFile`s and SHA-256-hashes **every**
  discovered file on every call to detect changes by content-hash diff — no mtime/event-based
  shortcut — before deciding which files to reparse.
- `code_index`'s `path` input (`tools.ts:53-56`) is a **repo-root override**, not a "reindex this
  one file" scope — see wiring inconsistency in section 1.

**Ranking / search precision**
- `pathPrefix` filtering is a naive `String.prototype.startsWith` check, not path-boundary aware
  (`src/search/exact.ts:22`, `src/search/fts.ts:14`) — e.g. `pathPrefix: 'src/mcp'` would also
  match a hypothetical `src/mcpFoo.ts`.
- `rerankSearchResults` (`src/search/rank.ts:34-37`) sorts purely by
  `rankScore = scopeScore + matchScore`. `matchScore` returns `0` for **every** FTS-sourced hit
  regardless of its bm25 relevance — so scope tier always dominates lexical relevance; a highly
  relevant local-scope symbol will rank below a barely-related exported one. FTS's own
  `ORDER BY bm25(...)` only survives as an implicit secondary key via JS's stable sort, and only
  within the same scope tier.
- `runFtsSearch` hardcodes `confidence: 'resolved'` for every full-text hit (`fts.ts:78`),
  reusing the same enum value that elsewhere means "reference resolved via import/export".
- `kind` filters (`tools.ts:30`) are raw, undocumented tree-sitter node types
  (`extract-symbols.ts:40-51`) — no enum/description in the zod schema
  (`z.array(z.string().min(1))`, unrestricted), and no glossary anywhere. Arrow functions and
  function expressions assigned via `const` surface with `kind: 'variable_declarator'`, not
  `'arrow_function'` — a discoverability trap for a caller unfamiliar with the grammar.
- `resultCount` in `CodeSearchOutputSchema` (`tools.ts:76`) is just `results.length` **after**
  slicing to `limit` (`server.ts:36`) — no `hasMore`/cursor/offset anywhere.

**Agent ergonomics / token budget**
- Every tool response duplicates the full payload: `content[0].text` (stringified JSON) plus
  `structuredContent` (`tools.ts:113-116`) — roughly 2x token cost for any consumer that reads
  the text channel.
- `maxStoredBodyLines` defaults to 120 but snippets shown to the agent are already clipped further
  to 3 lines for exact matches (`src/search/exact.ts:33-41`) — no way to request a larger/full
  snippet per-call.
- No result-formatting controls (no markdown/compact/verbose mode) — the only knob is `limit`.

**Observability / operational**
- No logging library or structured logs anywhere: repo-wide grep of `src/` shows only three raw
  `console.*` calls, all in `cli.ts`. No request IDs, no per-call timing/metrics (only
  `code_index`'s `elapsedMs` — no equivalent for search/symbol/impact latency), no debug/verbose
  flag, no telemetry dependency in `package.json`.
- `openDatabase` (`src/storage/db.ts:3-8`) opens a fresh SQLite connection (WAL mode) per call via
  `withDatabase` (`cli.ts:25-32`) for every single search/symbol/impact/index invocation, then
  closes it — no long-lived pooled connection.
- No config for MCP transport (`StdioServerTransport` is the only option), so no HTTP/remote
  deployment path exists in this codebase.

**Onboarding**
- No `codeindex init` / config-scaffolding command in the CLI's command switch (`cli.ts:97-121`)
  — first-time setup requires manually copying `.codeindex.json.example` to `.codeindex.json`.
- No `--help`/usage text anywhere; unknown commands just throw `Unknown command: ${command}`.
