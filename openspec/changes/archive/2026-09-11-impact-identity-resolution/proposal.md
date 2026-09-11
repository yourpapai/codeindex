# Proposal: Impact identity resolution

## Why

The agent A/B rig caught a trap that fixture-based benches structurally cannot:
`code_impact` silently returns empty for half the identity forms an agent naturally
sends. Live verification on the current index — `openDatabase` has 11 resolved incoming
edges, yet `symbolKey="src/storage/db#openDatabase"` (the qualified-name form
`code_symbol` advertises) returns 0, as does `qualifiedName="openDatabase"` (bare local
name). Only the exact `symbol_key` (`file#lines`) or exact `qualified_name` pairings
resolve. The empty-result guidance then misdiagnoses a key-format miss as graph
degradation and advises a full reindex. In the reps=3 stamp this plausibly fed the
`who-uses` cost premium (wasted impact→grep→bash turns) and at least one hallucinated
caller list.

## What Changes

- `code_impact` identity lookup is routed through the existing exact-first candidate
  router (`findSymbolCandidates` in `src/search/index.ts`) before falling back to
  empty: an input that matches by `symbol_key`, `qualified_name`, or exact local name
  resolves to the target symbol. First exact match wins; ties resolve by the existing
  rank order. No FTS fallback — an ambiguous identity is an error-shaped outcome, not
  a guess.
- Empty outcomes are split: *identity not resolved* vs *symbol found but no incoming
  references*. Guidance tells the truth per case; the "run code_index (full reindex)"
  advice survives only for the found-but-empty case.
- Tool description documents the accepted identity forms.

## Capabilities

### New Capabilities

- `impact-lookup`: identity resolution and honest empty-outcome guidance for
  `code_impact`, preserving exact-before-fuzzy ordering.

### Modified Capabilities

(none — `openspec/specs/` is empty; no main specs exist yet to modify)

## Impact

- Surfaces: MCP tools (`CodeImpactInputSchema`, `registerImpactTool` guidance) and the
  search layer — `findIncomingReferences` in `src/search/index.ts` extends the module
  that already owns lookup; the router is reused, not duplicated. No storage, indexer,
  or CLI changes.
- Canonical-key lookups (`symbol_key` / exact `qualified_name`) stay byte-identical,
  so `impact-baseline.json` gates hold without regeneration.
- Without this change: agents burn turns re-deriving callers after silent misses,
  follow misleading reindex advice, and hallucinate relational answers — the exact
  failure mode the rig measured.

## Non-goals

- The 3,198/3,974 NULL-target reference population (parked investigation — whether it
  is benign externals or lost recall is its own change).
- FTS/fuzzy impact lookup — declined; ambiguity should fail loudly, not guess.
- Persisting tool-call inputs in the A/B rig (observability gap) — bench-hygiene
  change, separate.
- `preview` params on `code_impact` (rows are already compact); compact-output just
  landed and its shapes stay untouched.
- HTTP transport, auth, refresh modes — P3-S5 remainder.
