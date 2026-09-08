# Design: Migrate brainstorming → OpenSpec

codeindex's planning pipeline runs on global `obra/superpowers` skills:
`brainstorming` produces single-file design docs under `docs/superpowers/specs/`,
`writing-plans` turns them into plan docs, `executing-plans` /
`subagent-driven-development` run them. These docs go stale, carry no
machine-readable state, and leave no living spec tree. papai has already
migrated the same pipeline to OpenSpec and validated the playbook
(`openspec/changes/archive/2026-08-10-migrate-brainstorming-to-openspec/` in
the papai repo). This change replays that playbook, sized down for codeindex.

## Context

Current state:

```text
STILL ROUTING TO THE OLD FLOW
═══════════════════════════════════════════════════════════════════
CLAUDE.md ─────────────────────► no workflow section; global superpowers
                                  skills gate all creative work →
                                  brainstorming → writing-plans
docs/superpowers/specs/         11 design docs (10 shipped, phase-3
                                  roadmap pending)
docs/superpowers/plans/         14 plans (all shipped)
.superpowers/sdd/               136 untracked working artifacts (review
                                  diffs, fix reports, progress.md)

NO LEGACY-COUPLED TOOLING (audited, unlike papai)
═══════════════════════════════════════════════════════════════════
package.json scripts, bench/, tests/ — nothing reads or writes
docs/superpowers/; no plan-adr-workflow or mutation-improve equivalent
```

Environment facts: openspec CLI 1.8.0 installed globally (bun);
no repo-local `.claude/`, `.opencode/`, or `.agents/` dirs yet (clean slate);
`.superpowers/` is not git-tracked; openspec reads the caller's cwd, matching
how codeindex's own MCP server already behaves.

## Goals / Non-Goals

**Goals:**

- One routing source of truth: `CLAUDE.md` sends code-behavior work to
  `/opsx:explore` / `/opsx:propose`, keeps superpowers skills only where they
  don't conflict (TDD, verification, code review, debugging, worktrees,
  branch finish).
- Every instruction surface that generates or edits old-format artifacts is
  retargeted or explicitly frozen.
- The migration itself validates the explore → propose → apply → archive loop
  end to end (dogfood), as papai's did.

**Non-Goals:**

- No backfill of the legacy corpus (11 specs, 14 plans) into
  `openspec/specs/` or changes; strangler — specs accrete from future changes.
- No schema fork (`schemas/auto-sdd/` equivalent); papai deferred its fork
  until 2–3 changes of experience, so does codeindex.
- No changes to `src/`, `bench/`, `tests/`, `package.json`, or any
  verification command; `bun run check` behavior is untouched.
- No edits to global `~/.claude/skills/` or `~/.agents/skills/`; superpowers
  stays vanilla for other projects.
- No migration of `.superpowers/sdd/` history; it becomes local-only.
- No porting of the phase-3 roadmap in this change; it is ported lazily when
  the next feature adopts it (shakedown step).

## Decisions

### D1 — Strangler, no backfill

`openspec/specs/` starts empty and accretes from future changes. The legacy
corpus stays in place as read-only reference; code and tests remain truth for
shipped behavior. papai rejected backfill for the same reason: delta specs
earn their keep on future changes, not as archaeology.

### D2 — Scaffold lands as a direct commit; the rewiring is the dogfood change

`openspec init` + tailored `openspec/config.yaml` land as one direct commit —
the chicken-and-egg step. Everything that *rewires* routing and freezes the
legacy tree is the first change under `openspec/changes/`, so the new loop
validates itself on real work. This design document lives as that change's
`design.md` (final home:
`openspec/changes/migrate-brainstorming-to-openspec/design.md`), replacing
papai's pattern of a standalone docs page.

### D3 — Fresh scaffold, codeindex-tailored config

Skills and commands come from `openspec init` / `openspec update` for both
hosts (`.claude/` and `.opencode/`), not verbatim copies of papai's
(papai's are customized with papai-specific paths: review-loop,
mutation-improve, docs/architecture, Stryker). `openspec/config.yaml` is
written fresh, modeled on papai's structure:

- `schema: spec-driven`
- `context`: codeindex is a tree-sitter symbol/reference indexer exposing an
  MCP server (code_symbol / code_search / code_impact) and a CLI; Bun-only
  runtime; strict TypeScript; Zod v4; SQLite WAL via `openDatabase()` with
  sibling `-wal`/`-shm` files; incoming-reference table is
  `symbol_references` (not `references` — SQLite keyword); exact-first search
  with structural ranking.
- Verification commands: `bun run test`, `bun run typecheck`, `bun run lint`,
  `bun run format:check`, aggregate `bun run check`, and benchmark gates via
  `bun run check:bench`.
- `rules.proposal`: name affected surfaces; require a "Non-goals" section;
  justify each declared capability; name the existing module that already
  covers a need where one does; keep proposals under 500 words.
- `rules.specs`: SHALL statements; every requirement has at least one
  `#### Scenario:` with WHEN/THEN; for MCP tool surfaces, spec both the
  text payload and `structuredContent` behavior.
- `rules.design`: name existing modules before introducing new ones;
  state indexer/search/MCP-surface impact; note TDD hook interactions.
- `rules.tasks`: independently verifiable chunks, test-first ordering, every
  task ends with its verification command, final task runs full
  `bun run check` and updates affected docs.
- `operations.apply`: TDD; checkbox hygiene; commit each tasks.md section as
  it completes; the change folder rides with the code on the same branch.
- `operations.archive`: validate strict, confirm merged specs read as current
  truth, archive as a follow-up commit after merge.

### D4 — CLAUDE.md routing table

`CLAUDE.md` gains a "Workflow" section; repo instructions outrank global
skills (using-superpowers precedence rule), so the override is repo-scoped.

| Trigger                                         | Route                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| "Let's build / add / change X" (code behavior)  | `/opsx:explore` or `/opsx:propose` — **not** brainstorming            |
| Non-code creative work (docs, process, writing) | brainstorming (unchanged)                                             |
| Bug / test failure                              | systematic-debugging; if root cause becomes a change, `/opsx:propose` |
| Inside `/opsx:apply`                            | test-driven-development, verification-before-completion               |
| Plan drifted from code                          | syncing-plan-with-code against `openspec/changes/<name>/` artifacts   |

An `AGENTS.md` symlink to `CLAUDE.md` gives opencode and Claude Code one
source of truth (papai's pattern).

### D5 — Legacy corpus frozen in place, ported lazily

Nothing in `docs/superpowers/` is moved or deleted. A
`docs/superpowers/README.md` banner marks the tree frozen and states
disposition rules:

- *Adopting a pending design (the phase-3 roadmap)* → `/opsx:propose` a
  change and port its content into `proposal.md` / `design.md` /
  `tasks.md`; then delete the stale legacy file in the same commit.
- *Referencing shipped behavior* → code and tests are truth; read
  `docs/superpowers/specs/` only as historical detail.
- *No new files* under `docs/superpowers/`.

### D6 — `.superpowers/` is local-only working state

The 136 sdd artifacts (review diffs, fix reports) are untracked working
output of the subagent-driven-development skill. `.gitignore` gains
`.superpowers/` so they never enter git; the files stay on disk.

### D7 — Both hosts, no lockstep copies to maintain

`.claude/` and `.opencode/` scaffolding comes from the same `openspec update`
run, so unlike papai's hand-maintained skill copies there is no drift risk to
manage; re-running `openspec update` after CLI upgrades refreshes both.

## Risks / Trade-offs

- *Agent habit regression* — global superpowers skills still push
  brainstorming → writing-plans for code work → mitigated by the CLAUDE.md
  routing table, loaded every session and outranking global skills.
- *Two doc universes coexist* — legacy specs remain as historical reference →
  freeze banner (D5) plus "ambiguity resolves to openspec wins".
- *Change folder exists before the scaffold commit* —
  `openspec/changes/migrate-brainstorming-to-openspec/design.md` is committed
  before `openspec init` runs; `openspec init` creates missing structure
  without clobbering existing files, and the change is simply incomplete
  (no proposal.md/tasks.md) until `/opsx:propose` fills it in.
- *Rollback* — all text in git; no data migration, no runtime surface;
  revert the commits.

## Migration Plan

Ordered steps; each maps to a verifiable task in `tasks.md`:

1. **Scaffold (direct commit).** `openspec init`, then rewrite
   `openspec/config.yaml` per D3; verify `openspec list` and
   `openspec doctor` pass and both host scaffolds exist.
2. **Land this design** as the change's `design.md` (done at spec-approval
   time).
3. **Propose** the change via `/opsx:propose`: `proposal.md` + `tasks.md` +
   `.openspec.yaml` (`skip_specs: true`).
4. **Rewire `CLAUDE.md`** (D4): add the Workflow routing table; add the
   `AGENTS.md` symlink.
5. **Freeze the legacy tree** (D5): `docs/superpowers/README.md`.
6. **Ignore `.superpowers/`** (D6).
7. **Final sweep.** Grep instruction surfaces (`CLAUDE.md`, `docs/`) for
   `docs/superpowers/specs` as a *write* target; every remaining hit is
   banner-covered legacy or historical reference. Run `bun run check`.
8. **Archive** the change via `/opsx:archive` (strict validate passes).
9. **Shakedown.** The next real feature — first phase-3 slice — runs the full
   loop; port the phase-3 roadmap content into that change's proposal and
   delete the legacy file (D5); tune `config.yaml` rules from observation.

Ongoing: `openspec update` after CLI upgrades; treat `openspec/specs/` as
review-required PR surface once it has content.

## Open Questions

None — schema-fork and expanded-profile decisions are deferred by design
(Non-Goals), revisited after the shakedown change, mirroring papai's
experience.
