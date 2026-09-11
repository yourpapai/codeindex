# Proposal: Impact unique-export acceptance + honest ambiguity candidates

## Why

After `semantic-gate-study`, bare local-name `code_impact` is strictly honest
and strictly low-recall: a name is accepted only when it is unique among **all**
indexed symbols. On react-ui (11,521 symbols), **124 names are unique among
exports** but collide with members/locals (`alpha`, `blink`, `Button`) — agents
asking for the public export get `unresolved`. True multi-export names
(`default`) get no candidates, forcing a second `code_symbol` round-trip.
Old rank-order guessing is correctly gone; we still need fairer *honest*
resolution.

## What Changes

- **Lever A — unique-export bare names:** accept a bare `local_name` when
  **exactly one** `scope_tier='exported'` symbol has that name, even if
  members/locals also share it. Still never pick among two+ exports.
- **Lever B — honest candidates:** unresolved multi-match identities return a
  capped candidate list in `structuredContent` + guidance naming them; no
  auto-pick.
- **Lever C — `module#name` partials:** accept a bare `Module#Name` that
  exactly matches one symbol’s module-local qualified suffix when no full
  `qualified_name` hit exists (e.g. `Toast#Action`).
- **Measure-and-decide gate:** a dedicated final task runs unit + impact
  benches + extracted third-party fixture and records keep-or-revert; each
  lever lands as its own commit so a regression can be reverted without
  undoing the others.

## Capabilities

### New Capabilities

*(none)*

### Modified Capabilities

- `impact-lookup`: bare-name uniqueness becomes unique-**export** uniqueness;
  unresolved outcomes carry capped candidates; `Module#Name` partials are an
  accepted identity form. Without this, 124 false-ambiguity names on a real
  monorepo stay unusable and true-ambiguous agents pay an extra round-trip.
  Existing module: `src/search/index.ts` (`resolveExactCandidate`) +
  `src/mcp/server.ts` / `tools.ts` for payload/guidance.

## Impact

- Surfaces: search (`src/search/index.ts`), MCP (`code_impact` identity
  schema, text + structuredContent, tool description), tests
  (`tests/impact.test.ts`, `tests/mcp/protocol.test.ts`), optional
  `bench/fixtures/impact-ambiguity` + env-gated external-repo check.
- No indexer, storage schema, or ranking rewrite. Canonical
  `symbol_key` / `qualified_name` paths stay byte-identical.
- Impact baselines should not need re-stamping (canonical keys unchanged);
  the measure task verifies and records the decision.
- Easy revert: levers are isolated commits; candidates are additive
  structuredContent; throw path is a clean `git revert` of identity commits.

## Non-goals

- Rank-order or in-degree tie-breaks among multiple exports.
- Changing default `roots`/`exclude` config or test-file discovery.
- Embeddings / semantic route (closed by `semantic-gate-study`).
- Auto-selecting a candidate when the agent did not confirm.
- Migrating or wiping `query_log` history.
- Making CI index a live third-party checkout path (fixture only; external
  path is optional and env-gated).
