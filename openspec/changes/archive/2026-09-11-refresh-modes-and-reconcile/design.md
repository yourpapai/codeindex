# Design: refresh-modes-and-reconcile

## Context

See `proposal.md`. Building on:

- `src/mcp/watcher.ts` — probeDirty, debounce, boot catch-up, always-on fs.watch
- `src/mcp/reindex-scheduler.ts` — single writer, coalesce pending into one follow-up
- `src/mcp/freshness.ts` — per-hit + response-level marks; wraps the three query tools
- `src/mcp/server.ts` / `tools.ts` — zod input schemas, `buildStructuredToolResult`
- Change 1 `serve-mcp-transport` — long-lived multi-client process (reconcile default-on target)

S1 D8 deferred this `refresh` knob until the response contract froze; S2’s preview fields are now stable.

## Goals / Non-Goals

**Goals:**

- `refresh` on search/symbol/impact with default byte-compatible `background`
- Full C `wait` loop, incremental-only, timeout-honest
- Shared scheduler join for concurrent waiters
- Hourly probe-first reconcile on long-lived sessions

**Non-Goals:**

- Worker offload; `full` inside `wait`; refresh on `code_index`
- Host migration; changing ranking/preview/identity
- Config surface for timeout/cadence in v1 (internal constants)

## Decisions

### D1: `wait` is incremental-only

`resolveFilesToProcess` already indexes every file missing from the DB (`existing === null`), so a cold worktree is covered without `full`. Papai-scale full reindex must not ride inside `wait`.

*Alternative:* full when DB missing — rejected (redundant + stall).

### D2: `wait` orchestration lives above the tool handlers

A small helper (e.g. `withRefresh(deps, config, watcher, scheduler)`) wraps the three query deps: before `codeSearch`/`codeSymbol`/`codeImpact`, if `refresh === 'wait'`, run settle/probe/submit/await; then call through. Keeps `server.ts` handlers thin and works for stdio and HTTP.

*Alternative:* logic inside each registerTool — rejected (three copies).

Settle: reuse watcher debounce constants already applied on events; a short explicit delay only if `pendingEvents > 0` or status is `catching_up` (join first). If `isArmed() === false`, still probe (boot may be in flight — join).

### D3: Scheduler join API

Extend `ReindexScheduler` with something like `waitForIdle(): Promise<void>` or `submit` already returns the coalesced run’s promise — **prefer relying on existing `submit`**: two waiters both `submit({ mode: 'incremental' })`; the second coalesces and receives the same follow-up summary (already true in tests). Add only if “wait without forcing a run when a catch-up is already active” needs a lighter join: e.g. `whenSettled()` that does not enqueue when `busy && pending`.

Minimal new API if needed:

```ts
// If busy: await current + coalesced follow-up without adding a third run
whenSettled(): Promise<void>
```

Test-first against concurrent waiters.

### D4: Timeout

Internal constant `WAIT_REFRESH_TIMEOUT_MS` (suggest 10_000). Race `Promise.race([catchUp, timeout])`. On timeout: run the original query anyway; do not throw; marks stay honest. Config later if dogfood demands.

### D5: Hourly reconcile

`IndexWatcher` gains optional `startReconcile(intervalMs = 3_600_000)` / cleared in `stop()`. Timer body: `if (await probeDirty(config)) submit({ mode: 'incremental' })`. Enabled by `createMcpSession` for both stdio and serve (long-lived enough). Sleep-resume: next tick’s probe is enough (no clock-jump detector in v1).

*Alternative:* serve-only — rejected (stdio sessions also live for hours).

### D6: Schema surface

Add `refresh` to the three input zod schemas only. Do not echo `refresh` in output schemas unless a test needs it — avoids structuredContent churn. Tool descriptions mention the three modes briefly so agents discover `wait`.

### D7: Default `background` is a no-op path

When `refresh` is omitted or `background`, do not probe or submit from the query — identical control flow to today. That keeps bench defaults byte-flat and avoids probe cost on every search.

## Search / MCP response impact

- Ranking, `matchedBy`, preview, identity resolution unchanged.
- Response `structuredContent` field set unchanged (no required new fields).
- Freshness *meaning* unchanged; `wait` only changes *when* the index is updated before the query runs.
- Baselines: no re-stamp. `check:bench` must pass at default `background`.

## Test-first interactions

1. `tests/mcp/refresh-modes.test.ts` — default background no extra submit; wait dirty → incremental then hits; wait clean → no submit; wait never full; timeout → stale result not hang; off → no submit + stale marks.
2. `tests/mcp/reindex-scheduler.test.ts` — extend for concurrent wait join / whenSettled if added.
3. `tests/mcp/reconcile-timer.test.ts` — hourly probe dirty → submit; clean → no-op; stop clears timer (fake timers or short interval).
4. Existing freshness/wiring/protocol tests stay green.

## Risks / Trade-offs

- [Wait + blocking reindex stalls concurrent HTTP clients] → incremental-only + timeout; Worker is Non-goal.
- [Probe cost on wait] → structure+mtime only; acceptable at limit-sized result sets.
- [Timer noise in tests] → inject interval; default 1h; tests use ms-scale.
- [Agents overuse wait and burn wall time] → default stays background; description nudges.
- [Coalesce join subtlety] → D3 test-first; reuse submit coalescing before inventing API.

## Migration Plan

Additive tool parameter with default. No DB migration. Rollback = revert commits; no schema debt.

## Open Questions

- None that change specs/tasks. Cadence/timeout constants stay internal until dogfood.
