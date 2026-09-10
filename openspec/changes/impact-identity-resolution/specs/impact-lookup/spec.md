# Impact Lookup — `code_impact` identity resolution and honest empty outcomes

## Purpose

Resolves the target symbol behind a `code_impact` identity input the same way
agents naturally name symbols — exact `symbol_key`, exact `qualified_name`, or
exact local name — and reports the truth when a lookup comes back empty, so a
key-format miss is never misdiagnosed as reference-graph degradation.

## ADDED Requirements

### Requirement: Identity resolution through exact-first matching

`code_impact` SHALL resolve its target symbol by trying, in order: an exact
`symbol_key` match (when `symbolKey` is given), an exact `qualified_name` match
(when `qualifiedName` is given), then the exact-first candidate router over
each provided input string, accepting only matches by exact `qualified_name` or
exact local name. The first stage that resolves SHALL win; ties among exact
candidates SHALL resolve by the existing rank order. `code_impact` SHALL NOT
fall back to fuzzy or full-text matching: an input that matches no indexed
symbol by these forms SHALL resolve to nothing.

#### Scenario: Canonical symbol_key is unchanged

- **WHEN** `code_impact` is called with a `symbolKey` that equals a stored `symbol_key`
- **THEN** the returned incoming-reference rows are exactly the rows for that symbol, in the same order as before this change

#### Scenario: Canonical qualified_name is unchanged

- **WHEN** `code_impact` is called with a `qualifiedName` that equals a stored `qualified_name`
- **THEN** the returned incoming-reference rows are exactly the rows for that symbol, in the same order as before this change

#### Scenario: Qualified-name string passed as symbolKey resolves

- **WHEN** `code_impact` is called with `symbolKey` set to a string that is not a stored `symbol_key` but exactly equals a stored `qualified_name` (for example `src/storage/db#openDatabase`)
- **THEN** the call resolves to that symbol and returns its incoming references

#### Scenario: Bare local name passed as qualifiedName resolves

- **WHEN** `code_impact` is called with `qualifiedName` set to a string that is not a stored `qualified_name` but exactly equals a stored `local_name` (for example `openDatabase`)
- **THEN** the call resolves to the top-ranked symbol with that local name and returns its incoming references

#### Scenario: Ties resolve by the existing rank order

- **WHEN** more than one distinct symbol exactly matches the input (for example two modules exporting the same local name)
- **THEN** the top-ranked candidate under the existing ranking (scope tier and match type) is used, and the response identifies which symbol was resolved so the caller can verify it

#### Scenario: Unknown identity does not fall back to fuzzy search

- **WHEN** `code_impact` is called with an input that matches no stored `symbol_key`, `qualified_name`, or exact `local_name`
- **THEN** the call reports the identity as unresolved instead of returning fuzzy matches, and does not advise a reindex

### Requirement: Honest empty outcomes

When a `code_impact` call returns no incoming references, the response SHALL
distinguish *identity not resolved* from *symbol found but no incoming
references*, in both the text payload and `structuredContent`. Unresolved
identity guidance SHALL state that the input did not match any indexed symbol
by the accepted forms and SHALL point at `code_symbol` to find the exact
identity; it SHALL NOT recommend a reindex. Found-but-empty guidance MAY keep
the existing advice to confirm via `code_symbol` and rebuild via a full
`code_index` run. `structuredContent` SHALL carry a resolution descriptor with
a resolution status, the match form used, and — when resolved — the resolved
symbol's `symbolKey` and `qualifiedName`.

#### Scenario: Unresolved identity guidance tells the truth

- **WHEN** a `code_impact` input resolves to no symbol
- **THEN** the response explains the identity did not resolve, names the accepted identity forms, suggests `code_symbol`, and does not suggest running `code_index`

#### Scenario: Found-but-empty guidance keeps the reindex advice

- **WHEN** a `code_impact` input resolves to a symbol that has no incoming references
- **THEN** the response reports the symbol was found with zero incoming references and may advise `code_symbol` confirmation and a full `code_index` rebuild

#### Scenario: Resolution descriptor in structuredContent

- **WHEN** a `code_impact` call completes
- **THEN** `structuredContent` includes the resolution status (`canonical`, `resolved`, or `unresolved`), the match form used when resolved, and the resolved symbol's `symbolKey` and `qualifiedName` when a symbol was resolved

### Requirement: Tool description documents accepted identity forms

The `code_impact` tool description SHALL document the accepted identity forms:
exact `symbol_key` (`file#range`), exact `qualified_name` (`module#name` or
`parent>name`), and exact local name.

#### Scenario: Description lists identity forms

- **WHEN** an MCP client lists the `code_impact` tool
- **THEN** its description states the accepted identity forms and that unknown identities return unresolved guidance rather than fuzzy matches

### Requirement: Canonical-key compatibility

Identity resolution SHALL NOT change the behavior of existing exact
`symbol_key` and exact `qualified_name` lookups: the reference rows, their
order, the CLI `impact` command output shape, and the benchmark oracle callers
of the incoming-reference lookup SHALL remain byte-identical, so the stamped
impact baselines hold without regeneration.

#### Scenario: Bench and CLI callers keep their contract

- **WHEN** the incoming-reference lookup is invoked with exact `qualified_name` keys by the benchmark harness, edit-fuzz oracle, impact scorer, or CLI `impact` command
- **THEN** the returned rows are byte-identical to the pre-change behavior and the impact baseline gates pass without regeneration
