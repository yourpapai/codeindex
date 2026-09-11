# Proposal: Freshness and background reindex

## Why

codeindex has never been dogfooded: the query log holds three test queries, the
MCP server is registered nowhere, and agents fall back to grep. The dogfooding
blocker is staleness — an index that silently lies the moment a file is edited.
Honest dogfooding needs an index that stays fresh in the background and marks
its own staleness while catching up. This change is the dogfood enabler for
this repo, and the first phase-3 slice (S1 freshness core + S5 watcher core
from the zg-inspired roadmap).

## What Changes

- **Storage schema v5:** `files.indexed_at` upgraded from second-resolution
  ISO text to epoch-milliseconds INTEGER (the column already exists — it is
  maintained on every upsert); the version bump follows the established
  wipe-and-rebuild convention, forcing one full reindex and clearing Slice 9's
  deferred legacy `identifier_terms` drift for free.
- **Per-hit freshness:** at query time, `stat()` each hit's file —
  `indexed_at >= mtimeMs` → `fresh`; mtime mismatch → compare stored
  `file_hash` → `fresh` if equal; file missing → `possibly_stale`. New zod
  fields on `code_search` / `code_symbol` / `code_impact` results, in both
  text and structuredContent.
- **Response-level state:** queries served while a reindex is in flight
  (startup catch-up or watcher debounce) carry an index-stale marker so
  nothing lies mid-reindex.
- **Watcher-lite in the stdio MCP server:** on startup, probe staleness;
  dirty or missing DB → reindex in the background, serve immediately with
  `possibly_stale` marks. During the session, `fs.watch` on the repo root
  (debounced) submits incremental reindexes through the shared serialized
  queue (agent-triggered `code_index` joins the same queue — it already
  exists as a tool); readers ride WAL.

## Capabilities

### New Capabilities

- `index-freshness`: query-time freshness truth per hit and per response —
  the honesty layer. Without it, background reindex windows serve silent
  lies and agents cannot distinguish fresh from stale; dogfooding stays
  dishonest even with a watcher.
- `background-reindex`: freshness maintenance — startup probe + in-session
  watcher submitting through the existing incremental reindex path. Without
  it, staleness accumulates silently between and during sessions and agents
  have no way to refresh (no reindex tool exists); trust erodes and
  dogfooding collapses.

The two are complements, not alternatives: the watcher makes the index
actually fresh; freshness marks make the in-between windows honest.

### Modified Capabilities

None — `openspec/specs/` is empty; this is the first runtime change on the
new workflow.

## Impact

- **Storage schema:** v5 column + migration; WAL behavior unchanged.
- **MCP tools:** freshness fields on the three query tools (text +
  structuredContent); `code_index` reports watcher state.
- **Indexer:** reused, not extended — the incremental path
  (`src/indexer/resolve-files.ts` `findIncrementalFileSet`, dependents of
  deleted files) already covers changed and deleted files; the watcher
  submits through it.
- **Bench harness:** index-baseline regeneration is legitimate (schema
  intent change); search and impact baselines expected flat.
- **Legacy roadmap:** the frozen phase-3 spec stays in place until the last
  adopted P3 slice archives (partial adoption here).

## Non-goals

- Route param (`mode: auto|exact|fts|fused`) + RRF fusion scaffold — later
  P3 slice.
- Response-level git HEAD/branch drift signal — out of scope: the
  worktree-centric workflow makes branch stamps noisy; per-hit mtime + hash
  already subsumes checkout/pull/rebase cases (checkout rewrites mtimes).
- HTTP transport, bearer auth, daemon, hourly reconcile timer, `refresh:
  wait|off` knob — P3-S5 proper; this change's always-on watcher becomes
  S5's `background` default.
- Compact output / preview modes (P3-S2), semantic study (P3-S3), task rig
  (P3-S4).
- papai dogfooding rollout; dogfood journal protocol.
