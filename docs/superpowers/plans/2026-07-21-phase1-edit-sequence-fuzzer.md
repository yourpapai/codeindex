# Phase 1 · Edit-Sequence Integrity Fuzzer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quantify the multi-hop reference-orphaning bug — incremental reindex silently `SET NULL`s `symbol_references.target_symbol_id` for refs 2+ hops from an edit — as a reproducible number, using a differential (incremental-vs-full) oracle, while hard-asserting the invariants that DO hold today.

**Architecture:** A seeded PRNG + a deterministic base-repo generator (a chain of `.ts` modules) produce reproducible fuzz inputs. Random edit sequences (rename-symbol / rename-file / delete-file / edit-content) are applied to a temp repo, reindexed `incremental` after each edit. The final incremental reference state is diffed against a from-scratch `full` reindex of the same file tree (ground truth) to compute an orphaning rate. A fixed-seed CI test asserts two true-today invariants (no dangling FK; 1-hop re-resolution) and that the rate is a finite number — it does NOT gate on the rate (the multi-hop bug is known and unfixed).

**Tech Stack:** Bun, `bun:sqlite`, `bun:test`, `node:fs`, TypeScript (strict, NodeNext-style `.js` import specifiers), oxlint + oxfmt. No `fast-check` dependency — a hand-rolled seeded PRNG.

## Context: where this sits

Final Phase 1 component ("Edit-sequence integrity fuzzer") from `docs/superpowers/specs/2026-07-20-codeindex-roadmap-design.md`. It sizes the freshness/identity work in a later phase. The bug is documented as `docs/research/04-gaps-and-opportunities.md` row F3. This is measurement of a KNOWN bug — the deliverable is a number, plus assertions on what currently works. Fixing the orphaning is out of scope (a later phase, sized by this number).

## Decision locked (by the maintainer)

**Assert + measure:** report the orphaning rate (no regression gate on it). PLUS hard-assert two true-today invariants in the fixed-seed test: (1) no dangling FK — every non-null `target_symbol_id` points at a real `symbols.id`; (2) 1-hop re-resolution — a direct dependent's reference re-resolves after an edit. The 2+-hop orphaning is measured-only. No committed orphaning-rate baseline (deferred to the fix phase).

## The bug (verified — this is what the fuzzer measures)

`symbol_references` DDL (`src/storage/schema.ts:52-64`): `target_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL`; `source_symbol_id`/`source_file_id` are `ON DELETE CASCADE`. On incremental reindex, `clearFileRows(fileId)` (`src/storage/queries.ts:12-17`) does `DELETE FROM symbols WHERE file_id = ?` for every reprocessed file. `findIncrementalFileSet` (`src/indexer/resolve-files.ts:11-44`) includes only ONE hop of dependents. So for a chain `a → b → c`, editing `c` reprocesses `{c, b}`: deleting b's symbols fires `ON DELETE SET NULL` on the `a→b` reference (a is NOT in the batch, never revisited), which is silently orphaned forever. `IndexSummary.referencesUnresolved` does NOT see this (it counts only rows freshly inserted for this run's files) — a structural row scan / differential is required.

## Global Constraints

Every task's requirements implicitly include this section. Values copied from the repo:

- **Runtime/tests:** Bun. Tests use `bun:test`, run via `bun test tests`.
- **Imports:** ESM only. **All local import specifiers end in `.js`.** `node:*`/`bun:*` take no `.js`.
- **Type-only imports** must use `import type`.
- **No optional chaining** (`?.`) — explicit `!== undefined`/`!== null`. `??` allowed.
- **No `any`**; **no `JSON.parse(x) as T`** — use zod if reading JSON.
- **Explicit return types** on every function. **No param reassignment** (locals only). No classes; functional style; `readonly` fields.
- **TS strictness:** `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`.
- **oxlint pedantic** `max-lines: 300` / `max-lines-per-function` on non-test files (`bench/` included) — split the fuzzer into focused modules.
- **Determinism:** all randomness goes through the seeded PRNG (no `Math.random`) so a run reproduces from `{seed, ...}`.
- **Gates:** `bun run lint`, `bun run typecheck`, `bun run format:check` pass. **Run `bun run format` after editing.**

## Key facts about the code (verified)

- `indexCodebase({ config, mode })` — full/incremental. `openDatabase`, `ensureSchema` set `PRAGMA foreign_keys = ON`. No file-watching anywhere — reindex is always an explicit `indexCodebase` call.
- `symbol_references` columns: `source_symbol_id, source_file_id, target_symbol_id, target_file_id, target_name, target_export_name, target_module_specifier, edge_type, confidence, line_number`. `symbols` has `id` + `qualified_name`.
- `CodeindexConfig` can be constructed as a plain object (tests do this — e.g. `tests/mcp/query-logging.test.ts`) with a custom `dbPath`, so two indexes of the same repo can target two different DB files for the differential.
- Test model: `tests/bench/index-bench.test.ts` / `harness-integration.test.ts` — `mkdtempSync` temp repo + `.codeindex.json` + real `indexCodebase`, `afterAll` cleanup.
- File layout convention: `bench/index-bench-types.ts` / `index-bench.ts` / `index-bench-run.ts` (pure logic vs CLI split); scripts `bench:index*` in package.json.

---

## File Structure

Created by this plan:

- `bench/fuzz-rng.ts` — `createRng(seed): Rng` (deterministic PRNG) + `randomInt`/`pick` helpers.
- `bench/fuzz-repo.ts` — `generateChainRepo(dir, fileCount): RepoModel` (writes a chain of `.ts` modules + `.codeindex.json`); `RepoModel` tracks current file/symbol names.
- `bench/fuzz-ops.ts` — the 4 edit operations + `applyRandomEdit(rng, dir, model): FuzzOperation`.
- `bench/edit-fuzz-types.ts` — `FuzzReport`, `FuzzOperation`, `RepoModel`, `ReferenceKey` types.
- `bench/edit-fuzz.ts` — `runEditFuzz(input): FuzzReport` (the measurement function: sequences + differential oracle); `readReferenceState(db)`, `countDanglingTargets(db)` helpers.
- `bench/edit-fuzz-run.ts` — CLI runner.
- `tests/bench/fuzz-rng.test.ts`, `tests/bench/fuzz-repo.test.ts`, `tests/bench/edit-fuzz.test.ts`.

Modified:

- `package.json` — add a `bench:fuzz` script.

---

### Task 1: Seeded PRNG + base-repo generator

**Files:**
- Create: `bench/fuzz-rng.ts`
- Create: `bench/fuzz-repo.ts`
- Create: `bench/edit-fuzz-types.ts` (the shared types consumed here + later)
- Test: `tests/bench/fuzz-rng.test.ts`
- Test: `tests/bench/fuzz-repo.test.ts`

**Interfaces:**
- Produces: `Rng` (`() => number` in [0,1)); `createRng(seed: number): Rng`; `randomInt(rng: Rng, maxExclusive: number): number`; `pick<T>(rng: Rng, items: readonly T[]): T`. `RepoModel` (`{ readonly dir: string; readonly files: readonly RepoFile[] }`, `RepoFile = { name: string; symbol: string }`); `generateChainRepo(dir: string, fileCount: number): RepoModel` (writes `src/mod0.ts`..`modN.ts`, each exporting `sym{i}` and importing+calling `sym{i-1}` from `./mod{i-1}.js`; writes `.codeindex.json` with `roots:['src']`).

- [ ] **Step 1: Write the failing PRNG test**

Create `tests/bench/fuzz-rng.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

import { createRng, pick, randomInt } from '../../bench/fuzz-rng.js'

describe('createRng', () => {
  test('is deterministic for a given seed', () => {
    const a = createRng(42)
    const b = createRng(42)
    const seqA = [a(), a(), a()]
    const seqB = [b(), b(), b()]
    expect(seqA).toEqual(seqB)
  })

  test('differs across seeds', () => {
    expect(createRng(1)()).not.toBe(createRng(2)())
  })

  test('produces values in [0, 1)', () => {
    const rng = createRng(7)
    for (let index = 0; index < 100; index += 1) {
      const value = rng()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  test('randomInt stays in range and pick returns a member', () => {
    const rng = createRng(9)
    for (let index = 0; index < 50; index += 1) {
      const n = randomInt(rng, 5)
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThan(5)
    }
    expect(['a', 'b', 'c']).toContain(pick(createRng(3), ['a', 'b', 'c']))
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/bench/fuzz-rng.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement the PRNG**

Create `bench/fuzz-rng.ts` (mulberry32 — deterministic, seed in, no `Math.random`):

```ts
export type Rng = () => number

export const createRng = (seed: number): Rng => {
  let state = seed >>> 0
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const randomInt = (rng: Rng, maxExclusive: number): number => Math.floor(rng() * maxExclusive)

export const pick = <T>(rng: Rng, items: readonly T[]): T => {
  const value = items[randomInt(rng, items.length)]
  if (value === undefined) {
    throw new Error('pick called on an empty array')
  }
  return value
}
```

(`let state`/`let t` are locals — reassignment allowed. `pick` guards the indexed access for `noUncheckedIndexedAccess`.)

- [ ] **Step 4: Run to verify PRNG passes**

Run: `bun test tests/bench/fuzz-rng.test.ts` — PASS.

- [ ] **Step 5: Create the shared types**

Create `bench/edit-fuzz-types.ts`:

```ts
export interface RepoFile {
  readonly name: string
  readonly symbol: string
}

export interface RepoModel {
  readonly dir: string
  readonly files: readonly RepoFile[]
}

export type FuzzOperationKind = 'rename-symbol' | 'rename-file' | 'delete-file' | 'edit-content'

export interface FuzzOperation {
  readonly kind: FuzzOperationKind
  readonly target: string
}

export interface FuzzReport {
  readonly seed: number
  readonly sequencesRun: number
  readonly totalEdits: number
  readonly totalReferencesChecked: number
  readonly orphanedReferences: number
  readonly orphaningRate: number
  readonly danglingTargets: number
}
```

- [ ] **Step 6: Write the failing generator test**

Create `tests/bench/fuzz-repo.test.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { generateChainRepo } from '../../bench/fuzz-repo.js'
import { loadCodeindexConfig } from '../../src/config.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'

const tempDirs: string[] = []

const makeDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-fuzzrepo-'))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('generateChainRepo', () => {
  test('writes a chain of modules that index with resolved cross-file references', async () => {
    const dir = makeDir()
    const model = generateChainRepo(dir, 4)
    expect(model.files.length).toBe(4)
    expect(existsSync(path.join(dir, '.codeindex.json'))).toBe(true)
    expect(existsSync(path.join(dir, 'src', 'mod0.ts'))).toBe(true)

    const config = await loadCodeindexConfig({ configPath: path.join(dir, '.codeindex.json'), repoRoot: dir })
    const summary = await indexCodebase({ config, mode: 'full' })
    expect(summary.filesIndexed).toBe(4)
    // A 4-module chain has 3 cross-file references (mod1->mod0, mod2->mod1, mod3->mod2), all resolvable.
    expect(summary.referencesIndexed).toBeGreaterThanOrEqual(3)
  })
})
```

- [ ] **Step 7: Run to verify generator test fails**

Run: `bun test tests/bench/fuzz-repo.test.ts` — FAIL (module missing).

- [ ] **Step 8: Implement the generator**

Create `bench/fuzz-repo.ts`. Each `mod{i}.ts` exports `sym{i}` (a function). For `i > 0`, it imports `sym{i-1}` from `./mod{i-1}.js` and calls it — creating a resolvable cross-file reference `mod{i} → mod{i-1}`.

```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { RepoFile, RepoModel } from './edit-fuzz-types.js'

const moduleSource = (index: number): string => {
  if (index === 0) {
    return `export const sym0 = (): number => 0\n`
  }
  const previous = index - 1
  return (
    `import { sym${previous} } from './mod${previous}.js'\n` +
    `export const sym${index} = (): number => sym${previous}() + ${index}\n`
  )
}

export const generateChainRepo = (dir: string, fileCount: number): RepoModel => {
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
  const files: RepoFile[] = []
  for (let index = 0; index < fileCount; index += 1) {
    writeFileSync(path.join(dir, 'src', `mod${index}.ts`), moduleSource(index))
    files.push({ name: `mod${index}`, symbol: `sym${index}` })
  }
  return { dir, files }
}
```

- [ ] **Step 9: Run to verify generator passes**

Run: `bun test tests/bench/fuzz-repo.test.ts` — PASS (indexes 4 files, ≥3 resolved refs).

- [ ] **Step 10: Gates + commit**

Run: `bun run format && bun run lint && bun run typecheck && bun run format:check` — PASS.

```bash
git add bench/fuzz-rng.ts bench/fuzz-repo.ts bench/edit-fuzz-types.ts tests/bench/fuzz-rng.test.ts tests/bench/fuzz-repo.test.ts
git commit -m "feat(bench): add seeded PRNG and chain-repo generator for the edit fuzzer"
```

---

### Task 2: Edit operations

**Files:**
- Create: `bench/fuzz-ops.ts`
- Test: `tests/bench/fuzz-ops.test.ts`

**Interfaces:**
- Consumes: `Rng`/`pick`/`randomInt` from `bench/fuzz-rng.ts`; `RepoModel`/`RepoFile`/`FuzzOperation` from `bench/edit-fuzz-types.ts`.
- Produces: `applyRandomEdit(rng: Rng, model: RepoModel): { operation: FuzzOperation; model: RepoModel }` — mutates a file on disk in `model.dir` and returns the operation description + the updated model. The four kinds:
  - `rename-symbol`: rewrite `mod{i}.ts` renaming `sym{i}` to `sym{i}_r` in its declaration (importers keep the old name → breaks incoming refs).
  - `rename-file`: `fs.rename` `mod{i}.ts` → `mod{i}_moved.ts` (importers keep `./mod{i}.js` → broken specifier).
  - `delete-file`: `rmSync` `mod{i}.ts`.
  - `edit-content`: append `export const extra{i}_{n} = (): number => {i}\n` (perturbs the file hash, no break).

- [ ] **Step 1: Write the failing test**

Create `tests/bench/fuzz-ops.test.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { generateChainRepo } from '../../bench/fuzz-repo.js'
import { createRng } from '../../bench/fuzz-rng.js'
import { applyRandomEdit } from '../../bench/fuzz-ops.js'

const tempDirs: string[] = []

const makeRepo = (): ReturnType<typeof generateChainRepo> => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-fuzzops-'))
  tempDirs.push(dir)
  return generateChainRepo(dir, 5)
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('applyRandomEdit', () => {
  test('is deterministic for a given seed (same op + same disk change)', () => {
    const modelA = makeRepo()
    const modelB = makeRepo()
    const a = applyRandomEdit(createRng(123), modelA)
    const b = applyRandomEdit(createRng(123), modelB)
    expect(a.operation.kind).toBe(b.operation.kind)
    expect(a.operation.target).toBe(b.operation.target)
  })

  test('a rename-file operation removes the old file from disk', () => {
    const model = makeRepo()
    // Drive a known op by constructing an rng seed that yields rename-file, OR test each op via a helper.
    // Here: apply several edits and assert the on-disk state stays consistent with the returned model.
    let current = model
    const rng = createRng(55)
    for (let index = 0; index < 4; index += 1) {
      const result = applyRandomEdit(rng, current)
      current = result.model
    }
    // Every file the model still lists must exist on disk; nothing the model dropped should remain.
    for (const file of current.files) {
      expect(existsSync(path.join(current.dir, 'src', `${file.name}.ts`))).toBe(true)
    }
    expect(readFileSync(path.join(current.dir, 'src', 'mod0.ts'), 'utf8').length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/bench/fuzz-ops.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement the operations**

Create `bench/fuzz-ops.ts`. Keep each op a small pure-ish function that performs the disk mutation and returns the new `RepoModel`. `applyRandomEdit` picks a target file + an op kind via the rng. Guidance:
- Track a per-model edit counter isn't needed; derive uniqueness for `edit-content` from the file's current source length or the rng.
- `rename-symbol`: read the file, replace the declaration `const sym{i} =` with `const sym{i}_r =` (and update the model's `symbol`); importers are NOT touched (that's the break). Also update any self-reference within the file if present.
- `rename-file`: `renameSync` the `.ts` file to `${name}_moved.ts`, update the model file's `name`.
- `delete-file`: `rmSync` the file, drop it from the model's files list. Avoid deleting `mod0.ts` if it would empty the repo — guard so at least one file always remains (pick from files with length > 1, or skip delete when only one file remains, substituting `edit-content`).
- `edit-content`: append a new `export const` line, no model change to name/symbol.

Provide explicit return types; no `any`; no optional chaining; guard all indexed access (`noUncheckedIndexedAccess`). If the file grows large, split helpers per op. The implementer should design the exact code to satisfy the test's determinism + on-disk-consistency assertions; the RED→GREEN loop drives correctness.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/bench/fuzz-ops.test.ts` — PASS.

- [ ] **Step 5: Gates + commit**

Run: `bun run format && bun run lint && bun run typecheck && bun run format:check` — PASS.

```bash
git add bench/fuzz-ops.ts tests/bench/fuzz-ops.test.ts
git commit -m "feat(bench): add fuzz edit operations (rename/move/delete/edit)"
```

---

### Task 3: Measurement function — the differential orphaning oracle

**Files:**
- Create: `bench/edit-fuzz.ts`
- Test: `tests/bench/edit-fuzz.test.ts` (the fixed-seed property + invariant test — the plan's core assertion)

**Interfaces:**
- Consumes: `generateChainRepo`, `applyRandomEdit`, `createRng`, the types; `loadCodeindexConfig`/`indexCodebase`; `openDatabase`.
- Produces: `runEditFuzz(input: Readonly<{ dir: string; seed: number; fileCount: number; sequenceCount: number; editsPerSequence: number }>): FuzzReport`; helpers `readReferenceState(db): Map<string, boolean>` (key → resolved) and `countDanglingTargets(db): number`.

**The differential oracle** (per sequence): generate a fresh chain repo in a subdir; index it `full` once; apply `editsPerSequence` random edits, reindexing `incremental` after each; then build a SECOND config for the same repo dir but a DIFFERENT `dbPath` (`.codeindex/full.db`) and index it `mode: 'full'` (fresh DB) = ground truth. Diff: for every reference key that is RESOLVED in the full DB, if the incremental DB has it unresolved or missing → orphaned.

- [ ] **Step 1: Write the failing test (fixed seed, invariants + finite rate)**

Create `tests/bench/edit-fuzz.test.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runEditFuzz } from '../../bench/edit-fuzz.js'

const tempDirs: string[] = []

const makeDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-editfuzz-'))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('runEditFuzz', () => {
  test('is deterministic and produces a finite orphaning rate in [0,1]', async () => {
    const a = await runEditFuzz({ dir: makeDir(), seed: 2026, fileCount: 5, sequenceCount: 3, editsPerSequence: 3 })
    const b = await runEditFuzz({ dir: makeDir(), seed: 2026, fileCount: 5, sequenceCount: 3, editsPerSequence: 3 })
    expect(a.orphanedReferences).toBe(b.orphanedReferences)
    expect(a.orphaningRate).toBeGreaterThanOrEqual(0)
    expect(a.orphaningRate).toBeLessThanOrEqual(1)
    expect(a.totalReferencesChecked).toBeGreaterThan(0)
  })

  test('INVARIANT: no dangling FK — every non-null target_symbol_id references a real symbol', async () => {
    const report = await runEditFuzz({ dir: makeDir(), seed: 77, fileCount: 6, sequenceCount: 4, editsPerSequence: 4 })
    expect(report.danglingTargets).toBe(0)
  })
})
```

Note: the "1-hop re-resolution" invariant is asserted by a targeted scenario the implementer adds to this file (see Step 4): build a 3-module chain, edit the LAST module (`mod2`), reindex incremental, and assert the DIRECT dependent's reference (`mod2 → mod1`... i.e. the reference FROM the reprocessed direct-dependent) is resolved — the 1-hop case that must hold today. If constructing this deterministically is fragile, assert the weaker form: after editing a leaf module and reindexing incrementally, at least one cross-file reference remains resolved (the 1-hop links are not universally destroyed).

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/bench/edit-fuzz.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement the measurement function**

Create `bench/edit-fuzz.ts`. Key pieces (complete code for the DB-facing helpers; the sequence loop is assembled from Tasks 1-2):

```ts
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import type { Database } from 'bun:sqlite'

import { loadCodeindexConfig } from '../src/config.js'
import type { CodeindexConfig } from '../src/config.js'
import { indexCodebase } from '../src/indexer/index-codebase.js'
import { openDatabase } from '../src/storage/db.js'
import { applyRandomEdit } from './fuzz-ops.js'
import { createRng } from './fuzz-rng.js'
import { generateChainRepo } from './fuzz-repo.js'
import type { FuzzReport } from './edit-fuzz-types.js'

interface ReferenceRow {
  readonly source_qualified_name: string | null
  readonly target_name: string
  readonly target_module_specifier: string | null
  readonly edge_type: string
  readonly line_number: number
  readonly target_symbol_id: number | null
}

const referenceKey = (row: ReferenceRow): string =>
  `${row.source_qualified_name ?? ''}|${row.target_name}|${row.target_module_specifier ?? ''}|${row.edge_type}|${row.line_number}`

// Map of reference key -> whether it is resolved (target_symbol_id not null).
export const readReferenceState = (db: Database): Map<string, boolean> => {
  const rows = db
    .query<ReferenceRow, []>(
      `SELECT s.qualified_name AS source_qualified_name, r.target_name, r.target_module_specifier,
              r.edge_type, r.line_number, r.target_symbol_id
       FROM symbol_references r
       LEFT JOIN symbols s ON s.id = r.source_symbol_id`,
    )
    .all()
  const state = new Map<string, boolean>()
  for (const row of rows) {
    state.set(referenceKey(row), row.target_symbol_id !== null)
  }
  return state
}

export const countDanglingTargets = (db: Database): number => {
  const row = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM symbol_references
       WHERE target_symbol_id IS NOT NULL
         AND target_symbol_id NOT IN (SELECT id FROM symbols)`,
    )
    .get()
  return row === null ? 0 : row.n
}
```

Then `runEditFuzz` does, per sequence `seqIndex` in `[0, sequenceCount)`:
1. `const repoDir = path.join(input.dir, \`seq${seqIndex}\`); mkdirSync(repoDir, { recursive: true })`.
2. `const model = generateChainRepo(repoDir, input.fileCount)`.
3. `const config = await loadCodeindexConfig({ configPath: path.join(repoDir, '.codeindex.json'), repoRoot: repoDir })`.
4. `await indexCodebase({ config, mode: 'full' })` (initial).
5. `let current = model; const rng = createRng(input.seed + seqIndex)`. Loop `editsPerSequence` times: `const r = applyRandomEdit(rng, current); current = r.model; await indexCodebase({ config, mode: 'incremental' })`. Count edits.
6. Read incremental state: `const incDb = openDatabase(config.dbPath); const incState = readReferenceState(incDb); const dangling = countDanglingTargets(incDb); incDb.close()`.
7. Ground truth: build a full-reindex config for the SAME repo but a different dbPath: `const fullConfig: CodeindexConfig = { ...config, dbPath: path.join(repoDir, '.codeindex', 'full.db') }`. `await indexCodebase({ config: fullConfig, mode: 'full' })`. `const fullDb = openDatabase(fullConfig.dbPath); const fullState = readReferenceState(fullDb); fullDb.close()`.
8. Diff: for each `[key, resolved]` in `fullState` where `resolved === true`: increment `checked`; if `incState.get(key) !== true` → increment `orphaned`.
9. Accumulate `dangling` into a total.

Return `{ seed: input.seed, sequencesRun: input.sequenceCount, totalEdits, totalReferencesChecked: checked, orphanedReferences: orphaned, orphaningRate: checked === 0 ? 0 : orphaned / checked, danglingTargets: totalDangling }`.

Note: `runEditFuzz` is `async` (indexCodebase is async) — the test calls it without await? NO — the test above calls it synchronously. FIX: make `runEditFuzz` return `Promise<FuzzReport>` and `await` it in the test (update the Step 1 test to `async` + `await`). Adjust the test's two cases to `async () => { const a = await runEditFuzz(...) }`. (Author the test with `await` from the start — the Step 1 snippet omits it for brevity; the implementer MUST make both the function and its test properly async.)

If `edit-fuzz.ts` approaches 300 lines, keep the DB helpers here and move the per-sequence runner into a helper or a second file (`bench/edit-fuzz-sequence.ts`).

- [ ] **Step 4: Add the 1-hop re-resolution invariant assertion**

Add a third test to `tests/bench/edit-fuzz.test.ts` that builds a small chain via `generateChainRepo`, indexes full, edits ONLY the leaf module's content (via a direct `writeFileSync` or one `edit-content` op), reindexes incremental, opens the DB, and asserts a DIRECT dependent's reference is still resolved (the 1-hop case). Use `readReferenceState` to find a resolved cross-file reference after the incremental reindex. Keep it deterministic. (If a precise 1-hop assertion proves fragile, assert the weaker "≥1 cross-file reference remains resolved after an incremental edit," which still guards against total-collapse regressions — note which you used.)

- [ ] **Step 5: Run to verify it passes**

Run: `bun test tests/bench/edit-fuzz.test.ts` — PASS. The orphaning rate may be 0 for tiny/short sequences (2-hop chains not always exercised) or positive — both are valid; the test asserts finiteness + invariants, NOT a specific rate.

- [ ] **Step 6: Whole suite + gates + commit**

Run: `bun run format && bun test tests && bun run lint && bun run typecheck && bun run format:check` — all PASS.

```bash
git add bench/edit-fuzz.ts tests/bench/edit-fuzz.test.ts
git commit -m "feat(bench): add differential orphaning oracle for the edit fuzzer"
```

---

### Task 4: CLI runner + `bench:fuzz` script

**Files:**
- Create: `bench/edit-fuzz-run.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `runEditFuzz`.
- Produces: a `bench:fuzz` CLI printing a `FuzzReport` JSON.

- [ ] **Step 1: Implement the CLI runner**

Create `bench/edit-fuzz-run.ts` (mirrors `bench/index-bench-run.ts`'s arg-loop + `void main().catch(...)`). It creates its own temp working dir (via `mkdtempSync`), parses `--seed` / `--files` / `--sequences` / `--edits` (with defaults, e.g. seed 1, files 8, sequences 20, edits 6), runs `runEditFuzz`, prints `JSON.stringify(report, null, 2)`, and cleans up the temp dir in a `finally`.

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runEditFuzz } from './edit-fuzz.js'

interface FuzzArgs {
  readonly seed: number
  readonly files: number
  readonly sequences: number
  readonly edits: number
}

const parseArgs = (argv: readonly string[]): FuzzArgs => {
  let seed = 1
  let files = 8
  let sequences = 20
  let edits = 6
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--seed' && value !== undefined) {
      seed = Number.parseInt(value, 10)
      index += 1
    } else if (flag === '--files' && value !== undefined) {
      files = Number.parseInt(value, 10)
      index += 1
    } else if (flag === '--sequences' && value !== undefined) {
      sequences = Number.parseInt(value, 10)
      index += 1
    } else if (flag === '--edits' && value !== undefined) {
      edits = Number.parseInt(value, 10)
      index += 1
    }
  }
  return { seed, files, sequences, edits }
}

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-fuzz-run-'))
  try {
    const report = await runEditFuzz({
      dir,
      seed: args.seed,
      fileCount: args.files,
      sequenceCount: args.sequences,
      editsPerSequence: args.edits,
    })
    console.log(JSON.stringify(report, null, 2))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
```

- [ ] **Step 2: Add the script**

In `package.json`, after `bench:index:papai`, add:

```json
    "bench:fuzz": "bun run bench/edit-fuzz-run.ts",
```

- [ ] **Step 3: Smoke-run the fuzzer**

Run: `bun run bench:fuzz --files 8 --sequences 10 --edits 6`
Expected: prints a `FuzzReport` — `sequencesRun: 10`, non-zero `totalEdits`/`totalReferencesChecked`, `danglingTargets: 0`, and an `orphaningRate` in [0,1] (likely POSITIVE at this size — the multi-hop bug manifests on longer chains + more edits). Record the reported `orphaningRate` and `orphanedReferences` — this is the Phase 1 deliverable number.

- [ ] **Step 4: Whole suite + gates**

Run: `bun run format && bun test tests/bench && bun run lint && bun run typecheck && bun run format:check` — all PASS.

- [ ] **Step 5: Commit**

```bash
git add bench/edit-fuzz-run.ts package.json
git commit -m "feat(bench): add edit-fuzz CLI runner and bench:fuzz script"
```

- [ ] **Step 6: Record the number (documentation only)**

The `bench:fuzz` orphaning rate is the Phase 1 output that sizes the later freshness/identity work. Note the observed rate (from Step 3) in the PR description. `danglingTargets` must be 0 (a hard invariant — a nonzero value is a real bug, not the known orphaning). No regression gate is wired (the rate is a known-bug measurement, not a bar to clear); a baseline gate is deferred to the fix phase.

---

## Definition of done (this plan)

- A seeded, reproducible fuzzer generates chain repos, applies rename/move/delete/edit sequences with incremental reindex, and quantifies reference orphaning via an incremental-vs-full differential.
- `bun run bench:fuzz` prints a `FuzzReport` with a reproducible `orphaningRate` (the Phase 1 deliverable number) and `danglingTargets`.
- The fixed-seed test hard-asserts the two true-today invariants: **no dangling FK** (`danglingTargets === 0`) and **1-hop re-resolution holds**; the multi-hop orphaning rate is measured, not gated.
- `bun test tests`, `bun run lint`, `bun run typecheck`, `bun run format:check` all pass.

## Deferred to a later phase (do NOT do here)

- **Fixing** the multi-hop orphaning (transitive incremental dependents, or stable symbol identity so ids survive reprocessing) — the freshness/identity work this number sizes.
- A committed orphaning-rate regression baseline/gate — added when the fix phase establishes a target.
- Richer repo shapes (DAGs, re-exports, JSX) beyond the linear chain.
