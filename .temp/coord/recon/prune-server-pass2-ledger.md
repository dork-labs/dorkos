# Server second pass: task preset tests

- Branch: codex/prune-tests-server. Batch base: **10d98b6cd8**. Original baseline: **6fccd4873b**.
- Scope: apps/server/src/services/tasks/__tests__/task-presets.test.ts.
- File before / after: **297 / 225 physical lines**.
- Server before / after: **879,238 / 879,166 physical test lines**. Batch removed: **72**. Cumulative server removal: **100**.
- Cases deleted: **8**. Files deleted: **0**. Server test files: **2,568**, unchanged.
- Every deleted test has a row below; 71 lines are recorded case blocks/separators and one is an orphan blank separator.
- Production code, dependency files and paid-test flags: unchanged. No push or PR.

## Coordinator exclusions and protected classes

The November 12 18:30 CT do-not-touch list is unchanged. Tasks is outside its exclusions. No schema, security/auth/permission, migration/upgrade, real-bug regression, contract/conformance or scripts guard case is deleted. The dependency-audit preset test is conservatively retained. Tests of public loading/writing behavior remain; only fixed getter assertions, a redundant identity check, and two call-only duplicates are removed.

## Deletions

| File | Test | Reason | Lines | Surviving checks |
| --- | --- | --- | ---: | --- |
| `apps/server/src/services/tasks/__tests__/task-presets.test.ts` | returns 4 default presets | trivial | 5 | Static factory inventory count; mutation isolation still checks the untouched default count, and missing-file fallback/written JSON tests remain. |
| `apps/server/src/services/tasks/__tests__/task-presets.test.ts` | returns presets with required fields | trivial | 13 | Only checks compiler-declared fields of fixed TaskPreset data and the literal UTC default; retain all preset loading/writing behavior and default JSON content checks. |
| `apps/server/src/services/tasks/__tests__/task-presets.test.ts` | includes health-check preset | trivial | 8 | Pins a static preset id, cron and category; keep unique IDs, cron shape, nonempty prompts, missing-file defaults and serialized default equality. |
| `apps/server/src/services/tasks/__tests__/task-presets.test.ts` | includes docs-sync preset | trivial | 8 | Pins a static preset id, cron and category; keep unique IDs, cron shape, nonempty prompts, missing-file defaults and serialized default equality. |
| `apps/server/src/services/tasks/__tests__/task-presets.test.ts` | includes code-review preset | trivial | 8 | Pins a static preset id, cron and category; keep unique IDs, cron shape, nonempty prompts, missing-file defaults and serialized default equality. |
| `apps/server/src/services/tasks/__tests__/task-presets.test.ts` | returns a copy (not a reference) | duplicate-of mutations to returned array do not affect future calls | 7 | The retained test mutates one returned array then checks a fresh call, proving copy isolation by its actual consequence. |
| `apps/server/src/services/tasks/__tests__/task-presets.test.ts` | creates tasks/ subdirectory with recursive flag | mock-only / duplicate-of creates default presets when file does not exist | 12 | The retained creation case asserts the same mkdir recursive flag and joined tasks path while checking serialized output; only the arbitrary dorkHome string differs, with no different production branch. |
| `apps/server/src/services/tasks/__tests__/task-presets.test.ts` | reads from correct path under dorkHome | mock-only / duplicate-of loads presets from JSON file | 10 | The retained load case checks the same joined presets path and UTF-8 encoding and verifies the decoded return value; only the arbitrary dorkHome string differs, with no different production branch. |

## Retained evidence

- getDefaultPresets: real mutation of the returned array cannot change future calls; every ID stays unique; cron strings retain five fields; prompts are nonempty.
- loadPresets: real decoding/return values for JSON arrays, missing files, malformed JSON, non-array JSON, read errors, empty content and null remain. The retained valid-load test also asserts the actual joined read path and encoding.
- ensureDefaultPresets: missing-file creation checks mkdir's path/recursive flag and write path/encoding plus parsed JSON; the full serialized defaults are checked independently. Existing data and non-ENOENT failures still prohibit overwriting.
- Source inspection: getDefaultPresets is a shallow copy of a typed fixed array. The custom-path call-only duplicates add no different branch to the straight path.join helper. No format or overwrite rule is removed.

## Wider screen and unsure list — all retained

The read-only AST screen produced 145 call-assertion-only candidates across 38 files after path/header exclusions. These are candidates, never deletion approvals. Most remain unreviewed or retained because observing a callback is how a real effect is tested. The raw candidate list is server-mock-only-candidates.json beside this ledger; it is not a coverage result.

- Task/store/relay persistence tests: even calls-only checks can protect atomic rename, no-overwrite or disk layout. Retained.
- TaskFileWatcher error-log tests: diagnosis, suppression per error code and watcher recovery carry regression value. Retained.
- TodoDueTimers and shutdown-signal callback assertions observe real deadlines or a process boundary. Retained.
- RuntimeCache, plugin reload/cache-impact and OpenCode runtime cases involve MCP server state or runtime contracts; excluded or retained.
- MarketplaceInstaller dispatch tests: a mocked flow may still be the only assertion distinguishing a package-type dispatch; no surviving same-input real result was established. Retained.
- AdapterManager: starting/stopping connections, safety timeouts, bindings and recovery remain; no call-count-only deletion is inferred from the scan.
- Room-context inline snapshot: contains trusted/untrusted fences and turn markers; protected security content, retained.
- TaskRegistrar and TaskStore: real cron registration and database behavior; retained.
- DOE presets: endpoint/header declarations are model-service contracts/auth behavior, retained.

This batch is below the requested 2–5k grouping size. No reviewed evidence justifies padding it by dropping unique timer/persistence behavior or protected classes. The full server semantic audit and the programme's 40% reduction remain open; the next useful input is the bounded coverage/mutation calibration, not a higher deletion quota.

## Verification

Counts use the same rg file globs and bytes.splitlines() convention as the first ledger. Fresh source reconstruction passed: precisely the eight recorded deletions plus one blank cleanup, no other tracked edits. node --check and git diff --check exited 0. Host load 7.23 is below the coordinator ceiling of 24. Normal commit hooks are next. Vitest/coverage/mutation execution remains assigned to the verifier; no passing-suite claim is made here.
