---
slug: managed-browser-engine-removal
id: 261113-215635
created: 2026-11-13
status: draft
---

# Delete the parked managed browser engine

**Status:** Draft deletion plan. Security reads the deletion diff before arming. The PR needs the `allow-deletions` label.
**Author:** DorkOS Code (agent)
**Date:** 2026-11-13
**Tracker:** DOR-4284 (Should, after the Nov 17 launch)
**Why:** [Agent browser: keep building, adopt, or package?](../../research/20261113_agent-browser-build-vs-adopt.md), §7 path A. The engine has no users, is wired into no shipped path, is macOS-only, and costs CI time.

Inventory taken at `0e886aa389` (Nov 13). Re-check every path at build time; line counts are approximate.

## 1. What goes

| Path                                                           | Files       | Product lines     | Test lines         |
| -------------------------------------------------------------- | ----------- | ----------------- | ------------------ |
| `packages/browser` (`@dorkos/browser`)                         | ~211        | ~24.7k            | ~31.4k             |
| `apps/server/src/services/browser/{egress,registry,runtime}`   | most of ~95 | ~6.9k (whole dir) | ~16.5k (whole dir) |
| `scripts/browser-control-prototype`, except the keep set below | ~125        | ~10.0k            | ~8.2k              |

## 2. What stays

**The viewer keep set**, for DOR-2667 to port: `scripts/browser-control-prototype/viewer.mjs`, `viewer-client.mjs`, `viewer-pointer.mjs`, `viewer-page.html` and `contracts.mjs`. These import nothing else in the folder.

The viewer's tests (`__tests__/viewer*.test.mjs`, `viewer-test-setup.mjs`) import `runtime.mjs`, `fixture.mjs`, `manager.mjs` and `control.mjs`, which pull in most of the prototype. **Delete those tests with the engine.** DOR-2667 writes new tests against the live Agent browser when it ports the viewer. Add a short `README.md` beside the keep set saying why the files are there and that DOR-2667 moves them.

**Live code inside `services/browser`. Move it, don't delete it.** These files belong to the live Agent browser and the older signed-in browser, not the engine:

| File                                         | Used by                                                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `agent-browser-guard.ts`                     | `startup/steps/mcp-tasks-skills.ts` (startup scrub), `services/mesh/agent-mcp-server-service.ts`          |
| `agent-browser-lint.ts`                      | `routes/mesh.ts`, `routes/discovery.ts`, `runtimes/claude-code/mcp-tools/mesh-tools.ts`, the startup step |
| `profile-scan.ts`, `profile-scan-openapi.ts` | `routes/your-browser.ts`, `core/openapi/domains.ts`                                                       |
| `browser-user-home.ts`                       | the profile scan (also a carve-out row in `.claude/rules/dork-home.md`)                                   |

Move them and their tests (`__tests__/agent-browser-guard*.test.ts`, `agent-browser-lint.test.ts`, `agent-browser-tool-census.test.ts`, `profile-scan.test.ts`, `fixtures/`) to a new `services/agent-browser-guard/` domain, or under `services/session/local-browser/`. Update every importer above. Do the move as its **own first commit** (pure renames), so Security can read the move and the deletion separately.

## 3. CLI removals

- `packages/cli/src/commands/browser-runtime-commands.ts` and `packages/cli/src/lib/agent-browser/browser-runtime-deps.ts`: they register `dorkos browser install [--repair]` and `dorkos browser status --runtime`, which install the engine's pinned Chrome for Testing.
- The branch in `packages/cli/src/commands/browser-dispatcher.ts` that loads them.
- `packages/cli/src/commands/__tests__/browser-runtime-commands.test.ts`.
- Build steps that bundle engine files: `packages/cli/scripts/build.ts` (the fresh-verifier and runtime-worker entries), `packages/cli/scripts/browser-native-artifact.ts` and its test `packages/cli/src/__tests__/browser-native-artifact.test.ts`.
- `"@dorkos/browser": "workspace:*"` in `packages/cli/package.json` and `apps/server/package.json`. Then regenerate `pnpm-lock.yaml`.

Keep the older `dorkos browser login` and `dorkos browser status` commands (`browser-commands.ts`). Their fate is DOR-3770.

## 4. The Shared browser experiment

- Remove the Experiments row (`services/core/config/experiments-registry.ts`, "Shared browser").
- Remove `browser.enabled` from `packages/shared/src/config-schema.ts` and the refusal in `services/core/config/browser-setting.ts` (wired in `config-manager.ts`).
- Remove its mentions in `core/safe-defaults/default-verdicts.ts`, `core/operator/config-disclosure-experiments.ts`, the operator policy files and `runtimes/shared/ui-tool-contract.ts`, with their tests.
- **Config:** removing a field needs a new semver-keyed migration that deletes `browser.enabled` from stored configs (the `adding-config-fields` skill). Leave the old `0.99.0` migration in place so version order holds.
- Docs: `docs/getting-started/configuration.mdx` (the `browser.enabled` section) and `contributing/configuration.md`.

## 5. Wiring and ratchets

- `vitest.config.ts`: drop the `packages/browser` project. `scripts/__tests__/vitest-projects.test.ts` will fail until you do.
- `AGENTS.md`: drop the `browser/` line from the package tree. If `services/browser` ends up empty, drop `browser` from the service-domain census too (and add the new domain if the guard moves to one); `scripts/__tests__/agents-service-census.test.ts` enforces it.
- Ratchet baselines (only lower or remove entries): `scripts/max-lines/baseline.json` (`pnpm check:max-lines -- --update`), `scripts/knip/baseline.json`, `scripts/own-mocks/baseline.json`, `scripts/sharding/durations.json`.
- Comments and prose that name the engine: `packages/shared/src/agent-browser.ts` (guard path comment), `packages/operating-skills/src/skills/using-the-agent-browser.ts` (skill text), `scripts/snapshot-agent-browser-tools.mjs`.
- Contributing guides: `contributing/system-architecture.md`, `contributing/browser-verification.md`, `contributing/INDEX.md`, `contributing/diagrams/architecture/README.md`.
- Specs, research, ADRs and the changelog archive are history. Leave them as they are. Mark ADR `261001-231451` (share one managed page) superseded in `decisions/manifest.json`, and set `specs/shared-browser-control` to `superseded` in `specs/manifest.json`.

## 6. Test plan

- Before deleting: `uptime` (hold over 16). Then targeted runs only: the moved guard, lint and profile-scan tests at their new paths; the CLI dispatcher tests; the config schema and migration tests; `scripts/__tests__/vitest-projects.test.ts` and `agents-service-census.test.ts`.
- `pnpm --filter @dorkos/server typecheck`, `pnpm --filter dorkos typecheck`, `pnpm --filter @dorkos/shared typecheck`.
- `pnpm knip` after building dists, then lower the knip baseline.
- `pnpm check:max-lines -- --update` and the own-mocks check.
- Build the CLI bundle once (`pnpm --filter dorkos build`) to prove no engine entry is left.
- CI's full suites run in the merge queue. A red there that names an engine path means an import was missed.

## 7. Review and labels

- Labels: `allow-deletions`, `hold`, `review:deep`, `skip-changelog` (users see no change; the Experiments row was never usable).
- Security reads both commits (the move, then the deletion) before arming. The move must not change any guard behaviour: same tests, same results.

## Order and date

After the Nov 17 launch, in parallel with DOR-4273 (no shared files). About 1.5 days with the guard move. Target: **Fri Nov 20, 2026.**
