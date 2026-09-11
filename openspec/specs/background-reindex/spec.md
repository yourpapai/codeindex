# Background Reindex

## Purpose

Freshness maintenance for the index: the MCP server keeps the index aligned
with the repository without agent or human intervention — an in-process
watcher plus a startup probe feed incremental reindexes through the existing
indexing path under a single serialized writer. This removes the staleness
trap that otherwise blocks honest dogfooding.

## Requirements

### Requirement: Startup freshness probe with immediate serving

When the MCP server starts, it SHALL probe index staleness — a missing or
newly-migrated (wiped) database, stored paths absent from the repository
(discovered deletions), repository paths absent from the database (discovered
additions), and stored files whose mtime is newer than their stored
`indexed_at`. The server SHALL serve queries immediately regardless of probe
outcome; when the probe finds drift, it SHALL start a background reindex and
responses SHALL carry the response-level `possibly_stale` state until the
reindex completes.

#### Scenario: Cold-start worktree indexes in background
- **WHEN** the MCP server starts in a repository with no `.codeindex/index.db` (fresh worktree or first run)
- **THEN** the server serves queries immediately with `indexFreshness: "possibly_stale"` while the initial full index runs in the background, and `indexFreshness: "fresh"` once it completes

#### Scenario: Clean index skips the catch-up reindex
- **WHEN** the MCP server starts and the probe finds no drift (no added, deleted, or modified files)
- **THEN** no reindex is started and responses carry `indexFreshness: "fresh"`

### Requirement: In-session file watching triggers incremental reindex

While the MCP server runs, file-system events under the repository SHALL be
watched; events matching the repository's configured roots, languages, and
excludes SHALL be debounced and coalesced into incremental reindexes through
the existing incremental indexing path (changed files plus dependents of
changed and deleted files). Events outside the configured roots, excludes, or
languages SHALL NOT trigger a reindex.

#### Scenario: Edit during session triggers coalesced reindex
- **WHEN** multiple files are edited within the debounce window during a live session
- **THEN** exactly one incremental reindex covers all changed files after the debounce settles

#### Scenario: Ignored-path event does not trigger reindex
- **WHEN** a file event occurs under an excluded directory or for a non-indexed language
- **THEN** no reindex is triggered and watcher state remains `idle`

### Requirement: Single-writer reindex serialization

Agent-triggered indexing (`code_index`) and watcher-triggered reindexing SHALL
share one serialized reindex queue: at most one indexing run is active for the
repository at any time; triggers arriving during an active run SHALL coalesce
into at most one follow-up run rather than queueing per event.

#### Scenario: Concurrent triggers coalesce instead of stacking
- **WHEN** a watcher-triggered reindex is in flight and the agent invokes `code_index` (and additional file events arrive)
- **THEN** the runs serialize through one queue and at most one follow-up run executes after the active run completes

### Requirement: Watcher state reporting

The `code_index` tool SHALL report watcher state in both text and
`structuredContent` payloads: current status (`idle`, `catching_up`, or
`error`), pending-event count, last completed reindex time, and the last error
message when status is `error`. A `code_index` call while a run is in flight
SHALL join the queue rather than starting a competing run.

#### Scenario: Agent inspects watcher state
- **WHEN** the agent invokes `code_index` while a background catch-up is running
- **THEN** the response reports status `catching_up` and a pending-event count in both payloads

### Requirement: Reindex failure handling

When a reindex run fails, the watcher SHALL record the error in watcher state
and keep serving: responses continue with per-hit freshness marks reporting
per-file truth, and the response-level state SHALL remain `possibly_stale`
until a successful run completes. A subsequent triggering event SHALL retry
the reindex.

#### Scenario: Failed reindex keeps serving honest results
- **WHEN** a reindex run fails and a query is served afterwards
- **THEN** the response reports watcher status `error`, per-hit marks still reflect each file's real state, and the next file event retries the reindex

### Requirement: Watcher lifecycle bound to the server session

The watcher SHALL start when the MCP server starts and stop when it stops.
Between sessions no watcher runs; the next server start re-establishes truth
via the startup probe. No daemon process and no background job outside the
server session SHALL be introduced.

#### Scenario: Session end stops watching; next start reconciles
- **WHEN** an MCP session ends and a later session starts in the same repository after edits made in between
- **THEN** the new server start's probe detects the edits made since the last indexing and runs the catch-up reindex in the background
