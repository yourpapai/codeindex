# Inventory 02 — Storage, Search & Ranking

Detailed technical inventory of `src/storage/schema.ts`, `src/storage/queries.ts`,
`src/storage/db.ts`, `src/search/index.ts`, `src/search/exact.ts`, `src/search/fts.ts`,
`src/search/rank.ts`, and `src/types.ts`. Includes the **live DB dump** (appendix) taken from
this repo's own `.codeindex/index.db`.

## 1. Storage design

### Schema (`src/storage/schema.ts`)

**`files`** (`schema.ts:4-13`) — one row per source file: `id`, `file_path` (UNIQUE),
`module_key` (UNIQUE), `language`, `file_hash` (sha256, computed in
`indexer/index-codebase.ts:74,84`), `parse_status` (`'indexed'` | `'parse_failed'`, free-text
TEXT with no CHECK constraint), `parse_error`, `indexed_at`.

**`module_aliases`** (`schema.ts:14-20`) — alternate resolvable names for a file: `file_id` FK
(`ON DELETE CASCADE`), `alias_key`, `alias_kind`
(`'extensionless' | 'index_collapse' | 'tsconfig_path'`, `resolver/module-specifiers.ts:5`),
`precedence` (int). Populated by `resolver/module-specifiers.ts:19-25` (extensionless,
precedence 100), `:27-33` (index-collapse, precedence 90), and `resolver/tsconfig-paths.ts:89-95`
(tsconfig path alias, precedence 80).

**`symbols`** (`schema.ts:21-42`) — the core table: `id`, `file_id` FK CASCADE, `file_path`,
`module_key`, `symbol_key` (UNIQUE), `local_name`, `qualified_name`, `kind` (raw tree-sitter
node type, e.g. `function_declaration`), `scope_tier`
(`'exported'|'module'|'member'|'local'`), `parent_symbol_id` (self-referential FK,
`ON DELETE CASCADE`), `is_exported` (INTEGER 0/1), `export_names` (JSON-stringified array),
`signature_text`, `doc_text`, `body_text`, `identifier_terms`, `start_line`/`end_line`,
`start_byte`/`end_byte`.

**`module_exports`** (`schema.ts:43-51`) — per-export-name rows: `file_id` FK, `export_name`,
`export_kind` (`named|default|namespace|reexport`), `symbol_id` FK (`ON DELETE SET NULL`),
`target_module_specifier`, `resolved_file_id` FK (`ON DELETE SET NULL`, written to schema but
**never populated** — `persistModuleExports` in `storage/queries.ts:196-214` always inserts
`NULL` for it).

**`symbol_references`** (`schema.ts:52-64`) — the reference/call graph: `source_symbol_id` FK
SET NULL, `source_file_id` FK CASCADE, `target_symbol_id` FK SET NULL, `target_file_id` FK SET
NULL, `target_name`, `target_export_name`, `target_module_specifier`, `edge_type`
(`imports|reexports|calls|extends|implements|references`, `types.ts:7`), `confidence`
(`resolved|file_resolved|name_only`, `types.ts:9`), `line_number`.

**Indexes** (`schema.ts:65-81`): `module_aliases(alias_key)`, `module_aliases(file_id)`,
`symbols(local_name)`, `symbols(qualified_name)`, `symbols(scope_tier)`, `symbols(file_id)`,
`symbols(parent_symbol_id)`, `module_exports(file_id)`, `module_exports(export_name)`,
`module_exports(symbol_id)`, `module_exports(resolved_file_id)`,
`symbol_references(source_symbol_id)`, `symbol_references(target_symbol_id)`,
`symbol_references(target_file_id)`, `symbol_references(target_name)`,
`symbol_references(edge_type)`, `symbol_references(confidence)`.

### FTS5 configuration (`schema.ts:84-98`)
`symbol_fts` is an **external-content** FTS5 table (`content='symbols', content_rowid='id'`)
over 8 columns in this exact order: `local_name(0), qualified_name(1), export_names(2),
identifier_terms(3), signature_text(4), doc_text(5), body_text(6), file_path(7)`. Tokenizer:
`unicode61 remove_diacritics 1 tokenchars '_-'`, with `prefix='2 3'` (2- and 3-char prefix
indexes). Kept in sync purely by triggers `symbols_ai`/`symbols_ad`/`symbols_au`
(`schema.ts:99-112`) — no separate write path populates the FTS table; it's a pure
trigger-driven external-content mirror of `symbols`.

### Schema versioning (`schema.ts:115-138`)
`SCHEMA_VERSION = 1`. `ensureSchema` reads `PRAGMA user_version`; if stale, it **drops every
table** (`symbol_fts, symbol_references, module_exports, symbols, module_aliases, files`,
`DROP_ORDER` at `schema.ts:118`) and rebuilds from scratch — no `ALTER TABLE` migration path.
Verified by `tests/storage/schema.test.ts:19-49` ("migrates" = drop+recreate). Any schema change
requires a full reindex.

### WAL / pragmas (`storage/db.ts:1-8`)
`openDatabase` sets `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON` on every open
(read or write path alike — used identically by `indexer/index-codebase.ts:255` and `cli.ts:26`
`withDatabase`). No `busy_timeout`, `synchronous`, or `cache_size` pragma is set anywhere in the
codebase.

### Per-symbol metadata capture (`indexer/extract-symbols.ts`)
- `symbolKey`: `` `${relativeFilePath}#${node.startIndex}-${node.endIndex}` `` — byte-offset
  based (`extract-symbols.ts:120`).
- `qualifiedName`: `` `${moduleKey}#${localName}` `` at module scope or
  `` `${parentQualifiedName}>${localName}` `` when nested (`extract-symbols.ts:137-138`).
- `scopeTier`: exported if inside an `export_statement`; `member` for
  `method_definition`/`public_field_definition`; `module` if no parent; else `local`
  (`extract-symbols.ts:89-97`).
- `identifierTerms`: derived **only from `localName`**, camelCase-split on lower→Upper
  boundaries and `_`/`-` runs replaced with spaces, lowercased (`extract-symbols.ts:55-60`).
- `bodyText`: sliced from source and clipped to `config.maxStoredBodyLines`
  (`extract-symbols.ts:64,128`; default 120 lines, `config.ts:16`).
- `docText`: leading `/** */` block comment scan, gated by `config.includeDocComments`
  (`extract-symbols.ts:66-84,127`).
- `signatureText`: just the trimmed source line at the node's start row
  (`extract-symbols.ts:126`) — not a parsed/reconstructed signature.
- Symbols are filtered post-walk: `program` nodes dropped, locals dropped unless `indexLocals`,
  `variable_declarator`s dropped unless `indexVariables` or exported
  (`extract-symbols.ts:170-175`).

### Reference extraction & resolution
`indexer/extract-references.ts` walks the tree and only ever emits **three** edge types in
practice: `imports` (`:230-242,274-283`), `reexports` (`:57-67`), `calls` (`:244-258`).
`resolver/resolve-references.ts` resolves each candidate through three tiers written to
`confidence`: `resolved` (import-map or export-name match, `:80-95`), `file_resolved` (name
match within a module-matched file, `:108-112`), `name_only` (name match with no file/module
match, `:108-112`).

### Write/persist path
`indexer/index-codebase.ts` orchestrates: `insertFile` (upsert by `file_path`,
`storage/queries.ts:71-92`) → `clearFileRows` (deletes `module_aliases`, `module_exports`,
`symbol_references(source_file_id=?)`, `symbols` for that file — `queries.ts:12-17`) →
`persistAliases`/`persistSymbols`/`persistModuleExports` → parent-symbol linking by a second
UPDATE pass matching `qualified_name` (`linkParentSymbols`, `queries.ts:159-170`) → after all
files in a batch, `persistResolvedReferences` re-resolves and inserts `symbol_references` rows
(`index-codebase.ts:209-251`). Incremental mode diffs by `file_hash` and additionally
re-processes files that reference a changed/deleted file via `symbol_references` joins
(`findIncrementalFileSet`, `index-codebase.ts:145-178`; `findDependentsOfDeletedFiles`,
`storage/queries.ts:35-69`), so that FK `ON DELETE SET NULL` cascades on stale
`target_symbol_id`s get re-resolved.

---

## 2. Search semantics

### Entry points (`src/search/index.ts`)
- `searchSymbols` (`:22-33`): runs `runExactSearch` **and** `runFtsSearch` each capped at
  `input.limit`, dedupes FTS results whose `symbolKey` already appeared in exact results
  (`:28-31`), reranks the union, then `.slice(0, input.limit)`.
- `findSymbolCandidates` (`:35-41`): exact-first shortcut — if `runExactSearch` returns
  anything, only those (reranked) are returned; FTS is not consulted at all in that case.
- `findIncomingReferences` (`:43-90`): looks up a `symbols` row by `symbol_key` or
  `qualified_name`, then joins `symbol_references` → `files`/`symbols` for the source side,
  `ORDER BY confidence = 'resolved' DESC, line_number ASC` (`:79`), `LIMIT ?`.

### Exact matching (`src/search/exact.ts`)
Single SQL statement (`:100-112`): `WHERE symbols.local_name = ? OR symbols.qualified_name = ?
OR module_exports.export_name = ? OR symbols.file_path LIKE ?` (the last bound to
`` `${query}%` `` unescaped — literal `%`/`_` in the query act as SQL wildcards), joined
`LEFT JOIN module_exports ON module_exports.symbol_id = symbols.id AND
module_exports.export_name = ?`. `matchReason` is derived post-hoc by string comparison
priority: export-name match → `'exact export_names'`, else qualified-name →
`'exact qualified_name'`, else local-name → `'exact local_name'`, else `'exact file_path'`
(`mapExactRow`, `:69-76`). `confidence` is hardcoded to `'exact'` (`:77`). Snippet = first 3
lines of `body_text`, else `signature_text`, else `qualified_name` (`buildSnippet`, `:33-41`,
verified by `tests/search/exact.test.ts`).

### FTS fallback (`src/search/fts.ts`)
`sanitizeFtsQuery` (`:28-36`) strips `" ( ) ^ * / #`, splits on whitespace, and **joins
multiple tokens with `OR`** (never `AND`/`NEAR`/phrase). Query:
`symbol_fts MATCH ? ORDER BY bm25(symbol_fts, 10.0, 9.0, 8.0, 7.0, 6.0, 5.0, 2.0, 1.0) LIMIT ?`
(`:56-64`) — column weights in schema order: local_name=10, qualified_name=9, export_names=8,
identifier_terms=7, signature_text=6, doc_text=5, body_text=2, file_path=1. `matchReason` is a
constant string `'fts identifier_terms/doc_text/body_text'` for every row (`:77`, doesn't
reflect which column actually matched). `confidence` is hardcoded to `'resolved'` for every row
regardless of BM25 score (`:78`). Snippet uses `snippet(symbol_fts, 5, '[', ']', '...', 12)` —
**column 5 is `doc_text`** (`:59`, cross-checked against column order in `schema.ts:85-93`).

### Ranking (`src/search/rank.ts`)
`scoreSearchResult = scopeScore(scopeTier) + matchScore(matchReason)` (`:31-32`):
- `scopeScore`: exported=400, module=300, member=200, local=100 (`:3-16`).
- `matchScore`: `matchReason` containing `'exact export_names'`→500,
  `'exact qualified_name'`→450, `'exact local_name'`→425, anything else (incl.
  `'exact file_path'` and all FTS results)→0 (`:18-29`).
- `rerankSearchResults` maps + `Array.prototype.sort` descending by score (`:34-37`) — a pure
  JS in-memory sort (stable per spec), so ties are broken only by original array order: exact
  rows precede FTS rows (from the concatenation order in `search/index.ts:28-31`), and FTS rows
  keep their incoming BM25 order among themselves.
- `kind` is never factored into ranking; BM25 magnitude is discarded after ordering the initial
  FTS query — the rerank step only sees `scopeTier`/`matchReason`.

### Filters & result assembly
`SearchFilters` (`kinds?`, `scopeTiers?`, `pathPrefix?`, `search/exact.ts:5-9`) are applied via
`applyFilters`, an in-process `Array.prototype.filter` implemented **twice**, once in
`exact.ts:11-26` and once in `fts.ts:6-18` (duplicated logic) — and applied **after** the SQL
`LIMIT`, so filtering can reduce the returned count below `limit` even when more matching rows
exist unfetched.

### MCP/CLI surface
`mcp/tools.ts` defines Zod schemas: `CodeSearchInputSchema` (`limit` default 10, max 50,
`:27-33`), `CodeSymbolInputSchema` (default 10, max 50, `:36-39`), `CodeImpactInputSchema`
(default 20, max 100, `:42-51`). `mcp/server.ts:28-40` attaches a `guidance` string only when
`code_search` returns zero results. `cli.ts:38-47` hardcodes limits 10/10/20 for
`search`/`symbol`/`impact` CLI commands. Both surfaces expose `limit` only — **no `offset`/page
parameter anywhere** (grep-verified, zero hits).

---

## 3. Concrete limitations & gaps

- **No semantic/embedding/vector search at all.** Grep across `src/` for
  embedding/vector/semantic/cosine/similarity returns nothing; `package.json` has zero
  ML/embedding dependencies. Retrieval is exclusively SQL equality/`LIKE` plus FTS5 BM25 —
  purely lexical.
- **Ranking is a static two-factor heuristic, not learned.** `rank.ts:1-37` only uses
  `scopeTier` (4 buckets) × `matchReason` (3 exact buckets + 0 for everything else). `kind` is
  unused; symbol popularity/in-degree (derivable from `symbol_references`, which the schema
  already tracks) is never consulted for ranking.
- **No fuzzy matching / typo tolerance.** No Levenshtein/fuzzy code anywhere (grep-verified).
  Exact search requires byte-exact string equality (case-sensitive — see below); FTS requires
  exact token matches (also see prefix-index point below).
- **Tokenizer keeps snake_case/kebab-case glued.** `tokenchars '_-'` (`schema.ts:96`) makes
  `_`/`-` **part of tokens**, so raw FTS columns (`local_name`, `qualified_name`,
  `signature_text`, `doc_text`, `body_text`, `file_path`) index `get_user_by_id` as one
  indivisible token, not word-split. Only `identifier_terms` (derived from `localName` alone,
  `extract-symbols.ts:55-60`) is explicitly space-split — and that regex only handles
  `lower→Upper` boundaries, so acronym runs like `XMLParser` do **not** split
  (`([a-z0-9])([A-Z])` never matches `L`→`P`).
- **Configured FTS prefix indexes are unused.** `prefix='2 3'` (`schema.ts:97`) sets up 2/3-char
  prefix indexes, but `sanitizeFtsQuery` (`fts.ts:28-36`) never appends `*`, so no query ever
  issues a prefix/wildcard MATCH — the prefix indexes are dead weight for current queries.
- **Very limited query expression power.** `sanitizeFtsQuery` strips `" ( ) ^ * / #` and joins
  multi-term queries with `OR` only (`fts.ts:28-36`) — no `AND`, `NEAR`, phrase search, or
  field-scoped search from the query text. The only structural narrowing is the `SearchFilters`
  (`kinds`/`scopeTiers`/`pathPrefix`), and those are applied as a post-fetch in-process filter,
  not pushed into SQL.
- **No relevance-evaluation harness.** `tests/search/*.test.ts` are unit assertions on specific
  scoring/matching behaviors (e.g. `tests/search/rank.test.ts`); there's no golden-query corpus,
  precision/recall measurement, or regression suite for ranking quality.
- **Weak result de-duplication.** Dedup only happens between the exact pool and FTS pool, by
  `symbolKey` (`search/index.ts:28-31`). There is no de-dup *within* the exact pool: the SQL
  `WHERE local_name = ? OR qualified_name = ? OR ...` can return multiple distinct rows (distinct
  `symbol_key`, same `qualified_name`) for duplicate declarations/overloads, and both will
  independently survive into results.
- **No pagination.** No `offset`/cursor anywhere (grep-verified). Only `limit`, capped by Zod
  (50 for `code_search`/`code_symbol`, 100 for `code_impact`, `mcp/tools.ts:29,38,46`).
  `CodeSearchOutputSchema.resultCount` is just `results.length` post-slice
  (`mcp/server.ts:34-39`) — callers get no signal of how many total matches exist beyond what
  was returned.
- **Large result handling is "fetch 2×limit, merge, truncate."** Exact and FTS are each
  independently capped at `limit` rows, concatenated, reranked, then sliced back down to `limit`
  (`search/index.ts:22-33`) — not a true top-k streaming merge.
- **Case sensitivity mismatch between the two tiers.** No `COLLATE NOCASE` anywhere in the
  schema (grep-verified); exact-match `=`/`LIKE` predicates (`exact.ts:106-109`) are
  case-sensitive (default BINARY collation), while FTS5's `unicode61` tokenizer lowercases
  tokens — so a case-mismatched query silently skips the exact tier (and its higher
  `matchScore`) and only surfaces via the FTS tier.
- **Unescaped LIKE metacharacters.** `symbols.file_path LIKE ?` is bound to `` `${query}%` ``
  with no escaping of `%`/`_` in the user's query (`exact.ts:109`), so literal `%`/`_`
  characters behave as SQL wildcards rather than literal text.
- **FTS snippet is hardcoded to the `doc_text` column** (`fts.ts:59`, column index 5 per
  `schema.ts:85-93`) regardless of which column actually matched. Since `doc_text` defaults to
  `''` whenever there's no leading `/** */` comment or `includeDocComments` is off
  (`extract-symbols.ts:127`), FTS-path results very commonly carry an empty/uninformative
  `snippet` even when the real match was in `body_text`, `local_name`, etc.
- **`confidence` field is overloaded and under-informative for search.** `types.ts:22` types it
  as `ReferenceConfidence | 'exact'`, but search code only ever emits `'exact'` (`exact.ts:77`)
  or a constant `'resolved'` (`fts.ts:78`) — the meaningful `file_resolved`/`name_only` values
  are exclusive to `symbol_references` rows (`resolve-references.ts`) and never appear in search
  results; FTS's `'resolved'` carries no gradation of match strength.
- **Schema changes require a full reindex** — no incremental migration; `ensureSchema` drops and
  rebuilds all tables (including FTS) on any `SCHEMA_VERSION` bump (`schema.ts:115-138`).
- **`symbol_key`/row-id churn on every file edit.** `symbol_key` is byte-offset-based
  (`extract-symbols.ts:120`); any edit anywhere earlier in a file shifts downstream byte offsets,
  and a changed file is always fully `clearFileRows`'d and re-inserted (`storage/queries.ts:12-17`,
  `index-codebase.ts:125-143`), so **every** symbol in that file gets a new SQLite `id` and, if
  its byte range moved, a new `symbol_key` — even symbols whose own source text is unchanged.
  Stale `symbol_key`s held by a caller across an edit simply return `[]` from
  `findIncomingReferences` (`search/index.ts:55-57`), not an error.
- **Dead/write-only columns**, confirmed by grep for read-sites:
  - `module_aliases.precedence` — written (`resolver/module-specifiers.ts:23,31`,
    `resolver/tsconfig-paths.ts:93`, persisted via `storage/queries.ts:106-115`) but
    `selectAllModuleAliases` doesn't even select it (`storage/queries.ts:244-248`), and
    `resolve-references.ts:67-71` picks the first `Array.prototype.find` match by insertion
    order — precedence never actually breaks a tie.
  - `symbols.is_exported` — written at insert (`storage/queries.ts:129,141`) but never
    selected/read anywhere afterward; `scopeTier === 'exported'` is used instead wherever "is
    this exported" matters.
  - `symbols.start_byte`/`end_byte` — written (`storage/queries.ts:130,149-150`) but never
    selected by any query; `RankedSearchResult`/`SearchResult` (`types.ts:11-24`) only expose
    `startLine`/`endLine`.
  - `module_exports.resolved_file_id` — column and index exist (`schema.ts:50,75`) but
    `persistModuleExports` always inserts `NULL` (`storage/queries.ts:196-214`).
- **`extends`/`implements`/`references` edge types are modeled but never produced.**
  `ReferenceEdgeType` (`types.ts:7`) and `symbol_references.edge_type` anticipate
  `extends`/`implements`/`references`, but `indexer/extract-references.ts` only ever pushes
  `imports`, `reexports`, `calls` (grep-verified: no code path constructs the other three) —
  class inheritance edges are entirely absent from the reference graph today.
- **No `busy_timeout`/`synchronous`/`cache_size` pragma** — only `journal_mode=WAL` and
  `foreign_keys=ON` (`storage/db.ts:5-6`) are ever set, on every open regardless of whether it's
  a concurrent MCP-server read or an indexer write.

---

## 4. Notable design decisions

- **`symbol_references`, not `references`** — explicitly documented: *"The incoming-reference
  table is named `symbol_references`, not `references`, because `REFERENCES` is a SQLite
  keyword."* (`CLAUDE.md:18`).
- **Exact-first search philosophy** — explicitly documented in `CLAUDE.md:41-48` ("`code_symbol`
  is exact-first... `code_search`... returns a mix of exact and FTS hits") and implemented as
  two distinct entrypoints: `findSymbolCandidates` short-circuits to exact-only when any exact
  hit exists (`search/index.ts:35-41`), while `searchSymbols` always blends both pools then
  reranks (`search/index.ts:22-33`).
- **FTS5 external-content table**, not a duplicated/standalone index —
  `content='symbols', content_rowid='id'` (`schema.ts:85-95`) plus `ai/ad/au` triggers
  (`schema.ts:99-112`) keep the FTS shadow table in sync without storing the indexed text twice;
  the tradeoff is per-write trigger overhead on every `symbols` INSERT/UPDATE/DELETE.
- **Symbol nesting is double-encoded** — both structurally via `parent_symbol_id` (self-FK,
  `schema.ts:31`, resolved in a second UPDATE pass by `linkParentSymbols`,
  `storage/queries.ts:159-170`) and textually via `qualifiedName`'s `parent>child` vs
  `module#name` grammar (`extract-symbols.ts:137-138`) — the same hierarchy is available both as
  a joinable FK and as a parseable string.
- **Three-tier reference confidence is a graceful-degradation model**, not a strict
  resolved/unresolved binary: even when a reference's target module can't be matched, the row is
  still recorded with `target_symbol_id = NULL` but `target_name` preserved
  (`resolver/resolve-references.ts:115-118`), so `symbol_references` doubles as both a resolved
  call/import graph and a name-only "candidate" ledger; `findIncomingReferences` explicitly
  prioritizes `confidence = 'resolved'` rows first (`search/index.ts:79`).
- **Module identity vs. module aliasing is split out** so a single file can be reached via
  multiple import spellings — `module_key` (canonical, extension-stripped) plus `module_aliases`
  rows for extensionless, index-collapsed, and tsconfig-path-mapped forms
  (`resolver/module-specifiers.ts:16-39`, `resolver/tsconfig-paths.ts:63-97`) — used by
  `resolve-references.ts:59-72` to map an import specifier back to a `file_id`.
- **Idempotent self-healing schema application** — `ensureSchema` always re-runs every
  `CREATE TABLE IF NOT EXISTS`/trigger statement on every open (`schema.ts:135-136`), and only
  performs the destructive drop-and-rebuild when `PRAGMA user_version` is behind `SCHEMA_VERSION`
  (`schema.ts:126-134`) — a from-scratch DB and an up-to-date DB both take the identical cheap
  path.

---

## Appendix — Live DB dump (this repo's `.codeindex/index.db`, 2026-07-19)

Primary data, captured directly from the database for scale/shape grounding.

### Full schema

```sql
CREATE TABLE files (
    id INTEGER PRIMARY KEY,
    file_path TEXT NOT NULL UNIQUE,
    module_key TEXT NOT NULL UNIQUE,
    language TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    parse_status TEXT NOT NULL,
    parse_error TEXT,
    indexed_at TEXT NOT NULL
  );
CREATE TABLE module_aliases (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    alias_key TEXT NOT NULL,
    alias_kind TEXT NOT NULL,
    precedence INTEGER NOT NULL
  );
CREATE TABLE symbols (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    module_key TEXT NOT NULL,
    symbol_key TEXT NOT NULL UNIQUE,
    local_name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    scope_tier TEXT NOT NULL,
    parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
    is_exported INTEGER NOT NULL,
    export_names TEXT NOT NULL,
    signature_text TEXT NOT NULL,
    doc_text TEXT NOT NULL,
    body_text TEXT NOT NULL,
    identifier_terms TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    start_byte INTEGER NOT NULL,
    end_byte INTEGER NOT NULL
  );
CREATE TABLE module_exports (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    export_name TEXT NOT NULL,
    export_kind TEXT NOT NULL,
    symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
    target_module_specifier TEXT,
    resolved_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL
  );
CREATE TABLE symbol_references (
    id INTEGER PRIMARY KEY,
    source_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
    source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    target_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
    target_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
    target_name TEXT NOT NULL,
    target_export_name TEXT,
    target_module_specifier TEXT,
    edge_type TEXT NOT NULL,
    confidence TEXT NOT NULL,
    line_number INTEGER NOT NULL
  );

CREATE VIRTUAL TABLE symbol_fts USING fts5(
    local_name, qualified_name, export_names, identifier_terms,
    signature_text, doc_text, body_text, file_path,
    content='symbols', content_rowid='id',
    tokenize='unicode61 remove_diacritics 1 tokenchars ''_-''',
    prefix='2 3'
  );
-- + triggers symbols_ai / symbols_ad / symbols_au keep symbol_fts in sync
```

### Table row counts

| table | rows |
|---|---|
| files | 25 |
| module_aliases | 26 |
| symbols | 336 |
| module_exports | 99 |
| symbol_references | 722 |
| symbol_fts | 336 |

### Symbol-kind distribution (telling!)

| kind | count |
|---|---|
| variable_declarator | 286 |
| interface_declaration | 34 |
| type_alias_declaration | 15 |
| identifier | 1 |

> **Note:** This is a functional-TS codebase, so arrow functions assigned to `const`
> (`export const foo = () => {}`) are indexed under their *syntactic* node kind
> `variable_declarator` — hence **286 `variable_declarator` and zero `function_declaration`/
> `class_declaration`**. This is direct evidence of the **symbol-kind fidelity gap**: `kind`
> reflects the tree-sitter node type, not the semantic role (function / component / hook).
