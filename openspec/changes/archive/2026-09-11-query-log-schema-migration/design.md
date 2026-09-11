# Design: Query log schema migration

## Context

`insertQueryLogEntry` (src/storage/query-log.ts:55) inserts an `error`
column that existing `queries.db` files lack: `CREATE TABLE IF NOT EXISTS`
(query-log.ts:32) never migrates tables created before the column was
added, and the best-effort `catch {}` in `record`
(src/mcp/query-logging.ts:35) swallows the `no such column` throw. Live
evidence in proposal.md — Why. The index database already has an
established migration convention: `PRAGMA user_version` bump +
drop-and-rebuild in `ensureSchema` (src/storage/schema.ts:142-153). The
query log has no version of its own.

## Goals / Non-Goals

**Goals:**

- Recording works against any `queries.db` opened by this version, with
  schema drift impossible to trigger silently again.
- Recording failures are visible without violating the never-fail-a-query
  contract.

**Non-Goals:**

- Additive/lossless migrations for the log (history is disposable by
  contract).
- Persisting the query-log connection for the server session lifetime.
- Any MCP tool response shape, CLI command, or bench gate change.

## Decisions

### 1. Own `user_version` on `queries.db` + wipe-and-rebuild

`ensureQueryLogSchema` (src/storage/query-log.ts:45) gains a
`PRAGMA user_version` check mirroring `ensureSchema`
(src/storage/schema.ts:142-153): version below current → drop and rebuild
`query_log`, then stamp the new version. The current file version is 0
(no stamp), so the first open wipes and rebuilds with the full current
schema including `error`.

Why over `ALTER TABLE ADD COLUMN` inventory: one migration pattern across
both databases instead of introducing a second style for a sibling file;
the log's contract is explicitly best-effort observability, so its
contents are disposable. The preserved history is currently the three
test queries — no value lost.

Trade-off recorded: future query-log schema bumps discard accumulated
dogfood history. Acceptable while the log is a dev-time honesty metric;
if it ever becomes product-critical, revisit with additive migrations.

### 2. Migration runs from `openQueryLog` on every open

`openQueryLog` already calls `ensureQueryLogSchema` per record
(open/close per call — query-log.ts:29-33,49-53). Adding the version
check there keeps the existing pattern; a `PRAGMA user_version` read is
trivial next to the connection cost already paid per record. No
connection-pooling change.

### 3. Failures surface on stderr, contract unchanged

The `catch {}` in `record` keeps swallowing — a real query must never
fail because observability is broken — but it now emits a single-line
`console.error` naming the tool and the underlying error. stderr is the
MCP stdio log channel, so hosts (opencode, Claude Code) surface it in
server logs without any protocol change. Structured MCP logging
notifications were considered and rejected as session plumbing overhead
for a dev tool.

## Impact on search semantics and responses

None. The logging wrapper sits below the response builders
(withQueryLogging wraps deps before `createCodeindexServer`, cli.ts:69);
scope tiers, rankScore, match types, text payloads, and structuredContent
shapes are untouched. No bench baselines are affected — the log is off
the search/ranking path and `check:bench` gates compare like-for-like.

## Risks / Trade-offs

- [Wipe drops dogfood history on future schema bumps] → documented as the
  log's disposable-by-contract nature; single-line stderr reports make
  any future drift loud instead of silent.
- [stderr noise if recording is persistently broken] → one line per
  failed record; failures indicate schema/env problems, not volume.
- [Version check on every record open] → negligible PRAGMA read next to
  the connection cost already paid per record.

## Test-first interactions

The failing-test-first order gates two existing test files:

- `tests/storage/query-log.test.ts` — new failing test: create a legacy
  DB with the old DDL (no `error` column), `openQueryLog`, insert an
  entry with `error` → fails before migration exists, passes after.
- `tests/mcp/query-logging.test.ts` — new failing test: force record
  failure (point `queriesPath` at a non-DB file), call the wrapped
  search → assert the query result is still returned AND a stderr
  diagnostic is emitted (spy on console.error). Fails before the stderr
  report exists, passes after.
