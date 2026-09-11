# Tasks: refresh-modes-and-reconcile

## 1. Refresh schema + default no-op path

- [x] 1.1 RED — write `tests/mcp/refresh-modes.test.ts` (start with default): omitting `refresh` does not submit a reindex (spy/fake scheduler); `refresh: "off"` does not submit; both still return honest freshness marks on a dirty index. Watch it fail. Verify: `bun test tests/mcp/refresh-modes.test.ts`
- [x] 1.2 GREEN — add `refresh: z.enum(['background','wait','off']).default('background')` to `CodeSearchInputSchema`, `CodeSymbolInputSchema`, `CodeImpactInputSchema` in `src/mcp/tools.ts`; plumb through `server.ts` handlers into deps (or a wrapper); default/off take the no-probe path. Update tool descriptions. Verify: `bun test tests/mcp/refresh-modes.test.ts && bun run typecheck`

## 2. Wait loop (incremental-only)

- [x] 2.1 RED — extend `tests/mcp/refresh-modes.test.ts`: dirty + `wait` → exactly one `incremental` submit then query sees new symbol; clean + `wait` → zero submits; multiple `wait`s never submit `full`. Watch it fail. Verify: `bun test tests/mcp/refresh-modes.test.ts`
- [x] 2.2 GREEN — implement wait orchestration helper wrapping query deps (design D2): settle/join if catching up → `probeDirty` → `scheduler.submit({ mode: 'incremental' })` → await → original query. Verify: `bun test tests/mcp/refresh-modes.test.ts && bun test tests/mcp/reindex-scheduler.test.ts && bun run typecheck`

## 3. Timeout honesty

- [x] 3.1 RED — test: slow incremental (fake delay > timeout) + `wait` → normal tool result with `indexFreshness: possibly_stale`, not a throw and not an unbounded hang. Watch it fail. Verify: `bun test tests/mcp/refresh-modes.test.ts`
- [x] 3.2 GREEN — add `WAIT_REFRESH_TIMEOUT_MS` race; on expiry run the original query. Verify: `bun test tests/mcp/refresh-modes.test.ts && bun run typecheck`

## 4. Concurrent wait join

- [x] 4.1 RED — extend scheduler tests: two `wait` triggers during an active run coalesce into at most one follow-up and both complete; if a lighter `whenSettled` is required (wait without extra enqueue when already busy), test that API first. Verify: `bun test tests/mcp/reindex-scheduler.test.ts tests/mcp/refresh-modes.test.ts`
- [x] 4.2 GREEN — rely on existing `submit` coalescing or add minimal join API; wire wait helper to it. Verify: `bun test tests/mcp/reindex-scheduler.test.ts tests/mcp/refresh-modes.test.ts && bun run typecheck`

## 5. Hourly reconcile

- [x] 5.1 RED — write `tests/mcp/reconcile-timer.test.ts` (injectable short interval): dirty probe at tick → incremental submit; clean → no submit; `stop()` clears timer. Watch it fail. Verify: `bun test tests/mcp/reconcile-timer.test.ts`
- [x] 5.2 GREEN — extend `IndexWatcher` with reconcile timer (default 1h); start from `createMcpSession`; clear on `stop`. Verify: `bun test tests/mcp/reconcile-timer.test.ts tests/mcp/watcher.test.ts && bun run typecheck`

## 6. Integration + gates

- [x] 6.1 Protocol/wiring stay green; one end-to-end: edit file, `code_search` with `refresh: "wait"` finds the new symbol without explicit `code_index`. Verify: `bun test tests/mcp/ && bun run typecheck`
- [x] 6.2 Full `bun run check` (including `check:bench`). Default `background` path must leave search/impact baselines byte-flat — no re-stamp. Verify: `bun run check`
