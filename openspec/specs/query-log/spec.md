# query-log

## Purpose

The query log is codeindex's honesty record: every MCP query call is
recorded with enough context (tool, query text, filters, result count,
hit, latency, top qualified names, error) to audit real usage and search
quality over time. Recording is best-effort — it must never break or
alter a query — but its own failures must be observable, and pre-existing
log databases must not silently drift out of schema.

## Requirements

### Requirement: MCP query calls are recorded

The system SHALL record an entry in the query log for every MCP
`code_search`, `code_symbol`, and `code_impact` call, containing the tool
name, query text (or `qualifiedName`/`symbolKey` for `code_impact`),
filters, result count, hit flag, latency, and top qualified names.

#### Scenario: Successful search is recorded

- **WHEN** an MCP `code_search` call returns results
- **THEN** a query-log entry exists with tool `code_search`, the query
  text, the request filters, `result_count` matching the returned count,
  `hit` true when results are non-empty, a non-negative latency, and top
  qualified names from the results

#### Scenario: Failed search is recorded with its error

- **WHEN** an MCP query call throws
- **THEN** a query-log entry exists with `result_count` 0, empty top
  qualified names, and the error message, and the original error still
  propagates to the caller

### Requirement: Recording failures never break queries

The system SHALL return the query result normally when query-log
recording fails, and SHALL report the recording failure to stderr
instead of silently discarding it.

#### Scenario: Unwritable log database

- **WHEN** the query log database cannot be written (for example the
  file is not a valid database)
- **THEN** the MCP query still returns its normal response with text and
  structuredContent intact, and a diagnostic naming the failing record
  appears on stderr

#### Scenario: Tool responses unchanged by recording

- **WHEN** query-log recording is enabled or disabled
- **THEN** the MCP tool responses (text payload and structuredContent
  shape) are identical for the same query

### Requirement: Pre-existing log databases migrate on open

The system SHALL migrate a pre-existing `queries.db` whose `query_log`
table predates the current columns so that recording works on it, instead
of silently failing on every write.

#### Scenario: Legacy database missing the error column

- **WHEN** a `queries.db` contains a `query_log` table created before
  the `error` column existed
- **THEN** the first query-log open migrates the table, and a subsequent
  MCP query call records an entry successfully

#### Scenario: WAL siblings while the log is open

- **WHEN** the query log database is opened for recording
- **THEN** it runs in WAL mode with `-wal`/`-shm` sibling files while
  open, consistent with the storage conventions
