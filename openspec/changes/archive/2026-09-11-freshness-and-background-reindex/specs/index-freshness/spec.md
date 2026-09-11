# index-freshness Specification (delta)

## Purpose

Query-time freshness truth for indexed results: every hit and every response
reports whether it reflects the current state of the repository, so agents can
distinguish a trustworthy answer from one served while the index is catching
up. This is the honesty layer that makes background reindexing safe.

## ADDED Requirements

### Requirement: Per-hit freshness marks on MCP query results

Every result in `code_search`, `code_symbol`, and `code_impact` responses SHALL
carry a `freshness` field with value `fresh` or `possibly_stale`. The field
SHALL appear in both the text payload and the `structuredContent` payload for
each tool.

#### Scenario: Unmodified file reports fresh
- **WHEN** a query returns a hit whose file's stored `indexed_at` is at or after the file's current mtime
- **THEN** the result carries `freshness: "fresh"` in both payloads

#### Scenario: Deleted file reports possibly_stale
- **WHEN** a query returns a hit whose file no longer exists on disk (stat fails)
- **THEN** the result carries `freshness: "possibly_stale"` in both payloads

### Requirement: Freshness determination rules

Freshness SHALL be determined at query time per hit: the hit's file is `fresh`
when the stored `indexed_at` is at or after the file's current mtime; when the
mtime is newer, the current file content SHALL be hashed and compared against
the stored `file_hash` — an equal hash keeps the hit `fresh` (touch and
checkout-without-content-change do not falsely stale), a differing hash makes
it `possibly_stale`; any stat or read failure SHALL be treated as
`possibly_stale` (conservative when evidence is missing).

#### Scenario: Content unchanged after touch stays fresh
- **WHEN** a file's mtime is newer than its stored `indexed_at` but its content hashes identically to the stored `file_hash`
- **THEN** the hit is `fresh`

#### Scenario: Content changed since indexing is possibly_stale
- **WHEN** a file's mtime is newer than its stored `indexed_at` and its content hash differs from the stored `file_hash`
- **THEN** the hit is `possibly_stale`

### Requirement: Freshness marks never affect ranking

Freshness SHALL be presentation metadata only: it SHALL NOT alter
`rankScore`, result ordering, scope tiers, or match types. The existing
exact-first semantics (exact local-name, qualified-name, and export-name
matches before FTS fallback) SHALL be preserved unchanged. Expected effect on
the bench oracle gates: IR search and code_impact baselines stay flat on both
the repo-local and papai corpora; only the index-count baseline may be
regenerated, and only for the schema change below.

#### Scenario: Search ordering identical with and without freshness marks
- **WHEN** the same query runs against the same database with freshness checking enabled and disabled
- **THEN** the result order, `rankScore` values, and match types are identical; only the `freshness` field differs

### Requirement: Response-level index freshness state

Every `code_search`, `code_symbol`, and `code_impact` response SHALL carry a
response-level `indexFreshness` field (`fresh` or `possibly_stale`) in both
payloads. It SHALL be `possibly_stale` exactly when an index catch-up (reindex)
is pending or in flight for the repository, and `fresh` when no drift evidence
exists. It SHALL NOT guess staleness from git state.

#### Scenario: Query during background reindex reports possibly_stale
- **WHEN** a query is served while a startup catch-up or watcher-triggered reindex is pending or in flight
- **THEN** the response carries `indexFreshness: "possibly_stale"` in both payloads, while per-hit marks continue to report per-file truth

#### Scenario: Query with no pending reindex reports fresh
- **WHEN** no reindex is pending or in flight
- **THEN** the response carries `indexFreshness: "fresh"` even if individual hits are `possibly_stale` (per-hit truth is not overwritten)

### Requirement: Epoch-millisecond per-file index timestamps

The `files.indexed_at` column SHALL store epoch milliseconds as INTEGER,
written by the indexer at upsert time, replacing the second-resolution ISO
text form. The index-wide `index_meta.indexed_at` SHALL remain human-readable
ISO text.

#### Scenario: Timestamps support millisecond freshness comparison
- **WHEN** a file is indexed and re-stat immediately after
- **THEN** the stored `indexed_at` is comparable against `mtimeMs` with millisecond precision without locale-dependent date parsing

### Requirement: Schema v5 rebuild migration

Bumping the stored schema version to v5 SHALL follow the established
wipe-and-rebuild convention: on first open of an existing `.codeindex/index.db`
at version 4, all tables are dropped and recreated (WAL mode and
`PRAGMA foreign_keys` handling unchanged), which forces a full reindex on next
indexing and clears any legacy `identifier_terms` token drift from
pre-upgrade incremental indexes. Fresh databases are created at v5 directly.

#### Scenario: Existing database migrates by wipe-and-rebuild
- **WHEN** a v4 database is opened after this change
- **THEN** its tables are dropped and recreated at schema v5, the first indexing run rebuilds the full corpus, and search results reflect the current tokenizer uniformly

#### Scenario: WAL behavior unchanged across migration
- **WHEN** the v4-to-v5 migration runs on a database opened in WAL mode
- **THEN** the database remains in WAL mode with the same `-wal`/`-shm` sibling files while open
