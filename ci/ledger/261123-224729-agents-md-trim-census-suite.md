---
id: 261123-224729
title: Drop the AGENTS.md service census suite from the repo-wide list with the census itself
kind: hygiene
status: proposed
actor: agent
gates: []
prs: [4181]
ratchet-release: []
field-changes: []
---

#4181 trims AGENTS.md under Codex's 32 KiB cap and removes its service-domain list, so the test that
guarded that list (`scripts/__tests__/agents-service-census.test.ts`) goes too. This removes its
name from `REPO_WIDE_SUITES` in `scripts/vitest.repo.config.ts`, which
`repo-wide-suites.test.ts` requires. Nothing measurable should move.
