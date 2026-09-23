# Tasks: Check and apply updates across every installed package in one request

Spec: `specs/marketplace-update-all/02-specification.md` · generated from `03-tasks.json`

## P1 — One scan and the per-installation flow

### Task 1.1: Share mapWithConcurrency from @dorkos/shared

**Size:** small · **Depends on:** none · **Parallel with:** 1.2

Move the private `mapWithConcurrency` out of `apps/server/src/services/session/agent-session-fanout.ts` into a shared module (later undone: the server-wide semaphore replaced it). The fan-out imports it. Test `packages/shared/src/__tests__/map-with-concurrency.test.ts`: results come back in input order; never more than `width` calls in flight (count them with deferred promises); an empty input resolves `[]` without calling `fn`.

### Task 1.2: Scanner yields InstallationRecord once per installation

**Size:** medium · **Depends on:** none · **Parallel with:** 1.1

In `installed-scanner.ts`, add `InstallationRecord { package: InstalledPackage; kind: InstallRootDir; declaredVersion?: string; metadata: InstallMetadata | null }`, `InstallationView = { projectPath: string } | { agents: AgentScopeRef[] }`, and `scanInstallationRecords(dorkHome, view)`. `{ agents }` gives the global roots (scope `global`), then each agent's project (deduped by path, `agent-local`, or `override` when the same installKey is global), sorted by agent name, carrying agentPath/agentId/agentName. `{ projectPath }` gives the merged view: global first, then project entries overriding the same installKey (`override`) or added (`agent-local`), with `agentPath: projectPath`. The walk (`scanScopeRoot`) reads each record once: identity through `readInstalledIdentity`, sidecar through `readInstallMetadata`. `scanInstalledPackages`, `scanInstallationsAcrossScopes` and `scanAgentLocalInstalls` become `.map(r => r.package)` over it, with unchanged output. Tests: records carry `declaredVersion` (undefined for a CC-only package with no version) and the sidecar; the `{ agents }` and `{ projectPath }` views; the existing scanner tests stay green.

### Task 1.3: UpdateFlow checks records; run applies in the installation's own scope

**Size:** medium · **Depends on:** 1.2 · **Parallel with:** none

In `flows/update.ts`: delete `listInstalled` and `readDirSafe`. Add `checkRecord(record)` (today's `checkOne`, with the name from `updateNameOf(record.package.name, record.package.installPath)`, `declaredVersion` and `metadata` from the record). `run(req)`: `UpdateRequest.name` becomes required. Scan `scanInstallationRecords(dorkHome, req.projectPath ? { projectPath } : { agents: [] })`; among records with that update name, prefer one with `package.agentPath` (project shadows global), else the first; no match → one `notInScope` result. Apply (if `update-available` and there is a request) with `projectPath: match.package.agentPath`, NEVER `req.projectPath`; clear memos in `finally` whenever `apply` was requested. A failing test first: a global-only package applied with `run({ name, apply: true, projectPath })` must call `installer.update` with `projectPath: undefined` (fails on base 3b36e3876). Keep the existing per-package tests green.

### Task 1.4: checkInstallations and selectInstallations

**Size:** large · **Depends on:** 1.1, 1.3 · **Parallel with:** none

Add `InstallationUpdateCheck` (UpdateCheckResult + installPath, type, scope, agentPath?, agentId?, agentName?, applied?: InstallResult, applyError?: string), `InstallationUpdatesRequest { installations; apply? }`, `InstallationUpdatesResult { checks }`, `UPDATE_CHECK_CONCURRENCY = 4`, and `checkInstallations(req)`: check via `mapWithConcurrency(..., UPDATE_CHECK_CONCURRENCY, checkRecord)`, in input order, attaching identity (scope defaults to 'global'). If `apply`: for each `update-available` check with a request, sequentially `installer.update({ ...request, projectPath: record.package.agentPath })` → `applied`; catch → `applyError = message` (logged, continue); `clearMemos()` in `finally`. Add `selectInstallations(records, names?)`: none/empty → all; otherwise keep matches by update name; any unmatched → throw `PackageNotInstalledForUpdateError(unmatched)`. The error takes a string or a string[] (`packageNames`), with the message `Package not installed: a` or `Packages not installed: a, b`. Migrate the name-less `run({})` tests to `checkInstallations` over `scanInstallationRecords(dorkHome, { agents: [] })` through a helper. New tests: identity on every check; the same name in two scopes is two checks; an agent-scope install is checked; advisory never calls update; apply scope global vs agent; a failure is isolated and the memo is cleared; the concurrency cap and order; concurrent same-source checks share one ls-remote, including a failing one; selectInstallations cases. Integration (`integration.test.ts`, real installer): a global install stays global when run with projectPath; a global plus an agent install of one package → two checks, both applied in place, the rerun current; advisory leaves the listing identical.

## P2 — The HTTP door and the wire contract

### Task 2.1: GET and POST /api/marketplace/updates

**Size:** large · **Depends on:** 1.4 · **Parallel with:** 2.2

In `routes/marketplace.ts`: `GET /updates` confines `?projectPath` (403 on boundary), runs one `scanInstallationRecords` (the project view, or `{ agents: listAgentScopes?.() ?? [] }`), then `updateFlow.checkInstallations({ installations })`. `POST /updates` body `{ apply: z.literal(true), names?: string[] (min 1, items min 1), projectPath? }` (400 otherwise); confine; one scan; `selectInstallations` (404); authorize each distinct (name, agentPath) as `marketplace.install` with `{ name, projectPath? }` in the caller's spelling (the requested project's canonical path maps back to the body's), stopping at the first non-allowed: `denied` → gateResponse; `approval_required` → 403 `{ error, code: 'batch_update_needs_approval' }`. Then `checkInstallations({ apply: true })`, and `onPluginsChanged({ projectPath: callerSpelling(check.agentPath), packageName: applied.packageName, action: 'install' })` per applied. Errors go through mapErrorToStatus. Update the router's endpoint TSDoc list. Route tests (fake flow, real registry, a module spy wrapping scanInstallationRecords): the GET all-scopes single scan with no apply; the GET project view is canonical; the GET boundary 403; POST 400 without apply:true; POST 404 unmatched; onPluginsChanged paths for global/project/agent and none for applyError; an agent caller allowed; an approval-requiring registry → 403, nothing run.

### Task 2.2: Wire types and OpenAPI

**Size:** medium · **Depends on:** 1.4 · **Parallel with:** 2.1

`@dorkos/shared/marketplace-schemas`: add `InstallationUpdateCheck` and `InstallationUpdatesResult`, mirroring the server's; update the header's source-of-truth list. `openapi-registry.ts`: `LocalInstallationUpdateCheckSchema` (extends the check schema with identity + applied/applyError), `LocalInstallationUpdatesResultSchema`, and register `GET /api/marketplace/updates` (query projectPath; 200, 403) and `POST /api/marketplace/updates` (body apply literal true, names, projectPath; 200, 400, 403, 404). Test in `export-openapi.test.ts`. Regenerate `docs/api/openapi.json` (`pnpm docs:export-api`) and the API pages (`pnpm --filter @dorkos/site generate:api-docs`). Rebuild shared.

## P3 — The CLI, docs, changelog

### Task 3.1: CLI name-less update is one request

**Size:** medium · **Depends on:** 2.1, 2.2 · **Parallel with:** none

`packages/cli/src/commands/update.ts`: import types from `@dorkos/shared/marketplace-schemas` and delete the local mirrors. Named: unchanged. Name-less: advisory `GET /api/marketplace/updates[?projectPath=]`, apply `POST /api/marketplace/updates { apply: true, projectPath? }`; any error → stderr + exit 1. Label non-global lines `name [agentName ?? agentPath]`. `Applied:` lists checks with applied; `Could not update:` lists applyError lines; exit 1 on any applyError. Delete listTargets/couldNotCheck for name-less. Update the module TSDoc. Tests in `packages/cli/src/__tests__/update.test.ts`: one GET (projectPath query); one POST body; labels; sections; exit codes; named still per-package; the old per-target tests are replaced.

### Task 3.2: Docs, changelog, implementation record

**Size:** small · **Depends on:** 3.1 · **Parallel with:** none

`contributing/marketplace-installs.md` update-flow section (the two doors, one scan, the per-installation result keyed by installPath, concurrency/order, apply scope + isolation, batch authorization). `docs/marketplace/index.mdx` + `docs/guides/cli-usage.mdx` (the place label; `--apply --project` keeps a global package global). A changelog fragment in `changelog/unreleased/` (plain words; fold any hook stubs). `04-implementation.md`. Manifest status implemented at the end.
