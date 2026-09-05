# Phase 2 Slice 9 — Deferral-Pool Close-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Phase 2 deferral pool — atomic transactional indexing writes, CLI `index [path]`, oracle accessor-boundary agreement, `code_index` payload honesty, baseline corpus stamping, and every accumulated hygiene minor — so the Phase 3 precondition is satisfied.

**Architecture:** Unit 1 wraps the entire index write phase (persist → references → prune → in-degree → provenance) in one explicit transaction with rollback-on-failure and hoists prepared statements out of hot loops (today: re-prepare + implicit commit per row; index-codebase.ts:200 × ~105k rows on papai). Unit 2 wires the CLI's ignored positional arg into `loadConfigForPath`. Unit 3 adds accessors to the oracle's `nearestNamedBoundary` (Slice 5a constructor precedent). Units 4-5 are payload honesty, baseline `repoHead` stamping with drift warnings, and the hygiene-minor disposition table from the spec.

**Tech Stack:** Bun, TypeScript, SQLite (bun:sqlite), web-tree-sitter, TypeScript compiler API (oracle), oxlint/oxfmt.

**Spec:** `docs/superpowers/specs/2026-09-05-phase2-slice9-deferral-pool-closeout-design.md`

## Global Constraints

- **No SCHEMA_VERSION bump** — no unit changes table shape. U4 adds a zod output field (protocol-level); U5 stamping adds a baseline-JSON field (schema-validated, not DDL).
- Gates: all existing bench gates flat-or-better under the **like-for-like protocol** (measure pre-slice and post-slice against the same repo commit; if the target repo moved, isolate with a worktree at the pre-slice commit exactly as Slice 8 Task 4 did). U1 must show a material indexing speedup on `bench/index-bench-run.ts` (`filesPerSecond`/`referencesPerSecond` recorded in the ledger). U3 must yield papai `falsePositiveRate` 0 like-for-like with no FN regression beyond the attribution shift.
- TDD RED→GREEN for every behavioral change: the failing test is written and observed failing before the implementation. Comment-only changes and missing-coverage pins are exempt (marked as such in their tasks).
- Baselines regenerate ONLY in the final task. Intermediate tasks must not write baseline files.
- After each task: `bun run lint && bun run typecheck && bun run format:check` clean, targeted tests green. Full `bun run check` only in the final task.
- Conventional commits: `perf(indexer): …`, `feat(cli): …`, `fix(bench): …`, `feat(mcp): …`, `fix(search): …`, `chore(slice9): …`.
- Line budgets: `src/indexer/index-codebase.ts` 297/300, `src/storage/queries.ts` 298/300, `src/search/exact.ts` 128/300, `src/search/fts.ts` 99/300 — index-codebase.ts and queries.ts are TIGHT; the plan's U1 additions are sized to fit, and the standing remedy applies (extract a helper file if a task trips `max-lines` or `max-lines-per-function` (50), note it in the ledger, do not restructure further).
- `pruneDeletedFiles`/`findDependentsOfDeletedFiles` callers and tests exist outside the indexer (tests/storage/, tests/index-codebase.test.ts) — Task 1's rename steps include a grep for stragglers; the implementer must update every call site the grep finds, not only the ones listed.

---

### Task 1: Atomic transactional writes + statement hoisting

**Files:**
- Modify: `src/indexer/index-codebase.ts` (transaction wrapper; reference-insert hoist; `skippedFilesTotal` NOT in this task — Task 4 owns it)
- Modify: `src/indexer/resolve-files.ts` (`resolveFilesToProcess` returns `prunablePaths` instead of pruning)
- Modify: `src/storage/queries.ts` (`pruneDeletedFiles` → `pruneFilePaths`; `findDependentsOfDeletedFiles` signature; loop hoists in `persistSymbols`/`persistAliases`/`persistModuleExports`)
- Test: `tests/indexer/index-atomicity.test.ts` (new, self-contained)

**Interfaces:**
- Consumes: `runIndexPhases` (index-codebase.ts:243-282) — the write section is lines 260-271, all synchronous DB work; `resolveFilesToProcess` (resolve-files.ts:46-71) currently calls `pruneDeletedFiles` at line 62 (OUTSIDE any transaction — this is the atomicity hole); `pruneDeletedFiles` (queries.ts:20-34) and `findDependentsOfDeletedFiles` (queries.ts:36-70) both re-query all stored paths.
- Produces: `resolveFilesToProcess` returns `Readonly<{ filesToProcess; prunablePaths: readonly string[]; filesSkipped }>`; `pruneFilePaths(db, filePaths: readonly string[]): number`; `findDependentsOfDeletedFiles(db, prunablePaths: readonly string[]): ReadonlySet<string>` (the `discoveredPaths` parameter is removed — prunable paths already encode it). A failed `indexCodebase` now throws AND leaves the database byte-identical to its pre-run state.

- [ ] **Step 1: Write the failing rollback test**

Create `tests/indexer/index-atomicity.test.ts`:

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { loadCodeindexConfig } from '../../src/config.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import { openDatabase } from '../../src/storage/db.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) {
    Bun.spawnSync(['rm', '-rf', dir])
  }
  dirs.length = 0
})

const makeFixture = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-atomic-'))
  dirs.push(dir)
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
  writeFileSync(path.join(dir, 'src/a.ts'), "import { helper } from './b'\nexport const alpha = helper()\n")
  writeFileSync(path.join(dir, 'src/b.ts'), 'export function helper(): number {\n  return 1\n}\n')
  return dir
}

const snapshot = (dbPath: string): { files: number; symbols: number; references: number; aliases: number; hash: string | null } => {
  const db = openDatabase(dbPath)
  try {
    const counts = db
      .query<{ files: number; symbols: number; references: number; aliases: number }, []>(
        `SELECT (SELECT COUNT(*) FROM files) AS files,
                (SELECT COUNT(*) FROM symbols) AS symbols,
                (SELECT COUNT(*) FROM symbol_references) AS references,
                (SELECT COUNT(*) FROM module_aliases) AS aliases`,
      )
      .get()!
    const hash = db.query<{ file_hash: string }, [string]>('SELECT file_hash FROM files WHERE file_path = ?').get('src/a.ts')?.file_hash ?? null
    return { ...counts, hash }
  } finally {
    db.close()
  }
}

describe('indexCodebase atomicity', () => {
  test('a mid-run failure rolls back — the previous index stays byte-intact', async () => {
    const dir = makeFixture()
    const config = await loadCodeindexConfig({ configPath: path.join(dir, '.codeindex.json'), repoRoot: dir })
    await indexCodebase({ config, mode: 'full' })
    const before = snapshot(config.dbPath)

    writeFileSync(path.join(dir, 'src/a.ts'), "import { helper } from './b'\nexport const alpha = helper() + 1\n")
    await expect(
      indexCodebase({
        config,
        mode: 'incremental',
        onPhase: (phase) => {
          if (phase === 'resolve') throw new Error('boom')
        },
      }),
    ).rejects.toThrow('boom')

    expect(snapshot(config.dbPath)).toEqual(before)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/indexer/index-atomicity.test.ts`
Expected: FAIL — today the write phase persists per statement, so the `resolve`-phase throw leaves `src/a.ts` re-persisted (new hash, new symbols, cleared-and-rebuilt aliases) and the snapshot comparison fails. All pre-existing tests stay green.

- [ ] **Step 3: Implement the transaction + hoists**

`src/indexer/resolve-files.ts` — replace `resolveFilesToProcess` (lines 46-71) and re-shape `findDependentsOfDeletedFiles` usage:

```ts
export const resolveFilesToProcess = async (
  db: Database,
  config: CodeindexConfig,
  mode: 'full' | 'incremental',
): Promise<
  Readonly<{ filesToProcess: readonly DiscoveredFile[]; prunablePaths: readonly string[]; filesSkipped: readonly string[] }>
> => {
  const { files: discoveredFiles, skippedFiles } = await discoverSourceFiles({
    repoRoot: config.repoRoot,
    roots: config.roots,
    exclude: config.exclude,
    languages: config.languages,
    maxFileSizeBytes: config.maxFileSizeBytes,
  })
  const discoveredPathSet = new Set(discoveredFiles.map((f) => f.relativePath))
  const storedPaths = db
    .query<{ file_path: string }, []>('SELECT file_path FROM files')
    .all()
    .map((row) => row.file_path)
  const prunablePaths = storedPaths.filter((filePath) => !discoveredPathSet.has(filePath))
  const deletedFileDependents = mode === 'incremental' ? findDependentsOfDeletedFiles(db, prunablePaths) : null
  const baseIncrementalSet = mode === 'incremental' ? await findIncrementalFileSet(db, discoveredFiles) : null
  const incrementalSet =
    baseIncrementalSet !== null && deletedFileDependents !== null
      ? new Set([...baseIncrementalSet, ...deletedFileDependents])
      : baseIncrementalSet
  const filesToProcess =
    incrementalSet === null ? discoveredFiles : discoveredFiles.filter((file) => incrementalSet.has(file.relativePath))
  return { filesToProcess, prunablePaths, filesSkipped: skippedFiles }
}
```

`src/storage/queries.ts` — replace `pruneDeletedFiles` (lines 20-34) and `findDependentsOfDeletedFiles` (lines 36-70):

```ts
export const pruneFilePaths = (db: Database, filePaths: readonly string[]): number => {
  let pruned = 0
  for (const filePath of filePaths) {
    db.query('DELETE FROM files WHERE file_path = ?').run(filePath)
    pruned += 1
  }
  return pruned
}
```

```ts
export const findDependentsOfDeletedFiles = (
  db: Database,
  prunablePaths: readonly string[],
): ReadonlySet<string> => {
  const dependents = new Set<string>()

  for (const filePath of prunablePaths) {
    const rows = db
      .query<{ file_path: string }, [string]>(
        `SELECT DISTINCT source_files.file_path
         FROM symbol_references
         JOIN files AS source_files ON source_files.id = symbol_references.source_file_id
         JOIN files AS target_files ON target_files.file_path = ?
         LEFT JOIN symbols AS target_symbols ON target_symbols.id = symbol_references.target_symbol_id
         WHERE target_symbols.file_id = target_files.id
            OR symbol_references.target_file_id = target_files.id`,
      )
      .all(filePath)

    for (const row of rows) {
      dependents.add(row.file_path)
    }
  }

  return dependents
}
```

Note the dependents set no longer filters by `discoveredPaths` — the filter moves to the `prunablePaths` computation, which is the same predicate computed once. `dependents` may now contain prunable paths themselves (harmless: they were never in the incremental candidate set).

`src/indexer/index-codebase.ts` — restructure `runIndexPhases` (lines 243-282). The discover destructure becomes `const { filesToProcess, prunablePaths, filesSkipped } = ...`, and the write section (lines 260-271) becomes:

```ts
  mark = Date.now()
  db.exec('BEGIN')
  try {
    const { filesIndexed, filesFailed, symbolsIndexed, parsedFiles } = applyProcessedFiles(db, processedFiles)
    emitPhase(input.onPhase, 'persist', mark)

    mark = Date.now()
    const { referencesIndexed, referencesUnresolved } = persistResolvedReferences(db, parsedFiles)
    backfillSymbolInDegree(db)
    emitPhase(input.onPhase, 'resolve', mark)

    mark = Date.now()
    const filesPruned = pruneFilePaths(db, prunablePaths)
    stampIndexProvenance(db, input.config)
    emitPhase(input.onPhase, 'provenance', mark)

    db.exec('COMMIT')
    return { filesIndexed, filesFailed, filesPruned, skippedFiles: filesSkipped, symbolsIndexed, referencesIndexed, referencesUnresolved }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
```

Import updates: `src/indexer/index-codebase.ts` ADDS `pruneFilePaths` to its `../storage/queries.js` import block (prune now happens inside the transaction there); `src/indexer/resolve-files.ts` DROPS `pruneDeletedFiles` from its import (line 6 keeps only `findDependentsOfDeletedFiles`). `ensureSchema`, `resolveFilesToProcess`, and the parse phase stay OUTSIDE the transaction (parse is async and does no DB writes).

Statement hoists (mechanical, no behavior change):
- `persistResolvedReferences` (index-codebase.ts:177-221): hoist the INSERT above the outer loop:

```ts
  const insertReference = db.query(
    'INSERT INTO symbol_references (source_symbol_id, source_file_id, target_symbol_id, target_file_id, target_name, target_export_name, target_module_specifier, edge_type, confidence, line_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
```

and replace the per-row `db.query(...).run(...)` with `insertReference.run(...)`.
- `persistSymbols` (queries.ts:128-165), `persistAliases` (queries.ts:117-126), `persistModuleExports` (queries.ts:204-222): hoist each function's `db.query(...)` out of its `for` loop into a local `const stmt = db.query(...)` before the loop; replace per-iteration `db.query(...).run(...)` with `stmt.run(...)`.

- [ ] **Step 4: Update call sites and tests of the renamed helpers**

Run: `rg -n "pruneDeletedFiles|findDependentsOfDeletedFiles" src/ tests/`
Every hit outside `src/storage/queries.ts` must be updated: `findDependentsOfDeletedFiles(db, discoveredPathSet)` callers pass `prunablePaths` instead; tests calling `pruneDeletedFiles` use `pruneFilePaths` with an explicit path array; tests of `findDependentsOfDeletedFiles` drop the discovered-set argument (its no-longer-present filtering is asserted via `prunablePaths` content instead).

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/indexer/ && bun test tests/storage/ && bun test tests/index-codebase.test.ts`
Expected: PASS — the atomicity test green, all pre-existing indexer/storage tests green after the mechanical signature updates.

- [ ] **Step 6: Lint, typecheck, format**

Run: `bun run lint && bun run typecheck && bun run format:check`
Expected: all clean; index-codebase.ts ≤ 300 lines, queries.ts ≤ 300 lines.

- [ ] **Step 7: Measure the speedup (recording only — no baseline writes)**

Run: `bun run bench/index-bench-run.ts`
Record `filesPerSecond` and `referencesPerSecond` in the task report (compare with the committed `bench/index-baseline.json` values). Do NOT pass `--update-baseline`.

- [ ] **Step 8: Commit**

```bash
git add src/indexer/index-codebase.ts src/indexer/resolve-files.ts src/storage/queries.ts tests/indexer/index-atomicity.test.ts
git commit -m "perf(indexer): atomic transactional write phase with hoisted statements"
```

---

### Task 2: CLI `index [path]`

**Files:**
- Modify: `src/cli.ts:99-106` (`main` — wire `rawArg` into `loadConfigForPath` for `index`/`reindex`)
- Test: `tests/cli.test.ts` (append)

**Interfaces:**
- Consumes: `loadConfigForPath(targetPath?: string)` (cli.ts:20-26, already resolves + loads the target's `.codeindex.json`) and `resolveRepoRoot` (cli.ts:15-18). Both are exported and tested.
- Produces: `codeindex index <path>` / `codeindex reindex <path>` index the given directory using that directory's config; no argument = cwd (byte-identical). `search`/`symbol`/`impact` keep consuming `rawArg` as their query.

- [ ] **Step 1: Write the failing tests**

Append inside the existing top-level `describe` of `tests/cli.test.ts` (after the last test, before the closing `})`):

```ts
  test('index resolves a positional path to that repo and its config', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-cli-path-'))
    dirs.push(dir)
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
    writeFileSync(path.join(dir, 'src/mod.ts'), 'export const marker = 1\n')

    const result = Bun.spawnSync(['bun', path.resolve(import.meta.dir, '../src/cli.ts'), 'index', dir], {
      cwd: import.meta.dir,
    })
    expect(result.exitCode).toBe(0)

    const db = openDatabase(path.join(dir, '.codeindex', 'index.db'))
    try {
      const row = db.query<{ files: number }, []>('SELECT COUNT(*) AS files FROM files WHERE parse_status = ?').get('indexed')
      expect(row?.files).toBe(1)
    } finally {
      db.close()
    }
  })

  test('reindex also honors the positional path', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-cli-reindex-'))
    dirs.push(dir)
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
    writeFileSync(path.join(dir, 'src/mod.ts'), 'export const marker = 1\n')
    Bun.spawnSync(['bun', path.resolve(import.meta.dir, '../src/cli.ts'), 'index', dir], { cwd: import.meta.dir })

    const result = Bun.spawnSync(['bun', path.resolve(import.meta.dir, '../src/cli.ts'), 'reindex', dir], {
      cwd: import.meta.dir,
    })
    expect(result.exitCode).toBe(0)
  })
```

The file's existing helpers: `tests/cli.test.ts` already imports `loadConfigForPath`/`resolveRepoRoot`; add `mkdtempSync, writeFileSync, mkdirSync` from `node:fs`, `tmpdir` from `node:os`, `path` from `node:path`, an `openDatabase` import from `../src/storage/db.js`, and a module-level `const dirs: string[]` with an `afterEach` cleanup loop (mirror tests/indexer/index-atomicity.test.ts from Task 1 if present, else the pattern above).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cli.test.ts`
Expected: the two new tests FAIL — today `index <path>` ignores the positional arg and indexes the test's cwd (`import.meta.dir` = tests/), so no `.codeindex/index.db` appears in the fixture dir and exit codes/config differ. Pre-existing cli tests stay green.

- [ ] **Step 3: Implement**

`src/cli.ts` — `main` (lines 99-106) becomes:

```ts
const main = async (): Promise<void> => {
  const [, , command = 'index', rawArg] = process.argv
  const positional = command === 'index' || command === 'reindex' ? rawArg : undefined
  const config = await loadConfigForPath(positional)
```

The `switch` bodies are unchanged (`index`/`reindex` already use `config`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli.test.ts`
Expected: PASS — both new tests green, pre-existing tests green.

- [ ] **Step 5: Lint, typecheck, format**

Run: `bun run lint && bun run typecheck && bun run format:check`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat(cli): index and reindex accept a target repo path"
```

---

### Task 3: Oracle accessor-boundary agreement

**Files:**
- Modify: `bench/impact-oracle.ts:175-190` (`nearestNamedBoundary` gains accessor boundaries)
- Test: `tests/bench/impact-oracle.test.ts` (append after the constructor pin, line 423)

**Interfaces:**
- Consumes: `nearestNamedBoundary` (impact-oracle.ts:175-190) — the walk already returns MethodDeclaration/ClassDeclaration/ConstructorDeclaration/named-var boundaries; `ts.isGetAccessorDeclaration`/`ts.isSetAccessorDeclaration` are the accessor predicates.
- Produces: references inside `get x()`/`set x(v)` attribute to the accessor symbol (e.g. `src/widget#Widget>value`), matching the indexer's symbol rows (papai evidence: `src/chat/router#ChatRouter>capabilities`). Oracle trueRef sets shift for accessor-internal references — baselines regenerate in the final task only.

- [ ] **Step 1: Write the failing test**

In `tests/bench/impact-oracle.test.ts`, insert after the constructor pin test (ends line 423):

```ts
  test('a call inside a getter attributes to Class>getter, not the class (Slice 9)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-oracle-getter-'))
    dirs.push(dir)
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, 'src/dep.ts'), 'export function makeThing(): number {\n  return 1\n}\n')
    writeFileSync(
      path.join(dir, 'src/widget.ts'),
      "import { makeThing } from './dep'\nexport class Widget {\n  private thing = 0\n  get value(): number {\n    return this.thing + makeThing()\n  }\n}\n",
    )
    writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { module: 'esnext', moduleResolution: 'bundler', strict: true },
        include: ['src'],
      }),
    )
    writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
    const config = await loadCodeindexConfig({ configPath: path.join(dir, '.codeindex.json'), repoRoot: dir })
    await indexCodebase({ config, mode: 'full' })
    const db = openDatabase(config.dbPath)
    try {
      const oracle = buildReferenceOracle(db, { repoRoot: dir, tsconfigPath: path.join(dir, 'tsconfig.json') })
      const makeThing = oracle.find((t) => t.target.endsWith('#makeThing'))
      const sources = makeThing!.trueSources.map((s) => s.name)
      expect(sources).toContain('src/widget#Widget>value')
      expect(sources).not.toContain('src/widget#Widget')
    } finally {
      db.close()
    }
  })
```

All imports/helpers (`mkdtempSync`, `dirs`, `loadCodeindexConfig`, `indexCodebase`, `openDatabase`, `buildReferenceOracle`) already exist in this file (the constructor pin at line 394 uses them identically).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bench/impact-oracle.test.ts`
Expected: the new test FAILS — today the walk skips the accessor and attributes `makeThing()` to `src/widget#Widget` (the class). The constructor pin (line 394) and all other oracle tests stay green.

- [ ] **Step 3: Implement**

`bench/impact-oracle.ts` — in `nearestNamedBoundary` (lines 175-190), add the accessor boundary after the constructor line (line 183):

```ts
    // An accessor body is its own symbol row (`Class>getter`) on the indexer side, same rule as
    // constructors: a reference inside `get x()` belongs to the accessor, not the class.
    if (ts.isGetAccessorDeclaration(a) || ts.isSetAccessorDeclaration(a)) return a
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/bench/`
Expected: PASS — new test green; all pre-existing bench tests green (the oracle's own fixtures contain no accessors).

- [ ] **Step 5: Lint, typecheck, format**

Run: `bun run lint && bun run typecheck && bun run format:check`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add bench/impact-oracle.ts tests/bench/impact-oracle.test.ts
git commit -m "fix(bench): oracle attributes accessor-internal references to the accessor symbol"
```

---

### Task 4: `code_index` payload honesty

**Files:**
- Modify: `src/indexer/index-codebase.ts:35-44,233-241,273-281` (`IndexSummary`/`IndexPhasesResult` gain `skippedFilesTotal`)
- Modify: `src/mcp/tools.ts:97-106` (`CodeIndexOutputSchema` gains `skippedFilesTotal`)
- Modify: `src/mcp/server.ts:90-99` (`registerIndexTool` — summaryText suffix + payload cap)
- Test: `tests/mcp.test.ts` or the mcp test file that exercises `code_index` (grep first: `rg -l "code_index" tests/`)

**Interfaces:**
- Consumes: `IndexSummary.skippedFiles` (index-codebase.ts:39) — the full skip list; `buildStructuredToolResult(schema, output, summaryText)` (tools.ts:108-118) parses the output against the schema.
- Produces: `IndexSummary.skippedFilesTotal: number` (equals `skippedFiles.length`); `CodeIndexOutputSchema` field `skippedFilesTotal: z.number()`; the MCP `code_index` structured payload caps `skippedFiles` at 20 entries while `skippedFilesTotal` carries the true count; the text channel reads `Indexed X files, Y symbols, Z references, N skipped` (suffix only when N > 0). CLI `logJson` output keeps the FULL list (the cap is MCP-payload-only).

- [ ] **Step 1: Write the failing tests**

In the mcp test file that exercises `code_index` (grep `rg -l "codeIndex|code_index" tests/` — `tests/mcp.test.ts` and/or `tests/mcp/`), append:

```ts
test('code_index caps skippedFiles in the payload and reports the total', async () => {
  const skipped = Array.from({ length: 25 }, (_, i) => `src/skip-${i}.ts`)
  const summary = {
    filesIndexed: 1,
    filesFailed: 0,
    filesPruned: 0,
    skippedFiles: skipped,
    skippedFilesTotal: 25,
    symbolsIndexed: 1,
    referencesIndexed: 0,
    referencesUnresolved: 0,
    elapsedMs: 1,
  }
  const deps = makeDepsWithIndexSummary(summary) // the file's existing deps-stub pattern
  const result = await callCodeIndexTool(deps, { mode: 'incremental' }) // the file's existing invocation helper
  expect(result.structuredContent.skippedFiles).toHaveLength(20)
  expect(result.structuredContent.skippedFilesTotal).toBe(25)
  expect(result.content[0]!.text).toContain(', 25 skipped')
})

test('code_index summaryText omits the skipped suffix when nothing is skipped', async () => {
  const summary = {
    filesIndexed: 3,
    filesFailed: 0,
    filesPruned: 0,
    skippedFiles: [],
    skippedFilesTotal: 0,
    symbolsIndexed: 10,
    referencesIndexed: 5,
    referencesUnresolved: 0,
    elapsedMs: 1,
  }
  const deps = makeDepsWithIndexSummary(summary)
  const result = await callCodeIndexTool(deps, { mode: 'incremental' })
  expect(result.content[0]!.text).toBe('Indexed 3 files, 10 symbols, 5 references')
})
```

Adapt `makeDepsWithIndexSummary`/`callCodeIndexTool` to the file's existing stub/invocation pattern for `code_index` — every mcp test file stubs `CodeindexToolDeps`; mirror how the existing `code_index` test (if any) or the `code_search` tests build deps and invoke the registered handler. If no `code_index` invocation helper exists, create one following the `code_search` stub shape: `createCodeindexServer({ ...deps })` is NOT needed — call the handler through the server's registered tool or extract; the existing tests show the established way (read them first).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/mcp.test.ts tests/mcp/`
Expected: FAIL — `skippedFilesTotal` is not in `IndexSummary`/schema (type error and/or schema parse strips/fails), and the text channel has no skipped suffix. Pre-existing mcp tests stay green.

- [ ] **Step 3: Implement**

`src/indexer/index-codebase.ts` — add `readonly skippedFilesTotal: number` to `IndexSummary` (after line 39) and to `IndexPhasesResult` (after line 237); in `runIndexPhases`'s return add `skippedFilesTotal: filesSkipped.length`.

`src/mcp/tools.ts` — `CodeIndexOutputSchema` gains `skippedFilesTotal: z.number()` after `skippedFiles` (line 101).

`src/mcp/server.ts` — `registerIndexTool` (lines 90-99) becomes:

```ts
    async ({ mode }: CodeIndexInput) => {
      const summary = await deps.codeIndex({ mode })
      const skippedSuffix = summary.skippedFilesTotal > 0 ? `, ${summary.skippedFilesTotal} skipped` : ''
      const summaryText = `Indexed ${summary.filesIndexed} files, ${summary.symbolsIndexed} symbols, ${summary.referencesIndexed} references${skippedSuffix}`
      const payload = { ...summary, skippedFiles: summary.skippedFiles.slice(0, 20) }
      return buildStructuredToolResult(CodeIndexOutputSchema, payload, summaryText)
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/mcp.test.ts tests/mcp/ && bun test tests/indexer/`
Expected: PASS — new tests green, pre-existing green.

- [ ] **Step 5: Lint, typecheck, format**

Run: `bun run lint && bun run typecheck && bun run format:check`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/indexer/index-codebase.ts src/mcp/tools.ts src/mcp/server.ts tests/
git commit -m "feat(mcp): code_index reports skipped-file truth with a capped payload"
```

---

### Task 5: Baseline corpus stamping (`repoHead`) + drift warning

**Files:**
- Create: `bench/git-stamp.ts` (`readRepoHead` + `warnOnCorpusDrift`)
- Modify: `bench/run.ts` (stamp on write; warn on compare), `bench/impact-run.ts` (same), `bench/index-bench-run.ts` (same)
- Modify: the zod baseline schemas: `BaselineMetricsSchema` (bench/run.ts:14-19), `ImpactBaselineSchema` (bench/impact-types.ts), `IndexBaselineCountsSchema` (bench/index-bench-run.ts:11+) — each gains `repoHead: z.string().nullable().optional()`
- Test: `tests/bench/git-stamp.test.ts` (new)

**Interfaces:**
- Consumes: `readGitInfo(repoRoot)` (src/indexer/git-info.ts:19-25) — returns `{ commit: string | null, branch: string | null }`, null on non-git dirs.
- Produces: `readRepoHead(repoRoot: string): string | null`; `warnOnCorpusDrift(baselineRepoHead: string | null | undefined, currentRepoHead: string | null, label: string): void` — prints a loud `console.error` WARNING when they differ (including when the baseline lacks a stamp). Every baseline JSON written hereafter carries `repoHead`; every compare path warns on mismatch. Spec §9: non-git targets stamp `null` and never fail.

- [ ] **Step 1: Write the failing tests**

Create `tests/bench/git-stamp.test.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, spyOn, test } from 'bun:test'

import { readRepoHead, warnOnCorpusDrift } from '../../bench/git-stamp.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) {
    Bun.spawnSync(['rm', '-rf', dir])
  }
  dirs.length = 0
})

describe('readRepoHead', () => {
  test('returns the commit sha in a git repo', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-stamp-'))
    dirs.push(dir)
    Bun.spawnSync(['git', 'init'], { cwd: dir })
    Bun.spawnSync(['git', 'config', 'user.email', 't@t'], { cwd: dir })
    Bun.spawnSync(['git', 'config', 'user.name', 't'], { cwd: dir })
    writeStampFile(dir)
    Bun.spawnSync(['git', 'add', '-A'], { cwd: dir })
    Bun.spawnSync(['git', 'commit', '-m', 'init'], { cwd: dir })
    const head = readRepoHead(dir)
    expect(head).toMatch(/^[0-9a-f]{40}$/)
  })

  test('returns null outside a git repo', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-stamp-nogit-'))
    dirs.push(dir)
    expect(readRepoHead(dir)).toBeNull()
  })
})

describe('warnOnCorpusDrift', () => {
  test('warns when the baseline stamp differs from the current head', () => {
    const errSpy = spyOn(console, 'error')
    try {
      warnOnCorpusDrift('aaaa', 'bbbb', 'IR')
      expect(errSpy).toHaveBeenCalled()
      const output = errSpy.mock.calls.map((call) => call.join(' ')).join('\n')
      expect(output).toContain('corpus drift')
      expect(output).toContain('IR')
    } finally {
      errSpy.mockRestore()
    }
  })

  test('warns when the baseline has no stamp (legacy file)', () => {
    const errSpy = spyOn(console, 'error')
    try {
      warnOnCorpusDrift(undefined, 'bbbb', 'impact')
      const output = errSpy.mock.calls.map((call) => call.join(' ')).join('\n')
      expect(output).toContain('corpus drift')
    } finally {
      errSpy.mockRestore()
    }
  })

  test('stays silent when the stamps match', () => {
    const errSpy = spyOn(console, 'error')
    try {
      warnOnCorpusDrift('aaaa', 'aaaa', 'IR')
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })
})
```

with a local helper (the git-init test needs a tracked file to commit):

```ts
const writeStampFile = (dir: string): void => {
  writeFileSync(path.join(dir, 'file.txt'), 'x\n')
}
```

plus `writeFileSync` in the `node:fs` import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/bench/git-stamp.test.ts`
Expected: FAIL — `bench/git-stamp.ts` does not exist (import error).

- [ ] **Step 3: Implement**

Create `bench/git-stamp.ts`:

```ts
import { readGitInfo } from '../src/indexer/git-info.js'

export const readRepoHead = (repoRoot: string): string | null => readGitInfo(repoRoot).commit

// A baseline measured against corpus A gates a run against corpus B only by luck. The stamp makes
// the drift loud instead of silent (Slice 8 hit this twice: papai moved mid-slice and the
// committed baselines stopped being reproducible). Missing stamp (legacy baseline) also warns.
export const warnOnCorpusDrift = (
  baselineRepoHead: string | null | undefined,
  currentRepoHead: string | null,
  label: string,
): void => {
  if (baselineRepoHead === currentRepoHead) return
  console.error(
    `WARNING (${label}): baseline corpus drift — baseline stamped ${baselineRepoHead ?? 'nothing'}, current repo HEAD ${currentRepoHead ?? 'unknown'}; the gate comparison is not like-for-like.`,
  )
}
```

`bench/run.ts` — in `main`, after `const args = parseArgs(...)`:

```ts
  const repoHead = readRepoHead(args.repo)
```

In the update branch (line 82-86), stamp: `toBaselineMetrics` gains `repoHead` (add the field in the object it returns at lines 57-62: `repoHead`); write path unchanged. In the compare branch (line 88-103), after parsing the baseline: `warnOnCorpusDrift(baseline.repoHead, repoHead, 'IR search')`. Import `readRepoHead, warnOnCorpusDrift` from `./git-stamp.js`. `BaselineMetricsSchema` (lines 14-19) gains `repoHead: z.string().nullable().optional()`.

`bench/impact-run.ts` — same shape: `const repoHead = readRepoHead(args.repo)` in `main`; `toBaseline` (lines 52-60) gains `repoHead`; `compareAgainstBaseline` (lines 64-83) takes `repoHead` as a parameter and calls `warnOnCorpusDrift(baseline.repoHead, repoHead, 'code_impact')` after parsing (update its call site at line 116); `ImpactBaselineSchema` (bench/impact-types.ts) gains the optional field.

`bench/index-bench-run.ts` — same shape: stamp in `toBaselineCounts` (line 51), warn after parsing the baseline in the compare branch; `IndexBaselineCountsSchema` gains the optional field.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/bench/`
Expected: PASS — git-stamp tests green; all pre-existing bench tests green (the schema field is optional, so existing baseline fixtures parse unchanged).

- [ ] **Step 5: Lint, typecheck, format**

Run: `bun run lint && bun run typecheck && bun run format:check`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add bench/git-stamp.ts bench/run.ts bench/impact-run.ts bench/index-bench-run.ts bench/impact-types.ts tests/bench/git-stamp.test.ts
git commit -m "fix(bench): stamp baselines with repoHead and warn on corpus drift"
```

---

### Task 6: exact.ts hygiene — eqNoCase hoist, short-query prefix guard, LIKE pins

**Files:**
- Modify: `src/search/exact.ts:33,47-85,87-121` (hoist query lowercase; length-guard the file_path arm)
- Test: `tests/search/exact.test.ts` (append)

**Interfaces:**
- Consumes: `mapExactRow` (exact.ts:47-85) calls `eqNoCase` up to 4× per row, lowercasing the query each time; `loadExactResults` (exact.ts:87-121) binds `query` five times — the fifth feeds the file_path `LIKE ? ESCAPE '\'` prefix arm (line 117).
- Produces: identical matchReason/confidence behavior for queries ≥ 3 chars (IR fence: baselines flat); queries shorter than 3 chars no longer return file-path-only matches (the `exact file_path` noise class for 1-2 char queries is gone); `escapeLikePattern` (exact.ts:35) behavior unchanged and now pinned.

- [ ] **Step 1: Write the failing tests**

Append inside the existing top-level `describe` of `tests/search/exact.test.ts` (mirror the file's existing DB-fixture setup for these — read the top of the file first; it already has an in-memory fixture builder used by the pinned tests at lines 171 and 217):

```ts
  test('queries shorter than 3 chars do not hit the file_path prefix arm', () => {
    // fixture contains a file whose path starts with the same letter(s)
    const results = runExactSearch(db, 'a', 10, {})
    expect(results.every((r) => r.matchReason !== 'exact file_path')).toBe(true)
  })

  test('queries of 3+ chars still match file paths', () => {
    const results = runExactSearch(db, 'ap', 10, {}) // adjust prefix to the fixture's real file name
    expect(results.some((r) => r.matchReason === 'exact file_path')).toBe(true)
  })

  test('underscore in the query does not wildcard-match other characters', () => {
    const results = runExactSearch(db, 'my_symbol', 10, {})
    expect(results.every((r) => !r.filePath.includes('myXsymbol'))).toBe(true)
  })

  test('backslash in the query does not act as an escape or wildcard', () => {
    const results = runExactSearch(db, 'a\\b', 10, {})
    expect(results.every((r) => !r.filePath.includes('aXb'))).toBe(true)
  })
```

Adjust the fixture assertions to the file's actual fixture symbols/paths — read tests/search/exact.test.ts's existing fixture (the pinned tests at 171/217 show the exact symbols and file names available) and pick a query that genuinely matches the fixture file path prefix for the 3+ chars test (e.g. if the fixture file is `src/service.ts`, use `'ser'`). The 1-char and escape tests assert absence, so they need no fixture change unless the fixture path starts with the query letter — verify and adjust the query letter to one that prefix-matches nothing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/search/exact.test.ts`
Expected: the short-query test FAILS (1-char query currently returns `exact file_path` rows); the escape-pin tests likely PASS pre-change (they pin existing `escapeLikePattern` behavior — record their pre-change state; they are pins, not discriminating REDs). The 3+ chars test likely PASSES pre-change (pin). Pre-existing tests (including the `exact file_path` pin at line 217) stay green — verify its query is ≥ 3 chars.

- [ ] **Step 3: Implement**

`src/search/exact.ts` — delete `eqNoCase` (line 33) and rewrite `mapExactRow`'s matchReason (lines 74-81) with a hoisted lowercase:

```ts
const mapExactRow = (
  row: { /* unchanged row shape */ },
  query: string,
): SearchResult => {
  const queryLower = query.toLowerCase()
  return {
    /* unchanged fields until matchReason */
    matchReason:
      row.matched_export_name !== null && row.matched_export_name.toLowerCase() === queryLower
        ? 'exact export_names'
        : row.qualified_name.toLowerCase() === queryLower
          ? 'exact qualified_name'
          : row.local_name.toLowerCase() === queryLower
            ? 'exact local_name'
            : 'exact file_path',
    /* confidence, snippet, inDegree unchanged */
  }
}
```

Keep the full row type and remaining fields verbatim — only the matchReason expression and the hoisted `queryLower` change.

`loadExactResults` — the SQL's file_path arm becomes guarded, and the bind list gains one `query`:

```ts
      `SELECT symbols.symbol_key, symbols.qualified_name, symbols.local_name, symbols.kind, symbols.scope_tier,
            symbols.file_path, symbols.start_line, symbols.end_line, symbols.export_names,
            symbols.in_degree AS in_degree,
            symbols.signature_text, symbols.body_text,
            module_exports.export_name AS matched_export_name
     FROM symbols
     LEFT JOIN module_exports ON module_exports.symbol_id = symbols.id AND module_exports.export_name = ?
     WHERE symbols.local_name = ?
        OR symbols.qualified_name = ?
        OR module_exports.export_name = ?
        OR (length(?) >= 3 AND symbols.file_path LIKE ? ESCAPE '\\')
     LIMIT ?`,
```

with `.all(query, query, query, query, query, `${escapeLikePattern(query)}%`, limit)` (six `query` binds + limit).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/search/`
Expected: PASS — new tests green (the escape pins green as pins), pre-existing exact/fts/rank tests green.

- [ ] **Step 5: Lint, typecheck, format**

Run: `bun run lint && bun run typecheck && bun run format:check`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/search/exact.ts tests/search/exact.test.ts
git commit -m "fix(search): hoist exact-tier query lowercase, guard short-query prefix arm, pin LIKE escaping"
```

---

### Task 7: Small behavior fixes — matchReason, tokenizer, discover diagnostic

**Files:**
- Modify: `src/search/fts.ts:86` (matchReason string gains signature_text)
- Modify: `src/indexer/extract-symbols.ts:53-59` (`normalizeIdentifierTerms` splits trailing-s acronyms)
- Modify: `src/indexer/discover.ts:30-36` (`readGitignore` warns when the file exists but is unreadable)
- Test: `tests/search/fts.test.ts` (matchReason pin), `tests/extract-symbols.test.ts` (tokenizer), `tests/discover.test.ts` (diagnostic)

**Interfaces:**
- Consumes: `normalizeIdentifierTerms` (extract-symbols.ts:53-59) feeds `identifier_terms` (extract-symbols.ts:128) → the FTS `identifier_terms` column (weight 10.0 in the bm25 vector, schema.ts:105). Changing it changes stored FTS content → the final task's reindex + IR gate absorbs it (expected flat-or-better: queries like `id` gain exact-token matches from `IDs` symbols).
- Produces: `'IDs' → 'id s'`, `'URLs' → 'url s'`; plain camel/snake unchanged; an unreadable `.gitignore` (exists but EACCES/EISDIR) prints a `console.error` diagnostic and proceeds without rules; a missing `.gitignore` stays silent.

- [ ] **Step 1: Write the failing tests**

`tests/extract-symbols.test.ts` — `normalizeIdentifierTerms` is exported; append a describe (or extend the existing one if present):

```ts
describe('normalizeIdentifierTerms', () => {
  test('splits a trailing-s acronym into its stem and the plural marker', () => {
    expect(normalizeIdentifierTerms('IDs')).toBe('id s')
    expect(normalizeIdentifierTerms('URLs')).toBe('url s')
  })

  test('leaves non-plural names unchanged', () => {
    expect(normalizeIdentifierTerms('getUser')).toBe('get user')
    expect(normalizeIdentifierTerms('APIKeys')).toBe('api keys')
    expect(normalizeIdentifierTerms('getUsers')).toBe('get users')
  })
})
```

(Import `normalizeIdentifierTerms` from `../src/indexer/extract-symbols.js`; adapt to the file's existing import style.)

`tests/discover.test.ts` — append (mirror the file's existing fixture pattern for `discoverSourceFiles`):

```ts
  test('an unreadable .gitignore warns but discovery proceeds', async () => {
    const dir = makeGitignoreFixtureDir() // the file's existing temp-dir helper
    mkdirSync(path.join(dir, '.gitignore')) // a DIRECTORY — readFile throws EISDIR
    const errSpy = spyOn(console, 'error')
    try {
      const { files } = await discoverSourceFiles({
        repoRoot: dir,
        roots: ['src'],
        exclude: [],
        languages: ['ts'],
        maxFileSizeBytes: 1_000_000,
      })
      expect(files.length).toBeGreaterThan(0)
      const output = errSpy.mock.calls.map((call) => call.join(' ')).join('\n')
      expect(output).toContain('.gitignore')
    } finally {
      errSpy.mockRestore()
    }
  })
```

(Adapt helper names to the file's existing pattern — read its first fixture test first. `mkdirSync` on an existing `.gitignore` path as directory is deterministic cross-platform; `chmod 000` is not.)

`tests/search/fts.test.ts` — if it pins the matchReason string, update the pin to the new value; if not, add:

```ts
  test('fts matchReason names the searched columns', () => {
    // existing fixture search, then:
    expect(results[0]!.matchReason).toBe('fts identifier_terms/signature_text/doc_text/body_text')
  })
```

using whatever fixture search call the file already performs (read the file; reuse its first test's setup).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/extract-symbols.test.ts tests/discover.test.ts tests/search/fts.test.ts`
Expected: tokenizer tests FAIL (`'IDs'` currently yields `'ids'`); the discover diagnostic test FAILS (currently silent); the matchReason pin FAILS if asserted against the new string (it currently reads `'fts identifier_terms/doc_text/body_text'`). Pre-existing tests stay green.

- [ ] **Step 3: Implement**

`src/indexer/extract-symbols.ts` — `normalizeIdentifierTerms` (lines 53-59) gains one rule before the acronym split:

```ts
export const normalizeIdentifierTerms = (name: string): string =>
  name
    .replace(/([A-Z])s$/, '$1 s')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim()
```

`src/search/fts.ts` — line 86:

```ts
      matchReason: 'fts identifier_terms/signature_text/doc_text/body_text',
```

`src/indexer/discover.ts` — `readGitignore` (lines 30-36):

```ts
const readGitignore = async (repoRoot: string): Promise<string> => {
  try {
    return await readFile(path.join(repoRoot, '.gitignore'), 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return ''
    }
    console.error(
      `codeindex: .gitignore exists but could not be read (${error instanceof Error ? error.message : String(error)}) — proceeding without ignore rules`,
    )
    return ''
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/extract-symbols.test.ts tests/discover.test.ts tests/search/`
Expected: PASS — all green (any other test indexing content with trailing-s acronyms re-runs through the new tokenizer — verify none asserts the old `'ids'` form; update such a pin if the grep in Step 5 finds one and note it in the report).

- [ ] **Step 5: Check for tokenizer-content pins**

Run: `rg -n "identifierTerms|identifier_terms" tests/ | rg -v "fts.test|extract-symbols.test"`
Update any assertion that pins the old tokenization of trailing-s acronyms; record each change in the report.

- [ ] **Step 6: Lint, typecheck, format**

Run: `bun run lint && bun run typecheck && bun run format:check`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add src/search/fts.ts src/indexer/extract-symbols.ts src/indexer/discover.ts tests/
git commit -m "fix(search): accurate fts matchReason, plural-acronym tokens, gitignore read diagnostic"
```

---

### Task 8: Test rides + NOCASE investigation (Slice 6/7/8 deferred tests)

**Files:**
- Modify: `tests/resolver/resolve-references.test.ts` (#1 kind table, #5 multi-star pin, #6 namespace pin, #3 alias-form link)
- Modify: `tests/bench/impact-ast.test.ts` (#11 classifyShape row)
- Modify: `src/resolver/resolve-references.ts` (#4 one comment sentence — comment-only, no RED)

**Interfaces:**
- Consumes: the existing same-module type_refs test shape (S8: `resolveReferenceCandidates({ symbols: [{ id, qualifiedName, localName, moduleKey, exportNames, kind }], moduleAliases: [], files: [], references: [...], currentModuleKey })`); the Slice 7 Task 4 star/namespace tests in the same file (READ the file's star and namespace tests first — mirror their exact input shapes); `classifyShape` signature `(node, position?, checker?)` per its existing data table (tests/bench/impact-oracle.test.ts:116-237) and `shapeLabelForPosition` (bench/impact-ast.ts).
- Produces: kind-filter coverage over all five `TYPE_SHAPED_KINDS`; the star first-hit-wins and namespace parent-level paths pinned; the alias-form re-export link pinned end-to-end; the #14 NOCASE investigation disposition recorded in the task report.

- [ ] **Step 1: #1 — kind table test (may PASS pre-change; it is a coverage pin)**

Append to `tests/resolver/resolve-references.test.ts` (inside the top-level `describe`, mirroring the S8 same-module test verbatim except `kind`):

```ts
  test.each(['interface_declaration', 'type_alias_declaration', 'enum_declaration', 'class_declaration', 'abstract_class_declaration'])(
    'same-module type ref binds to a %s (B7 kind filter, per-kind pin)',
    (kind) => {
      const resolved = resolveReferenceCandidates({
        symbols: [
          { id: 1, qualifiedName: 'src/mod#Task', localName: 'Task', moduleKey: 'src/mod', exportNames: [], kind },
        ],
        moduleAliases: [],
        files: [],
        references: [
          {
            sourceQualifiedName: 'src/mod#process',
            edgeType: 'type_refs',
            targetName: 'Task',
            targetExportName: null,
            targetModuleSpecifier: null,
            lineNumber: 2,
          },
        ],
        currentModuleKey: 'src/mod',
      })
      expect(resolved[0]).toMatchObject({ targetSymbolId: 1, confidence: 'name_only' })
    },
  )
```

Run: `bun test tests/resolver/resolve-references.test.ts` — Expected: PASS (the filter logic is tested; this pins each kind).

- [ ] **Step 2: #5 multi-star first-hit-wins + #6 namespace parent-level (coverage pins)**

Read the existing star-reexport and namespace tests in this file (Slice 7 Task 4 added them). Write two variants:
- multi-star: two star sources (`moduleExports` with two `export_kind: 'star'` rows targeting different modules) — assert the FIRST source's fileId wins (`targetFileId` equals the first module's id, not the second's).
- namespace parent-level: mirror the existing namespace test but exercise the parent-level path (a namespace import whose edge resolves at the file's top level rather than nested) — assert the same resolved shape as the sibling test with the parent-level input.
Run: `bun test tests/resolver/resolve-references.test.ts` — Expected: PASS both (pins of shipped behavior; record pre-change state — if either FAILS, that is a REAL bug: stop, report BLOCKED with the failing case).

- [ ] **Step 3: #3 alias-form re-export link (end-to-end pin, may PASS pre-change)**

Append to `tests/resolver/resolve-references.test.ts` OR — if the B4 chain is exercised only through the indexer — `tests/index-codebase.test.ts` (grep `rg -n "reexports" tests/` to find where the B4 chain tests live; mirror that file's fixture pattern):

```ts
  test('import-then-export alias form links y back to the original symbol (Residue #7 pin)', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        { id: 1, qualifiedName: 'src/a#x', localName: 'x', moduleKey: 'src/a', exportNames: ['x'] },
      ],
      moduleAliases: [],
      files: [{ id: 10, moduleKey: 'src/b' }],
      moduleExports: [
        // b.ts: import { x } from './a'; export { x as y } — a named re-export row with no
        // symbol of its own; the B4 chain must link it through b's imports to src/a#x.
        { exportName: 'y', exportKind: 'named', symbolId: null, targetModuleSpecifier: null },
      ],
      references: [
        {
          sourceQualifiedName: null,
          edgeType: 'reexports',
          targetName: 'x',
          targetExportName: 'y',
          targetModuleSpecifier: null,
          lineNumber: 2,
        },
      ],
      currentModuleKey: 'src/b',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: 1, targetFileId: null, confidence: 'resolved' })
  })
```

CRITICAL: verify the exact `ModuleExportSummary`/reexports-row field names against the resolver's types before running (`rg -n "exportKind|targetExportName" src/resolver/resolve-references.ts src/types.ts`) — adapt field names, not semantics. If the shipped B4 behavior differs from this assertion, STOP and report BLOCKED with the actual shape (do not bend the test to the code without understanding).

- [ ] **Step 4: #4 buildReexportResolver comment (comment-only)**

Run: `rg -n "buildReexportResolver" src/resolver/resolve-references.ts`
Add one sentence to the function's leading comment: "A dead-end named row (its own symbol/specifier resolved to nothing) still shadows star sources below it — named rows win by design, even when they link to nothing." No test, no RED (comment-only change per Global Constraints).

- [ ] **Step 5: #11 classifyShape type-position row**

In `tests/bench/impact-ast.test.ts`, extend (or add a sibling describe to) the existing tests:

```ts
describe('classifyShape (type-position direct unit)', () => {
  test('a bare type-annotation identifier classifies as bare-value before the position relabel', () => {
    // build a source with `const x: Task = load()` via the file's parser fixture pattern,
    // find the type_identifier node for Task, and assert:
    expect(classifyShape(node, 'value', checker)).toBe('bare-value')
  })
})
```

Read `tests/bench/impact-oracle.test.ts:116-237`'s table pattern first — it shows exactly how classifyShape is invoked with nodes + checker. Mirror that helper; add the type-annotation case if (and only if) the table lacks it — grep the table for an annotation-position identifier row first. If the table already covers it, record that in the report and skip (the S6 item is then already satisfied).

- [ ] **Step 6: #14 NOCASE JOIN row-multiplication investigation (timeboxed 30 min)**

Concrete procedure:
1. Build a fixture (in-memory DB via the tests/storage pattern) with one symbol exported twice via `module_exports` under different names (e.g. `x` and `y` both pointing at `src/a#x`), both matching a case-variant query (`X`).
2. Run `loadExactResults`-equivalent (`runExactSearch(db, 'X', 10, {})`) and count rows for the same `symbol_key`.
3. Decision rule: if one symbol appears more than once AND a contained fix (dedupe by `symbol_key` keeping the highest-confidence row in `loadExactResults`'s `.map`, before `applyFilters`) leaves `tests/search/` green and keeps `LIMIT` semantics sane (dedupe AFTER limit can underfill — if so, prefer a SQL-side `GROUP BY symbols.id` with `MAX(module_exports.export_name)`), implement it with a RED→GREEN test; otherwise write the finding into the task report and the ledger (documented class, not fixed).
Run: `bun test tests/search/` — Expected: green either way (fix landed, or investigation documented).

- [ ] **Step 7: Lint, typecheck, format, full targeted suites**

Run: `bun run lint && bun run typecheck && bun run format:check && bun test tests/resolver/ tests/bench/ tests/search/ tests/index-codebase.test.ts`
Expected: all clean and green.

- [ ] **Step 8: Commit**

```bash
git add tests/ src/resolver/resolve-references.ts src/search/exact.ts
git commit -m "test(resolver): pool ride-along pins — per-kind filter, star order, alias link, namespace path"
```

---

### Task 9: Reindex, baselines with stamps, like-for-like gates, ledger

**Files:**
- Modify: `bench/baseline.json`, `bench/baseline.papai.json`, `bench/impact-baseline.json`, `bench/impact-baseline.papai.json`, `bench/impact-baseline.fixture.json`, `bench/index-baseline.json` (regenerated, now stamped)
- Modify: `.superpowers/sdd/progress.md` (slice completion entry — controller-owned; implementers do NOT touch it)

**Interfaces:**
- Consumes: Tasks 1-8. Baselines now carry `repoHead`; runners warn on drift (Task 5).

- [ ] **Step 1: Record pre-slice like-for-like references (worktree isolation)**

Before regenerating anything: record the current papai HEAD (`git -C ../papai rev-parse HEAD`). Then create a worktree at this slice's base commit and run the pre-slice pipeline against today's papai (impact-run and bench-run reindex the repo themselves — index-codebase.ts is invoked by both):

```bash
git -C ../papai rev-parse HEAD
git worktree add /Users/ki/Projects/yourpapai/codeindex-slicebase <BASE_SHA>
ln -s /Users/ki/Projects/yourpapai/codeindex/node_modules /Users/ki/Projects/yourpapai/codeindex-slicebase/node_modules
(cd /Users/ki/Projects/yourpapai/codeindex-slicebase && bun run bench/impact-run.ts --repo ../papai --max-targets 300)
(cd /Users/ki/Projects/yourpapai/codeindex-slicebase && bun run bench/run.ts --repo ../papai --corpus bench/corpus/papai.json)
git worktree remove --force /Users/ki/Projects/yourpapai/codeindex-slicebase
```

Record: valueFNR, FP rate, typeFNR, MRR, P@k. These are the pre-slice numbers for the like-for-like comparison in Step 4. (`<BASE_SHA>` = the commit this slice started from.)

- [ ] **Step 2: Reindex both repos and measure U1's speedup**

```bash
(cd ../papai && bun /Users/ki/Projects/yourpapai/codeindex/src/cli.ts index)
bun run start index
```

Record the papai full-index `elapsedMs` against Task 1's recorded pre-slice index-bench numbers and the same measurement from the worktree run in Step 1 (the worktree reindex IS the pre-slice timing — record both).

- [ ] **Step 3: Regenerate all six baselines at HEAD**

```bash
bun run bench --baseline bench/baseline.json --update-baseline
bun run bench/run.ts --repo ../papai --corpus bench/corpus/papai.json --baseline bench/baseline.papai.json --update-baseline
bun run bench/impact-run.ts --baseline bench/impact-baseline.json --update-baseline
bun run bench/impact-run.ts --repo ../papai --max-targets 300 --baseline bench/impact-baseline.papai.json --update-baseline
bun run bench/impact-run.ts --repo bench/fixtures/impact-demo --baseline bench/impact-baseline.fixture.json --update-baseline
bun run bench/index-bench-run.ts --baseline bench/index-baseline.json --update-baseline
```

Expected: all exit 0; every written baseline JSON now contains a `repoHead` field; `git status` shows only the six baseline JSONs modified.

- [ ] **Step 4: Verify the gates like-for-like**

Compare the Step 2/3 HEAD numbers against the Step 1 pre-slice numbers (same papai corpus):
- papai FP rate: 0 like-for-like (U3's accessor fix should remove the residual FP when the target is sampled; the corpus may not sample it — record either way)
- papai valueFNR: flat-or-better; typeFNR: 0 held
- papai IR MRR + P@k: up-or-flat (the tokenizer change may shift FTS ranking — if a metric REGRESSES, STOP and surface; like Slice 8, isolate drift before concluding)
- self IR: flat; self impact: flat-or-better
- index-bench: material speedup recorded (this is the one gate expected to MOVE, upward)
- The drift warning fires during Step 1's compare runs if the corpus moved — expected, informational.

- [ ] **Step 5: Full gate**

Run: `bun run check`
Expected: EXIT 0 — lint 0/0, typecheck clean, format clean, full suite green, all four `check:bench` commands green against the fresh stamped baselines (no drift warnings — baselines just regenerated at the same HEAD).

- [ ] **Step 6: Controller ledger entry + commit**

The controller appends the Slice 9 completion entry to `.superpowers/sdd/progress.md`: code range, per-task commits, measured speedup (files/s + references/s + papai elapsedMs before/after), gate statuses like-for-like, the #14 investigation disposition, and the pool-closure statement (every historical minor now fixed or dispositioned per the spec's §7 table). Then:

```bash
git add -A
git commit -m "chore(slice9): regenerate stamped baselines, verify pool-closeout gates green"
```

---

## Self-Review Notes

- **Spec coverage:** U1 → Task 1; U2 → Task 2; U3 → Task 3; U4 → Task 4; U5 stamping → Task 5; U5 #7/#8/#10 → Task 6; U5 #9/#12/#13 → Task 7; U5 #1/#3/#4/#5/#6/#11/#14 → Task 8; final gates + ledger → Task 9. U5 #15 (stay-left items) requires no task — dispositioned in the spec's table, restated in the ledger entry. Navigation: out of scope per spec §1.
- **Type consistency:** `prunablePaths` (Task 1) flows resolve-files → index-codebase → `pruneFilePaths`; `skippedFilesTotal` (Task 4) flows IndexSummary → schema → server; `repoHead` (Task 5) flows readRepoHead → toBaseline* → schema → warnOnCorpusDrift. Task 6's guarded SQL has seven placeholders (4× query + LIKE pattern + limit) and the `.all()` list supplies exactly seven args.
- **Pre-existing test compatibility:** `ImpactBaselineSchema`/`BaselineMetricsSchema`/`IndexBaselineCountsSchema` gain OPTIONAL fields (existing fixtures parse unchanged). `exact.test.ts:217`'s `exact file_path` pin uses a ≥3-char query (verify during Task 6; adjust the fixture note if not). The tokenizer change may affect any test pinning `identifier_terms` content — Task 7 Step 5 greps for stragglers. `findDependentsOfDeletedFiles`/`pruneDeletedFiles` renames ripple to tests — Task 1 Step 4 greps and updates.
- **Known judgment calls (for the reviewer):** Task 8's star/namespace/alias tests are coverage pins (may pass pre-change) — the plan says so explicitly and defines the BLOCKED protocol if a pin unexpectedly fails (that would be a real shipped-behavior bug). Task 1's rollback test discriminates via the `onPhase('resolve')` throw — the only mid-transaction injection point that needs no mock and no DB corruption.
