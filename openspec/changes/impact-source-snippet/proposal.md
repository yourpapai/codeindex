## Why

`code_impact` returns `file:line` without the calling code, so an agent must issue a second lookup (`code_outline`, `code_search`, or a file read) to see *how* a symbol is used. Backlog **W3** (priority 82, Cheapness) and gap **E6**. `code_outline` (W2) answers “what’s in this file,” not “what’s on this call line.” Highest in-degree targets on dogfood are types (`CodeindexConfig`, `SearchResult`) where a one-line excerpt answers type-only vs value, annotation position, etc.

## What Changes

- Store a clipped source-line `line_text` on each `symbol_references` row at index time (extract already has full `source` in memory).
- Surface it on every `ImpactResult` as `snippet` — same name as `SearchResult.snippet`, still one line, no `preview` param.
- Thread through extract → resolver → persist → `queryIncomingRows` → MCP `ImpactResultSchema` → CLI `impact` JSON.
- Bump `SCHEMA_VERSION` 5→6 (existing wipe-and-rebuild policy); old DBs full-reindex on next open.
- Amend `impact-lookup`’s “byte-identical” clause: row *set* and identity/location fields stay identical; a new preview field is allowed.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `impact-lookup`: each incoming-reference row SHALL carry a clipped source-line snippet; the canonical-key / bench byte-identical requirement is amended to allow the new field while keeping identity, location, edge type, confidence, and row-set stable.

Without this, impact stays a phonebook and the W3 second-lookup cost remains; W4 multi-hop inherits a result shape with no calling code.

## Impact

- **Surfaces:** indexer (`extract-references`, `collect-export-candidates`, `persist-resolved-references`), storage schema (`symbol_references.line_text`, SCHEMA_VERSION 6), search (`impact-types`, `impact-identity` query), MCP (`tools.ts` ImpactResultSchema, `server.ts` pass-through), CLI `impact`.
- **APIs:** `ImpactResult` gains `snippet: string`; `ReferenceCandidate` gains `lineText`; no new MCP tool, no input-schema change.
- **Bench:** impact scorer keys on source identity — FN/FP gates should hold without re-stamping; confirm with `bun run check:bench`.
- **Telemetry:** `response_bytes` grows by ~80 chars × result count (structuredContent only; text channel stays a skim summary).
- **Not touched:** search ranking, identity resolution order, freshness decoration, `code_outline`.

## Non-goals

- Multi-line / ±N window snippets (W4 / context bundles).
- `preview` param on `code_impact`.
- Caller-symbol signature on the row.
- Query-time disk reads or `body_text` slicing (rejected Way B).
- Outgoing-direction or multi-hop impact.
- Pagination / `hasMore`.
- Agent-bench L3/L4 “fewer Read calls” claims (W11/W17).
