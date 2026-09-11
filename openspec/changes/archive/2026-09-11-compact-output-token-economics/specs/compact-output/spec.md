# compact-output Specification (delta)

## Purpose

Controls how many bytes an MCP tool response costs the calling agent: preview
modes shrink per-hit snippets, metadata is not duplicated across payload
channels, and every query records its response size so token economics stay
measurable.

## ADDED Requirements

### Requirement: Preview mode selects snippet density

`code_search` and `code_symbol` SHALL accept `preview: "none" | "short" | "full"`
with default `"none"`. The `preview` value SHALL affect only per-result snippet
density in the machine payload; ranking, hit set, exact-first order, `matchedBy`,
`rankScore`, and freshness marks SHALL be unchanged for a given query and index.

- `"none"` — each result's `snippet` SHALL be a single anchor line of at most
  160 characters, derived from stored signature or body text (truncated with an
  ellipsis when cut).
- `"short"` — each result's `snippet` SHALL be a window of at most 10 lines
  around the anchor, eliding the middle when the stored body is longer.
- `"full"` — each result's `snippet` SHALL match today's stored preview shape
  (multi-line body or signature text, subject to existing storage limits).

#### Scenario: Default preview is none

- **WHEN** a `code_search` or `code_symbol` call omits `preview`
- **THEN** every result `snippet` is a single line of at most 160 characters

#### Scenario: Full preview preserves current density

- **WHEN** a `code_search` call sets `preview: "full"` against an unchanged index
- **THEN** result identities, `matchedBy` values, `rankScore` values, and snippet
  density match the pre-change `full`-equivalent behavior for the same query

#### Scenario: Ranking is preview-invariant

- **WHEN** the same query runs with `preview: "none"` and `preview: "full"`
- **THEN** the ordered list of `symbolKey` values and their `rankScore` values
  are identical

### Requirement: Single-channel field contract

No response field SHALL be fully duplicated across the text payload and
`structuredContent`. The text payload SHALL remain a skim summary (result count,
top qualified names, freshness suffix, and guidance when present). The
`structuredContent` payload SHALL remain the authoritative machine result.
When a result's snippet already carries the symbol's local name, per-result
prose in the text channel SHALL not restate name/kind metadata that the machine
payload already provides.

#### Scenario: Text stays a skim summary

- **WHEN** a successful `code_search` returns N results
- **THEN** the text payload names at most the top 5 qualified names plus count
  and freshness, and does not embed full result objects or full snippets

#### Scenario: Structured payload remains authoritative

- **WHEN** a successful `code_search` or `code_symbol` returns results
- **THEN** `structuredContent` contains the ordered result array with identity,
  location, `matchedBy`, `rankScore`, snippet (per preview), and freshness

#### Scenario: Guidance appears once per empty search

- **WHEN** `code_search` returns zero results
- **THEN** `guidance` is present in `structuredContent` and summarized in the
  text payload without duplicating the full result schema

### Requirement: Response size is recorded

Every successful or failed `code_search`, `code_symbol`, and `code_impact` call
SHALL record `response_bytes` — the UTF-8 byte length of the text payload plus
the serialized `structuredContent` — in the query log. Existing log rows that
predate the column SHALL retain `NULL` for `response_bytes`. Logging failures
SHALL never fail the query. WAL mode and concurrent readers of `queries.db`
SHALL continue to work.

#### Scenario: Successful call logs response size

- **WHEN** a `code_search` call returns results and query logging is enabled
- **THEN** the newest query_log row has `response_bytes` equal to the measured
  response size (greater than zero)

#### Scenario: Error path still logs

- **WHEN** a tool handler throws before a result is built
- **THEN** the query log row records the error and `response_bytes` is NULL or
  zero without failing the caller beyond the original error

#### Scenario: Legacy rows keep NULL

- **WHEN** a `queries.db` created before this change is opened after upgrade
- **THEN** pre-existing rows have `response_bytes` NULL and new rows populate it

### Requirement: Exact-first semantics preserved under compaction

Preview and channel changes SHALL not alter exact-before-FTS priority. An exact
match SHALL never be ranked below an FTS-only match for the same query, and
`mode` routing (`auto` | `exact` | `fts` | `fused`) SHALL behave as specified by
`search-routing` under every preview value.

#### Scenario: Exact still outranks FTS

- **WHEN** a query produces both exact and FTS hits at default `preview: "none"`
- **THEN** all exact hits appear before FTS-only hits in the result array
