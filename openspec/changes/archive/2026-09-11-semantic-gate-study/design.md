# Design: Semantic gate study + local-name impact acceptance

## Context

See proposal.md for why. Current state that shapes the approach:

- `query_log` is already at user_version 2 with `response_bytes`; the
  schema comment names dogfood history as the S3 study corpus — migrations
  must be in-place (`ALTER TABLE`), never wipe-and-rebuild.
- Impact identity lives in `resolveCanonicalTarget` / `resolveIncomingReferences`
  in `src/search/index.ts`. FTS candidates are accepted only when
  `candidate.qualifiedName === input`; the unique-candidate `localName` path
  only fires when FTS returns exactly one hit — flaky under- and over-resolution.
- Dogfood evidence (not to be re-derived in code): self 216 queries (impact
  44/48 zeros, ident-heavy); papai worktrees 492 queries (memory worktree
  NL-heavy; many historical zeros now resolve on today's index). Papai index:
  16,465 symbols, 92% of exports have a repo-unique `local_name`; current
  bare-local impact resolves 0/30 of those.
- RRF fusion utility already exists (`fuseRankedLists`); embeddings stay
  out of scope. Search ranking and preview shapes are untouched.

## Goals / Non-Goals

**Goals:**

- Ship the P3-S3 instrumentation the roadmap required, without destroying
  the corpus it measures.
- Make bare local-name `code_impact` honest and useful: unique → resolve;
  ambiguous → unresolved (never a wrong caller list).
- Publish a decision memo that closes the semantic gate with evidence from
  two repos, and names the next accuracy bet as identity/precision — not
  embeddings.

**Non-Goals:**

- Any embedding, vector table, or semantic route.
- Changing `code_search` ranking, `matchedBy` enums beyond logging them, or
  preview modes.
- HTTP/auth/refresh (P3-S5).
- Backfilling historical `query_log` rows with shape/mode (NULL is fine;
  study windows are forward-looking plus the frozen corpus snapshot).

## Decisions

### D1. Exact SQL uniqueness for local names — not FTS candidates

`resolveCanonicalTarget` gains a dedicated stage after canonical
`symbol_key` / `qualified_name` lookups and before/instead of FTS candidacy
for local names:

```sql
SELECT … FROM symbols WHERE local_name = ?  -- exact, indexed if needed
```

- Exactly one row → accept that symbol (`matchedBy: local_name`).
- Zero rows → unresolved.
- More than one row → unresolved; guidance names ambiguity and points at
  `code_symbol` (optionally listing top qualified names as candidates).

**Why not keep FTS + uniqueness:** FTS return cardinality is unrelated to
repo uniqueness. papai `auth` (55 symbols) currently "resolves" when FTS
returns one lucky hit; unique exports fail when FTS returns noise. SQL
cardinality is the product semantics we want.

**Alternative considered:** rank-order pick among ties (the previous
`impact-identity-resolution` scenario). Rejected: a wrong caller list is
worse than unresolved; agents already retry with `code_symbol`.

### D2. Canonical paths stay byte-identical

Exact `symbol_key` and exact `qualified_name` branches are untouched.
Bench oracles (`impact-baseline*.json`, edit-fuzz, impact scorer) and CLI
`impact` keep their contract. Only bare-local / non-canonical inputs change
behavior — from flaky FTS acceptance to deterministic uniqueness.

### D3. Query log v3 in-place

Add columns (nullable, no backfill required):

| column | type | notes |
|---|---|---|
| `query_shape` | TEXT | `identifier` \| `multi_token_lexical` \| `nl` \| `empty` |
| `zero_or_weak` | INTEGER | 1 when `result_count < max(3, limit)` or equivalent |
| `mode` | TEXT | search route when provided |
| `matched_by` | TEXT | dominant/top hit provenance when available |

Classifier (pure helper beside query-logging): identifier if single token
matching code-ish shape or containing `#/.>`; else multi-token lexical if
space-separated short tokens; else NL if ≥3 tokens or mostly stopwords.
Cheap, deterministic, documented — refined only if the memo needs it.

`filters_json` already carries filters; `mode` is promoted to a column for
grouping (0/216 usage today is itself a finding).

### D4. Where logging is attached

Extend `withQueryLogging` wrappers in `src/mcp/query-logging.ts` — the same
module that owns `response_bytes`. Search/symbol/impact all ride along;
no new MCP fields in the response contract (telemetry is log-side only).

### D5. Memo as a first-class deliverable

`docs/research/06-semantic-gate-decision.md` (or next free index): corpus
inventory (paths + counts + date ranges), miss taxonomy (identity vs NL
precision vs historical zeros), go/no-go (**no-go** for default semantic
route), reopen criteria. Freeze a small JSON/CSV snapshot of shape×tool×zero
aggregates under `docs/research/corpus/` or `bench/` so the memo is
reproducible without live DBs.

## Risks / Trade-offs

- [Unique local names still collide across future edits] → uniqueness is
  evaluated at query time against the live index; no cached allow-list.
- [Ambiguous bare names become unresolved where they sometimes "worked"] →
  intentional; guidance sends agents to `code_symbol`. Measure retry cost
  in the memo.
- [Classifier mislabels edge queries] → shape is advisory telemetry, not a
  gate; memo reports raw distributions too.
- [v3 columns unused by older papai wrappers] → papai runs vendored CLI;
  columns are additive. Stale wrappers simply leave them NULL.
- [Impact baseline churn] → canonical keys unchanged; only non-canonical
  bare-local behavior moves. Re-stamp only if a baseline accidentally used
  bare names (verify during implementation).

## Migration Plan

1. Fail-test local-name uniqueness (unique accept, ambiguous reject, unknown
   unresolved, canonical unchanged).
2. Implement SQL uniqueness in `resolveCanonicalTarget`; green tests +
   `bun run check:bench` (or impact subset) without re-stamping.
3. Fail-test query_log v3 columns + classifier.
4. Implement schema bump + wrappers; unit tests; `bun run check`.
5. Write memo from frozen aggregates + narrative; link corpus paths.
6. Rollback: identity change is small and local to `resolveCanonicalTarget`;
   schema v3 is additive (worst case ignore columns). No data loss either way.

## Open Questions

None blocking. Deferred by design:

- Whether `matchedBy` on impact should surface ambiguity candidates in
  `structuredContent` beyond guidance text — polish, not required for the
  memo.
- Whether papai worktree DBs should be copied into this repo as a pinned
  corpus snapshot vs referenced by path — decide when writing the memo
  freeze step; does not change specs.
