# Proposal: Query log schema migration

## Why

Dogfooding caught that MCP query logging has been silently broken since the
`error` column was added to `insertQueryLogEntry`: every existing
`queries.db` predates that column, `CREATE TABLE IF NOT EXISTS` never
migrates the on-disk table, and the best-effort `catch {}` in
`withQueryLogging` swallows the resulting `no such column: error` throw.
Evidence from a live session: three real MCP tool calls (`code_search`,
`code_symbol`, `code_impact`) returned normally while `log-stats` still
reported `total: 3` — the pre-dogfooding state. This is also true for
papai, which runs the same code. The freshness change's honesty story
depends on this log filling with real usage, so the broken path undermines
the point of dogfooding itself.

## What Changes

- Migrate `queries.db` on open so existing files gain the `error` column
  (and any future column additions apply) instead of silently failing
  forever. Migration choice (ALTER TABLE vs wipe-and-rebuild) decided in
  design.md.
- Stop silent swallowing: query-log failures are reported to stderr so MCP
  hosts surface them, while never failing a real query (best-effort
  contract preserved).
- No change to any MCP tool request/response shape; logging stays
  invisible to callers.

## Capabilities

### New Capabilities

- `query-log`: the honesty log — every MCP `code_search` / `code_symbol` /
  `code_impact` call records tool, query text, filters, result count, hit,
  latency, top qualified names, and error; the log opens migrate-safe so
  schema drift cannot silently disable recording; failures are observable
  without breaking queries. This capability extends the existing modules
  `src/storage/query-log.ts` and `src/mcp/query-logging.ts` — no new
  module is introduced.

### Modified Capabilities

- (none — no main specs exist yet; `openspec/specs/` is empty)

## Non-goals

- No query-log retention, rotation, or size management.
- No query log UI or CLI beyond the existing `log-stats` command.
- No changes to the `index.db` schema (its v5 wipe-and-rebuild already
  shipped).
- No cross-repo log aggregation or export.
- Recording failures still never block or fail a real query; stderr
  reporting is the only new visibility.

## Impact

- Surfaces touched: storage schema (`queries.db`), MCP query-logging path
  (`src/mcp/query-logging.ts`), and indirectly CLI `log-stats` output
  (interface unchanged; totals start growing).
- Runtime behavior changes (queries actually get recorded), so delta
  specs are required; no `skip_specs`.
- Affected code: `src/storage/query-log.ts` (migration on open),
  `src/mcp/query-logging.ts` (error reporting), mirrored tests under
  `tests/`.
- No bench gates affected (logging is off the search/ranking path).
