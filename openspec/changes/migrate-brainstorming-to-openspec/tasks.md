# Tasks: Migrate brainstorming → OpenSpec

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Design: `design.md` (same folder). This plan is also the change's openspec `tasks.md` — it lives here permanently and its checkboxes ride with the code commits.

**Goal:** Move codeindex's planning pipeline from superpowers brainstorming→writing-plans to OpenSpec, replaying papai's validated playbook (strangler, no backfill).

**Architecture:** One direct scaffold commit (openspec init + tailored config), then the rewiring itself is the first openspec change: CLAUDE.md routing table + AGENTS.md symlink, legacy-tree freeze, `.superpowers/` ignore, sweep, archive. No code changes.

**Tech Stack:** openspec CLI 1.8.0 (global bun install), git, markdown.

## Global Constraints

- Bun only: `bun test`, `bun run <script>`; never npm/npx
- No changes to `src/`, `bench/`, `tests/`, `package.json`, `tsconfig.json`
- No edits to global `~/.claude/skills/` or `~/.agents/skills/`
- No new files under `docs/superpowers/` except the freeze README (design D5)
- No backfill of the legacy corpus (11 specs, 14 plans); `openspec/specs/` starts empty
- No schema fork; default `spec-driven` schema only
- Every task's commit includes the `tasks.md` checkbox update for that task

---

### Task 1: Scaffold openspec + tailored config (direct commit)

**Files:**
- Create (via CLI): `openspec/`, `.claude/skills/openspec-*/`, `.claude/commands/opsx/`, `.opencode/skills/openspec-*/`, `.opencode/commands/opsx-*.md`
- Overwrite: `openspec/config.yaml`
- Pre-existing: `openspec/changes/migrate-brainstorming-to-openspec/design.md` (committed already at 151cee8 — must survive init)

**Interfaces:**
- Produces: a working openspec root (`openspec list` / `openspec doctor` clean) and repo-local `openspec-*` skills + `opsx` commands for both hosts, which every later task and all future work rely on.

- [x] **Step 1: Run init non-interactively for both hosts**

```bash
openspec init --tools claude,opencode --no-animation
```

Expected: creates `openspec/` structure and tool scaffolding. The existing `openspec/changes/migrate-brainstorming-to-openspec/design.md` is not clobbered.

- [x] **Step 2: Verify the scaffold**

```bash
ls .claude/skills && ls .opencode/skills && ls openspec
test -f openspec/changes/migrate-brainstorming-to-openspec/design.md && echo "design.md intact"
```

Expected: skills list includes `openspec-explore`, `openspec-propose`, `openspec-apply-change`, `openspec-update-change`, `openspec-sync-specs`, `openspec-verify-change`, `openspec-archive-change` under both hosts; `openspec/` contains the default config; `design.md intact` prints.

- [x] **Step 3: Overwrite `openspec/config.yaml` with the tailored content**

Replace the entire file with:

```yaml
schema: spec-driven

context: |
  codeindex is a local developer tool: symbol-first TypeScript/JavaScript
  indexing and MCP-backed code search for AI agents and maintainers. It
  indexes any repo via tree-sitter (web-tree-sitter runtime +
  tree-sitter-javascript/tree-sitter-typescript grammars), stores
  files/symbols/references in SQLite (WAL mode), and serves them through an
  MCP server (code_symbol, code_search, code_impact) and a CLI (index,
  reindex, stats).

  Tech stack:
  - Runtime: Bun only (bun test, bun run <script>; never npm/npx)
  - Language: strict TypeScript, checked with tsgo
    (@typescript/native-preview)
  - Validation: Zod v4 at external boundaries (MCP tool params, CLI args,
    config files)
  - Storage: SQLite via bun:sqlite; DB at <repo-root>/.codeindex/index.db,
    WAL mode (sibling -wal/-shm files while open); incoming-reference table
    is symbol_references (REFERENCES is a SQLite keyword)
  - Lint/format: oxlint (.oxlintrc.json), oxfmt (.oxfmtrc.json)

  Key conventions:
  - code_symbol is exact-first: exact local-name, qualified-name, and
    export-name matches before FTS fallback
  - code_search is the exploratory entrypoint; results ranked by scope tier
    and match quality, each carrying rankScore
  - Exact-match previews come from stored body_text / signature_text
  - MCP tool responses include structuredContent alongside text; empty
    code_search results carry a guidance string
  - The MCP server always operates on the caller's cwd

  Verification commands:
  - bun run test — full suite; bun test tests/<path> for focused runs
  - bun run typecheck, bun run lint, bun run format:check
  - bun run check — all of the above plus check:bench, in parallel
  - bun run check:bench — benchmark gates vs stamped baselines
    (bench/baseline.json, index-baseline.json, impact-baseline.json);
    regenerate baselines only when corpus/intent changes, never to make a
    failing gate pass

rules:
  proposal:
    - State which surfaces the change touches (indexer, storage schema, MCP
      tools, CLI, bench harness); runtime behavior changes need delta specs,
      docs/tooling-only changes opt out with skip_specs (set it true)
    - Include a "Non-goals" section listing explicitly out-of-scope behavior
    - For each declared capability, state what concretely breaks or stays
      missing without it; a capability justified only by an anticipated need
      belongs in Non-goals rather than in scope, recorded as declined
    - Name the existing module that already covers a declared capability
      where one does, and either extend it or say why a separate one is
      needed
    - Keep proposals under 500 words; detail belongs in design.md
  specs:
    - Requirements use SHALL statements; every requirement has at least one
      `#### Scenario:` with WHEN/THEN
    - For MCP tool changes, spec both the text payload and the
      structuredContent shape, and preserve exact-first semantics (exact
      matches before FTS)
    - For search-ranking changes, state the expected effect on the bench
      oracle gates and which corpus (repo-local, papai) proves it
    - For storage changes, describe migration/backfill for existing
      .codeindex/index.db files and WAL behavior
  design:
    - Name the existing module that covers the need before introducing a new
      one — the dependency question one level in
    - State impact on search semantics (scope tiers, rankScore, match types)
      and on MCP tool responses (text + structuredContent)
    - For bench-gated work, name the affected baselines and the like-for-like
      comparison story
    - Note test-first interactions — which new files the failing-test-first
      order gates
  tasks:
    - Break tasks into independently verifiable chunks; order them test-first
      (failing test before implementation)
    - Every task ends with its verification command (bun test tests/<path>,
      bun run typecheck, bun run lint, ...)
    - Final task always runs full bun run check (plus bun run check:bench
      when indexing or search behavior moved)

operations:
  apply:
    guidance:
      - Follow test-driven-development — write the failing test, watch it
        fail, implement, watch it pass
      - Check off tasks.md checkboxes as each task completes; keep the file
        current as filesystem state
      - Commit each tasks.md section in its own commit as it completes; the
        tasks.md checkbox state lands in the same commit as the work
      - The change folder (openspec/changes/<name>/) rides with the code on
        the same branch; never commit implementation without artifacts
  archive:
    guidance:
      - Before archiving, confirm all tasks.md checkboxes are complete and
        openspec validate --strict passes
      - Confirm merged specs under openspec/specs/ read as current truth
        (no ADDED/MODIFIED/REMOVED framing left in main specs)
      - Summarize the archive outcome (shipped capabilities, spec files
        touched) before finishing
      - Archive as a small follow-up commit on master after the work lands,
        not inside the implementation branch
```

- [x] **Step 4: Verify the openspec root is healthy**

```bash
openspec list; openspec doctor
```

Expected: `openspec list` exits 0 (zero active changes or lists none yet — `migrate-brainstorming-to-openspec` has no `proposal.md` yet, which is fine until Task 2); `openspec doctor` reports no broken relationships.

- [x] **Step 5: Commit the scaffold**

```bash
git add openspec .claude .opencode
git commit -m "chore(openspec): scaffold openspec with codeindex-tailored config"
```

### Task 2: Propose the dogfood change

**Files:**
- Create: `openspec/changes/migrate-brainstorming-to-openspec/.openspec.yaml`
- Create: `openspec/changes/migrate-brainstorming-to-openspec/proposal.md`
- Pre-existing: `tasks.md` (this file) and `design.md`

**Interfaces:**
- Consumes: scaffolded root from Task 1.
- Produces: a strict-valid change named `migrate-brainstorming-to-openspec` with `skip_specs: true`, which Tasks 3–6 execute and Task 7 archives.

- [ ] **Step 1: Write `.openspec.yaml`**

```yaml
schema: spec-driven
created: 2026-09-08
skip_specs: true
```

- [ ] **Step 2: Write `proposal.md`**

```markdown
# Proposal: Migrate brainstorming → OpenSpec

## Why

codeindex's planning pipeline runs on obra/superpowers skills: `brainstorming`
produces single-file design docs under `docs/superpowers/specs/`,
`writing-plans` turns them into plan docs, `executing-plans` /
`subagent-driven-development` run them. These docs go stale, carry no
machine-readable state, and leave no living spec tree. papai has already
migrated the identical pipeline to OpenSpec and validated the playbook. The
scaffold landed in the preceding direct commit (`openspec/` +
`.claude/` + `.opencode/` + tailored `config.yaml`); this change performs the
migration itself as the first dogfood change on the new workflow.

## What Changes

- Add a "Workflow" routing table to `CLAUDE.md`: code-behavior work enters
  via `/opsx:explore` / `/opsx:propose`; `brainstorming` keeps non-code
  creative work only; other superpowers skills keep their current roles.
- Symlink `AGENTS.md` → `CLAUDE.md` so opencode and Claude Code share one
  source of truth.
- Freeze `docs/superpowers/` as legacy reference (strangler, no backfill) via
  a README banner with disposition rules; `openspec/specs/` starts empty and
  accretes from future changes.
- Add `.superpowers/` to `.gitignore` — its sdd working artifacts (review
  diffs, fix reports) are local-only state.

## Capabilities

### New Capabilities

None — pure dev-workflow/docs change; no codeindex runtime behavior changes.
`skip_specs: true` is set in `.openspec.yaml`.

### Modified Capabilities

None. `openspec/specs/` is empty; no existing capability specs are touched.

## Non-goals

- No backfill of the legacy corpus (11 specs, 14 plans) into
  `openspec/specs/`; the corpus stays in place as read-only reference.
- No porting of the pending phase-3 roadmap spec; it is ported lazily via
  `/opsx:propose` when the next feature adopts it.
- No changes to `src/`, `bench/`, `tests/`, `package.json`; no new
  dependencies; no verification-command changes.
- No edits to global `~/.claude/skills/` or `~/.agents/skills/`.
- No schema fork and no expanded-profile decision; revisit after 2–3 changes.

## Impact

- **Docs/instructions:** `CLAUDE.md` (Workflow section), `AGENTS.md` (new
  symlink), `docs/superpowers/README.md` (freeze banner), `.gitignore`.
- **OpenSpec tree:** first change under `openspec/changes/`; this change's
  `design.md` is the operational migration guide.
```

- [ ] **Step 3: Validate the change strict**

```bash
openspec validate migrate-brainstorming-to-openspec --strict --no-interactive
```

Expected: validation passes (unchecked task boxes are fine; structure is what matters).

- [ ] **Step 4: Commit**

```bash
git add openspec/changes/migrate-brainstorming-to-openspec
git commit -m "docs(openspec): propose migrate-brainstorming-to-openspec change"
```

### Task 3: Rewire CLAUDE.md routing + AGENTS.md symlink

**Files:**
- Modify: `CLAUDE.md` (append Workflow section at the end)
- Create: `AGENTS.md` (symlink → `CLAUDE.md`)

**Interfaces:**
- Consumes: scaffolded `opsx` commands from Task 1 (the routes must exist).
- Produces: the routing surface every future session reads; `AGENTS.md` resolves to `CLAUDE.md` for both hosts.

- [ ] **Step 1: Check whether init/update created an `AGENTS.md` file**

```bash
ls -la AGENTS.md 2>/dev/null; grep -n "openspec" CLAUDE.md | head
```

Expected: likely "No such file". If `AGENTS.md` exists as a regular file (openspec instruction header), note its content — if it contains an openspec-generated header block, preserve that block inside `CLAUDE.md` in Step 2 before replacing the file with the symlink in Step 3.

- [ ] **Step 2: Append the Workflow section to `CLAUDE.md`**

Add at the end of `CLAUDE.md`:

```markdown

## Workflow

Planning runs on OpenSpec in this repo: code-behavior work enters through
`/opsx:explore` / `/opsx:propose` and lives under `openspec/changes/<name>/`;
`brainstorming` keeps non-code creative work only. Superpowers skills stay in
force for everything else they own (TDD, verification, debugging, code
review, worktrees, branch finishing). When the harness supports
`obra/superpowers` skills, load `using-superpowers` at session start before
acting; load any other applicable skill before responding, editing, or
running commands.

| Trigger | Route |
| --- | --- |
| "Let's build / add / change X" (code behavior) | `/opsx:explore` or `/opsx:propose` — **not** brainstorming |
| Non-code creative work (docs, process, writing) | brainstorming (unchanged) |
| Bug / test failure | systematic-debugging; if root cause becomes a change, `/opsx:propose` |
| Inside `/opsx:apply` | test-driven-development, verification-before-completion |
| Plan drifted from code | syncing-plan-with-code against `openspec/changes/<name>/` artifacts |
```

(If Step 1 found an openspec-generated header in `AGENTS.md`, paste that header above the Workflow section instead of dropping it.)

- [ ] **Step 3: Create the symlink**

```bash
rm -f AGENTS.md && ln -s CLAUDE.md AGENTS.md
```

- [ ] **Step 4: Verify**

```bash
grep -n "opsx" CLAUDE.md | head; readlink AGENTS.md
```

Expected: routing table rows found in `CLAUDE.md`; `readlink` prints `CLAUDE.md`.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md AGENTS.md
git commit -m "docs(openspec): route code work via opsx, symlink AGENTS.md to CLAUDE.md"
```

### Task 4: Freeze legacy tree + ignore .superpowers/

**Files:**
- Create: `docs/superpowers/README.md`
- Modify: `.gitignore` (append one section at the end)

**Interfaces:**
- Produces: the freeze banner every future legacy-tree visit reads; `.superpowers/` excluded from git status noise.

- [x] **Step 1: Write `docs/superpowers/README.md`**

```markdown
# Frozen legacy planning corpus

This tree is frozen as of 2026-09-08. Planning runs on OpenSpec
(`openspec/changes/<name>/`); the migration is documented in
`openspec/changes/migrate-brainstorming-to-openspec/design.md` (after
archive: `openspec/changes/archive/<date>-migrate-brainstorming-to-openspec/`).
No new files land here.

Disposition rules:

- Adopting a pending design (the phase-3 roadmap,
  `specs/2026-09-03-phase3-zg-inspired-roadmap-design.md`) → `/opsx:propose`
  a change and port its content into proposal.md / design.md / tasks.md;
  delete the stale legacy file in the same commit.
- Referencing shipped behavior → code and tests are truth; read these specs
  and plans only as historical detail.
```

- [x] **Step 2: Append to `.gitignore`**

Add at the end of the file:

```gitignore

# local agent working artifacts (superpowers sdd)
.superpowers/
```

- [x] **Step 3: Verify**

```bash
git check-ignore .superpowers/sdd/progress.md && echo ignored
git status --short | grep -v "^??" | head
```

Expected: `ignored` prints; staged/unstaged set contains only this task's two files plus `tasks.md` checkbox state.

- [x] **Step 4: Commit**

```bash
git add docs/superpowers/README.md .gitignore openspec/changes/migrate-brainstorming-to-openspec/tasks.md
git commit -m "docs(openspec): freeze docs/superpowers legacy corpus, ignore .superpowers/"
```

### Task 5: Final sweep + full check

**Files:**
- Modify: none expected; fix any hits found.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified-clean instruction surfaces; the green gate for archive.

- [x] **Step 1: Sweep for stale routing**

```bash
grep -rn "brainstorming" CLAUDE.md
grep -rn "docs/superpowers" CLAUDE.md package.json src tests bench docs/research 2>/dev/null
```

Expected: the first grep matches only the two Workflow-section lines (the routing row and the brainstorming-keeps-non-code line). The second grep returns no hits (codeindex code never referenced the legacy tree); any hit must be either fixed or justified as historical in the commit message.

- [x] **Step 2: Run the full gate**

```bash
bun run check
```

Expected: all parallel checks pass (test, typecheck, lint, format:check, bench gates) — this migration touched no code.

- [x] **Step 3: Commit (only if the sweep fixed something)**

```bash
git add -A && git commit -m "docs(openspec): sweep stale legacy routing references"
```

### Task 6: Verify completion gates

**Files:**
- Modify: none.

- [x] **Step 1: Confirm every checkbox in this tasks.md is `- [x]`**

```bash
grep -c "\- \[ \]" openspec/changes/migrate-brainstorming-to-openspec/tasks.md
```

Expected: `0`.

- [x] **Step 2: Strict-validate the change one last time**

```bash
openspec validate migrate-brainstorming-to-openspec --strict --no-interactive
```

Expected: passes.

### Task 7: Archive the change

**Files:**
- Move: `openspec/changes/migrate-brainstorming-to-openspec/` → `openspec/changes/archive/2026-09-08-migrate-brainstorming-to-openspec/`

**Interfaces:**
- Consumes: Tasks 1–6 complete.
- Produces: the archived migration guide the freeze README (Task 4) points at; clean slate for the shakedown.

- [ ] **Step 1: Archive**

```bash
openspec archive migrate-brainstorming-to-openspec --yes --skip-specs
```

Expected: folder moves to `openspec/changes/archive/2026-09-08-migrate-brainstorming-to-openspec/` (date prefix from archive time).

- [ ] **Step 2: Commit the archive**

```bash
git add openspec/changes && git commit -m "chore(openspec): archive migrate-brainstorming-to-openspec"
```

- [ ] **Step 3: Report and hand off to the shakedown**

Summarize: what shipped (scaffold, routing, freeze, ignore), spec files touched (none — `skip_specs: true`). The shakedown is the next real feature — the first phase-3 slice — run as a fresh change via `/opsx:explore`, porting the phase-3 roadmap content into its proposal and deleting the legacy file per the freeze README. Tune `openspec/config.yaml` rules from what that change teaches.

---

## Execution notes

- tasks.md checkbox state lands in the same commit as each task's work (per `config.yaml` → `operations.apply.guidance`).
- Worktree isolation via `superpowers:using-git-worktrees` is optional here; all artifacts are text and rollback is `git revert` (design Risks section).
- papai reference playbook: `/Users/ki/Projects/yourpapai/papai/openspec/changes/archive/2026-08-10-migrate-brainstorming-to-openspec/` (read-only; do not copy files from it — config and docs here are codeindex-tailored).
