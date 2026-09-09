## 1. Legacy database migration (test-first)

- [x] 1.1 Add failing test in `tests/storage/query-log.test.ts`: build a legacy `queries.db` with the old DDL (no `error` column), run `openQueryLog`, insert an entry with `error` set → currently throws `no such column: error`; test fails. Verify: `bun test tests/storage/query-log.test.ts`
- [x] 1.2 Implement migration in `ensureQueryLogSchema`: own `PRAGMA user_version` on `queries.db`, `QUERY_LOG_SCHEMA_VERSION = 1`, version below → drop `query_log` and rebuild with the full current schema (mirror `ensureSchema`, src/storage/schema.ts:142-153), stamp version. Re-run 1.1 test → passes; existing `tests/storage/db.test.ts` and `tests/storage/queries.test.ts` stay green. Verify: `bun test tests/storage/query-log.test.ts tests/storage/db.test.ts tests/storage/queries.test.ts`

## 2. Failure visibility (test-first)

- [ ] 2.1 Add failing test in `tests/mcp/query-logging.test.ts`: point `queriesPath` at a non-DB file, run a wrapped `code_search` through `withQueryLogging` → assert the search result is still returned normally AND a diagnostic naming the failure was emitted (spy on `console.error`); currently stderr is silent, test fails. Verify: `bun test tests/mcp/query-logging.test.ts`
- [ ] 2.2 Implement the stderr report inside `record`'s catch (single-line `console.error` with tool and error; contract unchanged — never fail the query). Re-run 2.1 test → passes; `tests/mcp/server.test.ts` and `tests/mcp/wiring.test.ts` stay green. Verify: `bun test tests/mcp/query-logging.test.ts tests/mcp/server.test.ts tests/mcp/wiring.test.ts`

## 3. Full verification

- [ ] 3.1 Static gates. Verify: `bun run typecheck && bun run lint && bun run format:check`
- [ ] 3.2 Full suite plus bench gates (logging is off the search/ranking path, so baselines pass like-for-like). Verify: `bun run check`
- [ ] 3.3 Dogfood confirmation: one real MCP session (`code_search` / `code_symbol` / `code_impact` calls), then `bun run start log-stats` shows `total` growing past 3. Verify: `bun run start log-stats`
