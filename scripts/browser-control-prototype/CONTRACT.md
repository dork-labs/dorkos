# Prototype module contract

This experiment uses fictitious fixture identities only. Never put page state,
action text, credentials, raw URLs, console messages or network bodies in evidence.
Receipt fields are allowlisted; known credential and URL patterns are refused.
Pattern filtering cannot identify every possible secret in a free-text limitation
or command. Review those human-written fields before sharing a report. Screenshots
must show only the fake fixture.

## Ownership

- `contracts.mjs`, `runtime.mjs`, `evidence.mjs`, and their tests: task 1.1.
- `fixture.mjs` and state probes: task 1.2.
- `manager.mjs` and reservations: task 1.3.
- `control.mjs` and participant capabilities: task 1.4.
- Viewer files: task 2.1. Gate runners belong to their respective evidence tasks.

Each writer works in a separate worktree. The parent integrates commits and owns
specification, tracker, independent review, PR, merge and cleanup. The requested
GPT-6.1 Sol / Medium selection overrides Flow's tiers for this run.

## Runtime

```js
const { chromium, receipt, launchOptions } = await loadPlaywright({ repoRoot });
const context = await chromium.launchPersistentContext(profileDir, launchOptions);
```

`repoRoot`, `profileDir`, fixture storage and artifact directories are explicitly
injected. The loader resolves `playwright-core` through `apps/e2e`'s installed
`@playwright/test` dependency and requires 1.63.0 by default. It hashes the actual
executable, records its Chromium revision and OS, and returns launch options
pinning that exact file. Use these options even for headless launches: Playwright's
default headless launch can choose a separate headless-shell executable.

An absent dependency, incompatible version or missing executable throws
`RuntimeUnavailableError` with a fixed `code`. No loader or action downloads a
browser. An explicit install is a separate operator step. No raw CDP listener is
opened. A future version with Chromium revision overrides is refused until its
platform-specific revision can be recorded accurately.

```sh
pnpm install --frozen-lockfile
node scripts/browser-control-prototype/runtime.mjs .
node scripts/browser-control-prototype/runtime.mjs . --local
node --test scripts/browser-control-prototype/__tests__/*.test.mjs
```

Default runtime output redacts the executable path. `--local` preserves the exact
absolute path for local executable observation; do not copy that output into a
public report. An unavailable runtime exits nonzero with `status: unverified`.

## Receipt shapes

Every validator returns its input after validating it. Objects have exactly the
listed fields. Arrays must be dense ordinary arrays with data entries; holes,
accessors and extra properties are refused. IDs are bounded simple identifiers; navigation starts at zero,
viewport versions and capture sequences at one, and epochs at zero. Profiles,
browser contexts/processes, tabs, viewers and actors are separate identities.

| Kind      | Fields after `kind`                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runtime` | `libraryVersion`, `chromiumRevision`, `executablePath`, `executableSha256`, `os: {platform, release, arch}`                                                  |
| `action`  | `requestId`, `tabId`, `navigationGeneration`, `viewportVersion`, `actorId`, `epoch`, `outcome`                                                               |
| `frame`   | `browserId`, `tabId`, `navigationGeneration`, `viewportVersion`, `epoch`, `captureSequence`, `width`, `height`, `byteLength`                                 |
| `gate`    | `gateId`, `status`, `subjectIds`, `sampleCount`, `baseline`, `negativeControls`, `command`, `timings`, `artifacts`, `limitations`, `measurements`, `runtime` |

Action outcomes are `completed`, `rejected`, `failed`, `aborted`, `in-flight`.
Do not report an in-flight operation as undone. Frames are bounded to 2 MiB.
`LIMITS` also exports one pending frame, 16 KiB action payload and 2-second barrier
bounds; the owning control/viewer modules must enforce those operational bounds.
Validating a receipt alone does not enforce scheduling or frame backpressure.

Gate status is `pass`, `fail` or `unverified`. Subjects must be nonempty and unique.
A pass/fail requires a positive sample count. A pass additionally requires a
passing baseline and at least one negative control, all detected. Missing native
observations remain unverified with a limitation; no skipped observation passes.

- `baseline`: `{status, sampleCount}`.
- `negativeControls`: `[{id, outcome, sampleCount}]`, where outcome is `detected`,
  `missed` or `unverified`. Detected/missed controls require observations.
- `timings`: `{startedAt: ISO-8601 UTC string, durationMs}`.
- `artifacts`: relative screenshot/receipt paths; no absolute/traversal paths or
  profile/storage-state/cookie artifacts.
- `limitations`: bounded human-reviewed strings.
- `measurements`: `[{name, unit, sampleCount, min, max, p50, p95}]`, ordered
  distributions with positive sample counts. Units: `ms`, `bytes`, `bytes/s`,
  `MiB`, `percent`, `count`.
- `runtime`: full local runtime receipt, or `null` only for an unverified gate
  whose runtime could not be resolved.

`serializeEvidence(receipt)` validates before serializing, bounds output to
64 KiB and redacts runtime executable paths without mutating the source receipt.
Public JSON is a report projection, not a local runtime/gate object: its redacted
path intentionally fails the local executable-path validator. Aggregate validated
local objects before public serialization; do not feed public JSON back into
local gate validation.
`serializeEvidence(receipt, {publicReport:false})` keeps the local executable path.
`writeGateReceipt({artifactDir, name, receipt})` writes public JSON exclusively with
mode 0600 into the injected directory. Names are simple `.json` filenames; an
existing receipt is never silently overwritten. Keep the artifact directory
separate from browser profiles and outside tracked source.
