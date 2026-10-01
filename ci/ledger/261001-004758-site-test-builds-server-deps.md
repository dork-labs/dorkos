---
id: 261001-004758
title: The site's tests build the packages the server code they load needs
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.test.test-shard
prs: [2424]
hypothesis:
  metric: 'gate.wf.test.test-shard.failure_rate@pull_request'
  baseline: 0.036
  baseline_source: 'origin/ci-steward-data snapshots/2026-09-29.json, gate wf.test.test-shard@pull_request: 596 runs, 487 success, 18 failure, 91 cancelled (18 / 505 decided runs)'
  target: 0.036
  after_days: 14
ratchet-release: []
field-changes: []
---

A pull request that changes only `apps/site` went red twice on `test-shard (2/4)`. The site's
`managed-mounted-isolation.integration.test.ts` loads the server's
`services/connectors/__tests__/helpers/managed-local-protocol.ts` from source, and that file reaches
`@dorkos/relay` (through `core/auth/cloud-link.ts` and on to `session/asks/ask-entitlement.ts`) and
`@dorkos/extension-api` (through the Claude Code runtime and `marketplace/preview/permission-preview.ts`).
Both packages resolve to `dist/`. Neither is a dependency of the site, so on `pull_request`, where
the shards run `turbo test --affected`, nothing built them and the test failed with "Failed to
resolve entry for package". Pull requests that also touched a package depending on them passed,
because that package's build was in the graph.

The change adds a `@dorkos/site#test` task to `turbo.json` that depends on `^build` as before plus
`@dorkos/relay#build` and `@dorkos/extension-api#build`. The server's other workspace dependencies
resolve to source and need no build. A dependency declared in the site's `package.json` was tried
first and dropped: it re-resolved the site's `next` with a different peer set in the lockfile, and
would add both builds to every site deploy.

Reproduced locally: with both `dist/` folders removed, `turbo run test --filter=@dorkos/site` on
that file fails with the same error; with this change it builds both packages first and passes.

Why this metric: the defect only shows on site-only pull requests, so the shard failure rate should
not get worse and the site-only reds should stop. Revert if a site test run fails because of either
build, or if the extra builds push a shard past its ceiling (not expected: both are small `tsc`
builds and turbo caches them).
