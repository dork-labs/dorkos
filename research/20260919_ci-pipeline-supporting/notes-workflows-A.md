# CI workflow review, set A (12 workflows)

Repo: `the repo root`, read at `main` (9688d2db0). All paths below are relative to `.github/workflows/` unless they start with `scripts/` or are a root file. Every job runs on `ubuntu-latest`. No workflow here uses a self-hosted or larger runner.

## Cross-cutting facts

| Fact                                                                                                                                                                                                                                                                                                                                     | Evidence                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No turbo remote cache anywhere (no TURBO_TOKEN/TURBO_TEAM, no remoteCache block)                                                                                                                                                                                                                                                         | lint.yml:65-73, site-build.yml:116-118, turbo.json (no `remoteCache`)                                                                                                                                                                                                                                                        |
| The only turbo local cache persisted between runs is credential-free-build's `actions/cache` over `.turbo/cache`, and it is saved on PRs only                                                                                                                                                                                            | credential-free-build.yml:442-448, 645-650                                                                                                                                                                                                                                                                                   |
| `test` and `typecheck` both `dependsOn: ["^build"]`; `build` dependsOn `generate:api-docs` + `^build`; `lint` dependsOn `^lint` only (no build)                                                                                                                                                                                          | turbo.json `tasks`                                                                                                                                                                                                                                                                                                           |
| `^build` of `dorkos` (cli), `@dorkos/desktop`, `@dorkos/obsidian-plugin`, `@dorkos/evals` pulls in `@dorkos/server` + `@dorkos/client` (a Vite build). So any full `turbo test` or `turbo typecheck` builds server + client + shared + nearly every package                                                                              | packages/cli, apps/desktop, apps/obsidian-plugin, packages/evals package.json deps                                                                                                                                                                                                                                           |
| turbo.json sets `concurrency: 15` (developer default); CI jobs override it to 1, 2 or 4                                                                                                                                                                                                                                                  | turbo.json; test.yml:331,380; credential-free-build.yml:498,578                                                                                                                                                                                                                                                              |
| `setup-node` with `cache: pnpm` caches the pnpm store (download only). `pnpm install --frozen-lockfile` still runs in every job that needs node_modules                                                                                                                                                                                  | every workflow                                                                                                                                                                                                                                                                                                               |
| Merge-queue `check_response_timeout_minutes` is 120                                                                                                                                                                                                                                                                                      | credential-free-build.yml:338-342, typecheck.yml:126-127                                                                                                                                                                                                                                                                     |
| Required contexts (from the headers): `test`, `browser-test`, `typecheck`, `lint`, `fragment-present`, `no-fragment-under-skip-label`, `version-outranks-base`, `db-check`. NOT required: `site-build`, `openapi-fresh`, `copy-spec-drift`, `credential-free-build` (but see the contradiction below), scripts-test jobs, CLI smoke jobs | test.yml:152-159; browser-test.yml:71-81; typecheck.yml:146-150; lint.yml:52-57; changelog-fragment-check.yml:34-35; operating-skills-version-check.yml:49-50; db-check.yml:69-73; site-build.yml:82-87; docs-openapi-check.yml:44-49; browser-test.yml:615-620; credential-free-build.yml:120-128; scripts-test.yml:149-151 |

---

## 1. test.yml (`name: test`)

- **Triggers:** `pull_request` (all types, no branch or paths filter), `merge_group` (174-176). No push and no schedule. Push-to-main was dropped on purpose (169-173).
- **Concurrency:** `test-${{ github.ref }}`, cancel-in-progress only on `pull_request` (189-191).
- **Workflow env:** `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` (180-181).

| Job (check context)                     | if                                  | timeout  | needs                              | What it runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------- | ----------------------------------- | -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `community-pg`                          | none, so it runs on BOTH events     | 15 (201) | none                               | Postgres 17 service container (202-215); install (223); `pnpm --filter @dork-labs/cloud-api build && pnpm --filter @dorkos/shared build` (224); `pnpm --filter @dorkos/community test:pg` (228); `playwright install --with-deps chromium`, not cached (230); `test:browser`, which runs `pnpm build` of community and then Playwright (234, apps/community/package.json:15); uploads the `community-browser-evidence` artifact on `always()` (235-243)                                                                                                                                                                                                                                                 |
| `test-shard (1/4)` … `test-shard (4/4)` | job: none. Steps are gated by event | 30 (266) | none                               | matrix `shard: [1,2,3,4]`, `fail-fast: false` (252-259); env `NODE_OPTIONS=--max-old-space-size=8192` (273-274); checkout with `fetch-depth: 0` so tags exist (284-286); install (295). **merge_group:** `turbo test --summarize --continue --concurrency=1 -- --run --shard=N/4 --retry=1 --passWithNoTests` with json and flake reporters (329-331). **pull_request:** `TURBO_SCM_BASE=pull_request.base.sha turbo test --affected --continue --concurrency=1 -- --run --shard=N/4 --passWithNoTests` (376-380). merge_group only: `assert-tests-executed.sh` (408-410), naming of retried tests (443-479), recording the collected files (490-496), uploading the `shard-files-N` artifact (498-503) |
| `test` (the one required producer)      | `always()` (516)                    | 10 (581) | `[test-shard, community-pg]` (515) | Fails unless the shard matrix result is `success` (590-594) and `community-pg` is `success` (596-600). merge_group only: checkout, download `shard-files-*`, run `scripts/assert-shard-union.sh` (605-623). No install                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

- **Scoping:** it runs on both events. The PR shards use `turbo --affected` against a pinned SHA (359-375). The queue runs the full monorepo. Nothing is skipped at the workflow level. `community-pg` has no scoping at all, so every PR (docs-only included) pays for Postgres, a Chromium install, a community build and Playwright.
- **merge_group:** yes. It is required.
- **Scripts:**
  - `scripts/assert-tests-executed.sh` reads the newest `.turbo/runs/*.json`. It fails if any `test` task was not a cache MISS, or if the number of `test` tasks differs from the number of `apps/*`/`packages/*` manifests with a `test` script (lines 82-116). It deliberately avoids `--force` (26-30).
  - `scripts/assert-shard-union.sh` unions the `shard-files-*.txt` files and fails if any package with a `test` script contributed zero collected files. It rebuilds the net that `--passWithNoTests` removes (5-20, 65-98).
- **Header notes:**
  - Full sweep in the queue because a per-PR affected diff cannot see an interaction between two PRs (21-25).
  - Sharding is at the vitest file level, so apps/server splits: 241/240/240/240 files, and the queue shards measure 8-13 min (27-49).
  - The PR leg exists only because a required check must succeed on the PR before the PR can enqueue (PR #1246 deadlocked) (138-150).
  - One retry in the queue, and every retried test is named (86-112).
  - Cost math for sharding the PR leg: ~3.3 min fixed plus 34/N min. That is 37 runner-min at N=1 and 47 at N=4 (538-566).
- **Staleness:** the header (1-173) and the fan-in comment (505-513, "Pure fan-in … runs no tests") predate `community-pg`. Only lines 197-198 mention it. `test` now also gates on a job that runs no shard.
- **Cost:**
  - PR: 6 jobs. 5 run `pnpm install`. Each of the 4 shards pays its own `^build` for the affected closure (~2.8 min each per 546-548). `community-pg` builds cloud-api, shared and community.
  - merge_group: 6 jobs, with the same 5 installs. Each shard builds the full `^build` graph, which includes server and client, so the build runs 4 times.

## 2. browser-test.yml (`name: browser-test`)

- **Triggers:** `pull_request`, `merge_group` (114-116). No paths filter, on purpose (46-65). Push-to-main was dropped (40-44).
- **Concurrency:** `browser-test-${{ github.ref }}`, cancel only on PR (128-130).

| Job (context)                                                                 | if                                                                                                                    | timeout  | needs                 | What it runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser-shard (1/3)`, `(2/3)`, `(3/3)` (name uses `strategy.job-total`, 137) | `github.event_name == 'merge_group'` (141). On PRs the whole matrix is skipped (likely one skipped, unexpanded entry) | 45 (223) | none                  | matrix `[1,2,3]`, `fail-fast: false` (183-191); env `NODE_ENV=development`, `E2E_SITE=1`, `E2E_PROD=1`, `E2E_SHARD_TOTAL` (224-265); install (291); resolves the Playwright version (313-315); `actions/cache@v6` on `~/.cache/ms-playwright`, keyed `playwright-chromium-OS-version` (316-321); apt hardening, then `install-deps` or `install --with-deps chromium` with 2 attempts and a 10-min step timeout (328-353); `turbo run build --filter=@dorkos/server --filter=@dorkos/client --filter=@dorkos/site^...` (368-369); `pnpm --filter @dorkos/e2e run e2e --shard=N/3` with a 35-min step timeout (412-414); uploads `browser-results-shard-N` with one retry, 7-day retention (442-461); uploads `playwright-report-shard-N` on failure or cancel with one retry (485-503) |
| `browser-test` (the required producer)                                        | `always()` (532)                                                                                                      | 10 (536) | `browser-shard` (531) | **PR:** echoes the deferral and succeeds (542-544). **merge_group:** fails if shards did not all succeed (549-553), then checkout, download the reports and run `scripts/assert-browser-tests-executed.sh` over the union (555-601). No install                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `copy-spec-drift`                                                             | none, so it runs on both events                                                                                       | 10 (631) | none                  | checkout with `fetch-depth: 0`, install (635-646); `tsx scripts/check-copy-spec-drift.ts $BASE_SHA`, using the PR base.sha or merge_group.base_sha (657-669)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

- **Scoping:** the PR gets a pass-through context and the queue runs the full suite. The skip is inside the job (a job-level `if` on the matrix plus a fan-in that always runs), so the check always reports.
- **merge_group:** yes. `browser-test` is required. `copy-spec-drift` reports there but is not required (615-620).
- **Header notes:**
  - The suite moved to queue-only because of runner saturation: 88 runs were queued against 14 running on the Free-plan cap of 20 concurrent jobs (19-39).
  - Three shards is where the cost curve knees. Each shard costs about 1m45s of setup plus 2m30s of webServer boot plus 38m/N (143-182).
  - The timeout ladder is 30m globalTimeout, then the 35m step, then the 45m job (192-223).
  - The live marketplace registry is an external dependency of the site leg (93-104).
- **Cost:**
  - PR: 2 runner jobs (the fan-in echo, and copy-spec-drift with an install).
  - merge_group: 5 jobs, 4 of them with an install. Each of the 3 shards builds server, client and the site's dependencies, so the build runs 3 times, then boots the webServer legs.
- **Redundancy:** `copy-spec-drift` re-runs on merge_group against `merge_group.base_sha`. That is a second full install for a check that is not required.

## 3. typecheck.yml (`name: typecheck`)

- **Triggers:** `pull_request`, `merge_group` (75-77). Push-to-main was dropped (69-74).
- **Concurrency:** `typecheck-${{ github.ref }}`, cancel only on PR (89-91).

| Job         | if   | timeout  | needs | What it runs                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | ---- | -------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typecheck` | none | 20 (133) | none  | install (144); then five gates, each `if: !cancelled()`: `scripts/check-banned-words.sh` (159-161), `pnpm run check:vocab-gate` (tsx, 178-180), `pnpm run check:boundary` with the secret `BOUNDARY_TERMS` and the `vars.BOUNDARY_TERMS_REQUIRED` fork/dependabot logic (224-229), `scripts/check-nul-bytes.sh` (237-239), `scripts/check-dead-doc-paths.sh` (246-248); finally the full `turbo typecheck --continue` (253-255) |

- **Scoping:** none. The full monorepo runs on BOTH events (114-121).
- **merge_group:** yes. It is required.
- **Header notes:**
  - Full, not affected, because of the #488/#489 two-PR interaction (24-33).
  - No separate build because `^build` handles it (35-41).
  - The timeout of 20 is measured: over 207 queue runs, p50 was 4.62 min, p90 7.64 and max 8.52. The earlier limit of 10 evicted green entries (99-133).
  - Unrelated gates ride along because `typecheck` is the required check (146-150).
- **Cost:** 1 job per event. It installs and builds `^build` for every package, which includes server and client, and then typechecks all of them. The PR leg costs the same as the queue leg.

## 4. lint.yml (`name: lint`)

- **Triggers:** `pull_request`, `merge_group` (83-85). Push-to-main was dropped (75-82).
- **Concurrency:** `lint-${{ github.ref }}`, cancel only on PR (97-99).

| Job    | if   | timeout  | needs | What it runs                                                                                                                                                                                                                                                  |
| ------ | ---- | -------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lint` | none | 15 (115) | none  | install (126); `pnpm format:check`, which is `prettier --check .` over ~7,300 files (135-136); `turbo lint --continue` with `if: !cancelled()` (150-152); `pnpm lint:root`, which is `eslint .` from the root for scripts/.claude/.agents/templates (179-181) |

- **Scoping:** none. The full repo runs on both events (33-40).
- **merge_group:** yes. It is required (52-57).
- **Header notes:**
  - No build is needed because the ESLint config is syntax-only (59-63).
  - There is no execution assertion because there is no remote cache. The header warns that adding one makes this job silently skippable (65-73).
  - The local measurements were ~40s for lint and 2m17s for prettier (107-114).
- **Cost:** 1 job per event. It installs but does not build. The PR leg costs the same as the queue leg.

## 5. site-build.yml (`name: site-build`)

- **Triggers:** `pull_request`, `merge_group` (88-90).
- **Concurrency:** `site-build-${{ github.ref }}`, cancel only on PR (101-103).

| Job          | if   | timeout  | needs | What it runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------ | ---- | -------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site-build` | none | 30 (120) | none  | checkout with `fetch-depth: 0` (126-128); install (137), which runs even when the scope decides to skip; the scope step (PR only, 176-206) diffs `origin/<base_ref>...HEAD --no-renames` for `docs/`, `blog/` and the workflow file (194-199), otherwise runs `turbo build --filter=@dorkos/site --affected --dry=json` and counts the packages (200-206); build `turbo build --filter=@dorkos/site` if merge_group or scope is true (213-215); otherwise it echoes a no-op (219-221) |

- **Scoping:** inside the job, at step level (67-80). The PR build is conditional and the queue always builds.
- **merge_group:** yes. It is NOT required (82-87).
- **Header notes:**
  - It exists because PR #743 put an edge runtime next to a node-only import, which broke the Vercel build (7-12).
  - No secrets, by design (33-43).
  - It uses `turbo` rather than `pnpm --filter` because a pnpm filter that matches nothing exits 0 (45-54).
- **Minor inconsistency:** it uses the ref `origin/${{ github.base_ref }}` (180), which test.yml:363-375 argues against. The effect is small here because the diff is 3-dot.
- **Cost:** 1 job. It always installs. When it builds, turbo also runs site `generate:api-docs` through `build`'s dependsOn (turbo.json), the same generator docs-openapi-check runs.

## 6. scripts-test.yml (`name: scripts-test`)

- **Triggers:**
  - `pull_request` with `paths:` (155-187): scripts/**, .agents/skills/creating-pull-requests/scripts/**, .claude/scripts/**, package.json, lefthook.yml, apps/_/package.json, packages/_/package.json, packages/harness/src/**, packages/shared/src/**, vitest.config.ts, pnpm-workspace.yaml, .claude/hooks/**, contributing/INDEX.md, apps/server/eslint.config.js, packages/eslint-config/**, and 6 workflow files plus .github/dependabot.yml.
  - `push: branches [main]` with the same paths list, copied by hand (188-222).
  - **No `merge_group`**, so it can never be required. That is on purpose (146-152).
- **Concurrency:** `scripts-test-${{ push ? sha : ref }}`, cancel only on PR (238-240).

| Job        | timeout                    | What it runs                                                                                                                                                                                                                                                                 |
| ---------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixtures` | **none** (defaults to 360) | checkout; setup-node 22 without a pnpm cache (249-253); ~20 bash fixture suites (255-418); `node --test .claude/scripts/__tests__/*.test.ts` (431-434); `docs-coverage-map.mjs --check` (464-465). No install                                                                |
| `harness`  | **none**                   | setup-node 22 with a pnpm cache; install (484-485); `turbo build --filter=@dorkos/harness`, which also builds shared (494-495); `pnpm typecheck:scripts` (497-498); 5 bash suites that need node_modules (518-560); `vitest run --config scripts/vitest.config.ts` (580-581) |

- **Scoping:** a workflow-level `paths:` filter, so the check does not report on a PR that does not match.
- **merge_group:** no.
- **Header notes:**
  - Two jobs so the fast fixture signal skips the install (55-64).
  - The suite list is written twice, once here and once in the `test:scripts` script, and a parity test pins that the two lists agree (66-76).
  - The ESLint pass over `scripts/` was removed here because lint.yml's `lint:root` subsumes it (500-510).
- **Cost:** 2 jobs on a matching PR, and 2 again on push to main. `harness` installs and builds harness plus shared.
- **Duplication:**
  - The push-to-main leg re-runs what the PR already proved. It is advisory, so it catches nothing the PR leg missed, except when a skew between PRs goes untested because there is no merge_group leg.
  - The paths list is copied by hand (155-187 against 190-222).

## 7. changelog-fragment-check.yml (`name: changelog-fragment-check`)

- **Triggers:** `pull_request` types `[opened, synchronize, reopened, labeled, unlabeled]`; `merge_group` (54-57).
- **Concurrency:** **none**. A superseded PR push is not cancelled, and label toggles fire extra runs.

| Job                            | if                                                                                                                                               | timeout  | What it runs                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fragment-present`             | none                                                                                                                                             | **none** | checks out the PR head or `github.sha` with `fetch-depth: 0` (70-75); resolves the base (merge_group.base_sha or merge-base, 77-89); `python3 .claude/scripts/__tests__/test_changelog_backfill.py` (100-101); validates with `--validate --changed-only` on both events (117-120); coverage check `--check --pr N` on PRs without `skip-changelog` (135-140); a note step on merge_group (144-154). No node, no install |
| `no-fragment-under-skip-label` | `contains(pull_request.labels.*.name,'skip-changelog')` (189). On merge_group this is false, so the job is skipped and reports skipped (182-188) | **none** | the same checkout and base logic; `git diff --diff-filter=AR` over changelog/unreleased (237-258)                                                                                                                                                                                                                                                                                                                        |

- **Scoping:** label-based and event-based, with step-level `if`s.
- **merge_group:** yes. Both jobs are required (34-35), and the second one satisfies the requirement by being skipped.
- **Cost:** 1-2 small jobs. Python only, no install.
- **Duplication:** the analyzer's self-test (100-101) runs again on every PR event and on merge_group.

## 8. operating-skills-version-check.yml

- **Triggers:** `pull_request`, `merge_group` (90-92). No paths filter, on purpose (54-60).
- **Concurrency:** **none**.

| Job                     | timeout  | What it runs                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version-outranks-base` | **none** | env PACK_FILE/SKILLS_DIR (102-106); checkout with `fetch-depth: 0` (115-118); resolves the fork point and base tip, using `merge_group.base_sha` in the queue (141-157); `scripts/seeded-pack-changed.sh <fork_point>`, falling back to the base tip's copy if absent (196-213); on `changed`, it compares the version with base (220-247) and requires a History entry (254-262) |

- **Scoping:** inside the job, at step level. On a PR that does not touch the pack, the cost is one checkout (58-60).
  - `scripts/seeded-pack-changed.sh` prints `changed` or `unchanged` from a diff of pack.ts that ignores comment and blank lines, plus a byte-granular diff of the skills dir. It exits 2 if git cannot answer (header 1-66).
- **merge_group:** yes. It is required (49-50).
- **Header notes:** it depends on merge_group to close the DOR-509 race. The earlier guarantor was `strict` "up to date" (30-52).
- **Cost:** 1 job, checkout only. It is cheap, but `fetch-depth: 0` means it pulls the full history.

## 9. docs-openapi-check.yml

- **Triggers:** `pull_request`, `merge_group` (51-53). The paths filter and the push leg were removed (38-42).
- **Concurrency:** `docs-openapi-check-${{ github.ref }}`, cancel only on PR (64-66).

| Job             | timeout  | What it runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openapi-fresh` | **none** | checkout with `fetch-depth: 0` (81-83); scope step: merge_group always true, PR greps the diff for `apps/server/src/`, `packages/shared/src/`, `docs/api/`, the two generator scripts and the workflow (95-119). Every later step is gated on `run == 'true'`: pnpm setup, setup-node **22**, install (124-135), `turbo build --filter="./packages/*"` (141-143), `pnpm docs:export-api` (145-147), `pnpm --filter=@dorkos/site generate:api-docs` (151-153), then `git add -A docs/api` and a diff check (158-166) |

- **Scoping:** inside the job, and the scope step runs **before** the install. This is the cheapest skip shape in the set.
- **merge_group:** yes. It is NOT required (44-49).
- **Cost:** 1 job. When it runs, it installs and builds all of packages/*, about 4 min (86). Because the regex includes `apps/server/src/` and `packages/shared/src/`, most code PRs trigger it.
- **Inconsistency:** it uses Node 22 while the other install-and-build jobs use 24. `scripts-test` also uses 22.

## 10. db-check.yml

- **Triggers:** `push: branches [main]` (84-85), `pull_request`, `merge_group` (86-87). No paths filter, on purpose (55-67).
- **Concurrency:** `db-check-${{ push ? sha : ref }}`, cancel only on PR (96-98).

| Job        | timeout  | What it runs                                                                                                                                                                                                                                                                                 |
| ---------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db-check` | 10 (110) | install (121); `scripts/assert-migrations-current.sh` for packages/db (130-131); the same script for apps/site's public and control-plane configs (145-149). It runs `pnpm exec drizzle-kit generate` and judges the printed output (scripts/assert-migrations-current.sh:115-189). No build |

- **merge_group:** yes. It has been required since 2026-08-01 (69-73).
- **Header notes:**
  - drizzle-kit exits 0 when it refuses to run without a TTY.
  - A `pnpm --filter` that matches nothing also exits 0. Both are closed by the script (16-53).
- **Duplication:** **the push-to-main leg is still here.** Every other required check dropped theirs because the queue already tested the same tree (test.yml:169-173, typecheck.yml:69-74, lint.yml:75-82). The concurrency comment (94-95) cites typecheck.yml's push-by-SHA reasoning, but typecheck no longer has a push leg.
- **Cost:** 1 job per event, 3 events per merged PR (PR, queue, push). It installs but does not build. It runs in under a minute (63).

## 11. credential-free-build.yml

- **Triggers:** `pull_request`, `merge_group` (258-260). No paths filter, and a test pins that (110-118).
- **Concurrency:** `credential-free-build-${{ github.ref }}`, cancel only on PR (288-290).

| Job                     | timeout       | What it runs (all `run:` steps go through `scripts/run-credential-free.sh`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `credential-free-build` | **110** (352) | env `NODE_OPTIONS=--max-old-space-size=8192`, `DORKOS_PORT=4242` (353-362); checkout with `fetch-depth: 0` (368-370); `actions/cache/restore` on `.turbo/cache`, keyed `turbo-credential-free-OS-hash(lockfile)-sha` with a prefix restore key (442-448); `--print` (457-458); scrubbed install (463-464); `turbo build typecheck lint --affected --continue --concurrency=4` with TURBO_SCM_BASE set to merge_group.base_sha or pull_request.base.sha (495-498); `turbo test --affected --continue --concurrency=2 -- --run` with `VITEST_MAX_WORKERS=2` (573-578); `turbo build --filter=dorkos` (594-595); `scripts/credential-free-smoke.sh`, which boots the server and probes `/api/health` (597-598); `actions/cache/save` on `always() && pull_request` (645-650) |

- **Scoping:** turbo `--affected` against a SHA base on both events. In the queue the base is the group's `base_sha`, so the set covers every PR in the group (56-100). The boot probe always runs (102-108). There is no `if:` on any step.
- **merge_group:** yes.
- **Required status is contradictory in the file:**
  - 120-128 says "IT IS NOT A REQUIRED CHECK YET".
  - 217-218 says "`credential-free-build` IS A REQUIRED CONTEXT".
  - 283-285 refers back to "not required".
- **Header notes:**
  - It went red on runs killed by "runner shutdown" or a bare `Killed`. The suspected cause is oversubscription (15 × 8 GB heaps), which is why it now uses `--concurrency=4` and the cache. No cause is claimed (130-189).
  - On the serial cold path, a change under `packages/shared` expands to 20 of 25 packages, and the test step alone took 40m53s. That is why the timeout went from 50 to 110 and concurrency to 2 (191-213).
  - The sharding follow-up is scoped (215-252).
  - Queue runs are cold by construction. The cache scope is the `gh-readonly-queue` ref, and nothing writes main's scope (419-441).
  - Queue runs get **killed when the queue tears down the ref** once the required checks pass (273-287).
  - It deliberately skips `lint:root` and Playwright (254-257).
- **Scripts:**
  - `scripts/run-credential-free.sh` unsets hosted variable families by glob pattern (DORKOS_CLOUD__, DORKOS_MANAGED__, and so on), then execs. It keeps PATH/HOME/CI/NODE__/TURBO__/GITHUB_* (header 1-60).
  - `scripts/credential-free-smoke.sh` boots the built CLI with a throwaway DORK_HOME and probes `localhost/api/health`.
- **Cost:**
  - 1 job, but the longest in the set: 2 min on trivial changes, over 40 min on a shared change.
  - On the queue it is always cold. It is not required, so it is often cancelled mid-run when the batch merges, and those runner-minutes buy nothing.
- **Duplication:** `build typecheck lint` and `test` over the affected set re-do work that test.yml, typecheck.yml and lint.yml already do in the same event. The header concedes that turbo strict env mode strips most hosted variables anyway (77-85).

## 12. cli-smoke-test.yml (`name: CLI Smoke Test`)

- **Triggers:**
  - `push: branches [main]` with **no paths filter** (4-5).
  - `pull_request` with `paths:` packages/cli/**, packages/shared/**, apps/server/**, apps/client/**, Dockerfile, .dockerignore, scripts/smoke-test.sh, pnpm-lock.yaml and the workflow file (6-18).
  - `workflow_dispatch` (19).
  - **No merge_group.**
- **Concurrency:** `cli-smoke-${{ push ? sha : ref }}`, cancel only on PR (29-31).

| Job (context)                                  | needs         | timeout  | What it runs                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | ------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build-tarball`                                | none          | 15 (45)  | install (56); `pnpm --filter=dorkos run build` (58-59), which itself runs `pnpm turbo build --filter=@dorkos/client` (packages/cli/scripts/build.ts:223) and then esbuild; `pnpm pack` (61-66); uploads `cli-tarball` with 1-day retention (68-72)              |
| `smoke-test-bare (22)`, `smoke-test-bare (24)` | build-tarball | 10 (78)  | setup-node with the matrix version, no pnpm (80-85); apt install of python3 and build-essential with hardening (92-113); downloads the tarball; mocks `claude`; `npm install -g`; runs `--version`, `--help`, `--post-install-check` and `init --yes` (115-141) |
| `smoke-test-docker`                            | build-tarball | 15 (147) | sparse checkout; download; `docker build --target smoke`; `docker run` (149-163)                                                                                                                                                                                |
| `integration-test`                             | build-tarball | 10 (169) | sparse checkout including scripts/smoke-test.sh; download; `docker build --target integration`; run (171-186)                                                                                                                                                   |

- **Scoping:** a workflow-level `paths:` filter on PRs, so the check does not report there when nothing matches. Push-to-main is unfiltered, so all 5 jobs run on every merge.
- **merge_group:** no. It can never be required.
- **Cost:** 5 jobs per trigger. 1 install and CLI build, then 4 downstream jobs, each spinning up its own runner (2 do apt work, 2 build Docker images).
- **Duplication and serial chain:**
  - The push-to-main run cannot gate anything. It repeats the PR run, or runs for the first time on changes the PR filter excluded.
  - `build-tarball → 4 consumers` is a necessary serial link.
  - The two Docker jobs could share one runner, and so could the two bare legs.
  - credential-free-build already builds the `dorkos` CLI and boots the server on every PR and queue run.

---

## Jobs per event (runner jobs actually started)

| Workflow                       | pull_request                       | merge_group                           | push main          |
| ------------------------------ | ---------------------------------- | ------------------------------------- | ------------------ |
| test                           | 6 (community-pg, 4 shards, fan-in) | 6                                     | 0                  |
| browser-test                   | 2 (fan-in echo, copy-spec-drift)   | 5 (3 shards, fan-in, copy-spec-drift) | 0                  |
| typecheck                      | 1                                  | 1                                     | 0                  |
| lint                           | 1                                  | 1                                     | 0                  |
| site-build                     | 1                                  | 1                                     | 0                  |
| scripts-test                   | 0 or 2 (paths)                     | 0                                     | 0 or 2 (paths)     |
| changelog-fragment-check       | 1-2 (more on label events)         | 1 (+1 skipped)                        | 0                  |
| operating-skills-version-check | 1                                  | 1                                     | 0                  |
| docs-openapi-check             | 1                                  | 1                                     | 0                  |
| db-check                       | 1                                  | 1                                     | **1**              |
| credential-free-build          | 1                                  | 1                                     | 0                  |
| CLI Smoke Test                 | 0 or 5 (paths)                     | 0                                     | **5 (unfiltered)** |
| **Total**                      | ~16-23                             | **~19**                               | 6-8                |

A single merge group starts about 19 jobs. Against the Free-plan cap of 20 concurrent hosted jobs (browser-test.yml:22), one queue entry nearly fills the pool. PR runs from other branches then queue behind it.

`pnpm install` count per merge group: community-pg, 4 test shards, 3 browser shards, copy-spec-drift, typecheck, lint, site-build, openapi-fresh, db-check and credential-free, which is **14 installs**. On a typical code PR: community-pg, 4 shards, copy-spec-drift, typecheck, lint, site-build, db-check, credential-free, plus openapi-fresh, harness and cli build-tarball when scoped in, which is **11-14 installs**.

## Same work run more than once

1. **Every PR pays for typecheck and lint twice at full price.** Both run full monorepo on `pull_request` and again on `merge_group` (typecheck.yml:114-121, lint.yml:83-85). test.yml's own argument (138-150) says the PR leg only needs to be the cheapest honest signal, and test and credential-free use `--affected` on PRs. typecheck and lint do not.
2. **Tests run twice per event.** test.yml's shards run affected on PRs and full in the queue. credential-free-build runs `turbo test --affected` on both events, unsharded at `--concurrency=2`. In the queue its affected set covers the whole group, so for a shared change the same 20 packages' suites execute in both workflows. The same applies to typecheck and lint, where credential-free runs `build typecheck lint --affected` alongside the full typecheck.yml and lint.yml.
3. **`^build` of server, client and shared repeats across jobs.** Per merge group: 4 test shards, 3 browser shards, typecheck, site-build (the site closure includes shared), openapi-fresh (packages/*), credential-free (affected plus the CLI, which builds the client) and community-pg (cloud-api and shared). That is **~11-12 independent cold builds of @dorkos/shared** and ~9 of server and client. There is no remote cache and no build-artifact hand-off. Only credential-free has a local cache, and in the queue it is cold (credential-free-build.yml:425-427).
4. **`generate:api-docs` runs twice in the queue**: openapi-fresh (docs-openapi-check.yml:151-153) and site-build, through `build`'s dependsOn (turbo.json).
5. **CLI build plus server boot runs twice.** It happens in credential-free-build (594-598) and in cli-smoke build-tarball and its smoke jobs (PR and push-main).
6. **Push-to-main leftovers:** db-check (84-85, required and already queue-tested), CLI Smoke Test (4-5, unfiltered, 5 jobs) and scripts-test (188-222). None can gate a merge.
7. **Playwright Chromium is installed in two places with different caching.** browser-shard caches it (316-321). community-pg does not (test.yml:229-230) and runs on every PR and every queue run.
8. **copy-spec-drift re-runs on merge_group** with a full install (browser-test.yml:627-669). It is not required, and its value is as a PR-time signal (603-607).

## Serial chains and setup that could be parallel or shared

- **credential-free-build is one long serial job** (install, then build+typecheck+lint, then test, then CLI build, then boot). The header already specs a sharded fan-in shape (215-252). The test step could start alongside typecheck and lint instead of after them.
- **test.yml fan-in `needs: [test-shard, community-pg]`** is parallel fan-in, which is fine. But community-pg's 15-min Postgres and Playwright path now sits on the required `test` critical path, even for PRs that do not touch community.
- **cli-smoke `build-tarball` feeds 4 jobs.** The chain is necessary, but 4 extra runner spin-ups could be 1-2.
- **site-build installs before deciding to skip** (137 before 176). openapi-fresh decides before installing (95 before 124-135). The site-build scope needs turbo for `--dry=json`, so a no-install `git diff` pre-check could skip the install on most PRs.
- **Setup is duplicated:** each of the ~14 install jobs repeats checkout, pnpm setup, setup-node with the pnpm store cache, and `pnpm install --frozen-lockfile`. No composite action or reusable workflow exists. Every file inlines the same 4 steps.

## Hygiene gaps spotted

- **No `timeout-minutes`** (so the default is 360): scripts-test `fixtures` and `harness`, changelog `fragment-present` and `no-fragment-under-skip-label`, `version-outranks-base`, `openapi-fresh`.
- **No concurrency block:** changelog-fragment-check and operating-skills-version-check. Superseded PR runs are not cancelled, and label events add runs.
- **Node version drift:** docs-openapi-check and scripts-test use Node 22. The rest use 24.
- **Stale or contradictory comments:**
  - credential-free-build.yml:218 says it is required, against 120.
  - test.yml's header and fan-in comment say "runs no tests" and "pure fan-in" but predate `community-pg`.
  - db-check.yml:94-95 cites a push-by-SHA rationale borrowed from typecheck, which has since dropped push.
- **Base-ref inconsistency:** site-build and docs-openapi scope against `origin/<base_ref>` (a ref resolved at checkout). test and credential-free pin `pull_request.base.sha`, and test.yml:363-375 argues for the SHA.
