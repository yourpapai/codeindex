# Impact Lookup — delta: source-line snippet on ImpactResult

See `openspec/specs/impact-lookup/spec.md` for the full existing capability. This delta adds a clipped call-site snippet to every incoming-reference row and amends the canonical-key compatibility clause so the new field is allowed.

## ADDED Requirements

### Requirement: Incoming-reference rows carry a clipped source-line snippet

Each `code_impact` result row SHALL include a `snippet` string: the indexed source line at that reference's `lineNumber`, captured at index time. `snippet` SHALL be a single line (embedded newlines stripped or rejected at extract), truncated to at most 160 characters with a trailing ellipsis when cut. When the indexer could not capture a line (e.g. pathological source), `snippet` SHALL be the empty string — never a fabricated placeholder. Snippet content SHALL be index-snapshot text, consistent with `body_text` / search previews; it SHALL NOT be read from disk at query time.

`snippet` SHALL appear in `structuredContent.results[]`. The text channel SHALL remain a skim summary (`N incoming reference(s)` plus freshness/guidance) and SHALL not embed per-row snippets.

#### Scenario: Call-site line is returned on structuredContent

- **WHEN** `code_impact` resolves a symbol and returns incoming references
- **THEN** every `structuredContent.results[]` row includes `snippet` equal to the source line stored for that reference (minus trailing whitespace), and the text payload does not paste those snippets

#### Scenario: Long source line is clipped

- **WHEN** an indexed source line exceeds 160 characters
- **THEN** the stored `snippet` is the first 159 characters plus an ellipsis (or equivalent clip marker) and never contains a newline

#### Scenario: Import and re-export edges also carry snippets

- **WHEN** `code_impact` returns `imports` or `reexports` edges (which have no enclosing symbol)
- **THEN** those rows still include the import/export source line as `snippet`

#### Scenario: Unresolved identity still has empty results

- **WHEN** identity does not resolve (unknown or ambiguous)
- **THEN** `results` is empty as before; snippet requirements do not apply

### Requirement: Snippet density is fixed and preview-free

`code_impact` SHALL NOT accept a `preview` input in this change. Result `snippet` density SHALL be the single clipped line specified above. Identity resolution order, `limit` semantics, `edgeType`, `confidence`, `lineNumber`, freshness marks, and guidance rules SHALL be unchanged.

#### Scenario: Existing callers need no new arguments

- **WHEN** a client calls `code_impact` with only `symbolKey`/`qualifiedName`/`limit`/`refresh`
- **THEN** the call succeeds and every result row still carries `snippet`

### Requirement: Storage captures line text at index time

`symbol_references` SHALL persist the clipped source line per edge at insert time. Existing `.codeindex/index.db` files SHALL migrate via the project's wipe-and-rebuild policy (schema version bump): opening an older DB triggers drop-and-recreate and the next index run backfills snippets. WAL mode and concurrent readers SHALL continue to work; a partially migrated DB SHALL not serve mismatched columns. Repair/rematch of orphaned references SHALL preserve the original `line_text` unless the source file is re-extracted.

#### Scenario: Older DB rebuilds and gains snippets

- **WHEN** a DB stamped with the previous schema version is opened
- **THEN** tables are rebuilt at the new version and a subsequent full or incremental index populates `snippet` on new reference rows

#### Scenario: Repair keeps the stored line

- **WHEN** reference repair rematches an orphaned row's target without re-parsing the source file
- **THEN** the row's `snippet` remains the previously stored source line

## MODIFIED Requirements

### Requirement: Canonical-key compatibility and revert safety

Exact `symbol_key` / `qualified_name` lookups SHALL keep the same resolved identity, incoming-reference row *set*, and per-row values of `sourceQualifiedName`, `sourceFilePath`, `edgeType`, `confidence`, and `lineNumber` as before this change. Additional preview fields (`snippet`) SHALL be allowed and are not part of the byte-identical contract. CLI `impact` and benchmark oracles that score source identity SHALL continue to pass impact baseline gates without re-stamping; a JSON shape that merely adds `snippet` is not a scoring regression. Behavior changes SHALL remain isolated so a regression can be reverted without further data migration beyond reindex.

#### Scenario: Bench and CLI callers keep their contract

- **WHEN** the incoming-reference lookup is invoked with exact `qualified_name` keys by the benchmark harness, edit-fuzz oracle, impact scorer, or CLI `impact`
- **THEN** the ordered set of sources and the identity/location/edge/confidence fields match pre-change behavior; `snippet` may be present as an extra field and does not alter FN/FP scoring

#### Scenario: Canonical identity path is unchanged

- **WHEN** `code_impact` is called with an exact `symbol_key` or `qualified_name`
- **THEN** `identity` resolution and the reference row set are identical to pre-change behavior except for the added `snippet` field
