## Context

See `proposal.md` — Why. Exploration settled on **Way A** (store the line at index time) over Way B (slice `body_text` at query time): B dies on all import/re-export edges (no enclosing symbol) and on bodies clipped by `maxStoredBodyLines`; A covers every edge type and matches how search previews already work.

Dogfood index (codeindex self): 5,393 refs; resolved imports 220 and re-exports 33 have **zero** enclosing symbols; resolved calls 354 / type_refs 459 / references 30 are mostly symbol-backed. Highest in-degree targets are types — a one-line excerpt is the answer agents need. `code_outline` (W2, live) does not replace this.

Constraints that shape the approach:

- `SCHEMA_VERSION` wipe-and-rebuild is established policy (`src/storage/schema.ts`).
- Compact-output: text channel stays skim; snippets live only in `structuredContent`.
- `impact-lookup` amend: identity/location/row-set stable; extra preview fields allowed.
- W4 multi-hop will reuse the same result row shape — snippet must not be a 1-hop-only hack.

## Goals / Non-Goals

**Goals:**

- One clipped start-line snippet per reference edge, captured at extract, served by `code_impact` and CLI `impact`.
- Cover imports/re-exports as well as symbol-backed calls/types.
- No query-time disk I/O; no `preview` param; no ranking/identity changes.
- Schema v6 migration via existing wipe path; repair keeps stored line.

**Non-Goals:**

- Multi-line windows, caller signatures, `preview` density knobs.
- Way B (body_text slicing) as a fallback path.
- Outgoing/multi-hop impact (W4) beyond “the row shape already has snippet.”
- Agent-bench L3/L4 “fewer Read” claims; baseline re-stamps unless gates actually break.

## Decisions

### D1 — Store at extract, not at persist-from-JS-only

**Choice:** compute `lineText` in `extract-references.ts` where `source` and `node` are in memory; put it on `ReferenceCandidate`; persist in `persistResolvedReferences`. **Alt:** re-read the file at persist time (extra I/O, already have source). **Alt:** compute only at MCP layer from disk (Way B — rejected).

### D2 — Clip to one line, 160 chars, at extract

**Choice:** `sourceLines[lineNumber - 1]`, trim end, hard-clip to 160 with ellipsis — same budget family as `preview.ts` `anchorLine`. **Alt:** clip at MCP (wastes DB bytes; different densities later). **Alt:** `node.text` (misses import statement context; more collector sites to touch). Empty string if the line is missing — never invent text.

### D3 — Column name `line_text`; DTO field `snippet`

**Choice:** SQL column `line_text` (describes storage); public field `snippet` (parity with `SearchResult`). **Alt:** `snippet` in SQL too (fine, but `line_text` is more honest for a single line). No rename later when W4 grows density.

### D4 — Schema bump 5→6, wipe-and-rebuild

**Choice:** bump `SCHEMA_VERSION`; existing DBs drop tables and require reindex (project policy). No ALTER/backfill script. **Alt:** `ALTER TABLE … ADD COLUMN` + partial backfill (out of character; repair path complexity). Document the wipe in the migration plan.

### D5 — Thread `lineText` through resolver without remapping

**Choice:** `resolveReferenceCandidates` passthrough already carries candidate fields; add `lineText` alongside `lineNumber` so unresolved inserts also store it (free; repair may benefit). **Alt:** only store when `target_symbol_id` is set (saves little; complicates persist).

### D6 — MCP: schema + passthrough only

**Choice:** add `snippet: z.string()` to `ImpactResultSchema`; results already flow through `buildStructuredToolResult`. Freshness wrapper keys on `sourceFilePath` — unchanged. Text summary unchanged. **Alt:** `applyPreview` on impact (rejected — no `preview` param).

### D7 — Module placement

- `src/indexer/collect-export-candidates.ts` — `ReferenceCandidate.lineText`
- `src/indexer/extract-references.ts` — fill from source lines
- `src/indexer/persist-resolved-references.ts` — INSERT column
- `src/storage/schema.ts` — column + SCHEMA_VERSION 6
- `src/search/impact-types.ts` — `ImpactResult.snippet`
- `src/search/impact-identity.ts` — SELECT/map
- `src/mcp/tools.ts` — `ImpactResultSchema`
- CLI `impact` rides the same DTO (no separate formatter today)

Search semantics: **none**. `rankScore`, `matchedBy`, scope tiers untouched.

## Risks / Trade-offs

- [Wipe on open surprises a user mid-session] → same as prior schema bumps; watcher/startup already rebuilds via ensureSchema; mention in changelog/PR.
- [~80B × N edges storage] → measured; smaller than `body_text` already on symbols.
- [Multi-line call expressions start-line-only] → acceptable for W3; W4 can widen later without rename.
- [Bench JSON shape drift] → scorer keys on source identity; amendment documents that; run `bun run check:bench` before claiming done.
- [repair-references doesn't re-extract] → stored line may drift from disk until that file reindexes; same staleness as `body_text`/line_number today.

## Migration Plan

1. Land schema + extract + persist + query + MCP together (single change).
2. On open: `ensureSchema` sees user_version < 6 → wipe → recreate with `line_text`.
3. Next `code_index` / watcher catch-up backfills all references.
4. Rollback: revert code; old schema v5 readers ignore/drop v6 DB — full reindex again. No dual-write period.

## Open Questions

- Whether papai densifies past-clip pressure enough to matter later — irrelevant for A (we store the line regardless). Defer any density knob to W4.
- Whether dogfood telemetry will show agents skipping file reads after W3 — W11/W17 measurement, not a gate for this change.
