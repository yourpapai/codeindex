# Design: Freshness and background reindex

## Context

Dogfooding is blocked by staleness, not by missing capability — investigation
during this change's exploration overturned three assumptions from the
phase-3 roadmap:

1. `files.indexed_at` **already exists** (`src/storage/schema.ts:12`, maintained
   by every upsert in `src/storage/queries.ts:58,66,82,84`) — the roadmap's
   "schema v5 adds the column" prerequisite is already satisfied. What remains
   is a format problem: `datetime('now')` yields second-resolution UTC text
   with no machine-safe parse, unusable for the `indexed_at >= mtimeMs`
   comparison the freshness rule needs.
2. `code_index` **already exists as an MCP tool** (`src/mcp/server.ts:86`,
   wired to `indexCodebase` in `src/cli.ts:88`) — agents can already trigger
   reindex. What was missing is the signal (freshness marks) and the
   automation (watcher), not the trigger.
3. Schema migration is **wipe-and-rebuild** (`ensureSchema`,
   `src/storage/schema.ts:139`: `PRAGMA user_version` bump drops all tables in
   `DROP_ORDER` and recreates) — there is no ALTER TABLE path to retrofit.

Other load-bearing facts: MCP query handlers use per-call connections
(`withDatabase`, `src/cli.ts:28`), so WAL readers never share a connection
with the writer; search results all carry `filePath` (all three output
schemas in `src/mcp/tools.ts`), giving the freshness layer its lookup key;
`deps` composition already has a wrapper precedent (`withQueryLogging`,
`src/cli.ts:93`).

## Goals / Non-Goals

Goals: honest serving during catch-up windows; automatic freshness
maintenance inside the MCP session; worktree cold-start self-healing; the
identifier_terms drift close-out via the version bump.

Non-goals (see proposal): route param + RRF fusion; git-drift signal; HTTP
transport/auth/daemon/hourly reconcile/`refresh` knob; compact output;
semantic study; task rig; papai rollout; dogfood journal. Design-level
addition: no Bun Worker offload of the write phase (see Decision 7) and no
reindex-in-bench integration (bench runners create fresh DBs; the watcher
never runs there).

## Decisions

### D1. Schema v5 = timestamp format upgrade + rebuild trigger

Change `files.indexed_at` from TEXT to `INTEGER` epoch-milliseconds, written
by the indexer via `Date.now()` at upsert (`src/storage/queries.ts` — both
upsert statements, plus `markParseFailure`). Keep `index_meta.indexed_at` as
ISO text for human display. Bump `SCHEMA_VERSION` 4→5 even though no table is
added: the established wipe-and-rebuild mechanism then forces a full reindex
on every existing DB's next open, which is exactly the identifier_terms
close-out Slice 9 deferred. Rationale over alternatives: (a) parsing
`datetime('now')` text as UTC in JS is locale/spec-dependent and the known
hazard; (b) an ALTER TABLE + backfill path does not exist in this codebase
and would add a migration system for one change. A comment on
`SCHEMA_VERSION` records that v5 is a deliberate rebuild trigger, not a
shape-only oversight.

### D2. Freshness as a deps wrapper, not search-layer logic

New `src/mcp/freshness.ts` exporting `withFreshness(deps, config, watcher)`:
wraps `codeSearch`/`codeSymbol`/`codeImpact` — post-processes each result set:
batch `SELECT file_path, indexed_at, file_hash FROM files WHERE file_path IN
(…)` for the hit set, then one `stat()` per hit (≤ `limit`). Rules per
spec: `indexed_at >= mtimeMs` → fresh; mtime newer → read file + `sha256`
(reuse `src/indexer/resolve-files.ts:9`) → equal keeps fresh, differs marks
`possibly_stale`; stat/read failure → `possibly_stale`. Response-level
`indexFreshness` comes from watcher state (D3). Rationale: keeps
`src/search/*` untouched — ranking, `rankScore`, scope tiers, match types and
exact-first semantics are bit-identical, so IR baselines stay flat. The
alternative (fresness inside `searchSymbols`) would couple the search layer
to the filesystem and move a bench-gated surface for no behavioral gain.
Both text and `structuredContent` carry the fields automatically because
`buildStructuredToolResult` derives both from the same result objects.

### D3. Watcher module owns the probe, the watch, and the state

New `src/mcp/watcher.ts` exporting a watcher created with `(config, runIndex)`:
- **Boot probe:** compare `discoverSourceFiles` output against stored
  `file_path`s (structure diff) and `stat()` stored files against
  `indexed_at` (mtime scan) — no file reads, no hashing. Dirty or wiped/empty
  DB → background incremental reindex (incremental on an empty DB processes
  everything, so cold start and post-migration rebuild share one path).
- **Watch:** `fs.watch(config.repoRoot, { recursive: true })`; filter events
  through the same roots/exclude/languages predicates `discoverSourceFiles`
  applies; 300 ms debounce coalescing into one pending set.
- **State:** `{ status: 'idle' | 'catching_up' | 'error', pendingEvents,
  lastError, lastCompletedAt }` — the single source the response-level field
  and `code_index` reporting read. Missed watcher events (silent-watch risk)
  are reconciled by the next session's boot probe; no reconcile timer in this
  change.

### D4. Shared ReindexScheduler = the single writer

New `src/mcp/reindex-scheduler.ts`: serializes all indexing runs for the
process — agent-triggered `code_index` (via `deps.codeIndex`) and
watcher-triggered runs submit into one queue. Coalescing: while a run is
active, further triggers set a `pending` flag; when the active run completes,
at most one follow-up runs with the freshest incremental set (the incremental
path re-discovers changes itself, so a stale queued set is harmless — the
follow-up simply re-derives what changed). This is the S5 "single DB writer"
discipline pulled forward; `code_index`'s current direct call
(`src/cli.ts:88`) routes through the scheduler instead.

### D5. `code_index` reports watcher state

`CodeIndexOutputSchema` gains a `watcher` object (`status`, `pendingEvents`,
`lastError`, `lastCompletedAt`); text summary appends the status when not
`idle`. A call while a run is in flight joins the queue (D4) and reports
`catching_up`.

### D6. Freshness is never a ranking input

Presentation metadata only — no demotion of `possibly_stale` hits, no filter.
This is what keeps `bun run bench:check` (IR search + impact baselines)
byte-flat on both corpora; demotion is a possible later slice with its own
bench story. The index-count baseline (`bench/index-baseline.json`) may be
regenerated: schema v5 is an intent change (new write path, epoch-ms
timestamps), which is the legitimate regeneration trigger — counts must match
the pre-change corpus exactly, only timings/fields may move.

### D7. Accept the event-loop stall; defer the Worker

`indexCodebase`'s write phase is one synchronous SQLite transaction
(`src/indexer/index-codebase.ts`, Slice 9's atomic-write design); bun:sqlite
is synchronous, so a reindex run blocks the JS event loop for the transaction
duration. For this repository that is milliseconds for incremental runs and
~0.3 s for a cold-start full index — invisible next to query latencies. The
papi-scale case (~15 s full) is explicitly out of scope here; offloading the
write phase to a Bun Worker with a dedicated writer connection is an S5
concern (where long-lived HTTP serving makes it load-bearing). Mitigations
in scope: incremental-only catch-up, coalescing, and the documented
limitation. Rejected alternative: shipping the Worker now — real complexity
(worker lifecycle, error propagation, test surface) for a repo where the
stall is unobservable.

### D8. No config surface

Watcher debounce and probe cadence are internal constants. The S5 `refresh`
knob (`background | wait | off`) would be interface churn before S2 freezes
the response contract; the always-on watcher simply becomes S5's
`background` default, and `wait`/`off` land additively later.

## Risks / Trade-offs

- [Watcher misses events (fs.watch is lossy, especially under rename storms)]
  → per-hit freshness marks keep queries honest; boot probe reconciles every
  session start; S5 adds the hourly reconcile for long-lived servers.
- [Event-loop stall during a large catch-up] → bounded by repo size; this
  repo is ~0.3 s; papai-scale serving is S5's Worker problem (D7).
- [Hash-compare reads hit files at query time (mtime-mismatch path only)]
  → ≤ `limit` files per query, only on recently-touched files; full re-read
  cost is bounded by `maxFileSizeBytes`.
- [Two writers if the user runs CLI reindex while the server watcher runs]
  → WAL + `busy_timeout` (Phase 1 ride-along) makes contention a wait, not a
  failure; the scheduler serializes within the process.
- [v5 wipe destroys every consumer's index on first open] → that is the
  identifier_terms close-out working as intended; rebuild cost is the cold
  start (sub-second here, ~15 s papai) and the watcher/probe automates it.

## Migration Plan

No deployment steps beyond landing: any open of a v4 DB wipes and rebuilds;
the MCP server's boot probe then runs the full catch-up in the background
with `possibly_stale` marks during the window. Rollback = revert; a v4 client
opening the v5 DB wipes it again (safe, self-healing).

## Test-First Interactions

The failing-test-first order gates these new files:

- `tests/storage/schema-v5.test.ts` — wipe-and-rebuild on v4 DB; epoch-ms
  write path; WAL mode preserved. (Gates `src/storage/schema.ts`,
  `src/storage/queries.ts`, `src/indexer/*` timestamp plumbing.)
- `tests/mcp/freshness.test.ts` — per-hit fresh / hash-equal / changed /
  missing; response-level field wiring; no-ranking-change assertion.
  (Gates `src/mcp/freshness.ts`.)
- `tests/mcp/watcher.test.ts` — temp-dir boot probe (dirty/clean/wiped),
  debounce coalescing, rename/move/delete sequences, scheduler
  serialization + coalescing, error state + retry. (Gates
  `src/mcp/watcher.ts`, `src/mcp/reindex-scheduler.ts`.)
- `tests/mcp/` protocol round-trips — text + `structuredContent` shapes for
  the new fields on all four tools. (Gates `src/mcp/tools.ts` schemas.)

Existing suites must stay green unchanged except where the schema version
appears (storage tests assert v4 today).

## Open Questions

None — the three scoping questions (serve-with-marks default, incremental
path reuse, v5 fold-in) were resolved with the user during exploration.
