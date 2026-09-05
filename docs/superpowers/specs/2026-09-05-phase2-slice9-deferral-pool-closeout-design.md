# Phase 2 Slice 9 — Deferral-Pool Close-Out (Design)

**Date:** 2026-09-05
**Status:** Design (brainstorm session 2026-09-05; user-approved scope decisions recorded in §2).
**Precondition satisfied by this slice:** the Phase 3 roadmap
(`2026-09-03-phase3-zg-inspired-roadmap-design.md`) requires the remaining deferral pool to land
before Phase 3 starts. The Slice 8 plan's numbering note re-labeled that pool "Slice 9".
**Source:** accumulated deferred minors from Slice 6/7/8 final reviews (recorded in
`.superpowers/sdd/progress.md`) plus two user-approved items (transaction batching, CLI `index <path>`).

---

## 1. Purpose

Phase 2's accuracy mission is complete (papai valueFN 0.455 → 0.114, typeFN 1.0 → 0, FP 0
like-for-like, IR flat-or-better). What remains is the pool: one accuracy residue, two
operational gaps that bit real workflows during Slices 7–8, one payload-honesty item, and a tail
of small hygiene minors. Slice 9 lands all of them so Phase 3 starts with an empty pool, an
atomic write path, a CLI that can index from anywhere, and an oracle that agrees with the engine
on accessor boundaries.

**Out of scope:** "navigation" (undefined scope; multi-hop call hierarchy / outgoing edges stay
agenda 3b, P4-tracked per the roadmap). MCP response preview economics stays P3-S2 — this slice's
payload item (§6) is only the `code_index` summary truthfulness gap.

## 2. User-approved scope decisions (this session)

1. **Pool composition:** full pool, drop navigation. Units: transaction batching + atomicity, CLI
   `index <path>`, oracle accessor agreement, payload honesty, hygiene minors.
2. **Atomicity:** rollback-on-failure (single explicit transaction) — NOT today's partial-persist.
3. **CLI `index <path>`:** in (killed a recurring plan-error class in Slices 7 and 8).

## 3. Guiding constraints

- **No SCHEMA_VERSION bump** — no unit touches table shape. U1 changes transaction boundaries and
  statement lifetime only; U3 is bench-only; U4 extends one zod output schema (additive,
  protocol-level, not DDL); U5 is code/test hygiene.
- Gates: all existing bench gates flat-or-better under the **like-for-like protocol** (measure
  pre-slice and post-slice against the same repo commit; commit SHA stamped per §7-U5 so future
  drift fails loudly). U1 must show a material indexing speedup on `bench/index-bench-run.ts`
  (`filesPerSecond`/`referencesPerSecond`); U3 must move papai `falsePositiveRate` to 0 on a
  corpus where the accessor target is sampled, with no FN regression beyond the boundary shift.
- TDD RED→GREEN for every behavioral change, per the standing cadence.
- Baselines regenerate ONLY in the final gate task (like Slices 7/8); intermediate tasks must not
  write baseline files.
- Conventional commits (`perf(indexer): …`, `feat(cli): …`, `fix(bench): …`, `chore(slice9): …`).

## 4. Unit 1 — Atomic transactional writes + statement hoisting

**Problem.** The write path commits per statement: every `db.query(...).run(...)` inside the
loops is its own implicit transaction (fsync per row), and `db.query()` re-prepares the statement
on every iteration (index-codebase.ts:200 reference loop; same pattern in the per-file
symbol/file writes through `src/storage/queries.ts` insert helpers). papai: ~105k reference rows
≈ 105k implicit commits + 105k statement preparations — the dominant cost of the 27 s full reindex.

**Design.**

- One explicit transaction wraps the **entire write phase** of a run: file upserts, symbol
  inserts, module aliases/exports, reference inserts, in-degree backfill, provenance stamp.
  `BEGIN` before the first write, `COMMIT` after the last; any throw → `ROLLBACK` and the error
  propagates (run fails, nothing persisted).
- Hoist all hot prepared statements out of the loops: prepare once per run, reuse per row.
  `bun:sqlite` keeps prepared statements cheap; the hoist is mechanical.
- **Failure semantics flip (user-approved):** a crash or mid-run failure leaves the *previous*
  index fully intact (or, on a fresh DB, an empty DB) instead of today's silent partial persist.
  The index result reported to the caller is unchanged in the success path.
- FTS triggers on `symbols` (schema.ts:104-112) still fire per row *inside* the transaction —
  per-row trigger cost remains, commit cost vanishes. Accepted; revisit only if index-bench
  says otherwise.
- WAL mode (`openDatabase`) is untouched; one writer per run was already true.

**Tests.** (a) failed-run rollback: inject a write failure (e.g., a malformed row or a spied
`run` throw) mid-run → assert the pre-run DB content is byte-intact and the command fails;
(b) success parity: same DB content as before the change on a fixture corpus (the existing
index-codebase tests largely pin this); (c) statement reuse is observable only via perf — no
test, measured by index-bench.

**Gate.** index-bench `filesPerSecond`/`referencesPerSecond` materially up; all other baselines
flat like-for-like.

## 5. Unit 2 — CLI `index [path]`

**Problem.** `codeindex index` ignores positional args and always indexes cwd
(src/cli.ts:101 — `loadConfigForPath()` receives cwd). Slice 7 and Slice 8 plans both wrote
`bun run start index ../papai` and silently indexed the wrong directory; both had to substitute
`(cd ../papai && bun …/cli.ts index)`.

**Design.** The `index` command accepts an optional positional path: resolve against cwd,
`loadConfigForPath(resolvedTarget)` (existing plumbing, already used by search/symbol/impact for
config discovery), run `indexCodebase` with that repo root — so the *target's own*
`.codeindex.json` governs. No argument = cwd, byte-identical behavior.

**Tests.** (a) index a temp fixture repo from a cwd outside it → files land in
`<fixture>/.codeindex/index.db` and the fixture's config governs; (b) back-compat pin: no-arg
invocation indexes cwd; (c) the S7/S8 bug shape: a positional arg that would previously be
ignored now changes the target.

**Gate.** CLI tests green; no other surface touched.

## 6. Unit 3 — Oracle accessor-boundary agreement

**Problem.** The oracle's `nearestNamedBoundary` (bench/impact-oracle.ts:175-190) treats
function/class/method/constructor/named-var declarations as attribution boundaries but not
accessors. A reference inside `get capabilities()` attributes to the enclosing *class*, while the
indexer (correctly) emits the accessor as a symbol row and attributes the reference to it. This
produced the residual papai FP on the 354e0b1e7 corpus (`ChatRouter>activeInstances`: oracle said
`ChatRouter`, engine said `ChatRouter>capabilities`).

**Design.** Add `ts.isGetAccessorDeclaration(a) || ts.isSetAccessorDeclaration(a)` to
`nearestNamedBoundary`'s boundary list — the Slice 5a constructor precedent, engine-side behavior
is authoritative, oracle aligns. Indexer untouched. This shifts oracle trueRef sets (references
inside accessors now attribute to the accessor) → all impact baselines regenerate in the final
gate task under the like-for-like protocol (worktree isolation against the pre-slice code if the
target corpus moved again, per the Slice 8 protocol).

**Tests.** Extend the existing impact-oracle attribution pins (constructor case lives in
tests/bench/impact-oracle.test.ts) with the accessor case: a getter-internal call attributes to
`Class>getter`, not `Class`.

**Gate.** On a corpus where an accessor target is sampled: papai FP 0 like-for-like; FN moves
only by boundary-attribution (accessor vs class), verified flat-or-better like-for-like.

## 7. Units 4–5 — Payload honesty and hygiene minors

### U4 — `code_index` payload honesty

- `summaryText` (src/mcp/server.ts:96) reports skipped files: `…, N files skipped` when
  `skippedFiles.length > 0` — an agent reindexing can currently believe a partial index is
  complete.
- `skippedFiles` in the structured payload (src/mcp/tools.ts:101) is unbounded; cap it (first 20
  paths) and add `skippedFilesTotal: number` so the truncation is explicit. Zod schema + protocol
  round-trip tests; `buildStructuredToolResult` contract unchanged.

### U5 — Hygiene minors (disposition table)

| # | Item (origin) | Disposition |
|---|---|---|
| 1 | `TYPE_SHAPED_KINDS` positive path tested only via `interface_declaration` (S8) | fix — data-table test covering all five kinds |
| 2 | Baselines don't record the indexed repo's commit; corpus drift silently invalidates gate comparisons (S8, hit twice) | fix — impact/IR/index runners stamp `repoHead` (git rev-parse of `--repo`) into the baseline JSON; runners emit a loud warning when the committed baseline's stamp ≠ current repo head |
| 3 | Alias-form `export { x as y }` linking untested (S7) | fix — linking test |
| 4 | `buildReexportResolver` star-precedence rationale comment missing (S7) | fix — comment |
| 5 | Multi-star-source first-hit-wins order untested (S7) | fix — pin test |
| 6 | `namespace_import` parent-level path untested (S7, cosmetic) | fix — cheap test |
| 7 | `eqNoCase` lowercases both sides per row (src/search/exact.ts:33) (S6) | fix — hoist the query-side `toLowerCase` out of the per-row loop (one allocation per query, not two per row); the row-side lowercase stays (columns are NOCASE-collated but case-preserving; a stored normalized column would be a schema change, out of scope per §3) |
| 8 | 1–2 char queries hit the prefix arm unguarded (S6) | fix — length guard + tests |
| 9 | `matchReason` doesn't mention `signature_text` even when it matched (src/search/fts.ts:86) (S6) | fix — reason string reflects the actual matched field |
| 10 | `'_'`/`'\'`-distinguishing LIKE behavior untested (S6) | fix — pin tests |
| 11 | Oracle type-shape (`classifyShape`) direct unit test missing (S6) | fix — table test |
| 12 | Pluralized acronym splitting in identifier_terms (S6) | fix — tokenize test + minimal tokenizer adjustment |
| 13 | `readGitignore` silently treats an unreadable `.gitignore` (e.g. EACCES) as no rules (S6, discover.ts:30-36) | fix — stderr diagnostic when the file exists but can't be read (a missing file stays silent — that's the normal case); readdir's non-ENOENT path already throws and is correct |
| 14 | Exact-tier NOCASE JOIN row multiplication (S6; pre-existing class, "slightly widened") | investigate — timebox; fix only if contained (audit row counts on a fixture with mixed-case names); otherwise document the class in the ledger |
| 15 | S8 final-review LEAVEs (typeRefs[1] assertion, test-2 name, queries.ts camelCase aliases) | stay left — recorded here so the pool's disposition is explicit |

Rationale for the two judgment calls: #7 and #14 touch the exact-match hot path that IR gates
pin; both land as behavior-preserving refactors with the IR baselines as the fence. #14 gets a
timebox because Slice 6 already scoped it as a pre-existing schema-level class, not a Slice 9
introduction.

## 8. Task shape (for the plan)

The natural task order, dependency-first:

1. U1 atomic writes + hoisting (perf + failure-mode tests, index-bench measure)
2. U2 CLI `index [path]`
3. U3 oracle accessor agreement (+ attribution pin tests)
4. U4 payload honesty + U5 minors in 2–3 batched tasks (tests-only items batch together; behavior
   items each get their own RED→GREEN)
5. Final: reindex, regenerate all baselines (stamps now include `repoHead`), like-for-like gate
   verification, `bun run check`, ledger entry, `chore(slice9)` commit

Baselines regenerate once, in the final task (standing constraint). U1's speedup and U3's
attribution shift both land before that single regeneration.

## 9. Risks

- **Atomicity flip** changes failure semantics callers might (wrongly) rely on — covered by the
  explicit rollback test; the MCP/CLI result shape is unchanged.
- **U3 shifts oracle denominators** (references inside accessors re-attribute) — absorbed by the
  like-for-like protocol; the shift is attribution-finer, not coverage-smaller.
- **#7/#14 exact-path refactors** could disturb IR pins — behavior-preserving with IR baselines
  as the fence; timeboxed.
- **`repoHead` stamping** requires a git repo at `--repo`; runners must tolerate non-git targets
  (stamp `null` + no warning) — bench fixtures are git repos today, but the fixture gate must not
  newly fail on a tarball checkout.

## 10. Success criteria

- All six baselines regenerated with `repoHead` stamps; every gate green like-for-like.
- index-bench shows the measured speedup; papai FP 0 like-for-like on a corpus sampling the
  accessor target; failure-rollback test proves old-index intactness.
- The ledger records the pool as formally empty — every historical minor either fixed or
  explicitly dispositioned in this spec's table — satisfying the Phase 3 precondition.
