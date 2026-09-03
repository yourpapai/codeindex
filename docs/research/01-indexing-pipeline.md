# Inventory 01 — Indexing Pipeline

Detailed technical inventory of the indexing subsystem: `src/indexer/parser.ts`,
`src/indexer/discover.ts`, `src/indexer/extract-symbols.ts`,
`src/indexer/extract-references.ts`, `src/indexer/index-codebase.ts`,
`src/resolver/resolve-references.ts`, `src/resolver/module-specifiers.ts`,
`src/resolver/tsconfig-paths.ts`, and `src/impact.ts`.

## 0. Pipeline map

```
discover.ts ──▶ index-codebase.ts ──▶ parser.ts ──▶ extract-symbols.ts
                       │                              extract-references.ts
                       │                                      │
                       ▼                                      ▼
                storage/queries.ts ◀── resolve-references.ts (resolver/)
                       │                    ▲
                       ▼                    │ uses module-specifiers.ts + tsconfig-paths.ts
                  SQLite (storage/schema.ts)
                       ▲
                       │
        search/index.ts (searchSymbols, findIncomingReferences) ── re-exported as impact.ts / search.ts
```

Entry points: `src/cli.ts` (CLI commands `index`/`reindex`/`search`/`symbol`/`impact`/`stats`/`mcp`)
and `src/mcp/server.ts` + `src/mcp/tools.ts` (MCP tools `code_search`, `code_symbol`,
`code_impact`, `code_index`), both wired through `src/cli.ts:65-84` `buildMcpDeps`.

---

## 1. What each stage does today

### `src/indexer/parser.ts` — tree-sitter loading
- Supports exactly 4 languages, one wasm grammar per language: `.ts`→typescript, `.tsx`→tsx,
  `.js`/`.jsx`→**shared** javascript grammar (`parser.ts:42-55`, `57-69`). Unsupported
  extensions throw (`parser.ts:53`, `67`).
- Uses `web-tree-sitter` (WASM tree-sitter bindings), dynamically imported (`parser.ts:71-79`),
  with `Parser.init()` cached once per process in a `WeakMap` (`parser.ts:27`, `86-101`).
- `createParserLoader` caches loaded `Language` objects per `SupportedLanguage` in a `Map`
  (`parser.ts:109-120`), but instantiates a **new `Parser()` object per file**
  (`parser.ts:123-128`) — grammars are reused, parser instances are not pooled.

### `src/indexer/discover.ts` — file discovery
- Walks `input.roots` recursively via `node:fs/promises.readdir(..., { withFileTypes: true })`
  (`discover.ts:35-60`).
- Ignore rules = root `.gitignore` content **only** (`discover.ts:24-30`, single file at
  `repoRoot/.gitignore`, not per-directory) + `config.exclude` glob list, merged into one
  `ignore()` matcher (`discover.ts:65-67`).
- Directories matching the ignore matcher are pruned before recursion (`discover.ts:46-50`),
  so `node_modules` etc. are never descended into.
- Missing/renamed root directories are tolerated (`ENOENT` → `[]`, `discover.ts:36-40`),
  matching the test "skips a configured root that does not exist instead of throwing".
- Only `entry.isDirectory()` / `entry.isFile()` are handled (`discover.ts:49-54`); anything
  else (symlinks — `Dirent.isSymbolicLink()`) falls through to the default
  `return Promise.resolve([])` and is silently dropped.
- Final filter keeps only extensions in `config.languages` and sorts by relative path
  (`discover.ts:81-83`).
- Default config excludes `**/*.test.*` and `**/*.spec.*` (`config.ts:8-10`), so test files
  are **not indexed by default**.

### `src/indexer/extract-symbols.ts` — symbol extraction
- Single recursive tree-walk (`extractSymbolsFromSource`, `extract-symbols.ts:140-176`) over
  `declarationTypes` (`extract-symbols.ts:40-51`): `abstract_class_declaration`,
  `class_declaration`, `enum_declaration`, `function_declaration`, `interface_declaration`,
  `lexical_declaration` (vestigial — see §4), `method_definition`, `public_field_definition`,
  `type_alias_declaration`, `variable_declarator`.
- `memberTypes` (`method_definition`, `public_field_definition`, line 53) are always tagged
  `scopeTier: 'member'`; otherwise tier is `exported` (inside an `export_statement`), `module`
  (top-level), or `local` (nested) — priority order in `scopeTierForNode`
  (`extract-symbols.ts:89-97`).
- Per symbol, captures: `symbolKey` = `${relativeFilePath}#${startByte}-${endByte}`
  (`extract-symbols.ts:120`), `qualifiedName` = `${moduleKey}#${localName}` at top level or
  `${parentQualifiedName}>${localName}` nested (`extract-symbols.ts:137-138`), `signatureText`
  = **only the single source line at `node.startPosition.row`**, trimmed
  (`extract-symbols.ts:126`), `docText` via `readLeadingDocComment` (JSDoc `/** */` blocks
  only — see §3), `bodyText` = full node source text clipped to `maxStoredBodyLines`
  (default 120) lines (`extract-symbols.ts:64`, `128`), `identifierTerms` =
  camelCase/snake/kebab split into lowercase space-separated tokens for FTS
  (`extract-symbols.ts:55-60`).
- Config gates: `indexLocals` drops `scopeTier==='local'` symbols; `indexVariables` drops
  non-exported `variable_declarator` symbols (`extract-symbols.ts:170-175`). The synthetic
  `program` root node kind is always dropped.
- No separate symbols are produced for interface/type members (`property_signature`,
  `method_signature` — confirmed present in the TS grammar node-types but absent from
  `declarationTypes`) or enum members (`enum_assignment`) — only the parent
  `interface_declaration`/`enum_declaration` is a symbol.

### `src/indexer/extract-references.ts` — reference/export extraction
- Two outputs: `moduleExports` (declared exports of the file) and `references` (candidate
  edges), built by one tree walk (`extractReferenceCandidates`, `extract-references.ts:260-297`).
- Export handling (`collectExportCandidates`, `extract-references.ts:183-228`): function/class
  exports, interface/type/enum exports, `lexical_declaration` (multi-declarator `const`)
  exports, `export { a, b as c }` and `export { a } from './x'` (reexport) clauses.
- Import handling: named imports (`import_specifier` nodes, `extract-references.ts:230-242`)
  and default imports (bare `identifier` whose parent is `import_clause`,
  `extract-references.ts:274-284`).
- Call handling (`collectCallReference`, `extract-references.ts:244-258`): every
  `call_expression` becomes a `'calls'` edge whose `targetName` is the **raw source text of
  the callee expression** (`functionNode?.text`, line 253) — for `obj.method()` this literally
  is the string `"obj.method"`, not `"method"`.
- "Enclosing symbol" attribution walks up through `isNamedScopeBoundary` node types only:
  `function_declaration`, non-variable-declarator `function_expression`, `class_declaration`,
  `abstract_class_declaration`, `method_definition`, and `variable_declarator` whose value is
  an arrow/function expression (`extract-references.ts:91-99`).
- Of the 6 `ReferenceEdgeType` values declared in `src/types.ts:7`
  (`imports | reexports | calls | extends | implements | references`), **only 3 are ever
  produced** — `'imports'` (lines 236, 278), `'reexports'` (line 61), `'calls'` (line 252).
  Confirmed by exhaustive grep: `'extends'`, `'implements'`, `'references'` never appear as a
  constructed value anywhere in `src/`.
- Not handled at all (confirmed absent by grep, and cross-checked against the TS/JS
  tree-sitter `node-types.json`): `namespace_import` (`import * as ns from 'x'`),
  `import_require_clause` (`import x = require(...)`), `class_heritage`/`extends_clause`/
  `implements_clause`, `type_identifier`/type annotations, `jsx_element`/`jsx_opening_element`/
  `jsx_self_closing_element`, and bare/`namespace_export` re-export-all (`export * from 'x'`,
  `export * as ns from 'x'`).

### `src/indexer/index-codebase.ts` — orchestration
- `indexCodebase(input)` (`index-codebase.ts:253-294`) opens the DB, runs `ensureSchema`,
  builds the parser loader and tsconfig alias rules, discovers files, then:
  1. **Prune**: `findDependentsOfDeletedFiles` runs *before* `pruneDeletedFiles` deletes stale
     `files` rows (`index-codebase.ts:267-269`), so the join can still see rows for files that
     no longer exist on disk.
  2. **Select work set**: `mode: 'full'` processes every discovered file; `mode: 'incremental'`
     calls `findIncrementalFileSet` (`index-codebase.ts:145-178`), unioned with the deleted-file
     dependents (`index-codebase.ts:271-274`).
  3. **Parse concurrently**: `Promise.all(filesToProcess.map(parseFile...))`
     (`index-codebase.ts:277-279`) — reads file, sha256-hashes it, builds module
     identity/aliases, parses with tree-sitter, extracts symbols + reference candidates
     (`parseFile`, `index-codebase.ts:76-123`); failures are caught per-file
     (`ProcessedFileFailure`).
  4. **Persist symbols/exports**: `applyProcessedFiles` (`index-codebase.ts:180-207`) calls
     `persistProcessedFile` per success — `insertFile` upsert (`queries.ts:71-92`), then
     `clearFileRows` **hard-deletes** that file's existing
     `module_aliases`/`module_exports`/`symbol_references`/`symbols` rows (`queries.ts:12-17`,
     called at `index-codebase.ts:133`) before re-inserting fresh ones.
  5. **Resolve references**: `persistResolvedReferences` (`index-codebase.ts:209-251`) loads
     **all** symbols/files/module_aliases from the whole DB once (lines 213-215), then for each
     reprocessed file calls `resolveReferenceCandidates` and inserts one `symbol_references` row
     per candidate via individual `INSERT` statements (lines 229-242) — no explicit transaction
     wrapping anywhere in this file or `queries.ts`.
- Returns an `IndexSummary` (`index-codebase.ts:34-42`): `filesIndexed`, `filesFailed`,
  `filesPruned`, `symbolsIndexed`, `referencesIndexed`, `referencesUnresolved` (count of rows
  where `targetSymbolId === null`), `elapsedMs`.

### `src/resolver/resolve-references.ts` — name/module resolution
- `normalizeRelativeModule` (`resolve-references.ts:51-57`): resolves a `.`-relative specifier
  against the current file's directory and strips a trailing extension-looking suffix; bare
  specifiers (npm packages, tsconfig aliases) pass through unchanged.
- `findMatchedFileId` (`resolve-references.ts:59-72`): checks `module_aliases.alias_key` first,
  then `files.module_key`; returns `null` for anything unresolvable (bare package names,
  missing files, non-code assets, out-of-root paths).
- `findResolvedSymbol` (`resolve-references.ts:74-119`) — 3-tier, in order:
  1. **`resolved`**: a same-file running `importMap` populated as earlier `'imports'`
     references in the *same* reference array are resolved (`resolve-references.ts:80-83`,
     `131-133`) — this is a **single left-to-right pass**, so a call referencing an import that
     appears later in traversal order than the call itself won't hit this branch.
  2. **`resolved`**: export-name match within the specifier-resolved file
     (`resolve-references.ts:85-95`).
  3. **`file_resolved` / `name_only`**: bare `localName` match (`resolve-references.ts:97-113`).
     Critically, when a module specifier **is present but unresolvable to a file**
     (`matchedModuleKey === null && reference.targetModuleSpecifier !== null`), the lookup is
     `symbol.localName === reference.targetName` with **no module scoping at all**
     (`resolve-references.ts:102-106`, the `: true` branch) — i.e. it matches *any* same-named
     symbol anywhere in the whole codebase. This exact branch is not covered by
     `tests/resolver/resolve-references.test.ts` (only the null-specifier and resolved-file
     cases are asserted there).
- `resolveReferenceCandidates` (`resolve-references.ts:121-144`) is a pure function over
  in-memory arrays — no DB access itself, called once per file from `index-codebase.ts`.

### `src/resolver/module-specifiers.ts`
- `buildModuleIdentity` (`module-specifiers.ts:16-39`): `moduleKey` = POSIX-normalized,
  extension-stripped relative path. Always emits an `'extensionless'` alias (precedence 100).
  If the path ends in `/index`, also emits an `'index_collapse'` alias for the parent
  directory (precedence 90) — this is what lets `import x from './subdir'` resolve to
  `subdir/index.ts`.

### `src/resolver/tsconfig-paths.ts`
- `readTsconfig` (`tsconfig-paths.ts:20-43`) uses the real TypeScript compiler
  (`ts.readConfigFile` + `ts.parseJsonConfigFileContent`), so `extends` chains are followed
  natively, and reads the internal (undocumented, not in public `.d.ts`) `pathsBasePath`
  runtime property (lines 32-35, explicitly commented as such) to get the correctly-inherited
  `baseUrl`.
- `expandTsconfigPathRules` (`tsconfig-paths.ts:45-58`) resolves every `compilerOptions.paths`
  entry's replacement targets to absolute paths.
- `expandTsconfigAliasesForFile` (`tsconfig-paths.ts:63-97`) **only handles wildcard (`*`) path
  patterns** — `if (wildcardIndex === -1) return []` (lines 74-76) silently drops any
  exact/non-wildcarded `paths` mapping (e.g. `"@utils": ["src/utils/index.ts"]`), so those
  never produce an alias.
- `loadTsconfigPathAliases` (`tsconfig-paths.ts:60-61`) flat-maps over `config.tsconfigPaths`
  (default `['tsconfig.json']`, `config.ts:17`) — multiple tsconfig files can be manually
  listed (useful for monorepos) but there is no auto-discovery of nested `tsconfig.json` files
  or workspace/project-reference resolution.

### `src/impact.ts` — impact analysis
- The entire file is a 6-line re-export barrel (`impact.ts:1-6`) of
  `findIncomingReferences`/`findSymbolCandidates` from `src/search/index.ts`.
- `findIncomingReferences` (`search/index.ts:43-90`): looks up the target symbol by **exact**
  `qualified_name` or `symbol_key` (lines 48-53); returns `[]` with no fuzzy fallback if no
  exact match (lines 55-57). Then does a single SQL query: `symbol_references` joined to
  `files` (source) and LEFT JOINed to `symbols` (source) filtered by `target_symbol_id = ?`,
  ordered `confidence = 'resolved' DESC, line_number ASC`, `LIMIT ?` (lines 59-82).
- This is a **single-hop, incoming-only** "who references this exact symbol" query — no
  transitive/multi-level blast-radius traversal, no outgoing-dependency direction, and no
  total-match count returned alongside the (silently) truncated `limit`-capped array.
- `findSymbolCandidates` (`search/index.ts:35-41`) is exact-first symbol lookup with FTS
  fallback, used by MCP's `code_symbol` tool and, indirectly, as the typical way a caller
  discovers the `qualifiedName` to feed into impact.

---

## 2. End-to-end data flow (file on disk → DB rows)

1. `discoverSourceFiles` (`discover.ts:62`) walks `config.roots`, returns `DiscoveredFile[]`
   (absolute/relative path + extension), filtered by `.gitignore` + `config.exclude` +
   `config.languages`.
2. `indexCodebase` (`index-codebase.ts:253`) computes the work set (all files, or an
   incremental subset — see below), then for each file runs `parseFile`
   (`index-codebase.ts:76`) concurrently via `Promise.all`:
   - `readFile` → UTF-8 source string.
   - `sha256(source)` → `fileHash`.
   - `buildModuleIdentity(relativePath)` → `moduleKey` + local aliases
     (`module-specifiers.ts:16`), plus `expandTsconfigAliasesForFile` → tsconfig-path aliases
     (`tsconfig-paths.ts:63`).
   - `parserLoader.createParserForExtension(ext)` → tree-sitter `parser.parse(source)` → `Tree`.
   - `extractReferenceCandidates({source, tree, ...})` → `{ moduleExports, references }`.
   - `extractSymbolsFromSource({source, tree, ...})` → `ExtractedSymbol[]`.
3. `applyProcessedFiles` (`index-codebase.ts:180`) persists each success via
   `persistProcessedFile` (`index-codebase.ts:125`):
   - `insertFile` upserts the `files` row (`queries.ts:71`, keyed on unique `file_path`).
   - `clearFileRows` hard-deletes any existing
     `module_aliases`/`module_exports`/`symbol_references`/`symbols` for that `file_id`
     (`queries.ts:12`).
   - `persistAliases` → `module_aliases` rows (`queries.ts:106`).
   - `persistSymbols` → `symbols` rows, then `linkParentSymbols` back-fills `parent_symbol_id`
     via a `qualified_name` lookup scoped to the same `file_id` (`queries.ts:117`, `159`).
   - `persistModuleExports` → `module_exports` rows, matching each export candidate to a
     just-inserted symbol by `localName` (`queries.ts:196`).
   - Failures go through `markParseFailure` instead (`queries.ts:94`, sets
     `parse_status='parse_failed'`, clears any prior rows for that path).
4. `persistResolvedReferences` (`index-codebase.ts:209`) loads the **entire**
   `symbols`/`files`/`module_aliases` tables into memory
   (`selectAllSymbols`/`selectAllFiles`/`selectAllModuleAliases`, `queries.ts:216-249`), then
   for each reprocessed file calls `resolveReferenceCandidates` (`resolve-references.ts:121`)
   and `INSERT`s one `symbol_references` row per reference candidate
   (`index-codebase.ts:229-242`), each row carrying `confidence` ∈
   `resolved | file_resolved | name_only` and a nullable `target_symbol_id`/`target_file_id`.
5. The FTS5 virtual table `symbol_fts` is kept in sync automatically via
   `AFTER INSERT/UPDATE/DELETE` triggers on `symbols` (`schema.ts:99-112`) — no separate
   FTS-population step in the pipeline code.
6. Reads happen later, independently, through `src/search/index.ts`
   (`searchSymbols`/`findSymbolCandidates`, exact match in `search/exact.ts` + FTS in
   `search/fts.ts`, reranked in `search/rank.ts`) and `findIncomingReferences` (impact), all
   exposed via CLI (`cli.ts:38-63`) and MCP tools (`mcp/server.ts`, `mcp/tools.ts`).

---

## 3. Concrete limitations & gaps

**Languages.** Hard-coded to exactly `ts | tsx | js | jsx` (`types.ts:1`, `parser.ts:42-55`).
No Python/Go/Rust/Vue-SFC/Svelte/JSON/CSS/Markdown support, no plugin mechanism for adding
grammars.

**Reference resolution is name/text-based, not type-aware.** There is no TypeScript
`Program`/`TypeChecker` anywhere in the pipeline — `typescript` is imported only in
`tsconfig-paths.ts` to parse `tsconfig.json`'s `paths`/`baseUrl`/`extends` (`tsconfig-paths.ts:4`,
`21-26`), never to type-check or resolve symbols. All resolution is string equality on
`localName`/`qualifiedName`/`exportNames`/module specifiers (`resolve-references.ts:80-113`).

**Member/property calls essentially never resolve.** `collectCallReference` captures the
callee's raw source text verbatim (`extract-references.ts:253`), so `obj.method()` produces
`targetName: "obj.method"`, `this.foo()` produces `"this.foo"`, `ns.helper()` (namespace
import) produces `"ns.helper"`. Resolution matches against a symbol's *bare* `local_name`
(`resolve-references.ts:101`), so none of these dotted strings can ever match — only plain
function-name calls (`foo()`) resolve.

**Unresolvable-specifier fallback searches the whole codebase by bare name.** When an import
specifier is present but doesn't resolve to a known file/alias (bare npm package, workspace
package without a path alias, path outside indexed roots), resolution falls back to matching
*any* symbol anywhere with the same local name (`resolve-references.ts:97-107`, the `: true`
branch) — a same-named unrelated local symbol can be incorrectly attributed as the target. This
path is exercised by production code but not by the visible unit tests.

**Dead/unused edge types.** `ReferenceEdgeType` declares
`imports | reexports | calls | extends | implements | references` (`types.ts:7`), but
`extends`/`implements`/`references` are never constructed anywhere in `src/` (verified by
exhaustive grep) — class inheritance (`extends`/`implements` clauses) and generic "identifier
read" references are simply not tracked, despite the schema/type system being built for them.

**Not extracted at all** (confirmed absent in code and cross-checked against tree-sitter's
`node-types.json`):
- `class Foo extends Bar` / `implements Baz` (`class_heritage`/`extends_clause`/
  `implements_clause` nodes unhandled).
- Type-level references — parameter/return/property type annotations, generics
  (`type_identifier` nodes unhandled) — so renaming an `interface`/`type` won't surface
  "impact" on its type-only usages.
- JSX/TSX component usage — `jsx_element`/`jsx_opening_element`/`jsx_self_closing_element` are
  entirely unhandled, even though `.tsx`/`.jsx` are first-class supported languages.
  `<Button onClick={...} />` produces zero reference edge to `Button`. This means `code_impact`
  will systematically undercount usage for any component-based (React-style) codebase.
- `import * as ns from 'x'` (namespace imports) — the `namespace_import` grammar node is never
  matched, so no `'imports'` edge is ever created for it (confirmed against
  `tree-sitter-typescript`'s `node-types.json`, which shows `import_clause` can contain
  `identifier | named_imports | namespace_import`, only the first two are handled in
  `extract-references.ts:274-284`/`230-242`).
- `export * from './x'` and `export * as ns from './x'` (bare re-export-all / namespaced
  re-export-all) — `export_statement`'s possible children include `namespace_export` (per
  grammar), but `collectExportCandidates` (`extract-references.ts:183-228`) has no case for it
  or for a bare `*`; such statements fall through to a no-op generic visit. **Barrel files
  built on `export * from` are invisible to the indexer** — only `export { x } from './y'`
  (named re-export) is captured.
- `import x = require('y')` (`import_require_clause`) and CommonJS `require('y')` — plain
  `require(...)` calls are only ever captured as a generic, unresolved `'calls'` edge with
  `targetName: "require"`; there is no CommonJS import/module resolution.
- Dynamic `import('./mod')` — per the JS grammar, this is a `call_expression` whose `function`
  field is a distinct `import` node type; `collectCallReference` captures its text as
  `targetName: "import"` (the bare keyword), never the module-specifier argument — dynamic
  imports produce meaningless noise edges, not resolved module dependencies.
- Interface members (`property_signature`/`method_signature`) and enum members
  (`enum_assignment`) are not extracted as individual symbols — only the parent
  `interface_declaration`/`enum_declaration`, confirmed absent from `declarationTypes`
  (`extract-symbols.ts:40-51`) though present in the TS grammar.
- Docstrings: only JSDoc `/** ... */` blocks immediately preceding a declaration (no blank
  line) are captured via `readLeadingDocComment` (`extract-symbols.ts:66-84`); plain `//` line
  comments are explicitly dropped (the loop `unshift`s the line, then breaks without returning
  anything once it sees a non-`*`/non-`*/`-ending line, so a `//` comment yields `docText: ''`).
- No control-flow, no data-flow, no true call-graph (edges are 1-hop "textually appears inside
  function X and calls name Y", not a resolved/verified call graph).

**Incremental indexing — real gaps, not just "supported/unsupported."**
- Incremental mode still reads and SHA-256-hashes *every* discovered file on every run to
  compute the changed set (`findIncrementalFileSet`, `index-codebase.ts:145-151`, called with
  the full `discoveredFiles` list at line 270) — so incremental mode saves CPU parse/extract
  time and DB writes, but **not** disk I/O, which stays O(total files) every run. No mtime/size
  shortcut, no file watcher (`watch` does not appear anywhere in `src/`).
- Dependent-file invalidation is **single-hop only**: `findIncrementalFileSet` finds direct
  importers of changed files via one SQL join (`index-codebase.ts:162-175`), but does not
  transitively chase importers-of-importers.
- Combined with schema FK `ON DELETE SET NULL` on `symbol_references.target_symbol_id`
  (`schema.ts:56`) and `clearFileRows`'s hard `DELETE FROM symbols WHERE file_id = ?`
  (`queries.ts:16`, invoked per reprocessed file at `index-codebase.ts:133`): when a file 1 hop
  away is reprocessed, its `symbols` rows get new autoincrement IDs, and SQLite's FK cascade
  auto-nulls `target_symbol_id` in *any* other file's `symbol_references` rows that pointed at
  the old IDs — including 2+-hop files that were never reprocessed. Those far-away references
  silently become unresolved (`target_symbol_id = NULL`) and are **never automatically
  repaired** until that far-away file itself changes or a full reindex runs. No dangling/invalid
  pointers occur (FK integrity is preserved), but completeness silently degrades after
  incremental runs on deep dependency chains.
- No transaction batching: every alias/symbol/export/reference is its own
  `db.query(...).run(...)` call (`queries.ts`, `index-codebase.ts:229-242`) with no
  `db.transaction`/`BEGIN`/`COMMIT` wrapping found anywhere in `src/` — likely a real throughput
  bottleneck on large full-reindexes even though SQLite is in WAL mode (`storage/db.ts:5`).
- Schema changes are not migrated: `ensureSchema` drops and recreates all tables whenever
  `SCHEMA_VERSION` is bumped (`schema.ts:115-137`) — no column-level migration path, just full
  wipe + re-run of `indexCodebase`.

**Performance / scaling characteristics.**
- Single-threaded: no `Worker`/`worker_threads` usage anywhere in `src/` (grep confirmed empty)
  — `Promise.all` around `parseFile` (`index-codebase.ts:277-279`) overlaps file-read I/O
  latency but the CPU-bound tree-sitter parse + tree walks still execute serially on Bun's main
  thread.
- `persistResolvedReferences` loads the *entire* symbol/file/alias tables into JS arrays
  (`index-codebase.ts:213-215`) and `resolveReferenceCandidates` does linear `.find()`/
  `.filter()` scans over all symbols per reference candidate (`resolve-references.ts:85-113`) —
  effectively O(references-in-changed-files × total-symbols-in-codebase); on a full reindex of a
  large codebase this is a quadratic-shaped cost, not indexed lookups.
- No explicit file-size guard: `readFile(..., 'utf8')` loads the whole file into memory
  unconditionally (`index-codebase.ts:83`); only the *stored* `bodyText` is clipped to
  `maxStoredBodyLines` (default 120, `config.ts:16`, `extract-symbols.ts:64`,`128`) — parsing
  itself is unbounded, so an accidentally-included very large/generated/minified file has no
  safety valve.
- `signatureText` only captures the single source line where a declaration starts
  (`extract-symbols.ts:126`) — multi-line function signatures/generics are truncated in the
  stored preview (though `startLine`/`endLine`/`bodyText` remain accurate for the full span).

**Monorepo / multi-package handling.**
- `.gitignore` is read once from `repoRoot` only (`discover.ts:24-30`) — nested per-package
  `.gitignore` files are not merged/respected.
- `tsconfigPaths` (`config.ts:17`, default `['tsconfig.json']`) can be manually extended with
  multiple tsconfig files (one per package) and each is expanded independently
  (`tsconfig-paths.ts:60-61`), so cross-package path-alias resolution is *possible* but requires
  the user to enumerate every package's tsconfig explicitly — there's no auto-discovery of
  nested `tsconfig.json`s, TS project references, or `package.json` `workspaces`.
- No `node_modules` resolution and no `package.json` `main`/`exports` resolution at all — bare
  specifiers (npm packages, or workspace packages referenced by published name rather than a
  relative path/tsconfig alias) can only "resolve" via the risky whole-codebase bare-name
  fallback described above, or remain fully unresolved.
- Everything lands in one shared SQLite DB with one flat `moduleKey` namespace per configured
  `repoRoot`/`dbPath` (`config.ts:41`, `storage/db.ts:3`) — there is no per-package
  partitioning; running against a monorepo root means one giant shared index, or the user must
  run codeindex separately per package (each MCP invocation operates on the caller's `cwd`, per
  `CLAUDE.md:34`).
- Non-wildcard tsconfig `paths` entries are dropped entirely (`tsconfig-paths.ts:74-76`), a
  common pattern for pointing a package's short name at its `src/index.ts`.

---

## 4. Notable design decisions

- **Byte-offset-derived symbol identity.** `symbolKey` embeds the node's
  `startIndex-endIndex` byte offsets (`extract-symbols.ts:120`), so any structural edit
  *earlier* in a file shifts every downstream symbol's `symbolKey`, even if that symbol's own
  text didn't change. Combined with `clearFileRows` doing a full delete+reinsert per file
  (`queries.ts:12-17`), DB row IDs (`symbols.id`) are never stable across reindexes of a given
  file either — external callers should treat `symbolKey`/numeric IDs as ephemeral within a
  single index generation, not durable identifiers across edits.
- **Confidence is a first-class, queryable column**, not just an internal detail:
  `resolved | file_resolved | name_only` is persisted per reference row (`schema.ts:62`) and
  used directly in ranking (`search/index.ts:79`, ORDER BY `confidence = 'resolved' DESC`) —
  callers of `code_impact` can distinguish high-confidence vs. heuristic matches, though
  `file_resolved` also covers the "file matched but symbol lookup came up empty" case
  (`targetSymbolId: null` with `confidence: 'file_resolved'`, `resolve-references.ts:115-118`),
  which reads as more confident than it is.
- **FTS5 is trigger-maintained**, not pipeline-maintained: `symbol_fts` syncs off `symbols` via
  `AFTER INSERT/UPDATE/DELETE` triggers (`schema.ts:99-112`) with a custom tokenizer
  (`unicode61`, underscores/hyphens as token chars, `prefix='2 3'`) — the indexing code never
  touches FTS directly, it's a pure side effect of writing to `symbols`.
- **`.jsx` and `.js` intentionally share one grammar** (tree-sitter-javascript natively parses
  JSX), while `.tsx` gets tree-sitter-typescript's dedicated TSX grammar, separate from plain
  `.ts` (`parser.ts:57-69`) — a deliberate grammar-selection split rather than
  one-grammar-fits-all.
- **`ensureSchema` is a wipe-and-rebuild migration strategy** gated by a single
  `SCHEMA_VERSION` constant and `PRAGMA user_version` (`schema.ts:115-138`) — simple but
  destructive; any schema change requires a full reindex.
- **Impact analysis is deliberately scoped to exact-symbol, single-hop, incoming-only**
  (`search/index.ts:43-90`) — it is explicitly a "find references" primitive layered on the
  same `symbol_references` table as search, not a separate blast-radius/graph-traversal engine;
  `src/impact.ts` itself contains zero logic, it's purely a re-export seam (`impact.ts:1-6`).
- **Incremental dependency invalidation is join-based against already-stored data**, not
  AST-diff-based — it reuses the exact same `symbol_references` table that search/impact reads,
  so the same one-hop join query pattern (`index-codebase.ts:162-175`) appears twice, once for
  changed files (`findIncrementalFileSet`) and once for deleted files
  (`findDependentsOfDeletedFiles`, `queries.ts:35-69`).
- **Full-repo config is intentionally simple**: one `repoRoot`, one `dbPath`, arrays for
  `roots`/`exclude`/`tsconfigPaths` (`config.ts:6-18`) — no per-root or per-language override
  granularity (e.g. can't set different `exclude` for different `roots`).
