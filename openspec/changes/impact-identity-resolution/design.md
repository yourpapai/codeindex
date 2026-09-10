# Design: Impact identity resolution

## Context

`code_impact` resolves identity with two direct column lookups: `symbol_key = ?`
or `qualified_name = ?` (`findIncomingReferences`, `src/search/index.ts`). An
agent that sends the qualified-name form as `symbolKey`
(`src/storage/db#openDatabase`) or a bare local name as `qualifiedName`
(`openDatabase`) gets zero rows — indistinguishable from "no callers" — and the
empty guidance then advises a full reindex. The exact-first router already
exists one call away (`findSymbolCandidates` → `runExactSearch` +
`rerankSearchResults`); the fix reuses it without duplicating lookup logic.

Surfaces touched: `src/search/index.ts` (lookup), `src/mcp/tools.ts`
(deps type + output schema), `src/mcp/server.ts` (guidance + description),
`src/mcp/freshness.ts` and `src/mcp/query-logging.ts` (wrappers), `src/cli.ts`
(deps wiring). No storage, indexer, or CLI-command changes.

## Decisions

### D1: New resolution-aware entry point; `findIncomingReferences` stays frozen

Add `resolveIncomingReferences(db, input) → { resolution, results }` in
`src/search/index.ts`. `findIncomingReferences` keeps its exact signature and
return shape: the bench harness (`bench/harness.ts`), edit-fuzz oracle
(`bench/edit-fuzz-oracle.ts`), impact scorer (`bench/impact-score.ts`), and the
CLI `impact` command all call it with canonical keys and must stay
byte-identical. Delegating the old function to the new one would change
miss behavior (a miss could now resolve through the router), so both share an
internal row-query helper instead. `src/impact.ts` re-exports the new symbols.

`resolution` is a discriminated union:

- `{ status: 'canonical', matchedBy: 'symbol_key' | 'qualified_name', symbolKey, qualifiedName }` — direct column hit
- `{ status: 'resolved', matchedBy: 'qualified_name' | 'local_name', symbolKey, qualifiedName }` — router hit on a non-canonical form
- `{ status: 'unresolved' }` — no exact match anywhere

### D2: Router reuse = exact stage only

`findSymbolCandidates` itself FTS-falls-back, so the impact path calls the
router's exact stage directly: `runExactSearch(db, input, limit, {})` +
`rerankSearchResults`, accepting only `matchedBy: 'exact_qualified' |
'exact_local'`. This is the proposal's "routed through the exact-first
candidate router" with its explicit "no FTS fallback" honored — FTS-zone
ambiguity is an error-shaped outcome, never a guess. Rejected: calling
`findSymbolCandidates` and filtering (same results, wasted FTS query on the
miss path).

Accepted identity forms stay exactly the proposal's three: canonical
`symbol_key`, canonical `qualified_name`, and exact local name via the router.
`exact_export` and `path_prefix` router matches are not accepted (not in the
proposal's list; can be added if the A/B rig shows demand).

### D3: Stage order and target selection

1. Canonical: try the canonical columns in input order — `WHERE symbol_key = ?`
   when `symbolKey` is given, then `WHERE qualified_name = ?` when
   `qualifiedName` is given (the spec's "when ... is given" stage list; both
   inputs may be canonical-checked when both are provided — `symbolKey` still
   wins).
2. Router: for each provided input string in order (`symbolKey`, then
   `qualifiedName`), run the exact stage; the first input with accepted exact
   candidates wins.
3. Among candidates, `rerankSearchResults(...)[0]` — the proposal's "first
   exact match wins; ties resolve by the existing rank order". The resolved
   identity (symbolKey + qualifiedName + matchedBy) is echoed in the response
   so a wrong-symbol pick from a shared local name is visible to the agent
   rather than silent.

Rejected alternative: multiple distinct exact matches → unresolved. The
proposal's tie sentence explicitly assigns rank-order resolution, so rank-first
wins; ambiguity that would require fuzzy guessing remains an error.

### D4: Deps plumbing

`CodeindexToolDeps.codeImpact` returns `Promise<ImpactLookupOutcome>` —
`{ resolution, results }` where `results` rows keep the `ImpactResult` shape
(and gain `freshness` after `withFreshness`). Ripples, all mechanical:

- `withFreshness`: decorate `outcome.results` (`row.sourceFilePath`), return
  `{ ...outcome, results }`.
- `withQueryLogging` `wrapCodeImpact`: `resultCount` /
  `topQualifiedNames` read from `outcome.results`.
- `buildMcpDeps` (`src/cli.ts`): call `resolveIncomingReferences`.
- Test stubs/harness returning bare arrays switch to
  `{ resolution, results }` (harness uses the real
  `resolveIncomingReferences`).

### D5: Output schema + guidance split

`CodeImpactOutputSchema` gains optional `identity`:

```ts
identity: {
  status: 'canonical' | 'resolved' | 'unresolved'
  matchedBy?: 'symbol_key' | 'qualified_name' | 'local_name'
  symbolKey?: string
  qualifiedName?: string
}
```

Optional so hand-built fixtures without it still validate (additive change).
`registerImpactTool` derives guidance:

- unresolved → "did not resolve … accepted forms … use code_symbol" — no
  reindex advice; summary is the guidance (mirrors `code_search`).
- resolved/canonical with 0 rows → found-but-empty: keeps the existing
  confirm-via-`code_symbol` + full-`code_index` advice.
- rows present → no guidance (unchanged).

Tool description lists the three accepted forms and the no-fuzzy-guess rule.

## Compatibility / risks

- Canonical-key rows and ordering: unchanged (same SQL through the shared
  helper); `impact-baseline.json`, `impact-baseline.fixture.json` gates must
  pass without regeneration; `edit-fuzz` and search/IR baselines untouched.
- `matchedBy` guidance relies on rank order only in the multi-candidate case;
  single-candidate local-name hits (the common case) are unambiguous.
- Freshness marks still attach per source file; unresolved responses have no
  rows, so no freshness decoration occurs.
- Bench-only type-checker boundary (`tests/bench/impact-guard.test.ts`): the
  new code touches no `typescript` APIs.
