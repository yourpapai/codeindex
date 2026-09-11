# Tasks: serve-mcp-transport

## 1. Stdio protocol round-trip (J2 close)

- [x] 1.1 RED — write `tests/mcp/stdio-roundtrip.test.ts`: spawn `bun src/cli.ts mcp` on a temp repo with a seeded `.codeindex.json` + indexed symbol; connect `Client` + `StdioClientTransport`; assert `listTools` includes the four tools and `code_search` returns structured payload. Watch it fail (missing spawn harness / assertions on current in-memory-only coverage). Verify: `bun test tests/mcp/stdio-roundtrip.test.ts`
- [x] 1.2 GREEN — add a small spawn helper (reuse patterns from `tests/mcp/wiring.test.ts` temp-repo setup and agent-bench serve spawner timeout/retry); make the stdio round-trip pass. Verify: `bun test tests/mcp/stdio-roundtrip.test.ts && bun run typecheck`

## 2. Serve transport core

- [ ] 2.1 RED — write `tests/mcp/http-roundtrip.test.ts`: start serve on an ephemeral port against a temp repo; connect `Client` + `StreamableHTTPClientTransport`; assert `listTools`, `code_search` structured payload, and session id present after initialize. Watch it fail. Verify: `bun test tests/mcp/http-roundtrip.test.ts`
- [ ] 2.2 Implement `src/mcp/serve.ts`: `createServeSession` reusing `createMcpSession`; `Bun.serve` on `127.0.0.1`; `WebStandardStreamableHTTPServerTransport` with `sessionIdGenerator`; route only `/mcp` (else 404); SIGINT → `watcher.stop()` + close. Decide multi-transport vs per-session server sharing one deps object (design D2). Verify: `bun test tests/mcp/http-roundtrip.test.ts && bun run typecheck`
- [ ] 2.3 GREEN — HTTP round-trip passes; pin SSE vs JSON response mode (`enableJsonResponse`) to whichever the real client completes reliably (design D6). Verify: `bun test tests/mcp/http-roundtrip.test.ts`

## 3. CLI `serve` command

- [ ] 3.1 RED — write `tests/cli-serve.test.ts` (or extend existing cli tests): `--port` zod validation (reject 0 / 65536 / non-int); default port constant is 3456; EADDRINUSE path names `repoRoot` and suggests `--port`. Watch it fail. Verify: `bun test tests/cli-serve.test.ts`
- [ ] 3.2 GREEN — add `serve` to `src/cli.ts` main switch: `loadConfigForPath`, `--port` parse, call `runServeCommand`; bind `127.0.0.1` default 3456. Verify: `bun test tests/cli-serve.test.ts && bun run typecheck`

## 4. Optional bearer auth

- [ ] 4.1 RED — write `tests/mcp/auth.test.ts`: no token → tool call succeeds; configured token + missing/wrong bearer → `401` + `WWW-Authenticate: Bearer`; matching bearer → success; token shorter than 32 chars rejected at startup. Watch it fail. Verify: `bun test tests/mcp/auth.test.ts`
- [ ] 4.2 GREEN — implement hand-rolled bearer check on the serve `fetch` path (`timingSafeEqual`); load token from `CODEINDEX_TOKEN` or `CODEINDEX_TOKEN_FILE`; stdio path ignores auth env. Verify: `bun test tests/mcp/auth.test.ts && bun run typecheck`

## 5. Shared-session invariants + docs touch

- [ ] 5.1 Assert two concurrent HTTP clients share one reindex queue (extend http-roundtrip or scheduler-focused test: concurrent `code_index` serializes, max one active run). Verify: `bun test tests/mcp/ && bun run typecheck`
- [ ] 5.2 Document `codeindex serve` in `AGENTS.md` / `CLAUDE.md` MCP Usage (loopback URL shape, default port, optional token, stdio still default). Verify: `bun run lint && bun run format:check`

## 6. Full gates

- [ ] 6.1 Run `bun run check` (lint, typecheck, format:check, test, check:bench). Search/index behavior must stay flat — no baseline re-stamp. Verify: `bun run check`
- [ ] 6.2 Confirm stdio dogfood path unchanged: `bun run mcp` still starts; no config schema migration. Verify: `bun run typecheck && bun test tests/mcp/wiring.test.ts tests/mcp/stdio-roundtrip.test.ts`
