# Design: Impact unique-export + candidates + module#name partials

## Context

`semantic-gate-study` replaced FTS-candidate acceptance with exact SQL
`local_name` uniqueness across **all** symbols. That fixed wrong caller lists
but over-refused when nested noise shares an export’s name.

react-ui evidence (indexed 2026-09-11, 11,521 symbols):

| Bucket | Count |
|---|---|
| Unique among all symbols | 5,015 |
| Unique among exports | 1,200 |
| Unique among exports but multi-match overall | **124** |
| Multi-match with exactly one export | **124** (same set) |
| Multi-match with 0 or 2+ exports | 1,288 |

Examples of false ambiguity: `alpha`, `blink`, `Button`, `Actions`.
True ambiguity: `default` (10), `isEqual` (4).

## Goals / Non-Goals

**Goals:** higher bare-name resolve rate without any wrong caller list;
ambiguous names pay one round-trip instead of two; behavior is easy to measure
and easy to revert.

**Non-Goals:** rank guessing, exclude-config changes, semantic search, auto-pick
of candidates.

## Decisions

### D1. Lever A — unique-export cardinality, not rank

In `resolveExactCandidate` (`src/search/index.ts`), after failing
all-symbols uniqueness:

1. Query `SELECT … FROM symbols WHERE local_name = ?` (already NOCASE).
2. If `rows.length === 1` → accept (existing path).
3. Else if exactly one row has `scope_tier === 'exported'` → accept that row
   (`matchedBy: 'local_name'`).
4. Else → unresolved (Lever B candidates).

This is still a **cardinality** rule. Two exports named `Helper` never
auto-pick. Nested `ColorObject>alpha` cannot steal exported `alpha`.

**Case:** `local_name` is `COLLATE NOCASE`; the same rule applies
case-insensitively. Do not add a second case-sensitive path.

**Test-file noise:** uniqueness is evaluated against whatever is indexed.
Kontur `*-test.tsx` files (not matching default `**/*.test.*`) inflate
counts; that is an exclude/config concern, not an identity-rule change.

### D2. Lever B — candidates on unresolved

Extend `ImpactIdentityResolution` unresolved arm:

```ts
{
  status: 'unresolved',
  reason?: 'unknown' | 'ambiguous',
  candidates?: ReadonlyArray<{
    symbolKey: string
    qualifiedName: string
    scopeTier: string
    filePath: string
  }>
}
```

- Cap at **5**, ordered: exported first, then `qualified_name` ASC
  (deterministic, not a rank guess used for acceptance).
- Text guidance lists those qualified names and points at retrying with
  `symbolKey`/`qualifiedName`.
- Zero matches → `reason: 'unknown'`, no candidates.
- Additive to `ImpactIdentitySchema` in `src/mcp/tools.ts`; existing clients
  that ignore unknown fields keep working.

### D3. Lever C — `Module#Name` partials

If canonical + unique-local fail, and identity matches `/^[^/#>]+#[^/#>]+$/`
(e.g. `Toast#Action`):

- Split into `module` / `name`.
- Exact SQL: `WHERE local_name = ?` and `module_key` ends with `module`
  **or** `qualified_name` ends with `'#'+name` with module path containing
  module — prefer a **deterministic** filter:

```sql
SELECT … FROM symbols
WHERE local_name = ?1
  AND (module_key LIKE '%/' || ?2 OR module_key = ?2)
```

- Exactly one row → accept (`matchedBy: 'qualified_name'` is wrong; use
  `'local_name'` **or** extend enum with `'module_name'`. Prefer
  `'module_name'` in the identity enum for honesty.)
- Else fall through to Lever B candidates.

**Open risk:** LIKE `%module` can over-match. Mitigate with exact segment
match: module_key equals `module` or ends with `/module` (no fuzzy).

### D4. Module layout (existing modules only)

| Concern | Module |
|---|---|
| Resolution stages | `src/search/index.ts` (`resolveCanonicalTarget`, `resolveExactCandidate`) |
| MCP payload / guidance | `src/mcp/server.ts`, `src/mcp/tools.ts` |
| CLI `impact` | reuses resolve; no CLI flag |
| Tests | `tests/impact.test.ts`, `tests/mcp/protocol.test.ts` |
| Fixture | `bench/fixtures/impact-ambiguity/` (tiny hand-picked tree) |
| Optional external | `scripts` or bench env `CODEINDEX_BENCH_REPO` |

No new package, no schema/indexer change.

### D5. Revert strategy (first-class)

- **Commits:** Lever A, Lever B, Lever C each its own commit; measure task
  last.
- **No runtime flag** (YAGNI). Revert is `git revert` of the lever commit(s)
  that the measure task marks throw.
- **Schema impact of B is additive.** Reverting A/C does not require removing
  the candidates field; reverting B alone removes candidates from responses
  and may leave an unused optional field (harmless).
- **Baselines:** do not re-stamp to silence failures. Measure task compares
  `bench:impact:check` / `bench:impact:fixture:check` and the ambiguity
  fixture; record keep/throw in the task checkbox note or a short
  `openspec/changes/.../decision.md` only if throw is chosen.

### D6. Measure-and-decide (required task)

After implementation, before archive:

1. Full `bun run check`.
2. Ambiguity fixture assertions green.
3. Impact benches still pass **without** re-stamp.
4. Optional: run env-gated external-repo score if `CODEINDEX_BENCH_REPO` is set.
5. Compare resolve-rate sample (unique-export bare names) old vs new on the
   fixture; expect 100% unique-export accept, 0 multi-export accepts.
6. Explicit keep or throw decision.

## Risks / Trade-offs

- [Unique-export accept picks export when agent meant a member] → agents
  rarely bare-type member names without a parent; if they do, candidates /
  `Module>member` forms still work. Measure on fixture.
- [Lever C LIKE/segment errors] → strict module_key segment match only;
  unit tests for over-match.
- [Token bloat from candidates] → cap 5; compact text summary; reuse
  compact-output conventions.
- [Impact baseline drift] → canonical keys only in oracles; verify, never
  re-stamp to pass.

## Migration Plan

1. Fail-test Lever A (export+member collision resolves to export; two exports
   unresolved).
2. Implement A; green tests + impact benches.
3. Fail-test Lever B (multi-export unresolved with ≥1 candidate; unknown has
   none).
4. Implement B; protocol tests for schema + guidance.
5. Fail-test Lever C (partial module#name; over-match rejected).
6. Implement C.
7. Fixture bench + measure-and-decide task; keep or revert per lever.

## Open Questions — resolved

| Question | Decision |
|---|---|
| Case sensitivity | Inherit `COLLATE NOCASE` only; no dual path |
| Test-file noise | Out of scope (config), not identity rule |
| Candidate cap | 5 |
| Rank-order guarantee | Preserved — cardinality only |
| Runtime feature flag | No — per-lever commits + git revert |
| External repo in CI | No — extracted fixture; env-gated optional |
| Impact baselines | Verify without re-stamp; throw lever if gates fail |
