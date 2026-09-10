# Design: Compact output (token economics) — P3-S2

## Context

See proposal.md — Why. Grounding from the live tree:

- **Text is already skim-sized.** `src/mcp/server.ts` builds a one-line summary
  (`N result(s): name, name, …` + freshness suffix). Gap H1's "~2× full JSON in
  both channels" is no longer accurate for the text channel. The remaining bytes
  are in `structuredContent` (`RankedSearchResultSchema` in `src/mcp/tools.ts`):
  every hit carries multi-line `snippet`, `exportNames[]`, `confidence`,
  `rankScore`, `matchedBy`, freshness — times `limit` (default 10).
- **Snippet sources.** Exact path: `buildSnippet` in `src/search/exact.ts`
  already caps at **3 body lines** (or signature, or qualifiedName). FTS path:
  SQLite `snippet(symbol_fts, …)` in `src/search/fts.ts`. Neither is a single
  160-char anchor, and neither is controllable by the caller.
- **Query logging wraps deps, not the MCP envelope.** `src/mcp/query-logging.ts`
  sees result arrays and latency, not the bytes the host receives. Schema v1
  (`src/storage/query-log.ts`) uses wipe-and-rebuild on version bump; this slice
  must **preserve** dogfood history (proposal: existing rows keep NULL).
- **Acceptance instrument.** Agent A/B rig (`bench/agents/`) with the reps=3
  stamp at `913bc90` / head `a497785`: with-arm pays +13% cost and +5% input
  tokens overall, and 1.8–2.5× input on `who-uses-*` / `explain-*`. Deterministic
  IR/impact baselines must stay flat; they do not measure bytes.

Host-injection note: some hosts inject only `content[].text` into model context;
others surface structured tool results too. The A/B premium on relational tasks
implies the larger payload reaches the model (structured and/or follow-up reads
because summaries lack anchors). Shrinking `structuredContent` is still correct:
it is the MCP response size, it is what `response_bytes` measures, and it is the
channel this slice controls. Whether a given host also needs a richer text
channel is verified against the A/B delta after landing, not assumed here.

## Goals / Non-Goals

**Goals:**

- Caller-controlled snippet density (`preview`) with a cheap default.
- One channel per field: text = skim, structured = authoritative.
- Measurable response size (`response_bytes`) shared with P3-S3.
- Ranking / exact-first / `mode` byte-flat under every preview value.

**Non-Goals:**

- S3 instrumentation beyond `response_bytes` (proposal).
- Rig hygiene, HTTP/`refresh` on `code_symbol`, semantic route (proposal).
- Changing `buildSnippet`'s 3-line body cap for search-layer callers that are
  not the MCP tools (search API stays; MCP applies preview on top).
- Adding snippets to `code_impact` (gap E6) — separate change.
- Pagination / `hasMore` (H2).

## Decisions

### D1 — Preview is an MCP-layer filter, not a search-layer rewrite

`codeSearch` / `codeSymbol` keep returning today's `SearchResult` /
`RankedSearchResult` (including current `snippet`). The server/tool layer maps
each result through `applyPreview(result, preview)` before building
`structuredContent`. Ranking, dedup, and benches stay untouched.

*Alternatives:* push preview into `src/search/exact.ts` `buildSnippet` /
FTS SQL (rejected: couples every CLI/bench caller to an MCP concern; benches
would need a new default or diverge from agents). New search option bag
(rejected: YAGNI until a second consumer needs it).

### D2 — Anchor-line construction

Reuse stored text already on the result: prefer the first non-empty line of the
existing snippet; if that line exceeds 160 chars, truncate at 160 and append
`…`. For `preview: "none"` emit only that line. For `"short"`, take up to 10
lines from the existing snippet, replacing the middle with a single `…` line when
more than 10 lines exist. For `"full"`, pass the snippet through unchanged.

*Alternatives:* re-query `body_text` / `signature_text` at the MCP layer
(rejected: extra DB round-trip; snippet already holds the preview source).
zg-style 10-line window around a *query-match* offset (rejected: we do not store
match offsets on the symbol row; anchor = first snippet line is honest and
cheap).

### D3 — Structured field set under `preview: "none"`

Identity and ranking fields stay (agents and protocol tests need them):
`symbolKey`, `qualifiedName`, `localName`, `kind`, `scopeTier`, `filePath`,
`startLine`, `endLine`, `matchedBy`, `rankScore`, `freshness`, `confidence`.
`exportNames` stays as today (already a short array; dropping it breaks
export-name reasoning without a measured win). The size win is the snippet,
which dominates payload bytes at default `limit: 10`.

### D4 — Text channel contract unchanged in shape

Keep the existing summary builder (`server.ts`). Do not add per-result text
blobs. Metadata "elision" is satisfied by not introducing name/kind lines that
duplicate `structuredContent` — the current summary already only lists top
qualified names for skim. If a host is later shown to need richer text, that is
a follow-up informed by A/B, not this slice.

### D5 — `response_bytes` measured at the envelope

Extend `buildStructuredToolResult` to also return `responseBytes`
(`Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify(structuredContent))`).
Wire an optional `logResponseBytes?: (tool, bytes) => void` on
`CodeindexToolDeps`; `withQueryLogging` supplies it. Existing result logging in
`query-logging.ts` stays; this is an additive field, not a move of the wrapper.

Schema: bump `QUERY_LOG_SCHEMA_VERSION` to 2 **without** dropping history —
`ALTER TABLE query_log ADD COLUMN response_bytes INTEGER` when the column is
missing (unlike index.db's wipe-and-rebuild). Rationale: dogfood history is the
S3 study corpus; wiping it on every log-shape change would destroy the evidence
path this phase depends on. Failure to ALTER still never fails a query
(best-effort contract).

*Alternatives:* move all logging into server handlers (rejected: larger blast
radius; latency/hit logging already works). Measure only `structuredContent`
(rejected: understates hosts that also inject text).

### D6 — Acceptance: A/B delta, not IR gates

`bun run check` and IR/impact/index baselines must stay green with no
regeneration (ranking and hit-set unchanged). The advisory acceptance run is
`bun run bench:agent` / `bench:agent:baseline` against the stamp at this
change's parent: median input tokens and cost on `who-uses-*` and `explain-*`
tasks should drop; locate tasks should not regress. A failed size win is a
design revisit, not a baseline restamp.

**Search semantics impact:** none on scope tiers, `rankScore`, `matchedBy`, or
exact-before-FTS. MCP text shape unchanged; `structuredContent` snippet density
becomes caller-controlled; new optional `preview` on two input schemas.

## Test-first interactions

1. `tests/mcp/preview-modes.test.ts` (new) — failing tests for default `none`,
   160-char cap, `short` ≤10 lines, `full` passthrough, ranking invariance,
   exact-before-FTS under `none`.
2. `tests/mcp/response-bytes.test.ts` (new) — envelope size recorded; legacy
   `queries.db` rows keep NULL after upgrade; logging failure does not fail
   query.
3. Existing `tests/mcp/` protocol and search tests must stay green (text summary
   shape, `matchedBy`, mode routing).
4. Storage tests for `ensureQueryLogSchema` v2 ALTER path.

## Risks / Trade-offs

- [Hosts that only inject text never see the snippet win] → A/B measures the
  real host; if premium persists, a follow-up may put the anchor line into the
  summary — design D4 already allows that without breaking the channel contract.
- [160-char anchor hides useful signature context] → `preview: "short"|"full"`
  is one param away; default optimizes cost, not max fidelity.
- [ALTER TABLE on an open WAL `queries.db`] → additive column, nullable; busy
  timeout already set; best-effort logging.
- [JSON.stringify cost to measure bytes] → payload already built; stringify is
  O(response) and dwarfed by search latency (p50 ~4ms).
- [Protocol tests depend on full snippets] → update those fixtures to pin
  `preview: "full"` or assert the new default explicitly; do not weaken
  ranking assertions.

## Migration Plan

Ship behind default `preview: "none"` (intentional behavior change for MCP
callers). No `index.db` change. `queries.db` migrates in place on first open.
Rollback = revert the commit; log column can remain (nullable, unused).

## Open Questions

- Whether opencode and MiMo Desktop inject `structuredContent` into model
  context: verify during implementation by comparing `response_bytes` to A/B
  input-token deltas. Does not change specs or task order; may motivate a
  later text-channel follow-up only.
- Exact FTS `short` window source when SQLite snippet is already short: pass
  through (likely); confirmed by tests on FTS-only hits.
