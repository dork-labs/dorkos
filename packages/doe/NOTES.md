# Developer notes

This records the package boundaries and offline fixture coverage. Verification commands are listed below.

## Transport boundary

`pi-engine.ts` is the Pi runtime boundary. Public schemas and durable messages use JSON contracts. No DorkOS product runtime package is imported. Constructing `Doe`, resources, registries or MCP configurations makes no external request. Credentials resolve only on an explicit model request.

Pi core, AI and MCP are pinned to 1.0.4; TypeBox is pinned to 1.3.27. `AgentOptions.streamFn` is required. Doe uses explicit `.api/*.lazy` transport imports, core queues, awaited event listeners, `prepareRequest` before every model request, and `finishTurn` after the complete tool batch. SDK retries are disabled with `maxRetries:0`; retries and compatible fallbacks are explicit host choices. Authentication, quota, cancellation and observable effects prevent replay.

The three protocol fixtures exercise actual loopback HTTP requests through the installed SDKs:

| Protocol             | Offline evidence                                                                     |
| -------------------- | ------------------------------------------------------------------------------------ |
| `anthropic-messages` | Text, thinking signatures, tool exchange, reported usage and missing-usage refusal   |
| `openai-completions` | Text, thinking, complete tool exchange, refreshed schemas, reported and absent usage |
| `openai-responses`   | Text, encrypted reasoning fields, complete tool exchange, reported and absent usage  |

These are protocol compatibility checks, not live vendor-account checks. The intentionally malformed Anthropic missing-usage fixture ends as an error because the SDK expects the protocol's usage object. Doe retains absent counts and cost as absent even on that error. Pi's initialized zero counters do not establish actual provider usage.

The workspace overrides the Anthropic SDK version. The external packed consumer resolves its own production dependency graph, and its wire checks exercise those SDK versions. Its cold-import check traps network, subprocess and ambient vendor-authentication reads.

Credentials are explicit callbacks, never ambient fallbacks. Missing required credentials and recognized Anthropic subscription tokens are refused before vendor authentication discovery. An explicitly unauthenticated local descriptor uses `requiresCredentials:false`. Known supplied credentials are redacted from generated text, thinking, tool output, errors, outward events and durable generated records, including split stream deltas. Successful nonsecret opaque fields remain intact. This does not make host-supplied transcript inputs or arbitrary metadata a place to store secrets.

## Durable context and usage

`SqliteModelStore` stores complete JSON records. Sparse arrays, accessors, symbols, nonfinite numbers and properties JSON would discard are refused before sequence advancement. Plain JSON objects, null-prototype objects and a data property named `__proto__` remain valid. Each inserted record uses one serialized snapshot for its durable value and returned value.

Messages, usage, checkpoints and outcomes have stable sequence ordering within each scope. Request IDs are unique across a durable session. Recording identical existing usage is idempotent; reusing its ID with different data, scope or purpose fails. `allUsage()` already includes children, isolated summaries and beats. Do not add their totals again.

Messages and usage append separately. A checkpoint transaction commits its complete snapshot before restored context changes. A failed checkpoint preserves the prior restore boundary; real summary usage recorded before that failure remains durable. Archives never lose original records. The optional current-system snapshot and its original-message sequence anchor preserve effective instructions/schema state across repeated compaction and later updates. Model input applies that owned snapshot once; durable history keeps earlier system records.

Compaction is attached explicitly through `createCompaction({reserveTokens, retainTurns})`. Manual `compact()` loads the same current resource prompt and selected tools as the automatic path. Automatic business compaction runs on main scope only. The host chooses its output reserve; recent complete user turns plus any unfinished turn and crossing tool exchanges remain. Error, abort, length, empty or oversized summaries cannot replace context. Summary requests use separate `summary:` scopes and record their actual request usage even on failure.

Local input estimates use JSON character length divided by four. This is a heuristic, not a token-count upper bound, especially for multilingual text. A measured provider baseline is usable only with matching durable message/checkpoint anchors. Added dialogue and changed instructions/schemas use estimated growth. A changed system fingerprint prevents a pure-provider label even if the serialized length stays equal. Mixed counts are labeled estimated and expose their measured/estimated components. Unknown cost stays absent unless the host supplies explicit rates.

## Session and cancellation ownership

One durable session has one active operation in this process. SQLite identity covers separate facade/store instances for the same canonical database path. A generic store without identity uses shared object identity. Hosts must coordinate separate processes and independently opened custom-store handles.

The facade owns every scoped engine execution it starts. The facade persists successful beat outcomes and emits completion only after that drain; extensions return validated outcomes. Requested cancellation during cleanup prevents new success. Failed model-message/usage writes remain fatal even if a child caller recovers its error. Internal cleanup cancellation does not cancel an otherwise successful parent. Parent completion, cancellation and failure drain those executions before terminal events, promise settlement and lock release. Child accounting and cleanup therefore finish before the host closes SQLite. Untrusted resource, credential, approval and tool callbacks still use cancellation-aware waits; ignoring cancellation does not make the facade wait forever on those callbacks. An injected engine must honor its abort signal and finish its owned work. Hosts own separate MCP connection close calls and isolated executor cleanup.

## Resource and tool limits

Resource roots, agent instructions, memory, context and the five skill source categories come from the host. No home-directory/vendor scan or grant expansion is implied. Skill roots use first-root precedence, explicit namespaces and canonical deduplication. Catalogues contain metadata; bodies load on demand. Disabled model invocation remains enforced. Relative skill resources resolve beside their canonical file, under the same grants.

Nested instructions are loaded before file operations. First writes/edits refuse mutation until those pending instructions enter a subsequent model request. Parent and builder need different resource instances so the child cannot acknowledge the parent's pending instructions.

File tools resolve canonical paths, reject special files, bound reads/output, use literal search and require a unique exact-edit match. Existing/new paths and symlink-parent traversal are grant-checked. These checks do not defend against an adversarial process continually replacing parent directories, and do not create an OS sandbox. Web fetch checks the host URL policy on every redirect and bounds duration, input response bytes and output.

The registry's defaults cap initial schemas at 32,768 bytes, selected schemas at 262,144 bytes, and selected tools at 64. Tool-search results cap at eight. A successful search replaces the deferred selection and keeps initially loaded tools. Selection loads schemas without execution; earlier snapshots are detached. The 1,000-large-schema fixture proves fixed initial size and usable repeated discovery.

## Pinned MCP decision

Pi MCP 1.0.4 supplies the required stdio and Streamable HTTP APIs; no separate SDK fallback is used. Real local fixtures exercise both transports, pagination, result fidelity, progress IDs, cancellation, deadlines and close. Discovery uses bounded individual `tools/list` requests, not aggregate `listTools()`.

Stdio inherits no environment and receives only the host's explicit map. HTTP uses the exact configured endpoint, refuses redirects, and bounds JSON/error/SSE response bytes. Default limits are 10 seconds to connect, 30 seconds per call, 1 MiB per message, 4 MiB discovery, 2,000 tools and 100 pages. Abort or deadline closes the connection, cancels held HTTP work and stops only its owned stdio process group. Create a new connection afterward. Connection construction alone does not discover tools.

## Builder and beat boundaries

Register the builder explicitly. It has a coding prompt, fresh `child:` history, a child-owned resource instance and its own registry. The approved model inherits payer/protocol/history compatibility; recursive builder discovery and execution are refused. Only a bounded final result returns to the parent. Progress and usage retain child scope. Denied host approval prevents a successful builder summary; ordinary tool errors may recover after correction.

Shell is builder-only. Native unrestricted shell uses POSIX process groups and only an explicit environment. It bounds duration, combined output and concurrent commands, and stops held group identity on cancellation or command completion. Windows native shell is refused. Supply a host isolated executor there, or whenever isolation is needed. File grants do not restrict an authorized unrestricted shell. An isolated executor must enforce its own OS isolation, bounds and cancellation; Doe bounds its returned output and supplies the signal.

Attach `createBeatExtension()` as `extensions.runBeat`. `runBeat()` uses a new bounded ID and fresh supplied changes/instructions/commitments, not main history. Skip records its reason without a full model request. `end_beat` accepts quiet or one to eight raises, each at most 2,000 characters, with rung `record`, `report`, `room`, `dm` or `notification`. Completion waits for the whole tool batch; denied approval, failed sibling, cancellation and persistence failure cannot become quiet success. Free text is activity. Only explicit host posting tools notify people.

Beat defaults include `end_beat` within 64 tools and 262,144 schema bytes. Inputs cap at 32,768 characters per field. Hosts own timers, change gathering, cadence, prior-raise state and delivery. The package adds none of those policies.

## Verification handoff

Run the package gates from the repository root:

```sh
pnpm vitest run packages/doe/src
pnpm --filter @dorkos/doe build
pnpm --filter @dorkos/doe typecheck
pnpm --filter @dorkos/doe lint
pnpm --filter @dorkos/doe test:pack
pnpm vitest run scripts/__tests__/vitest-projects.test.ts
pnpm verify
```

The delivery test uses actual local model and HTTP MCP requests for deferred discovery, an approved call, a builder write, history reopen, manual compaction, continued chat after reopening a checkpoint, and an isolated beat. SQLite trigger fixtures cover late message/usage and outcome failures. Synchronization gates cover external and public cancellation during owned cleanup.

The local example exports `main`, requires explicit endpoint/model arguments, accepts loopback URLs only, imports Doe only inside `main`, and uses no API-key argument or environment credential. A direct-entry guard prevents import execution. It grants files only inside an owned temporary directory, denies tools unless `--allow-tools` is present, aborts on SIGINT, awaits the active run and then closes/deletes only its own files. Failure sets nonzero status. The packed-consumer check imports the example without running it, then executes it against a loopback streaming fixture. No live vendor-account check is implied.

The explicit `test:pack` command builds and packs the package, installs production dependencies in an owned OS temporary directory outside the repository, and removes that directory afterward. It checks shipped files and dependency confinement, runs the cold-import guards, all three SDK wire exchanges, and the packaged example. It downloads dependencies from npm; model traffic uses local fixtures only. This packaging check is separate from ordinary offline source tests.
