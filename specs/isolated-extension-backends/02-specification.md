---
slug: isolated-extension-backends
id: 261003-204731
created: 2026-10-03
status: specified
linearIssue: DOR-2686
---

# Isolated extension backends: a subprocess runtime with declared network and run allowlists

**Status:** Draft (two product decisions open for Dorian, see "Decisions for Dorian")
**Author:** Claude Code (SPECIFY stage, /flow)
**Date:** 2026-10-03

## Overview

An extension's server half can opt out of running inside DorkOS. With
`serverCapabilities.runtime: "subprocess"` in `extension.json`, DorkOS runs `server.ts` in its own
Node process with only what the manifest declares: the hosts it may connect to (`allow.net`), the
programs it may run (`allow.run`), and whether it may drive the person's agents (`allow.agents`).
Its Express router is reached through DorkOS exactly as today, at `/api/ext/<id>/*`. Its whole `ctx`
— secrets, settings, storage, schedules, events, accounts, projects, inbox, sessions, agent
messaging, and DOR-2685's tool handlers — is carried over the process boundary by one typed
protocol. A crash or a hang stops that extension, not DorkOS, and DorkOS restarts it a bounded
number of times.

Extensions that declare nothing keep running in-process, unchanged.

This spec is precise about what is enforced. Node 24 has no network permission, so the host list is
enforced by a DorkOS guard inside the extension's process, whose bypass routes Node's permission
model closes. That is real against ordinary code and code compromised through its input (the email
case). It is not an OS firewall, and Node itself says its permission model is not a guarantee
against deliberately malicious code. Nothing in the UI calls this a sandbox.

## Background / Problem Statement

`ExtensionServerLifecycle.initialize` (`apps/server/src/services/extensions/extension-server-lifecycle.ts`)
`require()`s the compiled `server.ts` into the DorkOS server process and calls
`register(router, ctx)`. ADR 0213 accepted that for "trusted, developer-authored extensions":
a crash takes the server down, and there is no CPU or memory isolation. `extension-load-policy.ts`
and `extension-test-harness.ts` both say it in their headers: "no sandbox, no boundary check".

Two things changed the premise (DOR-2686):

1. **A marketplace.** People now install extensions they did not write. The approval gate
   (DOR-516) asks once, but what it approves is "run this with the server's full authority".
2. **Extensions that parse hostile input.** The LifeOS mail extension (vault
   `0-System/mail-app/EXTENSION-PATH.md`) reads untrusted email. A parser bug there is a bug with the
   DorkOS server's authority: every secret store, the config, every agent, the tunnel.

What is measurable today: a `throw` in an extension's timer callback is caught, but a
`process.abort()`, a native fault, an out-of-memory, or a synchronous infinite loop in any extension
stops or freezes DorkOS for everyone. A compromised extension can read `~/.dork/config.json`, every
other extension's encrypted secrets and the key that decrypts them, and call any DorkOS route as
the person.

## Goals

- `extension.json` can declare `serverCapabilities.runtime: "subprocess"` with `allow.net`,
  `allow.run`, `allow.agents` and `limits.memoryMb`, validated by the shared schema (so
  `dorkos marketplace validate` and discovery agree).
- An isolated server half runs in a separate OS process with:
  - no filesystem access beyond its compiled bundle, its own `assets/`, and its own files folder;
  - no ability to start processes, threads, native addons, WASI or the inspector;
  - outbound connections only to declared hosts, and no inbound listening;
  - no environment secrets and no read access to DorkOS's data directory;
  - a heap cap and a liveness watchdog.
- Programs in `allow.run` can be run, and only those, through a host-side broker.
- The router is reached at `/api/ext/<id>/*` with the same Express semantics, including streaming
  responses; the person's cookies and tokens never reach the extension.
- Every `DataProviderContext` member works over the boundary, and adding a member to that interface
  without deciding how it crosses fails the build.
- DOR-2685 tools work from an isolated extension, with the same gate, deadline and abort semantics.
- A crash, out-of-memory or hang stops only that extension; DorkOS restarts it with backoff, and
  stops trying after repeated failures, saying so on its card.
- The approval binds to the declared permission set: a narrower set needs nothing, a wider one asks
  again.
- The consent surfaces (approval card, extension card, marketplace install preview) show what an
  isolated extension can reach, in plain words.
- Dev link (DOR-2696) hot reload keeps working for isolated extensions.
- In-process extensions behave exactly as today.

## Non-Goals

- Isolating the client bundle. It still runs same-origin in the page with the person's session
  (`extension-load-policy.ts` explains why). The card says so (Decision for Dorian 2).
- An OS-level sandbox (macOS `sandbox-exec`, Linux namespaces/seccomp, Windows AppContainer). It is
  the recorded upgrade path for the network rule (design decision D2).
- Making isolation mandatory or the default for marketplace installs.
- Isolating dataProxy-only extensions: they run no extension code; the proxy is host code.
- `test_extension`'s client-bundle import (`extension-test-harness.ts`), relay adapter plugins.
- A `fs` allowlist in the manifest. The fixed grants below are the whole filesystem story for v1.
- Per-extension CPU quotas. Node has no portable CPU cap; the watchdog bounds hangs only.
- Native addons in isolated extensions (`--allow-addons` stays off; an extension that needs one
  stays in-process).
- Synchronous child-process calls (`execSync`, `spawnSync`, `execFileSync`) from an isolated
  extension: they cannot be brokered over an asynchronous channel without workers, which are denied.

## Technical Dependencies

- **Node permission model** (`--permission`, `--allow-fs-read`, `--allow-fs-write`), stable since
  Node 22.13 / 23.5; DorkOS's floor is `>=22.22.3` (`packages/cli/package.json`). Probed on 24.14.1
  (2026-10-03):

  | Probe under `node --permission --allow-fs-read=<dir>`        | Result                                      |
  | ------------------------------------------------------------ | ------------------------------------------- |
  | `node --permission --allow-net`                              | `bad option: --allow-net` — no such flag    |
  | `fetch('https://example.com')`                               | **200 — network is not restricted at all**  |
  | `child_process.execSync`, `new Worker`, `readFileSync(/etc)` | `ERR_ACCESS_DENIED`                         |
  | `process.binding('tcp_wrap')`                                | `ERR_ACCESS_DENIED`                         |
  | patched `net.Socket.prototype.connect`, then `fetch`         | intercepted, host visible, fetch fails      |
  | `dns.lookup`, `dgram.send` after that patch                  | **not intercepted** — need their own guards |
  | `--allow-fs-read=/tmp` on macOS                              | denied: grants must be realpaths            |

  Node's documentation calls the model a "seat belt" for trusted code that "does not provide
  security guarantees in the presence of malicious code", and warns that symbolic links are followed
  even outside granted paths. `--allow-child-process` and `--allow-worker` are all-or-nothing.

- **Electron 41** (`apps/desktop/package.json`). The packaged server runs in `utilityProcess`
  (`apps/desktop/src/main/server-spawn.ts:416`), so `process.execPath` there is Electron's helper and
  a forked child needs `ELECTRON_RUN_AS_NODE=1`. No fuse is configured in `electron-builder.yml`, so
  `RunAsNode` is at its default (on). **Unverified:** that Electron 41's bundled Node honours
  `--permission` in run-as-node mode. Phase 3 proves it in the packaged smoke
  (`apps/desktop/scripts/smoke-packaged.ts`); the runtime self-check (§4) fails closed regardless.
- **`node:child_process.fork`** with `serialization: 'advanced'` for the IPC channel (structured
  clone: `Uint8Array`, `Date`, `Map` survive).
- **`express`** 5 (already a server dependency), bundled into the child bootstrap.
- **esbuild** (already used by `extension-compiler.ts`) for the bootstrap bundle entry in the CLI
  (`packages/cli/scripts/build.ts`) and desktop (`apps/desktop/scripts/build-server.ts`) builds.
- Lands after **DOR-2685** (PR #2519: `ctx.tools.handle`, manifest `tools`/`skills`, registry
  `contribute`) for Phase 6 only; Phases 1-5 do not depend on it. DOR-2683 (`ctx.agent`) and DOR-2696
  (dev link) are on `main`.
- The data layer (`ctx.data`, spec `extension-data-layer`) is not on `DataProviderContext` yet. When
  it lands, its methods are `call` entries in the protocol table (§5); the exhaustiveness check
  forces that decision at compile time.

## Detailed Design

### Architecture

```
                         DorkOS server process (unchanged authority)
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │ ExtensionServerLifecycle.initialize(id)                                              │
 │   approval gate (+ permission-set coverage) → compile server bundle                  │
 │   ├─ runtime in-process (default) ──► require() + register(router, ctx)  [as today]   │
 │   └─ runtime subprocess ──► IsolatedExtensionHost.start()                            │
 │         ctx = createDataProviderContext(...)  ◄── the REAL ctx, built as today        │
 │         CtxDispatcher(protocol table) ─ dispatches child calls into ctx               │
 │         RunBroker(allow.run)          ─ spawns allowed programs                        │
 │         IsolatedRouter                ─ Express handler: /api/ext/<id>/* → child      │
 │         Watchdog / RestartPolicy                                                      │
 └───────────────┬──────────────────────────────────────────────────────────────────────┘
                 │ fork(bootstrap.js, execArgv: --permission --allow-fs-read=… --max-old-space-size=…)
                 │ IPC (advanced serialization): calls, events, reverse calls, HTTP byte streams
 ┌───────────────▼──────────────────────────────────────────────────────────────────────┐
 │ Extension child process (one per isolated extension)                                  │
 │   bootstrap: self-check → install NetGuard → install child_process shim               │
 │   → load bundle with injected require (express, @dorkos/extension-api[/server])       │
 │   → register(router, proxyCtx) → report { handledTools, hasCleanup }                  │
 │   http.Server (never listens) ◄─ virtual connections over IPC                         │
 └──────────────────────────────────────────────────────────────────────────────────────┘
```

The central choice: **the host builds the extension's real `ctx` with the existing
`createDataProviderContext`, and the child gets a proxy that forwards to it.** Every validation,
scope check, listener tracking, `release` and `dispose` already in the factory applies unchanged, so
the two runtimes cannot drift in behaviour, only in transport.

### 1. Manifest contract (`packages/extension-api/src/manifest-schema.ts`)

```jsonc
{
  "id": "mail-app",
  "serverCapabilities": {
    "serverEntry": "./server.ts",
    "runtime": "subprocess", // "in-process" (default) | "subprocess"
    "allow": {
      "net": ["imap.fastmail.com:993", "smtp.fastmail.com:465", "*.googleapis.com"],
      "run": ["git"],
      "agents": true,
    },
    "limits": { "memoryMb": 256 },
  },
}
```

Schema rules (Zod, shared, so the CLI validator and discovery give the same reasons):

- `runtime`: `"in-process" | "subprocess"`, default `"in-process"`. `"worker"` per Decision for
  Dorian 1 (recommended: refused with the reason "Use \"subprocess\": a worker can't be given its
  own limits.").
- `allow` and `limits` are valid only with `runtime: "subprocess"` (an in-process extension already
  has everything; a list it declares would be a promise nothing keeps).
- `allow.net`: at most 64 entries, each `host[:port]`:
  - `host` is a lowercase DNS name, an IPv4 literal, or a bracketed IPv6 literal; a leading `*.`
    matches one or more labels below the named domain (never the apex itself, never a bare `*`);
  - no scheme, path or credentials (`https://x` is refused with "Write just the host, like
    api.example.com");
  - loopback (`localhost`, `127.0.0.0/8`, `::1`), private (RFC 1918, `fc00::/7`) and link-local
    names or literals require an explicit port;
  - omitted port means any port.
- `allow.run`: at most 16 entries, each a bare program name (`git`, resolved on the host's `PATH` at
  start) or an absolute path. No arguments, no globs.
- `allow.agents`: boolean, default `false`. Gates `ctx.agent.send`, `ctx.agent.subscribe` and
  `ctx.sessions.start` (§5.4).
- `limits.memoryMb`: integer 64..1024, default 256 (V8 old-space heap).
- With `runtime: "subprocess"`, `serverCapabilities.externalHosts` is refused ("Use allow.net for an
  extension that runs separately"); `externalHosts` stays the informational list for in-process
  extensions.
- `runtime: "subprocess"` with no server entry (dataProxy-only) is refused ("There is no server code
  to run separately").

Discovery adds `isolation: { runtime, net, run, agents, memoryMb } | null` to `ExtensionRecord` and
`ExtensionRecordPublic` (`packages/extension-api/src/types.ts`), with `allow.run` entries resolved to
absolute paths (`resolvedRun: { name, path | null }[]`, `null` = not found on this computer, which
the card shows and the broker refuses).

### 2. Consent: the approval binds to the declared permission set

Today an update from the same approved source keeps its approval (`extension-approval-queue.ts`
header), and a path-bound approval survives every edit. Without a change, an update could add hosts
or programs silently.

- New operator-only config field `extensions.approvedPermissions: Record<string, ApprovedPermissionSet>`
  keyed by extension id, where `ApprovedPermissionSet = { runtime, net: string[], run: string[],
agents: boolean }`. Classified `operator-only` in `core/operator/config-write-policy.ts` beside
  `approvedToRun`, added through the `adding-config-fields` skill with a semver-keyed migration
  (default `{}`).
- **A missing entry means the full in-process set.** Every extension approved before this ships was
  approved for full authority, so moving it to `subprocess` is a narrowing and asks nothing.
- `mayRunExtensionCode` (`extension-load-policy.ts`) adds one clause: the declared set must be
  **covered** by the approved set. Covered means: runtime `subprocess` ⊆ `in-process`; every
  declared `net` entry matched by an approved entry (same host and port, or an approved wildcard or
  port-less entry that matches it); every `run` entry present; `agents` not newly `true`.
- Approving (`POST /api/extensions/:id/approve`, the inbox card, the Settings card) writes the
  declared set as approved. Narrower edits never re-ask; wider ones make the extension wait, which
  the approval queue already turns into an inbox row because it keys on `mayRunExtensionCode`.
- `PendingExtensionApproval` (`@dorkos/shared/extension-approval-schemas`) gains
  `permissions: { runtime, net, run: { name, found }[], agents, hasPage: boolean } | null` and
  `added: { net: string[]; run: string[]; agents: boolean; runtime: boolean } | null` (what is new
  since the last approval), so a re-ask card leads with what changed.
- `buildSourceKey` adds a digest of `runtime`, `allow` and `limits`, so a manifest-only edit restarts
  the extension (narrower) or parks it awaiting approval (wider).

### 3. Process start and the fixed grants

`IsolatedExtensionHost.start(record, bundle)` (new,
`apps/server/src/services/extensions/isolation/isolated-host.ts`):

1. Writes the compiled bundle to `{dorkHome}/cache/extensions/server/_run/<id>.js` (as today).
2. Ensures `{dorkHome}/extension-data/<id>/files/` and `files/.tmp/` exist.
3. Scans `<runPath>/assets/` (if present) and refuses to start if any entry is a symlink whose
   realpath leaves `assets/` (Node follows symlinks outside granted paths, so a link to `~/.ssh` would
   otherwise be readable). Message: "<Name> couldn't start: its assets folder links outside itself."
4. Forks:

   ```ts
   fork(bootstrapPath, [], {
     execPath: process.execPath,
     execArgv: [
       '--permission',
       `--allow-fs-read=${realpath(bootstrapPath)}`,
       `--allow-fs-read=${realpath(bundlePath)}`,
       `--allow-fs-read=${realpath(assetsDir)}`, // only when it exists
       `--allow-fs-read=${realpath(filesDir)}`,
       `--allow-fs-write=${realpath(filesDir)}`,
       `--max-old-space-size=${memoryMb}`,
     ],
     env: childEnv, // below; NOT process.env
     serialization: 'advanced',
     stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
   });
   ```

   Never granted: `--allow-child-process`, `--allow-worker`, `--allow-addons`, `--allow-wasi`,
   `--allow-inspector`. Every path is passed through `realpath` (the macOS `/tmp` → `/private/tmp`
   probe). The parent's `execArgv` (tsx loaders in dev) is never inherited.

5. `childEnv` is built from nothing: `NODE_ENV`, `TZ`, `LANG` and `LC_*` copied; `HOME` = `filesDir`;
   `TMPDIR`/`TMP`/`TEMP` = `filesDir/.tmp`; `DORKOS_EXT_ID`; and `ELECTRON_RUN_AS_NODE=1` when
   `process.versions.electron` is set. No `PATH` (it cannot spawn), no `NODE_OPTIONS`, no API keys,
   no DorkOS tokens.

`ctx.filesDir` (new, both runtimes, `{dorkHome}/extension-data/<id>/files`) is the one writable
place; `ctx.extensionDir` stays as today, and an isolated extension can read only its `assets/`
there. `ctx.dorkHome` stays a string; an isolated child cannot read it.

The bootstrap (`isolation/child/bootstrap.ts`) is a separate esbuild entry in the CLI and desktop
server builds, emitted beside the server bundle and resolved with
`new URL('./extension-child.js', import.meta.url)`; in dev (server under tsx) the host bundles it once
per server version into `{dorkHome}/cache/extensions/isolation/` with the esbuild the compiler
already uses. A build guard test fails if either production build omits the entry.

### 4. The child: self-check, guards, then the extension

In this order, before any extension code is evaluated:

1. **Self-check.** The first IPC message is
   `hello { node: process.version, permission: { present, fsWriteRoot, child, worker, addon } }`,
   from `process.permission.has(...)`. The host requires `present` and every capability `false`
   (and `fs.write` on `/` false); anything else kills the child and marks
   `serverError { code: 'isolation_unavailable' }`: "<Name> couldn't start with its limits on this
   computer, so DorkOS left it off." **Fail closed:** there is no fallback to in-process.
2. **NetGuard** (`isolation/child/net-guard.ts`). Captures the intrinsics it needs first
   (`Reflect.apply`, string and array methods via uncurried references, a frozen copy of the
   allowlist), so later prototype tampering by extension code cannot change its decisions. Then:
   - wraps `net.Socket.prototype.connect` (the path `net.connect`, `tls.connect`, `http`, `https`,
     `http2` and built-in `fetch` all reach): a TCP connect is allowed only when its host (before
     DNS) and port match `allow.net`; a Unix socket or named pipe path is always refused;
   - wraps `dns.lookup`, `dns.resolve*`, `dns.reverse`, `dns.Resolver` and their `dns.promises`
     counterparts: only names matching `allow.net` resolve (closes DNS-query exfiltration);
     a declared non-loopback name that resolves to a loopback, private or link-local address is
     refused unless such an address is itself declared (DNS rebinding);
   - replaces `dgram.createSocket` and `net.Server.prototype.listen` with refusals (no UDP, no
     inbound);
   - always refuses DorkOS's own port on any loopback address, declared or not (the child must not
     reach DorkOS's HTTP API, its MCP endpoint, or its tunnel).

   A refusal throws `Error` with `code: 'ERR_EXTENSION_NET_DENIED'` and the message "<host:port> isn't
   in this extension's allow.net list." The guard's escape routes — `process.binding`, native addons,
   child processes, workers, WASI, the inspector — are closed by the permission model (§3), which the
   self-check confirmed.

3. **child_process shim.** `require('child_process')` (and `node:` form) from the bundle resolves to
   a shim exposing `spawn`, `execFile`, `exec` and `ChildProcess`-shaped objects backed by the
   RunBroker (§6). The `*Sync` forms and `fork` throw "Isolated extensions can't run programs
   synchronously; use the async form." Reaching the real module some other way gets
   `ERR_ACCESS_DENIED` from Node.
4. **Load the bundle** with an injected `require`: `express`, `@dorkos/extension-api`,
   `@dorkos/extension-api/server` map to the bootstrap's bundled copies (the compiler marks these
   external, `extension-compiler.ts:296`), `child_process` to the shim, other builtins pass through,
   anything else throws (the bundle is self-contained by construction).
5. `register(router, proxyCtx)`, under the existing `REGISTER_TIMEOUT_MS` (15 s, measured by the
   host from fork). On settle the child sends
   `registered { handledTools: string[], hasCleanup: boolean }`.

stdout/stderr lines are forwarded to the host logger as `[ext:<id>]`, capped at 200 lines per 10 s
(one "output suppressed" line when the cap trips), so a chatty or hostile child cannot flood the
log.

### 5. `ctx` over the boundary

#### 5.1 One protocol table, exhaustive by type

`isolation/ctx-protocol.ts` (imported by host and bootstrap) declares, for every member of
`DataProviderContext`, how it crosses:

```ts
type Kind =
  | { kind: 'const' } // extensionId, extensionDir, dorkHome, filesDir: copied at start
  | { kind: 'call'; gate?: 'agents' } // async request/response
  | { kind: 'emit' } // fire-and-forget (ctx.emit)
  | { kind: 'subscribe'; gate?: 'agents' } // listener registration, events pushed to child
  | { kind: 'reverse'; boundMs: number } // host calls a child-held function and awaits a value
  | { kind: 'local' } // implemented in the child (schedule, requirePerson)
  | { kind: 'object'; members: Record<string, Kind> };

export const CTX_PROTOCOL = {
  secrets: { kind: 'object', members: { get: call, set: call, delete: call, has: call } },
  settings: { kind: 'object', members: { get: call, set: call, delete: call, getAll: call } },
  storage: { kind: 'object', members: { loadData: call, saveData: call } },
  schedule: { kind: 'local' },
  emit: { kind: 'emit' },
  accounts: {
    kind: 'object',
    members: {
      list: call,
      usage: call,
      onUsage: subscribe,
      markContinued: call,
      registerAdvisor: { kind: 'reverse', boundMs: ADVISOR_TIMEOUT_MS },
    },
  },
  projects: {
    kind: 'object',
    members: { resolve: call, list: call, report: call, onChange: subscribe },
  },
  inbox: {
    kind: 'object',
    members: {
      raise: call,
      resolve: call,
      record: call,
      list: call,
      onAction: { kind: 'reverse', boundMs: 5_000 },
    },
  },
  requirePerson: { kind: 'local' },
  projectSettings: { kind: 'object', members: { get: call, onChange: subscribe } },
  sessions: { kind: 'object', members: { start: { kind: 'call', gate: 'agents' } } },
  agent: {
    kind: 'object',
    members: {
      send: { kind: 'call', gate: 'agents' },
      subscribe: { kind: 'subscribe', gate: 'agents' },
    },
  },
  tools: {
    kind: 'object',
    members: { handle: { kind: 'reverse', boundMs: 0 /* per-tool deadline, host-side */ } },
  },
  extensionId: konst,
  extensionDir: konst,
  dorkHome: konst,
  filesDir: konst,
} as const satisfies ProtocolFor<DataProviderContext>;
```

`ProtocolFor<T>` maps every key of `T` (recursively for objects) to a `Kind`, so **adding a member
to `DataProviderContext` without a protocol entry is a type error** in the server package, and a
unit test walks a real in-process ctx and asserts every function-valued path has an entry (the
runtime half of the same rule). `tools` lands with Phase 6, `ctx.data` with the data layer.

#### 5.2 Wire messages (IPC, advanced serialization)

| Direction | Message                                    | Meaning                                                        |
| --------- | ------------------------------------------ | -------------------------------------------------------------- |
| c→h       | `call { id, path, args }`                  | `path` like `"inbox.raise"`; host validates against the table  |
| h→c       | `ret { id, ok, value \| error }`           | result or serialized error                                     |
| c→h       | `emit { event, data }`                     | `ctx.emit`                                                     |
| c→h / h→c | `sub { id, path }` / `unsub { id }`        | listener lifecycle                                             |
| h→c       | `evt { id, args }`                         | a listener fired                                               |
| c→h       | `expose { id, path, methods? }`            | child registered a reverse handler (advisor lists its methods) |
| h→c / c→h | `rcall { id, handler, args }` / `rret`     | host invokes a child handler; `cancel { id }` aborts it        |
| both      | `conn-open/conn-data/conn-end { cid, … }`  | HTTP byte streams (§7)                                         |
| both      | `run-*`                                    | RunBroker (§6)                                                 |
| both      | `hello`, `registered`, `ping/pong`, `stop` | lifecycle                                                      |

Host-side rules: an unknown `path`, a non-array `args`, or a message over 4 MB is answered with an
error and logged; at most 256 outstanding `call`s per child (more are refused with "Too many calls
at once"); the real ctx method does all argument validation, as it does in-process.

#### 5.3 Errors

Errors cross as `{ name, message, code?, ...own enumerable data }` and are rebuilt in the child as
instances of the bootstrap's `AgentSendError`, `InboxLimitError` and `InboxLinkError` (by `name`),
else `Error` with `code` copied. The public guidance already says to match on `err.code`
(`agent-messaging.ts:143`), so behaviour matches in-process.

#### 5.4 `allow.agents`

DOR-2683 deliberately gave `ctx.agent` no manifest gate: "the server half is code the person already
chose to run, and a declaration it writes about itself would hold nothing back." That is true
in-process, where code could reach the services directly. In a child, the host is the only path, so
the declaration is enforceable, and it matters: an agent can run commands, so `agent.send` and
`sessions.start` are a way out of every other limit. Without `allow.agents: true`, the host refuses
those calls with `AgentSendError('not_allowed', "This extension didn't ask to message your agents.")`
(and a plain `Error` with the same words for `sessions.start`). In-process extensions are unchanged.

#### 5.5 Local members

- `schedule(intervalSeconds, fn)` runs in the child with the same 5-second floor; its cancels are
  run on `stop`.
- `requirePerson` is a middleware that reads the host's verdict header (§7) and either calls `next()`
  or answers with the host-computed status and body. A request without a verdict is refused (fail
  closed).

#### 5.6 Reverse calls

- **Advisor.** `registerAdvisor(advisor)` sends `expose` with the method names present (`rank`,
  `onLimited`, `modelFallback`, `carryOver`, `claims`, `move`, `cancelAuto`, `wait`); the host
  registers a proxy advisor with exactly those methods through the real `ctx.accounts.registerAdvisor`,
  so the existing `ADVISOR_TIMEOUT_MS` (2 s) bound and its "using the default" fallback
  (`account-advisor.ts:142-162`) apply unchanged.
- **`inbox.onAction`**: same, through the real `ctx.inbox.onAction`, under its existing 5 s bound.
- **Tools** (Phase 6): §8.

The returned unregister functions send `unsub`/`unexpose`; the host's tracked `release` still
removes everything when the extension stops, whatever the child did.

### 6. RunBroker (`allow.run`)

`--allow-child-process` is all-or-nothing, so the child has none and the host runs programs for it:

- `run-spawn { rid, file, args, cwd, env, stdin: boolean }`: `file` must equal a declared name or
  absolute path; the host spawns the **resolved absolute path** (resolved at start, re-checked to
  exist), with `shell: false`. `exec` and `spawn(..., { shell: true })` resolve to the platform
  shell, so they need `sh` (or `cmd.exe`) in `allow.run`.
- `cwd` must be inside `ctx.filesDir` or inside a project root `ctx.projects.list()` returns for this
  extension; otherwise refused. `env` is exactly what the extension passes plus `PATH` from the host
  (a program needs it); the extension cannot read the host's environment, so it cannot pass it.
- stdout/stderr stream back as `run-data` frames, stdin forward; `run-kill { rid, signal }`;
  `run-exit { rid, code, signal }`.
- At most 8 concurrent programs per extension. On stop or crash, the host kills every program the
  extension started (process group on POSIX; tree kill on Windows, following `git-runner.ts`).

What this enforces: **which** programs. What it cannot: what a permitted program then does — it runs
with the person's full authority, outside every limit here. `git` can run hooks; `sh`, `bash`,
`zsh`, `cmd`, `powershell`, `node`, `python`, `osascript`, `env` and `xargs` can run anything. The
card says so for those (§User Experience); the schema allows them because hiding the choice would
not make it safer.

### 7. Router over IPC

`IsolatedRouter` is what `getRouter(id)` returns for an isolated extension, so
`middleware/extension-routes.ts` and `index.ts:5004` are unchanged.

- **Transport.** The child runs `http.createServer(app)` and never calls `listen`. For each request
  the host calls `http.request({ createConnection: () => virtualSocket(cid) })`, where the virtual
  socket is a `Duplex` whose bytes travel as `conn-*` frames (64 KB chunks); the child feeds the
  matching `Duplex` to `server.emit('connection', duplex)`. Real HTTP/1.1 on both ends: streaming
  responses and SSE work, nothing listens, and Windows behaves the same (no named pipe).
- The child's `app` mounts the extension router at `/api/ext/<id>` and the host forwards
  `req.originalUrl`, so `req.baseUrl`, `req.path` and `req.params` match the in-process case.
- **Body.** `express.json` (`app.ts:292`) has already consumed a JSON body; the host re-encodes
  `req.body` as JSON with a fresh `content-length`. Any other body is piped raw. The 1 MB limit is
  unchanged.
- **Inbound headers.** Stripped: `cookie`, `authorization`, `proxy-authorization`, every `x-dorkos-*`
  header (agent identity, approval tokens), and the MCP token header. Added:
  `x-dorkos-ext-person` with the host's verdict, `{ "ok": true }` or
  `{ "ok": false, "status": 403, "body": { … } }`, computed by a new non-writing
  `assessPerson(req, res, copy)` extracted from `refuseIfNotAPerson`
  (`routes/extensions-person-bar.ts:155`); `refuseIfNotAPerson` becomes a thin wrapper over it.
  The person's session cookie therefore never reaches extension code, which matters because a
  cookie that left the machine is usable through the tunnel.
- **Outbound headers.** Stripped: `set-cookie`, `strict-transport-security`, `access-control-*`.
  Always added: `content-security-policy: sandbox; default-src 'none'` and
  `x-content-type-options: nosniff`, so a response opened as a document cannot run script on the
  DorkOS origin.
- **Timeouts.** 120 s with no bytes in either direction answers 504 "<Name> didn't answer in time."
  A client disconnect destroys the virtual socket. A child that exits mid-response: headers not yet
  sent → 503 "<Name> stopped while answering."; already streaming → the connection is destroyed.
- **Hybrid dataProxy.** The proxy router (`extension-proxy.ts`) stays in the host and is tried first
  on the same mount, as today; it is host code with a host-declared base URL.

### 8. Tools over the boundary (DOR-2685)

DOR-2685's invoke wrapper (its §5) stays the authority: gate, deadline (measured after the gate),
abort composition, 256 KB result cap, error copy. Only "look up the live handler" changes:

- `ctx.tools.handle(name, fn)` in the child validates the name locally against the manifest copy
  and sends `expose { path: 'tools.handle', name }`; the host binds a stub handler through the real
  `ctx.tools.handle`, so DOR-2685's declared-but-unhandled check and its `registry.contribute` call
  (after `registered`) run unchanged.
- The stub sends `rcall { handler: 'tool:<name>', args: [input, { agentId }] }`. When the composed
  `signal` aborts (deadline, stop, caller), the host sends `cancel { id }` and the child aborts that
  call's `AbortController`; the host does not wait for the child to acknowledge.
- Results cross as structured clone; the host serializes and caps exactly as for in-process.
- A child exit removes the contribution first (DOR-2685's shutdown order), then rejects in-flight
  calls with "<Name> stopped while this ran."

### 9. Lifecycle, crashes, restarts, limits

`ExtensionServerLifecycle.initialize` branches after the existing approval gate and compile:

- `runtime: "in-process"`: today's code path, byte-for-byte.
- `runtime: "subprocess"`: `IsolatedExtensionHost.start`. `ActiveServerExtension` gains
  `isolated?: IsolatedHandle`; `router` is the `IsolatedRouter`; `cleanup` sends `stop`.

`shutdown(id)` keeps its order (inbox `markStopped`, agent-send `extensionStopped`, scheduled
cancels, cleanup, `releaseListeners`) and for an isolated extension: sends `stop`; the child runs its
cleanup and schedule cancels and exits; after 3 s the host sends `SIGKILL`; every program the broker
started is killed; open virtual connections get 503; pending `call`s and `rcall`s are rejected.

**Watchdog.** The host sends `ping` every 5 s; no `pong` within 15 s kills the child as
`server_unresponsive` — which also closes DOR-2685's leftover ("a synchronous hang is DOR-2686's to
solve") for isolated extensions.

**Restart policy** (`isolation/restart-policy.ts`). An exit the host did not ask for runs the full
shutdown bookkeeping, then restarts (fresh process, `register()` again) after 1 s, 5 s, then 30 s.
A third unexpected exit within 10 minutes leaves it stopped with
`serverError { code: 'server_crashed' }`. A heap-limit death (exit with the V8 "heap out of memory"
marker on stderr) is reported as `server_out_of_memory` and counts as a crash. Reload, enable,
approve, or a dev-link reload resets the count. `serverError`, never `status`, so the client bundle
stays loadable (the DOR-1336 rule).

**Limits.** Heap: `limits.memoryMb` via `--max-old-space-size` (heap only; Buffers and native memory
are not counted, stated in the docs). IPC: 4 MB per message, 256 outstanding calls, 64 KB HTTP
frames, and a host-to-child backlog over 1,000 undelivered messages is treated as unresponsive. (Known
gap, found in the Phase 3 review: Node's IPC channel reads a whole message before the host sees it,
so the 4 MB limit bounds what the host acts on, not what it reads. A child that sends one huge frame
still costs the host that much memory, once. Closing it needs a framed pipe of DorkOS's own in place
of `fork`'s channel, which checks the length before reading.)
Programs: 8 concurrent. CPU: no cap; the watchdog bounds a stuck event loop only.

### 10. Dev link (DOR-2696)

The dev-link watcher calls `reloadExtension(id)` (shutdown + initialize) on any change under
`.dork/extensions/<id>/**`. For an isolated extension that is a stop (≤3 s, usually immediate) and a
fresh fork (~100 ms plus `register()`). A `server.ts` edit reloads; a manifest edit that narrows
`allow` reloads; one that widens it parks the extension awaiting approval (§2), shown on the dev-link
badge as "Waiting for your OK" through the existing approval queue. A dev link's run path is its
target's realpath, so the `assets/` grant and symlink scan apply to the working folder. The bundle
the child reads is the compiled cache file, so the watcher's no-write-during-reload rule holds.

### Code structure

```
packages/extension-api/src/manifest-schema.ts         runtime, allow, limits + rules
packages/extension-api/src/server-extension-api.ts    ctx.filesDir
packages/extension-api/src/types.ts                   record.isolation
packages/shared/src/config-schema.ts                  extensions.approvedPermissions (+ migration)
packages/shared/src/extension-approval-schemas.ts     permissions, added
apps/server/src/services/extensions/
  extension-load-policy.ts                            coverage clause
  extension-server-lifecycle.ts                       runtime branch
  isolation/
    isolated-host.ts            fork, grants, env, self-check, stop/kill
    ctx-protocol.ts             CTX_PROTOCOL + ProtocolFor<T>
    ctx-dispatcher.ts           host: child messages → real ctx
    isolated-router.ts          Express handler, virtual sockets, header policy
    run-broker.ts               allow.run
    restart-policy.ts           backoff + crash budget
    permission-coverage.ts      declared ⊆ approved
    net-allowlist.ts            parse + match (shared by schema checks and guard)
    child/
      bootstrap.ts              entry: self-check, guards, injected require, register
      net-guard.ts
      child-process-shim.ts
      proxy-ctx.ts
      virtual-server.ts
apps/server/src/routes/extensions-person-bar.ts       assessPerson()
packages/cli/scripts/build.ts, apps/desktop/scripts/build-server.ts   extension-child entry
apps/client/src/layers/…                              consent copy (§User Experience)
```

## User Experience

Copy follows `writing-app-copy` (no "we", at most 15 words per block). Never "sandbox".

**Approval card (inbox row, bell list, Settings card)** for an isolated extension, under the
existing "Let <Name> run?" line:

- "Runs separately from DorkOS." then, one line each:
  - "Can connect to: imap.fastmail.com, smtp.fastmail.com, *.googleapis.com" (or "Can't connect to
    the internet.")
  - "Can run: git" (with "git isn't on this computer." when unresolved); for a shell or interpreter:
    "Can run sh, which can run any program."
  - "Can message your agents and start chats." (only with `allow.agents`)
- When it has a client bundle (Decision for Dorian 2): "Its screens run in DorkOS with your access."
- A re-ask leads with what is new: "Now also wants to connect to: api.example.com".

For an in-process extension (Decision for Dorian 2, recommended): "Runs inside DorkOS with full
access to this computer."

**Marketplace install preview** (`PermissionPreviewSection.tsx`): per extension, the same lines,
built from the staged manifest (`permission-preview.ts` adds `isolation` per extension and folds
`allow.net` into its host list).

**Extension card status** (`serverError` codes, each with a Reload action as today):

- `server_crashed`: "<Name> stopped unexpectedly 3 times. Reload it to try again."
- `server_out_of_memory`: "<Name> ran out of memory and stopped. Reload it to try again."
- `server_unresponsive`: "<Name> stopped responding, so DorkOS stopped it."
- `isolation_unavailable`: "<Name> can't run with its limits on this computer."
- Restarting: "Restarting <Name>…" while a backoff restart is pending.

**Author experience.** A refused connection throws `ERR_EXTENSION_NET_DENIED` naming the host and
the manifest key; a refused program names `allow.run`; a write outside `ctx.filesDir` surfaces Node's
`ERR_ACCESS_DENIED` with the path, and the authoring guide maps each error to its fix.

## Testing Strategy

Each test carries a purpose comment. The suites that matter are the ones that can fail when
enforcement silently stops.

- **Unit**
  - Manifest schema: every rule in §1, including `https://` refusal, wildcard apex, loopback without
    port, `externalHosts` with subprocess, dataProxy-only with subprocess, `worker` per Decision 1.
  - `net-allowlist.ts`: matching table (wildcards, ports, IPv6, case, trailing dot, punycode).
  - `permission-coverage.ts`: narrowing/widening table, missing-entry-means-full.
  - `ctx-protocol`: the type-level exhaustiveness (a `// @ts-expect-error` fixture interface with an
    extra member) and the runtime walk of a real ctx.
  - Header policy: inbound strip list, outbound strip and CSP, verdict header cannot be forged (a
    client-supplied `x-dorkos-ext-person` is replaced).
  - Restart policy: backoff sequence, crash budget window, reset triggers.
- **Integration (real child processes, fixtures under `isolation/__tests__/fixtures/`)** — these
  spawn Node, never mock `fork`:
  - **Enforcement probes, each asserting the refusal AND that the same probe succeeds in a control
    child without the restriction** (so a test that cannot fail is caught): read `~/.dork/config.json`,
    write outside `filesDir`, `execSync`, `new Worker`, `process.binding`, `fetch` to an undeclared
    host, `fetch` to a declared host (local test server bound to a declared loopback port),
    `dns.lookup` undeclared, `dgram`, `listen`, DorkOS's own port, a prototype-tampering attempt
    (`String.prototype.endsWith = () => true`) followed by an undeclared connect.
  - Self-check fail-closed: launch with a test seam that omits `--permission`; the host must refuse.
  - ctx conformance: one suite of ctx behaviours (secrets round-trip, settings, storage, emit reaches
    `eventFanOut`, accounts listener fires and is released on stop, advisor timeout falls back,
    inbox `onAction` bound, `agent.send` gated by `allow.agents`, error `code` preserved) run against
    both the in-process ctx and the isolated proxy ctx.
  - Router: JSON body round-trip, raw body, streaming SSE chunks arrive incrementally, client abort,
    child exit mid-response (503 vs destroyed), `requirePerson` refusal body equals in-process.
  - Crash: `process.abort()` in a timer → DorkOS keeps serving other routes, extension restarts, third
    crash leaves `server_crashed`. Hang: `while(true){}` → `server_unresponsive` within 20 s. OOM.
  - RunBroker: allowed program runs and streams; undeclared refused; `cwd` outside refused; programs
    killed on stop.
  - Tools (Phase 6): handler in child, deadline abort reaches the child, crash mid-call answers the
    stopped error and removes the tools.
  - Dev link: edit `server.ts` → new child serves; widen `allow.net` → extension waits for approval.
- **Desktop.** `smoke-packaged.ts` gains a step that starts a fixture isolated extension in the
  packaged app and asserts the self-check passed (`hello.permission` all false) — the proof that
  Electron 41 honours the flags.
- **Windows.** The integration suite runs on the Windows CI job; no user-facing claim about Windows
  isolation until a real install confirms it (the demo-claim gate).
- **E2E.** One Playwright spec: install a fixture isolated extension, the approval card shows its
  hosts, approve, its page loads data through its route. Grep `apps/e2e` for any changed copy first.
- **Mocking.** None for `fork`, the permission model or the guard in the integration tier. Unit tiers
  use the existing `createDataProviderContext` with its service getters stubbed, as
  `extension-server-api-factory.test.ts` does.

## Performance Considerations

- ~40 MB resident and ~100 ms start per isolated extension (one Node process each). Isolation is
  opt-in, so the typical install pays nothing.
- Each `ctx` call is one IPC round trip (sub-millisecond locally); HTTP adds one hop of byte copying.
  Advisor `rank` runs on the session-launch path and is already bounded at 2 s.
- The watchdog ping is one tiny message per 5 s per isolated extension.
- In-process extensions take no new code path: the branch happens after compile.

## Security Considerations

What is enforced, and by what:

| Limit                                 | Enforced by                                              | Strength                                                                                        |
| ------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Crash / OOM / hang stays contained    | separate OS process, heap cap, watchdog                  | Real                                                                                            |
| No DorkOS data, config, secrets, keys | Node fs permission (realpath grants) + scrubbed env      | Real for ordinary code; Node disclaims it against malicious code; symlink escape closed by scan |
| No processes, threads, addons, WASI   | Node permission model                                    | Real for ordinary code; same Node disclaimer                                                    |
| Programs limited to `allow.run`       | host broker; child cannot spawn                          | Real on which program; a permitted program has the person's full authority                      |
| Hosts limited to `allow.net`          | DorkOS guard in the child; its bypasses closed by Node   | Real against ordinary and input-compromised code; not an OS firewall; a Node/V8 bug defeats it  |
| No DorkOS API as the person           | cookie/token stripping, own-port refusal, CSP on replies | Real                                                                                            |
| Agent-driving needs `allow.agents`    | host refuses the call                                    | Real (host is the only path)                                                                    |
| ctx powers it does hold               | host's real ctx, same validation as in-process           | As today                                                                                        |
| Client bundle                         | nothing new                                              | **Not isolated**: runs in the page with the person's session                                    |

Further safeguards: every host-side message handler treats the child as untrusted input (shape,
size, rate); the self-check fails closed, so a platform where the flags are ignored never runs an
"isolated" extension with full rights; approvals cannot widen silently; the declared lists are shown
before approval. Upgrade path, recorded in D2: when the Node floor (and Electron) ship a network
permission, an extension with an empty `allow.net` gets Node's hard deny as well; an OS-level layer
can be added beneath the guard per platform without changing the manifest.

## Documentation

- `contributing/extension-authoring.md`: "Running separately" section — the manifest keys, what each
  limit enforces and does not, `ctx.filesDir`, `assets/`, the error-to-fix table, no sync child
  process calls, no native addons.
- `docs/` extension guide (user-facing, `writing-for-humans`): what "Runs separately" on a card means,
  what it does not cover (screens, permitted programs).
- `contributing/architecture.md`: the isolated runtime beside ADR 0213.
- `packages/extension-api` README/TSDoc for the new manifest keys and `ctx.filesDir`.
- Header comments in `extension-load-policy.ts` and `extension-test-harness.ts` updated to say the
  in-process statement holds for in-process extensions only.
- Changelog fragments per user-visible phase (`changelog/unreleased/`), with `covers:` blocks.
- ADRs promoted from `design-decisions.md` at the end via `/adr:from-spec`; ADR 0213 gains a note
  that it remains the default, not superseded.

## Implementation Phases

Detailed in `03-tasks.md`. In order:

1. **Contract and consent data** — manifest keys and rules, `record.isolation`, config field and
   migration, coverage clause, source key, approval payload. Lifecycle refuses `subprocess` with
   "needs a newer version of DorkOS" until Phase 5.
2. **Consent UI** — approval card, Settings card, marketplace preview, status copy.
3. **Child process and enforcement** — bootstrap, grants, self-check, NetGuard, child_process shim,
   RunBroker, watchdog, restart policy, build entries, packaged and Windows proofs.
4. **`ctx` over the boundary** — protocol table, dispatcher, proxy ctx, errors, reverse calls,
   `allow.agents`, `ctx.filesDir`, conformance suite across both runtimes.
5. **Router and lifecycle** — virtual connections, header policy, `assessPerson`, lifecycle branch,
   crash path, dev-link reload; removes the Phase 1 refusal; docs and the user-facing changelog.
6. **Tools over the boundary** — after DOR-2685 merges.

## Open Questions

1. ~~Worker threads or subprocesses as the enforcement vehicle?~~ (RESOLVED)
   **Answer:** Subprocesses. **Rationale:** the permission model is process-wide and the DorkOS
   server runs without it, so a worker inherits full rights; `process.abort()` in a worker still ends
   DorkOS. Whether the manifest keeps the word `worker` at all is Decision for Dorian 1.
2. ~~Can the network be restricted by Node flags?~~ (RESOLVED)
   **Answer:** Not on Node 24 (`--allow-net` is a bad option; `fetch` succeeds under `--permission`).
   **Rationale:** probed 2026-10-03. Enforcement is the in-child guard, labelled for what it is.
3. ~~Unix socket/named pipe, or HTTP over IPC, for the router?~~ (RESOLVED)
   **Answer:** HTTP over IPC via `createConnection` + `server.emit('connection')`.
   **Rationale:** no listen permission, no filesystem socket path, identical on Windows, real
   streaming.
4. ~~Should `allow.run` use `--allow-child-process` plus a JS check?~~ (RESOLVED)
   **Answer:** No; host broker. **Rationale:** the flag is all-or-nothing; a JS check in the child
   would be the only thing standing between the extension and every program.
5. ~~What does the child read?~~ (RESOLVED)
   **Answer:** bootstrap, its bundle, `<runPath>/assets/` (symlink-scanned), `filesDir`.
   **Rationale:** a whole run path routinely holds pnpm `node_modules` symlinks that leave it, which
   the scan would refuse; a fixed `assets/` grant is deterministic.
6. ~~Gate `ctx.agent`/`ctx.sessions` for isolated extensions?~~ (RESOLVED)
   **Answer:** Yes, behind `allow.agents`. **Rationale:** §5.4; it is the escape route around every
   other limit, and only in a child can the host enforce it.
7. ~~What if packaged Electron ignores `--permission`?~~ (RESOLVED)
   **Answer:** Fail closed via the self-check; Phase 3 proves it in the packaged smoke.
   **Rationale:** a card listing limits nothing enforces is worse than no card.
8. ~~Where does a widened manifest leave an approved extension?~~ (RESOLVED)
   **Answer:** Waiting for approval, with the card leading on what is new. **Rationale:** §2.

## Decisions for Dorian

Two product calls. The spec is written against the recommendation; changing one changes only the
named section.

1. **What does `runtime: "worker"` mean?** (§1)
   - **(A) Reserve it (recommended).** Only `"subprocess"` ships; `"worker"` is refused with "Use
     \"subprocess\": a worker can't be given its own limits." Every isolated extension gets real
     limits, and the manifest never promises what DorkOS cannot keep.
   - **(B) Ship it as crash protection only.** A worker thread in DorkOS, cheaper to start, with a
     memory cap but no `allow.*` (refused under `worker`). The card says "Runs separately, with full
     access". Two kinds of "separate" to explain.
2. **What do approval cards say about access outside the isolated server half?** (User Experience)
   - **(A) Say it on every card (recommended).** In-process extensions: "Runs inside DorkOS with full
     access to this computer." Any extension with screens: "Its screens run in DorkOS with your
     access." Honest about the page half, and makes the isolated option legible by contrast. It
     changes the card every existing extension shows.
   - **(B) Only isolated extensions get a permissions section.** In-process cards stay as they are;
     the page-half caveat lives in the docs. Less change, but the card for an isolated extension
     with screens reads as more contained than it is.

## Related ADRs

- `decisions/0213-directus-style-server-extension-registration.md` — in-process `register(router, ctx)`;
  stays the default.
- `decisions/0214-aes-256-gcm-per-extension-secret-storage.md` — secrets the child must reach only by
  RPC.
- The "full-trust model" ADR 0213 cites as "ADR 204" — the file at that number today is
  `0204-consolidate-sse-connections-into-unified-stream.md`, so the full-trust premise is recorded
  only inside 0213 itself. This spec narrows it for opted-in extensions.
- `decisions/260926-153107-plugin-carried-extension-discovery.md` — where plugin-carried extensions
  come from.
- Draft records for this spec: `design-decisions.md` (D1-D7).

## References

- DOR-2686 (this), DOR-2685 (PR #2519, extension tools and skills), DOR-2683 (`ctx.agent`),
  DOR-2696 (dev link), DOR-516 (approval gate), DOR-1336 (`serverError` vs `status`), DOR-358 (data
  layer).
- Node.js permission model documentation (`--permission`, "seat belt", symlink caveat).
- `research/20260329_extension_server_side_capabilities.md` (Raycast, VS Code, Directus, Chrome
  `host_permissions`), `research/20260326_extension_system_open_questions.md` §Security.
- Deno permission flags (`--allow-net=host:port`, `--allow-run=prog`) as the reference shape.
