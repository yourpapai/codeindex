# agent-ab-benchmark — Proposal

## Why

codeindex's value proposition — "help AI coding agents retrieve the right code context
accurately and cheaply" — is measured today only by deterministic proxies (IR precision@k,
impact accuracy, indexing speed). Nothing measures the question that actually matters: does
giving an agent the codeindex MCP server reduce its token usage, tool round-trips, and wall
time, and improve answer quality on real navigation tasks? The deterministic benches prove the
index is correct and fast; this benchmark proves it *helps*.

## What Changes

- New agent-level A/B benchmark under `bench/agents/`, driven by the opencode SDK:
  spawn a headless `opencode serve` per arm (with / without the codeindex MCP config), run
  benchmark tasks in fresh sessions, and collect telemetry from the SSE event stream.
- New benchmark task corpus derived from the existing golden corpora
  (`bench/corpus/seed.json`, `bench/corpus/papai.json`) plus curated `explain`/`review`/`map`
  prompts — task taxonomy: `locate`, `who-uses`, `explain`, `review`, `map`.
- Metric collection: tokens by kind (input/output/reasoning/cache read+write), tool calls by
  name, wall time per session; stored as per-run JSON records.
- Subjective comparison: blind pairwise LLM-as-judge pass over arm answers with a rubric and
  A/B order swap; objective anchoring for `locate`/`who-uses` (ground-truth symbol match +
  hallucination check on named symbols).
- New package.json scripts (`bench:agent`, optional `--baseline`) and advisory-only delta
  reporting (no CI regression gate; LLM variance makes strict gating flaky).

## Capabilities

### New Capabilities
- `agent-benchmark`: the A/B harness behavior — arm isolation, task execution, metric
  collection, blind judging, and report shape. Spec-level because the harness's observable
  behavior (what a run produces, what a report contains) is the contract consumers rely on.

### Modified Capabilities
(none)

## Impact

- Touches: bench harness only. No indexer, storage schema, MCP tool, or CLI changes.
- New files under `bench/agents/` following existing `bench/*-run.ts` conventions
  (zod schemas, JSON reports, `--baseline` flag, git-stamped records).
- New devDependency: `@opencode-ai/sdk`. Runtime: Bun only.
- New advisory baseline file (`bench/agents/baseline.json`) — NOT wired into
  `bun run check:bench` gates.

## Non-goals

- **papai as first-class target** — deferred; harness is repo-agnostic (`--repo` flag) and
  mirrors existing `bench:papai` script shape, but task corpus curation for papai is a later
  change.
- **Seeded known-bug `review` variants** — declined for v1 (needs fixture maintenance);
  `review` stays judge-scored. Recorded as a possible v2 extension.
- **CI regression gating** — advisory deltas only, no exit-code failure.
- **Multi-model comparison matrix** — single pinned flash-tier agent model + stronger judge
  model (both pinned via env/config).
- **Index cold-start measurement** — index is pre-warmed before timing; cold-start timing is
  out of scope.
- **Changing indexer/storage/MCP/CLI surfaces** — out of scope.
