---
id: 261126-043951
title: Every git ls-files call gets a 64 MB output buffer (ENOBUFS)
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

On 2026-11-26 the repo's `git ls-files` output for all source files passed 1 MB, the default `maxBuffer` of Node's `execFileSync` and `spawnSync`. Repo-wide tests then crashed with `spawnSync git ENOBUFS` (for example `scripts/__tests__/gray-matter-import-boundary.test.ts` in typecheck's "Repo-wide scripts suites", run 45750738588), and queue entries were ejected for it. All 17 call sites that run `git ls-files` (scripts tests, server, shared and skills tests, `knip.config.ts`, `scripts/check-one-shot-routes.ts`) now pass `maxBuffer: 64 * 1024 * 1024`, the value other repo scripts already use. Six of the lines match the same fix already in #4464, #4466 and #4480, so they merge cleanly in either order. Nothing measurable should move besides the ENOBUFS reds stopping.
