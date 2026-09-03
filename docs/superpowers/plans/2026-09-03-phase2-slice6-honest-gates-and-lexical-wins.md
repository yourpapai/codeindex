# Phase 2 Slice 6 — Honest Gates & Lexical Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bank the remaining no-research Phase 2 items: type-tier memo instrumentation, the five lexical fixes (NOCASE exact tier, FTS snippet column, prefix queries, LIKE escaping, acronym tokenization), in-degree ranking, and the file-size guard — all carried by one SCHEMA_VERSION 4 migration.

**Architecture:** One schema bump (v3→v4) declares `COLLATE NOCASE` on the three exact-match columns and adds `symbols.in_degree` (backfilled once per index run post-resolve). Search layers select `in_degree` and `rank.ts` blends it as a bounded log-dampened term mirroring the existing BM25 pattern. Tokenization and the guard are isolated pure-function changes in the indexer.

**Tech Stack:** Bun, TypeScript, SQLite (bun:sqlite), FTS5, tree-sitter, zod, oxlint/oxfmt.

**Spec:** `docs/superpowers/specs/2026-09-03-phase2-slice6-honest-gates-and-lexical-wins-design.md`

## Global Constraints

- SCHEMA_VERSION bumps exactly once, 3→4, in Task 2. No other task bumps it.
- IR gate must be up-or-flat (precision@k + MRR); impact FN/FP gates flat-or-better. Baselines are regenerated ONLY in Task 11 — intermediate tasks must not write baseline files.
- No resolver/graph changes in this slice (no `src/resolver/` edits except none planned).
- Every fix lands RED→GREEN: the failing test is written and observed failing before the implementation.
- After each task: `bun run lint && bun run typecheck && bun run format:check` clean for touched files, targeted tests green. Full `bun run check` only at Task 11 (earlier tasks leave baselines stale by design; `check:bench` compares against them and may be red mid-slice — that is expected).
- Conventional commits, style matching repo history (`feat(search): …`, `fix(indexer): …`).

---

### Task 1: Type-tier FN shape breakdown (Unit 0 — bench-only memo instrumentation)

**Files:**
- Modify: `bench/impact-oracle.ts:258-263` (collect shapes for type-position refs too)
- Modify: `bench/impact-score.ts` (`scoreTarget`, `TargetTally`, `scoreImpact`)
- Modify: `bench/impact-types.ts` (`ImpactBenchReport`)
- Test: `tests/bench/impact-score.test.ts`
- Amend: `docs/superpowers/specs/2026-09-03-phase2-slice6-honest-gates-and-lexical-wins-design.md` (memo results)

**Interfaces:**
- Consumes: existing `classifyShape(sf, pos, checker)` in `bench/impact-ast.ts:57` (already handles heritage via `ts.isHeritageClause` — works for type positions as-is).
- Produces: `ImpactBenchReport.typeTrueReferenceCountByShape: Readonly<Record<string, number>>` and `ImpactBenchReport.typeFalseNegativesByShape: Readonly<Record<string, number>>`. `ImpactBaselineSchema` is NOT extended (baselines stay 7 fields; new report fields don't participate in compare).

- [ ] **Step 1: Write the failing test**

In `tests/bench/impact-score.test.ts`, find the existing value-shape assertions (search for `valueFalseNegativesByShape`). Add alongside, using the same fixture style already present in that file (an oracle target whose true source is type-position, e.g. an `extends` reference the resolver fails to cover):

```ts
test('type-tier false negatives break down by shape', () => {
  // Reuse the file's existing fixture pattern: an OracleTarget with a type-position true source
  // (position: 'type', shapes: ['heritage']) that code_impact does not report.
  const report = scoreImpact(db, oracleWithTypeOnlySource, 'fixture')
  expect(report.typeFalseNegativesByShape).toEqual({ heritage: 1 })
  expect(report.typeTrueReferenceCountByShape).toEqual({ heritage: 1 })
})
```

Adapt the fixture construction to the helpers already used in this test file for the value-shape tests — the shape of the assertion, not a new harness, is what's new.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bench/impact-score.test.ts`
Expected: FAIL — `typeFalseNegativesByShape` is `undefined` on the report.

- [ ] **Step 3: Implement**

`bench/impact-oracle.ts` — classify shapes regardless of position (currently only the `value` branch does):

```ts
      const agg = byName.get(enclosing) ?? { value: false, type: false, shapes: Set<Shape> }
      if (position === 'value') {
        agg.value = true
      } else {
        agg.type = true
      }
      agg.shapes.add(classifyShape(sf, pos, checker))
```

(replacing the current `if/else` where only the value branch adds shapes; keep the `{ value: false, type: false, shapes: new Set<Shape>() }` initializer as-is)

`bench/impact-score.ts` — in `scoreTarget`, add alongside the existing shape records:

```ts
  const typeTrueByShape: Record<string, number> = {}
  const typeFalseNegativesByShape: Record<string, number> = {}
```

and in the `else` branch of the source loop (the `typeTrue += 1` branch):

```ts
    } else {
      typeTrue += 1
      if (!covered) typeFalseNegatives += 1
      for (const shape of source.shapes) {
        typeTrueByShape[shape] = (typeTrueByShape[shape] ?? 0) + 1
        if (!covered) typeFalseNegativesByShape[shape] = (typeFalseNegativesByShape[shape] ?? 0) + 1
      }
    }
```

Add both to `TargetTally` and its return object, then aggregate in `scoreImpact` next to the value aggregates:

```ts
  const typeTrueReferenceCountByShape: Record<string, number> = {}
  const typeFalseNegativesByShape: Record<string, number> = {}
  // in the tally fold:
    addCounts(typeTrueReferenceCountByShape, tally.typeTrueByShape)
    addCounts(typeFalseNegativesByShape, tally.typeFalseNegativesByShape)
```

and to the returned report object next to `valueFalseNegativesByShape`:

```ts
    typeTrueReferenceCountByShape,
    typeFalseNegativesByShape,
```

`bench/impact-types.ts` — extend `ImpactBenchReport`:

```ts
  readonly typeTrueReferenceCountByShape: Readonly<Record<string, number>>
  readonly typeFalseNegativesByShape: Readonly<Record<string, number>>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/bench/impact-score.test.ts && bun test tests/bench/`
Expected: PASS, no other bench test broken (if a test constructs a full report literal, add the two new empty-record fields to that literal).

- [ ] **Step 5: Run the memo and amend the spec**

Run (no `--baseline`, so no compare):
`bun run bench/impact-run.ts --repo ../papai --max-targets 300`

From the printed `typeFalseNegativesByShape` / `typeTrueReferenceCountByShape`, trace the dominant categories to papai source exactly as Slice 5 did for call-FNs. Cross-check specific targets against the papai DB:

```bash
sqlite3 ../papai/.codeindex/index.db \
  "SELECT edge_type, confidence, COUNT(*) FROM symbol_references WHERE target_name IN (<top type-FN target names>) GROUP BY edge_type, confidence"
```

Amend the spec's Unit 0 section with: the categorized table, the oracle-artifact vs real-gap verdict per category, and the recommendation (real gap → candidate edge-type for a follow-up spec; artifact → bench fix follow-up). Add a "Follow-up #1 (type-tier sizing): CLOSED" subsection in the established style.

- [ ] **Step 6: Commit**

```bash
git add bench/ tests/bench/impact-score.test.ts docs/superpowers/specs/2026-09-03-phase2-slice6-honest-gates-and-lexical-wins-design.md
git commit -m "feat(bench): type-tier FN breakdown by shape (Slice 6, Unit 0 memo)"
```

---

### Task 2: Schema v4 — NOCASE columns, in_degree column, version bump

**Files:**
- Modify: `src/storage/schema.ts:21-47` (symbols, module_exports tables), `src/storage/schema.ts:120` (SCHEMA_VERSION)
- Test: `tests/storage/schema.test.ts`

**Interfaces:**
- Produces: `symbols.in_degree INTEGER NOT NULL DEFAULT 0` (Task 8 backfills it); case-insensitive equality on `symbols.local_name`, `symbols.qualified_name`, `module_exports.export_name` (Tasks 3, 9 rely on it). All existing INSERTs are unaffected (explicit column lists; `in_degree` defaults).

- [ ] **Step 1: Write the failing test**

Append to `tests/storage/schema.test.ts` (reuse the file's existing imports; add `import { Database } from 'bun:sqlite'` if absent):

```ts
describe('schema v4', () => {
  test('local_name and qualified_name match case-insensitively; in_degree defaults to 0', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    db.query(
      `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at) VALUES (1, 'src/a.ts', 'src/a', 'ts', 'x', 'indexed', NULL, datetime('now'))`,
    ).run()
    db.query(
      `INSERT INTO symbols (id, file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line)
       VALUES (1, 1, 'src/a.ts', 'src/a', 'src/a.ts#1-2', 'getUserById', 'src/a#getUserById', 'function_declaration', 'exported', NULL, '[]', '', '', '', 'get user by id', 1, 2)`,
    ).run()

    const row = db
      .query<{ id: number; in_degree: number }, [string]>('SELECT id, in_degree FROM symbols WHERE local_name = ?')
      .get('getuserbyid')
    expect(row).not.toBeNull()
    expect(row!.in_degree).toBe(0)

    const qualified = db
      .query<{ id: number }, [string]>('SELECT id FROM symbols WHERE qualified_name = ?')
      .get('src/a#getuserbyid')
    expect(qualified).not.toBeNull()

    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(4)
  })

  test('module_exports.export_name matches case-insensitively', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    db.query(
      `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at) VALUES (1, 'src/a.ts', 'src/a', 'ts', 'x', 'indexed', NULL, datetime('now'))`,
    ).run()
    db.query(
      `INSERT INTO module_exports (id, file_id, export_name, export_kind, symbol_id, target_module_specifier) VALUES (1, 1, 'getUserById', 'named', NULL, NULL)`,
    ).run()
    const row = db.query<{ id: number }, [string]>('SELECT id FROM module_exports WHERE export_name = ?').get('getuserbyid')
    expect(row).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/storage/schema.test.ts`
Expected: FAIL — case-sensitive lookup returns null / user_version is 3 / `in_degree` column does not exist.

- [ ] **Step 3: Implement**

`src/storage/schema.ts` — in the `symbols` table definition, change the two columns and append the new one:

```ts
    local_name TEXT NOT NULL COLLATE NOCASE,
    qualified_name TEXT NOT NULL COLLATE NOCASE,
```

```ts
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    in_degree INTEGER NOT NULL DEFAULT 0
```

In `module_exports`:

```ts
    export_name TEXT NOT NULL COLLATE NOCASE,
```

Bump the version (comment above it already documents the wipe contract):

```ts
const SCHEMA_VERSION = 4
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/storage/schema.test.ts && bun test tests/storage/`
Expected: PASS. If other storage tests fail on column-count-sensitive raw INSERTs, add `in_degree`-omitting inserts are fine (DEFAULT 0) — fix only genuinely broken expectations.

- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.ts tests/storage/schema.test.ts
git commit -m "feat(schema): SCHEMA_VERSION 4 — NOCASE name columns + symbols.in_degree (Slice 6)"
```

---

### Task 3: NOCASE exact tier — case-mismatched queries hit the exact tier

**Files:**
- Modify: `src/search/exact.ts:69-76` (matchReason comparisons)
- Test: `tests/search/exact.test.ts`

**Interfaces:**
- Consumes: Task 2's column collations (SQL-side folding is free).
- Produces: `runExactSearch` returns case-insensitive exact matches; `matchReason` stays truthful via case-insensitive JS comparison.

- [ ] **Step 1: Write the failing test**

Append to `tests/search/exact.test.ts`:

```ts
describe('runExactSearch case-insensitive matching', () => {
  test('case-mismatched query still hits the exact tier', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    insertFile(db, 1, 'src/user.ts', 'src/user')
    insertSymbol(db, {
      id: 1,
      fileId: 1,
      filePath: 'src/user.ts',
      moduleKey: 'src/user',
      symbolKey: 'src/user.ts#1-2',
      localName: 'getUserById',
      qualifiedName: 'src/user#getUserById',
      kind: 'function_declaration',
      scopeTier: 'exported',
      exportNames: '["getUserById"]',
      signatureText: 'export function getUserById()',
      docText: '',
      bodyText: 'x',
      identifierTerms: 'get user by id',
      startLine: 1,
      endLine: 2,
    })

    const results = runExactSearch(db, 'getuserbyid', 10, {})
    expect(results).toHaveLength(1)
    expect(results[0]!.matchReason).toBe('exact local_name')
    expect(results[0]!.confidence).toBe('exact')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/search/exact.test.ts`
Expected: FAIL — `results` is empty (BINARY collation on `local_name = ?`).

- [ ] **Step 3: Implement**

In `src/search/exact.ts`, the SQL is already fixed by Task 2's collations. Only the JS-side matchReason needs case-insensitive equality. Add near the top of the file:

```ts
const eqNoCase = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase()
```

Replace the matchReason chain in `mapExactRow` (exact.ts:69-76):

```ts
  matchReason:
    row.matched_export_name !== null && eqNoCase(row.matched_export_name, query)
      ? 'exact export_names'
      : eqNoCase(row.qualified_name, query)
        ? 'exact qualified_name'
        : eqNoCase(row.local_name, query)
          ? 'exact local_name'
          : 'exact file_path',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/search/exact.test.ts && bun test tests/search/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/search/exact.ts tests/search/exact.test.ts
git commit -m "feat(search): case-insensitive exact tier (Slice 6, 1b NOCASE)"
```

---

### Task 4: FTS snippet column — signature_text instead of doc_text

**Files:**
- Modify: `src/search/fts.ts:60`
- Test: `tests/search/fts.test.ts`

**Interfaces:**
- Consumes: FTS5 column order (`0 local_name, 1 qualified_name, 2 export_names, 3 identifier_terms, 4 signature_text, 5 doc_text, 6 body_text, 7 file_path`).
- Produces: FTS-tier results carry a populated `snippet` sourced from `signature_text`.

- [ ] **Step 1: Write the failing test**

Append to `tests/search/fts.test.ts` (reuse that file's existing insert helpers; if it defines none, copy the `insertFile`/`insertSymbol` helpers verbatim from `tests/search/exact.test.ts:7-54`):

```ts
describe('runFtsSearch snippet', () => {
  test('snippets signature_text when doc_text is empty', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    insertFile(db, 1, 'src/helper.ts', 'src/helper')
    insertSymbol(db, {
      id: 1,
      fileId: 1,
      filePath: 'src/helper.ts',
      moduleKey: 'src/helper',
      symbolKey: 'src/helper.ts#1-2',
      localName: 'helper',
      qualifiedName: 'src/helper#helper',
      kind: 'function_declaration',
      scopeTier: 'exported',
      exportNames: '["helper"]',
      signatureText: 'export function helper()',
      docText: '',
      bodyText: 'function helper() {\n  return 1\n}',
      identifierTerms: 'helper',
      startLine: 1,
      endLine: 2,
    })

    const results = runFtsSearch(db, 'helper', 10, {})
    expect(results).toHaveLength(1)
    expect(results[0]!.snippet).toContain('export function helper')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/search/fts.test.ts`
Expected: FAIL — snippet is empty (column 5 = doc_text is `''`).

- [ ] **Step 3: Implement**

In `src/search/fts.ts:60`, change column index 5 → 4:

```ts
            snippet(symbol_fts, 4, '[', ']', '...', 12) AS snippet,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/search/fts.test.ts && bun test tests/search/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/search/fts.ts tests/search/fts.test.ts
git commit -m "fix(search): FTS snippet reads signature_text instead of empty doc_text (Slice 6, 1b)"
```

---

### Task 5: Activate the prefix index — partial-identifier FTS matching

**Files:**
- Modify: `src/search/fts.ts` (`loadFtsResults`)
- Test: `tests/search/fts.test.ts`

**Interfaces:**
- Consumes: `sanitizeFtsQuery` (strips FTS syntax incl. `*`, so appending a prefix `*` is safe); `prefix='2 3'` index already declared in schema.
- Produces: single-token queries match token prefixes; multi-token queries unchanged.

- [ ] **Step 1: Write the failing test**

Append to `tests/search/fts.test.ts`:

```ts
describe('runFtsSearch prefix matching', () => {
  test('partial identifier matches via token prefix', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    insertFile(db, 1, 'src/user.ts', 'src/user')
    insertSymbol(db, {
      id: 1,
      fileId: 1,
      filePath: 'src/user.ts',
      moduleKey: 'src/user',
      symbolKey: 'src/user.ts#1-2',
      localName: 'getUserById',
      qualifiedName: 'src/user#getUserById',
      kind: 'function_declaration',
      scopeTier: 'exported',
      exportNames: '["getUserById"]',
      signatureText: 'export function getUserById()',
      docText: '',
      bodyText: 'x',
      identifierTerms: 'get user by id',
      startLine: 1,
      endLine: 2,
    })

    const results = runFtsSearch(db, 'getuser', 10, {})
    expect(results).toHaveLength(1)
  })

  test('multi-token queries are not prefix-expanded', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    insertFile(db, 1, 'src/user.ts', 'src/user')
    insertSymbol(db, {
      id: 1,
      fileId: 1,
      filePath: 'src/user.ts',
      moduleKey: 'src/user',
      symbolKey: 'src/user.ts#1-2',
      localName: 'getUserById',
      qualifiedName: 'src/user#getUserById',
      kind: 'function_declaration',
      scopeTier: 'exported',
      exportNames: '["getUserById"]',
      signatureText: '',
      docText: '',
      bodyText: '',
      identifierTerms: 'get user by id',
      startLine: 1,
      endLine: 2,
    })

    const results = runFtsSearch(db, 'get user', 10, {})
    expect(results).toHaveLength(1)
  })
})
```

(The second test pins existing multi-token OR behavior so the prefix change cannot regress it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/search/fts.test.ts`
Expected: first test FAIL (no prefix path today); second test PASSES already.

- [ ] **Step 3: Implement**

In `src/search/fts.ts`, add next to `sanitizeFtsQuery`:

```ts
// Single-token queries gain a prefix alternative so partial identifiers
// ('getuser' → 'getUserById') still match; the prefix='2 3' index serves these.
// Multi-token queries keep today's OR-joined behavior untouched.
const buildFtsMatch = (safe: string): string => (safe.includes(' ') ? safe : `${safe} OR ${safe}*`)
```

and in `loadFtsResults`, pass the built expression to the statement instead of `safe`:

```ts
    .all(buildFtsMatch(safe), limit)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/search/fts.test.ts && bun test tests/search/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/search/fts.ts tests/search/fts.test.ts
git commit -m "feat(search): prefix-match single-token FTS queries (Slice 6, 1b prefix index)"
```

---

### Task 6: Escape LIKE wildcards in the file_path exact fallback

**Files:**
- Modify: `src/search/exact.ts:109,112`
- Test: `tests/search/exact.test.ts`

**Interfaces:**
- Produces: `%`, `_`, `\` in queries match literally in the `file_path LIKE` clause (the only LIKE in `src/`).

- [ ] **Step 1: Write the failing test**

Append to `tests/search/exact.test.ts`:

```ts
describe('runExactSearch LIKE escaping', () => {
  const seed = (db: Database): void => {
    ensureSchema(db)
    insertFile(db, 1, 'src/foo_bar.ts', 'src/foo_bar')
    insertSymbol(db, {
      id: 1,
      fileId: 1,
      filePath: 'src/foo_bar.ts',
      moduleKey: 'src/foo_bar',
      symbolKey: 'src/foo_bar.ts#1-2',
      localName: 'widget',
      qualifiedName: 'src/foo_bar#widget',
      kind: 'function_declaration',
      scopeTier: 'exported',
      exportNames: '["widget"]',
      signatureText: 'export function widget()',
      docText: '',
      bodyText: 'x',
      identifierTerms: 'widget',
      startLine: 1,
      endLine: 2,
    })
  }

  test('underscore in query matches literally, not as wildcard', () => {
    const db = new Database(':memory:')
    seed(db)
    expect(runExactSearch(db, 'fooXbar', 10, {})).toHaveLength(0)
  })

  test('literal underscore query still matches the file path', () => {
    const db = new Database(':memory:')
    seed(db)
    const results = runExactSearch(db, 'foo_bar', 10, {})
    expect(results).toHaveLength(1)
    expect(results[0]!.matchReason).toBe('exact file_path')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/search/exact.test.ts`
Expected: first test FAIL (`fooXbar` wildcard-matches `foo_bar` → 1 result), second PASSES.

- [ ] **Step 3: Implement**

In `src/search/exact.ts`, add:

```ts
const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
```

Change the WHERE clause line:

```ts
        OR symbols.file_path LIKE ? ESCAPE '\\'
```

and the bind args:

```ts
    .all(query, query, query, query, `${escapeLikePattern(query)}%`, limit)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/search/exact.test.ts && bun test tests/search/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/search/exact.ts tests/search/exact.test.ts
git commit -m "fix(search): escape LIKE wildcards in file_path matching (Slice 6, 1b)"
```

---

### Task 7: Acronym-run tokenization in identifier_terms

**Files:**
- Modify: `src/indexer/extract-symbols.ts:53-59` (`normalizeIdentifierTerms` — export it)
- Test: `tests/extract-symbols.test.ts`

**Interfaces:**
- Produces: exported `normalizeIdentifierTerms(name: string): string`; `XMLParser` → `xml parser`. Existing non-acronym normalizations byte-identical. (`src/extract-symbols.ts` re-exports `*`, so the export flows to existing import paths automatically.)

- [ ] **Step 1: Write the failing test**

Append to `tests/extract-symbols.test.ts`:

```ts
import { normalizeIdentifierTerms } from '../src/extract-symbols.js'

describe('normalizeIdentifierTerms acronym runs', () => {
  test('splits acronym boundaries into separate terms', () => {
    expect(normalizeIdentifierTerms('XMLParser')).toBe('xml parser')
    expect(normalizeIdentifierTerms('HTTPClient')).toBe('http client')
    expect(normalizeIdentifierTerms('getXMLHttpRequest')).toBe('get xml http request')
  })

  test('existing normalizations are byte-identical', () => {
    expect(normalizeIdentifierTerms('helper')).toBe('helper')
    expect(normalizeIdentifierTerms('foo_bar')).toBe('foo bar')
    expect(normalizeIdentifierTerms('foo-bar')).toBe('foo bar')
    expect(normalizeIdentifierTerms('getDrizzleDb')).toBe('get drizzle db')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/extract-symbols.test.ts`
Expected: FAIL — `XMLParser` normalizes to `xmlparser` (acronym boundary never matches); `normalizeIdentifierTerms` not exported.

- [ ] **Step 3: Implement**

In `src/indexer/extract-symbols.ts:53`, replace:

```ts
export const normalizeIdentifierTerms = (name: string): string =>
  name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim()
```

(Acronym rule runs first: `XMLParser` → `XML Parser`; the existing camel rule then handles remaining lower→upper boundaries. Glued token `xmlparser` still matches queries via the FTS-indexed `local_name` column, so no existing match regresses.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/extract-symbols.test.ts && bun test tests/indexer/ tests/extract-symbols.test.ts`
Expected: PASS — including the existing assertion `identifierTerms` contains `'get drizzle db'`.

- [ ] **Step 5: Commit**

```bash
git add src/indexer/extract-symbols.ts tests/extract-symbols.test.ts
git commit -m "feat(indexer): split acronym runs in identifier_terms (Slice 6, 1b tokenization)"
```

---

### Task 8: In-degree backfill after resolution

**Files:**
- Modify: `src/storage/queries.ts` (add `backfillSymbolInDegree`)
- Modify: `src/indexer/index-codebase.ts:261-263` (call it in the resolve phase)
- Test: `tests/storage/queries.test.ts`

**Interfaces:**
- Consumes: Task 2's `symbols.in_degree` column; `idx_symbol_references_target_symbol_id` (already exists, schema.ts:72 — the correlated subquery is index-backed).
- Produces: `backfillSymbolInDegree(db: Database): void` — one statement per index run, called by Task 9's ranking consumer indirectly (values land in `symbols.in_degree`).

- [ ] **Step 1: Write the failing test**

Append to `tests/storage/queries.test.ts` (adapt to the file's existing imports/seed helpers; the raw SQL below is self-contained if helpers are absent):

```ts
describe('backfillSymbolInDegree', () => {
  test('counts incoming references per symbol', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    db.query(
      `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at) VALUES (1, 'src/a.ts', 'src/a', 'ts', 'x', 'indexed', NULL, datetime('now'))`,
    ).run()
    for (const id of [1, 2, 3]) {
      db.query(
        `INSERT INTO symbols (id, file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line)
         VALUES (?, 1, 'src/a.ts', 'src/a', ?, ?, ?, 'function_declaration', 'exported', NULL, '[]', '', '', '', 'x', 1, 2)`,
      ).run(id, `src/a.ts#${id}-2`, `s${id}`, `src/a#s${id}`)
    }
    const insertRef = db.query(
      `INSERT INTO symbol_references (id, source_symbol_id, source_file_id, target_symbol_id, target_file_id, target_name, target_export_name, target_module_specifier, edge_type, confidence, line_number)
       VALUES (?, ?, 1, ?, NULL, 'x', NULL, NULL, 'calls', 'resolved', 5)`,
    )
    insertRef.run(1, 2, 1)
    insertRef.run(2, 3, 1)
    insertRef.run(3, 3, 2)

    backfillSymbolInDegree(db)

    const degrees = db.query<{ id: number; in_degree: number }, []>('SELECT id, in_degree FROM symbols ORDER BY id').all()
    expect(degrees.map((d) => d.in_degree)).toEqual([2, 1, 0])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/storage/queries.test.ts`
Expected: FAIL — `backfillSymbolInDegree` is not exported.

- [ ] **Step 3: Implement**

`src/storage/queries.ts` — add near the other persistence helpers:

```ts
export const backfillSymbolInDegree = (db: Database): void => {
  db.run(
    'UPDATE symbols SET in_degree = (SELECT COUNT(*) FROM symbol_references WHERE symbol_references.target_symbol_id = symbols.id)',
  )
}
```

`src/indexer/index-codebase.ts` — import it alongside the other `queries.js` imports and call it inside the resolve phase (index-codebase.ts:261-263):

```ts
  mark = Date.now()
  const { referencesIndexed, referencesUnresolved } = persistResolvedReferences(db, parsedFiles)
  backfillSymbolInDegree(db)
  emitPhase(input.onPhase, 'resolve', mark)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/storage/queries.test.ts && bun test tests/index-codebase.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/queries.ts src/indexer/index-codebase.ts tests/storage/queries.test.ts
git commit -m "feat(storage): backfill symbols.in_degree after reference resolution (Slice 6, 1a)"
```

---

### Task 9: Blend in-degree into ranking

**Files:**
- Modify: `src/types.ts:24` (`SearchResult.inDegree?`)
- Modify: `src/search/exact.ts` (SELECT + row type + mapper)
- Modify: `src/search/fts.ts` (SELECT + row type + mapper)
- Modify: `src/search/rank.ts` (in-degree term)
- Test: `tests/search/rank.test.ts`, `tests/search/exact.test.ts`

**Interfaces:**
- Consumes: Task 8's `symbols.in_degree` values.
- Produces: `SearchResult.inDegree?: number` (optional, mirroring `relevance?` so existing fixtures stay valid); `rerankSearchResults` adds a bounded in-degree term. MCP output unchanged — `RankedSearchResultSchema` in `src/mcp/tools.ts:58-72` deliberately does NOT gain the field (zod strips it; payload economics are Slice 8's).

- [ ] **Step 1: Write the failing tests**

Append to `tests/search/rank.test.ts`:

```ts
describe('in-degree blending', () => {
  const ftsBase = {
    symbolKey: 'k',
    qualifiedName: 'm#a',
    localName: 'a',
    kind: 'function',
    scopeTier: 'exported' as const,
    filePath: 'm.ts',
    startLine: 1,
    endLine: 2,
    exportNames: [] as readonly string[],
    matchReason: 'fts identifier_terms/doc_text/body_text',
    confidence: 'resolved' as const,
    snippet: '',
  }

  test('within a tier, the more-referenced symbol ranks higher', () => {
    const low = { ...ftsBase, symbolKey: 'low', relevance: 0, inDegree: 0 }
    const high = { ...ftsBase, symbolKey: 'high', relevance: 0, inDegree: 25 }
    const ranked = rerankSearchResults([low, high])
    expect(ranked[0]!.symbolKey).toBe('high')
  })

  test('missing inDegree contributes nothing (scores unchanged)', () => {
    const ranked = rerankSearchResults([{ ...ftsBase, symbolKey: 'only' }])
    expect(ranked[0]!.rankScore).toBe(400)
  })
})
```

Append to `tests/search/exact.test.ts` (inside the file's existing describe style):

```ts
test('exact results carry in_degree from storage', () => {
  const db = new Database(':memory:')
  ensureSchema(db)
  insertFile(db, 1, 'src/hot.ts', 'src/hot')
  insertSymbol(db, {
    id: 1,
    fileId: 1,
    filePath: 'src/hot.ts',
    moduleKey: 'src/hot',
    symbolKey: 'src/hot.ts#1-2',
    localName: 'hot',
    qualifiedName: 'src/hot#hot',
    kind: 'function_declaration',
    scopeTier: 'exported',
    exportNames: '["hot"]',
    signatureText: '',
    docText: '',
    bodyText: '',
    identifierTerms: 'hot',
    startLine: 1,
    endLine: 2,
  })
  db.query('UPDATE symbols SET in_degree = 7 WHERE id = 1').run()

  const results = runExactSearch(db, 'hot', 10, {})
  expect(results[0]!.inDegree).toBe(7)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/search/rank.test.ts tests/search/exact.test.ts`
Expected: FAIL — `inDegree` does not exist on `SearchResult` / results carry `undefined`.

- [ ] **Step 3: Implement**

`src/types.ts` — inside `SearchResult`, after `relevance`:

```ts
  readonly relevance?: number
  readonly inDegree?: number
```

`src/search/exact.ts` — add `symbols.in_degree AS in_degree` to the SELECT list (after `symbols.export_names,`), add `in_degree: number` to the row type, and map in the mapper object:

```ts
      inDegree: row.in_degree,
```

`src/search/fts.ts` — same three edits (SELECT after `symbols.export_names,`, row type, mapper).

`src/search/rank.ts` — add the term in the established BM25 style:

```ts
// In-degree is blended like BM25: bounded and normalized across the current result set, so a
// popular symbol reorders *within* its tier without overtaking exact-name matches. log1p
// dampens hubs; IN_DEGREE_WEIGHT is calibrated once against the IR gate (Slice 6).
const IN_DEGREE_WEIGHT = 30

const maxInDegree = (results: readonly SearchResult[]): number =>
  results.reduce((max, r) => (r.inDegree !== undefined && r.inDegree > max ? r.inDegree : max), 0)

const inDegreeScore = (result: Readonly<SearchResult>, max: number): number =>
  result.inDegree === undefined || max <= 0 ? 0 : (Math.log1p(result.inDegree) / Math.log1p(max)) * IN_DEGREE_WEIGHT
```

and in `rerankSearchResults`:

```ts
export const rerankSearchResults = (results: readonly SearchResult[]): readonly RankedSearchResult[] => {
  const maxRel = maxRelevance(results)
  const maxDeg = maxInDegree(results)
  return [...results]
    .map((result) => ({
      ...result,
      rankScore: scoreSearchResult(result) + relevanceScore(result, maxRel) + inDegreeScore(result, maxDeg),
    }))
    .sort((left, right) => right.rankScore - left.rankScore)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/search/`
Expected: PASS — all pre-existing rank tests unchanged (their fixtures have no `inDegree`, contributing 0).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/search/exact.ts src/search/fts.ts src/search/rank.ts tests/search/rank.test.ts tests/search/exact.test.ts
git commit -m "feat(search): blend log-dampened in-degree into ranking (Slice 6, 1a)"
```

---

### Task 10: File-size guard on discovery

**Files:**
- Modify: `src/config.ts:7-21` (schema), `src/config.ts:37-49` (identity)
- Modify: `src/indexer/discover.ts` (input, return type, size filter)
- Modify: `src/indexer/resolve-files.ts:51-56` (thread through)
- Modify: `src/indexer/index-codebase.ts` (IndexSummary + IndexPhasesResult + phase threading)
- Modify: `src/mcp/tools.ts:97-105` (`CodeIndexOutputSchema`)
- Test: `tests/discover.test.ts`, `tests/config.test.ts`, `tests/config-identity.test.ts`
- Fix-up: any test constructing `IndexSummary` literals — `rg -n "filesIndexed:" tests/ src/` to find them (known: `tests/mcp/harness.ts`)

**Interfaces:**
- Consumes: `CodeindexConfig.maxFileSizeBytes` (new).
- Produces: `discoverSourceFiles(input & { maxFileSizeBytes }): Promise<DiscoverResult>` where `DiscoverResult = { files: readonly DiscoveredFile[]; skippedFiles: readonly string[] }`; `IndexSummary.skippedFiles: readonly string[]`; `CodeIndexOutputSchema.skippedFiles: z.array(z.string())`. Intended behavior note: a skipped file is absent from the discovered set, so incremental runs prune its stale rows — same semantics as any excluded file.

- [ ] **Step 1: Write the failing tests**

Append to `tests/discover.test.ts`:

```ts
  test('skips files over maxFileSizeBytes and reports them', async () => {
    const repoRoot = makeTempRepo()
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true })
    writeFileSync(path.join(repoRoot, 'src', 'small.ts'), 'export const small = 1\n')
    writeFileSync(path.join(repoRoot, 'src', 'huge.ts'), 'x'.repeat(64))

    const result = await discoverSourceFiles({
      repoRoot,
      roots: [path.join(repoRoot, 'src')],
      exclude: [],
      languages: ['ts'],
      maxFileSizeBytes: 32,
    })

    expect(result.files.map((entry) => entry.relativePath)).toEqual(['src/small.ts'])
    expect(result.skippedFiles).toEqual(['src/huge.ts'])
  })
```

(Note: every existing `discoverSourceFiles` call in this file must also gain `maxFileSizeBytes: 1_000_000` to compile.)

Append to `tests/config.test.ts` (mirror the file's existing default-assertion style):

```ts
test('maxFileSizeBytes defaults to 1,000,000', () => {
  const parsed = CodeindexConfigSchema.parse({})
  expect(parsed.maxFileSizeBytes).toBe(1_000_000)
})
```

(Import `CodeindexConfigSchema` the way the file already accesses config internals; if the schema is not exported, assert through `loadCodeindexConfig` with a temp `.codeindex.json` omitting the key, matching the file's existing pattern.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/discover.test.ts tests/config.test.ts`
Expected: FAIL — unknown input key / `result.files` is a plain array, not `DiscoverResult`.

- [ ] **Step 3: Implement**

`src/config.ts` — add to `CodeindexConfigSchema` (after `maxStoredBodyLines`):

```ts
  maxFileSizeBytes: z.number().int().positive().default(1_000_000),
```

and to the identity object in `computeConfigIdentity` (after `maxStoredBodyLines: config.maxStoredBodyLines,`):

```ts
    maxFileSizeBytes: config.maxFileSizeBytes,
```

`src/indexer/discover.ts` — extend input, change return type, add the filter:

```ts
import { readdir, readFile, stat } from 'node:fs/promises'

export interface DiscoverSourceFilesInput {
  readonly repoRoot: string
  readonly roots: readonly string[]
  readonly exclude: readonly string[]
  readonly languages: readonly SupportedLanguage[]
  readonly maxFileSizeBytes: number
}

export interface DiscoverResult {
  readonly files: readonly DiscoveredFile[]
  readonly skippedFiles: readonly string[]
}

export const discoverSourceFiles = async (
  input: Readonly<DiscoverSourceFilesInput>,
): Promise<DiscoverResult> => {
  const matcher = ignore()
    .add(await readGitignore(input.repoRoot))
    .add([...input.exclude])
  const supportedExtensions = supportedExtensionsFor(input.languages)
  const files = await Promise.all(input.roots.map((root) => walk(root, input.repoRoot, matcher)))

  const candidates = files
    .flat()
    .map((absolutePath) => {
      const relativePath = path.relative(input.repoRoot, absolutePath)
      return {
        absolutePath,
        relativePath,
        extension: path.extname(absolutePath),
      }
    })
    .filter((entry) => supportedExtensions.has(entry.extension))
    .filter((entry) => !matcher.ignores(entry.relativePath))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))

  const kept: DiscoveredFile[] = []
  const skippedFiles: string[] = []
  for (const entry of candidates) {
    const stats = await stat(entry.absolutePath)
    if (stats.size > input.maxFileSizeBytes) {
      skippedFiles.push(entry.relativePath)
      continue
    }
    kept.push(entry)
  }
  return { files: kept, skippedFiles }
}
```

`src/indexer/resolve-files.ts:51-56` — destructure and thread:

```ts
  const { files: discoveredFiles, skippedFiles } = await discoverSourceFiles({
    repoRoot: config.repoRoot,
    roots: config.roots,
    exclude: config.exclude,
    languages: config.languages,
    maxFileSizeBytes: config.maxFileSizeBytes,
  })
```

Change the return type and statement to include `filesSkipped: skippedFiles`.

`src/indexer/index-codebase.ts` — `IndexSummary` and `IndexPhasesResult` gain:

```ts
  readonly skippedFiles: readonly string[]
```

`runIndexPhases` receives `filesSkipped` from `resolveFilesToProcess` and returns it (mapped to `skippedFiles` in the final `IndexSummary`).

`src/mcp/tools.ts` — `CodeIndexOutputSchema` gains:

```ts
  skippedFiles: z.array(z.string()),
```

- [ ] **Step 4: Fix all consumers and literal fixtures**

Run: `rg -n "discoverSourceFiles\\(" src tests` and `rg -n "filesIndexed:" tests src`
Expected: update every `discoverSourceFiles` call site (tests included) to pass `maxFileSizeBytes` and consume `result.files`; update every `IndexSummary`/`CodeIndexOutputSchema` literal (e.g. `tests/mcp/harness.ts`) to include `skippedFiles: []`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/discover.test.ts tests/config.test.ts tests/config-identity.test.ts tests/indexer/ tests/mcp/ tests/index-codebase.test.ts`
Expected: PASS. If `tests/config-identity.test.ts` asserts a specific hash string, update the expected hash to the recomputed value (the identity inputs legitimately changed).

- [ ] **Step 6: Commit**

```bash
git add src/ tests/
git commit -m "feat(indexer): file-size guard with maxFileSizeBytes config (Slice 6 ride-along)"
```

---

### Task 11: Weight calibration, baseline regeneration, full gates

**Files:**
- Modify: `src/search/rank.ts` (only if calibration changes `IN_DEGREE_WEIGHT`)
- Modify: `bench/*.json` baselines (regenerated)
- Modify: `.superpowers/sdd/progress.md` (slice completion entry)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Calibrate IN_DEGREE_WEIGHT against the IR gate**

Run with the current value 30:

```bash
bun run bench:check && bun run bench:papai:check
```

Decision rule (frozen after this run):
- Both green (up-or-flat) → keep 30.
- Regression on either → try 15, then 60 (edit `IN_DEGREE_WEIGHT` in `src/search/rank.ts`, re-run both commands), keep the best passing value. If no value passes, set `IN_DEGREE_WEIGHT = 0`, record the negative result in `.superpowers/sdd/progress.md`, and continue (the plumbing stays for a future recalibration).

- [ ] **Step 2: Regenerate all baselines at HEAD**

```bash
bun run bench --baseline bench/baseline.json --update-baseline
bun run bench/run.ts --repo ../papai --corpus bench/corpus/papai.json --baseline bench/baseline.papai.json --update-baseline
bun run bench/impact-run.ts --baseline bench/impact-baseline.json --update-baseline
bun run bench/impact-run.ts --repo ../papai --max-targets 300 --baseline bench/impact-baseline.papai.json --update-baseline
bun run bench/impact-run.ts --repo bench/fixtures/impact-demo --baseline bench/impact-baseline.fixture.json --update-baseline
bun run bench/index-bench-run.ts --baseline bench/index-baseline.json --update-baseline
```

Expected: all exit 0; `git status` shows only the baseline JSONs (plus rank.ts if Step 1 changed it).

- [ ] **Step 3: Full gate**

Run: `bun run check`
Expected: EXIT 0 — lint 0/0, typecheck clean, format clean, full test suite green, all four `check:bench` commands green against the fresh baselines.

- [ ] **Step 4: Verify the value/type impact gates moved or held**

Inspect the regenerated `bench/impact-baseline.papai.json` and compare to the committed pre-slice values (`valueFalseNegativeRate: 0.1023`, `typeFalseNegativeRate: 0.9949`):
- `valueFalseNegativeRate` should be flat-or-better (no graph changes — a rise would mean a lexical change perturbed resolution scoring; investigate before proceeding).
- `typeFalseNegativeRate` movement is informational (Task 1's memo explains it).

- [ ] **Step 5: Update progress and commit**

Append the Slice 6 completion entry to `.superpowers/sdd/progress.md` in the established format (code range, gate status, calibration outcome, memo verdict reference).

```bash
git add -A
git commit -m "chore(slice6): calibrate in-degree weight, regenerate baselines, gate green"
```

---

## Self-Review Notes

- **Spec coverage:** Unit 0 → Task 1; 1.1 NOCASE → Tasks 2+3; 1.2 snippet → Task 4; 1.3 prefix → Task 5; 1.4 LIKE → Task 6; 1.5 tokenization → Task 7; Unit 2 in-degree → Tasks 2+8+9+11; Unit 3 guard → Task 10; migration → Task 2; baselines/gates → Task 11. No gaps.
- **Type consistency:** `inDegree?: number` used consistently across types/exact/fts/rank/tests; `DiscoverResult.files`/`skippedFiles` threaded resolve-files → index-codebase → tools schema; `backfillSymbolInDegree(db: Database): void` defined Task 8, consumed in index-codebase same task.
- **Known cross-task coupling:** Task 2's schema is a prerequisite for Tasks 3, 8, 9 — task order enforces it. Task 10's return-type change is the only multi-file signature change; its Step 4 sweeps all call sites.
