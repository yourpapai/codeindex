# codeindex — Next-Iteration Roadmap (Design)

**Date:** 2026-07-20
**Status:** Approved design. Firm commitment covers **Phase 1 only**; Phases 2–4 are provisional
and planned at their gates.
**Source:** Grounded in `docs/research/01`–`05` (discovery + agenda, 2026-07-19).

---

## Purpose

A multi-phase roadmap for the next iterations of `codeindex`, derived from the research corpus in
`docs/research/`. It is deliberately structured around one operating principle — **measure before
you commit** — so that only the evaluation harness is a firm commitment now, and every subsequent
phase is opened by evidence rather than assumption.

This document decides *what to build, in what order, and under what conditions*. It is not itself
an implementation plan; `writing-plans` is invoked for Phase 1 once this design is approved.

---

## North star & axes

> Help AI coding agents (and maintainers) retrieve the **right** code context — **accurately** and
> **cheaply** — and answer "where is X / who uses X" without reading whole files.

Four axes, used throughout:

- **Accuracy** — right symbols, right edges.
- **Cheapness** — few tokens, few round-trips per answer.
- **Freshness** — index stays complete and current through edit loops.
- **Reach** — languages and repo shapes usable.

**Calibration.** Foreground **Accuracy + Cheapness + Ergonomics**. **Reach & scale stay secondary**
until accuracy is trustworthy. (Inherited from the research; revisit only if real usage forces it.)

---

## Operating principle — measure before you commit

Only **Phase 1 (the harness) is firm.** Every phase after it is *provisional*: drawn so the arc is
legible, but not started until its **gate** opens. The harness is the instrument that opens gates.

**A "gate" is three explicit things:**

1. **Entry criterion** — what must be true/known before the phase starts (usually: "the prior
   phase's numbers show this is the bottleneck").
2. **Go/no-go rule** — the condition under which we *don't* build it, or build a cheaper substitute
   (the YAGNI escape hatch).
3. **Success metric** — how the harness confirms it worked, and the regression gate it must clear to
   merge.

**Reassessment cadence.** Baseline after Phase 1 → prioritize Phase 2. Re-baseline and re-rank the
remaining candidates after *every* phase. The drawn order is a hypothesis the numbers may rewrite.
No change merges if it regresses precision@k / MRR past threshold.

**Handoff consequence.** Because Phases 2–4 are provisional, implementation planning covers Phase 1
only. Later phases are planned when their gates open, against real numbers.

---

## Phase map

```
Phase 1  HARNESS  (FIRM)
  golden corpus + IR gate (precision@k, MRR)
  query logging . protocol round-trip tests . edit-sequence fuzzer
  indexing benchmark . [ride-alongs: busy_timeout, index provenance]
     |
  == REASSESS GATE: baselines set Phase 2 priority ==
     |
Phase 2  ACCURACY & FREE WINS  (provisional; likely 2-3 shippable slices)
  complete the graph . lexical fixes . ranking . token economics . nav primitives
     | == gate: measured code_impact FN drop; no precision@k/MRR regression ==
Phase 3  GATED BIG BETS  (go / no-go)
  type-aware resolution . context bundles . stable identity + kind fidelity
     | == gate: precision is the measured bottleneck? fuzzer says churn hurts? ==
Phase 4  CONDITIONAL / REACH
  semantic/hybrid search . monorepo/workspace . multi-language
     | == gate: query logs show real NL miss rate; reach becomes a goal ==
```

---

## Phase 1 — Evaluation & Correctness Harness (FIRM)

**Purpose.** Produce trustworthy baselines and a regression gate. Ships no user-facing retrieval
improvement by design; it is the instrument the rest of the roadmap is measured with.

**Decisions baked in:**

- **IR relevance is the backbone** — precision@k + MRR against a labeled golden-query corpus is the
  deterministic CI gate. A task-success rig is deferred to a later stretch (see Non-goals).
- **Corpus is hybrid** — lightweight query logging + a hand-authored seed for immediate baselines +
  mined real queries over time (a self-improving set).

### Components

1. **Golden-query corpus + IR scorer** (`bench/`)
   - Labeled queries across the three agent-realistic shapes: *find-symbol*, *who-uses-X*,
     *NL-intent* — each with an expected result set (qualified names / symbol keys).
   - Scorer computes **precision@k + MRR** (NDCG optional) by running each query through the real
     search/impact path.
   - A **hand-authored seed** yields immediate baselines; the corpus grows from mined logs.
   - Baselines recorded per repo — the reference point every later change A/Bs against.

2. **Query logging / observability**
   - Capture every MCP query: text, tool, filters, `resultCount`, **latency**, hit/miss → a
     mineable store.
   - Doubles as the observability the tool lacks today (only `code_index` reports timing) and as the
     "mine over time" feed for the corpus.

3. **Protocol-boundary tests** (`tests/mcp/`)
   - Real `Client` / `StdioClientTransport` round-trips via `callTool` / `listTools` — the first
     tests that cross the actual MCP SDK boundary.
   - Deliberately covers the **`code_index` DB-target wiring bug** (a non-cwd `path` indexes a DB the
     query tools never read), `guidance` logic, and error paths.

4. **Edit-sequence integrity fuzzer**
   - Property-based rename/move/delete sequences asserting `symbol_references` integrity;
     **quantifies the multi-hop FK-cascade orphaning** (2+-hop refs silently going `NULL`). Output is
     a number that sizes later freshness/identity work.

5. **Indexing throughput/latency benchmark**
   - On a 10k+ file repo: parse/extract/persist/resolve timings + DB size. Real perf numbers *before*
     any optimization (today: no transaction batching, O(references × total-symbols) resolution scan).

### Ride-alongs (low-risk, folded into Phase 1)

These are tiny and de-risk the harness itself running against a live, multi-agent-accessed DB:

- **Set `busy_timeout`** — near-one-liner; addresses `SQLITE_BUSY` under a live query + background
  reindex (swarm/subagent usage plausibly hits this today).
- **Stamp index provenance** — record the git commit/branch (and `.codeindex.json` identity) the
  index reflects, so branch/worktree drift is detectable rather than silently wrong.

### Baseline repos

- **`codeindex` itself** — small, functional-TS (library-shaped).
- **`yourpapai/papai`** — the real dogfooding app; the natural target for measuring `code_impact`
  false-negative rate on real React/component usage.
- *(Optional)* one additional OSS library for breadth — confirmed at Phase 1 planning. `≥2` repos is
  the floor; the two above already clear it.

### Exit criteria (definition of done)

- Baseline precision@k + MRR on ≥2 repos, reproducible from a single command.
- IR scorer wired as a **CI regression gate** (fails past a threshold).
- Protocol round-trip tests green across all 4 tools + guidance + error paths.
- Fuzzer emits a quantified orphaning rate; benchmark emits throughput/latency/DB-size.
- Query logging capturing real traffic into a mineable store.
- Ride-alongs landed (`busy_timeout` set; index provenance stamped).

**Deliverable.** A baseline report + a regression gate that every later phase measures against.

---

## Reassessment Gate (Phase 1 → Phase 2)

The baseline report answers four questions the project currently cannot:

- Where is retrieval weakest (which query shape has low precision@k)?
- How badly does `code_impact` under-report (measured FN rate on labeled who-uses-X — especially JSX
  and member-call cases)?
- How bad is the multi-hop orphaning?
- How slow is indexing?

**Decision rule.** Rank Phase 2 candidates by **(measured deficit × cheapness)**. The drawn order —
graph completion leading — is a hypothesis; if the numbers say ranking or a lexical bug is the bigger
measured deficit, it leads instead. The gate's output is a prioritized Phase 2 plan, which is when
`writing-plans` is next invoked.

---

## Phase 2 — Accuracy & Free Wins (provisional)

Likely splits into 2–3 shippable slices when planned. Candidate pool, ranked by the gate:

- **Complete the reference graph (research 2a):** JSX usage edges · member / `this.x()` calls
  resolved against the enclosing class's member table · activate `extends` / `implements` via
  `class_heritage` · `export *` barrels + `import * as ns` · **suppress the codebase-wide
  false-positive fallback**.
- **Lexical free wins (1b + cheap correctness):** `COLLATE NOCASE` · acronym / snake / kebab
  tokenization · activate the dead `prefix='2 3'` indexes · FTS snippet-column bug · unescaped `LIKE`.
- **Ranking upgrade (1a):** blend normalized BM25 · symbol in-degree / centrality · kind-awareness ·
  intra-pool dedup.
- **Token economics (3a):** kill the ~2× payload duplication · pagination / `hasMore`.
- **Navigation primitives (3b):** list-symbols-in-file · go-to-def at (file, line, col) ·
  list-exports-of-module · multi-hop call hierarchy · snippet on `ImpactResult`.
- **Transaction batching (4a):** the one perf item that's audit-and-fix, not research.
- **Robustness:** file-size guard on parse (unbounded today) — a small ride-along here (see
  cross-cutting risks).

**Entry gate.** Harness baselines exist.
**Go/no-go (per item).** Heuristic member-call resolution ships only if it does not push false-positive
rate past threshold *on the harness*; fallback suppression must show a measured FP drop.
**Success.** Measured drop in `code_impact` FN rate on papai · precision@k / MRR up with no
regression · measured token reduction per response.

**Pre-flight.** Reconcile the "tier1" scaffolding (dead/write-only columns `resolved_file_id`,
`is_exported`, `start/end_byte`, `precedence`; modeled-but-unproduced edge types) — decide keep-or-drop
per item rather than building on ambiguous groundwork.

---

## Phase 3 — Gated Big Bets (go / no-go)

- **Type-aware resolution (2b)** — `ts.Program` / Language-Service, lazy / on-demand per `code_impact`
  query.
  - **Entry gate:** 2a's cheap heuristics still leave a large measured gap **and** the harness shows
    *precision* (not recall) is the bottleneck.
  - **Go/no-go:** if that fails → ship a recommendation memo and stop.
  - **Success:** precision/recall delta vs. the heuristic resolver + acceptable per-query latency.
- **Context bundles (3c)** — a budget-aware `context_bundle` tool (target + high-confidence callers +
  type deps in one call).
  - **Entry gate:** 2a (edges) + 1a (ranking) landed.
  - **Success:** token reduction with task-relevant coverage held.
- **Stable identity + kind fidelity (2c)** — content / AST-hash `symbolKey` that survives unrelated
  edits; semantic kind (function / component / hook / method) instead of the raw tree-sitter node type.
  - **Entry gate:** Phase-1 fuzzer data shows churn actually breaks workflows.
  - **Success:** measured reduction in stale-handle breakage.

---

## Phase 4 — Conditional / Reach

- **Semantic / hybrid retrieval (1c)** — local in-process embeddings fused with BM25 + structural rank.
  - **Entry gate:** *Phase 1's query logs* show a real NL-query miss rate **after** 1a/1b land.
  - **Go/no-go:** strong YAGNI — better tokenization (1b) may already capture most of the benefit.
  - **Success:** miss-rate reduction beating a 1b-only ablation.
- **Monorepo / workspace (4b)** — `node_modules` / `package.json` `exports` resolution,
  project-reference / `workspaces` auto-discovery, non-wildcard tsconfig paths, per-package
  partitioning. **Entry gate:** broader-repo reach becomes an explicit goal.
- **Multi-language (4c)** — tree-sitter grammar plugin mechanism. **Entry gate:** JSX/TS accuracy solid
  first; confirm the `kind` / schema layer can even go language-agnostic.

**Feedback loop.** Phase 1's query logging is the evidence that opens (or keeps shut) the Phase 4
semantic gate — the instrument built first is what tells you whether the most expensive bet is worth
it.

---

## Cross-cutting risks (each with an owner)

- **`code_impact` false negatives are safety-critical.** A missed "who calls this" lets an agent
  confidently ship a breaking change. *Owned by:* the harness (measures FN rate directly) + Phase 2
  (surface confidence; evaluate over-reporting `name_only` by default so agents don't over-trust
  heuristic hits).
- **Metric divergence (IR vs. agent-task-success).** *Owned by:* the IR-backbone choice + a deferred
  task-success rig; re-examine if IR gains stop feeling like agent wins.
- **Stale-index / branch-drift has no owner today.** *Owned by:* Phase 1 provenance ride-along.
- **Concurrent multi-agent DB access unstudied.** *Owned by:* Phase 1 `busy_timeout` ride-along;
  deeper pooling/snapshot work deferred until measured need.
- **Hostile/huge input** — no file-size guard; unescaped `LIKE`. *Owned by:* Phase 2 (LIKE in the
  lexical bucket; file-size guard as a robustness ride-along there).
- **Reconcile the "tier1" scaffolding.** *Owned by:* Phase 2 pre-flight.

---

## Non-goals (YAGNI — stated so they don't creep in)

- Learned-to-rank / ML ranking (needs training data the harness would first have to produce).
- API-based embeddings (self-contained preference; local only if 1c is warranted).
- HTTP/SSE transport & remote deployment (stdio only).
- Full data-flow / control-flow call graph beyond 1-hop + multi-hop hierarchy.
- Task-success as the *primary* gate (it is a later stretch, not the backbone).
- Cross-repo / org-wide federated index.

---

## Scenarios this unlocks (motivation, not commitments)

- **Impact-aware code review** — full blast-radius on a diff, confidence-weighted.
- **Dead-code / safe-deletion** — needs 2a first (today zero in-degree often just means "JSX edges
  missing").
- **Test-impact selection** — needs test files indexed (default config excludes them) + outgoing
  multi-hop.
- **Safe automated rename/refactor** — needs 2b-grade recall (a missed usage silently breaks the build).

---

## How this serves the north star

- **Accuracy:** Phase 2 fixes the graph for real TS/React patterns; ranking sharpens with signals
  already stored; Phase 3 raises the ceiling toward go-to-definition grade; the harness makes all of
  it verifiable.
- **Cheapness:** token-economics halves payload cost; nav primitives + context bundles cut whole-file
  reads; better top-k means fewer follow-up round-trips.
- **Freshness:** provenance + `busy_timeout` now; watch/mtime/invalidation work later, sized by the
  fuzzer.
- **Reach:** deliberately secondary until accuracy is trustworthy.

---

## Next step

On approval: invoke `writing-plans` to produce the implementation plan for **Phase 1 only**.
