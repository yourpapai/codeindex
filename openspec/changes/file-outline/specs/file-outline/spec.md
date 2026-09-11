## Purpose

Navigation primitive for structure questions: list a file's indexed symbols and a module's export surface without ranking or whole-file reads, so agents stop falling back to reading entire files when they only need an outline or the public API.

## ADDED Requirements

### Requirement: Outline tool identity and mode

The MCP server SHALL expose a `code_outline` tool that accepts a repo-relative `filePath` (exact match against indexed `files.file_path`) and a required `mode` of `"symbols"` or `"exports"`. Callers SHALL NOT need a non-empty free-text `query`. The tool SHALL NOT perform BM25/FTS ranking, SHALL NOT emit `rankScore` or `matchedBy`, and SHALL NOT change `code_search` / `code_symbol` contracts.

#### Scenario: Exact file path required

- **WHEN** `code_outline` is called with `filePath` equal to an indexed path such as `src/mcp/tools.ts`
- **THEN** the tool returns outline rows for that file
- **AND** when called with a path that is not an indexed `files.file_path` (including near-misses such as a missing suffix), the tool returns zero rows and a guidance string stating the path was not indexed

#### Scenario: Mode is required

- **WHEN** `code_outline` is called without `mode`
- **THEN** input validation rejects the call

#### Scenario: Search tools unchanged

- **WHEN** `code_outline` exists in the tool inventory
- **THEN** `code_search` and `code_symbol` still require a non-empty `query`, and their exact-first / FTS semantics are unchanged

### Requirement: Symbols mode lists in-file structure

In `mode: "symbols"`, the tool SHALL return one row per matching `symbols` row for the file, ordered by `start_line` ascending. Each row SHALL include at least: `localName`, `kind`, `scopeTier`, `startLine`, `endLine`, `symbolKey`, `qualifiedName`, `signatureText`, and `exportNames`. Rows SHALL NOT include `body_text` or `doc_text` unless a future preview expansion is explicitly requested. Default `scopeTiers` SHALL exclude `"local"` so function-local declarations do not drown the outline. Callers MAY pass `scopeTiers` and `kinds` to narrow the list. When the ordered list is truncated by `limit`, the text summary SHALL state that the list was truncated.

#### Scenario: Default excludes locals

- **WHEN** `code_outline` runs in symbols mode on a file that has both module-level and function-local indexed symbols
- **THEN** the default result contains exported/module/member rows only and omits `scopeTier: "local"` rows

#### Scenario: Ordered compact rows

- **WHEN** symbols mode returns multiple rows
- **THEN** rows are sorted by `startLine` and each row carries signature text without body text

#### Scenario: Limit truncation is disclosed

- **WHEN** matching rows exceed `limit`
- **THEN** the response contains at most `limit` rows and the text summary reports truncation

### Requirement: Exports mode reads module_exports

In `mode: "exports"`, the tool SHALL list rows from `module_exports` for the file, not from `symbols.export_names` alone. Each row SHALL include `exportName`, `exportKind`, `symbolId` (nullable), `qualifiedName` (nullable), and `targetModuleSpecifier` (nullable). Re-export and star rows SHALL appear even when they have no local `symbol_id`. A pure barrel file with zero local symbols and only re-export rows SHALL return those export rows rather than an empty list.

#### Scenario: Barrel with no local symbols

- **WHEN** exports mode is called on a file whose only indexed content is `export … from '…'` rows with `symbol_id` null
- **THEN** the result lists those export names with their `exportKind` and `targetModuleSpecifier`

#### Scenario: Local exports resolve names when available

- **WHEN** an export row has a non-null `symbol_id`
- **THEN** the row includes the linked symbol's `qualifiedName`

### Requirement: Response channels and freshness

`code_outline` SHALL return a skim text summary (file path, mode, result count, truncation/guidance) plus authoritative `structuredContent` with the ordered row array, following existing single-channel field rules. Indexed hits and the response SHALL carry the same freshness decoration as other query tools (`indexFreshness` and per-row `freshness` when applicable). Empty or failed calls SHALL not invent hits.

#### Scenario: Text is a skim summary

- **WHEN** symbols mode returns N rows
- **THEN** the text payload summarizes count, mode, and file path without embedding every full row

#### Scenario: Freshness accompanies results

- **WHEN** `code_outline` returns hits against an index that is possibly stale
- **THEN** the response includes the same freshness marks other query tools would emit for those files

### Requirement: Query-log identity for outline calls

Successful or failed `code_outline` calls SHALL be recorded in the query log with `tool = "code_outline"`, `query_text` set to the requested `filePath` (never null for a validation-passed call), and the existing `mode` column set to `"symbols"` or `"exports"`. Logging SHALL remain best-effort and SHALL never fail the tool call.

#### Scenario: FilePath is logged as query text

- **WHEN** a `code_outline` call is logged
- **THEN** `query_text` equals the `filePath` and is not classified as an empty query
