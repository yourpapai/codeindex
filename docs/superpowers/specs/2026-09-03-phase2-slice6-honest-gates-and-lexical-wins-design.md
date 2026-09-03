# codeindex Phase 2 Slice 6 — Honest Gates & Lexical Wins (Design)

**Date:** 2026-09-03
**Status:** Approved design. All four units are **firm** scope.
**Source:** The Slice 5 follow-up state (remaining Phase 2 candidate pool), the Phase 2 candidate
list in `docs/superpowers/specs/2026-07-20-codeindex-roadmap-design.md`, and the gap catalog
`docs/research/04-gaps-and-opportunities.md` (all lexical items re-verified against current code
on 2026-09-03 — see "Current state" per unit).

---

## Purpose

Phase 2's graph work (Slices 2–5) drove papai's value FN rate from 0.455 → 0.102. What remains in
Phase 2 is a floor of small, no-research items: the lexical correctness bugs that silently suppress
good matches (1b), the one ranking signal the index already stores but never consults (1a
remainder), the unsized type-tier gate number, and the one robustness hole (unbounded parse input).
This slice banks all of them in one migration so Phase 2 can close on an honest set of gates.

**Approach decision (user-approved):** one `SCHEMA_VERSION` 3→4 bump carries everything
schema-touching — `COLLATE NOCASE` declarations, the `in_degree` column, and the refreshed
`identifier_terms` content — because the tokenization change makes old indexes silently stale
(`identifier_terms` is extract-time-derived), so the wipe-and-reindex is forced regardless. Folding
the other schema changes into the same migration costs users nothing extra.

---

## Unit 0 — Type-tier sizing memo (bench-only, opens the slice)

**What.** papai's committed baseline reports `typeFalseNegativeRate: 0.9949` — the worst gate
number in the project and nobody has ever categorized its population. Extend the Slice 5
methodology to the type tier: in `bench/impact-oracle.ts` / `bench/impact-score.ts`, break the
type-tier FN population down by shape/category, trace each category to actual papai source, and
produce a categorized table like Slice 5's call-FN table.

**Deliverable.** A follow-up subsection in this spec (amended during implementation, matching the
Slice 5 pattern) with: the categorized table, oracle-artifact vs real-gap verdict per category, and
a recommendation — real gap → candidate edge-type for a later spec; oracle artifact → bench fix
filed as a follow-up.

**Scope rule.** This unit is a read-out, not a gate. It does **not** reshape the other units; a
real type-tier gap spawns a follow-up spec, it does not expand Slice 6.

---

## Unit 1 — Lexical fixes (1b)

All five items re-verified open against current code.

### 1.1 NOCASE exact tier

`symbols.local_name = ?` uses the default BINARY collation (src/search/exact.ts:106), so a
case-mismatched query silently skips the high-scoring exact tier while FTS (unicode61, which folds
case) still matches — an inconsistency agents hit constantly.

**Fix.** Declare `COLLATE NOCASE` on `symbols.local_name`, `symbols.qualified_name`, and
`module_exports.export_name` (the JOIN at exact.ts:105 must fold too). Column-level declaration, so
every comparison site is fixed at once. JS-side `matchReason` comparisons in `mapExactRow`
(exact.ts:70-76) switch to case-insensitive equality so the reported reason stays truthful.
SQLite's NOCASE folds ASCII only — sufficient for identifiers; noted, not a limitation for this
use. FTS tier unaffected.

### 1.2 FTS snippet column

`snippet(symbol_fts, 5, …)` (src/search/fts.ts:60) snippets column index 5 = `doc_text` — empty for
the overwhelming majority of symbols, so agents get useless snippets from the FTS tier.

**Fix.** Column index 4 = `signature_text`: populated for nearly all symbols and carries the
identifier in context. Exact-tier's `buildSnippet` fallback path unchanged.

### 1.3 Activate the dead prefix index

`prefix='2 3'` is declared on `symbol_fts` (src/storage/schema.ts:101) but no query in `src/` ever
issues an FTS prefix match — the index is built and never read.

**Fix.** The FTS tier gains a prefix-MATCH alternative on `local_name` and `identifier_terms` for
partial-identifier queries (query text with no whitespace). Exact matching remains the primary
path; the prefix clauses only widen the FTS tier's candidate net. Exact syntax decided in the
implementation plan.

### 1.4 Escape LIKE wildcards

`file_path LIKE ?` is fed `${query}%` raw (src/search/exact.ts:112): a query containing `%`, `_`,
or `\` silently becomes a wildcard pattern and over-matches.

**Fix.** Escape `\`, `%`, `_` in the LIKE argument (with `ESCAPE '\'`) at this site; it is the only
LIKE in `src/` (verified).

### 1.5 Acronym-run tokenization

**Honest current state (verified 2026-09-03):** `normalizeIdentifierTerms`
(src/indexer/extract-symbols.ts:53) **already** splits camelCase boundaries and snake/kebab glue —
`foo_bar` → `foo bar` works today. The research doc's "snake/kebab glued" claim is stale. The real
residue: **acronym runs** — the regex `([a-z0-9])([A-Z])` never matches an uppercase→uppercase
boundary, so `XMLParser` normalizes to `xmlparser` and the token `parser` can never hit it.

**Fix.** Add an acronym-boundary rule (`([A-Z]+)([A-Z][a-z])` → `$1 $2`, applied before the
existing camel rule) so `XMLParser` → `xml parser`, `HTTPClient` → `http client`. Additive: only
new terms appear; existing matches cannot regress.

---

## Unit 2 — In-degree ranking (1a remainder)

`rank.ts` blends scope tier + match reason + normalized BM25 (`RELEVANCE_WEIGHT = 100`) but never
consults `symbol_references` — "used by N callers" is stored and ignored.

**Fix.**

- New `symbols.in_degree` INTEGER column (default 0), populated by a single post-resolve
  statement in the resolve phase (src/indexer/index-codebase.ts:178 region):
  `UPDATE symbols SET in_degree = (SELECT COUNT(*) FROM symbol_references WHERE target_symbol_id = symbols.id)`.
  One statement per index run, not per query — search pays nothing.
- `rank.ts` adds a bounded, log-dampened term in the established style:
  `IN_DEGREE_WEIGHT × log1p(in_degree) / log1p(maxInDegree)` normalized across the current result
  set (mirrors the BM25 blending pattern so a popular symbol reorders *within* its tier without
  overtaking exact-name matches of rarer symbols).
- Weight calibrated once against the IR gate (precision@k + MRR on the golden corpus): pick the
  default value with a measured gain and no regression, then freeze it in code. Calibration is a
  one-off bench run during implementation, not a runtime knob.

---

## Unit 3 — File-size guard (robustness ride-along)

Tree-sitter parse cost is unbounded today; a stray minified bundle in the repo can stall indexing.

**Fix.** `discoverSourceFiles` (src/indexer/discover.ts:62) skips files larger than
`maxFileSizeBytes` — default 1,000,000 bytes, overridable via a new optional `.codeindex.json` key
of the same name. Skipped files are reported as a per-file warning line in the index summary (the
existing phase-reporting path), not silently dropped. Schema validation of the config accepts the
new optional key.

---

## Migration

`SCHEMA_VERSION` 3→4 (src/storage/schema.ts:120). Existing auto-wipe-on-mismatch behavior applies,
so the first run after this slice reindexes: new collations, `in_degree` backfill, and refreshed
`identifier_terms` all land together. All three bench baselines (codeindex, fixture, papai) are
regenerated at HEAD after units land — the established byte-identical-verification workflow.

---

## Global constraints

- Shipped behavior changes are limited to the units above; no resolver/graph changes this slice.
- The IR regression gate must not regress: precision@k + MRR up-or-flat on the golden corpus; the
  in-degree weight ships only with a measured gain.
- No false-positive risk is introduced: NOCASE, snippet, prefix, LIKE, and tokenization are
  candidate-widening or display fixes; the impact gates (FN/FP rates) must stay flat-or-better.
- Every fix lands with a RED→GREEN unit test per the established TDD workflow.

---

## Testing & verification

| Unit | Test |
|---|---|
| 1.1 NOCASE | exact-tier hit with case-mismatched query; `matchReason` still accurate |
| 1.2 snippet | FTS-tier result returns non-empty snippet for a symbol with empty `doc_text` |
| 1.3 prefix | partial identifier (`"parser"`) matches `XMLParser` via FTS tier |
| 1.4 LIKE | query `foo%bar` matches literal filename only, not wildcard expansion |
| 1.5 tokenization | `XMLParser` / `HTTPClient` normalize to split variants; existing normalizations byte-identical |
| 2 in-degree | ranking reorders by in-degree within a tier; weight-zero equivalence test |
| 3 guard | oversized file skipped with warning; config override respected |
| Unit 0 memo | bench-only; categorization reproducible via the impact bench commands |

**Definition of done.** `bun run check` green (lint 0/0, typecheck, format, full test suite); all
three bench gates pass with regenerated baselines; IR precision@k/MRR up-or-flat; type-tier memo
table amended into this spec; slice marked complete in `.superpowers/sdd/progress.md`.

---

## Deliberately out of scope (deferred, not forgotten)

- B5 `export *` / `import * as ns` bridging — Slice 7.
- C2 FP-fallback suppression — Slice 7, after its FP rate is measured.
- Call residue #7 (import-then-`export { x }`) and #4/#5 (nested scope-path) — Slice 7.
- Payload duplication / pagination (3a), navigation primitives (3b), transaction batching (4a) —
  Slice 8.
- `obj.m()` member-call resolution — Phase 3, gated with 2b.
- Any type-tier *edge work* implied by the Unit 0 memo — follow-up spec, not this slice.
