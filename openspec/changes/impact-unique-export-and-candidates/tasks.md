# Tasks: Impact unique-export + candidates + module#name

Each lever is its own commit. Do not re-stamp impact baselines to silence
failures. The measure-and-decide task is mandatory before archive.

## 1. Lever A — unique-export bare local names (test-first)

- [x] 1.1 Write failing tests in `tests/impact.test.ts`: (a) export + member/local collision (`alpha`) resolves to the export with `matchedBy: local_name`; (b) two exports sharing a name stay unresolved; (c) unique-among-all behavior unchanged; (d) canonical `symbol_key` / `qualified_name` paths unchanged. Verify: `bun test tests/impact.test.ts` (red for new cases)
- [x] 1.2 Implement unique-export acceptance in `resolveExactCandidate` (`src/search/index.ts`): if all-symbols match count ≠ 1, accept iff exactly one `scope_tier='exported'` row. No rank/score. Verify: `bun test tests/impact.test.ts` (green)
- [x] 1.3 Confirm impact benches without re-stamp: `bun run bench:impact:check && bun run bench:impact:fixture:check`. Verify: gates pass or only pre-existing drift; no baseline files modified

## 2. Lever B — honest ambiguity candidates (test-first)

- [ ] 2.1 Write failing tests: multi-export bare name → `unresolved` + `reason: 'ambiguous'` + candidates (≤5, exported first, `qualifiedName` ASC) and empty `results`; unknown → no candidates; success paths omit `reason`/candidates. Verify: `bun test tests/impact.test.ts tests/mcp/protocol.test.ts` (red)
- [ ] 2.2 Extend `ImpactIdentityResolution` + `ImpactIdentitySchema` + `CodeImpactOutputSchema` in `src/search/index.ts` / `src/mcp/tools.ts` (additive fields only). Verify: `bun test tests/mcp/tools.test.ts`
- [ ] 2.3 Implement candidate collection and unresolved guidance in `resolveIncomingReferences` / `src/mcp/server.ts` (cap 5; list qualified names; no `code_index` advice; no auto-pick). Verify: `bun test tests/impact.test.ts tests/mcp/protocol.test.ts` (green)
- [ ] 2.4 Update `code_impact` description for candidates + unique-export form. Verify: description assertions in `tests/mcp/protocol.test.ts`

## 3. Lever C — `Module#Name` partials (test-first)

- [ ] 3.1 Write failing tests: `Toast#Action` resolves when exactly one `Action` has module_key `Toast` or `*​/Toast`; `Module#Name` does not match `MyModule` or sibling modules; ambiguous partial stays unresolved with candidates; canonical full qualified_name still wins first. Verify: `bun test tests/impact.test.ts` (red)
- [ ] 3.2 Implement segment-exact `module#name` stage (after unique local, before unresolved) with `matchedBy: 'module_name'` (extend identity enum). Verify: `bun test tests/impact.test.ts tests/mcp/protocol.test.ts` (green)
- [ ] 3.3 Document `Module#Name` in tool description. Verify: protocol description assertions

## 4. Third-party-shaped fixture + optional external check

- [ ] 4.1 Add `bench/fixtures/impact-ambiguity/` (hand-picked tiny tree: one export+member name collision, two same-name exports, one `Module#Name`-style pair) plus a small runner or unit harness that scores unique-export accept / multi-export refuse+candidates / partial accept. Verify: `bun test tests/bench/impact-ambiguity.test.ts` (or equivalent) green
- [ ] 4.2 Optional env-gated path: if `CODEINDEX_BENCH_REPO` is set, score bare unique-export names on that repo’s index and print keep/throw metrics (do not fail CI when unset). Verify: script runs locally with env set; skipped cleanly when unset

## 5. Measure and decide — keep or throw

- [ ] 5.1 Run full `bun run check` (lint, typecheck, format:check, test, check:bench). Verify: exit 0 without re-stamping `bench/impact-baseline*.json`
- [ ] 5.2 Record measurement: fixture resolve rates (unique-export 100%, multi-export 0 auto-pick), impact FN/FP vs pre-change, and any protocol token-size delta. Verify: numbers written in this file’s decision note or commit message
- [ ] 5.3 Explicit decision: **KEEP** all levers, or **THROW** named levers via `git revert` of that lever’s commit(s). If throw, re-run `bun run check` and leave remaining levers green. Verify: decision recorded; working tree consistent with the decision

## Decision note

*(fill during 5.2–5.3)*

- Date:
- Impact bench delta:
- Fixture rates:
- Decision (KEEP / THROW A / THROW B / THROW C):
- Reverts applied:
