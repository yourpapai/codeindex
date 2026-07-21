# Phase 1 · Query Logging / Observability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture every MCP query (tool, query text, filters, result count, hit/miss, latency, and the top result names) into a persistent, mineable store, plus a `log-stats` observability command — the observability the tool lacks today and the future feed for mining real queries into the `bench/` golden corpus.

**Architecture:** A `withQueryLogging(deps, config)` decorator wraps the `CodeindexToolDeps` object once (in `runMcpCommand`), timing and logging each of the three query tools (`code_search`/`code_symbol`/`code_impact`; `code_index` is a build step, not a query, so it's passed through). Logs go to a **separate** `.codeindex/queries.db` (never wiped by index reindex/migration), written best-effort so a logging failure never breaks a query. Logging is opt-out (`logQueries` defaults to `true`). A `readQueryLogStats` reader + a `log-stats` CLI command expose the data.

**Tech Stack:** Bun, `bun:sqlite` (WAL + `busy_timeout`, reusing `openDatabase`), `bun:test`, zod v4, TypeScript (strict, NodeNext-style `.js` import specifiers), oxlint + oxfmt.

## Context: where this sits

Phase 1 component ("Query logging / observability") from `docs/superpowers/specs/2026-07-20-codeindex-roadmap-design.md`. It "doubles as observability" and feeds the "mine real queries over time" corpus loop. **Mining logged queries into `bench/` is a LATER plan, out of scope here** — this plan only produces the store + reader + CLI; the stored shape is designed to make later mining easy. Other remaining Phase 1 components (indexing benchmark, edit-sequence fuzzer) are separate plans.

## Decisions locked (by the maintainer)

- **Storage:** a separate SQLite DB at `.codeindex/queries.db`, reusing `openDatabase` (WAL + `busy_timeout`). NOT a table in `index.db` (would be dropped on schema-version bumps).
- **Privacy:** opt-out — `logQueries` defaults to `true`. A `.codeindex.json` flag disables it.
- **Surface:** a `readQueryLogStats` reader function AND a `bun run start log-stats` CLI command.
- **Scope:** MCP tools only (CLI `search`/`symbol`/`impact` bypass `CodeindexToolDeps` and are not logged). `code_index` is excluded from logging.

## Global Constraints

Every task's requirements implicitly include this section. Values copied from the repo:

- **Runtime/tests:** Bun. Tests use `bun:test`, run via `bun test tests`.
- **Imports:** ESM only. **All local import specifiers must end in `.js`.** `node:*`/`bun:*` builtins take no `.js`.
- **Type-only imports** must use `import type` (`verbatimModuleSyntax: true`).
- **No optional chaining** anywhere (`oxc/no-optional-chaining: error`) — use explicit `!== undefined`/`!== null`. `??` IS allowed.
- **No `any`** (`typescript/no-explicit-any`). **No unsafe type assertions** (`no-unsafe-type-assertion`) — do NOT write `JSON.parse(x) as T`; reuse `parseStringArray` from `src/storage/queries.ts` for JSON string-array columns, and validate other JSON via a guarded parser.
- **Explicit return types** on every function. **No param reassignment** — reassign locals only. No classes; functional style; `readonly` fields.
- **TS strictness:** `strict`, `noUncheckedIndexedAccess` (indexed access is `T | undefined` — guard it), `noUnusedLocals/Parameters`, `noPropertyAccessFromIndexSignature`.
- **oxlint `max-lines: 300`** on non-test files (tests exempt) — keep new `src/` modules focused.
- **Lint/format/typecheck gates:** `bun run lint`, `bun run typecheck`, `bun run format:check` must all pass. **Run `bun run format` after writing/editing any file.**

## Key facts about the code (verified against source)

- `src/config.ts` — `CodeindexConfigSchema` (lines 7-19) with `.default(...)` fields; `CodeindexConfig` type (line 21) is `Readonly<z.infer<...> & { repoRoot; configPath; dbPath: string; roots; tsconfigPaths }>`. `loadCodeindexConfig` (line 53) resolves `dbPath` to absolute (line 59), `mkdir`s its dirname (line 61), and returns the resolved config (lines 63-70). Existing helper `relativizeRoots` at line 31.
- `src/mcp/tools.ts` — `CodeindexToolDeps` (lines 7-25): `codeSearch(input: { query; limit; kinds?; scopeTiers?; pathPrefix? }) => Promise<readonly RankedSearchResult[]>`; `codeSymbol(query, limit) => Promise<readonly SearchResult[] | readonly RankedSearchResult[]>`; `codeImpact(input: { symbolKey?; qualifiedName?; limit }) => Promise<readonly ImpactResult[]>`; `codeIndex(input: { mode }) => Promise<IndexSummary>`. `RankedSearchResult`/`SearchResult` have `qualifiedName: string`; `ImpactResult` has `sourceQualifiedName: string | null` (from `src/search/index.ts`).
- `src/cli.ts` — `buildMcpDeps(config)` (lines 65-76) returns the deps object; `runMcpCommand` (lines 78-83) does `createCodeindexServer(buildMcpDeps(config))`; `main`'s `switch` (lines 89-113) dispatches commands; `runStatsCommand` (lines 50-63) is the pattern for a read-only CLI command; `withDatabase(config, cb)` (private helper) opens/closes `config.dbPath`.
- `src/storage/db.ts` — `openDatabase(dbPath): Database` sets WAL + `foreign_keys` + `busy_timeout = 5000`. Reuse it for `queries.db`.
- `src/storage/queries.ts` — `export const parseStringArray = (value: string): readonly string[]` (line 7) is the lint-clean JSON-array parser to reuse.
- Test patterns: `tests/config.test.ts` (temp-dir `.codeindex.json` + `loadCodeindexConfig`); `tests/storage/schema.test.ts` / `tests/storage/queries.test.ts` (`new Database(':memory:')` + direct assertions); `tests/mcp/harness.ts` `makeInMemoryDeps(db)` (build a `CodeindexToolDeps` for decorator tests) and `connectClient` (protocol round-trip); `tests/cli.test.ts` (CLI command tests).

---

## File Structure

Created by this plan:

- `src/storage/query-log.ts` — `QueryLogEntry`/`QueryLogStats` types; `openQueryLog(queriesPath): Database` (open + ensure schema); `ensureQueryLogSchema(db): void`; `insertQueryLogEntry(db, entry): void`; `readQueryLogStats(db): QueryLogStats`.
- `src/mcp/query-logging.ts` — `withQueryLogging(deps, config): CodeindexToolDeps` decorator.
- `tests/storage/query-log.test.ts`, `tests/mcp/query-logging.test.ts`, `tests/cli-log-stats.test.ts`, and a `queriesPath`/`logQueries` case added to `tests/config.test.ts` (or a new `tests/config-query-log.test.ts`).

Modified:

- `src/config.ts` — add `queriesPath` + `logQueries` schema fields; resolve `queriesPath` to absolute; add `queriesPath: string` to the `CodeindexConfig` intersection.
- `src/cli.ts` — wrap deps with `withQueryLogging` in `runMcpCommand`; add a `log-stats` command.

---

### Task 1: Config fields — `queriesPath` + `logQueries`

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config-query-log.test.ts`

**Interfaces:**
- Produces: `CodeindexConfig` gains `queriesPath: string` (absolute, default `<repo>/.codeindex/queries.db`) and `logQueries: boolean` (default `true`).

- [ ] **Step 1: Write the failing test**

Create `tests/config-query-log.test.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadCodeindexConfig } from '../src/config.js'

const tempDirs: string[] = []

const loadWith = async (raw: Record<string, unknown>): Promise<Awaited<ReturnType<typeof loadCodeindexConfig>>> => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-qlcfg-'))
  tempDirs.push(dir)
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify(raw))
  return loadCodeindexConfig({ configPath: path.join(dir, '.codeindex.json'), repoRoot: dir })
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('query-log config', () => {
  test('defaults logQueries to true and queriesPath under .codeindex', async () => {
    const config = await loadWith({ roots: ['src'] })
    expect(config.logQueries).toBe(true)
    expect(config.queriesPath.endsWith(path.join('.codeindex', 'queries.db'))).toBe(true)
    expect(path.isAbsolute(config.queriesPath)).toBe(true)
  })

  test('respects an explicit logQueries: false', async () => {
    const config = await loadWith({ roots: ['src'], logQueries: false })
    expect(config.logQueries).toBe(false)
  })

  test('respects a custom queriesPath', async () => {
    const config = await loadWith({ roots: ['src'], queriesPath: '.codeindex/custom-queries.db' })
    expect(config.queriesPath.endsWith('custom-queries.db')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config-query-log.test.ts`
Expected: FAIL — `config.logQueries`/`config.queriesPath` are `undefined` (not in the schema yet); the `.endsWith` on `undefined` throws or the boolean assertions fail.

- [ ] **Step 3: Add the fields**

In `src/config.ts`:

1. Add to `CodeindexConfigSchema` (after the `dbPath` line, line 13):

```ts
  queriesPath: z.string().min(1).default('.codeindex/queries.db'),
  logQueries: z.boolean().default(true),
```

2. Add `queriesPath: string` to the `CodeindexConfig` intersection (alongside `dbPath: string`, line 25):

```ts
export type CodeindexConfig = Readonly<
  z.infer<typeof CodeindexConfigSchema> & {
    repoRoot: string
    configPath: string
    dbPath: string
    queriesPath: string
    roots: readonly string[]
    tsconfigPaths: readonly string[]
  }
>
```

3. In `loadCodeindexConfig`, resolve `queriesPath` and include it in the return. After `const resolvedDbPath = path.resolve(repoRoot, parsed.dbPath)` (line 59) add:

```ts
  const resolvedQueriesPath = path.resolve(repoRoot, parsed.queriesPath)
```

and in the returned object (lines 63-70) add `queriesPath: resolvedQueriesPath,` alongside `dbPath: resolvedDbPath,`. (The existing `mkdir(path.dirname(resolvedDbPath), …)` already creates `.codeindex/`, which is the same directory `queriesPath` lives in — no extra `mkdir` needed as long as `queriesPath` defaults under the same dir. If a custom `queriesPath` could point elsewhere, that dir is created lazily by `openQueryLog` in Task 2 via `openDatabase`'s `{ create: true }`; `openDatabase` does NOT mkdir parent dirs, so also `await mkdir(path.dirname(resolvedQueriesPath), { recursive: true })` right after the existing mkdir to be safe.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/config-query-log.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Gates**

Run: `bun run format && bun run lint && bun run typecheck && bun run format:check`
Expected: PASS. Confirm `computeConfigIdentity` (which enumerates specific fields) still compiles — it does not reference the new fields, so it's unaffected; the new fields are intentionally NOT part of config identity (they don't change indexing behavior).

- [ ] **Step 6: Commit**

```bash
git add src/config.ts tests/config-query-log.test.ts
git commit -m "feat(config): add queriesPath and logQueries settings"
```

---

### Task 2: Query-log storage module

**Files:**
- Create: `src/storage/query-log.ts`
- Test: `tests/storage/query-log.test.ts`

**Interfaces:**
- Consumes: `openDatabase` from `src/storage/db.ts`; `parseStringArray` from `src/storage/queries.ts`.
- Produces: `QueryLogEntry` (`{ timestamp; tool; queryText: string | null; filtersJson: string | null; resultCount; hit; latencyMs; topQualifiedNames: readonly string[] }`); `QueryLogStats`; `openQueryLog(queriesPath): Database`; `ensureQueryLogSchema(db): void`; `insertQueryLogEntry(db, entry): void`; `readQueryLogStats(db): QueryLogStats`.

- [ ] **Step 1: Write the failing test**

Create `tests/storage/query-log.test.ts`:

```ts
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { ensureQueryLogSchema, insertQueryLogEntry, readQueryLogStats } from '../../src/storage/query-log.js'
import type { QueryLogEntry } from '../../src/storage/query-log.js'

const baseEntry = (overrides: Partial<QueryLogEntry>): QueryLogEntry => ({
  timestamp: '2026-07-21T00:00:00.000Z',
  tool: 'code_search',
  queryText: 'searchSymbols',
  filtersJson: JSON.stringify({ limit: 10 }),
  resultCount: 1,
  hit: true,
  latencyMs: 3,
  topQualifiedNames: ['src/search/index#searchSymbols'],
  ...overrides,
})

describe('query log storage', () => {
  test('insert then stats aggregates count, hit rate, and latency percentiles', () => {
    const db = new Database(':memory:')
    try {
      ensureQueryLogSchema(db)
      insertQueryLogEntry(db, baseEntry({ latencyMs: 1, hit: true, resultCount: 2 }))
      insertQueryLogEntry(db, baseEntry({ latencyMs: 5, hit: false, resultCount: 0, topQualifiedNames: [] }))
      insertQueryLogEntry(db, baseEntry({ latencyMs: 9, hit: true, resultCount: 1 }))
      const stats = readQueryLogStats(db)
      expect(stats.total).toBe(3)
      expect(stats.hits).toBe(2)
      expect(stats.hitRate).toBeCloseTo(2 / 3)
      expect(stats.p50LatencyMs).toBe(5)
      expect(stats.maxLatencyMs).toBe(9)
    } finally {
      db.close()
    }
  })

  test('stats on an empty log are all zero, not NaN', () => {
    const db = new Database(':memory:')
    try {
      ensureQueryLogSchema(db)
      const stats = readQueryLogStats(db)
      expect(stats.total).toBe(0)
      expect(stats.hits).toBe(0)
      expect(stats.hitRate).toBe(0)
      expect(stats.p50LatencyMs).toBe(0)
    } finally {
      db.close()
    }
  })

  test('topQueries counts repeated query text', () => {
    const db = new Database(':memory:')
    try {
      ensureQueryLogSchema(db)
      insertQueryLogEntry(db, baseEntry({ queryText: 'foo' }))
      insertQueryLogEntry(db, baseEntry({ queryText: 'foo' }))
      insertQueryLogEntry(db, baseEntry({ queryText: 'bar' }))
      const stats = readQueryLogStats(db)
      const foo = stats.topQueries.find((entry) => entry.queryText === 'foo')
      expect(foo).not.toBeUndefined()
      expect(foo!.count).toBe(2)
    } finally {
      db.close()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/storage/query-log.test.ts`
Expected: FAIL — `src/storage/query-log.js` does not exist.

- [ ] **Step 3: Implement the storage module**

Create `src/storage/query-log.ts`:

```ts
import type { Database } from 'bun:sqlite'

import { openDatabase } from './db.js'
import { parseStringArray } from './queries.js'

export interface QueryLogEntry {
  readonly timestamp: string
  readonly tool: string
  readonly queryText: string | null
  readonly filtersJson: string | null
  readonly resultCount: number
  readonly hit: boolean
  readonly latencyMs: number
  readonly topQualifiedNames: readonly string[]
}

export interface TopQuery {
  readonly queryText: string
  readonly count: number
}

export interface QueryLogStats {
  readonly total: number
  readonly hits: number
  readonly hitRate: number
  readonly p50LatencyMs: number
  readonly p95LatencyMs: number
  readonly maxLatencyMs: number
  readonly topQueries: readonly TopQuery[]
}

const CREATE_QUERY_LOG = `CREATE TABLE IF NOT EXISTS query_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  tool TEXT NOT NULL,
  query_text TEXT,
  filters_json TEXT,
  result_count INTEGER NOT NULL,
  hit INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  top_qualified_names TEXT NOT NULL
)`

export const ensureQueryLogSchema = (db: Database): void => {
  db.run(CREATE_QUERY_LOG)
}

export const openQueryLog = (queriesPath: string): Database => {
  const db = openDatabase(queriesPath)
  ensureQueryLogSchema(db)
  return db
}

export const insertQueryLogEntry = (db: Database, entry: QueryLogEntry): void => {
  db.query(
    `INSERT INTO query_log (timestamp, tool, query_text, filters_json, result_count, hit, latency_ms, top_qualified_names)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.timestamp,
    entry.tool,
    entry.queryText,
    entry.filtersJson,
    entry.resultCount,
    entry.hit ? 1 : 0,
    entry.latencyMs,
    JSON.stringify(entry.topQualifiedNames),
  )
}

const percentile = (sortedAscending: readonly number[], fraction: number): number => {
  if (sortedAscending.length === 0) {
    return 0
  }
  const index = Math.min(sortedAscending.length - 1, Math.floor(fraction * sortedAscending.length))
  const value = sortedAscending[index]
  return value === undefined ? 0 : value
}

interface LatencyRow {
  readonly latency_ms: number
}

interface TopQueryRow {
  readonly query_text: string
  readonly n: number
}

export const readQueryLogStats = (db: Database): QueryLogStats => {
  const latencies = db
    .query<LatencyRow, []>('SELECT latency_ms FROM query_log ORDER BY latency_ms ASC')
    .all()
    .map((row) => row.latency_ms)
  const total = latencies.length
  const hitsRow = db.query<{ hits: number }, []>('SELECT COUNT(*) AS hits FROM query_log WHERE hit = 1').get()
  const hits = hitsRow === null ? 0 : hitsRow.hits
  const topQueries = db
    .query<TopQueryRow, []>(
      `SELECT query_text, COUNT(*) AS n FROM query_log
       WHERE query_text IS NOT NULL
       GROUP BY query_text ORDER BY n DESC, query_text ASC LIMIT 10`,
    )
    .all()
    .map((row) => ({ queryText: row.query_text, count: row.n }))
  return {
    total,
    hits,
    hitRate: total === 0 ? 0 : hits / total,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    maxLatencyMs: total === 0 ? 0 : (latencies[total - 1] ?? 0),
    topQueries,
  }
}
```

Note: `parseStringArray` is imported for symmetry/potential `readQueryLog` raw reads; if the module ends up not needing it (stats don't decode `top_qualified_names`), REMOVE the import to satisfy `noUnusedLocals` rather than leaving it dangling. (A raw `readQueryLog(db)` that decodes `top_qualified_names` via `parseStringArray` may be added if a later step needs it — but the stats reader above does not, so keep imports honest.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/storage/query-log.test.ts`
Expected: PASS (3 tests). Verify the p50 assertion: 3 latencies `[1,5,9]`, `floor(0.5*3)=1` → index 1 → `5`. Matches.

- [ ] **Step 5: Gates**

Run: `bun run format && bun run lint && bun run typecheck && bun run format:check`
Expected: PASS. If `parseStringArray` is unused, remove its import.

- [ ] **Step 6: Commit**

```bash
git add src/storage/query-log.ts tests/storage/query-log.test.ts
git commit -m "feat(storage): add query-log store with stats reader"
```

---

### Task 3: `withQueryLogging` decorator + wire into the MCP server

**Files:**
- Create: `src/mcp/query-logging.ts`
- Modify: `src/cli.ts` (`runMcpCommand`)
- Test: `tests/mcp/query-logging.test.ts`

**Interfaces:**
- Consumes: `CodeindexToolDeps` from `src/mcp/tools.ts`; `CodeindexConfig` from `src/config.ts`; `openQueryLog`/`insertQueryLogEntry`/`QueryLogEntry` from `src/storage/query-log.ts`.
- Produces: `withQueryLogging(deps: Readonly<CodeindexToolDeps>, config: CodeindexConfig): CodeindexToolDeps`.
- Behavior: when `config.logQueries` is false, returns `deps` unchanged. Otherwise wraps `codeSearch`/`codeSymbol`/`codeImpact` (times each, records an entry to `config.queriesPath`, returns the real result); `codeIndex` is passed through untouched. Recording is **best-effort**: a logging error is swallowed and never affects the query result.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/query-logging.test.ts`:

```ts
import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { CodeindexConfig } from '../../src/config.js'
import { withQueryLogging } from '../../src/mcp/query-logging.js'
import type { CodeindexToolDeps } from '../../src/mcp/tools.js'
import { readQueryLogStats } from '../../src/storage/query-log.js'
import type { RankedSearchResult } from '../../src/types.js'

const tempDirs: string[] = []

const fakeResult = (qualifiedName: string): RankedSearchResult => ({
  symbolKey: 'k',
  qualifiedName,
  localName: 'x',
  kind: 'variable_declarator',
  scopeTier: 'exported',
  filePath: 'src/x.ts',
  startLine: 1,
  endLine: 1,
  exportNames: [],
  matchReason: 'exact',
  confidence: 'high',
  snippet: '',
  rankScore: 1,
})

const stubDeps = (): CodeindexToolDeps => ({
  codeSearch: () => Promise.resolve([fakeResult('src/x#found')]),
  codeSymbol: () => Promise.resolve([]),
  codeImpact: () => Promise.resolve([]),
  codeIndex: () =>
    Promise.resolve({
      filesIndexed: 0,
      filesFailed: 0,
      filesPruned: 0,
      symbolsIndexed: 0,
      referencesIndexed: 0,
      referencesUnresolved: 0,
      elapsedMs: 0,
    }),
})

const configWith = (logQueries: boolean): CodeindexConfig => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-qlog-'))
  tempDirs.push(dir)
  return {
    roots: ['src'],
    exclude: [],
    languages: ['ts'],
    dbPath: path.join(dir, 'index.db'),
    queriesPath: path.join(dir, 'queries.db'),
    logQueries,
    indexLocals: true,
    indexVariables: true,
    includeDocComments: true,
    maxStoredBodyLines: 120,
    tsconfigPaths: [path.join(dir, 'tsconfig.json')],
    repoRoot: dir,
    configPath: path.join(dir, '.codeindex.json'),
  }
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('withQueryLogging', () => {
  test('logs a code_search call to the queries db', async () => {
    const config = configWith(true)
    const wrapped = withQueryLogging(stubDeps(), config)
    const results = await wrapped.codeSearch({ query: 'find me', limit: 10 })
    expect(results.length).toBe(1)
    const db = new Database(config.queriesPath)
    try {
      const stats = readQueryLogStats(db)
      expect(stats.total).toBe(1)
      expect(stats.hits).toBe(1)
      expect(stats.topQueries[0]!.queryText).toBe('find me')
    } finally {
      db.close()
    }
  })

  test('does not log when logQueries is false', async () => {
    const config = configWith(false)
    const wrapped = withQueryLogging(stubDeps(), config)
    await wrapped.codeSearch({ query: 'nope', limit: 10 })
    // queries.db is never created when logging is off; opening it fresh yields an empty schema-less db.
    const db = new Database(config.queriesPath)
    try {
      const table = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='query_log'")
        .get()
      expect(table).toBeNull()
    } finally {
      db.close()
    }
  })

  test('returns the real result even if logging cannot write', async () => {
    const config = configWith(true)
    // Point queriesPath at an unwritable location to force a logging failure.
    const brokenConfig: CodeindexConfig = { ...config, queriesPath: path.join(config.repoRoot, 'no-such-dir', 'q.db') }
    const wrapped = withQueryLogging(stubDeps(), brokenConfig)
    const results = await wrapped.codeSearch({ query: 'x', limit: 10 })
    expect(results.length).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp/query-logging.test.ts`
Expected: FAIL — `src/mcp/query-logging.js` does not exist.

- [ ] **Step 3: Implement the decorator**

Create `src/mcp/query-logging.ts`:

```ts
import type { CodeindexConfig } from '../config.js'
import { insertQueryLogEntry, openQueryLog } from '../storage/query-log.js'
import type { QueryLogEntry } from '../storage/query-log.js'
import type { CodeindexToolDeps } from './tools.js'

interface RecordInput {
  readonly tool: string
  readonly queryText: string | null
  readonly filtersJson: string | null
  readonly resultCount: number
  readonly latencyMs: number
  readonly topQualifiedNames: readonly string[]
}

const record = (queriesPath: string, input: RecordInput): void => {
  const entry: QueryLogEntry = {
    timestamp: new Date().toISOString(),
    tool: input.tool,
    queryText: input.queryText,
    filtersJson: input.filtersJson,
    resultCount: input.resultCount,
    hit: input.resultCount > 0,
    latencyMs: input.latencyMs,
    topQualifiedNames: input.topQualifiedNames,
  }
  try {
    const db = openQueryLog(queriesPath)
    try {
      insertQueryLogEntry(db, entry)
    } finally {
      db.close()
    }
  } catch {
    // Query logging is best-effort observability; never let it fail a real query.
  }
}

const topNames = (rows: readonly { readonly qualifiedName: string }[], count: number): readonly string[] =>
  rows.slice(0, count).map((row) => row.qualifiedName)

export const withQueryLogging = (
  deps: Readonly<CodeindexToolDeps>,
  config: CodeindexConfig,
): CodeindexToolDeps => {
  if (!config.logQueries) {
    return deps
  }
  const queriesPath = config.queriesPath
  return {
    codeSearch: async (input): Promise<Awaited<ReturnType<CodeindexToolDeps['codeSearch']>>> => {
      const started = Date.now()
      const results = await deps.codeSearch(input)
      record(queriesPath, {
        tool: 'code_search',
        queryText: input.query,
        filtersJson: JSON.stringify({
          kinds: input.kinds,
          scopeTiers: input.scopeTiers,
          pathPrefix: input.pathPrefix,
          limit: input.limit,
        }),
        resultCount: results.length,
        latencyMs: Date.now() - started,
        topQualifiedNames: topNames(results, 3),
      })
      return results
    },
    codeSymbol: async (query, limit): Promise<Awaited<ReturnType<CodeindexToolDeps['codeSymbol']>>> => {
      const started = Date.now()
      const results = await deps.codeSymbol(query, limit)
      record(queriesPath, {
        tool: 'code_symbol',
        queryText: query,
        filtersJson: JSON.stringify({ limit }),
        resultCount: results.length,
        latencyMs: Date.now() - started,
        topQualifiedNames: topNames(results, 3),
      })
      return results
    },
    codeImpact: async (input): Promise<Awaited<ReturnType<CodeindexToolDeps['codeImpact']>>> => {
      const started = Date.now()
      const results = await deps.codeImpact(input)
      const sourceNames = results
        .map((row) => row.sourceQualifiedName)
        .filter((name): name is string => name !== null)
      record(queriesPath, {
        tool: 'code_impact',
        queryText: input.qualifiedName === undefined ? (input.symbolKey ?? null) : input.qualifiedName,
        filtersJson: JSON.stringify({ limit: input.limit }),
        resultCount: results.length,
        latencyMs: Date.now() - started,
        topQualifiedNames: sourceNames.slice(0, 3),
      })
      return results
    },
    codeIndex: deps.codeIndex,
  }
}
```

Note on the return types: each wrapped arrow declares `Promise<Awaited<ReturnType<CodeindexToolDeps['<method>']>>>` to satisfy `explicit-function-return-type` while staying exactly compatible with the deps interface — do NOT loosen these to `any`. If tsgo objects that the `input` param is implicitly typed, annotate it as `Parameters<CodeindexToolDeps['codeSearch']>[0]` etc. If oxlint flags the empty `catch {}` body, the comment inside satisfies `no-empty`; keep the comment.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mcp/query-logging.test.ts`
Expected: PASS (3 tests) — including the "returns the real result even if logging cannot write" best-effort case.

- [ ] **Step 5: Wire the decorator into the MCP server**

In `src/cli.ts`, add the import (with the other local imports, `.js`):

```ts
import { withQueryLogging } from './mcp/query-logging.js'
```

Change `runMcpCommand` (line 79) from:

```ts
  const server = createCodeindexServer(buildMcpDeps(config))
```

to:

```ts
  const server = createCodeindexServer(withQueryLogging(buildMcpDeps(config), config))
```

- [ ] **Step 6: Add a protocol-level wiring test**

Append to `tests/mcp/query-logging.test.ts` a round-trip case that goes through a real `Client` (mirroring `tests/mcp/wiring.test.ts`), to prove the decorator logs when driven through the actual MCP boundary:

```ts
import { createCodeindexServer } from '../../src/mcp/server.js'
import { connectClient } from './harness.js'

describe('withQueryLogging through the protocol', () => {
  test('a callTool round-trip produces a log row', async () => {
    const config = configWith(true)
    const server = createCodeindexServer(withQueryLogging(stubDeps(), config))
    const client = await connectClient(server)
    await client.callTool({ name: 'code_search', arguments: { query: 'via protocol' } })
    const db = new Database(config.queriesPath)
    try {
      expect(readQueryLogStats(db).total).toBe(1)
    } finally {
      db.close()
    }
  })
})
```

(Add the two imports at the top of the file with the others.)

- [ ] **Step 7: Run the whole suite + gates**

Run: `bun run format && bun test tests && bun run lint && bun run typecheck && bun run format:check`
Expected: all PASS. Watch that `tests/mcp/protocol.test.ts` and `tests/mcp/wiring.test.ts` still pass — they build deps WITHOUT the decorator (or with `logQueries` unset). Note: those tests construct their own configs/deps and do not enable logging, so they are unaffected; if any real-config test now writes a `queries.db` into a temp dir, that's harmless and cleaned up with the temp dir.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/query-logging.ts src/cli.ts tests/mcp/query-logging.test.ts
git commit -m "feat(mcp): log MCP queries via a best-effort deps decorator"
```

---

### Task 4: `log-stats` CLI command

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/cli-log-stats.test.ts`

**Interfaces:**
- Consumes: `openQueryLog`/`readQueryLogStats` from `src/storage/query-log.ts`.
- Produces: a `log-stats` CLI command that prints `QueryLogStats` JSON for the configured `queriesPath`.

- [ ] **Step 1: Write the failing test**

Create `tests/cli-log-stats.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runLogStatsCommand } from '../src/cli.js'
import type { CodeindexConfig } from '../src/config.js'
import { insertQueryLogEntry, openQueryLog } from '../src/storage/query-log.js'

const configIn = (dir: string): CodeindexConfig => ({
  roots: ['src'],
  exclude: [],
  languages: ['ts'],
  dbPath: path.join(dir, 'index.db'),
  queriesPath: path.join(dir, 'queries.db'),
  logQueries: true,
  indexLocals: true,
  indexVariables: true,
  includeDocComments: true,
  maxStoredBodyLines: 120,
  tsconfigPaths: [path.join(dir, 'tsconfig.json')],
  repoRoot: dir,
  configPath: path.join(dir, '.codeindex.json'),
})

describe('runLogStatsCommand', () => {
  test('returns stats for the configured queries db', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-logstats-'))
    try {
      const config = configIn(dir)
      const db = openQueryLog(config.queriesPath)
      insertQueryLogEntry(db, {
        timestamp: '2026-07-21T00:00:00.000Z',
        tool: 'code_search',
        queryText: 'q',
        filtersJson: null,
        resultCount: 1,
        hit: true,
        latencyMs: 2,
        topQualifiedNames: [],
      })
      db.close()
      const stats = runLogStatsCommand(config)
      expect(stats.total).toBe(1)
      expect(stats.hits).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

Note: `runLogStatsCommand` is designed to RETURN the stats (and print them as a side effect) so it's testable — mirroring how the other `run*Command` functions could be tested, but this one returns its value for assertion. The `main` switch calls it and ignores the return.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli-log-stats.test.ts`
Expected: FAIL — `runLogStatsCommand` is not exported from `src/cli.ts`.

- [ ] **Step 3: Implement the command**

In `src/cli.ts`:

1. Add imports (with the others, `.js`):

```ts
import { openQueryLog, readQueryLogStats } from './storage/query-log.js'
import type { QueryLogStats } from './storage/query-log.js'
```

2. Add the command function (near `runStatsCommand`):

```ts
export const runLogStatsCommand = (config: CodeindexConfig): QueryLogStats => {
  const db = openQueryLog(config.queriesPath)
  try {
    const stats = readQueryLogStats(db)
    logJson(stats)
    return stats
  } finally {
    db.close()
  }
}
```

3. Add a `case` to the `main` switch (after `stats`):

```ts
    case 'log-stats':
      runLogStatsCommand(config)
      return
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli-log-stats.test.ts`
Expected: PASS.

- [ ] **Step 5: Whole suite + gates + real smoke**

Run: `bun run format && bun test tests && bun run lint && bun run typecheck && bun run format:check`
Expected: all PASS.

Real smoke (optional but recommended): `bun run start log-stats` against this repo — prints a `QueryLogStats` JSON (likely all zeros unless the MCP server has been exercised). Confirm it doesn't error when `queries.db` doesn't exist yet (`openQueryLog` creates it via `openDatabase`'s `{ create: true }` + `ensureQueryLogSchema`).

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts tests/cli-log-stats.test.ts
git commit -m "feat(cli): add log-stats command for query-log observability"
```

---

## Definition of done (this plan)

- `.codeindex/queries.db` receives one row per MCP `code_search`/`code_symbol`/`code_impact` call (tool, query text, filters, result count, hit, latency, top result names), when `logQueries` is on (default).
- Logging is best-effort: a logging failure never fails a query (proven by a test).
- `logQueries: false` fully disables logging; `code_index` is never logged.
- `readQueryLogStats` + `bun run start log-stats` expose count, hit rate, latency percentiles, and top queries.
- The stored shape supports later corpus mining (query text + tool→kind + top qualified names).
- `bun test tests`, `bun run lint`, `bun run typecheck`, `bun run format:check` all pass.

## Deferred to sibling / later plans (do NOT do here)

- **Mining logged queries into the `bench/` golden corpus** — depends on this store; its own plan.
- Logging CLI (`search`/`symbol`/`impact`) queries — MCP-only for now.
- Log rotation / retention / size caps — not needed at dev-session volumes yet.
- A richer observability surface (per-tool breakdowns, time-series) beyond the `log-stats` summary.
