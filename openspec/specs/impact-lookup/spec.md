# Impact Lookup — identity resolution and honest empty outcomes

## Purpose

Fair, still-honest `code_impact` identity: accept the public export when it is
the only export with that bare name, never rank-guess among multiple exports,
and hand agents a capped candidate list instead of a dead-end miss.

## Requirements

### Requirement: Identity resolution through exact-first matching

`code_impact` SHALL resolve its target by trying, in order: exact `symbol_key`
(when `symbolKey` is given), exact `qualified_name` (when `qualifiedName` is
given), exact unique `local_name` among all indexed symbols, then — for a bare
local name — exact unique `local_name` among symbols with
`scope_tier='exported'`. If neither uniqueness rule holds, a `module#name`
partial (Lever C) may be accepted under the rules below. Multiple exports
SHALL NOT be tie-broken by rank, FTS cardinality, scope score, or in-degree.
`code_impact` SHALL NOT fall back to fuzzy or full-text matching for identity.

#### Scenario: Canonical symbol_key and qualified_name unchanged

- **WHEN** `code_impact` is called with a `symbolKey` or `qualifiedName` that equals a stored `symbol_key` / `qualified_name`
- **THEN** resolution and incoming-reference rows are byte-identical to pre-change behavior

#### Scenario: Bare local name unique among all symbols resolves

- **WHEN** exactly one indexed symbol has that `local_name`
- **THEN** the call resolves to that symbol with `matchedBy: local_name`

#### Scenario: Bare local name unique among exports resolves despite member noise

- **WHEN** a bare name matches multiple symbols but exactly one of them has `scope_tier='exported'` (for example `alpha` exported plus `ColorObject>alpha` as a member)
- **THEN** the call resolves to the exported symbol with `matchedBy: local_name` and does not return a member/local hit

#### Scenario: Two or more exports share the bare name and stay unresolved

- **WHEN** a bare name matches two or more `scope_tier='exported'` symbols (for example two `Helper` exports)
- **THEN** the call reports unresolved, does not return incoming references for any one export, and returns candidates as specified below

#### Scenario: Unknown identity stays unresolved

- **WHEN** no `symbol_key`, `qualified_name`, unique all-symbol `local_name`, unique-export `local_name`, or `module#name` partial matches
- **THEN** the call reports unresolved with no candidates and no fuzzy fallback

### Requirement: module#name partial identity

When input contains a single `#` and matches the form `Module#Name` with no
path separators in either segment, and no earlier stage resolved, `code_impact`
SHALL treat it as a partial qualified identity: accept iff exactly one indexed
symbol has `local_name` equal to `Name` (NOCASE) and `module_key` equal to
`Module` or ending with `/Module`.

#### Scenario: Toast#Action resolves when unique

- **WHEN** `code_impact` is called with `Toast#Action` and exactly one symbol has `local_name` `Action` whose `module_key` ends with `/Toast` or equals `Toast`
- **THEN** the call resolves to that symbol (`matchedBy: module_name`)

#### Scenario: Partial does not over-match sibling modules

- **WHEN** `Module#Name` would match symbols in `otherModule` or a module key that merely contains `Module` as a substring of a segment (for example `MyModule` when input is `Module`)
- **THEN** those symbols are not accepted and the call does not resolve unless exactly one segment-exact match exists

### Requirement: Honest empty outcomes and candidates

When identity does not resolve, the response SHALL distinguish *unknown* from
*ambiguous*. Ambiguous outcomes SHALL include a capped candidate list
(maximum 5) of exact `local_name` matches with `symbolKey`,
`qualifiedName`, `scopeTier`, and `filePath`. Candidates SHALL be ordered
exported-first then `qualified_name` ascending. The response SHALL NOT auto-
select a candidate or return incoming references. Guidance SHALL name the
candidates (or state none) and SHALL NOT recommend `code_index` for identity
misses. Found-but-empty guidance for a resolved symbol MAY keep reindex advice.

#### Scenario: Ambiguous bare name returns candidates, not a caller list

- **WHEN** `code_impact` is called with a bare name matching multiple exports (or multiple non-export matches with zero exports)
- **THEN** `identity.status` is `unresolved`, `identity.reason` is `ambiguous`, `identity.candidates` contains at most 5 entries, `results` is empty, and text guidance lists those qualified names

#### Scenario: Unknown identity has no candidates

- **WHEN** `code_impact` is called with a string that matches no accepted identity form
- **THEN** `identity.reason` is `unknown` (or equivalent), `candidates` is omitted or empty, and guidance points at `code_symbol` without `code_index`

#### Scenario: Resolution descriptor on success is unchanged in shape

- **WHEN** a call resolves (canonical or local_name or module_name)
- **THEN** `structuredContent.identity` carries status, `matchedBy`, `symbolKey`, and `qualifiedName` as before, and `results` is the incoming-reference list

### Requirement: Tool description documents accepted identity forms

The `code_impact` tool description SHALL document: exact `symbol_key`, exact
`qualified_name`, repo-unique local name, unique-export local name (export
unique even if members share the name), and `Module#Name` partials. It SHALL
state that multiple exports return unresolved with candidates, never a
rank-order guess.

#### Scenario: Description lists all identity forms

- **WHEN** an MCP client lists the `code_impact` tool
- **THEN** the description mentions symbol_key, qualified_name, local name uniqueness including export-unique acceptance, Module#Name, and ambiguity candidates

### Requirement: Canonical-key compatibility and revert safety

Exact `symbol_key` / `qualified_name` lookups, CLI `impact` output for those
keys, and benchmark oracles SHALL remain byte-identical so stamped impact
baselines hold without regeneration. Behavior changes SHALL be isolated so a
regression can be reverted per lever without data migration.

#### Scenario: Bench and CLI callers keep their contract

- **WHEN** the incoming-reference lookup is invoked with exact `qualified_name` keys by the benchmark harness, edit-fuzz oracle, impact scorer, or CLI `impact`
- **THEN** returned rows are byte-identical to pre-change behavior and impact baseline gates pass without re-stamping
