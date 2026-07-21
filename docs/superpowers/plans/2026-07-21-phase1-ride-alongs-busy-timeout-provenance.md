# Phase 1 · Ride-Alongs: busy_timeout + Index Provenance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the two low-risk Phase 1 "ride-alongs": set SQLite `busy_timeout` so concurrent access waits instead of throwing `SQLITE_BUSY`, and stamp index provenance (git commit + branch + config identity + timestamp) into the index so branch/worktree drift is detectable rather than silently wrong.

**Architecture:** `busy_timeout` is one PRAGMA added at the single `openDatabase` choke point. Provenance adds a single-row `index_meta` table to the schema, a git-reading utility (`src/indexer/git-info.ts`), a config-identity hash (`computeConfigIdentity` in `src/config.ts`), and storage read/write helpers (`src/storage/provenance.ts`); `indexCodebase` assembles and writes the stamp after a successful index. Layering stays one-directional: indexer → storage/config; storage/provenance depends on neither.

**Tech Stack:** Bun, `bun:sqlite`, `bun:test`, `Bun.spawnSync` (git), `node:crypto` (sha256), zod v4, TypeScript (strict, NodeNext-style `.js` import specifiers), oxlint + oxfmt.

## Context: where this sits

Phase 1 ride-alongs from `docs/superpowers/specs/2026-07-20-codeindex-roadmap-design.md` ("Ride-alongs"). The roadmap owns two cross-cutting risks here: "Concurrent multi-agent DB access unstudied" (→ `busy_timeout`) and "Stale-index / branch-drift has no owner" (→ provenance). Phase 1's remaining components (query logging, indexing benchmark, edit-sequence fuzzer) are **separate plans, out of scope here**.

## Global Constraints

Every task's requirements implicitly include this section. Values copied from the repo:

- **Runtime/tests:** Bun. Tests use `bun:test` (`import { describe, expect, test } from 'bun:test'`), run via `bun test tests`.
- **Imports:** ESM only. **All local import specifiers must end in `.js`** (`import/extensions: ["error","always"]`). `node:*`/`bun:*` builtins take no `.js`.
- **Type-only imports** must use `import type` (`verbatimModuleSyntax: true`).
- **No optional chaining** anywhere (`oxc/no-optional-chaining: error`) — use explicit `!== undefined` / `!== null` checks. `??` (nullish coalescing) IS allowed.
- **No `any`** (`typescript/no-explicit-any`). **No unsafe type assertions** — oxlint's type-aware `pedantic` category includes `no-unsafe-type-assertion`; do NOT write `JSON.parse(x) as T`. For JSON TEXT columns, reuse the repo's existing safe parser (see Task 3).
- **Explicit return types** on every function. **No param reassignment** (`eslint/no-param-reassign`) — reassign locals only. No classes; functional style; `readonly` fields.
- **TS strictness:** `strict`, `noUncheckedIndexedAccess` (indexed access is `T | undefined` — guard it), `noUnusedLocals/Parameters`, `noPropertyAccessFromIndexSignature`.
- **Lint/format/typecheck gates:** `bun run lint`, `bun run typecheck`, `bun run format:check` must all pass. **Run `bun run format` after writing/editing any file.** This applies to every task even where a step doesn't restate it.

## Key facts about the code (verified against source)

- `src/storage/db.ts` (whole file) — `openDatabase(dbPath): Database` opens `new Database(dbPath, { create: true })` then `db.run('PRAGMA journal_mode = WAL;')` and `db.run('PRAGMA foreign_keys = ON;')`. This is the single choke point for all real (file-backed) access (CLI `withDatabase`, MCP, `indexCodebase`, `bench/run.ts`). Tests that use `new Database(':memory:')` directly bypass it (fine — `busy_timeout` only matters for file-backed concurrent access).
- PRAGMA idioms already in the repo: set-only via `db.run('PRAGMA … = …;')`; read-back via `db.query<{ user_version: number }, []>('PRAGMA user_version').get()!`.
- `src/storage/schema.ts` — `ensureSchema(db)` at line 126: if `PRAGMA user_version < SCHEMA_VERSION`, drops every table in `DROP_ORDER` (line 118), then runs `schemaStatements` + `ftsStatements`, then sets `PRAGMA user_version = SCHEMA_VERSION`. `SCHEMA_VERSION = 1` (line 116). Tables today: `files`, `module_aliases`, `symbols`, `module_exports`, `symbol_references`, `symbol_fts` (+ triggers). No metadata table exists.
- `src/indexer/index-codebase.ts` — `indexCodebase(input)` (line 253): opens db (255), `ensureSchema` (256), processes files, `persistResolvedReferences` (282), `db.close()` (283), returns `IndexSummary` (285-293). `input.config` (`CodeindexConfig`) carries `repoRoot`. `Date.now()` is already used here (line 254) — normal source may use `Date`/`new Date()`.
- `src/config.ts` — `CodeindexConfig` (line 20) is `Readonly<z.infer<typeof CodeindexConfigSchema> & { repoRoot; configPath; dbPath; roots; tsconfigPaths }>`. Behavior-affecting fields: `roots`, `exclude`, `languages`, `indexLocals`, `indexVariables`, `includeDocComments`, `maxStoredBodyLines`, `tsconfigPaths`. No git utility exists anywhere in `src/` (grep confirmed).
- `src/storage/queries.ts` contains an existing helper for parsing JSON string-array TEXT columns (the same convention `export_names`/`identifier_terms` use). Task 3 reuses it — read `queries.ts` to get its exact name/signature; export it if it isn't already exported. Do NOT hand-roll `JSON.parse(...) as string[]`.
- Test conventions: `tests/storage/schema.test.ts` builds `new Database(':memory:')` + `ensureSchema` + asserts via `PRAGMA table_info(...)`/`sqlite_master`. `tests/index-codebase.test.ts` builds a real temp dir via `mkdtempSync(path.join(tmpdir(), 'codeindex-index-'))` (NOT git-initialized), writes source + `.codeindex.json`, runs `loadCodeindexConfig` + `indexCodebase`.

---

## File Structure

Created by this plan:

- `src/indexer/git-info.ts` — `readGitInfo(repoRoot): GitInfo` (`{ commit: string | null; branch: string | null }`), shelling out to git, null on any failure.
- `src/storage/provenance.ts` — `IndexProvenance` type, `writeIndexProvenance(db, provenance)`, `getIndexProvenance(db): IndexProvenance | null`.
- `tests/storage/db.test.ts` — busy_timeout is set.
- `tests/indexer/git-info.test.ts` — `readGitInfo` against the real repo and a non-git temp dir.
- `tests/storage/provenance.test.ts` — write/read round-trip + `computeConfigIdentity`.
- `tests/indexer/provenance-integration.test.ts` — `indexCodebase` stamps provenance end-to-end.

Modified:

- `src/storage/db.ts` — add `BUSY_TIMEOUT_MS` const + the PRAGMA.
- `src/config.ts` — add `computeConfigIdentity(config): string`.
- `src/storage/schema.ts` — add `index_meta` table to `schemaStatements`; add `'index_meta'` to `DROP_ORDER`; bump `SCHEMA_VERSION` to `2`.
- `src/indexer/index-codebase.ts` — assemble + `writeIndexProvenance` before `db.close()`.
- `src/storage/queries.ts` — export the existing JSON-array parser if needed (Task 3).

---

### Task 1: Set `busy_timeout`

**Files:**
- Modify: `src/storage/db.ts`
- Test: `tests/storage/db.test.ts`

**Interfaces:**
- Produces: no API change — `openDatabase` now additionally sets `PRAGMA busy_timeout = 5000`.

- [ ] **Step 1: Write the failing test**

Create `tests/storage/db.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

import { openDatabase } from '../../src/storage/db.js'

describe('openDatabase', () => {
  test('sets busy_timeout to 5000ms', () => {
    const db = openDatabase(':memory:')
    try {
      const row = db.query<{ timeout: number }, []>('PRAGMA busy_timeout').get()
      expect(row).not.toBeNull()
      expect(row!.timeout).toBe(5000)
    } finally {
      db.close()
    }
  })

  test('enables WAL journal mode for a file-backed db', () => {
    const db = openDatabase(':memory:')
    try {
      const row = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()
      expect(row).not.toBeNull()
      // :memory: reports 'memory'; the PRAGMA call itself must not throw and the row must exist.
      expect(typeof row!.journal_mode).toBe('string')
    } finally {
      db.close()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/storage/db.test.ts`
Expected: FAIL on the busy_timeout assertion — default `busy_timeout` is `0`, not `5000`.

- [ ] **Step 3: Add the PRAGMA**

In `src/storage/db.ts`, add a module const and the PRAGMA. Change:

```ts
import { Database } from 'bun:sqlite'

export const openDatabase = (dbPath: string): Database => {
  const db = new Database(dbPath, { create: true })
  db.run('PRAGMA journal_mode = WAL;')
  db.run('PRAGMA foreign_keys = ON;')
  return db
}
```

to:

```ts
import { Database } from 'bun:sqlite'

const BUSY_TIMEOUT_MS = 5000

export const openDatabase = (dbPath: string): Database => {
  const db = new Database(dbPath, { create: true })
  db.run('PRAGMA journal_mode = WAL;')
  db.run('PRAGMA foreign_keys = ON;')
  db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`)
  return db
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/storage/db.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Verify gates**

Run: `bun run format && bun run lint && bun run typecheck && bun run format:check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/storage/db.ts tests/storage/db.test.ts
git commit -m "feat(storage): set SQLite busy_timeout to avoid SQLITE_BUSY under concurrency"
```

---

### Task 2: Provenance inputs — git info + config identity

**Files:**
- Create: `src/indexer/git-info.ts`
- Modify: `src/config.ts`
- Test: `tests/indexer/git-info.test.ts`
- Test: `tests/config-identity.test.ts`

**Interfaces:**
- Produces: `readGitInfo(repoRoot: string): GitInfo` where `GitInfo = { readonly commit: string | null; readonly branch: string | null }`; `computeConfigIdentity(config: CodeindexConfig): string` (a sha256 hex of the behavior-affecting config fields).

- [ ] **Step 1: Write the failing tests**

Create `tests/indexer/git-info.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { readGitInfo } from '../../src/indexer/git-info.js'

describe('readGitInfo', () => {
  test('reads commit and branch from a real git repo', () => {
    const info = readGitInfo(process.cwd())
    const expectedCommit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: process.cwd() }).stdout.toString().trim()
    expect(info.commit).toBe(expectedCommit)
    expect(info.commit).not.toBeNull()
    expect(info.branch).not.toBeNull()
  })

  test('returns null fields for a non-git directory', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-nogit-'))
    try {
      const info = readGitInfo(dir)
      expect(info.commit).toBeNull()
      expect(info.branch).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

Create `tests/config-identity.test.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { computeConfigIdentity, loadCodeindexConfig } from '../src/config.js'

const tempDirs: string[] = []

const configFor = async (raw: Record<string, unknown>): Promise<Awaited<ReturnType<typeof loadCodeindexConfig>>> => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-identity-'))
  tempDirs.push(dir)
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify(raw))
  return loadCodeindexConfig({ configPath: path.join(dir, '.codeindex.json'), repoRoot: dir })
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('computeConfigIdentity', () => {
  test('is stable for the same behavior-affecting settings', async () => {
    const a = await configFor({ roots: ['src'] })
    const b = await configFor({ roots: ['src'] })
    expect(computeConfigIdentity(a)).toBe(computeConfigIdentity(b))
  })

  test('changes when a behavior-affecting field changes', async () => {
    const a = await configFor({ roots: ['src'] })
    const b = await configFor({ roots: ['src', 'lib'] })
    expect(computeConfigIdentity(a)).not.toBe(computeConfigIdentity(b))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/indexer/git-info.test.ts tests/config-identity.test.ts`
Expected: FAIL — `readGitInfo` and `computeConfigIdentity` don't exist yet.

- [ ] **Step 3: Implement `readGitInfo`**

Create `src/indexer/git-info.ts`:

```ts
export interface GitInfo {
  readonly commit: string | null
  readonly branch: string | null
}

const runGit = (args: readonly string[], repoRoot: string): string | null => {
  try {
    const result = Bun.spawnSync(['git', ...args], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) {
      return null
    }
    const text = result.stdout.toString().trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

export const readGitInfo = (repoRoot: string): GitInfo => ({
  commit: runGit(['rev-parse', 'HEAD'], repoRoot),
  branch: runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot),
})
```

- [ ] **Step 4: Implement `computeConfigIdentity`**

In `src/config.ts`, add an import of `createHash` and the function. At the top with the other imports:

```ts
import { createHash } from 'node:crypto'
```

and (after the `CodeindexConfig` type is defined) add:

```ts
export const computeConfigIdentity = (config: CodeindexConfig): string => {
  const identity = {
    roots: config.roots,
    exclude: config.exclude,
    languages: config.languages,
    indexLocals: config.indexLocals,
    indexVariables: config.indexVariables,
    includeDocComments: config.includeDocComments,
    maxStoredBodyLines: config.maxStoredBodyLines,
    tsconfigPaths: config.tsconfigPaths,
  }
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}
```

Note: this deliberately excludes `repoRoot`/`configPath`/`dbPath` (path-derived, environment-specific) so the identity reflects *indexing behavior*, not where the repo lives. Confirm each referenced field exists on `CodeindexConfig` (read `src/config.ts` — all eight are in `CodeindexConfigSchema`). If a field is optional/defaulted such that it's `undefined`, `JSON.stringify` drops it consistently, which is fine.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/indexer/git-info.test.ts tests/config-identity.test.ts`
Expected: PASS. (The git test runs against this repo, which is a git repo; the commit is compared against a fresh `git rev-parse HEAD`, so it stays correct across commits.)

- [ ] **Step 6: Verify gates**

Run: `bun run format && bun run lint && bun run typecheck && bun run format:check`
Expected: PASS. If oxlint flags `result.stdout.toString()` as unsafe, note it — `SyncSubprocess.stdout` is a `Buffer` under `stdout: 'pipe'`, so `.toString()` is safe and typed; do not add `any`.

- [ ] **Step 7: Commit**

```bash
git add src/indexer/git-info.ts src/config.ts tests/indexer/git-info.test.ts tests/config-identity.test.ts
git commit -m "feat(indexer): add git-info reader and config-identity hash for provenance"
```

---

### Task 3: Provenance storage + wire into indexing

**Files:**
- Create: `src/storage/provenance.ts`
- Modify: `src/storage/schema.ts` (add `index_meta`; add to `DROP_ORDER`; bump `SCHEMA_VERSION`)
- Modify: `src/storage/queries.ts` (export the JSON-array parser if not exported)
- Modify: `src/indexer/index-codebase.ts` (write provenance before `db.close()`)
- Test: `tests/storage/provenance.test.ts`
- Test: `tests/indexer/provenance-integration.test.ts`

**Interfaces:**
- Consumes: `readGitInfo` (Task 2), `computeConfigIdentity` (Task 2), the JSON-array parser from `src/storage/queries.ts`.
- Produces: `IndexProvenance` (`{ gitCommit: string | null; gitBranch: string | null; configHash: string; roots: readonly string[]; languages: readonly string[]; indexedAt: string }`), `writeIndexProvenance(db, provenance): void`, `getIndexProvenance(db): IndexProvenance | null`.

- [ ] **Step 1: Add the `index_meta` table + bump the schema version**

In `src/storage/schema.ts`:

1. Add this `CREATE TABLE` to the `schemaStatements` array (place it near the other tables, before the FTS section):

```sql
CREATE TABLE IF NOT EXISTS index_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  git_commit TEXT,
  git_branch TEXT,
  config_hash TEXT NOT NULL,
  roots TEXT NOT NULL,
  languages TEXT NOT NULL,
  indexed_at TEXT NOT NULL
)
```

(As a template-string entry in the `schemaStatements` array, matching the existing entries' style.)

2. Add `'index_meta'` to the front of `DROP_ORDER` (line 118): `const DROP_ORDER = ['index_meta', 'symbol_fts', 'symbol_references', 'module_exports', 'symbols', 'module_aliases', 'files']`.

3. Bump `SCHEMA_VERSION` from `1` to `2` (line 116). (Existing DBs will destructively rebuild on next `ensureSchema`; `index_meta` has no FK dependencies, so its `DROP_ORDER` position is not load-bearing — front is fine.)

- [ ] **Step 2: Write the provenance storage round-trip test**

Create `tests/storage/provenance.test.ts`:

```ts
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { getIndexProvenance, writeIndexProvenance } from '../../src/storage/provenance.js'
import { ensureSchema } from '../../src/storage/schema.js'

describe('index provenance storage', () => {
  test('getIndexProvenance returns null before any stamp', () => {
    const db = new Database(':memory:')
    try {
      ensureSchema(db)
      expect(getIndexProvenance(db)).toBeNull()
    } finally {
      db.close()
    }
  })

  test('write then read round-trips all fields', () => {
    const db = new Database(':memory:')
    try {
      ensureSchema(db)
      writeIndexProvenance(db, {
        gitCommit: 'abc123',
        gitBranch: 'main',
        configHash: 'hash-xyz',
        roots: ['src', 'lib'],
        languages: ['ts', 'tsx'],
        indexedAt: '2026-07-21T00:00:00.000Z',
      })
      const provenance = getIndexProvenance(db)
      expect(provenance).not.toBeNull()
      expect(provenance!.gitCommit).toBe('abc123')
      expect(provenance!.gitBranch).toBe('main')
      expect(provenance!.configHash).toBe('hash-xyz')
      expect(provenance!.roots).toEqual(['src', 'lib'])
      expect(provenance!.languages).toEqual(['ts', 'tsx'])
      expect(provenance!.indexedAt).toBe('2026-07-21T00:00:00.000Z')
    } finally {
      db.close()
    }
  })

  test('writing again replaces the single row (id stays 1)', () => {
    const db = new Database(':memory:')
    try {
      ensureSchema(db)
      writeIndexProvenance(db, { gitCommit: null, gitBranch: null, configHash: 'h1', roots: ['src'], languages: ['ts'], indexedAt: 't1' })
      writeIndexProvenance(db, { gitCommit: 'c2', gitBranch: 'b2', configHash: 'h2', roots: ['src'], languages: ['ts'], indexedAt: 't2' })
      const count = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM index_meta').get()
      expect(count).not.toBeNull()
      expect(count!.n).toBe(1)
      expect(getIndexProvenance(db)!.configHash).toBe('h2')
    } finally {
      db.close()
    }
  })
})
```

- [ ] **Step 3: Run the storage test to verify it fails**

Run: `bun test tests/storage/provenance.test.ts`
Expected: FAIL — `src/storage/provenance.js` does not exist.

- [ ] **Step 4: Implement provenance storage**

First, read `src/storage/queries.ts` and find its existing helper that parses a JSON string-array TEXT column (used for columns like `export_names`). If it is exported, import it. If it is NOT exported, export it (add `export` to its declaration — a safe additive change). Note its exact name; the code below assumes `parseStringArray(value: string): string[]` — adjust the import/call to the real name.

Create `src/storage/provenance.ts`:

```ts
import type { Database } from 'bun:sqlite'

import { parseStringArray } from './queries.js'

export interface IndexProvenance {
  readonly gitCommit: string | null
  readonly gitBranch: string | null
  readonly configHash: string
  readonly roots: readonly string[]
  readonly languages: readonly string[]
  readonly indexedAt: string
}

export const writeIndexProvenance = (db: Database, provenance: IndexProvenance): void => {
  db.query(
    `INSERT OR REPLACE INTO index_meta (id, git_commit, git_branch, config_hash, roots, languages, indexed_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    provenance.gitCommit,
    provenance.gitBranch,
    provenance.configHash,
    JSON.stringify(provenance.roots),
    JSON.stringify(provenance.languages),
    provenance.indexedAt,
  )
}

interface IndexMetaRow {
  readonly git_commit: string | null
  readonly git_branch: string | null
  readonly config_hash: string
  readonly roots: string
  readonly languages: string
  readonly indexed_at: string
}

export const getIndexProvenance = (db: Database): IndexProvenance | null => {
  const row = db
    .query<IndexMetaRow, []>(
      'SELECT git_commit, git_branch, config_hash, roots, languages, indexed_at FROM index_meta WHERE id = 1',
    )
    .get()
  if (row === null) {
    return null
  }
  return {
    gitCommit: row.git_commit,
    gitBranch: row.git_branch,
    configHash: row.config_hash,
    roots: parseStringArray(row.roots),
    languages: parseStringArray(row.languages),
    indexedAt: row.indexed_at,
  }
}
```

If `parseStringArray`'s real name/signature differs (e.g. it returns `readonly string[]` or takes a nullable), adjust the calls accordingly — the goal is to reuse the repo's lint-clean JSON-array parser rather than `JSON.parse(...) as string[]`.

- [ ] **Step 5: Run the storage test to verify it passes**

Run: `bun test tests/storage/provenance.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the integration test**

Create `tests/indexer/provenance-integration.test.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadCodeindexConfig, computeConfigIdentity } from '../../src/config.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import { getIndexProvenance } from '../../src/storage/provenance.js'
import { openDatabase } from '../../src/storage/db.js'

const tempDirs: string[] = []

const makeRepo = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-prov-'))
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

describe('indexCodebase writes provenance', () => {
  test('stamps config identity + timestamp; git fields null for a non-git repo', async () => {
    const repo = makeRepo()
    const config = await loadCodeindexConfig({ configPath: path.join(repo, '.codeindex.json'), repoRoot: repo })
    await indexCodebase({ config, mode: 'full' })
    const db = openDatabase(config.dbPath)
    try {
      const provenance = getIndexProvenance(db)
      expect(provenance).not.toBeNull()
      expect(provenance!.configHash).toBe(computeConfigIdentity(config))
      expect(provenance!.roots).toEqual(['src'])
      expect(provenance!.gitCommit).toBeNull()
      expect(provenance!.gitBranch).toBeNull()
      expect(provenance!.indexedAt.length).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })
})
```

- [ ] **Step 7: Run the integration test to verify it fails**

Run: `bun test tests/indexer/provenance-integration.test.ts`
Expected: FAIL — `indexCodebase` does not write provenance yet, so `getIndexProvenance` returns `null`.

- [ ] **Step 8: Wire provenance into `indexCodebase`**

In `src/indexer/index-codebase.ts`:

1. Add imports (with the other imports, `.js` suffixed):

```ts
import { readGitInfo } from './git-info.js'
import { writeIndexProvenance } from '../storage/provenance.js'
import { computeConfigIdentity } from '../config.js'
```

(Check whether `computeConfigIdentity` can be added to an existing `../config.js` import line rather than a new one — if `index-codebase.ts` already imports from `../config.js`, merge it. Confirm no duplicate import.)

2. Between `persistResolvedReferences` (line 282) and `db.close()` (line 283), insert:

```ts
  const gitInfo = readGitInfo(input.config.repoRoot)
  writeIndexProvenance(db, {
    gitCommit: gitInfo.commit,
    gitBranch: gitInfo.branch,
    configHash: computeConfigIdentity(input.config),
    roots: input.config.roots,
    languages: input.config.languages,
    indexedAt: new Date().toISOString(),
  })
```

- [ ] **Step 9: Run the integration test to verify it passes**

Run: `bun test tests/indexer/provenance-integration.test.ts`
Expected: PASS.

- [ ] **Step 10: Run the whole suite + gates**

Run: `bun run format && bun test tests && bun run lint && bun run typecheck && bun run format:check`
Expected: all PASS. The `SCHEMA_VERSION` bump to `2` means `ensureSchema` rebuilds pre-existing schemas — confirm `tests/storage/schema.test.ts` (which exercises the migration path) still passes. If that test hardcodes the version number or the exact `DROP_ORDER`/table set, update its expectations to include `index_meta` and version `2`.

- [ ] **Step 11: Commit**

```bash
git add src/storage/provenance.ts src/storage/schema.ts src/storage/queries.ts src/indexer/index-codebase.ts tests/storage/provenance.test.ts tests/indexer/provenance-integration.test.ts
git commit -m "feat(indexer): stamp git + config provenance into the index"
```

---

## Definition of done (this plan)

- `openDatabase` sets `busy_timeout = 5000`; a test asserts it.
- Every successful `indexCodebase` writes an `index_meta` row: git commit + branch (null when not a git repo), config-identity hash, roots, languages, and an ISO timestamp. `getIndexProvenance(db)` reads it back.
- `readGitInfo` degrades gracefully (null fields) outside a git repo and never throws.
- `bun test tests`, `bun run lint`, `bun run typecheck`, `bun run format:check` all pass.

## Deferred to sibling Phase 1 plans (do NOT do here)

- **Query logging / observability**, **indexing throughput/latency benchmark**, **edit-sequence integrity fuzzer** — separate plans.
- Surfacing provenance through the MCP/CLI layer (e.g. a `code_provenance` tool or a `stats` addition) — not required by the roadmap ride-along, which only asks that drift be *detectable* (stored + readable). A consumer-facing surface can be a later, evidence-driven addition.
- Using `config_hash`/git drift to auto-trigger reindex or warn — detection only for now.
