# Proposal: Compact output (token economics) — P3-S2

## Why

The agent A/B rig measured the with-arm paying a 1.8–2.5× input-token premium over the
grep-only arm on exactly the relational tasks where codeindex wins (`who-uses-*`, deep
`explain-*`), at n=30 per arm. The text channel is already one summary line; the bytes
flow through `structuredContent` (full result arrays: `snippet`, `rankScore`,
`confidence`, `exportNames`, per-hit freshness) whose size no log can currently see.
Until responses shrink, codeindex stays a cost premium for its own best use cases.

## What Changes

- `code_search` / `code_symbol` gain `preview: "none" | "short" | "full"` (default
  `none`): `snippet` becomes a single anchor line (~160 chars) from stored
  body/signature text; `short` is a ~10-line window; `full` is today's shape.
- Metadata elision: when the anchor line already contains the symbol's local name,
  redundant name/kind lines are dropped from per-result text.
- **One channel per field**: no field fully duplicated across the text summary and
  `structuredContent` (settles gap H1; verify current duplication state in the slice
  spec — the contract, not the current bug, is the requirement).
- Query log records `response_bytes` per tool call (storage schema bump + backfill-free
  migration; existing logs keep NULL).

## Capabilities

### New Capabilities

- `compact-output`: preview modes, metadata elision, single-channel field contract, and
  `response_bytes` logging for MCP tool responses.

### Modified Capabilities

(none — `openspec/specs/` is empty; no main specs exist yet to modify)

## Impact

- Surfaces: MCP tools (`CodeSearchInputSchema`, result schemas, text builders in
  `src/mcp/server.ts` / `src/mcp/tools.ts` — extends the existing
  `buildStructuredToolResult` path, no new module), search layer (`src/search/exact.ts`
  `buildSnippet` as the anchor-line seed), storage (query log schema: `response_bytes`
  column), no indexer or CLI changes.
- Exact-first semantics unchanged; ranking and hit-rate byte-flat in `full` mode.
- Bench: deterministic gates unchanged; agent rig (`bench:agent`) is the advisory
  acceptance instrument — input-token delta on `who-uses`/`explain` tasks after S2 vs
  the fresh reps=3 stamp at head `a497785`.
- Without this change: the with-arm cost premium persists; `response_bytes` (shared
  with P3-S3 instrumentation) stays unmeasurable.

## Non-goals

- S3 study instrumentation beyond `response_bytes` (token-shape classification, tier
  served) — stays with P3-S3.
- Rig hygiene (judge scores empty/errored records as fake ties; timeout surfacing;
  `review-impact` oversizing) — declined here; candidate for a separate bench-hygiene
  change.
- `mode`/`refresh` params on `code_symbol`, HTTP transport, auth — P3-S5 remainder.
- Semantic route + sqlite-vec — P4, gated on the S3 memo.
- Changing default `limit` values or demoting `path_prefix` from the exact pool.
