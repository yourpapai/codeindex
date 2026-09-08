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
