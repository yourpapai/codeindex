# agent-ab-benchmark — Design

## Context

codeindex's deterministic benches (`bench/*-run.ts` against `bench/corpus/*.json`)
prove the index is correct and fast, but measure retrieval mechanics — not the
agent-level outcome the north star cares about. The research agenda's Track 0
explicitly flags this: "which metric actually matters for an *agent* caller?"
This change adds the missing layer: an agent harness driven by the opencode SDK,
A/B-ing agent sessions with and without the codeindex MCP tools.

Existing conventions the design follows: Bun-only runtime, zod v4 at boundaries,
JSON records + advisory baselines in `bench/`, `--baseline` flag semantics from
`bench/run.ts`, and `check:bench` as the gate surface (unchanged — this bench is
deliberately *not* wired into it).

## Goals / Non-Goals

**Goals:**
- Measure per-task deltas: tokens by kind, tool calls, wall time, cost.
- Grade answer quality twice: objectively (ground truth) and subjectively (blind
  pairwise judge).
- Keep runs reproducible: pinned models, verbatim prompts, interleaved reps.
- Stay honest: records reflect what actually happened (real tool calls, raw
  token counts), never inferred numbers.

**Non-Goals:**
- No CI gating on agent results (LLM variance makes strict gates flaky);
  deterministic benches keep ownership of `check:bench`.
- No papai task corpus yet (harness is repo-agnostic via `--repo`, corpus curation
  is a later change).
- No cold-start/index-latency measurement (index is pre-warmed before timing).
- No changes to indexer, storage, MCP tools, or CLI.

## Decisions

### D1: Drive real opencode sessions via the SDK, not the CLI
Spawn `opencode serve --port 0` per arm (cwd = target repo), point the SDK client
at the printed URL, create a fresh session per task rep, and send the task prompt
via `session.chat()`.

*Alternatives considered:*
- `opencode run` per prompt — no structured event stream, no per-step token/cost
  telemetry; we'd parse transcript text.
- One server, toggle MCP per session — MCP enablement is config-level, not
  session-level; risks cross-arm contamination.
- Custom agent loop over raw model APIs — measures our harness, not real agent
  behavior with real tool-use patterns.

### D2: A/B toggle via inline scratch configs + `OPENCODE_CONFIG_CONTENT`
Each arm gets a scratch config passed inline as JSON in the `OPENCODE_CONFIG_CONTENT`
env var (the same mechanism the SDK itself uses): the `with` arm registers the
codeindex MCP server with `enabled: true`, the `without` arm carries the identical
block with `enabled: false` so it explicitly overrides the repo's project-level
`opencode.json` registration. No workspace files are touched.

*Alternative:* rewrite the repo's `opencode.json` between runs — mutates the
user's workspace and is racy with watchers/editors. (A file-based
`OPENCODE_CONFIG` var was also considered; the inline variant avoids temp-file
lifecycle management entirely.)

### D3: Telemetry from the SDK's message and parts model
Per rep: `session.create` → `session.prompt` (wall time measured around it) →
`session.messages` returns every message with its parts. Ordered tool calls come
from `ToolPart`s (deduplicated by `callID`, final state wins), per-step tokens and
cost from assistant-message `tokens`/`cost`, the final answer from trailing text
parts (synthetic parts excluded), and compaction from `compaction`-type parts.
All SDK payloads are zod-validated at the boundary so SDK drift fails loudly at
parse time, not silently in metrics.

*Alternative:* transcript diffing — brittle, loses ordering and step boundaries.
(SSE event names in the original sketch — `session.next.*` — do not exist in the
installed SDK; the messages/parts model covers the same data without a stream.)

### D4: Task taxonomy reusing the golden corpora
- `locate`, `who-uses` — derived from `bench/corpus/seed.json` (+ papai later):
  ground-truth symbols enable objective grading + hallucination checks.
- `explain`, `review`, `map` — curated prompts with judge rubrics; no ground
  truth, judge-scored only.

Corpus lives in a checked-in JSON file (task id, kind, prompt, ground truth,
judge notes) so tasks are reviewable and diffs meaningful.

### D5: Blind pairwise judging with order swap
The judge model (stronger tier, pinned separately) receives two answers with arm
identity stripped, scores correctness/completeness/specificity, picks a winner.
Each comparison runs twice with presentation order swapped; consistent winner
wins, disagreement = tie. This neutralizes position bias that single-pass
absolute scoring suffers.

### D6: Noise discipline — reps, interleaving, advisory deltas
Default 3 reps per task per arm, execution interleaved across arms (never all of
one arm first, so drift/hour-of-day effects spread evenly), agent and judge
models pinned via env. Reports compare against a stored advisory baseline
(`bench/agents/baseline.json`) and always exit zero; baseline regeneration stays
a manual, intent-ful act like the other benches.

### D7: Layout mirrors existing bench structure
`bench/agents/{run.ts, judge.ts, report.ts, types.ts}`, corpus JSON alongside,
per-run records under `bench/agents/runs/` (gitignored), baseline JSON
checked in. Package scripts: `bench:agent` (run + report), `--baseline` flag for
comparison, mirroring `bench:papai` / `bench:baseline` shapes.

## Risks / Trade-offs

- [SDK event/config schema drift across opencode releases] → pin the SDK
  version; zod-validate events and configs at the boundary so drift fails loudly
  at parse time, not silently in metrics.
- [Judge model bias (verbosity, self-preference)] → blind presentation, order
  swap with tie-on-disagreement, rubric scores recorded so drift is inspectable.
- [Run cost (LLM spend × tasks × reps × arms)] → small default task set
  (~10 tasks) and reps=3; both configurable; `--tasks` filter for cheap reruns.
- [opencode server startup flake] → startup timeout + one retry; failed spawn
  aborts the rep cleanly and is recorded as an error, not silently dropped.
- [Token accounting differs across providers] → record raw per-kind counts
  *and* cost; analysis prefers cost for cross-model comparisons.
- [Hallucination check depends on index freshness] → pre-warm the index before
  the run and reuse it for grading, so grading matches what the `with` arm saw.

## Migration Plan

New tooling only — no runtime surfaces change, nothing to deploy or migrate.
Rollback: delete `bench/agents/` and the package scripts; the repo's other
benches are untouched.

## Open Questions

- Compaction handling: if `session.next.compaction.started` fires mid-task, mark
  the record (token totals lose comparability). Deferring the policy (flag only
  vs exclude) until we see real runs — does not change spec or tasks.
- Session cleanup: whether to `session.delete` after each rep or keep transcripts
  for debugging. Default keep, prune later if disk grows.
