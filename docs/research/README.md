# codeindex — Research Findings (Next-Iteration Discovery)

**Date:** 2026-07-19
**Status:** Discovery complete; findings feed the research agenda in `05-research-agenda.md`.

## Purpose

This directory captures a complete, detailed discovery pass over the current `codeindex`
implementation, gathered to inform the **next iteration of improvements**. It documents
*what exists today* (with `file:line` precision), *every concrete gap/limitation/bug found*,
and *a prioritized research agenda* for what to investigate and build next.

These are working research notes, not user documentation. They are intentionally exhaustive
so that later work does not have to re-derive the current-state map.

## Methodology

Findings were gathered by:

1. **Three parallel read-only exploration passes**, one per subsystem, each asked to produce
   a factual technical inventory with `file:line` references (capabilities, data flow,
   limitations, design decisions) — no suggestions, just the ground truth of the code:
   - Indexing pipeline (parser, discovery, symbol/reference extraction, resolution, impact)
   - Storage + search + ranking (SQLite schema, FTS5, exact/FTS search, rank)
   - MCP / CLI / config / testing surface
2. **Live database inspection** — dumped the schema, per-table row counts, and symbol-kind
   distribution from this repo's own `.codeindex/index.db` (primary data, see `02-...`).
3. **Git history review** — trajectory and the implied "tier1" roadmap.
4. **An independent cross-check pass** — pressure-tested prioritization and surfaced blind
   spots that a single framing would miss (folded into `04-...` and `05-...`).

## Contents

| File | What it contains |
|---|---|
| `01-indexing-pipeline.md` | Full inventory of the indexing pipeline: `parser.ts`, `discover.ts`, `extract-symbols.ts`, `extract-references.ts`, `index-codebase.ts`, the resolvers, and `impact.ts`. Stage-by-stage behavior, end-to-end data flow, limitations, and design decisions. |
| `02-storage-search-ranking.md` | Full inventory of storage + search + ranking: the complete SQLite schema, FTS5 configuration, exact/FTS/rank search semantics, limitations, design decisions — plus the **live DB dump** (schema + row counts + kind distribution). |
| `03-mcp-cli-config-testing.md` | Full inventory of the user-facing surface: the 4 MCP tools, CLI commands, `.codeindex.json` config, and the test suite. |
| `04-gaps-and-opportunities.md` | A **consolidated, categorized catalog** of every concrete gap, bug, and limitation found across all three inventories, plus cross-cutting risks/blind spots. The actionable synthesis. |
| `05-research-agenda.md` | The prioritized, forward-looking **research agenda** — tracks, benefit/effort/risk comparison matrix, phased sequencing, additional scenarios, and how each direction improves the core goals. |

## The core goal (the lens everything is evaluated against)

> Help AI coding agents (and maintainers) retrieve the **right** code context —
> **accurately** and **cheaply** — and answer "where is X / who uses X" without reading
> whole files.

Decomposed into four axes used throughout these notes:

- **Accuracy** — right symbols and right edges.
- **Cheapness** — few tokens and few round-trips per answer.
- **Freshness / coverage** — index stays complete and current through edit loops.
- **Reach** — how many languages and repo shapes are usable.

## Executive summary of findings

**Current state.** codeindex is a solid *lexical / structural* v1:

- A symbol-first SQLite index (`symbols`, `symbol_references`, `module_exports`,
  `module_aliases`, `files`) with an FTS5 mirror (`symbol_fts`).
- Search is **exact-first + FTS5 BM25 fallback**, reranked by a static
  `scopeTier + matchReason` score.
- The reference graph is **name/text-based with a confidence tier**
  (`resolved | file_resolved | name_only`); **no type checker ever runs**.
- Incremental indexing exists (content-hash diff + single-hop dependent reprocessing).
- 4 MCP tools: `code_search`, `code_symbol`, `code_impact`, `code_index`.

**Headline gaps.** The index is lexically strong but *semantically shallow*, and nothing
measures its quality:

- **Resolution is name-only**, and an unresolvable import specifier falls back to matching
  *any* same-named symbol codebase-wide (false-positive risk).
- **The reference graph misses the dominant real-world TS/React patterns** — JSX component
  usage, `obj.method()` / `this.x()` calls, `extends` / `implements`, `import * as ns`, and
  `export * from` barrels all produce **zero or garbage edges**. `code_impact` therefore
  *systematically under-reports* usage.
- **Ranking discards signals it already stores** — every FTS hit scores 0 regardless of BM25,
  symbol in-degree is never consulted, and the configured `prefix='2 3'` FTS indexes are never
  queried.
- **There is no way to measure retrieval quality** — zero golden queries, no precision/recall,
  and MCP tests never cross the protocol boundary.
- **The agent surface is thin and token-heavy** — every response is duplicated
  (`content.text` + `structuredContent`, ~2× tokens), no pagination, no navigation primitives.

## Key conclusions (carried into the agenda)

1. **An evaluation & correctness harness is the single highest-leverage bet.** Almost every
   accuracy/quality improvement is *unmeasurable* today; the harness converts the rest of the
   agenda from opinion into findings and gates the highest-value work.
2. **Completing the reference graph is the best accuracy-per-effort feature.** The fixes
   (JSX, member calls, `extends`/`implements`, barrels) are mostly cheap heuristics that need
   no type checker, and they repair the flagship `code_impact` tool.
3. **Ranking has free, unused signals.** In-degree and BM25 magnitude are already available;
   blending them is a small, high-return change.
4. **Type-aware resolution and semantic search are real ceilings but should be *measured,
   gated* bets, not assumed builds** — an agent caller may not hit the lexical gap often
   enough to justify the cost.
5. **False negatives in `code_impact` are safety-critical** — a missed "who calls this" is
   what lets an agent confidently ship a breaking change.
