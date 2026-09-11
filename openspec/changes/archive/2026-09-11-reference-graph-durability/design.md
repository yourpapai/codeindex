# Design: Reference graph durability

## Context

See proposal.md — Why. Mechanics established during exploration:

- `PRAGMA foreign_keys = ON` (`src/storage/db.ts:8`), so FK actions fire: when a file is reindexed, its symbols are delete+reinserted and every edge pointing at them gets `target_symbol_id = NULL` (`ON DELETE SET NULL`, `schema.ts`). The live DB reached 3,071/3,821 orphaned targets.
- Source endpoints **cannot** orphan: `source_symbol_id ... ON DELETE CASCADE` deletes the edge when the source symbol dies. The 580 `source_symbol_id IS NULL` rows were inserted that way — references extracted outside any captured symbol scope (module-level statements). They return `sourceQualifiedName: null` but keep `source_file_path` + `line_number`. This is an extraction-binding gap (2a territory), not durability: **source-side repair is out of scope**.
- Resolution only runs for files parsed in the current batch (`persistResolvedReferences` per `parsedFiles`), so edges from untouched files are never revisited.
- `persistResolvedReferences` already inserts edges with `targetSymbolId: null` when a candidate doesn't resolve (e.g., C3 order-dependent misses). Orphaned and never-resolved edges are therefore indistinguishable on disk — which makes **idempotent re-matching** the right frame: re-attempt resolution for every NULL-target edge; the two classes heal identically.
- The resolver's last-resort tier (`resolveByLocalName` + `findMatchedFileId`, `src/resolver/resolve-references.ts`) is module-scoped and needs only: source module key, `target_module_specifier`, module aliases, file table, symbols by local name. All of these are derivable from stored rows — `source_file_id` survives orphaning, and `target_name` / `target_module_specifier` are `NOT NULL` persisted columns.
- Index-run phase order (`index-codebase.ts:208-223`): `BEGIN` → persist symbols → `persistResolvedReferences` → `backfillSymbolInDegree` → prune → provenance → `COMMIT`. All writers (CLI index/reindex, `code_index` tool, watcher, startup catch-up) funnel through `indexCodebase`.

## Goals / Non-Goals

**Goals:**

- Edges survive incremental and watcher reindexes: after any indexing run, `code_impact` results converge to what a fresh full reindex would produce.
- Existing databases self-heal (today's 3,071 orphans) without wipe-and-rebuild.
- Empty `code_impact` responses explain themselves (H6), mirroring the `code_search` guidance contract.

**Non-Goals:**

- Stable `symbol_key` (2c) — byte-range identity churn (F4) is untouched; agents holding a stale symbolKey still get `[]`.
- Extraction completeness (2a) — JSX/member-call/heritage edges; source-side binding gaps stay.
- Re-export-chain re-walk in repair tier 1 (deferred, measured — see Open Questions).
- Graph-health metrics in responses (proposal Non-goals).

## Decisions

### D1 — Repair = idempotent re-match, not re-resolution

Run after `persistResolvedReferences` and before `backfillSymbolInDegree` inside the same `BEGIN`/`COMMIT` (`index-codebase.ts:214-215`). Repaired edges are counted by the existing in-degree recount in the same transaction; a crash rolls back cleanly.

*Alternatives considered:* full re-resolution per batch (reject: loads all symbols/aliases/files per watcher batch, G2 cost); post-commit repair pass (reject: extra transaction, in-degree staleness window, no atomicity with the batch); repair-on-open at DB connect (reject: duplicates the writer path; the freshness change's startup catch-up already performs an incremental run through `indexCodebase`, so first server start heals the DB).

### D2 — New module `src/indexer/repair-references.ts`, mirroring resolver tiers from stored rows

`persist-resolved-references.ts` owns candidate→row writes; repair owns row→row re-linking over persisted data with different inputs (stored rows, not fresh candidates) — a separate module, reusing the resolver's logic. `normalizeRelativeModule` must be exported from `resolve-references.ts` (currently module-private) rather than duplicated.

Repair loop over edges where `target_symbol_id IS NULL`:

1. Derive the source module from `source_file_id` → files table.
2. Derive the scope module exactly as the resolver does: if `target_module_specifier` is non-null, `normalizeRelativeModule(sourceModuleKey, specifier)` → `module_aliases` → files (this re-establishes `target_file_id` too); if null, bare reference → source module. A specified-but-unmatched module resolves to **nothing** — preserving C2 suppression (no codebase-wide guessing).
3. Match `target_name` against live symbols' `local_name` (NOCASE, as stored) within the scope module. Exactly one candidate → set `target_symbol_id` (+ `target_file_id`); zero or multiple → leave NULL.
4. Stored `confidence` is left as-is: it describes how the edge was originally resolved, and the re-link re-establishes the same binding class. Unmatched edges stay invisible to `code_impact` (`WHERE target_symbol_id = ?` cannot match NULL) — honest degradation, no stale-confidence leak.

The refuse-to-guess rule on ambiguity (step 3) is stricter than the old C2 fallback by design: repair must never manufacture an edge a full reindex would not have created.

*Alternatives considered:* SQL-only `UPDATE ... FROM` join (insufficient — module normalization and alias fallback need the resolver's logic; implementation may still batch the candidate fetch via one indexed SELECT of NULL-target rows for cost).

### D3 — Empty-impact guidance rides the existing `code_search` mechanism

`code_impact` with zero results emits `guidance` (static string) in both text and `structuredContent`, via the same emission path `code_search` uses (`server.ts`). Content: state zero incoming references; suggest confirming the name via `code_symbol`; note that a `code_index` full reindex rebuilds the graph if results look degraded. No orphan-count probing — static keeps the contract simple and costs nothing per query. Non-empty responses are byte-identical to today apart from previously-missing rows appearing.

### D4 — Verification: extend the edit fuzzer; regenerate impact baselines as an intent change

- `bench/edit-fuzz.ts` (exists) gains the durability invariant: after an N-edit sequence driven through incremental reindexes, the edge set / `code_impact` results must equal a fresh full reindex's ground truth on the same corpus. This is the failing-test-first gate for D1/D2. Known-and-measured divergence (barrel-routed targets, tier 2) is reported, not asserted.
- Impact baselines (`bench/impact-baseline.json`, `impact-baseline.papai.json`, `impact-baseline.fixture.json`): same corpora, same oracle — repair raises resolved-edge counts, so stamped baselines are regenerated in the final bench task as a **declared intent change** (oracle now measures a repaired graph), never to make a failing gate pass. Rationale recorded in the regeneration commit.
- `index-baseline.json` must absorb repair cost: one indexed pass over NULL-target rows, expected near-zero steady-state and sub-second on the current 3k backfill.

**Search semantics impact:** none — no ranking, `rankScore`, scope-tier, or `matchedBy` changes; `code_search` / `code_symbol` responses are byte-identical. Only `code_impact` result completeness and the empty-result `guidance` field move.

## Risks / Trade-offs

- [Ambiguous-name re-link creates false-positive resolved edges] → refuse-to-guess (D2 step 3); fuzzer asserts precision against full-reindex ground truth.
- [Repair diverges from full reindex for barrel-routed imports (no re-export chain re-walk)] → measured by the fuzzer; acceptable if divergence is small; otherwise tier 2 lands as a follow-up (see Open Questions).
- [Backfill cost on first run after upgrade] → single indexed pass inside the existing transaction; gated by `index-baseline.json`; one-time per DB.
- [`target_name` holding raw callee text (`obj.method`) can never re-match] → no regression — those edges were unresolved at insert too; B2 extraction work owns them.
- [Fuzzer ground-truth comparison is itself name-based] → same oracle as production `code_impact`; divergence metrics are like-for-like.

## Migration Plan

No schema change; no `user_version` bump. Existing DBs heal on the first indexing run after upgrade — startup catch-up for MCP-first sessions, `code_index`/CLI reindex otherwise. Rollback is a plain revert: repaired rows remain valid (repair only fills NULLs; it deletes nothing).

## Open Questions

- Re-export-chain re-walk (resolver tier over `module_exports`) in repair: defer unless fuzzer divergence on barrel corpora (papai has 6 known barrel misses) exceeds noise; the decision is measurement-gated and does not change specs or task order (tier 2 slots into the same repair loop if needed).
- Exact repair-row fetch shape (one indexed SELECT of NULL-target rows vs per-row lookups): performance-neutral at current scale; settled by the `index-baseline.json` gate during implementation.
