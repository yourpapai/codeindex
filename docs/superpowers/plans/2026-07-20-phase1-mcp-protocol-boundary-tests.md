# Phase 1 · MCP Protocol-Boundary Tests + code_index DB-Target Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first tests that cross the real MCP SDK boundary (a live `Client` calling `listTools`/`callTool` over an in-memory transport against `createCodeindexServer`), and fix the confirmed `code_index` DB-target wiring bug so all four tools operate on the one repo the server is bound to.

**Architecture:** Tests connect a real `@modelcontextprotocol/sdk` `Client` to the real server via `InMemoryTransport.createLinkedPair()` — no subprocess. Two suites: (1) a protocol suite driving all four tools with injected in-memory-DB deps (happy paths, the empty-result `guidance` string, and error/validation paths that surface as `isError: true`); (2) a wiring suite that exercises the **real** `buildMcpDeps` from `src/cli.ts` against on-disk temp repos to pin the DB-target bug. The fix removes `code_index`'s `path` parameter so it indexes the server's startup-bound repo (the closed-over `config`) exactly like the read tools — aligning the code with CLAUDE.md's existing "always operates on the caller's cwd" contract.

**Tech Stack:** Bun, `bun:sqlite`, `bun:test`, `@modelcontextprotocol/sdk` `^1.29.0` (`Client`, `InMemoryTransport`), zod v4, TypeScript (strict, NodeNext-style `.js` import specifiers), oxlint + oxfmt.

## Context: where this sits

This is a **Phase 1 harness component** from `docs/superpowers/specs/2026-07-20-codeindex-roadmap-design.md` (component 3, "Protocol-boundary tests"). Phase 1's other instruments — query logging, the edit-sequence fuzzer, the indexing benchmark, and the `busy_timeout`/provenance ride-alongs — are **separate plans, out of scope here**. The IR-relevance harness (component 1) is already built (`bench/`). This plan delivers the first real MCP-boundary coverage and fixes the one confirmed correctness bug it exposes.

## Global Constraints

Every task's requirements implicitly include this section. Values copied from the repo:

- **Runtime/tests:** Bun. Tests use `bun:test` (`import { describe, expect, test } from 'bun:test'`), run via `bun test tests`.
- **Imports:** ESM only. **All import specifiers must end in `.js`** (`import/extensions: ["error","always"]`), including local ones. SDK subpath imports also end in `.js` (e.g. `@modelcontextprotocol/sdk/client/index.js`, `@modelcontextprotocol/sdk/inMemory.js`).
- **Type-only imports** must use `import type` (`verbatimModuleSyntax: true`).
- **No optional chaining** anywhere (`oxc/no-optional-chaining: error`) — use explicit `!== undefined` / `!== null` checks.
- **No barrel files** for new files (`oxc/no-barrel-file: error`). (The existing `src/mcp.ts` barrel is out of scope — do not touch it.)
- **Explicit return types** on every function (`typescript/explicit-function-return-type` + `explicit-module-boundary-types`). Note: the `tests/**/*.ts` oxlint override relaxes `max-lines`/`max-lines-per-function`/`no-await-in-loop` but NOT the return-type or import rules — test helper functions still need explicit return types and `.js` imports.
- **No `any`** (`typescript/no-explicit-any`). **No param reassignment** (`eslint/no-param-reassign`) — reassign locals only.
- **TS strictness:** `strict`, `noUncheckedIndexedAccess` (array/tuple access is `T | undefined` — guard it), `noUnusedLocals/Parameters`, `noPropertyAccessFromIndexSignature`.
- **Functional style:** exported `const` arrow functions, `readonly` fields, no classes.
- **Lint/format/typecheck gates:** `bun run lint`, `bun run typecheck`, `bun run format:check` must all pass (all already include `src tests bench`). **Run `bun run format` after writing/editing any file** so oxfmt output matches — otherwise `format:check` fails. This applies to every task even where a step doesn't restate it.
- **qualifiedName format:** `` `${moduleKey}#${localName}` `` where `moduleKey` is the POSIX, extension-stripped path relative to repo root.

## Key facts about the code under test (verified against source)

- `createCodeindexServer(deps: Readonly<CodeindexToolDeps>): McpServer` — `src/mcp/server.ts:89`. DI-based; registers tools `code_search`, `code_symbol`, `code_impact`, `code_index`.
- Every tool result is built by `buildStructuredToolResult` (`src/mcp/tools.ts:108`): `{ content: [{ type: 'text', text: JSON.stringify(parsed) }], structuredContent: parsed }`.
- `code_search` sets `guidance` iff `results.length === 0` (`src/mcp/server.ts:30-33`). `code_symbol` has no guidance field.
- `code_impact` input has a zod `.refine` requiring `symbolKey` OR `qualifiedName` (`src/mcp/tools.ts:48`).
- **Error surfacing:** the SDK's `McpServer` catches handler throws AND input-schema-validation failures and returns a normal `CallToolResult` with `isError: true` and `content[0].text` = the message. Tests assert on `result.isError === true`, NOT a rejected promise. (Client-side output-schema validation only runs after `listTools()` caches validators — irrelevant to these tests.)
- **The bug** (`src/cli.ts:65-84`, `buildMcpDeps`): `codeSearch`/`codeSymbol`/`codeImpact` close over the startup `config` and always open `config.dbPath`. `codeIndex` instead calls `loadConfigForPath(targetPath)` per-call and indexes THAT repo's DB. So `code_index(path=B)` writes repo B's DB while the read tools keep reading the startup repo's DB.
- `buildMcpDeps` and `runMcpCommand` are currently NOT exported from `src/cli.ts` (only `resolveRepoRoot` and `loadConfigForPath` are).
- **`src/cli.ts` runs `main()` as an unguarded top-level side effect** (`void main().catch(...)` at the file's end). Importing `src/cli.js` therefore executes the CLI: `tests/cli.test.ts` already imports from it, and this is the source of the stray `filesIndexed: …` JSON block printed during `bun test` (main() defaults to the `index` command and indexes the codeindex repo on import). Task 3 wraps `main()` in an `import.meta.main` guard so the module is safely importable — required before the wiring test can import `buildMcpDeps`. Bun sets `import.meta.main` to `true` only when the file is the entry point (`bun run src/cli.ts …`), so the CLI keeps working while imports become side-effect-free.
- `ensureSchema(db: Database): void` — `src/storage/schema.ts`. `openDatabase(dbPath: string): Database` — `src/storage/db.ts`. `loadCodeindexConfig({ configPath, repoRoot }): Promise<CodeindexConfig>` with `config.dbPath` — `src/config.ts`. `indexCodebase({ config, mode }): Promise<IndexSummary>` — `src/indexer/index-codebase.ts`.
- Existing thin smoke tests `tests/mcp.test.ts` and `tests/mcp/server.test.ts` each just assert `createCodeindexServer({...stub}) ` is defined. Leave them as-is (out of scope); the new suites supersede them in value without deleting them.

---

## File Structure

Created by this plan:

- `tests/mcp/harness.ts` — shared test helper: `connectClient(server)` wiring a `Client` to a server via `InMemoryTransport`, plus a `makeInMemoryDeps(db)` builder returning `CodeindexToolDeps` backed by a `bun:sqlite` `:memory:` DB. (Helper module for tests — not a barrel, exports named helpers only.)
- `tests/mcp/protocol.test.ts` — Client/`callTool`/`listTools` round-trips for all four tools with injected in-memory-DB deps: happy paths, `code_search` empty-result guidance, `code_symbol` no-guidance, `code_impact` refine-validation error, missing-required-field validation error.
- `tests/mcp/wiring.test.ts` — exercises the REAL `buildMcpDeps` against on-disk temp repos to pin the DB-target bug and prove the fix.

Modified:

- `src/mcp/tools.ts` — remove `path` from `CodeIndexInputSchema` and from `CodeindexToolDeps.codeIndex`'s input type.
- `src/mcp/server.ts:82-84` — `registerIndexTool` handler stops destructuring/forwarding `path`.
- `src/cli.ts` — `buildMcpDeps.codeIndex` indexes the closed-over startup `config` (drop `loadConfigForPath(targetPath)`); export `buildMcpDeps` for the wiring test.

---

### Task 1: Protocol test harness

**Files:**
- Create: `tests/mcp/harness.ts`

**Interfaces:**
- Produces: `connectClient(server: McpServer): Promise<Client>` (connects a fresh `Client` to `server` over an in-memory linked pair and returns the connected client); `makeInMemoryDeps(db: Database): CodeindexToolDeps` (builds tool deps backed by the given DB using the real `searchSymbols`/`findSymbolCandidates`/`findIncomingReferences`, and a `codeIndex` stub that returns a zeroed `IndexSummary` — the protocol suite does not index); `seedSymbol(db, {...})` and `seedFile(db, {...})` helpers mirroring the existing `tests/bench/harness.test.ts` seeding style.

This is not TDD-first (it is test infrastructure with no behavior of its own); it is validated by Task 2 consuming it. Keep it minimal.

- [ ] **Step 1: Write the harness**

Create `tests/mcp/harness.ts`:

```ts
import type { Database } from 'bun:sqlite'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { findIncomingReferences, findSymbolCandidates, searchSymbols } from '../../src/search/index.js'
import type { CodeindexToolDeps } from '../../src/mcp/tools.js'
import type { IndexSummary } from '../../src/indexer/index-codebase.js'

export const connectClient = async (server: McpServer): Promise<Client> => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return client
}

const emptySummary: IndexSummary = {
  filesIndexed: 0,
  filesFailed: 0,
  filesPruned: 0,
  symbolsIndexed: 0,
  referencesIndexed: 0,
  referencesUnresolved: 0,
  elapsedMs: 0,
}

export const makeInMemoryDeps = (db: Database): CodeindexToolDeps => ({
  codeSearch: (input: Parameters<typeof searchSymbols>[1]): Promise<ReturnType<typeof searchSymbols>> =>
    Promise.resolve(searchSymbols(db, input)),
  codeSymbol: (query: string, limit: number): Promise<ReturnType<typeof findSymbolCandidates>> =>
    Promise.resolve(findSymbolCandidates(db, query, limit)),
  codeImpact: (
    input: Parameters<typeof findIncomingReferences>[1],
  ): Promise<ReturnType<typeof findIncomingReferences>> => Promise.resolve(findIncomingReferences(db, input)),
  codeIndex: (): Promise<IndexSummary> => Promise.resolve(emptySummary),
})

export interface SeedFile {
  readonly id: number
  readonly filePath: string
  readonly moduleKey: string
}

export const seedFile = (db: Database, file: SeedFile): void => {
  db.query(
    `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at)
     VALUES (?, ?, ?, 'ts', 'x', 'indexed', NULL, datetime('now'))`,
  ).run(file.id, file.filePath, file.moduleKey)
}

export interface SeedSymbol {
  readonly id: number
  readonly fileId: number
  readonly filePath: string
  readonly moduleKey: string
  readonly localName: string
  readonly qualifiedName: string
}

export const seedSymbol = (db: Database, symbol: SeedSymbol): void => {
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
```

Note: the arrow annotations mirror the existing `buildMcpDeps` in `src/cli.ts` (which lints cleanly), so `Parameters<typeof searchSymbols>[1]` / `ReturnType<typeof searchSymbols>` etc. are known-good. `findSymbolCandidates`, `searchSymbols`, `findIncomingReferences` are all exported from `src/search/index.ts` (same as `src/cli.ts:9`). Do NOT use `any`.

- [ ] **Step 2: Verify it typechecks and lints**

Run: `bun run format && bun run typecheck && bun run lint`
Expected: PASS. (No test runs yet — Task 2 exercises the harness. If `findSymbolCandidates`'s return type is not assignable to `codeSymbol`'s declared union, check `src/search/index.ts` for its exact signature and adjust the annotation, not the deps interface.)

- [ ] **Step 3: Commit**

```bash
git add tests/mcp/harness.ts
git commit -m "test(mcp): add in-memory Client/transport test harness"
```

---

### Task 2: Protocol round-trip suite (all four tools + guidance + error paths)

**Files:**
- Create: `tests/mcp/protocol.test.ts`

**Interfaces:**
- Consumes: `connectClient`, `makeInMemoryDeps`, `seedFile`, `seedSymbol` from `tests/mcp/harness.ts`; `createCodeindexServer` from `src/mcp/server.ts`; `ensureSchema` from `src/storage/schema.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/protocol.test.ts`. Each test builds a `:memory:` DB, seeds it, builds a server from `makeInMemoryDeps(db)`, connects a real `Client`, and asserts on `callTool`/`listTools` results. A tool result's JSON payload is in both `result.structuredContent` and `JSON.parse(result.content[0].text)`.

```ts
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'

import { createCodeindexServer } from '../../src/mcp/server.js'
import { ensureSchema } from '../../src/storage/schema.js'
import { connectClient, makeInMemoryDeps, seedFile, seedSymbol } from './harness.js'

const openDbs: Database[] = []

const buildSeededDb = (): Database => {
  const db = new Database(':memory:')
  openDbs.push(db)
  ensureSchema(db)
  seedFile(db, { id: 1, filePath: 'src/search/index.ts', moduleKey: 'src/search/index' })
  seedFile(db, { id: 2, filePath: 'src/storage/db.ts', moduleKey: 'src/storage/db' })
  seedSymbol(db, {
    id: 1,
    fileId: 1,
    filePath: 'src/search/index.ts',
    moduleKey: 'src/search/index',
    localName: 'searchSymbols',
    qualifiedName: 'src/search/index#searchSymbols',
  })
  seedSymbol(db, {
    id: 2,
    fileId: 2,
    filePath: 'src/storage/db.ts',
    moduleKey: 'src/storage/db',
    localName: 'openDatabase',
    qualifiedName: 'src/storage/db#openDatabase',
  })
  db.query(
    `INSERT INTO symbol_references (source_symbol_id, source_file_id, target_symbol_id, target_file_id, target_name, target_export_name, target_module_specifier, edge_type, confidence, line_number)
     VALUES (1, 1, 2, 2, 'openDatabase', NULL, '../storage/db', 'calls', 'resolved', 5)`,
  ).run()
  return db
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    db.close()
  }
})

describe('MCP protocol boundary', () => {
  test('listTools exposes all four tools', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const listed = await client.listTools()
    const names = listed.tools.map((tool) => tool.name).sort()
    expect(names).toEqual(['code_impact', 'code_index', 'code_search', 'code_symbol'])
  })

  test('code_search returns a structured hit for a known symbol', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const result = await client.callTool({ name: 'code_search', arguments: { query: 'searchSymbols' } })
    expect(result.isError ?? false).toBe(false)
    const payload = result.structuredContent as { resultCount: number; results: readonly { qualifiedName: string }[]; guidance?: string }
    expect(payload.resultCount).toBeGreaterThanOrEqual(1)
    expect(payload.results.some((row) => row.qualifiedName === 'src/search/index#searchSymbols')).toBe(true)
    expect(payload.guidance).toBeUndefined()
  })

  test('code_search on no match returns the guidance string', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const result = await client.callTool({ name: 'code_search', arguments: { query: 'zzz_nonexistent_symbol' } })
    const payload = result.structuredContent as { resultCount: number; guidance?: string }
    expect(payload.resultCount).toBe(0)
    expect(typeof payload.guidance).toBe('string')
    expect(payload.guidance).toContain('No symbol matches')
  })

  test('code_symbol returns candidates with no guidance field', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const result = await client.callTool({ name: 'code_symbol', arguments: { query: 'openDatabase' } })
    const payload = result.structuredContent as { results: readonly { qualifiedName: string }[]; guidance?: unknown }
    expect(payload.results.some((row) => row.qualifiedName === 'src/storage/db#openDatabase')).toBe(true)
    expect(payload.guidance).toBeUndefined()
  })

  test('code_impact resolves incoming references by qualifiedName', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const result = await client.callTool({
      name: 'code_impact',
      arguments: { qualifiedName: 'src/storage/db#openDatabase' },
    })
    const payload = result.structuredContent as { results: readonly { sourceQualifiedName: string | null }[] }
    expect(payload.results.some((row) => row.sourceQualifiedName === 'src/search/index#searchSymbols')).toBe(true)
  })

  test('code_impact without symbolKey or qualifiedName is a tool error', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const result = await client.callTool({ name: 'code_impact', arguments: { limit: 5 } })
    expect(result.isError).toBe(true)
    const text = (result.content as readonly { type: string; text: string }[])[0]
    expect(text).toBeDefined()
    expect(text!.text).toContain('symbolKey or qualifiedName')
  })

  test('code_search with a missing query is a validation error', async () => {
    const client = await connectClient(createCodeindexServer(makeInMemoryDeps(buildSeededDb())))
    const result = await client.callTool({ name: 'code_search', arguments: {} })
    expect(result.isError).toBe(true)
  })
})
```

- [ ] **Step 2: Run the suite to verify it passes**

Run: `bun test tests/mcp/protocol.test.ts`
Expected: PASS (7 tests). These exercise the CURRENT correct behaviors (server + read tools are already correct), so they pass immediately — this task is regression-guarding coverage, not a red→green cycle. If the `code_impact` refine message differs, match the exact text in `src/mcp/tools.ts:49` (`'Either symbolKey or qualifiedName is required'`) — the assertion checks a substring `'symbolKey or qualifiedName'`, which that message contains.

- [ ] **Step 3: Verify lint + typecheck + format**

Run: `bun run format && bun run lint && bun run typecheck && bun run format:check`
Expected: PASS. (The `!` non-null assertions on guarded tuple access are permitted; if oxlint objects to `!`, replace with an explicit `if (text === undefined) throw new Error(...)` guard before use.)

- [ ] **Step 4: Commit**

```bash
git add tests/mcp/protocol.test.ts
git commit -m "test(mcp): protocol round-trips for all tools, guidance, and errors"
```

---

### Task 3: Fix the code_index DB-target bug (failing wiring test → fix)

**Files:**
- Create: `tests/mcp/wiring.test.ts`
- Modify: `src/mcp/tools.ts` (`CodeIndexInputSchema`, `CodeindexToolDeps.codeIndex`)
- Modify: `src/mcp/server.ts:82-84` (`registerIndexTool` handler)
- Modify: `src/cli.ts` (`buildMcpDeps.codeIndex`; export `buildMcpDeps`; guard `main()` with `import.meta.main` so the module is safely importable)

**Interfaces:**
- Consumes: `connectClient` from `tests/mcp/harness.ts`; `buildMcpDeps` and `loadConfigForPath` from `src/cli.ts`; `createCodeindexServer` from `src/mcp/server.ts`.
- Produces: exported `buildMcpDeps(config: CodeindexConfig): CodeindexToolDeps` from `src/cli.ts`; `code_index` tool input becomes `{ mode }` (no `path`), indexing the server's bound repo.

**Behavior being fixed:** With the server bound to repo A, calling `code_index` must index **repo A** (so `code_search` afterward finds A's symbols). Before the fix, `code_index` requires a `path` and indexes whatever that resolves to — diverging from what the read tools query.

- [ ] **Step 1: Write the failing wiring test**

Create `tests/mcp/wiring.test.ts`. It builds a real on-disk temp repo A with a distinctive symbol, binds the server to A via the REAL `buildMcpDeps(await loadConfigForPath(repoA))`, then through the protocol calls `code_index` (mode `full`) and then `code_search` for that symbol.

```ts
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createCodeindexServer } from '../../src/mcp/server.js'
import { buildMcpDeps, loadConfigForPath } from '../../src/cli.js'
import { connectClient } from './harness.js'

const tempDirs: string[] = []

const makeRepo = (symbolName: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-wiring-'))
  tempDirs.push(dir)
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
  writeFileSync(path.join(dir, 'src', 'thing.ts'), `export const ${symbolName} = (): number => 1\n`)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('code_index targets the server-bound repo', () => {
  test('indexing then searching through the protocol finds the bound repo symbol', async () => {
    const repoA = makeRepo('boundRepoBeacon')
    const config = await loadConfigForPath(repoA)
    const client = await connectClient(createCodeindexServer(buildMcpDeps(config)))

    const indexResult = await client.callTool({ name: 'code_index', arguments: { mode: 'full' } })
    expect(indexResult.isError ?? false).toBe(false)
    const summary = indexResult.structuredContent as { filesIndexed: number; symbolsIndexed: number }
    expect(summary.filesIndexed).toBeGreaterThanOrEqual(1)

    const searchResult = await client.callTool({ name: 'code_search', arguments: { query: 'boundRepoBeacon' } })
    const payload = searchResult.structuredContent as { resultCount: number; results: readonly { qualifiedName: string }[] }
    expect(payload.resultCount).toBeGreaterThanOrEqual(1)
    expect(payload.results.some((row) => row.qualifiedName === 'src/thing#boundRepoBeacon')).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails (RED — captures the bug)**

Run: `bun test tests/mcp/wiring.test.ts`
Expected: FAIL — the import `{ buildMcpDeps } from '../../src/cli.js'` does not resolve because `buildMcpDeps` is not exported yet (ESM: "does not provide an export named 'buildMcpDeps'"). (Even if it did resolve, `code_index` still requires `path`, so `arguments: { mode: 'full' }` would be an `isError: true` validation failure and the search would find nothing.) Record the actual failing output as the RED evidence.

- [ ] **Step 3: Remove `path` from the code_index input schema and deps type**

In `src/mcp/tools.ts`, change `CodeIndexInputSchema` (currently `src/mcp/tools.ts:53-56`) from:

```ts
export const CodeIndexInputSchema = z.object({
  path: z.string().min(1),
  mode: z.enum(['full', 'incremental']).default('incremental'),
})
```

to:

```ts
export const CodeIndexInputSchema = z.object({
  mode: z.enum(['full', 'incremental']).default('incremental'),
})
```

And change `CodeindexToolDeps.codeIndex` (currently `src/mcp/tools.ts:24`) from:

```ts
  readonly codeIndex: (input: { path: string; mode: 'full' | 'incremental' }) => Promise<IndexSummary>
```

to:

```ts
  readonly codeIndex: (input: { mode: 'full' | 'incremental' }) => Promise<IndexSummary>
```

- [ ] **Step 4: Update the server handler to stop forwarding `path`**

In `src/mcp/server.ts`, change `registerIndexTool`'s handler (currently `src/mcp/server.ts:82-84`) from:

```ts
    async ({ path, mode }: CodeIndexInput) => {
      const summary = await deps.codeIndex({ path, mode })
      return buildStructuredToolResult(CodeIndexOutputSchema, summary)
    },
```

to:

```ts
    async ({ mode }: CodeIndexInput) => {
      const summary = await deps.codeIndex({ mode })
      return buildStructuredToolResult(CodeIndexOutputSchema, summary)
    },
```

- [ ] **Step 5: Fix the wiring and export buildMcpDeps in `src/cli.ts`**

In `src/cli.ts`, change `buildMcpDeps` (currently `src/cli.ts:65-84`) so it is `export`ed and its `codeIndex` uses the closed-over startup `config` instead of resolving a per-call target. Replace:

```ts
const buildMcpDeps = (config: CodeindexConfig): Parameters<typeof createCodeindexServer>[0] => ({
  codeSearch: (input: Parameters<typeof searchSymbols>[1]): Promise<ReturnType<typeof searchSymbols>> =>
    Promise.resolve(withDatabase(config, (db) => searchSymbols(db, input))),
  codeSymbol: (query: string, limit: number): Promise<ReturnType<typeof findSymbolCandidates>> =>
    Promise.resolve(withDatabase(config, (db) => findSymbolCandidates(db, query, limit))),
  codeImpact: (
    input: Parameters<typeof findIncomingReferences>[1],
  ): Promise<ReturnType<typeof findIncomingReferences>> =>
    Promise.resolve(withDatabase(config, (db) => findIncomingReferences(db, input))),
  codeIndex: async ({
    path: targetPath,
    mode,
  }: {
    path: string
    mode: 'full' | 'incremental'
  }): Promise<Awaited<ReturnType<typeof indexCodebase>>> => {
    const targetConfig = await loadConfigForPath(targetPath)
    return indexCodebase({ config: targetConfig, mode })
  },
})
```

with:

```ts
export const buildMcpDeps = (config: CodeindexConfig): Parameters<typeof createCodeindexServer>[0] => ({
  codeSearch: (input: Parameters<typeof searchSymbols>[1]): Promise<ReturnType<typeof searchSymbols>> =>
    Promise.resolve(withDatabase(config, (db) => searchSymbols(db, input))),
  codeSymbol: (query: string, limit: number): Promise<ReturnType<typeof findSymbolCandidates>> =>
    Promise.resolve(withDatabase(config, (db) => findSymbolCandidates(db, query, limit))),
  codeImpact: (
    input: Parameters<typeof findIncomingReferences>[1],
  ): Promise<ReturnType<typeof findIncomingReferences>> =>
    Promise.resolve(withDatabase(config, (db) => findIncomingReferences(db, input))),
  codeIndex: ({ mode }: { mode: 'full' | 'incremental' }): Promise<Awaited<ReturnType<typeof indexCodebase>>> =>
    indexCodebase({ config, mode }),
})
```

Note: after this change `loadConfigForPath` may become unused inside `buildMcpDeps`, but it is still used by `main()` (`src/cli.ts:95`) and is an exported function, so it stays. Confirm no now-unused imports remain (`noUnusedLocals`): all of `searchSymbols`, `findSymbolCandidates`, `findIncomingReferences`, `indexCodebase`, `withDatabase` are still referenced.

- [ ] **Step 6: Guard `main()` so `src/cli.ts` is safely importable**

The wiring test (and `tests/cli.test.ts`) import from `src/cli.js`; the module currently runs `main()` on import. Wrap the top-level invocation in an `import.meta.main` guard. Change the end of `src/cli.ts` (currently `src/cli.ts:124-127`) from:

```ts
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
```

to:

```ts
if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
```

This keeps the CLI working when run as an entry point (`bun run src/cli.ts …`, `bun run mcp`, `bun run start`) while making imports side-effect-free. As a bonus it removes the stray `filesIndexed: …` JSON that `main()` currently prints during `bun test` (via `tests/cli.test.ts`'s import).

- [ ] **Step 7: Run the wiring test to verify it passes (GREEN)**

Run: `bun test tests/mcp/wiring.test.ts`
Expected: PASS. `code_index` now indexes repo A (the bound repo); `code_search` finds `src/thing#boundRepoBeacon`. This exercises the real tree-sitter indexer, so it is slower than the in-memory suite. Record the passing output as GREEN evidence.

- [ ] **Step 8: Run the whole test suite + gates**

Run: `bun run format && bun test tests && bun run lint && bun run typecheck && bun run format:check`
Expected: all PASS. Watch specifically that the existing `tests/mcp/server.test.ts` / `tests/mcp.test.ts` smoke tests still pass (they use stub deps and don't reference `path`), and that no other caller of `code_index`'s `path` exists (grep already confirmed the MCP tool is the only consumer). If any existing test constructed `CodeindexToolDeps` with a `codeIndex` taking `path`, update that stub to the new `{ mode }` signature. The stray `filesIndexed: …` JSON block should no longer appear in the test output (the `import.meta.main` guard suppressed it).

- [ ] **Step 9: Commit**

```bash
git add src/mcp/tools.ts src/mcp/server.ts src/cli.ts tests/mcp/wiring.test.ts
git commit -m "fix(mcp): code_index targets the server-bound repo, not an arbitrary path"
```

---

## Definition of done (this plan)

- Real `Client`/`InMemoryTransport` round-trip tests exist and pass for all four tools, the empty-result `guidance` string, and error/validation paths (`isError: true`).
- The `code_index` DB-target bug is fixed: `code_index` indexes the server's bound repo; a protocol-level index-then-search test proves it. `path` is gone from the tool's input schema and `CodeindexToolDeps`.
- `buildMcpDeps` is exported from `src/cli.ts`, and `src/cli.ts` is safely importable (`main()` guarded by `import.meta.main`) — the stray `filesIndexed: …` JSON no longer prints during `bun test`.
- `bun test tests`, `bun run lint`, `bun run typecheck`, `bun run format:check` all pass.

## Deferred to sibling Phase 1 plans (do NOT do here)

- **Query logging / observability**, **edit-sequence fuzzer**, **indexing benchmark**, **`busy_timeout` + provenance ride-alongs** — separate plans.
- Removing the redundant `src/mcp.ts` barrel / consolidating the duplicate `tests/mcp.test.ts` + `tests/mcp/server.test.ts` smoke tests — cleanup, not in scope.
- Threading a per-call target repo through the read tools (the multi-repo alternative fix) — explicitly rejected in favor of the cwd-bound design.
