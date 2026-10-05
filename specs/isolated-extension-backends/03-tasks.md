# Tasks: isolated-extension-backends

Generated from `03-tasks.json` (2026-10-03T20:57:23.062Z). Each phase is one PR, except Phase 3 and Phase 5, which may split along task lines if review size demands it.

Critical path: 1.1 → 1.2 → 1.3 → 1.4 → (2.x in parallel) ; 1.1 → 3.1 → 3.2/3.4 ; 1.2 → 3.3 → 3.5 → 3.6 ; 3.1 → 4.1 → 4.3 → 4.4 → 5.1/5.2 → 5.3 → 5.4 ; 5.3 + DOR-2685 merged → 6.1 → 6.2.

Phase 2 (UI) and Phase 3 (child process) can run in parallel after Phase 1.

## Phase 1: Contract and consent data

### Task 1.1: Add runtime, allow and limits to the extension manifest schema

- Size: medium; priority: high
- Depends on: none; parallel with: 1.2

Goal: extension.json can declare an isolated server half, validated identically by discovery and `dorkos marketplace validate` (both use packages/extension-api/src/manifest-schema.ts).

1. New pure module packages/extension-api/src/net-allowlist.ts (exported via the package's existing exports; no new package):
   - parseNetEntry(entry: string): { host: string; wildcard: boolean; port: number | null; kind: 'name'|'ipv4'|'ipv6' } | { error: string }.
     Rules: lowercase DNS name, IPv4 literal, or bracketed IPv6 literal; optional ':port' (1..65535); optional leading '_.' (matches one or more labels BELOW the domain, never the apex, never bare '_'); refuse scheme/path/credentials with the message 'Write just the host, like api.example.com'; loopback (localhost, 127.0.0.0/8, ::1), RFC 1918, fc00::/7 and link-local names/literals REQUIRE an explicit port (message: 'Add a port for a local address, like localhost:8080').
   - matchesNetEntry(entries, host, port): boolean — trailing dot ignored, case-insensitive, punycode compared as given.
     TSDoc on every export.
2. In ServerCapabilitiesSchema add:
   runtime: z.enum(['in-process','subprocess']).default('in-process') — plus 'worker' handling per Decision for Dorian 1: recommended (A) means a value of 'worker' fails with exactly: Use "subprocess": a worker can't be given its own limits.
   allow: z.object({ net: z.array(z.string()).max(64).default([]), run: z.array(z.string()).max(16).default([]), agents: z.boolean().default(false) }).strict().optional()
   limits: z.object({ memoryMb: z.number().int().min(64).max(1024).default(256) }).strict().optional()
   superRefine rules: allow/limits only with runtime 'subprocess' ('allow and limits only apply to an extension that runs separately'); each allow.net entry passes parseNetEntry; allow.run entries are a bare program name (/^[A-Za-z0-9._-]+$/) or an absolute path, no spaces-as-arguments; externalHosts together with runtime 'subprocess' fails ('Use allow.net for an extension that runs separately').
3. In ExtensionManifestSchema superRefine: runtime 'subprocess' requires a server entry — a dataProxy-only manifest declaring it fails ('There is no server code to run separately').
4. Export types IsolationRuntime, ExtensionAllow, ExtensionLimits.

Acceptance / tests (packages/extension-api/src/**tests**/, each with a purpose comment):

- valid mail-app example parses with defaults filled (memoryMb 256, agents false).
- each refusal above returns its exact message (https://x, '_', '_.example.com' accepted, 'example.com' not matched by '*.example.com', localhost without port refused, localhost:8080 accepted, [::1]:3000 accepted, 'git status' in run refused).
- allow under in-process refused; worker refused with the exact message.
- an existing in-process manifest fixture parses byte-identically to before (runtime defaults, no allow key added).

### Task 1.2: Expose record.isolation from discovery, with allow.run resolved

- Size: small; priority: high
- Depends on: 1.1; parallel with: none

Goal: every consumer (lifecycle, approval queue, client) reads one normalized isolation view.

1. packages/extension-api/src/types.ts: add to ExtensionRecord and ExtensionRecordPublic:
   isolation: { runtime: 'subprocess'; net: string[]; run: string[]; resolvedRun: { name: string; path: string | null }[]; agents: boolean; memoryMb: number } | null
   (null for in-process). TSDoc explains resolvedRun: path is the absolute program path found on the host PATH at discovery, null when not found on this computer.
2. apps/server/src/services/extensions/extension-discovery.ts: fill it from the validated manifest. Resolve bare run names against the server's PATH (use the same which-style lookup other server code uses; on Windows honour PATHEXT); absolute paths are kept if they exist, else null.
3. Public projection in the route/serializer that builds ExtensionRecordPublic carries isolation.

Tests: discovery fixture with runtime subprocess yields the view; a missing program gives path null; an in-process extension yields null.

### Task 1.3: Bind approvals to the declared permission set

- Size: large; priority: high
- Depends on: 1.2; parallel with: none

Goal: a person's approval covers exactly the set they saw; narrowing never asks, widening makes the extension wait.

1. packages/shared/src/config-schema.ts, under extensions: approvedPermissions: z.record(z.string(), ApprovedPermissionSetSchema).default(() => ({})) where ApprovedPermissionSetSchema = z.object({ runtime: z.enum(['in-process','subprocess']), net: z.array(z.string()), run: z.array(z.string()), agents: z.boolean() }). Follow the adding-config-fields skill end to end: per-field default AND the object-literal default (both are declared — keep them in agreement), a semver-keyed conf migration adding {} , docs in contributing/configuration.md if fields are listed there, and classify extensions.approvedPermissions as operator-only in apps/server/src/services/core/operator/config-write-policy.ts beside approvedToRun (its drift guard must pass).
2. New apps/server/src/services/extensions/isolation/permission-coverage.ts:
   declaredSet(record): ApprovedPermissionSet ('in-process' records → { runtime:'in-process', net:[], run:[], agents:false } but treated as FULL);
   isCovered(declared, approved | undefined): boolean — undefined means the full in-process set (always covers). Rules: subprocess ⊆ in-process; in-process declared needs approved runtime in-process; every declared net entry matched by an approved entry (same host+port, or an approved port-less entry for that host, or an approved wildcard matching it — use matchesNetEntry semantics on entries); every declared run entry present; agents true needs approved agents true.
   addedSince(declared, approved): { net: string[]; run: string[]; agents: boolean; runtime: boolean } | null.
3. extension-load-policy.ts mayRunExtensionCode: add the clause "and isCovered(declaredSet(copy), approvals.approvedPermissions?.[id])". Update the header comment with one paragraph on why (same-source updates keep approval; declared lists must not widen silently).
4. Every approve path writes the declared set: POST /api/extensions/:id/approve, the inbox approval action, and any server function that appends to approvedToRun (grep approvedToRun writes). Revocation removes the entry.
5. extension-server-lifecycle.ts buildSourceKey: add isolation: record.isolation ? { runtime, net, run, agents, memoryMb } : null.
6. Until Phase 5 lands, initialize() refuses runtime 'subprocess' after the approval gate with serverError { code: 'isolation_not_ready', message: '<Name> needs a newer version of DorkOS to run.' } — a dedicated, grep-able constant ISOLATION_NOT_READY so Phase 5 deletes it.

Tests (purpose comments):

- coverage table: narrowing (drop a host, in-process→subprocess with no entry) covered; widening (new host, new port, wildcard broader than approved, new program, agents false→true, subprocess→in-process) not covered.
- mayRunExtensionCode false for an approved id whose manifest widened; the approval queue (extension-approval-queue.ts) then lists it (it keys on mayRunExtensionCode).
- approve writes the set; a later identical manifest runs without asking.
- migration test: old config without the field loads with {} and existing approvals still run.
- config-write-policy drift guard passes with the new field classified.

### Task 1.4: Carry permissions and what changed on the pending approval payload

- Size: small; priority: medium
- Depends on: 1.3; parallel with: none

Goal: the client can render what an isolated extension can reach and what is new since the last approval.

1. packages/shared/src/extension-approval-schemas.ts PendingExtensionApproval gains:
   permissions: { runtime: 'in-process'|'subprocess'; net: string[]; run: { name: string; found: boolean }[]; agents: boolean; hasPage: boolean } | null
   added: { net: string[]; run: string[]; agents: boolean; runtime: boolean } | null
   (hasPage = the extension has a client bundle.)
2. extension-approval-queue.ts fills both from record.isolation, record client-bundle presence and addedSince(declared, config approvedPermissions[id]).
3. Marketplace preview: apps/server/src/services/marketplace/preview/permission-preview.ts adds isolation per extension ({ id, runtime, net, run, agents }) and folds allow.net hosts into externalHosts (deduplicated). Update the PermissionPreview type in services/marketplace/types.ts and any shared schema mirroring it.

Tests: queue payload for a widened extension lists only the new host; preview for a fixture package lists its isolation block; an in-process extension gives runtime 'in-process' and empty lists.

## Phase 2: Consent UI

### Task 2.1: Show declared permissions on approval cards and the extension card

- Size: medium; priority: high
- Depends on: 1.4; parallel with: 2.2

Goal: the person sees what an extension can reach before saying yes. Copy follows writing-app-copy (no "we", max 15 words per block, pnpm check:copy-length passes). Never the word "sandbox".

Surfaces: apps/client/src/layers/widgets/inbox-bell/ui/ExtensionApprovalList.tsx, the inbox approval row in layers/features/inbox, and layers/features/extensions/ui/ExtensionCard.tsx. Build ONE shared presentational component (e.g. layers/entities/extension or the lowest layer all three may import, respecting FSD: shared ← entities ← features ← widgets) named ExtensionPermissionLines taking the permissions/added payload.

Lines for runtime subprocess:

- "Runs separately from DorkOS."
- "Can connect to: <hosts joined with ', '>" or "Can't connect to the internet." when net is empty.
- "Can run: <names>"; a program with found=false adds "<name> isn't on this computer."; for sh, bash, zsh, cmd, powershell, pwsh, node, python, python3, osascript, env, xargs: "Can run <name>, which can run any program."
- "Can message your agents and start chats." only when agents is true.
- A re-ask (added non-null) leads with "Now also wants to connect to: <added.net>" / "Now also wants to run: <added.run>" / "Now also wants to message your agents."
  Decision for Dorian 2 (recommended A, implement A unless Dorian chose B): runtime in-process → "Runs inside DorkOS with full access to this computer."; hasPage → "Its screens run in DorkOS with your access."

Tests (RTL with mock Transport, purpose comments): each line appears for its condition and not otherwise; re-ask leads with the added host; interpreter warning; long host lists wrap without truncation. Grep apps/e2e for any approval-card copy you change and update those specs in the same PR (browser specs run only in the merge queue).
Maintain the Dev Playground per the maintaining-dev-playground skill: add a showcase for ExtensionPermissionLines states.

### Task 2.2: Show isolation in the marketplace install preview

- Size: small; priority: medium
- Depends on: 1.4; parallel with: 2.1

Goal: before install, a package's extensions show the same lines as the approval card.

apps/client/src/layers/features/marketplace/ui/PermissionPreviewSection.tsx renders the isolation block per extension using the shared ExtensionPermissionLines component from task 2.1 (if 2.1 has not landed, land the component here first and let 2.1 reuse it). Keep the existing externalHosts list for in-process extensions.

Tests: PermissionPreviewSection.test.tsx cases for an isolated extension, an in-process one, and a package with both; install-flow.integration.test.tsx still passes.

### Task 2.3: Add status copy for isolated-extension failures

- Size: small; priority: medium
- Depends on: 1.4; parallel with: none

Goal: the extension card explains each new serverError code, each with the existing Reload action.

Map in ExtensionCard (and wherever serverError renders):

- server_crashed: "<Name> stopped unexpectedly 3 times. Reload it to try again."
- server_out_of_memory: "<Name> ran out of memory and stopped. Reload it to try again."
- server_unresponsive: "<Name> stopped responding, so DorkOS stopped it."
- isolation_unavailable: "<Name> can't run with its limits on this computer."
- isolation_not_ready: "<Name> needs a newer version of DorkOS to run." (removed in Phase 5 together with the server constant)
- restarting state (record field restartingAt: string | null added to ExtensionRecordPublic in this task, null by default): "Restarting <Name>…"
  The server already sends a message string; prefer the server message when present and use this map only as the code→copy source of truth shared with the server (put the strings in packages/shared so server and client say the same words; check:copy-length must pass).

Tests: each code renders its line and a Reload button.

## Phase 3: Child process and enforcement

### Task 3.1: Build the child bootstrap and its production bundle entries

- Size: large; priority: high
- Depends on: 1.1; parallel with: 3.3

Goal: a self-contained JS entry DorkOS forks for each isolated extension, shipped by the CLI and desktop builds.

1. apps/server/src/services/extensions/isolation/child/bootstrap.ts (entry). Order, before any extension code:
   a. send hello { node: process.version, permission: { present: typeof process.permission?.has === 'function', fsWriteRoot: process.permission?.has('fs.write', '/') , child: has('child'), worker: has('worker'), addon: has('addon') } } over process.send (IPC, advanced serialization).
   b. wait for host 'init' { extensionId, bundlePath, allowNet, dorkosPort, manifestTools, constants } — the host sends it only after accepting hello.
   c. install NetGuard (task 3.2) and the child_process shim (task 3.4).
   d. load the bundle: read bundlePath, wrap in a CommonJS function with an injected require that maps 'express' → the bootstrap's bundled express, '@dorkos/extension-api' and '@dorkos/extension-api/server' → bundled copies, 'child_process'/'node:child_process' → the shim, other node builtins → real require, anything else → throw "Isolated extensions must bundle their dependencies: <name>". Use vm.compileFunction or Module.wrap with the real file name for stack traces (inline sourcemaps already present).
   e. leave register() for task 4.x; in this phase export a test seam that runs a fixture entry's default export(app) so 3.x tests can drive the child.
   f. stdout/stderr are left to the host (task 3.5 forwards them).
2. Build entries: add apps/server/src/services/extensions/isolation/child/bootstrap.ts as a second esbuild entry emitted as extension-child.js beside the server bundle in packages/cli/scripts/build.ts and apps/desktop/scripts/build-server.ts (platform node, cjs, bundle everything incl. express, target matching the server bundle). Host resolves it with new URL('./extension-child.js', import.meta.url); in dev (source TS under tsx) the host bundles bootstrap.ts with esbuild once per server version into {dorkHome}/cache/extensions/isolation/extension-child-<version>.js.
3. Guard test (scripts/**tests** or the cli package tests): both build configs include the entry (static assertion on the build script config, not a full build).

Tests: dev bundling produces a runnable file; hello message shape; unknown dependency require throws the exact message.

### Task 3.2: Implement NetGuard and the net allowlist match in the child

- Size: large; priority: high
- Depends on: 3.1; parallel with: 3.4

Goal: an isolated extension connects only to allow.net; its escape routes are closed by the permission model the self-check confirmed.

apps/server/src/services/extensions/isolation/child/net-guard.ts, installGuard({ allowNet, dorkosPort }):

- FIRST capture intrinsics: const apply = Reflect.apply; uncurried String.prototype.toLowerCase/endsWith/slice/split, Array.prototype.some/includes, a frozen deep copy of parsed allow entries; never call a method on a prototype the extension can reach after install.
- Wrap net.Socket.prototype.connect: normalize args (options object, (port, host), (path)); a path (Unix socket / named pipe) → refuse; host+port must match (matchesNetEntry from packages/extension-api/src/net-allowlist.ts, reimplemented on captured intrinsics or called before install and closed over); DorkOS's own port on any loopback address (localhost, 127.0.0.0/8, ::1) → always refuse.
- Wrap dns.lookup, dns.resolve, resolve4/6/Any/Cname/Mx/Ns/Txt/Srv/Ptr/Naptr/Soa/Caa, dns.reverse, dns.Resolver.prototype methods, and the dns.promises counterparts: names not matching allow.net → refuse; dns.reverse always refuse. After a permitted lookup, if a declared NON-loopback/private name resolved to a loopback/private/link-local address and no such address is declared → refuse (rebinding).
- dgram.createSocket → throw; net.Server.prototype.listen → throw.
- Refusal: Error with code 'ERR_EXTENSION_NET_DENIED' and message '<host:port> isn't in this extension's allow.net list.' (for listen: 'Isolated extensions can't accept connections.'; for UDP: 'Isolated extensions can't use UDP.').

Tests (real child processes forked with the real flags; NEVER mock): for each probe assert refusal AND that the same probe succeeds in a control child without the guard (so the test can fail): fetch undeclared host (point at a local test server on an undeclared loopback port), fetch declared loopback port succeeds, https via tls.connect to undeclared, http2.connect, dns.lookup undeclared, dns.promises.resolve4, dgram send, net.createServer().listen, DorkOS port refused even when declared, a prototype-tampering attempt (String.prototype.endsWith = () => true; Array.prototype.some = () => true) then undeclared connect still refused.

### Task 3.3: Fork isolated children with fixed grants, scrubbed env and a fail-closed self-check

- Size: large; priority: high
- Depends on: 1.2; parallel with: 3.1

Goal: IsolatedExtensionHost starts a child with only the permissions this spec grants, or refuses.

apps/server/src/services/extensions/isolation/isolated-host.ts:

1. start({ record, bundlePath, dorkHome }):
   - ensure {dorkHome}/extension-data/<id>/files/ and files/.tmp/;
   - assetsDir = <record.runPath ?? record.path>/assets when it exists; walk it and refuse if any symlink's realpath leaves it (serverError message: '<Name> couldn't start: its assets folder links outside itself.');
   - fork(bootstrapPath, [], { execPath: process.execPath, execArgv: ['--permission', '--allow-fs-read=' + realpath(bootstrap), '--allow-fs-read=' + realpath(bundle), ...(assets ? ['--allow-fs-read=' + realpath(assets)] : []), '--allow-fs-read=' + realpath(files), '--allow-fs-write=' + realpath(files), '--max-old-space-size=' + memoryMb], env: childEnv, serialization: 'advanced', stdio: ['ignore','pipe','pipe','ipc'] }). Never pass --allow-child-process, --allow-worker, --allow-addons, --allow-wasi, --allow-inspector; never inherit process.execArgv.
   - childEnv from nothing: NODE_ENV, TZ, LANG, LC_* copied; HOME = files; TMPDIR/TMP/TEMP = files/.tmp; DORKOS_EXT_ID = id; ELECTRON_RUN_AS_NODE = '1' when process.versions.electron.
2. Self-check: require hello within 5 s with permission.present true and fsWriteRoot, child, worker, addon all false; otherwise SIGKILL and return { ok:false, code:'isolation_unavailable', message: "<Name> couldn't start with its limits on this computer, so DorkOS left it off." }. No fallback.
3. stop(): send 'stop', wait up to 3 s for exit, then SIGKILL. Return a promise that resolves on exit.
4. ctx.filesDir is introduced in task 4.2; this task only creates the folder.
5. A test seam (constructor option) lets a test drop '--permission' to prove the self-check refuses.

Tests (real forks): child cannot read {dorkHome}/config.json or write outside files (assert ERR_ACCESS_DENIED, and control child can); execSync, new Worker, process.binding('tcp_wrap') denied; env has no PATH/NODE_OPTIONS/ANTHROPIC_API_KEY even when the parent has them; assets symlink to outside refused; self-check refuses without --permission; stop() kills a child that ignores 'stop' within ~3 s.
Note macOS: grants must be realpaths (/tmp is /private/tmp) — tests must use fs.realpathSync for temp dirs.

### Task 3.4: Broker allow.run programs from the host

- Size: large; priority: high
- Depends on: 3.1; parallel with: 3.2

Goal: an isolated extension runs only declared programs, through the host.

1. Child shim apps/server/src/services/extensions/isolation/child/child-process-shim.ts: spawn(file, args, opts), execFile(file, args, opts, cb), exec(cmd, opts, cb) (= platform shell: /bin/sh -c, or cmd.exe /d /s /c on Windows), returning ChildProcess-shaped EventEmitters with stdout/stderr Readables, stdin Writable, kill(signal), pid (host pid), 'exit'/'close'/'error' events. spawn with shell:true behaves like exec. execSync/execFileSync/spawnSync/fork throw: "Isolated extensions can't run programs synchronously; use the async form."
2. Host apps/server/src/services/extensions/isolation/run-broker.ts handling run-spawn { rid, file, args, cwd, env, stdin } / run-stdin / run-kill → run-data { rid, stream, chunk } / run-exit { rid, code, signal } / run-error:
   - file must equal a declared allow.run name or absolute path (shell needs 'sh' or 'cmd' declared); spawn the RESOLVED absolute path (re-check it exists) with shell:false;
   - cwd must be inside ctx.filesDir or inside a project root ctx.projects.list() returns for this extension (resolve realpaths); else refuse 'That folder is outside what this extension can use.';
   - env = extension-supplied env + host PATH;
   - max 8 concurrent ('Too many programs running at once.');
   - killAll() on stop/crash: POSIX spawn detached and kill(-pid); Windows tree kill as apps/server/src/services/marketplace/lib/git/git-runner.ts does.
   - refusal message for undeclared: '<name> isn't in this extension's allow.run list.'

Tests (real processes): declared program (an absolute path such as /bin/echo on POSIX, cmd.exe on Windows) streams stdout and exit code; undeclared refused; exec without sh declared refused; cwd outside refused; 9th concurrent refused; killAll terminates a sleeping program; sync forms throw the exact message.

### Task 3.5: Add the watchdog, restart policy, log forwarding and IPC limits

- Size: medium; priority: high
- Depends on: 3.3; parallel with: none

Goal: a hung, crashing or chatty child never harms DorkOS, and repeated failure ends in a clear stopped state.

1. Watchdog in isolated-host.ts: ping every 5 s; no pong within 15 s → SIGKILL with reason server_unresponsive.
2. apps/server/src/services/extensions/isolation/restart-policy.ts: pure class RestartPolicy({ delays: [1000, 5000, 30000], budget: 3, windowMs: 600000, now }) with onUnexpectedExit() → { restartIn: number } | { giveUp: true } and reset(). Reset triggers wired in Phase 5 (reload, enable, approve, dev-link reload).
3. Exit classification: exit the host asked for (stop) → no restart; V8 'heap out of memory' marker seen on stderr → server_out_of_memory; watchdog kill → server_unresponsive; else server_crashed.
4. Log forwarding: stdout/stderr split into lines → logger.info/warn as '[ext:<id>] <line>', capped at 200 lines per 10 s, one 'output suppressed' line when the cap trips.
5. IPC limits: message > 4 MB refused (host side: drop + error reply + log); > 256 outstanding calls refused ('Too many calls at once'); host→child backlog over 1,000 undelivered messages (process.send returning false, tracked) → treat as unresponsive.

Tests: RestartPolicy table (three exits inside window → giveUp; exits spread beyond window → restart; reset clears); real child with while(true){} killed within 20 s as unresponsive; real child allocating until heap death classified out_of_memory with memoryMb 64; log flood capped.

### Task 3.6: Prove isolation on packaged desktop and Windows CI

- Size: medium; priority: high
- Depends on: 3.3, 3.2; parallel with: none

Goal: evidence that the flags are honoured where DorkOS actually ships, before any extension relies on them.

1. apps/desktop/scripts/smoke-packaged.ts: add a step that, inside the packaged app's server (utilityProcess), forks the packaged extension-child.js through IsolatedExtensionHost with a fixture bundle and asserts the hello self-check passed (permission.present true; fsWriteRoot, child, worker, addon false) and that an undeclared fetch is refused. If Electron 41 ignores --permission in run-as-node mode, this step must fail and the finding goes on the PR (the runtime self-check already fails closed; do not weaken it).
2. Add a desktop build guard asserting electron-builder.yml configures no fuse that disables RunAsNode (or, if fuses are added later, that RunAsNode stays enabled).
3. Make the isolation integration suite run on the existing Windows CI job (check contributing/ci.md and ci/required-checks.json; do not add a new required check without the ci-pipeline protocol and a ci/ledger entry).
   Per AGENTS.md demo-claim gate: no user-facing claim that isolation works on Windows until a real install confirms it.

## Phase 4: ctx over the boundary

### Task 4.1: Define CTX_PROTOCOL with type-level exhaustiveness

- Size: medium; priority: high
- Depends on: 3.1; parallel with: none

Goal: one table decides how every DataProviderContext member crosses the boundary, and adding a member without deciding is a build error.

apps/server/src/services/extensions/isolation/ctx-protocol.ts:
type Kind = { kind:'const' } | { kind:'call'; gate?: 'agents' } | { kind:'emit' } | { kind:'subscribe'; gate?: 'agents' } | { kind:'reverse'; boundMs: number } | { kind:'local' } | { kind:'object'; members: Record<string, Kind> };
type ProtocolFor<T> = { [K in keyof T]-?: T[K] extends (...a: any[]) => any ? Exclude<Kind, {kind:'object'}|{kind:'const'}> : T[K] extends object ? { kind:'object'; members: ProtocolFor<T[K]> } | { kind:'const' } | { kind:'local' } : { kind:'const' } };
export const CTX_PROTOCOL = { secrets:{object get/set/delete/has: call}, settings:{get/set/delete/getAll: call}, storage:{loadData/saveData: call}, schedule: local, emit: emit, extensionId/extensionDir/dorkHome/filesDir: const, accounts:{list, usage, markContinued: call; onUsage: subscribe; registerAdvisor: reverse 2000 (ADVISOR_TIMEOUT_MS)}, projects:{resolve, list, report: call; onChange: subscribe}, inbox:{raise, resolve, record, list: call; onAction: reverse 5000}, requirePerson: local, projectSettings:{get: call; onChange: subscribe}, sessions:{start: call gate agents}, agent:{send: call gate agents; subscribe: subscribe gate agents} } as const satisfies ProtocolFor<DataProviderContext>;
(tools is added in Phase 6; ctx.data when the data layer lands — the satisfies clause forces both.)
Helper: lookup(path: string): Kind | undefined, flatten() listing every leaf path.

Tests: a // @ts-expect-error fixture showing an interface with an extra function member fails ProtocolFor; a runtime test builds a real in-process ctx via createDataProviderContext (service getters stubbed as extension-server-api-factory.test.ts does) and asserts every function-valued path has a table entry and vice versa.

### Task 4.2: Add ctx.filesDir to both runtimes

- Size: small; priority: medium
- Depends on: 4.1; parallel with: 4.3

Goal: one writable folder per extension, the same in both runtimes.

packages/extension-api/src/server-extension-api.ts: add readonly filesDir: string to DataProviderContext with TSDoc ("A folder only this extension writes to: {dorkHome}/extension-data/<id>/files. In an isolated extension it is the only place it can write.").
extension-server-api-factory.ts: set filesDir = path.join(dorkHome, 'extension-data', extensionId, 'files') and mkdir it lazily (recursive) at context creation.
CTX_PROTOCOL gets filesDir: const (the satisfies clause fails until it does).
Tests: factory test asserts the path and that it exists after creation.

### Task 4.3: Implement the host dispatcher and the child proxy ctx

- Size: xl; priority: high
- Depends on: 4.1; parallel with: 4.2

Goal: every ctx call from an isolated child runs through the extension's REAL ctx in the host.

Host apps/server/src/services/extensions/isolation/ctx-dispatcher.ts: given the ctx from createDataProviderContext and the record's isolation, handle messages:

- call { id, path, args }: lookup(path) must be a call kind; args must be an array; gate 'agents' requires isolation.agents (else reject with AgentSendError('not_allowed', "This extension didn't ask to message your agents.") for agent.*, plain Error with the same words for sessions.start); invoke the real method; reply ret { id, ok, value } or { ok:false, error }.
- emit { event, data } → ctx.emit.
- sub { id, path } → call the real registration with a listener that posts evt { id, args }; keep the unregister fn; unsub { id } calls it. Gated like calls.
- expose { id, path, methods? }: accounts.registerAdvisor → register through the real ctx.accounts.registerAdvisor a proxy advisor having exactly 'methods' (rank, onLimited, modelFallback, carryOver, claims, move, cancelAuto, wait), each doing rcall and awaiting rret (the existing ADVISOR_TIMEOUT_MS bound and default fallback in account-advisor.ts apply unchanged); inbox.onAction → real ctx.inbox.onAction with a handler doing rcall (existing 5 s bound applies). unexpose { id } calls the returned unregister.
- unknown path, bad shape, > 4 MB → error reply + log; host treats every child message as untrusted.
  Errors serialize as { name, message, code?, ...own enumerable primitives }.

Child apps/server/src/services/extensions/isolation/child/proxy-ctx.ts builds a DataProviderContext from CTX_PROTOCOL: const → values from init; call → promise over call/ret with id map; emit → post; subscribe → returns an unsubscribe that posts unsub; reverse → registers the local function under an id and answers rcall with rret (honouring cancel { id } via an AbortController where the handler accepts a signal); local: schedule (setInterval with the 5 s floor, cancels tracked and run on stop), requirePerson (task 5.2 supplies the verdict-reading middleware; until then a middleware that refuses 403). Errors rebuilt by name into the bootstrap's AgentSendError / InboxLimitError / InboxLinkError, else Error with code copied.
Wire into bootstrap: after init, register(router, proxyCtx) under the host-measured REGISTER_TIMEOUT_MS; child replies registered { handledTools: [], hasCleanup }. On 'stop': run cleanup, schedule cancels, then process.exit(0).

### Task 4.4: Run one ctx conformance suite against both runtimes

- Size: large; priority: high
- Depends on: 4.3, 4.2; parallel with: none

Goal: proof that an isolated ctx behaves like the in-process one, kept true as ctx grows.

Create a shared suite (apps/server/src/services/extensions/**tests**/ctx-conformance.ts) parameterized by a factory returning a ctx: in-process (createDataProviderContext) and isolated (a real forked child via IsolatedExtensionHost with a fixture bundle that exposes ctx operations over a test channel). Cases (purpose comment each):

- secrets set/get/has/delete round-trip; settings; storage loadData/saveData;
- emit reaches eventFanOut as ext:<id>:<event>;
- accounts.onUsage fires and is released after stop (no listener left in the store);
- registerAdvisor rank answered; a rank that sleeps 3 s falls back to the default within the 2 s bound;
- inbox.onAction handler result returned; 5 s bound;
- projects.onChange, projectSettings.onChange fire and release;
- agent.send / sessions.start refused without allow.agents (isolated only, asserted as an expected difference), allowed with it;
- an AgentSendError's code survives the boundary;
- schedule clamps to 5 s and is cancelled on stop.
  The isolated leg must fail if the dispatcher is bypassed (e.g. assert host-side call counters).

## Phase 5: Router and lifecycle (isolated extensions go live)

### Task 5.1: Proxy the router over IPC with the header policy

- Size: xl; priority: high
- Depends on: 4.3; parallel with: 5.2

Goal: /api/ext/<id>/* reaches the child's Express router with real HTTP semantics, and the person's credentials never reach it.

1. Child apps/server/src/services/extensions/isolation/child/virtual-server.ts: express app mounting the extension router at /api/ext/<id>; http.createServer(app) that NEVER listens; on conn-open { cid } create a Duplex whose writes post conn-data and whose reads come from host conn-data; server.emit('connection', duplex); conn-end/destroy both ways.
2. Host apps/server/src/services/extensions/isolation/isolated-router.ts: an Express handler returned by getRouter(id) for isolated extensions. Per request: http.request({ method, path: req.originalUrl, headers, createConnection: () => virtualSocket(cid) }); 64 KB frames.
   - Body: if express.json already parsed it (req.body !== undefined and content-type json), send JSON.stringify(req.body) with a fresh content-length; else pipe req.
   - Inbound strip: cookie, authorization, proxy-authorization, every x-dorkos-* header, the MCP token header; then set x-dorkos-ext-person (task 5.2).
   - Outbound strip: set-cookie, strict-transport-security, access-control-*; always add content-security-policy: sandbox; default-src 'none' and x-content-type-options: nosniff.
   - 120 s with no bytes either way → 504 '<Name> didn't answer in time.'; client abort destroys the virtual socket; child exit before headers → 503 '<Name> stopped while answering.', after headers → destroy.
   - Hybrid dataProxy: the host proxy router (extension-proxy.ts) is tried first on the same mount, as today.
     middleware/extension-routes.ts and index.ts:5004 are unchanged.

Tests (real child): JSON body round-trip; raw text body; SSE chunks arrive incrementally (assert timing between two chunks); client abort reaches the child; child exit mid-response (both cases); cookie/authorization never visible to the child; a client-sent x-dorkos-ext-person is replaced; set-cookie stripped; CSP present; req.baseUrl/req.params match the in-process fixture.

### Task 5.2: Extract assessPerson and make requirePerson read the host verdict

- Size: medium; priority: high
- Depends on: 4.3; parallel with: 5.1

Goal: ctx.requirePerson in an isolated extension refuses exactly what it refuses in-process.

1. apps/server/src/routes/extensions-person-bar.ts: extract assessPerson(req, res, copy): null | { status: number; body: { error, code, message } } containing the three bars of refuseIfNotAPerson (origin, operator cookie under login, trusted caller) without writing; refuseIfNotAPerson becomes: const r = assessPerson(...); if (r) { res.status(r.status).json(r.body); return true } return false. Existing tests must pass unchanged.
2. isolated-router.ts sets x-dorkos-ext-person: JSON { ok: true } or { ok: false, status, body } computed with the extension's PersonBarCopy (createRequirePerson's copy, factored so both share it).
3. Child requirePerson: parse the header; ok → next(); not ok → res.status(status).json(body); header missing or unparsable → 403 with the in-process agent-refusal body (fail closed).

Tests: for each refusal case (cross-site origin, login on without cookie, agent header) the isolated response status and body equal the in-process response; a person passes; a missing header refuses.

### Task 5.3: Wire isolation into the extension lifecycle and remove the not-ready refusal

- Size: large; priority: high
- Depends on: 5.1, 5.2, 3.5, 3.4, 4.4; parallel with: none

Goal: an approved runtime-subprocess extension starts, serves, stops, crashes and restarts through every existing start/stop path.

extension-server-lifecycle.ts initialize(): after the approval gate and compile (unchanged), branch on record.isolation:

- null → today's require() path, untouched.
- subprocess → IsolatedExtensionHost.start; build the real ctx with createDataProviderContext (extensionDir = runPath ?? path) and attach the dispatcher; await 'registered' within REGISTER_TIMEOUT_MS (on timeout: dispose(), stop the child, same serverError copy as today); store ActiveServerExtension { router: IsolatedRouter, cleanup: () => host.stop(), scheduledCleanups: [], releaseListeners, sourceKey, isolated: handle }; inbox markRunning; agent-send extensionStarted; clear serverError.
  shutdown(): unchanged order, plus for isolated: host.stop() (3 s then SIGKILL), runBroker.killAll(), 503 open connections, reject pending calls/rcalls.
  Unexpected exit: run the full shutdown bookkeeping, set serverError per the classification (server_crashed / server_out_of_memory / server_unresponsive) or schedule a restart per RestartPolicy (set record.restartingAt while pending, broadcast the existing extension change event so the card updates). RestartPolicy.reset() on reloadExtension, enable, approveToRun and dev-link reload.
  **Required (from the Phase 4 review):** an UNEXPECTED exit must run the same stop bookkeeping as a requested one, in particular `getExtensionInbox()?.markStopped(id)` and `getAgentSendService()?.extensionStopped(id)`. `CtxDispatcher.close()` removes only what the child registered; a call already running in the real ctx (an `agent.send` waiting for room) still goes out after the child is gone unless agent-send is told. Wire it through the host's `onExit` (or give `CtxDispatcher.close()` an `onClosed` hook) and test a killed child with a held `agent.send`.
  Delete ISOLATION_NOT_READY (server constant, shared copy entry, client mapping) — grep must find nothing.
  Update header comments in extension-load-policy.ts and extension-test-harness.ts: the "no sandbox, no boundary check" statement holds for in-process extensions; isolated ones run per this spec.

Tests (extension-lifecycle.integration.test.ts style, real child): approve → route answers; process.abort() in a timer → other DorkOS routes keep answering and the extension restarts; third crash in 10 min → server_crashed and stays stopped; reload resets; while(true) → server_unresponsive; disable stops the child (no process left: check pid); in-process extension fixtures pass unchanged (run the existing extension test files).
Dev link (DOR-2696): with a dev-linked fixture, edit server.ts → a new child serves the new code; edit extension.json to add an allow.net host → extension waits for approval (mayRunExtensionCode false) and the approval queue lists it; narrowing reloads without asking.

### Task 5.4: Document isolated extensions and add the changelog fragment

- Size: medium; priority: medium
- Depends on: 5.3; parallel with: none

Goal: authors know how to opt in and exactly what it does and does not protect; people know what the card means.

- contributing/extension-authoring.md: "Running separately" — manifest keys with the mail-app example; enforced-by table (crash/OOM/hang: real; files/processes: Node permission model, Node disclaims it against malicious code; allow.run: which program, not what it does; allow.net: DorkOS guard inside the process, not an OS firewall; agents: host-enforced; screens: not isolated); ctx.filesDir and assets/; no sync child_process, no native addons, bundle all dependencies; error → fix table (ERR_EXTENSION_NET_DENIED → add the host to allow.net; ERR_ACCESS_DENIED path → write under ctx.filesDir or read from assets/; '<name> isn't in this extension's allow.run list' → add it).
- docs/ extension guide (writing-for-humans): what "Runs separately" on a card means and what it doesn't cover. Never "sandbox", no Windows claim (demo-claim gate). Vocab gate: no "integration/connector/adapter/provider" in prose.
- contributing/architecture.md: isolated runtime beside ADR 0213.
- packages/extension-api TSDoc for runtime/allow/limits/filesDir.
- changelog/unreleased/<id>-isolated-extension-backends.md (timestamp id via .claude/scripts/id.ts) with a covers: block, user-facing wording.
- Run pnpm exec prettier --write on every hand-edited file before committing.

## Phase 6: Tools over the boundary (after DOR-2685)

### Task 6.1: Carry DOR-2685 tool handlers over the boundary

- Size: large; priority: high
- Depends on: 5.3; parallel with: none

Prerequisite: DOR-2685 (PR #2519) merged — ctx.tools.handle, manifest tools, registry.contribute, the host invoke wrapper with deadline/abort/256 KB cap.

1. CTX_PROTOCOL: tools: { kind:'object', members: { handle: { kind:'reverse', boundMs: 0 } } } (boundMs 0 = the per-tool deadline lives in the host wrapper). The satisfies clause fails until this exists once DOR-2685 adds tools to DataProviderContext.
2. Child proxy ctx.tools.handle(name, fn): validate against the manifest tools copy sent in init (same errors DOR-2685 throws: undeclared name, already handled); post expose { path: 'tools.handle', name }.
3. Host dispatcher: on that expose, call the REAL ctx.tools.handle(name, stub). The stub sends rcall { handler: 'tool:<name>', args: [input, { agentId }] } and resolves with rret's value; when the composed call.signal aborts, send cancel { id } and settle immediately (do not wait for the child).
4. Child: per rcall create an AbortController passed as call.signal; cancel aborts it.
5. registered.handledTools lists the handled names; DOR-2685's declared-but-unhandled check and registry.contribute run after 'registered' exactly as after an in-process register().
6. Child exit: contribution.remove() first (DOR-2685 shutdown order), then reject in-flight tool calls with "<Name> stopped while this ran."

Tests (real child): an agent-path invoke returns the child's result; deadline abort reaches the child's signal; result over 256 KB refused by the host wrapper; process.abort() mid-call → stopped error and the tool disappears from registry.get; restart re-contributes; a handler hung in while(true) → watchdog kill → tool removed (closes DOR-2685's "synchronous hang" leftover for isolated extensions).

### Task 6.2: Document tools from isolated extensions and promote the ADRs

- Size: small; priority: low
- Depends on: 6.1; parallel with: none

- contributing/extension-authoring.md: tools work the same from an isolated extension; handlers receive call.signal and must stop work on abort; results must be structured-clone-able and JSON-serializable.
- Run /adr:from-spec on specs/isolated-extension-backends (promotes D1-D7 from design-decisions.md that still hold into decisions/ with manifest entries); add a note to decisions/0213 that in-process remains the default (not superseded).
- specs/manifest.json: set status to implemented when all phases have merged.
