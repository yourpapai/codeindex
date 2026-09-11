# Query Telemetry — study corpus instrumentation

## Purpose

Records enough per-query shape and outcome data to measure lexical miss
rates for the P3-S3 semantic gate, while preserving historical dogfood
`query_log` rows as the study corpus.

## ADDED Requirements

### Requirement: Durable in-place query_log schema evolution

The query log database SHALL migrate in place across schema bumps. Adding
study columns MUST NOT drop or wipe existing `query_log` rows. Existing
rows MAY leave new columns NULL. The schema version SHALL advance so old
and new writers are distinguishable.

#### Scenario: Existing dogfood history survives the bump

- **WHEN** an existing `queries.db` at the prior schema version is opened after this change
- **THEN** prior rows remain queryable with their original `query_text`, `result_count`, `response_bytes`, and timestamps, and new columns are present (NULL for historical rows)

#### Scenario: Fresh database gets the full schema

- **WHEN** a new query log database is created
- **THEN** it includes the telemetry columns from the start and records a schema version consistent with this change

### Requirement: Per-query shape and weak-result fields

Each newly recorded tool call SHALL store a `query_shape` classification of
the query text (`identifier`, `multi_token_lexical`, `nl`, or `empty`) and a
`zero_or_weak` flag derived from result count relative to the requested
limit (a query is weak when it returns fewer hits than the client asked for,
or fewer than a small absolute floor when no useful limit is available).
Classification SHALL be deterministic for a given string.

#### Scenario: Identifier-shaped query is labeled

- **WHEN** a `code_search` or `code_symbol` call is logged with query text `openDatabase` or `src/storage/db#openDatabase`
- **THEN** its `query_shape` is `identifier`

#### Scenario: Multi-word natural-language-ish query is labeled

- **WHEN** a `code_search` call is logged with query text such as `rerank search results relevance` or `index command CLI`
- **THEN** its `query_shape` is `nl` or `multi_token_lexical` according to the classifier, not `identifier`

#### Scenario: Empty result is weak

- **WHEN** a logged call returns zero results
- **THEN** `zero_or_weak` is set

#### Scenario: Full page is not weak

- **WHEN** a logged `code_search` call requests `limit=10` and returns 10 results
- **THEN** `zero_or_weak` is not set solely because of that call

### Requirement: Search route and match provenance ride-along

When `code_search` (or `code_symbol`) is invoked with an explicit route
`mode`, that mode SHALL be recorded on the query log row. When results
carry match provenance, the dominant/top-hit `matchedBy` value SHALL be
recorded when available. Absence of `mode` or `matchedBy` SHALL NOT fail
the query or the log write.

#### Scenario: Explicit mode is recorded

- **WHEN** `code_search` is called with `mode=exact` and the call is logged
- **THEN** the query log row stores `mode` as `exact`

#### Scenario: Default mode is absent, not invented

- **WHEN** `code_search` is called without a `mode` parameter
- **THEN** the query log row does not claim a non-default route that the caller never chose (NULL or an explicit default marker, never a fabricated non-auto value)

### Requirement: Telemetry is log-side only

Instrumentation SHALL NOT change MCP tool response contracts: `code_search`
/ `code_symbol` / `code_impact` text payloads and `structuredContent` shapes
SHALL remain unchanged apart from unrelated work already landed. A query-log
write failure SHALL NOT fail the tool call.

#### Scenario: Tool result unchanged by logging

- **WHEN** a `code_search` call is wrapped by query logging with telemetry enabled
- **THEN** the MCP result the client receives is the same shape and fields as without the wrapper (aside from any pre-existing `response_bytes` side channel), and a log I/O error is reported on stderr without failing the call

### Requirement: Study corpus stays inspectable

The preserved query log SHALL remain sufficient to compute, for a time
window and tool: volume, shape mix, zero/weak rate, and (when present)
mode distribution — without requiring external instrumentation. A decision
memo built from this corpus SHALL cite concrete corpus locations and counts.

#### Scenario: Memo inputs are recoverable from the query log

- **WHEN** an analyst queries the dogfood `query_log` after this change
- **THEN** they can group by tool, `query_shape`, and `zero_or_weak` over the historical window and compare to newly recorded rows
