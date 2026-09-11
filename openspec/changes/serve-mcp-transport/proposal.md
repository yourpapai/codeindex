# Proposal: serve-mcp-transport

## Why

Every MCP host (opencode, Claude, MiMo) spawns its own stdio `codeindex mcp` process against the same worktree, so each has its own watcher and writer; SQLite WAL only softens the races. The phase-3 roadmap’s firm P3-S5 slice promised a loopback Streamable HTTP server so multiple clients share one process-level scheduler and freshness state. Watcher, scheduler, and freshness already landed in S1; transport, optional auth, and real Client round-trips remain.

## What Changes

- **`codeindex serve`:** loopback-only Streamable HTTP MCP endpoint on `127.0.0.1` (default port `3456`, `--port` override). Wraps the *same* `createCodeindexServer(deps)` / `createMcpSession` path as stdio — transports, not codepaths.
- **Stateful sessions** via `mcp-session-id` (`sessionIdGenerator`); path `/mcp`.
- **Optional bearer auth:** off by default; ≥32-char token via env or token file; `timingSafeEqual`; 401 + `WWW-Authenticate: Bearer`. Stdio stays unauthenticated.
- **Protocol-boundary tests:** real `Client` + `StdioClientTransport` and `Client` + Streamable HTTP round-trips (closes research gap J2); auth accept/reject paths.
- **EADDRINUSE** fails with a message naming `repoRoot` and suggesting `--port`.

## Capabilities

### New Capabilities

- `http-serve`: loopback Streamable HTTP MCP serving, optional bearer auth, and shared-session process model. Without it, multi-host same-worktree use multiplies writers and watchers; stdio remains the only transport and J2 stays open. Modules: new `src/mcp/serve.ts` + CLI `serve` command; reuses `src/cli.ts` `createMcpSession` and `src/mcp/server.ts` unchanged.

### Modified Capabilities

*(none — tool schemas, search semantics, and stdio behavior are unchanged)*

## Impact

- Surfaces: CLI (`serve` command), new `src/mcp/serve.ts`, tests (`tests/mcp/stdio-roundtrip.test.ts`, `http-roundtrip.test.ts`, `auth.test.ts`). No indexer, storage schema, MCP tool schema, or ranking changes.
- Stdio path (`bun run mcp`) is byte-identical; host configs stay on stdio until a later migration.
- No bench baseline movement expected (no search/index behavior change).
- Without this change: the approved P3-S5 remainder stays open, concurrent hosts still race writers, and protocol tests never cross stdio/HTTP bytes.

## Non-goals

- `refresh: background | wait | off` modes and hourly reconcile — second change (`refresh-modes-and-reconcile`).
- Writer offload to a Bun Worker.
- Host config migration (opencode.json / .mcp.json → remote URL).
- Port-file / UDS discovery for multi-worktree serve; multi-repo or multi-tenant serve.
- Daemon auto-start, TLS, binding beyond loopback, `0.0.0.0`.
- Changing tool descriptions, preview modes, or freshness mark semantics.
