# Consolidated Gaps & Opportunities Catalog

Every concrete gap, bug, and limitation found across the three inventories (`01`–`03`),
de-duplicated and categorized, plus cross-cutting risks/blind spots surfaced by the independent
cross-check. Each item notes the primary **goal axis** it hurts — **Acc**(uracy),
**Cheap**(ness), **Fresh**(ness), **Reach** — and a `file:line` anchor where applicable.

Severity legend (impact on the core "agents retrieve the right code accurately + cheaply" goal):
🔴 high · 🟠 medium · 🟡 low/latent.

---

## A. Correctness bugs (silently wrong or degraded results)

| # | Gap | Where | Impact | Axis | Sev |
|---|---|---|---|---|---|
| A1 | **Case-sensitivity mismatch** between tiers: exact `=`/`LIKE` are BINARY (case-sensitive), FTS `unicode61` lowercases. A case-mismatched query silently skips the high-scoring exact tier and only surfaces via FTS. | `search/exact.ts:106-109` (no `COLLATE NOCASE`) | Wrong/worse ordering; "correct name, wrong case" demotes a perfect match | Acc | 🔴 |
| A2 | **FTS snippet hardcoded to the `doc_text` column** (index 5) regardless of which column matched. `doc_text` is usually `''`, so FTS results routinely carry empty/uninformative previews. | `search/fts.ts:59` | Agent gets blank previews → must do a follow-up read | Cheap | 🟠 |
| A3 | **Unescaped `LIKE` metacharacters** in file-path search — literal `%`/`_` in a query act as SQL wildcards. | `search/exact.ts:109` | Surprising matches on path queries containing `_`/`%` | Acc | 🟡 |
| A4 | **`confidence` conflation** — FTS hardcodes `confidence:'resolved'` (the same enum value that means "structurally resolved reference") for every text hit regardless of BM25. | `search/fts.ts:78` | Agent can't tell a strong match from a weak one | Acc | 🟠 |
| A5 | **`matchReason` is a constant string** for all FTS rows (`'fts identifier_terms/doc_text/body_text'`) — doesn't reflect the column that matched. | `search/fts.ts:77` | No signal of why a result matched | Cheap | 🟡 |
| A6 | **`pathPrefix` is a naive `startsWith`**, not path-boundary aware — `src/mcp` also matches `src/mcpFoo.ts`. | `search/exact.ts:22`, `search/fts.ts:14` | Filter leaks unrelated files | Acc | 🟡 |
| A7 | **Filters applied after SQL `LIMIT`** — `kinds`/`scopeTiers`/`pathPrefix` filter the already-truncated page, so results can fall below `limit` even when more matches exist. Logic is also duplicated in exact and fts. | `exact.ts:11-26`, `fts.ts:6-18` | Under-returns; inconsistent counts | Acc | 🟠 |

---

## B. Reference-graph accuracy gaps (missing / garbage edges)

The flagship `code_impact` tool systematically under-reports usage. All in
`indexer/extract-references.ts` unless noted.

| # | Gap | Impact | Axis | Sev |
|---|---|---|---|---|
| B1 | **JSX component usage produces ZERO edges** — `jsx_element`/`jsx_opening_element`/`jsx_self_closing_element` unhandled, though `.tsx`/`.jsx` are first-class. `<Button/>` → no edge to `Button`. | `code_impact` blind to all React component usage | Acc | 🔴 |
| B2 | **Member/method calls never resolve** — `collectCallReference` stores the callee's raw text, so `obj.method()`→`"obj.method"`, `this.foo()`→`"this.foo"`; resolution matches bare `local_name`, so none can match. Only plain `foo()` resolves. | Class/OO/namespaced call graph is essentially empty | Acc | 🔴 |
| B3 | **`extends`/`implements` never produced** — edge types are modeled in `types.ts:7` but `class_heritage`/`extends_clause`/`implements_clause` are unhandled. | Can't answer "who extends/implements this" | Acc | 🔴 |
| B4 | **`export * from` barrels are invisible** — `namespace_export`/bare-`*` re-export-all unhandled; only named `export { x } from` is captured. | Re-exported symbols look unused; broken resolution through barrels | Acc | 🟠 |
| B5 | **Namespace imports (`import * as ns`) produce no edge** — `namespace_import` unhandled. | Namespace-style usage invisible | Acc | 🟠 |
| B6 | **Dynamic `import('./mod')` → `targetName:"import"`** (bare keyword), and CommonJS `require('y')` → generic `"require"` call edge. | Dynamic/CJS deps are noise, not resolved edges | Acc | 🟠 |
| B7 | **Type-level references untracked** — parameter/return/property type annotations and generics (`type_identifier`) unhandled. Renaming an `interface`/`type` won't surface type-only usages. | Impact undercounts type usage | Acc | 🟠 |
| B8 | **Interface/enum members not extracted as symbols** — only the parent declaration. | Can't find/rank individual members | Acc | 🟡 |
| B9 | **Only JSDoc `/** */` docs captured**; plain `//` comments dropped → `docText:''`. | Weaker doc-based search/preview | Cheap | 🟡 |

---

## C. Resolution accuracy gaps

| # | Gap | Where | Impact | Axis | Sev |
|---|---|---|---|---|---|
| C1 | **All resolution is name/text string-equality — no `ts.TypeChecker` ever runs.** Same-named symbols across scopes are fundamentally undisambiguable. | `resolver/resolve-references.ts:80-113` | Ceiling on precision; can't do go-to-definition-grade resolution | Acc | 🔴 |
| C2 | **Unresolvable-specifier fallback matches ANY same-named symbol codebase-wide** (the `: true` branch) — a bare npm/workspace import or out-of-root path attributes to an unrelated local of the same name. Not covered by tests. | `resolve-references.ts:97-107` | **False-positive** edges | Acc | 🔴 |
| C3 | **Import-map resolution is a single left-to-right pass** — a call referencing an import encountered later in traversal order misses the `resolved` tier. | `resolve-references.ts:80-83,131-133` | Order-dependent under-resolution | Acc | 🟠 |
| C4 | **`file_resolved` overstates confidence** — it also covers "file matched but symbol lookup empty" (`targetSymbolId:null`), reading as more confident than it is. | `resolve-references.ts:115-118` | Misleading confidence signal | Acc | 🟡 |
| C5 | **No `node_modules` / `package.json` `exports` resolution** — bare specifiers only "resolve" via the risky C2 fallback or stay unresolved. | pipeline-wide | Cross-package refs unreliable | Acc/Reach | 🟠 |
| C6 | **Non-wildcard tsconfig `paths` dropped** (`if wildcardIndex === -1 return []`). Common `"@pkg": ["src/index.ts"]` mappings never alias. | `resolver/tsconfig-paths.ts:74-76` | Missed alias resolution | Acc | 🟡 |

---

## D. Ranking / search-quality gaps

| # | Gap | Where | Impact | Axis | Sev |
|---|---|---|---|---|---|
| D1 | **Every FTS hit scores `matchScore = 0`** regardless of BM25 — scope tier always dominates lexical relevance; a highly relevant local ranks below a barely-related exported symbol. | `search/rank.ts:18-29` | Poor top-k for exploratory search | Acc/Cheap | 🔴 |
| D2 | **Symbol in-degree ("used by N callers") never used in ranking** — the signal is already in `symbol_references`. | `search/rank.ts` | Misses the best popularity signal | Acc | 🟠 |
| D3 | **`kind` never factored into ranking.** | `search/rank.ts` | Can't prefer functions over locals | Acc | 🟡 |
| D4 | **Configured FTS `prefix='2 3'` indexes are never queried** (`sanitizeFtsQuery` never appends `*`). Dead weight; no partial-identifier matching. | `schema.ts:97`, `fts.ts:28-36` | No prefix search despite paying to index it | Acc | 🟠 |
| D5 | **Tokenizer glues `snake_case`/`kebab-case`** (`tokenchars '_-'`); `identifier_terms` splits only `lower→Upper`, so acronym runs (`XMLParser`) don't split. | `schema.ts:96`, `extract-symbols.ts:55-60` | "user id" won't match `get_user_by_id`; acronym queries miss | Acc | 🟠 |
| D6 | **No fuzzy / typo tolerance** anywhere (no Levenshtein/`spellfix1`). | grep-verified | Typos → empty results | Acc | 🟠 |
| D7 | **Very limited query power** — multi-term joined with `OR` only; no `AND`/`NEAR`/phrase/field-scoping. | `fts.ts:28-36` | Can't express precise queries | Acc | 🟡 |
| D8 | **Weak intra-pool dedup** — exact pool can return multiple rows for overloads/duplicate decls; dedup only happens exact-vs-FTS. | `search/index.ts:28-31` | Duplicate results waste the page | Cheap | 🟡 |

---

## E. Missing capabilities (primitives agents expect)

| # | Gap | Impact | Axis | Sev |
|---|---|---|---|---|
| E1 | **No "list symbols in file" / outline** — `query` is mandatory non-empty, so enumeration is impossible. | Agents read whole files instead | Cheap | 🔴 |
| E2 | **No "go to definition at (file, line, col)".** | No positional navigation | Cheap | 🟠 |
| E3 | **No multi-hop call hierarchy** — `findIncomingReferences` is single-hop, incoming-only; no recursive CTE, no outgoing direction. | Can't do blast-radius or "how does X work" traversals | Acc/Cheap | 🔴 |
| E4 | **No "list exports of module"** despite `module_exports` existing. | Can't enumerate a module's API | Cheap | 🟠 |
| E5 | **No "find implementations/subclasses"** (needs B3). | — | Acc | 🟠 |
| E6 | **`ImpactResult` has no snippet/source line** — agent must do a second lookup to see calling code. | Extra round-trips | Cheap | 🟠 |
| E7 | **`code_symbol` lacks `kinds`/`scopeTiers`/`pathPrefix`** that `code_search` has (asymmetry). | Inconsistent, weaker filtering | Cheap | 🟡 |

---

## F. Freshness / incremental gaps

| # | Gap | Where | Impact | Axis | Sev |
|---|---|---|---|---|---|
| F1 | **No file-watch mode** — reindex is always explicit. | `src/` (no `fs.watch`) | Index goes stale during edit loops | Fresh | 🟠 |
| F2 | **"Incremental" still hashes EVERY file each run** (no mtime/event shortcut) — saves parse/write CPU but not O(total-files) disk I/O. | `index-codebase.ts:145-151` | Slow incremental on big repos | Fresh/Cheap | 🟠 |
| F3 | **Single-hop dependent invalidation** — importers-of-importers not chased; combined with FK `ON DELETE SET NULL` + per-file delete+reinsert, **2+-hop references silently orphan to `NULL`** until that far file changes or a full reindex runs. | `index-codebase.ts:162-175`, `schema.ts:56` | Completeness silently degrades | Acc/Fresh | 🔴 |
| F4 | **Byte-offset symbol identity churns on any earlier edit** — `symbolKey` and row `id` change even for untouched symbols; a stale `symbolKey` held across an edit returns `[]` (not an error). | `extract-symbols.ts:120`, `queries.ts:12-17` | Agent handles break across turns | Acc/Cheap | 🟠 |

---

## G. Performance / scale gaps

| # | Gap | Where | Impact | Axis | Sev |
|---|---|---|---|---|---|
| G1 | **No transaction batching** — every alias/symbol/export/reference is its own `run()`. | `queries.ts`, `index-codebase.ts:229-242` | Slow full reindex | Fresh | 🟠 |
| G2 | **Resolution is O(references × total-symbols)** — loads entire symbol/file/alias tables into JS and linear-scans per candidate. | `index-codebase.ts:213-215`, `resolve-references.ts:85-113` | Quadratic-shaped cost at scale | Fresh | 🟠 |
| G3 | **Single-threaded** — no worker threads; CPU-bound tree-sitter parse serial on the main thread. | `src/` (no `worker_threads`) | Slow on large repos | Fresh | 🟡 |
| G4 | **No file-size guard** — unbounded parse of huge/minified/generated files (only *stored* body is clipped). | `index-codebase.ts:83` | One giant file can stall/OOM indexing | Fresh/robustness | 🟠 |
| G5 | **Fresh DB connection per call, no pooling; no `busy_timeout`.** | `storage/db.ts:3-8`, `cli.ts:25-32` | `SQLITE_BUSY` risk under concurrent access | Fresh | 🟠 |
| G6 | **`signatureText` = single start line only** — multi-line signatures truncated in the stored preview. | `extract-symbols.ts:126` | Weaker previews for wrapped signatures | Cheap | 🟡 |

---

## H. Agent ergonomics / token economics

| # | Gap | Where | Impact | Axis | Sev |
|---|---|---|---|---|---|
| H1 | **Every response duplicated** — full JSON in both `content[0].text` and `structuredContent` (~2×). | `tools.ts:113-116` | ~2× token cost per call | Cheap | 🔴 |
| H2 | **No pagination / `hasMore`** — `resultCount` is post-slice length; no total or cursor. | `tools.ts:76`, `server.ts:36` | Agent can't tell if it saw everything | Cheap | 🟠 |
| H3 | **No result-formatting / verbosity / snippet-size controls** — only `limit`. | `tools.ts` | No way to trade detail for tokens | Cheap | 🟠 |
| H4 | **Tool-selection cost** — `code_search` vs `code_symbol` overlap + undocumented, unconstrained `kind` vocabulary impose planning-time tokens before any response. | `tools.ts:30,36-39` | Wasted reasoning tokens | Cheap | 🟠 |
| H5 | **Raw error strings only** — no codeindex-specific formatting, codes, or recovery hints (SDK generic handler surfaces `error.message`). | `server.ts:28-86` | Agent can't recover programmatically | Cheap | 🟡 |
| H6 | **Guidance only on `code_search`** — `code_symbol`/`code_impact` can't emit it (not in schema). | `server.ts:30-33`, `tools.ts:82-96` | No next-step hints on empty impact | Cheap | 🟡 |

---

## I. Reach (languages / repo shapes)

| # | Gap | Where | Impact | Axis | Sev |
|---|---|---|---|---|---|
| I1 | **Hard-coded to `ts/tsx/js/jsx`; no grammar plugin mechanism.** | `parser.ts:42-55`, `types.ts:1` | No Python/Go/Rust/Vue/Svelte/etc. | Reach | 🟠 |
| I2 | **No monorepo/workspace awareness** — one flat `moduleKey` namespace per repoRoot; no nested `tsconfig`/`package.json workspaces`/project-reference auto-discovery; root `.gitignore` only. | `discover.ts:24-30`, `tsconfig-paths.ts:60-61` | Manual per-package setup; cross-package refs weak | Reach/Acc | 🟠 |
| I3 | **Symlinks silently dropped** in discovery. | `discover.ts:49-54` | Missed files in symlinked layouts | Reach | 🟡 |

---

## J. Evaluation / testing gaps

| # | Gap | Where | Impact | Axis | Sev |
|---|---|---|---|---|---|
| J1 | **No relevance-evaluation harness at all** — zero golden queries, no precision/recall/MRR/NDCG, no ranking regression suite. | grep-verified | Every quality change is unmeasurable | Acc | 🔴 |
| J2 | **MCP tests never cross the protocol boundary** — no `Client`/`StdioClientTransport`/`callTool`/`listTools`; handlers, `guidance`, `code_index` wiring, and error paths untested end-to-end. | `tests/mcp/*` | Protocol-level regressions slip through | Acc | 🟠 |
| J3 | **No edit-sequence / graph-integrity fuzzer** — the multi-hop orphaning (F3) is unquantified. | — | Silent completeness loss unmeasured | Acc | 🟠 |
| J4 | **No indexing throughput/latency benchmark** on a large repo. | — | Perf work would be blind | Fresh | 🟠 |
| J5 | **In-memory unit tests hand-write `INSERT` SQL duplicating the schema** — must be kept in sync manually. | `tests/search/index.test.ts:12-20` etc. | Brittle tests; drift risk | — | 🟡 |
| J6 | **No README / prose docs** beyond `CLAUDE.md`. | — | Onboarding friction | — | 🟡 |

---

## K. Latent / unfinished scaffolding (dead or write-only)

These look like groundwork for an unwritten "tier1"→tier-N roadmap (worth reconciling before
building on top of them):

- `module_exports.resolved_file_id` — column + index exist, **always inserted `NULL`**
  (`queries.ts:196-214`).
- `symbols.is_exported` — written, **never read** (`scopeTier==='exported'` used instead).
- `symbols.start_byte`/`end_byte` — written, **never selected**.
- `module_aliases.precedence` — written, **never breaks a tie** (`selectAllModuleAliases` doesn't
  even select it; resolution takes first `.find()` by insertion order).
- `edge_type` values `extends`/`implements`/`references` — modeled, **never produced** (= B3).
- `lexical_declaration` in `declarationTypes` — vestigial.

---

## L. Cross-cutting risks & blind spots (from the independent cross-check)

- **False negatives in `code_impact` are safety-critical, not cosmetic.** A missed "who calls
  this" is what lets an agent confidently ship a breaking change. Research whether to over-report
  `name_only` matches by default and how to surface confidence so agents don't over-trust
  heuristic hits.
- **Evaluation methodology is itself a research question** — classic IR precision@k vs. downstream
  *agent task success*. These diverge; picking the wrong one invalidates every accuracy claim.
- **Stale-index / branch-drift / worktree-drift has no owner** — nothing records which git
  commit/branch/worktree or `.codeindex.json` an index reflects. An agent switching branches
  (normal in this environment) can get confidently-wrong results.
- **Concurrent multi-agent DB access is unstudied** — no `busy_timeout`, fresh connection per
  call, no pooling; `SQLITE_BUSY` behavior under a live query + background reindex is untested
  (= G5, elevated). Plausibly hit by swarm/subagent usage today.
- **Robustness on hostile/huge input is untested** — no file-size guard (G4), unescaped `LIKE`
  wildcards (A3). Low severity as a local single-user tool; matters the moment codeindex touches
  CI/shared contexts.
- **`code_index` DB-target wiring bug** — a non-cwd `path` indexes a DB the query tools never
  read (see `03` §1). An agent that indexes then searches a different repo gets stale/empty
  results with no error.
- **Reconcile the implied "tier1" roadmap** — the §K scaffolding suggests a plan exists nowhere in
  writing (only `CLAUDE.md`); confirm before re-deriving or contradicting it.

---

## Quick "cheap wins vs. big bets" read

- **Cheap correctness wins (low risk, ship now):** A1 (case), A2 (snippet column), D4 (activate
  prefix), D5 (tokenization), H1 (payload duplication), G1 (transaction batching), B3
  (`extends`/`implements`).
- **Best accuracy-per-effort feature:** completing the reference graph — B1/B2/B4/B5 + C2
  suppression (heuristic, no type checker).
- **Foundational (unlocks measuring all of the above):** J1 + J2 (eval + protocol tests).
- **Measured, gated big bets:** C1 type-aware resolution; semantic/embedding search (see agenda
  Direction 1c); F4/G2/G3 scale work.

Full prioritization, sequencing, benefit/effort/risk matrix, and new scenarios are in
`05-research-agenda.md`.
