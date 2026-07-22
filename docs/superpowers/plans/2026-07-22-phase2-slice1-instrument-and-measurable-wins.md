# Phase 2 Slice 1 — Instrument & Measurable Wins — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `code_impact` false-negative/false-positive measurement instrument (a bench-only TypeScript-compiler oracle with a frozen-baseline CI gate), and bank the two already-measurable wins — blend BM25 into ranking, and halve the MCP response payload.

**Architecture:** Three independent units. Unit 1 (`bench/impact-*.ts`) constructs a `ts.LanguageService` over a target repo, enumerates true references per exported symbol, maps each reference back to the enclosing codeindex symbol via the DB, and diffs that truth set against the real `code_impact` output — freezing FN/FP numbers to committed JSON with a fast gate, mirroring the existing `index-bench` pattern. Unit 2 threads the FTS `bm25()` score through to `rank.ts` so lexical relevance finally participates in ordering. Unit 3 stops duplicating the full JSON payload in both MCP response channels.

**Tech Stack:** Bun, TypeScript 6.0.3, `bun:sqlite`, zod, the raw `typescript` compiler API (already a devDependency), MCP SDK. Functional-TS style throughout (readonly, arrow functions, no classes).

## Global Constraints

- **Target branch: `master`** (the user directed committing to the current branch). Follow the repo's conventional-commit style (`feat(bench):`, `fix(search):`, `test:`, `docs:`).
- **No new runtime dependencies.** The oracle uses the raw `typescript` compiler API, which is **already** a devDependency (`typescript@6.0.3`, verified resolvable with `ts.createLanguageService`). **Deviation from spec (accepted):** the spec named `ts-morph` as the example vehicle; `ts-morph` is not installed and does not support TS 6.x, so we use the raw `typescript` API instead — same intent (a bench-only type-checker oracle), zero new deps, no version conflict.
- **The type-checker *construction* APIs (`createLanguageService`, `createProgram`, `getReferencesAtPosition`, `findReferences`) must appear ONLY under `bench/`, never `src/`.** The shipped indexer runs no type checker. **Correction to the spec's "never imported by `src/`" phrasing:** `src/resolver/tsconfig-paths.ts` *already* imports `typescript` for lightweight tsconfig *parsing* (`readConfigFile`/`parseJsonConfigFileContent`) — that is allowed and unchanged; the real boundary is the heavy checker APIs above. Task 4 adds a test enforcing exactly that boundary.
- **Functional-TS + lint compliance.** oxlint enforces (Phase 1 confirmed these bite): `no-unsafe-type-assertion` (validate external JSON with zod, never `as T`), `max-lines` (keep files focused; extract helpers before a file grows large), `prefer-nullish-coalescing`, `no-await-in-loop`. Match the style of the file you are editing.
- **TDD, bite-sized, frequent commits.** Every code change is: write failing test → run it red → minimal implementation → run it green → commit.
- **`bun run check`** (lint + typecheck + format:check + test, in parallel) must pass before a task is considered done. Run `bun run format` to auto-fix formatting.
- **Existing baselines are exact-tolerance gates** (`1e-9`). `compareToBaseline` (IR) flags any metric that *decreases*; improvements pass. Unit 2 changes ranking, so its baselines are re-captured and committed (Task 7).

---

## File Structure

**New files (Unit 1 — the oracle):**
- `bench/impact-types.ts` — types + zod baseline schema.
- `bench/impact-oracle.ts` — `createTsProject()` + `buildReferenceOracle()` (TS LanguageService → true reference sets, mapped to codeindex symbol keys).
- `bench/impact-score.ts` — `scoreImpact()` (pure diff of oracle truth vs `findIncomingReferences`).
- `bench/impact-compare.ts` — `compareImpact()` (FN-rate regression gate).
- `bench/impact-run.ts` — CLI runner (index → oracle → score → print → freeze/gate).
- `bench/impact-baseline.json`, `bench/impact-baseline.papai.json` — frozen baselines (Task 6).
- `tests/bench/impact-oracle.test.ts`, `tests/bench/impact-score.test.ts`, `tests/bench/impact-compare.test.ts`, `tests/bench/impact-guard.test.ts`.

**Modified files (Units 2 & 3):**
- `src/types.ts` — add `relevance?: number` to `SearchResult`.
- `src/search/fts.ts` — select `bm25()`, carry `relevance`.
- `src/search/rank.ts` — blend `relevance` into the score.
- `src/mcp/tools.ts` — `buildStructuredToolResult` takes an explicit compact `summaryText`.
- `src/mcp/server.ts` — 4 call sites build compact summaries.
- `tests/search/rank.test.ts`, `tests/search/fts.test.ts`, `tests/mcp/tools.test.ts` — updated/added assertions.
- `package.json` — `bench:impact*` scripts.
- `bench/baseline.json`, `bench/baseline.papai.json` — re-captured after Unit 2.
- `.superpowers/sdd/progress.md` — Slice 1 ledger entry (Task 8).

---

## Task 1: Compact MCP response payload (Unit 3 / gap H1)

Kills the ~2× duplication: `structuredContent` stays the full payload; `content[0].text` becomes a short human summary.

**Files:**
- Modify: `src/mcp/tools.ts` (`buildStructuredToolResult`, lines 107-116)
- Modify: `src/mcp/server.ts` (4 call sites)
- Test: `tests/mcp/tools.test.ts` (update lines 101-119)

**Interfaces:**
- Produces: `buildStructuredToolResult<S>(schema: S, output: unknown, summaryText: string) => { content: [{type:'text', text:string}]; structuredContent: z.output<S> }` — `text` is now `summaryText`, not `JSON.stringify(output)`.

- [ ] **Step 1: Update the two `buildStructuredToolResult` unit tests to the new signature**

In `tests/mcp/tools.test.ts`, replace the `describe('buildStructuredToolResult', ...)` block (lines 101-119) with:

```ts
describe('buildStructuredToolResult', () => {
  test('returns structuredContent plus a compact text summary (not full JSON)', () => {
    const schema = z.object({ value: z.number() })
    const result = buildStructuredToolResult(schema, { value: 42 }, '1 value')

    expect(result.content[0]!.type).toBe('text')
    expect(result.content[0]!.text).toBe('1 value')
    expect(result.structuredContent).toEqual({ value: 42 })
  })

  test('does not duplicate the full payload into the text channel', () => {
    const schema = z.object({ items: z.array(z.string()) })
    const result = buildStructuredToolResult(schema, { items: ['a', 'b'] }, '2 items')

    expect(result.content[0]!.text).toBe('2 items')
    expect(result.content[0]!.text).not.toContain('[')
    expect(result.structuredContent).toEqual({ items: ['a', 'b'] })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/mcp/tools.test.ts`
Expected: FAIL — `buildStructuredToolResult` currently takes 2 args and puts JSON in `text`.

- [ ] **Step 3: Change `buildStructuredToolResult` to take an explicit summary**

In `src/mcp/tools.ts`, replace the function (lines 107-116) with:

```ts
export const buildStructuredToolResult = <S extends z.ZodType>(
  schema: S,
  output: unknown,
  summaryText: string,
): { content: Array<{ type: 'text'; text: string }>; structuredContent: z.output<S> } => {
  const parsed = schema.parse(output)
  return {
    content: [{ type: 'text', text: summaryText }],
    structuredContent: parsed,
  }
}
```

- [ ] **Step 4: Build compact summaries at the 4 server call sites**

In `src/mcp/server.ts`:

Search tool (replace the `return buildStructuredToolResult(...)` at lines 34-39):
```ts
      const topNames = results.slice(0, 5).map((r) => r.qualifiedName).join(', ')
      const summary =
        results.length === 0
          ? (guidance ?? 'No matches.')
          : `${results.length} result(s): ${topNames}${results.length > 5 ? ', …' : ''}`
      return buildStructuredToolResult(
        CodeSearchOutputSchema,
        { query, resultCount: results.length, results: [...results], guidance },
        summary,
      )
```

Symbol tool (replace line 54):
```ts
      const summary = `${results.length} candidate(s): ${results.slice(0, 5).map((r) => r.qualifiedName).join(', ')}`
      return buildStructuredToolResult(CodeSymbolOutputSchema, { results: [...results] }, summary)
```

Impact tool (replace line 69):
```ts
      const summary = `${results.length} incoming reference(s)`
      return buildStructuredToolResult(CodeImpactOutputSchema, { results: [...results] }, summary)
```

Index tool — the handler already has `const summary = await deps.codeIndex({ mode })`. Add a separate text variable and pass both (replace the `return` at line 84):
```ts
      const summaryText = `Indexed ${summary.filesIndexed} files, ${summary.symbolsIndexed} symbols, ${summary.referencesIndexed} references`
      return buildStructuredToolResult(CodeIndexOutputSchema, summary, summaryText)
```

- [ ] **Step 5: Run the MCP suite to verify green**

Run: `bun test tests/mcp/`
Expected: PASS. (Protocol tests assert only `structuredContent` shape + error text, which are unchanged; `tests/mcp/protocol.test.ts:101` asserts an error-path message, not the success payload.)

- [ ] **Step 6: Run full check**

Run: `bun run check`
Expected: PASS (lint, typecheck, format, test).

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools.ts src/mcp/server.ts tests/mcp/tools.test.ts
git commit -m "feat(mcp): compact text channel, keep full structuredContent (H1)"
```

---

## Task 2: Carry BM25 relevance through FTS (Unit 2a)

The FTS query already orders by `bm25()` but discards the value. Capture it so ranking can use it.

**Files:**
- Modify: `src/types.ts` (`SearchResult`, add `relevance?: number`)
- Modify: `src/search/fts.ts` (`loadFtsResults`)
- Test: `tests/search/fts.test.ts`

**Interfaces:**
- Produces: `SearchResult.relevance?: number` — present on FTS results only (higher = stronger lexical match; absent on exact results). Consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Add to `tests/search/fts.test.ts`, reusing the file's existing `makeDb(localName)` helper (each test builds its own single-symbol in-memory DB — there is no shared `db`). Assert FTS rows carry a defined, non-negative `relevance`:

```ts
test('FTS results carry a defined, non-negative bm25 relevance', () => {
  const db = makeDb('getDrizzleDb')
  const results = runFtsSearch(db, 'getDrizzleDb', 10, {})
  expect(results.length).toBeGreaterThan(0)
  expect(typeof results[0]!.relevance).toBe('number')
  expect(results[0]!.relevance!).toBeGreaterThanOrEqual(0)
})
```
(Best-first ordering is already guaranteed by the SQL `ORDER BY bm25_score`; relevance-driven *reordering* is exercised in Task 3's `rank.test.ts`.)

- [ ] **Step 2: Run it red**

Run: `bun test tests/search/fts.test.ts`
Expected: FAIL — `relevance` is `undefined`.

- [ ] **Step 3: Add `relevance` to the type**

In `src/types.ts`, add to `SearchResult` (after `snippet`, keep `readonly`):
```ts
  readonly snippet: string
  readonly relevance?: number
```

- [ ] **Step 4: Select bm25 and set relevance in `fts.ts`**

In `src/search/fts.ts`, in `loadFtsResults`, add the bm25 column to the SELECT and the row type, and set `relevance`. Change the `snippet(...)` SELECT line to also compute the score, and add `bm25_score: number` to the row generic:

```ts
     `SELECT symbols.symbol_key, symbols.qualified_name, symbols.local_name, symbols.kind, symbols.scope_tier,
            symbols.file_path, symbols.start_line, symbols.end_line, symbols.export_names,
            snippet(symbol_fts, 5, '[', ']', '...', 12) AS snippet,
            bm25(symbol_fts, 10.0, 9.0, 8.0, 7.0, 6.0, 5.0, 2.0, 1.0) AS bm25_score
     FROM symbol_fts
     JOIN symbols ON symbols.id = symbol_fts.rowid
     WHERE symbol_fts MATCH ?
     ORDER BY bm25_score
     LIMIT ?`,
```
Add `bm25_score: number` to the row type object (alongside `snippet: string`). In the `.map(...)`, add after `snippet: row.snippet,`:
```ts
      relevance: -row.bm25_score,
```
(`bm25()` returns ≤ 0 where more-negative is a better match, so negating yields a ≥ 0 "higher = better" value.)

- [ ] **Step 5: Run it green**

Run: `bun test tests/search/fts.test.ts`
Expected: PASS.

- [ ] **Step 6: Full check + commit**

Run: `bun run check` → PASS
```bash
git add src/types.ts src/search/fts.ts tests/search/fts.test.ts
git commit -m "feat(search): carry bm25 relevance on FTS results (D1 groundwork)"
```

---

## Task 3: Blend BM25 into ranking (Unit 2b)

Today `matchScore` returns `0` for every FTS hit, so scope tier alone orders NL results. Blend a bounded, normalized `relevance` term so lexical strength reorders *within* a tier (the measured NL-intent weakness) without letting FTS override exact matches.

**Plan-time deviation from spec (accepted, YAGNI):** the spec's Unit 2 also listed "de-dup the exact pool (overloads/duplicate declarations)." On inspection this is a no-op and is dropped: `runExactSearch`'s SQL cannot return two rows with the same `symbol_key` (an `OR` `WHERE` never multiplies rows; the single `module_exports` LEFT JOIN matches at most one `export_name`), and genuine overloads are *distinct* `symbol_key`s that a key-dedup would not touch. No measured deficit, no constructible red test → not built. `searchSymbols` is left unchanged.

**Files:**
- Modify: `src/search/rank.ts`
- Test: `tests/search/rank.test.ts`

**Interfaces:**
- Consumes: `SearchResult.relevance?` (Task 2).
- Produces: unchanged public signature (`rerankSearchResults`); only ordering changes.

- [ ] **Step 1: Write the failing ranking test**

Add to `tests/search/rank.test.ts` — two FTS results in the same scope tier, differing only by `relevance`, must order by relevance; and an exact match must still outrank any FTS hit:

```ts
test('blends relevance: within a tier, higher bm25 relevance ranks higher', () => {
  const base = {
    symbolKey: 'k', qualifiedName: 'm#a', localName: 'a', kind: 'function',
    scopeTier: 'exported' as const, filePath: 'm.ts', startLine: 1, endLine: 2,
    exportNames: [], matchReason: 'fts identifier_terms/doc_text/body_text',
    confidence: 'resolved' as const, snippet: '',
  }
  const weak = { ...base, symbolKey: 'weak', qualifiedName: 'm#weak', relevance: 1 }
  const strong = { ...base, symbolKey: 'strong', qualifiedName: 'm#strong', relevance: 9 }
  const ranked = rerankSearchResults([weak, strong])
  expect(ranked[0]!.symbolKey).toBe('strong')
})

test('an exact match still outranks a strong FTS hit', () => {
  const exact = {
    symbolKey: 'exact', qualifiedName: 'm#z', localName: 'z', kind: 'function',
    scopeTier: 'local' as const, filePath: 'm.ts', startLine: 1, endLine: 2,
    exportNames: [], matchReason: 'exact local_name', confidence: 'exact' as const, snippet: '',
  }
  const fts = {
    symbolKey: 'fts', qualifiedName: 'm#y', localName: 'y', kind: 'function',
    scopeTier: 'exported' as const, filePath: 'm.ts', startLine: 1, endLine: 2,
    exportNames: [], matchReason: 'fts identifier_terms/doc_text/body_text',
    confidence: 'resolved' as const, snippet: '', relevance: 999,
  }
  const ranked = rerankSearchResults([fts, exact])
  expect(ranked[0]!.symbolKey).toBe('exact')
})
```

- [ ] **Step 2: Run it red**

Run: `bun test tests/search/rank.test.ts`
Expected: FAIL on the first test — with `matchScore` = 0 for both, order is input order (`weak` first).

- [ ] **Step 3: Blend relevance in `rank.ts`**

Rewrite `src/search/rank.ts` so scoring normalizes `relevance` across the result set and adds a bounded term (weight `100`, below the `425` exact-`local_name` floor so exact always wins; large enough to reorder freely *within* a tier):

```ts
import type { RankedSearchResult, SearchResult } from '../types.js'

const scopeScore = (scopeTier: SearchResult['scopeTier']): number => {
  switch (scopeTier) {
    case 'exported':
      return 400
    case 'module':
      return 300
    case 'member':
      return 200
    case 'local':
      return 100
    default:
      throw new Error(`Unsupported scope tier: ${String(scopeTier)}`)
  }
}

const matchScore = (matchReason: string): number => {
  if (matchReason.includes('exact export_names')) return 500
  if (matchReason.includes('exact qualified_name')) return 450
  if (matchReason.includes('exact local_name')) return 425
  return 0
}

// BM25 relevance is blended as a bounded term so lexical strength reorders results
// *within* a scope tier (the measured NL-intent weakness) without ever letting an FTS
// hit overtake an exact-name match. Normalized to [0,1] across the current result set.
const RELEVANCE_WEIGHT = 100

const maxRelevance = (results: readonly SearchResult[]): number =>
  results.reduce((max, r) => (r.relevance !== undefined && r.relevance > max ? r.relevance : max), 0)

const relevanceScore = (result: Readonly<SearchResult>, max: number): number =>
  result.relevance === undefined || max <= 0 ? 0 : (result.relevance / max) * RELEVANCE_WEIGHT

export const scoreSearchResult = (result: Readonly<SearchResult>): number =>
  scopeScore(result.scopeTier) + matchScore(result.matchReason)

export const rerankSearchResults = (results: readonly SearchResult[]): readonly RankedSearchResult[] => {
  const maxRel = maxRelevance(results)
  return [...results]
    .map((result) => ({ ...result, rankScore: scoreSearchResult(result) + relevanceScore(result, maxRel) }))
    .sort((left, right) => right.rankScore - left.rankScore)
}
```
Note: `scoreSearchResult` keeps its **original single-argument signature** (scope + match only), so the existing `scoreSearchResult` unit tests (`rank.test.ts:38,42,47`, which call it with one arg) are unaffected. The bounded relevance term is added only inside `rerankSearchResults`; the existing `rerankSearchResults` tests also pass unchanged because their inputs carry no `relevance` (so the term is 0).

- [ ] **Step 4: Run it green**

Run: `bun test tests/search/rank.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check**

Run: `bun test tests/search/rank.test.ts` then `bun run check`
Expected: PASS. (Existing rank tests are unaffected: results without `relevance` — every exact hit — score exactly as before, since `relevanceScore` returns 0 when `relevance` is `undefined`.)

- [ ] **Step 6: Verify no IR regression against existing baselines**

Run: `bun run bench:check` and `bun run bench:papai:check` (the latter assumes `../papai` exists).
Expected: no regression reported (MRR should rise or hold; recall must stay 1.0 — a drop would flag and means the reorder pushed a relevant item past k, which must be investigated before proceeding).

- [ ] **Step 7: Re-capture the improved IR baselines and commit**

Ranking changed, so lock the new numbers as the bar:
```bash
bun run bench/run.ts --baseline bench/baseline.json --update-baseline
bun run bench/run.ts --repo ../papai --corpus bench/corpus/papai.json --baseline bench/baseline.papai.json --update-baseline
git add src/search/rank.ts tests/search/rank.test.ts bench/baseline.json bench/baseline.papai.json
git commit -m "feat(search): blend bm25 relevance into ranking (D1)"
```
Record the before/after MRR in the commit body (old codeindex 0.9048 / papai 0.8295).

---

## Task 4: Oracle foundation — TS project + bench-only import guard (Unit 1a)

Construct a `ts.LanguageService` from a repo's `tsconfig.json`, and lock in that `typescript` never leaks into `src/`.

**Files:**
- Create: `bench/impact-types.ts`
- Create: `bench/impact-oracle.ts` (partial — `createTsProject`)
- Test: `tests/bench/impact-oracle.test.ts`, `tests/bench/impact-guard.test.ts`

**Interfaces:**
- Produces: `createTsProject(tsconfigPath: string) => { service: ts.LanguageService; program: ts.Program }`
- Produces (types): `OracleTarget = { readonly target: string; readonly trueSources: readonly string[] }`; `ImpactTargetScore`, `ImpactBenchReport`, `ImpactBaseline`, `ImpactBaselineSchema` (see Task 6).

- [ ] **Step 1: Write the bench-only type-checker guard test**

`src/` may import `typescript` for tsconfig parsing (`tsconfig-paths.ts` already does), so the guard forbids the heavy *checker-construction* APIs specifically. Create `tests/bench/impact-guard.test.ts`:
```ts
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const CHECKER_APIS = ['createLanguageService', 'createProgram', 'getReferencesAtPosition', 'findReferences']

const walk = (dir: string): readonly string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })

describe('bench-only type-checker boundary', () => {
  test('src/ constructs no TS type-checker (LanguageService/Program/findReferences)', () => {
    const offenders = walk(path.join(import.meta.dir, '../../src'))
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => CHECKER_APIS.some((api) => readFileSync(f, 'utf8').includes(api)))
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 2: Run it — expect PASS immediately**

Run: `bun test tests/bench/impact-guard.test.ts`
Expected: PASS. `src/resolver/tsconfig-paths.ts` uses only `readConfigFile`/`parseJsonConfigFileContent` (parsing), never the checker APIs, so `src/` is clean today. This guard keeps future work honest; commit it now.

- [ ] **Step 3: Create `bench/impact-types.ts`**

```ts
import { z } from 'zod'

export interface OracleTarget {
  readonly target: string
  readonly trueSources: readonly string[]
}

export interface ImpactTargetScore {
  readonly target: string
  readonly trueSourceCount: number
  readonly impactSourceCount: number
  readonly falseNegatives: number
  readonly falsePositives: number
}

export interface ImpactBenchReport {
  readonly repo: string
  readonly targetsScored: number
  readonly trueReferenceCount: number
  readonly impactReferenceCount: number
  readonly falseNegatives: number
  readonly falseNegativeRate: number
  readonly falsePositives: number
  readonly falsePositiveRate: number
  readonly falsePositivesByConfidence: Readonly<Record<string, number>>
  readonly perTarget: readonly ImpactTargetScore[]
}

export interface ImpactBaseline {
  readonly targetsScored: number
  readonly trueReferenceCount: number
  readonly falseNegatives: number
  readonly falseNegativeRate: number
  readonly falsePositiveRate: number
}

export const ImpactBaselineSchema = z.object({
  targetsScored: z.number(),
  trueReferenceCount: z.number(),
  falseNegatives: z.number(),
  falseNegativeRate: z.number(),
  falsePositiveRate: z.number(),
})
```

- [ ] **Step 4: Write the failing `createTsProject` test**

Create `tests/bench/impact-oracle.test.ts`. It writes a tiny 2-file TS repo to a temp dir, points a `tsconfig.json` at it, and asserts the program sees both files:

```ts
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createTsProject } from '../../bench/impact-oracle.js'

const dirs: string[] = []
const makeRepo = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-oracle-'))
  dirs.push(dir)
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, 'src/a.ts'), 'export function foo(): number { return 1 }\n')
  writeFileSync(
    path.join(dir, 'src/b.ts'),
    "import { foo } from './a'\nexport function bar(): number { return foo() }\n",
  )
  writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', strict: true }, include: ['src'] }),
  )
  return dir
}
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('createTsProject', () => {
  test('constructs a program over the repo tsconfig', () => {
    const dir = makeRepo()
    const { program } = createTsProject(path.join(dir, 'tsconfig.json'))
    const files = program.getSourceFiles().map((s) => path.basename(s.fileName))
    expect(files).toContain('a.ts')
    expect(files).toContain('b.ts')
  })
})
```

- [ ] **Step 5: Run it red**

Run: `bun test tests/bench/impact-oracle.test.ts`
Expected: FAIL — `createTsProject` not exported yet.

- [ ] **Step 6: Implement `createTsProject` in `bench/impact-oracle.ts`**

Import only what `createTsProject` uses (Task 5 adds more imports when it appends `buildReferenceOracle`; importing them now would trip oxlint's unused-import rule):

```ts
import path from 'node:path'

import ts from 'typescript'

export interface TsProject {
  readonly service: ts.LanguageService
  readonly program: ts.Program
}

export const createTsProject = (tsconfigPath: string): TsProject => {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
  if (configFile.error !== undefined) {
    throw new Error(`Failed to read tsconfig: ${tsconfigPath}`)
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfigPath))
  const versions = new Map(parsed.fileNames.map((f) => [path.resolve(f), '0']))
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...versions.keys()],
    getScriptVersion: (fileName) => versions.get(path.resolve(fileName)) ?? '0',
    getScriptSnapshot: (fileName) => {
      const text = ts.sys.readFile(fileName)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => path.dirname(tsconfigPath),
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  }
  const service = ts.createLanguageService(host, ts.createDocumentRegistry())
  const program = service.getProgram()
  if (program === undefined) {
    throw new Error('Failed to construct ts.Program from language service')
  }
  return { service, program }
}
```

- [ ] **Step 7: Run it green + check + commit**

Run: `bun test tests/bench/impact-oracle.test.ts` → PASS; `bun run check` → PASS
```bash
git add bench/impact-types.ts bench/impact-oracle.ts tests/bench/impact-oracle.test.ts tests/bench/impact-guard.test.ts
git commit -m "feat(bench): tsc language-service project + bench-only import guard"
```

---

## Task 5: Reference enumeration + position→symbol mapping (Unit 1b)

For each exported codeindex symbol, get its true references from the type checker and map each back to the enclosing codeindex symbol key.

**Files:**
- Modify: `bench/impact-oracle.ts` (add `buildReferenceOracle`)
- Test: `tests/bench/impact-oracle.test.ts`

**Interfaces:**
- Consumes: `createTsProject` (Task 4) and the codeindex DB (`symbols` table). It does **not** call `findIncomingReferences` — comparing truth against `code_impact` is the scorer's job (Task 6).
- Produces: `buildReferenceOracle(db: Database, opts: { repoRoot: string; tsconfigPath: string; maxTargets?: number }) => readonly OracleTarget[]`

- [ ] **Step 1: Write the failing oracle test**

Extend `tests/bench/impact-oracle.test.ts`. Reuse the `makeRepo()` fixture, index it with the real indexer, then assert the oracle finds `bar` as a true source of `foo`:

```ts
import { loadCodeindexConfig } from '../../src/config.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import { openDatabase } from '../../src/storage/db.js'
import { buildReferenceOracle } from '../../bench/impact-oracle.js'

test('maps true references back to the enclosing codeindex symbol', async () => {
  const dir = makeRepo()
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
  const config = await loadCodeindexConfig({ configPath: path.join(dir, '.codeindex.json'), repoRoot: dir })
  await indexCodebase({ config, mode: 'full' })
  const db = openDatabase(config.dbPath)
  try {
    const oracle = buildReferenceOracle(db, { repoRoot: dir, tsconfigPath: path.join(dir, 'tsconfig.json') })
    const foo = oracle.find((t) => t.target.endsWith('#foo'))
    expect(foo).toBeDefined()
    expect(foo!.trueSources.some((s) => s.endsWith('#bar'))).toBe(true)
  } finally {
    db.close()
  }
})
```

- [ ] **Step 2: Run it red**

Run: `bun test tests/bench/impact-oracle.test.ts`
Expected: FAIL — `buildReferenceOracle` not defined.

- [ ] **Step 3: Implement `buildReferenceOracle`**

First add the two imports this function needs to the top of `bench/impact-oracle.ts` (they were deliberately omitted in Task 4 to keep it lint-clean):
```ts
import type { Database } from 'bun:sqlite'

import type { OracleTarget } from './impact-types.js'
```
Then append the implementation. Enumerate exported symbols from the DB; for each, find its declaration identifier position in the TS source, ask the language service for references, and map each reference line to the innermost enclosing codeindex symbol:

```ts
interface DbExportedSymbol {
  readonly qualifiedName: string
  readonly localName: string
  readonly filePath: string
  readonly startLine: number
}

const loadExportedSymbols = (db: Database): readonly DbExportedSymbol[] =>
  db
    .query<
      { qualified_name: string; local_name: string; file_path: string; start_line: number },
      []
    >(
      `SELECT qualified_name, local_name, file_path, start_line
       FROM symbols WHERE scope_tier = 'exported' ORDER BY qualified_name`,
    )
    .all()
    .map((r) => ({
      qualifiedName: r.qualified_name,
      localName: r.local_name,
      filePath: r.file_path,
      startLine: r.start_line,
    }))

const enclosingQualifiedName = (db: Database, filePath: string, line: number): string | null =>
  db
    .query<{ qualified_name: string }, [string, number, number]>(
      `SELECT qualified_name FROM symbols
       WHERE file_path = ? AND start_line <= ? AND end_line >= ?
       ORDER BY (end_line - start_line) ASC LIMIT 1`,
    )
    .get(filePath, line, line)?.qualified_name ?? null

const declarationOffset = (
  program: ts.Program,
  absFilePath: string,
  localName: string,
  startLine: number,
): number | null => {
  const sf = program.getSourceFile(absFilePath)
  if (sf === undefined) return null
  let offset: number | null = null
  const visit = (node: ts.Node): void => {
    if (offset !== null) return
    if (ts.isIdentifier(node) && node.text === localName) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      if (Math.abs(line - startLine) <= 1) offset = node.getStart(sf)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return offset
}

export const buildReferenceOracle = (
  db: Database,
  opts: Readonly<{ repoRoot: string; tsconfigPath: string; maxTargets?: number }>,
): readonly OracleTarget[] => {
  const { program, service } = createTsProject(opts.tsconfigPath)
  const symbols = loadExportedSymbols(db)
  const selected = opts.maxTargets === undefined ? symbols : symbols.slice(0, opts.maxTargets)
  return selected.map((symbol) => {
    const absFile = path.resolve(opts.repoRoot, symbol.filePath)
    const offset = declarationOffset(program, absFile, symbol.localName, symbol.startLine)
    const entries = offset === null ? [] : (service.getReferencesAtPosition(absFile, offset) ?? [])
    const sources = new Set<string>()
    for (const entry of entries) {
      const sf = program.getSourceFile(entry.fileName)
      if (sf === undefined) continue
      const line = sf.getLineAndCharacterOfPosition(entry.textSpan.start).line + 1
      const relPath = path.relative(opts.repoRoot, entry.fileName)
      const enclosing = enclosingQualifiedName(db, relPath, line)
      // Exclude module-scope refs (unnameable by code_impact) and self-references,
      // keeping the comparison apples-to-apples with code_impact's output shape.
      if (enclosing !== null && enclosing !== symbol.qualifiedName) sources.add(enclosing)
    }
    return { target: symbol.qualifiedName, trueSources: [...sources] }
  })
}
```

- [ ] **Step 4: Run it green + check + commit**

Run: `bun test tests/bench/impact-oracle.test.ts` → PASS; `bun run check` → PASS
```bash
git add bench/impact-oracle.ts tests/bench/impact-oracle.test.ts
git commit -m "feat(bench): enumerate true references and map to codeindex symbols"
```

---

## Task 6: Differential FN/FP scorer (Unit 1c)

Diff the oracle's truth set against real `code_impact` output; produce FN rate (gated) and FP rate by confidence (diagnostic).

**Files:**
- Create: `bench/impact-score.ts`
- Test: `tests/bench/impact-score.test.ts`

**Interfaces:**
- Consumes: `OracleTarget[]` (Task 5), `findIncomingReferences`.
- Produces: `scoreImpact(db: Database, oracle: readonly OracleTarget[], repo: string) => ImpactBenchReport`

- [ ] **Step 1: Write the failing scorer test**

Create `tests/bench/impact-score.test.ts`. Build a repo with (a) a plain cross-module call that `code_impact` resolves (FN 0) and (b) a namespace member call `ns.baz()` that `code_impact` misses but tsc resolves (FN > 0), both targeting exported functions:

```ts
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadCodeindexConfig } from '../../src/config.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import { openDatabase } from '../../src/storage/db.js'
import { buildReferenceOracle } from '../../bench/impact-oracle.js'
import { scoreImpact } from '../../bench/impact-score.js'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const build = async (): Promise<{ db: import('bun:sqlite').Database; dir: string }> => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-score-'))
  dirs.push(dir)
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  // Two exported functions. `foo` is called plainly (code_impact resolves it → FN 0).
  // `baz` is called only via a namespace member access `ns.baz()`, which code_impact
  // stores as opaque text 'ns.baz' and cannot resolve, and `import * as ns` produces no
  // edge — so code_impact misses it while tsc finds it. Both targets are unambiguously
  // exported (no reliance on member-tier behavior).
  writeFileSync(
    path.join(dir, 'src/a.ts'),
    'export function foo(): number { return 1 }\nexport function baz(): number { return 2 }\n',
  )
  writeFileSync(
    path.join(dir, 'src/b.ts'),
    "import { foo } from './a'\nimport * as ns from './a'\n" +
      'export function bar(): number { return foo() }\n' +
      'export function qux(): number { return ns.baz() }\n',
  )
  writeFileSync(path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', strict: true }, include: ['src'] }))
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
  const config = await loadCodeindexConfig({ configPath: path.join(dir, '.codeindex.json'), repoRoot: dir })
  await indexCodebase({ config, mode: 'full' })
  return { db: openDatabase(config.dbPath), dir }
}

describe('scoreImpact', () => {
  test('FN is zero for a resolved call and positive for a missed namespace member call', async () => {
    const { db, dir } = await build()
    try {
      const oracle = buildReferenceOracle(db, { repoRoot: dir, tsconfigPath: path.join(dir, 'tsconfig.json') })
      const report = scoreImpact(db, oracle, 'fixture')
      expect(report.trueReferenceCount).toBeGreaterThan(0)
      expect(report.falseNegativeRate).toBeGreaterThanOrEqual(0)
      expect(report.falseNegativeRate).toBeLessThanOrEqual(1)
      // foo() is resolved → not a false negative.
      const foo = report.perTarget.find((t) => t.target.endsWith('#foo'))
      expect(foo!.falseNegatives).toBe(0)
      // ns.baz() is missed → baz has a true source (qux) code_impact does not report.
      const baz = report.perTarget.find((t) => t.target.endsWith('#baz'))
      expect(baz!.trueSourceCount).toBeGreaterThan(0)
      expect(baz!.falseNegatives).toBeGreaterThan(0)
      expect(report.falseNegatives).toBeGreaterThanOrEqual(1)
    } finally {
      db.close()
    }
  })
})
```

- [ ] **Step 2: Run it red**

Run: `bun test tests/bench/impact-score.test.ts`
Expected: FAIL — `scoreImpact` not defined.

- [ ] **Step 3: Implement `scoreImpact`**

Create `bench/impact-score.ts`:

```ts
import type { Database } from 'bun:sqlite'

import { findIncomingReferences } from '../src/search/index.js'
import type { ImpactBenchReport, ImpactTargetScore, OracleTarget } from './impact-types.js'

const IMPACT_LIMIT = 100000

interface ImpactSource {
  readonly name: string
  readonly confidence: string
}

// Distinct incoming sources code_impact reports for a target, excluding module-scope
// (null) sources and self-references — matching the oracle's exclusions.
const impactSources = (db: Database, target: string): readonly ImpactSource[] => {
  const byName = new Map<string, string>()
  for (const row of findIncomingReferences(db, { qualifiedName: target, limit: IMPACT_LIMIT })) {
    if (row.sourceQualifiedName === null || row.sourceQualifiedName === target) continue
    // Keep the strongest confidence seen for this source.
    const rank = (c: string): number => (c === 'resolved' ? 3 : c === 'file_resolved' ? 2 : 1)
    const existing = byName.get(row.sourceQualifiedName)
    if (existing === undefined || rank(row.confidence) > rank(existing)) {
      byName.set(row.sourceQualifiedName, row.confidence)
    }
  }
  return [...byName].map(([name, confidence]) => ({ name, confidence }))
}

export const scoreImpact = (
  db: Database,
  oracle: readonly OracleTarget[],
  repo: string,
): ImpactBenchReport => {
  const fpByConfidence: Record<string, number> = {}
  let trueReferenceCount = 0
  let impactReferenceCount = 0
  let falseNegatives = 0
  let falsePositives = 0

  const perTarget: readonly ImpactTargetScore[] = oracle.map((entry) => {
    const truth = new Set(entry.trueSources)
    const reported = impactSources(db, entry.target)
    const reportedNames = new Set(reported.map((r) => r.name))

    const fn = [...truth].filter((s) => !reportedNames.has(s)).length
    const fpRows = reported.filter((r) => !truth.has(r.name))
    for (const fp of fpRows) fpByConfidence[fp.confidence] = (fpByConfidence[fp.confidence] ?? 0) + 1

    trueReferenceCount += truth.size
    impactReferenceCount += reported.length
    falseNegatives += fn
    falsePositives += fpRows.length

    return {
      target: entry.target,
      trueSourceCount: truth.size,
      impactSourceCount: reported.length,
      falseNegatives: fn,
      falsePositives: fpRows.length,
    }
  })

  return {
    repo,
    targetsScored: oracle.length,
    trueReferenceCount,
    impactReferenceCount,
    falseNegatives,
    falseNegativeRate: trueReferenceCount === 0 ? 0 : falseNegatives / trueReferenceCount,
    falsePositives,
    falsePositiveRate: impactReferenceCount === 0 ? 0 : falsePositives / impactReferenceCount,
    falsePositivesByConfidence: fpByConfidence,
    perTarget,
  }
}
```

- [ ] **Step 4: Run it green + check + commit**

Run: `bun test tests/bench/impact-score.test.ts` → PASS; `bun run check` → PASS
```bash
git add bench/impact-score.ts tests/bench/impact-score.test.ts
git commit -m "feat(bench): differential code_impact FN/FP scorer vs tsc oracle"
```

---

## Task 7: FN-rate gate + CLI runner + scripts (Unit 1d/1e)

Wrap the oracle+scorer in a runner that mirrors `index-bench-run.ts`: freeze the report to committed JSON and gate on FN-rate increase.

**Files:**
- Create: `bench/impact-compare.ts`
- Create: `bench/impact-run.ts`
- Test: `tests/bench/impact-compare.test.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `ImpactBenchReport`, `ImpactBaseline`, `ImpactBaselineSchema`.
- Produces: `compareImpact(report, baseline, tolerance) => { regressed: boolean; delta: number }`

- [ ] **Step 1: Write the failing compare test**

Create `tests/bench/impact-compare.test.ts`:
```ts
import { describe, expect, test } from 'bun:test'
import { compareImpact } from '../../bench/impact-compare.js'
import type { ImpactBaseline, ImpactBenchReport } from '../../bench/impact-types.js'

const baseline: ImpactBaseline = {
  targetsScored: 10, trueReferenceCount: 100, falseNegatives: 30, falseNegativeRate: 0.3, falsePositiveRate: 0.1,
}
const report = (fnRate: number): ImpactBenchReport => ({
  repo: 'x', targetsScored: 10, trueReferenceCount: 100, impactReferenceCount: 90,
  falseNegatives: Math.round(fnRate * 100), falseNegativeRate: fnRate, falsePositives: 9,
  falsePositiveRate: 0.1, falsePositivesByConfidence: {}, perTarget: [],
})

describe('compareImpact', () => {
  test('FN rate increasing past tolerance is a regression', () => {
    expect(compareImpact(report(0.35), baseline, 1e-9).regressed).toBe(true)
  })
  test('FN rate dropping is an improvement, not a regression', () => {
    expect(compareImpact(report(0.2), baseline, 1e-9).regressed).toBe(false)
  })
})
```

- [ ] **Step 2: Run it red** — `bun test tests/bench/impact-compare.test.ts` → FAIL (not defined)

- [ ] **Step 3: Implement `compareImpact`**

Create `bench/impact-compare.ts`:
```ts
import type { ImpactBaseline, ImpactBenchReport } from './impact-types.js'

export interface ImpactComparison {
  readonly regressed: boolean
  readonly delta: number
}

// FN rate going UP means code_impact newly misses more true usages — a regression.
// FP rate is reported by the runner but not gated in Slice 1 (diagnostic only).
export const compareImpact = (
  report: ImpactBenchReport,
  baseline: ImpactBaseline,
  tolerance: number,
): ImpactComparison => {
  const delta = report.falseNegativeRate - baseline.falseNegativeRate
  return { regressed: delta > tolerance, delta }
}
```

- [ ] **Step 4: Run it green** — `bun test tests/bench/impact-compare.test.ts` → PASS

- [ ] **Step 5: Implement the CLI runner**

Create `bench/impact-run.ts` (mirrors `index-bench-run.ts` — parse args, index, build oracle, score, print, freeze/gate):
```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { loadCodeindexConfig } from '../src/config.js'
import { indexCodebase } from '../src/indexer/index-codebase.js'
import { openDatabase } from '../src/storage/db.js'
import { compareImpact } from './impact-compare.js'
import { buildReferenceOracle } from './impact-oracle.js'
import { scoreImpact } from './impact-score.js'
import { type ImpactBaseline, ImpactBaselineSchema, type ImpactBenchReport } from './impact-types.js'

interface Args {
  readonly repo: string
  readonly tsconfig: string
  readonly baseline: string | null
  readonly updateBaseline: boolean
  readonly maxTargets: number | undefined
}

const parseArgs = (argv: readonly string[]): Args => {
  let repo = process.cwd()
  let tsconfig: string | null = null
  let baseline: string | null = null
  let updateBaseline = false
  let maxTargets: number | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--repo' && value !== undefined) { repo = path.resolve(value); i += 1 }
    else if (flag === '--tsconfig' && value !== undefined) { tsconfig = path.resolve(value); i += 1 }
    else if (flag === '--baseline' && value !== undefined) { baseline = path.resolve(value); i += 1 }
    else if (flag === '--max-targets' && value !== undefined) { maxTargets = Number.parseInt(value, 10); i += 1 }
    else if (flag === '--update-baseline') { updateBaseline = true }
  }
  return { repo, tsconfig: tsconfig ?? path.join(repo, 'tsconfig.json'), baseline, updateBaseline, maxTargets }
}

const toBaseline = (r: ImpactBenchReport): ImpactBaseline => ({
  targetsScored: r.targetsScored,
  trueReferenceCount: r.trueReferenceCount,
  falseNegatives: r.falseNegatives,
  falseNegativeRate: r.falseNegativeRate,
  falsePositiveRate: r.falsePositiveRate,
})

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))
  const config = await loadCodeindexConfig({ configPath: path.join(args.repo, '.codeindex.json'), repoRoot: args.repo })
  await indexCodebase({ config, mode: 'full' })
  const db = openDatabase(config.dbPath)
  const report = ((): ImpactBenchReport => {
    try {
      const oracle = buildReferenceOracle(db, { repoRoot: args.repo, tsconfigPath: args.tsconfig, maxTargets: args.maxTargets })
      return scoreImpact(db, oracle, path.basename(args.repo))
    } finally {
      db.close()
    }
  })()
  console.log(JSON.stringify(report, null, 2))

  if (args.updateBaseline && args.baseline === null) {
    console.error('--update-baseline requires --baseline <path>; no baseline written.')
  }
  if (args.updateBaseline && args.baseline !== null) {
    writeFileSync(args.baseline, `${JSON.stringify(toBaseline(report), null, 2)}\n`)
    console.error(`Impact baseline written to ${args.baseline}`)
    return
  }
  if (args.baseline !== null && existsSync(args.baseline)) {
    const baseline = ImpactBaselineSchema.parse(JSON.parse(readFileSync(args.baseline, 'utf8')) as unknown)
    const comparison = compareImpact(report, baseline, 1e-9)
    console.error(
      `falseNegativeRate: ${baseline.falseNegativeRate.toFixed(4)} -> ${report.falseNegativeRate.toFixed(4)} (${comparison.delta >= 0 ? '+' : ''}${comparison.delta.toFixed(4)})`,
    )
    console.error(`falsePositiveRate (diagnostic): ${report.falsePositiveRate.toFixed(4)} by confidence ${JSON.stringify(report.falsePositivesByConfidence)}`)
    if (comparison.regressed) {
      console.error('code_impact false-negative rate regressed against baseline.')
      process.exit(1)
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
```

- [ ] **Step 6: Add scripts to `package.json`**

Add to `scripts` (after the `bench:fuzz` line):
```json
    "bench:impact": "bun run bench/impact-run.ts",
    "bench:impact:check": "bun run bench/impact-run.ts --baseline bench/impact-baseline.json",
    "bench:impact:papai": "bun run bench/impact-run.ts --repo ../papai --max-targets 300 --baseline bench/impact-baseline.papai.json"
```

- [ ] **Step 7: Smoke the runner on codeindex itself + check + commit**

Run: `bun run bench:impact` (from the repo root, no baseline → prints a report to stdout).
Expected: a JSON report with `targetsScored > 0`, `trueReferenceCount > 0`, and a `falseNegativeRate` in [0,1]. Note the FN/FP numbers — they are the headline instrument output.
Run: `bun run check` → PASS
```bash
git add bench/impact-compare.ts bench/impact-run.ts tests/bench/impact-compare.test.ts package.json
git commit -m "feat(bench): FN-rate gate + impact-run CLI + bench:impact scripts"
```

---

## Task 8: Capture frozen baselines + progress ledger (Unit 1f)

Freeze the instrument's numbers on both repos and prove the gate both ways.

**Files:**
- Create: `bench/impact-baseline.json`, `bench/impact-baseline.papai.json`
- Modify: `.superpowers/sdd/progress.md`

- [ ] **Step 1: Capture the codeindex baseline**

Run: `bun run bench/impact-run.ts --baseline bench/impact-baseline.json --update-baseline`
Expected: writes `bench/impact-baseline.json`. Open it — confirm `falseNegativeRate` is present and plausible (codeindex is functional-TS with few classes, so member-call FN should be low; the interesting FN is on papai).

- [ ] **Step 2: Capture the papai baseline** (assumes `../papai` exists with its `tsconfig.json`)

Run: `bun run bench/impact-run.ts --repo ../papai --max-targets 300 --baseline bench/impact-baseline.papai.json --update-baseline`
Expected: writes `bench/impact-baseline.papai.json`. This is the headline number: papai's real `code_impact` FN rate. Record it.

- [ ] **Step 3: Prove the gate both ways**

Run: `bun run bench:impact:check` → expected PASS (delta 0.0000).
Temporarily edit `bench/impact-baseline.json` to lower `falseNegativeRate` by 0.05, re-run `bun run bench:impact:check` → expected FAIL (regression). Restore the file (`git checkout bench/impact-baseline.json`).

- [ ] **Step 4: Update the progress ledger**

Append a Slice 1 section to `.superpowers/sdd/progress.md` recording: the three units done, the frozen `impact-baseline.*` FN/FP headline numbers, the re-captured IR MRR (Task 3), and the measured token reduction (Task 1). Mirror the format of the existing Phase 1 plan entries.

- [ ] **Step 5: Commit**

```bash
git add bench/impact-baseline.json bench/impact-baseline.papai.json .superpowers/sdd/progress.md
git commit -m "feat(bench): capture frozen code_impact FN/FP baselines (codeindex + papai)"
```

---

## Self-Review (completed during planning)

**Spec coverage** — every Slice 1 exit criterion maps to a task:
- "FN rate measured on ≥2 repos, frozen JSON, single command, CI gate" → Tasks 5–8.
- "FP rate reported by confidence tier (diagnostic, not gated)" → Task 6 (`falsePositivesByConfidence`) + Task 7 (printed, `compareImpact` gates FN only).
- "BM25 blended; NL-intent RR up, no MRR regression" → Tasks 2–3 (Task 3 Step 6 gate check, Step 7 re-capture). Exact-pool de-dup dropped as a verified no-op (see Task 3 note).
- "Payload de-duplicated; measured token reduction; protocol green" → Task 1.
- "type-checker confined to `bench/`, enforced" → Task 4 (`impact-guard.test.ts`, scoped to the checker-construction APIs since `src/` already uses `typescript` for tsconfig parsing).
- "in-degree deferred" → honored (not in any task; noted in spec).

**Placeholder scan:** no TBD/TODO; every code step carries complete code. (The earlier `EXISTING_SYMBOL_NAME` placeholder was removed with the exact-pool de-dup drop.)

**Type consistency:** `buildReferenceOracle(db, opts)` returns `OracleTarget[]`; `scoreImpact(db, oracle, repo)` consumes it and returns `ImpactBenchReport`; `compareImpact(report, baseline, tolerance)` consumes `ImpactBenchReport` + `ImpactBaseline`. `SearchResult.relevance?` produced in Task 2, consumed in Task 3's `rank.ts`. `buildStructuredToolResult(schema, output, summaryText)` — the new 3rd param is used at all 4 server call sites and both unit tests.

**Known risk (documented in spec go/no-go):** the `declarationOffset` name+line heuristic could mis-locate a symbol whose name repeats on its declaration line. Mitigation: the ≤1-line tolerance + name match handles the common case; if papai FN proves untrustworthy, fall back to a curated target set (spec's Unit 1 go/no-go). The fixtures in Tasks 5–6 validate the mapping deterministically.

---

## Execution Handoff

Plan complete. Recommended: **subagent-driven** — one fresh subagent per task with two-stage review between tasks, matching how Phase 1 was executed (each task has an independently testable deliverable and a clean commit).
