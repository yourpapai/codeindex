# Proposal: refresh-modes-and-reconcile

## Why

S1’s always-on watcher is effectively `refresh: "background"` with no knob: an agent that just edited a file must notice `possibly_stale`, call `code_index`, and re-query. Long-lived stdio/HTTP sessions also reconcile only at next boot, so `fs.watch` misses (rename storms, sleep) accumulate until the process restarts. This is the policy half of P3-S5, after `serve-mcp-transport`.

## What Changes

- **`refresh: "background" | "wait" | "off"`** on `code_search`, `code_symbol`, and `code_impact` (default `background` = today’s behavior).
- **`wait` (full zg loop, incremental-only):** settle → probe → submit incremental via the shared scheduler → await → re-search. Never issues `full`. Bounded by a timeout; on expiry return current results with honest stale marks.
- **Scheduler join API:** concurrent `wait` callers share the in-flight/coalesced run rather than racing private submissions.
- **Hourly reconcile timer** on long-lived sessions: probe first, no-op if clean, else incremental submit. Default on for `serve`; opt-in or same default for stdio (design decides).
- **Off:** serve as-is; no async catch-up trigger from this query (marks stay honest).

## Capabilities

### New Capabilities

- `refresh-modes`: caller-controlled freshness policy on the three query tools, wait-loop semantics, and periodic reconcile. Without it, agents pay extra round-trips after every edit and long-lived processes go silently stale between boot probes. Extends `src/mcp/tools.ts` (input schema), `src/mcp/freshness.ts` / server handlers (wait orchestration), `src/mcp/reindex-scheduler.ts` (join), `src/mcp/watcher.ts` (reconcile timer) — no new package.

### Modified Capabilities

*(none in `openspec/specs/` yet — `background-reindex` from S1 is still unarchived; reconcile is specified here as part of `refresh-modes` so the first archive can merge a single coherent freshness policy)*

## Impact

- Surfaces: MCP tool input schemas (text + structuredContent unchanged except optional ride-along if design adds refresh echo), scheduler, watcher, serve/stdio session wiring. No indexer, storage schema, or ranking changes.
- Exact-first semantics, preview modes, and freshness mark *meaning* unchanged; only when a query triggers catch-up changes.
- Bench: search/impact baselines must stay byte-flat at default `background` (no wait). Fuzzer stays green (still one writer).
- Without this change: `serve-mcp-transport` is multi-client but every client still does manual `code_index` + re-query after edits; reconcile stays boot-only.

## Non-goals

- Writer offload to a Bun Worker (stall accepted; revisit if multi-client `wait` + full `code_index` hurts).
- Daemon auto-start; `refresh` on `code_index` (already joins the queue).
- Host config migration; UDS/port discovery (change 1 / later).
- Changing default `preview`, ranking, or identity resolution.
- Multi-repo serve; TLS.
