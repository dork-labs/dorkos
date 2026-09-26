# Audit delivery verification

Recorded 2026-09-26 on macOS at source baseline `7168a5b7c69def16bb2cb48319b24285c9894a3f`. Documentation is the only tracked change. These runs credit existing executable evidence; they do not test the proposed future disposal API.

## Local checks

- `pnpm install --frozen-lockfile`: completed without lockfile changes.
- `pnpm --filter @dorkos/server... build`: exit 0. Builds existing dependencies for local tests; no deployment or billable service.
- First targeted run: **16 suites, 397 tests passed**, exit 0.
- Uninstall/classification run: **3 suites, 79 tests passed**, exit 0.
- Both diagnostic fixtures: exit 0; exact code and results are [preserved here](../../research/20260926-marketplace-retained-copy-reproduction.md). They prove local scanner/copy behavior, not native harness execution or an approval bypass.

The first invocation also supplied two misordered uninstall paths, which selected no extra files. Those omissions were noticed and corrected in the second run below. The first command is shown with only its 16 actual selected suites so it is directly reproducible.

```sh
pnpm vitest run \
  apps/server/src/services/marketplace/__tests__/transaction.test.ts \
  apps/server/src/services/marketplace/__tests__/install-recovery.test.ts \
  apps/server/src/services/marketplace/__tests__/install-recovery-ownership.test.ts \
  apps/server/src/services/marketplace/__tests__/transaction-concurrency.test.ts \
  apps/server/src/services/marketplace/__tests__/transaction-ownership.test.ts \
  apps/server/src/services/marketplace/__tests__/ownership-flows.test.ts \
  apps/server/src/services/marketplace/__tests__/failure-paths.test.ts \
  apps/server/src/services/marketplace/__tests__/backup-janitor.test.ts \
  apps/server/src/services/marketplace/lib/__tests__/uninstall-journal.test.ts \
  apps/server/src/services/session/__tests__/session-list-broadcaster.test.ts \
  apps/server/src/services/session/__tests__/session-list-broadcaster-asks.test.ts \
  apps/server/src/services/search/__tests__/search-indexer.test.ts \
  apps/server/src/services/search/__tests__/sweep-guard.test.ts \
  apps/server/src/services/tasks/__tests__/task-scheduler-service.test.ts \
  apps/server/src/services/harness/__tests__/skills-watcher.test.ts \
  apps/server/src/services/marketplace/__tests__/package-cache-retention.test.ts

pnpm vitest run \
  apps/server/src/services/marketplace/__tests__/flows/uninstall.test.ts \
  apps/server/src/services/marketplace/__tests__/flows/uninstall-in-place.test.ts \
  apps/server/src/services/marketplace/lib/integrity/__tests__/strict-record.test.ts
```

No full-server restart, new SIGKILL exercise, Windows recovery proof, live agent turn, Cloud/Community verification or CI configuration change was performed. Historical process-kill evidence is credited separately in the recovery matrix. No generic recovery suite was added.

## Design completion boundary

The ownership map and pilot are specified, not implemented. DOR-2428 owns future local implementation; DOR-2429 owns separately selected central-adoption design. DOR-2340 and DOR-2341 retain their existing records with deferred approval/ownership decisions. DOR-2349 remains open beyond its local DOR-2427 slice.

Independent review and merged PR evidence are attached to DOR-2347 and DOR-2427 at closeout. A green docs-only PR check does not substitute for the explicit local test results above.
