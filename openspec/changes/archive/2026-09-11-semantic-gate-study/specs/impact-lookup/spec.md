# Impact Lookup — bare local-name uniqueness (delta)

## Purpose

Resolves `code_impact` identities honestly across the forms agents actually
send, and reports the truth when a lookup is empty — so a key-format miss is
never misdiagnosed as graph degradation, and a bare local name never becomes
a wrong caller list.

## MODIFIED Requirements

### Requirement: Identity resolution through exact-first matching

`code_impact` SHALL resolve its target symbol by trying, in order: an exact
`symbol_key` match (when `symbolKey` is given), an exact `qualified_name`
match (when `qualifiedName` is given), then — for a remaining input string —
an exact `local_name` lookup against the index. A bare local name SHALL be
accepted **if and only if** exactly one indexed symbol has that `local_name`.
Zero matches and multiple matches SHALL both resolve to nothing
(`unresolved`); multiple matches SHALL NOT be tie-broken by rank, FTS
cardinality, or scope tier. `code_impact` SHALL NOT fall back to fuzzy or
full-text matching for identity.

#### Scenario: Canonical symbol_key is unchanged

- **WHEN** `code_impact` is called with a `symbolKey` that equals a stored `symbol_key`
- **THEN** the returned incoming-reference rows are exactly the rows for that symbol, in the same order as before this change

#### Scenario: Canonical qualified_name is unchanged

- **WHEN** `code_impact` is called with a `qualifiedName` that equals a stored `qualified_name`
- **THEN** the returned incoming-reference rows are exactly the rows for that symbol, in the same order as before this change

#### Scenario: Qualified-name string passed as symbolKey resolves

- **WHEN** `code_impact` is called with `symbolKey` set to a string that is not a stored `symbol_key` but exactly equals a stored `qualified_name` (for example `src/storage/db#openDatabase`)
- **THEN** the call resolves to that symbol and returns its incoming references

#### Scenario: Repo-unique bare local name resolves

- **WHEN** `code_impact` is called with `qualifiedName` set to a string that is not a stored `qualified_name` but exactly equals the `local_name` of exactly one indexed symbol (for example `openDatabase` on a repo where that name is unique)
- **THEN** the call resolves to that symbol and returns its incoming references

#### Scenario: Ambiguous bare local name does not guess

- **WHEN** `code_impact` is called with a bare local name that matches more than one indexed symbol (for example `log` or `db`)
- **THEN** the call reports the identity as unresolved, does not return incoming references for any one of the tied symbols, and guidance points the caller at `code_symbol` to obtain an exact `symbolKey` or `qualifiedName`

#### Scenario: Unknown identity does not fall back to fuzzy search

- **WHEN** `code_impact` is called with an input that matches no stored `symbol_key`, `qualified_name`, or exact unique `local_name`
- **THEN** the call reports the identity as unresolved instead of returning fuzzy matches, and does not advise a reindex

### Requirement: Honest empty outcomes

When a `code_impact` call returns no incoming references, the response SHALL
distinguish *identity not resolved* from *symbol found but no incoming
references*, in both the text payload and `structuredContent`. Unresolved
identity guidance SHALL state that the input did not match any indexed symbol
by the accepted forms (or matched an ambiguous local name) and SHALL point at
`code_symbol` to find the exact identity; it SHALL NOT recommend a reindex.
Found-but-empty guidance MAY keep the existing advice to confirm via
`code_symbol` and rebuild via a full `code_index` run. `structuredContent`
SHALL carry a resolution descriptor with a resolution status, the match form
used, and — when resolved — the resolved symbol's `symbolKey` and
`qualifiedName`.

#### Scenario: Unresolved identity guidance tells the truth

- **WHEN** a `code_impact` input resolves to no symbol
- **THEN** the response explains the identity did not resolve (or was ambiguous), names the accepted identity forms, suggests `code_symbol`, and does not suggest running `code_index`

#### Scenario: Found-but-empty guidance keeps the reindex advice

- **WHEN** a `code_impact` input resolves to a symbol that has no incoming references
- **THEN** the response reports the symbol was found with zero incoming references and may advise `code_symbol` confirmation and a full `code_index` rebuild

#### Scenario: Resolution descriptor in structuredContent

- **WHEN** a `code_impact` call completes
- **THEN** `structuredContent` includes the resolution status (`canonical`, `resolved`, or `unresolved`), the match form used when resolved, and the resolved symbol's `symbolKey` and `qualifiedName` when a symbol was resolved

### Requirement: Tool description documents accepted identity forms

The `code_impact` tool description SHALL document the accepted identity
forms: exact `symbol_key` (`file#range`), exact `qualified_name`
(`module#name` or `parent>name`), and exact repo-unique local name. It SHALL
state that ambiguous local names return unresolved guidance rather than a
rank-order guess.

#### Scenario: Description lists identity forms

- **WHEN** an MCP client lists the `code_impact` tool
- **THEN** its description states the accepted identity forms, that bare local names require uniqueness, and that unknown or ambiguous identities return unresolved guidance rather than fuzzy matches

### Requirement: Canonical-key compatibility

Identity resolution SHALL NOT change the behavior of existing exact
`symbol_key` and exact `qualified_name` lookups: the reference rows, their
order, the CLI `impact` command output shape, and the benchmark oracle
callers of the incoming-reference lookup SHALL remain byte-identical, so the
stamped impact baselines hold without regeneration.

#### Scenario: Bench and CLI callers keep their contract

- **WHEN** the incoming-reference lookup is invoked with exact `qualified_name` keys by the benchmark harness, edit-fuzz oracle, impact scorer, or CLI `impact` command
- **THEN** the returned rows are byte-identical to the pre-change behavior and the impact baseline gates pass without regeneration
