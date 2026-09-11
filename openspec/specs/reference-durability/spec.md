# Reference Durability

## Purpose

The durability contract for the reference graph: cross-file reference edges survive incremental and watcher reindexes, orphaned edge targets are repaired from stored identity without manufacturing edges a full reindex would not produce, existing databases self-heal, and empty `code_impact` responses explain themselves.

## Requirements

### Requirement: Reference edges survive reindexes

After any indexing run completes (full, incremental, or watcher-triggered), `code_impact` results for a stable target symbol SHALL equal the results a fresh full reindex of the same tree would produce, including edges whose source file was not part of the reindexed batch.

#### Scenario: Editing a dependency does not blind impact

- **WHEN** a file that defines a called function is edited and an incremental reindex completes, and a second file that calls it is untouched by that batch
- **THEN** `code_impact` on the called function still reports the call site from the untouched file with `resolved` confidence

#### Scenario: Repeated watcher batches do not degrade the graph

- **WHEN** a sequence of file edits triggers repeated watcher reindexes within one session
- **THEN** impact results remain equal to full-reindex ground truth after each batch, rather than accumulating orphaned, invisible edges

### Requirement: Post-batch repair re-matches orphaned targets

After persisting references in an indexing run, the system SHALL re-match every reference edge whose target symbol binding is NULL, deriving the resolver's scope from stored edge and index data (source file module, target module specifier via module aliases and the file table) and matching the stored target name against live symbols' local names within that scope; a unique match SHALL re-establish the target symbol binding and target file binding.

#### Scenario: Orphaned edge is re-linked

- **WHEN** an edge's target symbol was re-created by a reindex of its defining file, and the stored target name matches exactly one live symbol in the derived scope module
- **THEN** the edge's target symbol and target file bindings are restored within that same indexing run, and `code_impact` reports the edge again

#### Scenario: Module-scoped matching follows resolver semantics

- **WHEN** an orphaned edge's stored target module specifier no longer resolves to any file or alias
- **THEN** the edge is not re-matched against symbols from unrelated modules (no codebase-wide name guessing)

#### Scenario: Never-resolved edges get the same re-match chance

- **WHEN** an edge was stored with a NULL target because resolution failed in an earlier run (for example, its import was encountered in a later traversal pass), and its target now exists in the derived scope
- **THEN** the re-match restores the binding under the same uniqueness rule as orphaned edges

### Requirement: Repair never manufactures edges

Repair SHALL NOT create a target binding that a fresh full reindex under the same tree would not produce. When the stored target name matches zero or multiple live symbols in the derived scope, the edge SHALL remain unbound with its stored confidence unchanged, staying invisible to `code_impact` rather than surfacing with a guessed target.

#### Scenario: Ambiguous name is left unbound

- **WHEN** a stored target name matches two or more live symbols in the derived scope module
- **THEN** the edge keeps a NULL target binding and its original confidence value, and `code_impact` does not return it

#### Scenario: Stored confidence is preserved

- **WHEN** an edge with a non-`resolved` stored confidence acquires a re-matched target
- **THEN** its confidence value is unchanged, and ordering of `code_impact` results still prefers `resolved` edges first

### Requirement: In-degree counts repaired edges

Symbol in-degree SHALL be recomputed to include repaired edges before the repair transaction commits, so that a single indexing run never serves in-degree values that exclude edges it just repaired.

#### Scenario: In-degree reflects a healed edge in the same run

- **WHEN** an indexing run repairs an edge targeting a symbol
- **THEN** that symbol's in-degree, as returned by search results completing in the same or later runs, counts the repaired edge

### Requirement: Existing databases self-heal without migration

The repair pass SHALL run on the first indexing run performed by an upgraded build — including the MCP server's startup catch-up — requiring no schema migration, no wipe-and-rebuild, and no stored schema-version bump; repair executes inside the serialized writer transaction, leaving WAL mode and concurrent-reader behavior unchanged.

#### Scenario: Pre-upgrade orphaned database heals on first start

- **WHEN** an existing `.codeindex/index.db` contains orphaned reference edges produced by an older build, and the MCP server starts and completes its startup catch-up (or a CLI `reindex` runs)
- **THEN** previously orphaned edges that are uniquely re-matchable are bound again and visible to `code_impact`, with no manual migration step

#### Scenario: Query-only sessions are unaffected structurally

- **WHEN** repair runs while a reader holds the database open in WAL mode
- **THEN** queries continue to serve (stale-marked per the freshness contract) without `SQLITE_BUSY` failures introduced by repair

### Requirement: Empty code_impact responses carry guidance

When `code_impact` returns zero results, the tool response SHALL include a `guidance` string in both the text payload and `structuredContent`, suggesting verification of the symbol name via exact symbol lookup and noting that a full reindex rebuilds the reference graph; when results are non-empty, the response SHALL NOT include a `guidance` field.

#### Scenario: Empty impact result explains itself

- **WHEN** `code_impact` is called with a validly formed name that matches no incoming references
- **THEN** the text payload includes the guidance message and `structuredContent` includes the same `guidance` string

#### Scenario: Non-empty impact result keeps its shape

- **WHEN** `code_impact` returns one or more references
- **THEN** the response shape is unchanged from before this capability and contains no `guidance` field

### Requirement: Search semantics are unchanged

`code_search` and `code_symbol` responses SHALL be unchanged by repair activity: exact-first ordering, `matchedBy` values, `rankScore` computation, scope tiers, and filters all behave exactly as before, and only `code_impact` result completeness and empty-result guidance move.

#### Scenario: Repaired graph does not perturb search

- **WHEN** a repair pass re-binds edges during an indexing run, and `code_search` executes afterward
- **THEN** results, their `matchedBy` values, and `rankScore` values are identical to those produced before the repair for the same query
