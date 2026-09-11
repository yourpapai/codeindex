# Design: serve-mcp-transport

## Context

See `proposal.md` for motivation. On disk today:

- `createMcpSession(config)` (`src/cli.ts`) already builds scheduler + watcher + query-logged deps and returns `{ server, watcher }` — transport-agnostic.
- `createCodeindexServer(deps)` (`src/mcp/server.ts`) registers the four tools; no transport imports.
- Stdio path is `server.connect(new StdioServerTransport())` + `watcher.start()`.
- `@modelcontextprotocol/sdk` ^1.29 ships `WebStandardStreamableHTTPServerTransport` (Bun `Request`/`Response`) and `StreamableHTTPClientTransport` for tests.
- Tests already exercise `Client.callTool` via `InMemoryTransport` (`tests/mcp/harness.ts`) but never stdio bytes or HTTP (gap J2).
- Existing modules cover need: `createMcpSession` is the session assembler; do not fork deps construction into serve-only code.

## Goals / Non-Goals

**Goals:**

- One process, N HTTP clients, one writer/watcher/freshness source.
- Optional bearer auth without Express middleware.
- Real Client round-trips on both transports.
- Stdio behavior unchanged.

**Non-Goals:**

- `refresh` modes, hourly reconcile, Worker offload (change 2 / later).
- Host config migration, port-file/UDS discovery, multi-repo serve.
- TLS, non-loopback bind, daemon auto-start.
- Tool schema or ranking changes.

## Decisions

### D1: Bun.serve + WebStandardStreamableHTTPServerTransport

Use Bun’s native HTTP server with the web-standard transport (`Request`/`Response`), not the Node `StreamableHTTPServerTransport` wrapper (pulls `@hono/node-server` compatibility). Bun is the only runtime; keep the stack native.

*Alternative:* Node wrapper + hono — rejected (extra dependency, wrong runtime).

### D2: Reuse `createMcpSession` as the sole assembly path

`src/mcp/serve.ts` (new) calls the same `createMcpSession` as stdio, then connects one WebStandard transport per HTTP session onto that single `McpServer` (or a thin factory that builds a server per session from the **same** deps object). Prefer one `McpServer` + per-request transport connect if the SDK allows multiple transports; otherwise one server per session sharing identical deps — scheduler/watcher stay process-global either way.

*Alternative:* serve-only deps builder — rejected (two codepaths, drift risk).

### D3: Stateful sessions, path `/mcp`

`sessionIdGenerator: () => randomUUID()`. Unknown session ids rejected by the transport. Only `/mcp` is routed; everything else 404.

*Alternative:* stateless (`sessionIdGenerator: undefined`) — simpler but drops session DELETE/reconnect semantics the roadmap asked for; tools are stateless but hosts expect ids.

### D4: Hand-rolled bearer check on Bun.serve `fetch`

SDK `requireBearerAuth` is Express `RequestHandler` — do not use it. Before `transport.handleRequest`:

```
if token configured:
  Authorization header present && timingSafeEqual(headerToken, token)
    → pass
  else → 401 + WWW-Authenticate: Bearer
```

Token sources: `CODEINDEX_TOKEN` env or `CODEINDEX_TOKEN_FILE` path (read at start; ≥32 chars). Not raw token in `.codeindex.json`. Stdio ignores these.

*Alternative:* SDK Express middleware on a Node server — rejected (D1).

### D5: Default port 3456, fail on EADDRINUSE

Explicit `--port` for a second worktree. Clear error naming `repoRoot`. No silent rebind. UDS/port-file deferred (proposal Non-goals).

### D6: JSON vs SSE response mode

Default SDK SSE streaming. Prefer `enableJsonResponse: true` if agent hosts (opencode, Claude, MiMo) complete tool calls more reliably with plain JSON bodies — verify in the HTTP round-trip test against the real client. If either mode flake, pin the one that passes and document it.

### D7: CLI wiring

```
codeindex serve [--port N] [--host ignored / reserved]
```

Zod-validate `--port` (int, 1–65535). Reuse `loadConfigForPath`. SIGINT → `watcher.stop()`, close Bun.serve, exit 0.

## Search / MCP response impact

None. Same handlers, same `buildStructuredToolResult`, same exact-first ranking, same preview defaults. Freshness marks and `indexFreshness` behave as on stdio (shared watcher). Bench baselines must stay byte-flat; no re-stamp.

## Test-first interactions

Failing tests first:

1. `tests/mcp/stdio-roundtrip.test.ts` — spawn `bun src/cli.ts mcp` in a temp repo; `Client` + `StdioClientTransport`; `listTools` + `code_search`.
2. `tests/mcp/http-roundtrip.test.ts` — start serve on an ephemeral port; `Client` + `StreamableHTTPClientTransport`; same assertions + session id present.
3. `tests/mcp/auth.test.ts` — no token / wrong token 401 / right token success.

Unit-level (no spawn): port parse, EADDRINUSE message, bearer compare helper.

## Risks / Trade-offs

- [Bun.serve + SDK transport session map grows without bound] → onsessionclosed cleanup; document; optional idle timeout later.
- [Two `McpServer` instances if SDK forbids multi-transport] → still one deps/scheduler/watcher; only registration is duplicated.
- [SSE vs JSON host quirks] → D6 verify with real client in tests; pin mode.
- [Port collision in multi-worktree] → explicit `--port` + loud EADDRINUSE (accepted).
- [Auth token in process env visible via `ps`] → token-file preferred; env is convenience.
- [StdioClientTransport spawn flakes in CI] → timeout + retry once (pattern from agent bench serve spawner).

## Migration Plan

Additive CLI command. No config schema change required. Host configs stay on `mcp` stdio. Rollback = remove `serve` command + `src/mcp/serve.ts`; stdio untouched.

## Open Questions

- Whether any production host prefers SSE streams over JSON responses — resolved during HTTP round-trip implementation, not before.
- Exact multi-transport vs multi-server wiring under SDK 1.29 — resolved in D2 during implementation; does not change specs.
