# Phase 1 · IR Evaluation Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `bench/` evaluation harness that runs a labeled golden-query corpus through codeindex's real search/impact functions and reports precision@k, recall@k, and MRR — wired as a deterministic baseline-regression gate.

**Architecture:** A small set of pure, focused modules under `bench/`: metric functions, a zod-validated corpus loader, a scorer that dispatches each query to `searchSymbols` (find-symbol / nl-intent) or `findIncomingReferences` (who-uses), a baseline comparator, and a thin CLI runner that indexes a repo, scores the corpus, and fails on regression. Unit tests seed an in-memory SQLite DB (mirroring existing test style); one integration test indexes a throwaway repo end-to-end.

**Tech Stack:** Bun, `bun:sqlite`, `bun:test`, zod v4, TypeScript (strict, NodeNext-style `.js` import specifiers), oxlint + oxfmt.

## Context: where this sits

This is **Plan 1 of the Phase 1 harness set** defined in
`docs/superpowers/specs/2026-07-20-codeindex-roadmap-design.md`. Phase 1's other instruments —
query logging/observability, protocol-boundary tests, the edit-sequence fuzzer, the indexing
benchmark, and the `busy_timeout` + provenance ride-alongs — are **separate plans** and are **out of
scope here**. This plan delivers the IR-relevance backbone: the gate every later change is measured
against. The corpus is seed-only in this plan; mining real logged queries into it is a later plan
(it depends on query logging).

## Global Constraints

Every task's requirements implicitly include this section. Values copied from the repo:

- **Runtime/tests:** Bun. Tests use `bun:test` (`import { describe, expect, test } from 'bun:test'`), run via `bun test tests`.
- **Imports:** ESM only. **All import specifiers must end in `.js`** (`import/extensions: ["error","always"]`), including local ones. Cross-dir imports from `bench/` into source use `../src/...js`.
- **Type-only imports** must use `import type` (`verbatimModuleSyntax: true`).
- **No optional chaining** anywhere (`oxc/no-optional-chaining: error`) — use explicit `!== undefined` / `!== null` checks.
- **No barrel files** (`oxc/no-barrel-file: error`) — do not create an index re-export file under `bench/`.
- **Explicit return types** on every function (`typescript/explicit-function-return-type` + `explicit-module-boundary-types`).
- **No `any`** (`typescript/no-explicit-any`). **No param reassignment** (`eslint/no-param-reassign`) — reassign locals only.
- **TS strictness:** `strict`, `noUncheckedIndexedAccess` (array access is `T | undefined` — guard it), `noUnusedLocals/Parameters`, `noPropertyAccessFromIndexSignature`.
- **Functional style** to match the codebase: exported `const` arrow functions, `readonly` fields, no classes.
- **Lint/format/typecheck gates:** `bun run lint` (oxlint, `denyWarnings`), `bun run typecheck` (tsgo), `bun run format:check` (oxfmt) must all pass. `bench/` must be added to the tsconfig `include` and the lint/format globs (Task 1).
- **Auto-format before every commit:** after writing/editing any file, run `bun run format` (oxfmt write) so hand-copied code matches oxfmt output — otherwise `format:check` fails. This applies to every task below even where a step doesn't restate it.
- **qualifiedName format:** `` `${moduleKey}#${localName}` `` where `moduleKey` is the POSIX, extension-stripped path relative to repo root. Example: `searchSymbols` in `src/search/index.ts` → `src/search/index#searchSymbols`.

---

## File Structure

Created by this plan:

- `bench/types.ts` — shared types: `GoldenQuery` union, `Corpus`, `CorpusReport`, `QueryScore`, `BaselineMetrics`. (Type declarations only — not a barrel.)
- `bench/metrics.ts` — pure metric functions: `precisionAtK`, `recallAtK`, `reciprocalRank`, `mean`.
- `bench/corpus.ts` — zod schema + `parseCorpus` / `loadCorpus`.
- `bench/harness.ts` — `scoreCorpus(db, corpus, k)`; dispatches per query kind to the real search/impact functions.
- `bench/baseline-compare.ts` — pure `compareToBaseline(report, baseline, tolerance)`.
- `bench/run.ts` — CLI runner: parse args → index repo → score → print → baseline gate.
- `bench/corpus/seed.json` — hand-authored golden corpus grounded in this repo's symbols.
- `bench/baseline.json` — generated baseline metrics (Task 7).
- `tests/bench/metrics.test.ts`, `tests/bench/corpus.test.ts`, `tests/bench/harness.test.ts`, `tests/bench/baseline-compare.test.ts`, `tests/bench/seed.test.ts`, `tests/bench/harness-integration.test.ts`.

Modified:

- `tsconfig.json` — add `bench/**/*.ts` to `include`.
- `package.json` — add `bench` + `bench:check` scripts; extend `lint`/`format`/`format:check` globs with `bench`.

---

### Task 1: Scaffold `bench/` into tooling + shared types

**Files:**
- Modify: `tsconfig.json:22`
- Modify: `package.json:8-11` (scripts)
- Create: `bench/types.ts`

**Interfaces:**
- Produces: the type vocabulary every later task imports — `GoldenQuery` (`FindQuery | WhoUsesQuery`), `Corpus`, `QueryScore`, `CorpusReport`, `BaselineMetrics`, `GoldenQueryKind`.

- [ ] **Step 1: Add `bench/` to the tsconfig include**

Change `tsconfig.json` line 22 from:

```json
  "include": ["src/**/*.ts", "tests/**/*.ts"]
```

to:

```json
  "include": ["src/**/*.ts", "tests/**/*.ts", "bench/**/*.ts"]
```

- [ ] **Step 2: Add scripts and extend lint/format globs in `package.json`**

Replace the `scripts` block (`package.json:5-14`) with:

```json
  "scripts": {
    "test": "bun test tests",
    "typecheck": "tsgo --project tsconfig.json --noEmit",
    "lint": "oxlint --config .oxlintrc.json src tests bench",
    "format": "oxfmt --write src tests bench --ignore-path=.oxfmtignore",
    "format:check": "oxfmt --check src tests bench --ignore-path=.oxfmtignore",
    "check": "bun run --parallel lint typecheck format:check test",
    "start": "bun run src/cli.ts",
    "mcp": "bun run src/cli.ts mcp",
    "bench": "bun run bench/run.ts",
    "bench:check": "bun run bench/run.ts --baseline bench/baseline.json"
  },
```

- [ ] **Step 3: Create the shared types**

Create `bench/types.ts`:

```ts
export type GoldenQueryKind = 'find-symbol' | 'nl-intent' | 'who-uses'

export interface FindQuery {
  readonly id: string
  readonly kind: 'find-symbol' | 'nl-intent'
  readonly query: string
  readonly relevant: readonly string[]
}

export interface WhoUsesQuery {
  readonly id: string
  readonly kind: 'who-uses'
  readonly target: string
  readonly relevant: readonly string[]
}

export type GoldenQuery = FindQuery | WhoUsesQuery

export interface Corpus {
  readonly name: string
  readonly queries: readonly GoldenQuery[]
}

export interface QueryScore {
  readonly id: string
  readonly kind: GoldenQueryKind
  readonly precisionAtK: number
  readonly recallAtK: number
  readonly reciprocalRank: number
  readonly retrieved: readonly string[]
  readonly relevant: readonly string[]
}

export interface CorpusReport {
  readonly k: number
  readonly queryCount: number
  readonly meanPrecisionAtK: number
  readonly meanRecallAtK: number
  readonly mrr: number
  readonly perQuery: readonly QueryScore[]
}

export interface BaselineMetrics {
  readonly k: number
  readonly meanPrecisionAtK: number
  readonly meanRecallAtK: number
  readonly mrr: number
}
```

- [ ] **Step 4: Verify tooling picks up `bench/`**

Run: `bun run format && bun run typecheck && bun run lint && bun run format:check`
Expected: all PASS with `bench/types.ts` now in scope (no "file not included" errors, no lint/format complaints).

- [ ] **Step 5: Commit**

```bash
git add tsconfig.json package.json bench/types.ts
git commit -m "chore(bench): scaffold bench/ tooling and shared harness types"
```

---

### Task 2: Metric functions

**Files:**
- Create: `bench/metrics.ts`
- Test: `tests/bench/metrics.test.ts`

**Interfaces:**
- Produces: `precisionAtK(retrieved: readonly string[], relevant: ReadonlySet<string>, k: number): number`, `recallAtK(...): number` (same params), `reciprocalRank(retrieved: readonly string[], relevant: ReadonlySet<string>): number`, `mean(values: readonly number[]): number`.
- Definitions: precision@k = |distinct relevant ids in top-k| / k. recall@k = |distinct relevant ids in top-k| / |relevant|. reciprocalRank = 1/(1-based rank of first relevant hit), else 0.

- [ ] **Step 1: Write the failing test**

Create `tests/bench/metrics.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

import { mean, precisionAtK, recallAtK, reciprocalRank } from '../../bench/metrics.js'

describe('precisionAtK', () => {
  test('counts distinct relevant hits in the top k over k', () => {
    expect(precisionAtK(['a', 'x', 'b', 'y'], new Set(['a', 'b']), 4)).toBe(0.5)
  })

  test('returns 0 when k is 0', () => {
    expect(precisionAtK(['a'], new Set(['a']), 0)).toBe(0)
  })
})

describe('recallAtK', () => {
  test('is the share of the relevant set found in the top k', () => {
    expect(recallAtK(['a', 'b', 'z'], new Set(['a', 'b', 'c']), 10)).toBeCloseTo(2 / 3)
  })

  test('returns 0 when the relevant set is empty', () => {
    expect(recallAtK(['a'], new Set<string>(), 10)).toBe(0)
  })
})

describe('reciprocalRank', () => {
  test('is 1 over the 1-based rank of the first relevant hit', () => {
    expect(reciprocalRank(['x', 'a', 'b'], new Set(['a']))).toBe(1 / 2)
  })

  test('returns 0 when no relevant item appears', () => {
    expect(reciprocalRank(['x', 'y'], new Set(['a']))).toBe(0)
  })
})

describe('mean', () => {
  test('averages the values', () => {
    expect(mean([1, 0, 0.5])).toBeCloseTo(0.5)
  })

  test('returns 0 for an empty list', () => {
    expect(mean([])).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bench/metrics.test.ts`
Expected: FAIL — cannot resolve `../../bench/metrics.js` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `bench/metrics.ts`:

```ts
export const precisionAtK = (retrieved: readonly string[], relevant: ReadonlySet<string>, k: number): number => {
  if (k <= 0) {
    return 0
  }
  const found = new Set<string>()
  for (const id of retrieved.slice(0, k)) {
    if (relevant.has(id)) {
      found.add(id)
    }
  }
  return found.size / k
}

export const recallAtK = (retrieved: readonly string[], relevant: ReadonlySet<string>, k: number): number => {
  if (relevant.size === 0) {
    return 0
  }
  const found = new Set<string>()
  for (const id of retrieved.slice(0, k)) {
    if (relevant.has(id)) {
      found.add(id)
    }
  }
  return found.size / relevant.size
}

export const reciprocalRank = (retrieved: readonly string[], relevant: ReadonlySet<string>): number => {
  for (let index = 0; index < retrieved.length; index += 1) {
    const id = retrieved[index]
    if (id !== undefined && relevant.has(id)) {
      return 1 / (index + 1)
    }
  }
  return 0
}

export const mean = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0
  }
  let total = 0
  for (const value of values) {
    total += value
  }
  return total / values.length
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/bench/metrics.test.ts`
Expected: PASS (8 assertions across 4 describes).

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bench/metrics.ts tests/bench/metrics.test.ts
git commit -m "feat(bench): add precision/recall/MRR metric functions"
```

---

### Task 3: Corpus schema + loader

**Files:**
- Create: `bench/corpus.ts`
- Test: `tests/bench/corpus.test.ts`

**Interfaces:**
- Consumes: `Corpus` from `bench/types.ts`.
- Produces: `parseCorpus(raw: unknown): Corpus` (throws on invalid), `loadCorpus(filePath: string): Promise<Corpus>`.

- [ ] **Step 1: Write the failing test**

Create `tests/bench/corpus.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

import { parseCorpus } from '../../bench/corpus.js'

describe('parseCorpus', () => {
  test('accepts a corpus with find and who-uses queries', () => {
    const corpus = parseCorpus({
      name: 'sample',
      queries: [
        { id: 'q1', kind: 'find-symbol', query: 'searchSymbols', relevant: ['src/search/index#searchSymbols'] },
        { id: 'q2', kind: 'who-uses', target: 'src/storage/db#openDatabase', relevant: ['src/cli#withDatabase'] },
      ],
    })
    expect(corpus.queries.length).toBe(2)
  })

  test('rejects a who-uses query missing a target', () => {
    expect(() => parseCorpus({ name: 'bad', queries: [{ id: 'q1', kind: 'who-uses', relevant: [] }] })).toThrow()
  })

  test('rejects an unknown query kind', () => {
    expect(() => parseCorpus({ name: 'bad', queries: [{ id: 'q1', kind: 'grep', query: 'x', relevant: [] }] })).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bench/corpus.test.ts`
Expected: FAIL — cannot resolve `../../bench/corpus.js`.

- [ ] **Step 3: Write the implementation**

Create `bench/corpus.ts`:

```ts
import { readFile } from 'node:fs/promises'

import { z } from 'zod'

import type { Corpus } from './types.js'

const FindSymbolQuerySchema = z.object({
  id: z.string().min(1),
  kind: z.literal('find-symbol'),
  query: z.string().min(1),
  relevant: z.array(z.string().min(1)),
})

const NlIntentQuerySchema = z.object({
  id: z.string().min(1),
  kind: z.literal('nl-intent'),
  query: z.string().min(1),
  relevant: z.array(z.string().min(1)),
})

const WhoUsesQuerySchema = z.object({
  id: z.string().min(1),
  kind: z.literal('who-uses'),
  target: z.string().min(1),
  relevant: z.array(z.string().min(1)),
})

const CorpusSchema = z.object({
  name: z.string().min(1),
  queries: z.array(z.discriminatedUnion('kind', [FindSymbolQuerySchema, NlIntentQuerySchema, WhoUsesQuerySchema])),
})

export const parseCorpus = (raw: unknown): Corpus => CorpusSchema.parse(raw)

export const loadCorpus = async (filePath: string): Promise<Corpus> => {
  const contents = await readFile(filePath, 'utf8')
  return parseCorpus(JSON.parse(contents) as unknown)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/bench/corpus.test.ts`
Expected: PASS (3 assertions).

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: PASS. (If typecheck complains that the parsed union is not assignable to `Corpus`, confirm each schema uses `z.literal` for `kind` — the discriminated union's branches must be assignable to `FindQuery`/`WhoUsesQuery`.)

- [ ] **Step 6: Commit**

```bash
git add bench/corpus.ts tests/bench/corpus.test.ts
git commit -m "feat(bench): add zod corpus schema and loader"
```

---

### Task 4: Corpus scorer against the real search/impact path

**Files:**
- Create: `bench/harness.ts`
- Test: `tests/bench/harness.test.ts`

**Interfaces:**
- Consumes: `searchSymbols`, `findIncomingReferences` from `src/search/index.ts`; `precisionAtK`/`recallAtK`/`reciprocalRank`/`mean` from `bench/metrics.ts`; `Corpus`/`CorpusReport`/`GoldenQuery`/`QueryScore` from `bench/types.ts`.
- Produces: `scoreCorpus(db: Database, corpus: Corpus, k: number): CorpusReport`.
- Behavior: `who-uses` → `findIncomingReferences(db, { qualifiedName: target, limit: k })`, retrieved = non-null `sourceQualifiedName`s. Other kinds → `searchSymbols(db, { query, limit: k })`, retrieved = `qualifiedName`s.

- [ ] **Step 1: Write the failing test**

Create `tests/bench/harness.test.ts`:

```ts
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { parseCorpus } from '../../bench/corpus.js'
import { scoreCorpus } from '../../bench/harness.js'
import { ensureSchema } from '../../src/storage/schema.js'

interface SeedSymbol {
  readonly id: number
  readonly fileId: number
  readonly filePath: string
  readonly moduleKey: string
  readonly localName: string
  readonly qualifiedName: string
}

const insertFile = (db: Database, id: number, filePath: string, moduleKey: string): void => {
  db.query(
    `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at)
     VALUES (?, ?, ?, 'ts', 'x', 'indexed', NULL, datetime('now'))`,
  ).run(id, filePath, moduleKey)
}

const insertSymbol = (db: Database, symbol: SeedSymbol): void => {
  db.query(
    `INSERT INTO symbols (id, file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, is_exported, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line, start_byte, end_byte)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'variable_declarator', 'exported', NULL, 1, ?, ?, '', ?, ?, 1, 1, 0, 10)`,
  ).run(
    symbol.id,
    symbol.fileId,
    symbol.filePath,
    symbol.moduleKey,
    `${symbol.filePath}#${symbol.id}`,
    symbol.localName,
    symbol.qualifiedName,
    JSON.stringify([symbol.localName]),
    `export const ${symbol.localName} = () => {}`,
    `export const ${symbol.localName} = () => {}`,
    symbol.localName.toLowerCase(),
  )
}

const buildDb = (): Database => {
  const db = new Database(':memory:')
  ensureSchema(db)
  insertFile(db, 1, 'src/storage/db.ts', 'src/storage/db')
  insertFile(db, 2, 'src/cli.ts', 'src/cli')
  insertFile(db, 3, 'src/search/index.ts', 'src/search/index')
  insertSymbol(db, { id: 1, fileId: 1, filePath: 'src/storage/db.ts', moduleKey: 'src/storage/db', localName: 'openDatabase', qualifiedName: 'src/storage/db#openDatabase' })
  insertSymbol(db, { id: 2, fileId: 2, filePath: 'src/cli.ts', moduleKey: 'src/cli', localName: 'withDatabase', qualifiedName: 'src/cli#withDatabase' })
  insertSymbol(db, { id: 3, fileId: 3, filePath: 'src/search/index.ts', moduleKey: 'src/search/index', localName: 'searchSymbols', qualifiedName: 'src/search/index#searchSymbols' })
  db.query(
    `INSERT INTO symbol_references (source_symbol_id, source_file_id, target_symbol_id, target_file_id, target_name, target_export_name, target_module_specifier, edge_type, confidence, line_number)
     VALUES (2, 2, 1, 1, 'openDatabase', NULL, '../storage/db', 'calls', 'resolved', 5)`,
  ).run()
  return db
}

describe('scoreCorpus', () => {
  test('scores a find-symbol query against exact search', () => {
    const db = buildDb()
    try {
      const corpus = parseCorpus({
        name: 't',
        queries: [{ id: 'q1', kind: 'find-symbol', query: 'searchSymbols', relevant: ['src/search/index#searchSymbols'] }],
      })
      const report = scoreCorpus(db, corpus, 10)
      expect(report.mrr).toBe(1)
      expect(report.meanRecallAtK).toBe(1)
    } finally {
      db.close()
    }
  })

  test('scores a who-uses query against incoming references', () => {
    const db = buildDb()
    try {
      const corpus = parseCorpus({
        name: 't',
        queries: [{ id: 'q2', kind: 'who-uses', target: 'src/storage/db#openDatabase', relevant: ['src/cli#withDatabase'] }],
      })
      const report = scoreCorpus(db, corpus, 10)
      const first = report.perQuery[0]!
      expect(first.retrieved).toContain('src/cli#withDatabase')
      expect(report.meanRecallAtK).toBe(1)
    } finally {
      db.close()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bench/harness.test.ts`
Expected: FAIL — cannot resolve `../../bench/harness.js`.

- [ ] **Step 3: Write the implementation**

Create `bench/harness.ts`:

```ts
import type { Database } from 'bun:sqlite'

import { findIncomingReferences, searchSymbols } from '../src/search/index.js'
import { mean, precisionAtK, recallAtK, reciprocalRank } from './metrics.js'
import type { Corpus, CorpusReport, GoldenQuery, QueryScore } from './types.js'

const retrievedFor = (db: Database, query: GoldenQuery, k: number): readonly string[] => {
  if (query.kind === 'who-uses') {
    return findIncomingReferences(db, { qualifiedName: query.target, limit: k })
      .map((row) => row.sourceQualifiedName)
      .filter((name): name is string => name !== null)
  }
  return searchSymbols(db, { query: query.query, limit: k }).map((row) => row.qualifiedName)
}

const scoreQuery = (db: Database, query: GoldenQuery, k: number): QueryScore => {
  const retrieved = retrievedFor(db, query, k)
  const relevant = new Set(query.relevant)
  return {
    id: query.id,
    kind: query.kind,
    precisionAtK: precisionAtK(retrieved, relevant, k),
    recallAtK: recallAtK(retrieved, relevant, k),
    reciprocalRank: reciprocalRank(retrieved, relevant),
    retrieved,
    relevant: query.relevant,
  }
}

export const scoreCorpus = (db: Database, corpus: Corpus, k: number): CorpusReport => {
  const perQuery = corpus.queries.map((query) => scoreQuery(db, query, k))
  return {
    k,
    queryCount: perQuery.length,
    meanPrecisionAtK: mean(perQuery.map((score) => score.precisionAtK)),
    meanRecallAtK: mean(perQuery.map((score) => score.recallAtK)),
    mrr: mean(perQuery.map((score) => score.reciprocalRank)),
    perQuery,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/bench/harness.test.ts`
Expected: PASS (4 assertions).

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bench/harness.ts tests/bench/harness.test.ts
git commit -m "feat(bench): score a corpus against real search and impact"
```

---

### Task 5: Hand-authored seed corpus for this repo

**Files:**
- Create: `bench/corpus/seed.json`
- Test: `tests/bench/seed.test.ts`

**Interfaces:**
- Consumes: `loadCorpus` from `bench/corpus.ts`.
- Produces: the default corpus file the runner loads (`bench/corpus/seed.json`).

Note: the `relevant` qualifiedNames below are derived from the current source. Task 7 re-runs the
bench against the real index and corrects any that don't resolve — treat them as grounded but
verify-on-baseline.

- [ ] **Step 1: Write the failing test**

Create `tests/bench/seed.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

import { loadCorpus } from '../../bench/corpus.js'

describe('seed corpus', () => {
  test('parses and contains all three query kinds', async () => {
    const corpus = await loadCorpus('bench/corpus/seed.json')
    const kinds = new Set(corpus.queries.map((query) => query.kind))
    expect(kinds.has('find-symbol')).toBe(true)
    expect(kinds.has('nl-intent')).toBe(true)
    expect(kinds.has('who-uses')).toBe(true)
    expect(corpus.queries.length).toBeGreaterThanOrEqual(6)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bench/seed.test.ts`
Expected: FAIL — `ENOENT` opening `bench/corpus/seed.json`.

- [ ] **Step 3: Create the seed corpus**

Create `bench/corpus/seed.json`:

```json
{
  "name": "codeindex-self",
  "queries": [
    { "id": "find-searchSymbols", "kind": "find-symbol", "query": "searchSymbols", "relevant": ["src/search/index#searchSymbols"] },
    { "id": "find-openDatabase", "kind": "find-symbol", "query": "openDatabase", "relevant": ["src/storage/db#openDatabase"] },
    { "id": "find-indexCodebase", "kind": "find-symbol", "query": "indexCodebase", "relevant": ["src/indexer/index-codebase#indexCodebase"] },
    { "id": "nl-rerank", "kind": "nl-intent", "query": "rerank search results", "relevant": ["src/search/rank#rerankSearchResults"] },
    { "id": "nl-load-config", "kind": "nl-intent", "query": "load codeindex config", "relevant": ["src/config#loadCodeindexConfig"] },
    { "id": "who-uses-openDatabase", "kind": "who-uses", "target": "src/storage/db#openDatabase", "relevant": ["src/cli#withDatabase", "src/indexer/index-codebase#indexCodebase"] },
    { "id": "who-uses-ensureSchema", "kind": "who-uses", "target": "src/storage/schema#ensureSchema", "relevant": ["src/indexer/index-codebase#indexCodebase"] }
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/bench/seed.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bench/corpus/seed.json tests/bench/seed.test.ts
git commit -m "feat(bench): add hand-authored seed corpus for codeindex"
```

---

### Task 6: Baseline comparator + CLI runner (with end-to-end integration test)

**Files:**
- Create: `bench/baseline-compare.ts`
- Create: `bench/run.ts`
- Test: `tests/bench/baseline-compare.test.ts`
- Test: `tests/bench/harness-integration.test.ts`

**Interfaces:**
- Consumes: `CorpusReport`/`BaselineMetrics` from `bench/types.ts`; `loadCodeindexConfig` from `src/config.ts`; `indexCodebase` from `src/indexer/index-codebase.ts`; `openDatabase` from `src/storage/db.ts`; `loadCorpus`, `scoreCorpus`, `compareToBaseline`.
- Produces: `compareToBaseline(report: CorpusReport, baseline: BaselineMetrics, tolerance: number): BaselineComparison` where `BaselineComparison = { regressed: boolean; deltas: readonly MetricDelta[] }`; and the `bench/run.ts` CLI (no exported API — invoked via the `bench` / `bench:check` scripts).

- [ ] **Step 1: Write the failing test for the comparator**

Create `tests/bench/baseline-compare.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

import { compareToBaseline } from '../../bench/baseline-compare.js'
import type { BaselineMetrics, CorpusReport } from '../../bench/types.js'

const buildReport = (overrides: Partial<CorpusReport>): CorpusReport => ({
  k: 10,
  queryCount: 1,
  meanPrecisionAtK: 0.5,
  meanRecallAtK: 0.5,
  mrr: 0.5,
  perQuery: [],
  ...overrides,
})

const baseline: BaselineMetrics = { k: 10, meanPrecisionAtK: 0.5, meanRecallAtK: 0.5, mrr: 0.5 }

describe('compareToBaseline', () => {
  test('flags regression when a metric drops beyond tolerance', () => {
    expect(compareToBaseline(buildReport({ mrr: 0.4 }), baseline, 1e-9).regressed).toBe(true)
  })

  test('does not flag equal metrics', () => {
    expect(compareToBaseline(buildReport({}), baseline, 1e-9).regressed).toBe(false)
  })

  test('does not flag improvements', () => {
    expect(compareToBaseline(buildReport({ mrr: 0.9 }), baseline, 1e-9).regressed).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bench/baseline-compare.test.ts`
Expected: FAIL — cannot resolve `../../bench/baseline-compare.js`.

- [ ] **Step 3: Implement the comparator**

Create `bench/baseline-compare.ts`:

```ts
import type { BaselineMetrics, CorpusReport } from './types.js'

export interface MetricDelta {
  readonly metric: 'meanPrecisionAtK' | 'meanRecallAtK' | 'mrr'
  readonly baseline: number
  readonly current: number
  readonly delta: number
}

export interface BaselineComparison {
  readonly regressed: boolean
  readonly deltas: readonly MetricDelta[]
}

export const compareToBaseline = (
  report: CorpusReport,
  baseline: BaselineMetrics,
  tolerance: number,
): BaselineComparison => {
  const deltas: readonly MetricDelta[] = [
    {
      metric: 'meanPrecisionAtK',
      baseline: baseline.meanPrecisionAtK,
      current: report.meanPrecisionAtK,
      delta: report.meanPrecisionAtK - baseline.meanPrecisionAtK,
    },
    {
      metric: 'meanRecallAtK',
      baseline: baseline.meanRecallAtK,
      current: report.meanRecallAtK,
      delta: report.meanRecallAtK - baseline.meanRecallAtK,
    },
    {
      metric: 'mrr',
      baseline: baseline.mrr,
      current: report.mrr,
      delta: report.mrr - baseline.mrr,
    },
  ]
  return { regressed: deltas.some((entry) => entry.delta < -tolerance), deltas }
}
```

- [ ] **Step 4: Run comparator test to verify it passes**

Run: `bun test tests/bench/baseline-compare.test.ts`
Expected: PASS (3 assertions).

- [ ] **Step 5: Write the failing end-to-end integration test**

Create `tests/bench/harness-integration.test.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { parseCorpus } from '../../bench/corpus.js'
import { scoreCorpus } from '../../bench/harness.js'
import { loadCodeindexConfig } from '../../src/config.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import { openDatabase } from '../../src/storage/db.js'

const tempDirs: string[] = []

const makeRepo = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-bench-'))
  tempDirs.push(dir)
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
  writeFileSync(path.join(dir, 'src', 'math.ts'), 'export const addNumbers = (a: number, b: number): number => a + b\n')
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('scoreCorpus end-to-end', () => {
  test('finds a symbol in a freshly indexed repo', async () => {
    const repo = makeRepo()
    const config = await loadCodeindexConfig({ configPath: path.join(repo, '.codeindex.json'), repoRoot: repo })
    await indexCodebase({ config, mode: 'full' })
    const db = openDatabase(config.dbPath)
    try {
      const corpus = parseCorpus({
        name: 'e2e',
        queries: [{ id: 'q', kind: 'find-symbol', query: 'addNumbers', relevant: ['src/math#addNumbers'] }],
      })
      const report = scoreCorpus(db, corpus, 10)
      expect(report.mrr).toBe(1)
    } finally {
      db.close()
    }
  })
})
```

- [ ] **Step 6: Run the integration test to verify it passes**

Run: `bun test tests/bench/harness-integration.test.ts`
Expected: PASS — the real pipeline indexes `math.ts` and `addNumbers` resolves to `src/math#addNumbers`. (This exercises tree-sitter parsing; it is slower than the unit tests.)

- [ ] **Step 7: Implement the CLI runner**

Create `bench/run.ts`:

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { compareToBaseline } from './baseline-compare.js'
import { loadCorpus } from './corpus.js'
import { scoreCorpus } from './harness.js'
import type { BaselineMetrics, CorpusReport } from './types.js'
import { loadCodeindexConfig } from '../src/config.js'
import { indexCodebase } from '../src/indexer/index-codebase.js'
import { openDatabase } from '../src/storage/db.js'

interface BenchArgs {
  readonly repo: string
  readonly corpus: string
  readonly k: number
  readonly baseline: string | null
  readonly updateBaseline: boolean
}

const parseArgs = (argv: readonly string[]): BenchArgs => {
  let repo = process.cwd()
  let corpus = path.join(process.cwd(), 'bench/corpus/seed.json')
  let k = 10
  let baseline: string | null = null
  let updateBaseline = false
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--repo' && value !== undefined) {
      repo = path.resolve(value)
      index += 1
    } else if (flag === '--corpus' && value !== undefined) {
      corpus = path.resolve(value)
      index += 1
    } else if (flag === '--k' && value !== undefined) {
      k = Number.parseInt(value, 10)
      index += 1
    } else if (flag === '--baseline' && value !== undefined) {
      baseline = path.resolve(value)
      index += 1
    } else if (flag === '--update-baseline') {
      updateBaseline = true
    }
  }
  return { repo, corpus, k, baseline, updateBaseline }
}

const toBaselineMetrics = (report: CorpusReport): BaselineMetrics => ({
  k: report.k,
  meanPrecisionAtK: report.meanPrecisionAtK,
  meanRecallAtK: report.meanRecallAtK,
  mrr: report.mrr,
})

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))
  const config = await loadCodeindexConfig({
    configPath: path.join(args.repo, '.codeindex.json'),
    repoRoot: args.repo,
  })
  await indexCodebase({ config, mode: 'full' })
  const corpus = await loadCorpus(args.corpus)
  const db = openDatabase(config.dbPath)
  const report = ((): CorpusReport => {
    try {
      return scoreCorpus(db, corpus, args.k)
    } finally {
      db.close()
    }
  })()
  console.log(JSON.stringify(report, null, 2))

  if (args.updateBaseline && args.baseline !== null) {
    writeFileSync(args.baseline, `${JSON.stringify(toBaselineMetrics(report), null, 2)}\n`)
    console.error(`Baseline written to ${args.baseline}`)
    return
  }

  if (args.baseline !== null && existsSync(args.baseline)) {
    const baseline = JSON.parse(readFileSync(args.baseline, 'utf8')) as BaselineMetrics
    const comparison = compareToBaseline(report, baseline, 1e-9)
    for (const entry of comparison.deltas) {
      const sign = entry.delta >= 0 ? '+' : ''
      console.error(`${entry.metric}: ${entry.baseline.toFixed(4)} -> ${entry.current.toFixed(4)} (${sign}${entry.delta.toFixed(4)})`)
    }
    if (comparison.regressed) {
      console.error('Regression detected against baseline.')
      process.exit(1)
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
```

- [ ] **Step 8: Smoke-run the runner against this repo**

Run: `bun run bench`
Expected: prints a `CorpusReport` JSON with `queryCount: 7` and non-zero `mrr`. (No baseline yet, so no gate runs.)

- [ ] **Step 9: Verify the full gate suite**

Run: `bun run format && bun test tests/bench && bun run lint && bun run typecheck && bun run format:check`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add bench/baseline-compare.ts bench/run.ts tests/bench/baseline-compare.test.ts tests/bench/harness-integration.test.ts
git commit -m "feat(bench): add baseline comparator and CLI runner"
```

---

### Task 7: Capture the baseline + ground the seed

**Files:**
- Create: `bench/baseline.json`
- Modify (if needed): `bench/corpus/seed.json`

**Interfaces:**
- Consumes: the `bench:check` script and `bench/run.ts` from Task 6.
- Produces: `bench/baseline.json` — the committed reference the regression gate compares against.

- [ ] **Step 1: Inspect current scores and ground the seed**

Run: `bun run bench`
Read the printed report's `perQuery` array. For **every** query, confirm `reciprocalRank > 0`
(the expected symbol was found). If any query shows `reciprocalRank: 0` or `recallAtK: 0`, its
`relevant` qualifiedName is wrong — look up the real name and fix `bench/corpus/seed.json`:

Run (example, to find a symbol's real qualifiedName): `bun run start symbol openDatabase`
This prints candidates including their `qualifiedName`. Replace the mismatched entry in
`seed.json`, then re-run `bun run bench` until no query is degenerate.

- [ ] **Step 2: Re-run the seed test after any edits**

Run: `bun test tests/bench/seed.test.ts`
Expected: PASS (still ≥6 queries, all three kinds present).

- [ ] **Step 3: Write the baseline file**

Run: `bun run bench/run.ts --baseline bench/baseline.json --update-baseline`
Expected: stderr prints `Baseline written to .../bench/baseline.json`; the file contains
`k`, `meanPrecisionAtK`, `meanRecallAtK`, `mrr` (example shape):

```json
{
  "k": 10,
  "meanPrecisionAtK": 0.1,
  "meanRecallAtK": 1,
  "mrr": 1
}
```

- [ ] **Step 4: Verify the gate passes against its own baseline**

Run: `bun run bench:check`
Expected: exit 0; stderr shows each metric with a `(+0.0000)` delta; no "Regression detected".

- [ ] **Step 5: Verify a regression is actually caught**

Temporarily edit `bench/baseline.json` to set `"mrr": 1.5`, then run `bun run bench:check`.
Expected: stderr prints `mrr: 1.5000 -> ...` with a negative delta and `Regression detected against baseline.`; exit code 1 (`echo $status` in fish prints `1`). Restore the real baseline afterward with:

Run: `bun run bench/run.ts --baseline bench/baseline.json --update-baseline`

- [ ] **Step 6: Commit**

```bash
git add bench/baseline.json bench/corpus/seed.json
git commit -m "feat(bench): capture IR baseline and wire regression gate"
```

- [ ] **Step 7: Note the CI wiring (documentation only)**

`bench:check` is the regression gate. It is intentionally **not** folded into `bun run check`
(which stays fast and index-free). CI should run `bun run bench:check` as a separate pre-merge
step; when a change legitimately improves metrics, regenerate the baseline with
`bun run bench/run.ts --baseline bench/baseline.json --update-baseline` and commit it in the same PR.
Record this in the PR description — there is no CI config file in the repo yet, so this step is a
handoff note for whoever adds one.

---

## Definition of done (this plan)

- `bench/` harness present: metrics, corpus loader, scorer, comparator, runner.
- `bun run bench` indexes this repo, scores the seed corpus, prints a `CorpusReport`.
- `bun run bench:check` exits non-zero on regression, zero otherwise.
- `bench/baseline.json` committed; every seed query is non-degenerate (found its expected symbol).
- `bun test tests/bench`, `bun run lint`, `bun run typecheck`, `bun run format:check` all pass.

## Deferred to sibling Phase 1 plans (do NOT do here)

- **Query logging / observability** (feeds mined queries into the corpus over time).
- **Protocol-boundary tests** (`Client`/`StdioClientTransport` round-trips).
- **Edit-sequence integrity fuzzer.**
- **Indexing throughput/latency benchmark** (the 10k-file perf numbers).
- **Ride-alongs:** `busy_timeout`, index-provenance stamping.
- **Baselining `yourpapai/papai`** — run `bun run bench/run.ts --repo <path-to-papai> --corpus <papai-corpus> --baseline <papai-baseline>` once a papai corpus exists; authoring that corpus is its own task.
