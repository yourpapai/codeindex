# agent-ab-benchmark — Tasks

## 1. Foundation

- [x] 1.1 Add `@opencode-ai/sdk` as devDependency (pinned version). Verify: `bun install && bun run typecheck`
- [x] 1.2 Define zod schemas + TS types in `bench/agents/types.ts` (`TaskSpec`, `RunRecord`, `JudgeVerdict`, `BenchReport`) for task id/kind/prompt/ground-truth, per-run tokens-by-kind + ordered tool calls + wall time + model + session id, judge rubric scores + winner. Write `tests/agents/types.test.ts` first (failing). Verify: `bun test tests/agents/types.test.ts && bun run typecheck`
- [x] 1.3 Scratch-config generator: emit per-arm config JSON (with/without codeindex MCP block) to a temp dir for `OPENCODE_CONFIG`. Write `tests/agents/config.test.ts` first. Verify: `bun test tests/agents/config.test.ts && bun run typecheck`

## 2. Runner

- [x] 2.1 `opencode serve` spawner: launch per arm with `--port 0` + cwd + `OPENCODE_CONFIG`, parse listening URL from stdout, startup timeout + one retry, clean teardown. Write `tests/agents/serve.test.ts` first (URL parse + timeout logic unit-tested; live spawn covered in 6.2). Verify: `bun test tests/agents/serve.test.ts && bun run typecheck`
- [x] 2.2 Event reducer: fold SSE events (`session.next.tool.called`, `session.next.step.ended`, final message) + `session.messages()` into a `RunRecord` — ordered real tool calls, tokens by kind, cost, wall time; zod-validate payloads; flag compaction if seen. Write `tests/agents/reducer.test.ts` first with fixture event payloads. Verify: `bun test tests/agents/reducer.test.ts && bun run typecheck`
- [x] 2.3 Runner loop in `bench/agents/run.ts`: tasks × arms × reps, interleaved arm order, fresh session per rep, pre-warm index before timing, persist records to `bench/agents/runs/`. Write `tests/agents/interleave.test.ts` first (order logic only). Verify: `bun test tests/agents/interleave.test.ts && bun run typecheck`

## 3. Task corpus

- [x] 3.1 Checked-in corpus JSON: derive `locate`/`who-uses` tasks from `bench/corpus/seed.json` ground truth; curate `explain`/`review`/`map` prompts with judge notes (~10 tasks); validate file against `TaskSpec` schema in a test. Write `tests/agents/corpus.test.ts` first. Verify: `bun test tests/agents/corpus.test.ts && bun run typecheck`

## 4. Grading

- [x] 4.1 Objective grader: ground-truth symbol presence in answer + hallucination check (named symbols must exist in the pre-warmed index). Write `tests/agents/grade.test.ts` first (fixture answers + temp index). Verify: `bun test tests/agents/grade.test.ts && bun run typecheck`
- [x] 4.2 Judge in `bench/agents/judge.ts`: blind pairwise prompt (arm identity stripped), rubric scoring (correctness/completeness/specificity) + winner, run twice with swapped order, disagreement → tie. Write `tests/agents/judge.test.ts` first (fixture judge responses; no live calls). Verify: `bun test tests/agents/judge.test.ts && bun run typecheck`

## 5. Report

- [x] 5.1 Report in `bench/agents/report.ts`: per-arm mean/median tokens by kind, tool-call counts by tool, wall time, objective pass rate, judge win/tie/loss; optional advisory deltas vs `bench/agents/baseline.json`; always exit zero. Write `tests/agents/report.test.ts` first. Verify: `bun test tests/agents/report.test.ts && bun run typecheck`

## 6. Integration & live verification

- [x] 6.1 Wire package.json scripts (`bench:agent`, `--baseline` / `--write-baseline` flags) and gitignore `bench/agents/runs/`. Verify: `bun run bench:agent --tasks nonexistent` exits cleanly with usage
- [x] 6.2 Live smoke: run 1 task × 1 rep × both arms against this repo; confirm records contain real tool names, token counts, and a judged comparison. Verify: manual inspection of `bench/agents/runs/` output + report
- [x] 6.3 Generate advisory `bench/agents/baseline.json` and commit it. Verify: `bun run bench:agent --baseline` prints deltas and exits zero
- [x] 6.4 Full verification. Verify: `bun run check`
