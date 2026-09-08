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
