# search-routing Delta

## Purpose

Route selection and truthful match provenance for `code_search`: callers pin the search
pool with an explicit `mode`, and every result reports a typed `matchedBy` value
describing how it matched — replacing the stringly-typed `matchReason` channel and
ending path-prefix hits' false `exact` badge.

## ADDED Requirements

### Requirement: Route mode selects the search pool

The `code_search` tool SHALL accept a `mode` parameter with values `auto`, `exact`,
`fts`, and `fused`, defaulting to `auto` when omitted. `auto` and `fused` SHALL serve
the union of the exact pool and the FTS pool with the current rerank; `exact` SHALL
serve only the exact pool; `fts` SHALL serve only the FTS pool. The mode parameter
SHALL be validated at the tool boundary, and an invalid value SHALL be rejected like
any other malformed input. The mode parameter and the served pool SHALL be reflected
identically in the text payload and the `structuredContent` shape.

#### Scenario: Omitted mode behaves as auto

- **WHEN** `code_search` is called without `mode`
- **THEN** results are byte-identical to a call with `mode: "auto"`

#### Scenario: Exact mode serves only the exact pool

- **WHEN** `code_search` is called with `mode: "exact"` for a query with both exact and
  FTS-only candidates
- **THEN** every returned result has `matchedBy` in the exact family
  (`exact_export`, `exact_qualified`, `exact_local`, `path_prefix`) and no FTS-only
  candidate appears

#### Scenario: FTS mode serves only the FTS pool

- **WHEN** `code_search` is called with `mode: "fts"` for the same query
- **THEN** every returned result has `matchedBy: "fts"` and no exact-pool-only
  candidate appears

#### Scenario: Invalid mode is rejected

- **WHEN** `code_search` is called with `mode: "semantic"`
- **THEN** the call fails input validation and no search runs

### Requirement: Fused mode is a frozen contract

`mode: "fused"` SHALL produce results byte-identical to `mode: "auto"` at the time this
capability lands, and SHALL remain a stable mechanical union even if `auto` routing
evolves later — `fused` exists so benchmark arms and callers can pin one behavior.

#### Scenario: Fused equals auto today

- **WHEN** the same query is run with `mode: "auto"` and `mode: "fused"`
- **THEN** results, order, `rankScore`, and `matchedBy` values are identical

### Requirement: Match provenance is a typed matchedBy field

Every search result in `code_search` and `code_symbol` responses SHALL carry
`matchedBy` with exactly one of the values `exact_export`, `exact_qualified`,
`exact_local`, `path_prefix`, or `fts`, in both the text payload and
`structuredContent`. The free-form `matchReason` string field SHALL be removed from the
response schemas (**BREAKING** — consumers reading `matchReason` must migrate to
`matchedBy`). The provenance value SHALL reflect the strongest name match: an
export-name match SHALL be `exact_export` even when the local name also matches.

#### Scenario: Export name wins provenance

- **WHEN** a symbol's export name and local name both equal the query
- **THEN** the result reports `matchedBy: "exact_export"`

#### Scenario: No matchReason field remains

- **WHEN** any `code_search` or `code_symbol` response is inspected
  (text payload or `structuredContent`)
- **THEN** results carry `matchedBy` and contain no `matchReason` field

### Requirement: Path-prefix matches are labeled path_prefix

A match earned by the exact pool's file-path prefix branch SHALL report
`matchedBy: "path_prefix"` — never an exact-name value. Path-prefix hits SHALL retain
their current pool membership, dedup priority, and zero match-quality bonus, so their
`rankScore` and ordering are unchanged.

#### Scenario: Path query returns path_prefix provenance

- **WHEN** `code_search` is called with a query matching file paths but no symbol name
  (e.g. a directory prefix)
- **THEN** matching results report `matchedBy: "path_prefix"` and `rankScore` values
  are unchanged from the pre-change behavior

### Requirement: Exact matches precede FTS matches in every mode

In `auto` and `fused` modes, an exact-name match SHALL never be ranked below an FTS
match for the same query — the exact-before-FTS ordering guarantee SHALL hold after
this change exactly as before it, in both the text payload and `structuredContent`.

#### Scenario: Exact-first ordering survives the rerank

- **WHEN** a query has an exact-name candidate and FTS candidates, run in `auto` mode
- **THEN** the exact-name candidate appears before any FTS candidate it used to precede,
  with unchanged `rankScore`

### Requirement: Ranking invariance under the change

The change SHALL NOT alter ranking outcomes for existing queries: `rankScore` values,
result order, and match-tier selection SHALL be identical to pre-change behavior for
`auto` mode across the benchmark corpora. The IR oracle gates SHALL remain byte-flat on
both the repo-local corpus (`bench/baseline.json`) and the papai corpus
(`bench/baseline.papai.json`); the impact gate (`bench/impact-baseline*.json`) SHALL
likewise remain byte-flat. Baselines SHALL NOT be regenerated for this change.

#### Scenario: IR oracle stays flat

- **WHEN** `bun run check:bench` runs after the change
- **THEN** the repo-local and papai IR baselines pass byte-identical, without
  regeneration
