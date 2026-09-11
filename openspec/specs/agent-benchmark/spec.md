# agent-benchmark

## Purpose

Measures what codeindex actually buys an AI agent: running the same benchmark
tasks with and without the codeindex MCP server and comparing token usage, tool
calls, wall time, and answer quality. The harness's observable contract — what
a run records, how arms are isolated, and what a comparison reports — is what
future regression tracking and baseline regeneration rely on.

## Requirements

### Requirement: Dual-arm task execution

The harness SHALL execute each benchmark task in two arms: a `with` arm where
the codeindex MCP tools are available to the agent, and a `without` arm where
they are not. Arms SHALL be fully isolated from each other (separate sessions,
no shared conversation state), and the same verbatim task prompt SHALL be used
in both arms. The agent model SHALL be pinned for the whole run and recorded
in every record.

#### Scenario: With-arm agent can call codeindex tools
- **WHEN** a task runs in the `with` arm
- **THEN** the recorded tool-call trace may include codeindex MCP tool names (e.g. `codeindex_code_search`, `codeindex_code_symbol`, `codeindex_code_impact`)

#### Scenario: Without-arm agent has no codeindex tools
- **WHEN** a task runs in the `without` arm
- **THEN** no codeindex MCP tool appears in the recorded tool-call trace

#### Scenario: Arms receive identical prompts
- **WHEN** a task is executed in both arms
- **THEN** both records carry byte-identical prompt text for that task

### Requirement: Per-run metric record

Every task execution SHALL produce a persisted record containing: task id, arm
label, token counts by kind (input, output, reasoning, cache read, cache
write), cost, the ordered list of tool calls with tool names, wall time for
the agent's answer, the agent model id, and a session identifier. Tool-call
entries SHALL reflect the tools the agent actually invoked, not the tools that
were merely available.

#### Scenario: Record captures actual tool usage
- **WHEN** an agent answers a task after calling three tools
- **THEN** the record lists exactly those three tool calls in order with their names

#### Scenario: Record captures token breakdown
- **WHEN** a task completes
- **THEN** the record contains nonzero token counts for at least input and output, plus cost and wall time

### Requirement: Objective grading for ground-truth tasks

Tasks with ground truth (`locate`, `who-uses`) SHALL be graded objectively:
the final answer passes when the expected symbol(s) from the task's ground
truth appear in the answer. Additionally, every repository symbol the answer
names SHALL be verified to exist in the repo; naming a nonexistent symbol
SHALL flag the answer as hallucinating regardless of the ground-truth match.

#### Scenario: Correct symbol passes
- **WHEN** a `locate` task's answer names the ground-truth symbol
- **THEN** the record is graded as a pass for that task

#### Scenario: Invented symbol is flagged
- **WHEN** a task's answer names a symbol that does not exist in the indexed repo
- **THEN** the record is flagged as hallucinating even if the ground-truth check passes

### Requirement: Blind pairwise judging for subjective tasks

Subjective tasks (`explain`, `review`, `map`) SHALL be compared by a judge
model that does not know which answer came from which arm. Each comparison
SHALL be judged twice with the two answers presented in swapped order; a
consistent winner across both passes SHALL be recorded as the winning arm, and
a disagreement SHALL be recorded as a tie. The judge SHALL return per-criterion
rubric scores (correctness, completeness, specificity) plus the winner.

#### Scenario: Consistent winner is recorded
- **WHEN** the judge picks the same arm's answer in both the original and swapped presentations
- **THEN** the comparison records that arm as the winner with its rubric scores

#### Scenario: Swapped disagreement becomes a tie
- **WHEN** the judge picks arm A first and arm B after the order swap
- **THEN** the comparison records a tie

#### Scenario: Judge cannot infer arm identity
- **WHEN** the judge receives the two answers for comparison
- **THEN** the presentation does not include arm labels, run records, or tool traces

### Requirement: Aggregate report with advisory baseline comparison

The harness SHALL produce a report aggregating per arm: mean and median tokens
(by kind), tool-call counts by tool, wall time, objective pass rate, and judge
win/tie/loss counts. When a stored baseline exists, the report SHALL include
deltas against it; the comparison SHALL be advisory only — the harness SHALL
exit zero regardless of delta direction or size.

#### Scenario: Report aggregates both arms
- **WHEN** a full run (all tasks, both arms, all reps) completes
- **THEN** the report shows per-arm token, tool-call, wall-time, pass-rate, and win-rate summaries

#### Scenario: Worse-than-baseline delta does not fail
- **WHEN** the report's deltas against the stored baseline are worse in every metric
- **THEN** the harness still exits zero and the report presents the deltas as advisory

### Requirement: Repetition and interleaving for noise control

The harness SHALL support running each task multiple times (reps) per arm and
SHALL interleave execution order across arms rather than running all of one
arm first. Reps SHALL default to a fixed nonzero count so a single lucky or
unlucky sample cannot dominate a report.

#### Scenario: Reps are interleaved across arms
- **WHEN** a task runs with more than one rep
- **THEN** execution order alternates between arms instead of completing one arm before the other

#### Scenario: Rep count is explicit in records
- **WHEN** a task runs with three reps per arm
- **THEN** the resulting records and report identify the rep count used
