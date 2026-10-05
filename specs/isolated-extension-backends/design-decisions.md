# Design decisions: isolated-extension-backends

Draft decision records seeded at SPECIFY (spec `isolated-extension-backends`, DOR-2686). They live
here, not in `decisions/`, until the spec is implemented; `/adr:from-spec` promotes the ones that
still hold, applying the significance rubric. Each follows the `/flow` draft-ADR shape.

**Promoted (2026-10-05).** All seven still hold and are accepted ADRs in `decisions/`: D1
`261005-105209` (amends 0213), D2 `261005-105210`, D3 `261005-105211`, D4 `261005-105212`, D5
`261005-105213`, D6 `261005-105214`, D7 `261005-105215`. The ADRs record what shipped where it
moved from these drafts (two read grants on a staged run folder; an allowlist of reply headers;
tool handlers as `reverse` members). These drafts are kept as the history.

---

## D1. Isolated server halves run as one Node subprocess per extension under the permission model

**Status:** Draft (extracted from spec: isolated-extension-backends)

### Context

ADR 0213 runs `server.ts` in the DorkOS process with full authority. A marketplace and extensions
that parse hostile input (the mail extension) need crash isolation and enforceable limits. Node's
permission model is process-wide, and the DorkOS server itself cannot run under it, so a worker
thread inherits the server's full rights; `process.abort()` in a worker still ends DorkOS.
`isolated-vm` breaks every Node library and adds a native addon.

### Decision

An extension that declares `serverCapabilities.runtime: "subprocess"` runs in its own Node process,
forked with `--permission`, realpath read grants for its bootstrap, bundle and `assets/`, a
read-write grant for its own files folder, a heap cap, and a scrubbed environment. Child processes,
workers, addons, WASI and the inspector are never granted. In-process stays the default.

### Consequences

#### Positive

- Crash, OOM and hang stay in one extension; DorkOS restarts it with a budget.
- Filesystem and process limits are enforced by Node, not by the code they restrict.
- One process per extension gives each its own permission set.

#### Negative

- ~40 MB and ~100 ms per isolated extension.
- Node disclaims the model against deliberately malicious code; this is containment for honest and
  input-compromised code, not a hostile-author sandbox.
- Packaged Electron must be proven to honour the flags (D7 covers the failure case).

---

## D2. The network allowlist is a DorkOS guard inside the child, labelled for what it is

**Status:** Draft (extracted from spec: isolated-extension-backends)

### Context

Node 24 has no network permission: `--allow-net` is a bad option and `fetch` succeeds under
`--permission` (probed 2026-10-03). OS sandboxes are per-platform (and deprecated on macOS); an
egress proxy only covers clients that honour it.

### Decision

Before extension code loads, the child bootstrap wraps `net.Socket.prototype.connect` (which
`net`, `tls`, `http(s)`, `http2` and `fetch` reach), every `dns` entry point, `dgram.createSocket` and
`net.Server.prototype.listen`, using captured intrinsics. Connections go only to `allow.net`
host:port matches; DNS resolves only matching names and refuses rebinding to private addresses;
DorkOS's own port is always refused. The guard's escape routes (`process.binding`, addons, child
processes, workers) are closed by the permission model. UI and docs never call this a sandbox.

### Consequences

#### Positive

- Hostname-accurate, cross-platform, no extra binary.
- Real against ordinary code and code compromised through its input.

#### Negative

- Not an OS firewall: a missed builtin path or a Node/V8 bug defeats it.
- Upgrade path recorded: Node's network permission (when the floor has it) for empty lists, and an
  OS layer beneath the guard per platform, without changing the manifest.

---

## D3. `allow.run` is enforced by a host-side broker; the child cannot spawn

**Status:** Draft (extracted from spec: isolated-extension-backends)

### Context

`--allow-child-process` is all-or-nothing. A JS check inside the child, with the flag on, would be
the only thing between the extension and every program.

### Decision

The child has no spawn right. Its `child_process` resolves to a shim whose `spawn`/`execFile`/`exec`
send requests to the host, which runs only declared programs, by resolved absolute path, with
`shell: false`, a `cwd` inside the extension's files folder or one of its projects, at most 8 at
once, all killed when the extension stops. Synchronous forms are refused.

### Consequences

#### Positive

- Which program runs is enforced by code the extension cannot touch.

#### Negative

- A permitted program has the person's full authority; shells and interpreters mean "anything". The
  card says so.
- `execSync`-style code must move to async forms to run isolated.

---

## D4. The router is reached by real HTTP carried over the IPC channel

**Status:** Draft (extracted from spec: isolated-extension-backends)

### Context

The extension's Express router must stay at `/api/ext/<id>/*` with streaming intact. A Unix socket
or named pipe needs a listen permission and a filesystem path, and differs on Windows. Serializing
requests by hand reimplements HTTP badly.

### Decision

The child runs an `http.Server` that never listens; the host proxies each request with
`http.request({ createConnection })` over a virtual `Duplex` whose bytes travel as IPC frames, fed to
the child via `server.emit('connection')`. The host strips cookies, authorization and `x-dorkos-*`
headers inbound, adds a host-computed person verdict, strips `set-cookie`/HSTS/CORS outbound, and
adds `content-security-policy: sandbox`.

### Consequences

#### Positive

- Real HTTP/1.1 semantics, SSE included; nothing listens; identical on every platform.
- The person's session never reaches extension code (a leaked cookie would work through the tunnel).

#### Negative

- An extension that read cookies or the `Authorization` header in-process must use
  `ctx.requirePerson` instead when isolated.
- The host re-encodes bodies `express.json` already consumed.

---

## D5. One protocol table carries `ctx`, exhaustive by type, dispatching into the real ctx

**Status:** Draft (extracted from spec: isolated-extension-backends)

### Context

`DataProviderContext` mixes async calls, fire-and-forget emits, listener registrations, host-called
callbacks that return values (advisor, `inbox.onAction`, DOR-2685 tool handlers), constants and an
Express middleware. DOR-2685 and the data layer add members; a member that silently fails to cross
would ship broken.

### Decision

The host builds the extension's real ctx with `createDataProviderContext` and dispatches child
messages into it. `CTX_PROTOCOL` declares each member's kind (`const`, `call`, `emit`, `subscribe`,
`reverse`, `local`) and `satisfies ProtocolFor<DataProviderContext>`, so a new member without an
entry is a type error; a runtime walk of a real ctx backs it. Errors cross by `name`/`code`. For
isolated extensions only, `agent.send`, `agent.subscribe` and `sessions.start` require
`allow.agents: true`, because an agent can run commands and the host is now the only path.

### Consequences

#### Positive

- Behaviour parity by construction: validation, tracking, release and dispose are the same code.
- New ctx members are a forced, reviewable decision.

#### Negative

- Reverses DOR-2683's "no manifest gate" for isolated extensions (kept for in-process).
- Every call is an IPC round trip.

---

## D6. An approval covers a declared permission set; widening asks again

**Status:** Draft (extracted from spec: isolated-extension-backends)

### Context

An update from the same approved source keeps its approval, and a path-bound approval survives
edits. Declared lists would otherwise widen silently.

### Decision

Operator-only config `extensions.approvedPermissions[id]` records the set a person approved. A
missing entry means the full in-process set (every existing approval was for full authority).
`mayRunExtensionCode` requires the declared set to be covered by the approved one. Narrowing never
asks; widening parks the extension in the existing approval queue with a card that leads on what is
new.

### Consequences

#### Positive

- Declared lists mean what the person saw.
- Moving an approved extension to `subprocess` costs nothing.

#### Negative

- A config field and migration; a dev-link author widening `allow.net` sees one card.

---

## D7. Fail closed when isolation cannot be confirmed

**Status:** Draft (extracted from spec: isolated-extension-backends)

### Context

Packaged desktop runs the server in Electron's `utilityProcess`; whether Electron 41's Node honours
`--permission` in run-as-node mode is unverified, and a future fuse change could disable run-as-node.

### Decision

The child's first message reports `process.permission` probes; the host refuses unless the model is
present and every withheld capability reads as denied. A refusal leaves the extension off with
`isolation_unavailable`. There is no fallback to in-process. The packaged smoke test proves the
desktop path.

### Consequences

#### Positive

- No extension ever runs "isolated" with full rights.

#### Negative

- On a platform that cannot isolate, an isolated extension does not run at all until fixed.
