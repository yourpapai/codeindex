# Phase 1 · Indexing Throughput/Latency Benchmark — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce real indexing performance baselines — total + per-phase timings (init / discover / parse / persist / resolve / provenance), file/symbol/reference counts, DB size, and throughput — so Phase 2 optimization work (transaction batching, the O(references × total-symbols) resolver) can be measured against a before-picture.

**Architecture:** Add a non-breaking optional `onPhase` callback to `indexCodebase` so it emits per-phase timings without changing any existing caller. A `runIndexBench(config, mode)` measurement function in `bench/` collects those timings + `statSync` DB size + throughput into an `IndexBenchReport`. A CLI runner (`bench/index-bench-run.ts`) mirrors `bench/run.ts`'s `--repo`/`--baseline` conventions. Wall-clock timings are report-only (machine-dependent); a restricted comparator gates only on deterministic COUNT regressions on a fixed repo snapshot.

**Tech Stack:** Bun, `bun:sqlite`, `bun:test`, `node:fs` (`statSync`), `node:os` (`cpus`), zod v4, TypeScript (strict, NodeNext-style `.js` import specifiers), oxlint + oxfmt.

## Context: where this sits

Phase 1 component ("Indexing throughput/latency benchmark") from `docs/superpowers/specs/2026-07-20-codeindex-roadmap-design.md`. It confirms the roadmap's two named indexing costs — "no transaction batching" (every insert is its own implicit transaction) and "O(references × total-symbols) resolution scan" (`resolveReferenceCandidates` linear-scans all repo symbols per reference). The remaining Phase 1 component (edit-sequence fuzzer) is a separate plan. Mining/optimization is Phase 2.

## Decisions locked (by the maintainer)

- **Per-phase timing:** instrument `indexCodebase` with an optional `onPhase(phase, ms)` callback (additive, non-breaking).
- **Repos:** benchmark real repos now via `--repo` (default cwd; `bench:index:papai` for papai). A synthetic 10k-file generator is DEFERRED to a fast-follow.
- **Gate:** report-only for wall-clock ms; an optional structural-count gate (files/symbols/references) via `--baseline`, flagging only count DECREASES on a fixed repo (the IR harness's decrease-only semantics).

## Global Constraints

Every task's requirements implicitly include this section. Values copied from the repo:

- **Runtime/tests:** Bun. Tests use `bun:test`, run via `bun test tests`.
- **Imports:** ESM only. **All local import specifiers must end in `.js`.** `node:*`/`bun:*` take no `.js`. Cross-dir imports from `bench/` into source use `../src/...js`.
- **Type-only imports** must use `import type`.
- **No optional chaining** (`?.`) — explicit `!== undefined`/`!== null`. `??` allowed.
- **No `any`**; **no `JSON.parse(x) as T`** — use zod (`bench/run.ts` uses `BaselineMetricsSchema.parse(JSON.parse(text) as unknown)`; mirror it).
- **Explicit return types** on every function. **No param reassignment** (locals only). No classes; functional style; `readonly` fields.
- **TS strictness:** `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`.
- **oxlint pedantic**: `max-lines: 300` and `max-lines-per-function` apply to non-test files (`bench/` included). If instrumenting `indexCodebase` trips `max-lines-per-function`, extract the phased body into a helper (as `resolve-files.ts`/`stamp-provenance.ts` were previously extracted).
- **Gates:** `bun run lint`, `bun run typecheck`, `bun run format:check` pass. **Run `bun run format` after editing.**

## Key facts about the code (verified against source)

- `src/indexer/index-codebase.ts` — `IndexSummary` (lines 33-41): `filesIndexed/filesFailed/filesPruned/symbolsIndexed/referencesIndexed/referencesUnresolved/elapsedMs`. `IndexCodebaseInput` (43-46): `{ config; mode }`. `indexCodebase` (215-244) opens db, `try { ensureSchema; createParserLoader; loadTsconfigPathAliases; resolveFilesToProcess; Promise.all(parseFile); applyProcessedFiles; persistResolvedReferences; stampIndexProvenance; return summary } finally { db.close() }`. `elapsedMs = Date.now() - startedAt` (216, 239). No per-phase timing exists.
- `bench/run.ts` — `parseArgs` (29-55): a flag loop supporting `--repo` (default `process.cwd()`, `path.resolve`), `--baseline`, `--update-baseline`. `loadCodeindexConfig({ configPath: path.join(args.repo, '.codeindex.json'), repoRoot: args.repo })` then `indexCodebase({ config, mode: 'full' })` then prints `JSON.stringify(report, null, 2)`; `void main().catch(...)` at the end. Reads a baseline via zod (`BaselineMetricsSchema.parse(JSON.parse(readFileSync(...)) as unknown)`).
- `package.json` scripts include `bench`, `bench:check`, `bench:papai`, `bench:papai:check` (mirror these).
- Test model: `tests/bench/harness-integration.test.ts` — `mkdtempSync` temp repo with `.codeindex.json` + a `.ts` file, real `loadCodeindexConfig` + `indexCodebase`, `afterAll` cleanup.

---

## File Structure

Created by this plan:

- `bench/index-bench-types.ts` — `IndexPhase` re-export usage, `PhaseTimings`, `IndexBenchReport`, `IndexBaselineCounts`.
- `bench/index-bench.ts` — `runIndexBench(config, mode): Promise<IndexBenchReport>`.
- `bench/index-bench-compare.ts` — `compareIndexCounts(report, baseline, ): IndexCountComparison`.
- `bench/index-bench-run.ts` — CLI runner.
- `bench/index-baseline.json` — captured count baseline (Task 4).
- `tests/bench/index-bench.test.ts`, `tests/bench/index-bench-compare.test.ts`, `tests/indexer/index-phase-timing.test.ts`.

Modified:

- `src/indexer/index-codebase.ts` — add `IndexPhase` type + optional `onPhase` to `IndexCodebaseInput`; emit per-phase timings.
- `package.json` — add `bench:index`, `bench:index:check`, `bench:index:papai` scripts.

---

### Task 1: Instrument `indexCodebase` with per-phase timings

**Files:**
- Modify: `src/indexer/index-codebase.ts`
- Test: `tests/indexer/index-phase-timing.test.ts`

**Interfaces:**
- Produces: `IndexPhase` (`'init' | 'discover' | 'parse' | 'persist' | 'resolve' | 'provenance'`); `IndexCodebaseInput` gains `readonly onPhase?: (phase: IndexPhase, ms: number) => void`. `indexCodebase` invokes `onPhase` once per phase with its elapsed ms.

- [ ] **Step 1: Write the failing test**

Create `tests/indexer/index-phase-timing.test.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadCodeindexConfig } from '../../src/config.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import type { IndexPhase } from '../../src/indexer/index-codebase.js'

const tempDirs: string[] = []

const makeRepo = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-phase-'))
  tempDirs.push(dir)
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const alpha = (): number => 1\n')
  return dir
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('indexCodebase onPhase', () => {
  test('emits a timing for every phase', async () => {
    const repo = makeRepo()
    const config = await loadCodeindexConfig({ configPath: path.join(repo, '.codeindex.json'), repoRoot: repo })
    const seen = new Map<IndexPhase, number>()
    await indexCodebase({
      config,
      mode: 'full',
      onPhase: (phase, ms) => {
        seen.set(phase, ms)
      },
    })
    const phases: readonly IndexPhase[] = ['init', 'discover', 'parse', 'persist', 'resolve', 'provenance']
    for (const phase of phases) {
      expect(seen.has(phase)).toBe(true)
      expect(seen.get(phase)!).toBeGreaterThanOrEqual(0)
    }
  })

  test('works without an onPhase callback (backward compatible)', async () => {
    const repo = makeRepo()
    const config = await loadCodeindexConfig({ configPath: path.join(repo, '.codeindex.json'), repoRoot: repo })
    const summary = await indexCodebase({ config, mode: 'full' })
    expect(summary.filesIndexed).toBeGreaterThanOrEqual(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/indexer/index-phase-timing.test.ts`
Expected: FAIL — `IndexPhase` isn't exported and `onPhase` isn't accepted (the first test's `onPhase` is never called, so `seen` is empty).

- [ ] **Step 3: Instrument `indexCodebase`**

In `src/indexer/index-codebase.ts`:

1. Add the phase type (near `IndexSummary`):

```ts
export type IndexPhase = 'init' | 'discover' | 'parse' | 'persist' | 'resolve' | 'provenance'
```

2. Add the optional callback to `IndexCodebaseInput`:

```ts
export interface IndexCodebaseInput {
  readonly config: CodeindexConfig
  readonly mode: 'full' | 'incremental'
  readonly onPhase?: (phase: IndexPhase, ms: number) => void
}
```

3. Add a top-level helper (with the other module-scope helpers):

```ts
const emitPhase = (
  onPhase: ((phase: IndexPhase, ms: number) => void) | undefined,
  phase: IndexPhase,
  since: number,
): void => {
  if (onPhase !== undefined) {
    onPhase(phase, Date.now() - since)
  }
}
```

4. Rewrite the `try` body of `indexCodebase` (lines 219-240) to mark and emit each phase:

```ts
  try {
    ensureSchema(db)
    let mark = Date.now()
    const parserLoader = await createParserLoader()
    const tsconfigAliases = loadTsconfigPathAliases(input.config.tsconfigPaths)
    emitPhase(input.onPhase, 'init', mark)

    mark = Date.now()
    const { filesToProcess, filesPruned } = await resolveFilesToProcess(db, input.config, input.mode)
    emitPhase(input.onPhase, 'discover', mark)

    mark = Date.now()
    const processedFiles = await Promise.all(
      filesToProcess.map((file) => parseFile(input.config, file, parserLoader, tsconfigAliases)),
    )
    emitPhase(input.onPhase, 'parse', mark)

    mark = Date.now()
    const { filesIndexed, filesFailed, symbolsIndexed, parsedFiles } = applyProcessedFiles(db, processedFiles)
    emitPhase(input.onPhase, 'persist', mark)

    mark = Date.now()
    const { referencesIndexed, referencesUnresolved } = persistResolvedReferences(db, parsedFiles)
    emitPhase(input.onPhase, 'resolve', mark)

    mark = Date.now()
    stampIndexProvenance(db, input.config)
    emitPhase(input.onPhase, 'provenance', mark)

    return {
      filesIndexed,
      filesFailed,
      filesPruned,
      symbolsIndexed,
      referencesIndexed,
      referencesUnresolved,
      elapsedMs: Date.now() - startedAt,
    }
  } finally {
    db.close()
  }
```

(`let mark` is a local reassignment — allowed; `no-param-reassign` only bans reassigning parameters.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/indexer/index-phase-timing.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Whole suite + gates**

Run: `bun run format && bun test tests && bun run lint && bun run typecheck && bun run format:check`
Expected: all PASS. If oxlint flags `max-lines-per-function` on `indexCodebase` after the added lines, extract the phased body into a helper `runIndexPhases(db, input): Promise<{ filesIndexed; filesFailed; filesPruned; symbolsIndexed; referencesIndexed; referencesUnresolved }>` and have `indexCodebase` call it inside the try, computing `elapsedMs` around it. Report if you did this.

- [ ] **Step 6: Commit**

```bash
git add src/indexer/index-codebase.ts tests/indexer/index-phase-timing.test.ts
git commit -m "feat(indexer): emit per-phase timings via an optional onPhase callback"
```

---

### Task 2: `runIndexBench` measurement function

**Files:**
- Create: `bench/index-bench-types.ts`
- Create: `bench/index-bench.ts`
- Test: `tests/bench/index-bench.test.ts`

**Interfaces:**
- Consumes: `indexCodebase`/`IndexPhase` from `src/indexer/index-codebase.ts`; `CodeindexConfig` from `src/config.ts`.
- Produces: `IndexBenchReport`, `PhaseTimings`, `IndexBaselineCounts` types; `runIndexBench(config: CodeindexConfig, mode: 'full' | 'incremental'): Promise<IndexBenchReport>`.

- [ ] **Step 1: Create the types**

Create `bench/index-bench-types.ts`:

```ts
import type { IndexPhase } from '../src/indexer/index-codebase.js'

export type PhaseTimings = Readonly<Record<IndexPhase, number>>

export interface IndexBenchReport {
  readonly repo: string
  readonly mode: 'full' | 'incremental'
  readonly filesIndexed: number
  readonly filesFailed: number
  readonly filesPruned: number
  readonly symbolsIndexed: number
  readonly referencesIndexed: number
  readonly referencesUnresolved: number
  readonly elapsedMs: number
  readonly phaseMs: PhaseTimings
  readonly dbSizeBytes: number
  readonly filesPerSecond: number
  readonly symbolsPerSecond: number
  readonly referencesPerSecond: number
  readonly bunVersion: string
  readonly cpuCount: number
}

export interface IndexBaselineCounts {
  readonly filesIndexed: number
  readonly symbolsIndexed: number
  readonly referencesIndexed: number
  readonly referencesUnresolved: number
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/bench/index-bench.test.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runIndexBench } from '../../bench/index-bench.js'
import { loadCodeindexConfig } from '../../src/config.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'

const tempDirs: string[] = []

const makeRepo = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-idxbench-'))
  tempDirs.push(dir)
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const alpha = (): number => 1\n')
  writeFileSync(path.join(dir, 'src', 'b.ts'), "import { alpha } from './a.js'\nexport const beta = (): number => alpha() + 1\n")
  return dir
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('runIndexBench', () => {
  test('reports counts matching indexCodebase, plus phase timings, DB size, throughput', async () => {
    const repo = makeRepo()
    const config = await loadCodeindexConfig({ configPath: path.join(repo, '.codeindex.json'), repoRoot: repo })
    const report = await runIndexBench(config, 'full')

    // Counts match a direct index of the same repo (re-run is deterministic on an unchanged repo).
    const direct = await indexCodebase({ config, mode: 'full' })
    expect(report.filesIndexed).toBe(direct.filesIndexed)
    expect(report.symbolsIndexed).toBe(direct.symbolsIndexed)

    expect(report.filesIndexed).toBeGreaterThanOrEqual(2)
    expect(report.dbSizeBytes).toBeGreaterThan(0)
    for (const phase of ['init', 'discover', 'parse', 'persist', 'resolve', 'provenance'] as const) {
      expect(report.phaseMs[phase]).toBeGreaterThanOrEqual(0)
    }
    // Sum of phases should not exceed total (with a small tolerance for Date.now granularity + inter-phase gaps).
    const phaseSum = Object.values(report.phaseMs).reduce((total, ms) => total + ms, 0)
    expect(phaseSum).toBeLessThanOrEqual(report.elapsedMs + 50)
    expect(report.filesPerSecond).toBeGreaterThanOrEqual(0)
    expect(report.cpuCount).toBeGreaterThanOrEqual(1)
    expect(report.bunVersion.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/bench/index-bench.test.ts`
Expected: FAIL — `bench/index-bench.js` does not exist.

- [ ] **Step 4: Implement `runIndexBench`**

Create `bench/index-bench.ts`:

```ts
import { statSync } from 'node:fs'
import { cpus } from 'node:os'

import type { CodeindexConfig } from '../src/config.js'
import { indexCodebase } from '../src/indexer/index-codebase.js'
import type { IndexPhase } from '../src/indexer/index-codebase.js'
import type { IndexBenchReport } from './index-bench-types.js'

const perSecond = (count: number, elapsedMs: number): number => (elapsedMs <= 0 ? 0 : count / (elapsedMs / 1000))

export const runIndexBench = async (
  config: CodeindexConfig,
  mode: 'full' | 'incremental',
): Promise<IndexBenchReport> => {
  const phaseMs: Record<IndexPhase, number> = {
    init: 0,
    discover: 0,
    parse: 0,
    persist: 0,
    resolve: 0,
    provenance: 0,
  }
  const summary = await indexCodebase({
    config,
    mode,
    onPhase: (phase, ms) => {
      phaseMs[phase] = ms
    },
  })
  const dbSizeBytes = statSync(config.dbPath).size
  return {
    repo: config.repoRoot,
    mode,
    filesIndexed: summary.filesIndexed,
    filesFailed: summary.filesFailed,
    filesPruned: summary.filesPruned,
    symbolsIndexed: summary.symbolsIndexed,
    referencesIndexed: summary.referencesIndexed,
    referencesUnresolved: summary.referencesUnresolved,
    elapsedMs: summary.elapsedMs,
    phaseMs,
    dbSizeBytes,
    filesPerSecond: perSecond(summary.filesIndexed, summary.elapsedMs),
    symbolsPerSecond: perSecond(summary.symbolsIndexed, summary.elapsedMs),
    referencesPerSecond: perSecond(summary.referencesIndexed, summary.elapsedMs),
    bunVersion: Bun.version,
    cpuCount: cpus().length,
  }
}
```

Note: `phaseMs` is a full `Record<IndexPhase, number>` (all six keys initialized), so indexing it in the callback is type-safe under `noUncheckedIndexedAccess`. Mutating its properties is not param reassignment. If tsgo objects to returning `phaseMs` (a mutable `Record`) as the `readonly PhaseTimings` field, that's a valid widening (mutable → readonly) and compiles; if not, spread into a fresh object.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/bench/index-bench.test.ts`
Expected: PASS.

- [ ] **Step 6: Gates**

Run: `bun run format && bun run lint && bun run typecheck && bun run format:check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add bench/index-bench-types.ts bench/index-bench.ts tests/bench/index-bench.test.ts
git commit -m "feat(bench): add indexing benchmark measurement function"
```

---

### Task 3: Count comparator + CLI runner

**Files:**
- Create: `bench/index-bench-compare.ts`
- Create: `bench/index-bench-run.ts`
- Modify: `package.json` (scripts)
- Test: `tests/bench/index-bench-compare.test.ts`

**Interfaces:**
- Consumes: `IndexBenchReport`/`IndexBaselineCounts` from `bench/index-bench-types.ts`; `runIndexBench`; `loadCodeindexConfig`.
- Produces: `compareIndexCounts(report, baseline, tolerance): IndexCountComparison` (`{ regressed: boolean; deltas: readonly IndexCountDelta[] }`), flagging a metric that DROPPED more than `tolerance` below baseline; and the `bench/index-bench-run.ts` CLI.

- [ ] **Step 1: Write the failing comparator test**

Create `tests/bench/index-bench-compare.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

import { compareIndexCounts } from '../../bench/index-bench-compare.js'
import type { IndexBaselineCounts, IndexBenchReport } from '../../bench/index-bench-types.js'

const report = (overrides: Partial<IndexBenchReport>): IndexBenchReport => ({
  repo: '/x',
  mode: 'full',
  filesIndexed: 10,
  filesFailed: 0,
  filesPruned: 0,
  symbolsIndexed: 100,
  referencesIndexed: 200,
  referencesUnresolved: 50,
  elapsedMs: 5,
  phaseMs: { init: 0, discover: 0, parse: 0, persist: 0, resolve: 0, provenance: 0 },
  dbSizeBytes: 1,
  filesPerSecond: 0,
  symbolsPerSecond: 0,
  referencesPerSecond: 0,
  bunVersion: '1',
  cpuCount: 1,
  ...overrides,
})

const baseline: IndexBaselineCounts = { filesIndexed: 10, symbolsIndexed: 100, referencesIndexed: 200, referencesUnresolved: 50 }

describe('compareIndexCounts', () => {
  test('flags a drop in indexed symbols', () => {
    expect(compareIndexCounts(report({ symbolsIndexed: 90 }), baseline, 0).regressed).toBe(true)
  })

  test('does not flag equal counts', () => {
    expect(compareIndexCounts(report({}), baseline, 0).regressed).toBe(false)
  })

  test('does not flag an increase (repo grew)', () => {
    expect(compareIndexCounts(report({ symbolsIndexed: 120, filesIndexed: 12 }), baseline, 0).regressed).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bench/index-bench-compare.test.ts`
Expected: FAIL — `bench/index-bench-compare.js` does not exist.

- [ ] **Step 3: Implement the comparator**

Create `bench/index-bench-compare.ts`:

```ts
import type { IndexBaselineCounts, IndexBenchReport } from './index-bench-types.js'

export interface IndexCountDelta {
  readonly metric: keyof IndexBaselineCounts
  readonly baseline: number
  readonly current: number
  readonly delta: number
}

export interface IndexCountComparison {
  readonly regressed: boolean
  readonly deltas: readonly IndexCountDelta[]
}

export const compareIndexCounts = (
  report: IndexBenchReport,
  baseline: IndexBaselineCounts,
  tolerance: number,
): IndexCountComparison => {
  const metrics: readonly (keyof IndexBaselineCounts)[] = [
    'filesIndexed',
    'symbolsIndexed',
    'referencesIndexed',
    'referencesUnresolved',
  ]
  const deltas: readonly IndexCountDelta[] = metrics.map((metric) => ({
    metric,
    baseline: baseline[metric],
    current: report[metric],
    delta: report[metric] - baseline[metric],
  }))
  // Only the "more is expected" counts gate on a decrease. referencesUnresolved dropping is an improvement,
  // so it is reported but never flags a regression.
  const gated: readonly (keyof IndexBaselineCounts)[] = ['filesIndexed', 'symbolsIndexed', 'referencesIndexed']
  const regressed = deltas.some((entry) => gated.includes(entry.metric) && entry.delta < -tolerance)
  return { regressed, deltas }
}
```

- [ ] **Step 4: Run comparator test to verify it passes**

Run: `bun test tests/bench/index-bench-compare.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Implement the CLI runner**

Create `bench/index-bench-run.ts`:

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { loadCodeindexConfig } from '../src/config.js'
import { compareIndexCounts } from './index-bench-compare.js'
import { runIndexBench } from './index-bench.js'
import type { IndexBaselineCounts, IndexBenchReport } from './index-bench-types.js'

const IndexBaselineCountsSchema = z.object({
  filesIndexed: z.number(),
  symbolsIndexed: z.number(),
  referencesIndexed: z.number(),
  referencesUnresolved: z.number(),
})

interface IndexBenchArgs {
  readonly repo: string
  readonly mode: 'full' | 'incremental'
  readonly baseline: string | null
  readonly updateBaseline: boolean
}

const parseArgs = (argv: readonly string[]): IndexBenchArgs => {
  let repo = process.cwd()
  let mode: 'full' | 'incremental' = 'full'
  let baseline: string | null = null
  let updateBaseline = false
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--repo' && value !== undefined) {
      repo = path.resolve(value)
      index += 1
    } else if (flag === '--mode' && value !== undefined) {
      mode = value === 'incremental' ? 'incremental' : 'full'
      index += 1
    } else if (flag === '--baseline' && value !== undefined) {
      baseline = path.resolve(value)
      index += 1
    } else if (flag === '--update-baseline') {
      updateBaseline = true
    }
  }
  return { repo, mode, baseline, updateBaseline }
}

const toBaselineCounts = (report: IndexBenchReport): IndexBaselineCounts => ({
  filesIndexed: report.filesIndexed,
  symbolsIndexed: report.symbolsIndexed,
  referencesIndexed: report.referencesIndexed,
  referencesUnresolved: report.referencesUnresolved,
})

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))
  const config = await loadCodeindexConfig({
    configPath: path.join(args.repo, '.codeindex.json'),
    repoRoot: args.repo,
  })
  const report = await runIndexBench(config, args.mode)
  console.log(JSON.stringify(report, null, 2))

  if (args.updateBaseline && args.baseline !== null) {
    writeFileSync(args.baseline, `${JSON.stringify(toBaselineCounts(report), null, 2)}\n`)
    console.error(`Index baseline written to ${args.baseline}`)
    return
  }

  if (args.baseline !== null && existsSync(args.baseline)) {
    const baseline = IndexBaselineCountsSchema.parse(JSON.parse(readFileSync(args.baseline, 'utf8')) as unknown)
    const comparison = compareIndexCounts(report, baseline, 0)
    for (const entry of comparison.deltas) {
      const sign = entry.delta >= 0 ? '+' : ''
      console.error(`${entry.metric}: ${entry.baseline} -> ${entry.current} (${sign}${entry.delta})`)
    }
    if (comparison.regressed) {
      console.error('Index count regression detected against baseline.')
      process.exit(1)
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
```

- [ ] **Step 6: Add scripts**

In `package.json`, after the `bench:papai:check` line, add:

```json
    "bench:index": "bun run bench/index-bench-run.ts",
    "bench:index:check": "bun run bench/index-bench-run.ts --baseline bench/index-baseline.json",
    "bench:index:papai": "bun run bench/index-bench-run.ts --repo ../papai",
```

- [ ] **Step 7: Smoke-run the benchmark**

Run: `bun run bench:index`
Expected: prints an `IndexBenchReport` JSON for this repo — non-zero `filesIndexed`/`symbolsIndexed`, `phaseMs` for all six phases, `dbSizeBytes > 0`, throughput numbers, `bunVersion`, `cpuCount`.

- [ ] **Step 8: Whole suite + gates**

Run: `bun run format && bun test tests/bench && bun run lint && bun run typecheck && bun run format:check`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add bench/index-bench-compare.ts bench/index-bench-run.ts package.json tests/bench/index-bench-compare.test.ts
git commit -m "feat(bench): add indexing benchmark CLI runner and count comparator"
```

---

### Task 4: Capture the count baseline + verify the gate

**Files:**
- Create: `bench/index-baseline.json`

**Interfaces:**
- Consumes: the `bench:index` / `bench:index:check` scripts.
- Produces: `bench/index-baseline.json` — the committed count reference for the (opt-in) regression gate.

- [ ] **Step 1: Write the baseline**

Run: `bun run bench/index-bench-run.ts --baseline bench/index-baseline.json --update-baseline`
Expected: stderr prints `Index baseline written to .../bench/index-baseline.json`; the file contains `filesIndexed`, `symbolsIndexed`, `referencesIndexed`, `referencesUnresolved` (integers for this repo).

- [ ] **Step 2: Verify the gate passes against its own baseline**

Run: `bun run bench:index:check`
Expected: exit 0 (`echo $status` → 0 in fish); stderr shows each count with a `(+0)` delta; no "regression detected".

- [ ] **Step 3: Verify a regression is caught**

Temporarily edit `bench/index-baseline.json` to set `"symbolsIndexed"` to a value well above the real count (e.g. `999999`), then run `bun run bench:index:check`.
Expected: stderr prints `symbolsIndexed: 999999 -> <real> (-<delta>)` and `Index count regression detected against baseline.`; exit code 1 (`echo $status` → 1). Restore the real baseline afterward:

Run: `bun run bench/index-bench-run.ts --baseline bench/index-baseline.json --update-baseline`

Double-check `symbolsIndexed` no longer says 999999.

- [ ] **Step 4: Commit**

```bash
git add bench/index-baseline.json
git commit -m "feat(bench): capture indexing count baseline for regression gate"
```

- [ ] **Step 5: Note the CI/handoff wiring (documentation only)**

`bench:index` reports throughput/latency (machine-dependent — read, don't gate). `bench:index:check` is an OPT-IN count-regression gate: it flags only DECREASES in `filesIndexed`/`symbolsIndexed`/`referencesIndexed` on this repo. Because these counts change legitimately whenever the repo's source changes (e.g. adding files raises them — never flagged; deleting/refactoring can lower them — flagged), the baseline needs regenerating (`--update-baseline`) alongside any change that legitimately reduces indexed counts, committed in the same PR. Like `bench:check`, it is intentionally NOT part of `bun run check`. There is no CI config in the repo yet; this is a handoff note.

---

## Definition of done (this plan)

- `indexCodebase` emits per-phase timings via an optional `onPhase` callback; no existing caller changed.
- `bun run bench:index` prints an `IndexBenchReport` (total + per-phase ms, counts, DB size, throughput, env) for any `--repo`.
- Wall-clock timings are report-only; `bench:index:check` gates only on deterministic count DECREASES against a committed `bench/index-baseline.json`, proven to exit 0 on match and 1 on a seeded regression.
- The benchmark confirms the roadmap's indexing-cost picture (phase breakdown shows where time goes: parse vs persist vs resolve).
- `bun test tests`, `bun run lint`, `bun run typecheck`, `bun run format:check` all pass.

## Deferred to sibling / later plans (do NOT do here)

- **Synthetic 10k-file repo generator** for the literal roadmap scale claim — a fast-follow.
- **Edit-sequence integrity fuzzer** — the remaining Phase 1 component, its own plan.
- Optimizing anything the benchmark reveals (transaction batching, the O(refs×symbols) resolver) — Phase 2, gated on these numbers.
- Gating on DB size or wall-clock ms — deliberately excluded as machine-dependent/noisy.
