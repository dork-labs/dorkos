---
slug: isolated-extension-backends
id: 261003-204731
created: 2026-10-03
status: ideation
linearIssue: DOR-2686
---

# Isolated extension backends: a subprocess runtime with declared network and run allowlists

**Slug:** isolated-extension-backends
**Author:** Claude Code (IDEATE stage, /flow)
**Date:** 2026-10-03

---

## 1) Intent & Assumptions

- **Task brief (DOR-2686, verbatim constraints kept):** `server.ts` runs in the DorkOS process with
  the server's own privileges; `extension-load-policy.ts` and `extension-test-harness.ts` say so in
  their headers ("no sandbox, no boundary check"). ADR 0213 accepted that for "trusted,
  developer-authored extensions". A marketplace, and an extension that parses hostile email content,
  change the premise: a crash takes DorkOS down and a compromise has the server's authority.
  **Done when:** an extension can declare `runtime: "worker" | "subprocess"` with `allow.net` and
  `allow.run` lists in its manifest, the host runs it out of process with only those permissions
  (Deno-style permission flags are the reference shape), the Express router is proxied to it, and an
  in-process extension keeps working unchanged. Sequenced after the data layer and tool registration
  (DOR-2685), because both change the `ctx` surface the isolated backend must speak over a boundary.
- **Motivating case:** the LifeOS mail extension (vault `0-System/mail-app/EXTENSION-PATH.md`): it
  parses untrusted mail, so the realistic threat is **benign code compromised through its input**,
  not a malicious author. Built dev-linked (DOR-2696), it gives agents tools (DOR-2685) and sends
  agents messages (DOR-2683).
- **Assumptions:**
  - Single user, single machine; the OS user is the outer trust boundary. Other processes of the same
    OS user are not the adversary.
  - Node floor is `>=22.22.3` (`packages/cli/package.json`); local dev is 24.14.1; the packaged desktop
    server runs inside Electron 41's `utilityProcess` (`apps/desktop/src/main/server-spawn.ts:416`).
  - The server half is what this ticket isolates. The client bundle keeps running same-origin in the
    page (`extension-load-policy.ts` header explains why that is not "just UI").
  - DOR-2685 (`ctx.tools.handle`, manifest `tools`/`skills`) lands first; its handler contract is plain
    JSON in, JSON out, plus an abort signal, written so this ticket can carry it.
  - The data layer (`ctx.data`, spec `extension-data-layer`, DOR-358) is specified but not wired onto
    `DataProviderContext` yet (`extension-database.ts` and `extension-migrator.ts` exist, nothing
    exposes them on `ctx`). The protocol must make adding it mechanical, not block on it.
- **Out of scope:**
  - Isolating the client bundle (iframe or membrane). Named honestly on the approval card instead.
  - `test_extension`'s client-bundle import in the server process (`extension-test-harness.ts`).
  - An OS-level sandbox (macOS `sandbox-exec`, Linux namespaces, Windows AppContainer). Recorded as the
    upgrade path for the network rule.
  - Relay adapter plugins (`relay_reload_adapters`), excluded by `extension-load-policy.ts` already.
  - Requiring isolation for marketplace installs. In-process stays the default and unchanged.

## 2) Pre-reading Log

- `decisions/0213-directus-style-server-extension-registration.md`: in-process `register(router, ctx)`,
  mounted at `/api/ext/{id}/*`; negatives name the crash and CPU/memory sharing, both accepted for
  trusted authors. This ticket revisits that premise for opted-in extensions.
- `apps/server/src/services/extensions/extension-server-lifecycle.ts`: the ONE place server code starts
  (approval gate, compile, `require()` from `{dorkHome}/cache/extensions/server/_run/<id>.js`,
  `register()` with a 15 s `REGISTER_TIMEOUT_MS`, idempotent `buildSourceKey`, `shutdown()` that
  cancels schedules, calls cleanup, releases listeners, and tells inbox and agent-send it stopped).
  Isolation slots in here, behind the same gate, so every start path inherits it.
- `apps/server/src/services/extensions/extension-server-api-factory.ts`: the whole `ctx` surface —
  `secrets`, `settings`, `storage`, `schedule`, `emit`, `extensionId/Dir`, `dorkHome`, `accounts`
  (incl. `onUsage` listener and `registerAdvisor`, an object of host-called callbacks returning values),
  `projects` (incl. `onChange`), `inbox` (incl. `onAction`, a handler returning a result within 5 s),
  `requirePerson` (an Express `RequestHandler`), `projectSettings` (incl. `onChange`), `sessions.start`,
  `agent.send/subscribe` (DOR-2683). Every listener is tracked and released; `dispose()` makes a
  given-up instance inert.
- `packages/extension-api/src/server-extension-api.ts`: the public types. Errors with codes
  (`AgentSendError`, `InboxLimitError`, `InboxLinkError`) are part of the contract.
- `apps/server/src/services/extensions/extension-load-policy.ts`: approval is per artifact (path,
  origin, or digest), stored in operator-only config `extensions.approvedToRun/approvedSources`. An
  update from the same approved source keeps its approval — so today a widened permission set would
  ride an existing approval silently.
- `apps/server/src/services/extensions/extension-compiler.ts:286`: the server bundle is CJS for
  `node20` with `express`, `@dorkos/extension-api`, `@dorkos/extension-api/server` external, "provided by
  the host process".
- `apps/server/src/middleware/extension-routes.ts` + `index.ts:5004`: `/api/ext/:id` delegates to
  `extensionManager.getServerRouter(id)`. `app.ts:292` runs `express.json({ limit: '1mb' })` before it,
  so a JSON body is already consumed by the time a proxy sees it.
- `packages/extension-api/src/manifest-schema.ts`: `serverCapabilities.externalHosts` exists ("declared
  for UI display and future sandboxing") and is surfaced only in the marketplace permission preview
  (`services/marketplace/preview/permission-preview.ts:512`); `permissions` is "reserved".
- `apps/server/src/services/extensions/extension-approval-queue.ts`, client
  `features/inbox`, `widgets/inbox-bell/ui/ExtensionApprovalList.tsx`, `features/extensions/ui/ExtensionCard.tsx`,
  `features/marketplace/ui/PermissionPreviewSection.tsx`: the consent surfaces where declared
  permissions must appear.
- `specs/marketplace-dev-link/02-specification.md` §6: the watcher calls `reloadExtension(id)` on any
  change under `.dork/extensions/<id>/**`; non-goal "Sandboxing dev-linked code (DOR-2686)".
- DOR-2685 spec (PR #2519) §3-5: `ctx.tools.handle(name, handler)`, host-built invoke wrapper with a
  deadline measured after the gate, abort on stop, 256 KB result cap; "a synchronous hang is
  DOR-2686's to solve".
- `research/20260329_extension_server_side_capabilities.md`: Raycast (worker threads in a child
  process, JSON-RPC), VS Code (extension host process), Directus (`isolated-vm`), Chrome
  `host_permissions` (browser-enforced). "If DorkOS adds extension sandboxing in v2, Node.js Worker
  Threads would be the isolation mechanism" — this ideation finds that a worker cannot carry
  per-extension permissions (below).
- `research/20260326_extension_system_open_questions.md` §Security: "permissions are meaningless
  without enforcement" — the bar this design has to clear.

## 3) Codebase Map

- **Primary components/modules:** `services/extensions/extension-server-lifecycle.ts` (start/stop),
  `extension-server-api-factory.ts` (ctx), `extension-load-policy.ts` (approval), `extension-compiler.ts`
  (bundle), `middleware/extension-routes.ts` (routing), `packages/extension-api` (manifest + types).
- **Shared dependencies:** `@dorkos/shared/extension-secrets`, `extension-settings`,
  `extension-approval-schemas`; `eventFanOut`; `getAgentSendService`, `getStartWorkService`,
  `getExtensionInbox`; `refuseIfNotAPerson` (person bar).
- **Data flow:** manifest → discovery record → approval gate → compile → `register(router, ctx)` →
  router mounted → requests via `/api/ext/:id`; ctx calls go straight into host services.
- **Feature flags/config:** `extensions.approvedToRun`, `extensions.approvedSources` (operator-only).
- **Builds:** CLI `packages/cli/scripts/build.ts` (esbuild, one server entry), desktop
  `apps/desktop/scripts/build-server.ts`; an isolated child needs a second bundled entry in both.
- **Potential blast radius:** extension lifecycle, manifest schema (also read by
  `dorkos marketplace validate`), config schema (migration), approval card copy, marketplace preview,
  CLI and desktop builds, docs (`contributing/extension-authoring.md`, `docs/` extension guides).

## 5) Research

### What Node can actually enforce (probed on Node 24.14.1, 2026-10-03)

| Probe under `node --permission --allow-fs-read=<dir>`        | Result                                         |
| ------------------------------------------------------------ | ---------------------------------------------- |
| `node --permission --allow-net`                              | `bad option: --allow-net` — no such flag       |
| `fetch('https://example.com')` with only `--allow-fs-read`   | **200 — network is not restricted at all**     |
| `child_process.execSync`, `new Worker`, `readFileSync(/etc)` | `ERR_ACCESS_DENIED`                            |
| `process.binding('tcp_wrap')`                                | `ERR_ACCESS_DENIED`                            |
| patched `net.Socket.prototype.connect`, then `fetch`         | intercepted (host visible), fetch fails        |
| `dns.lookup`, `dgram.send` after that patch                  | **not intercepted** — need their own guards    |
| `--allow-fs-read=/tmp` on macOS                              | denied: grants need realpaths (`/private/tmp`) |

Also from Node's own permission-model documentation: it is a "seat belt" for trusted code and "does
not provide security guarantees in the presence of malicious code"; symbolic links are followed even
outside granted paths. `--allow-child-process` and `--allow-worker` are all-or-nothing. The model is
process-wide, so a worker thread inside the (unrestricted) DorkOS server cannot be given narrower
rights than its parent.

### Potential solutions

1. **Worker thread per extension (Raycast-style).** Pros: cheap start, `resourceLimits` per worker,
   structured-clone messaging. Cons: shares the server's process-wide permissions — it can
   `require('child_process')` and read everything; `process.abort()` or a native fault still kills
   DorkOS. Permission lists would be theatre.
2. **Subprocess per extension under the Node permission model, with a DorkOS guard for network and a
   host broker for `allow.run`.** Pros: real crash isolation; filesystem, spawning, workers, addons,
   inspector, WASI and `process.binding` denied by Node; a heap cap; the extension's only way to
   DorkOS authority is the ctx RPC the host chooses to answer. Cons: ~40 MB and ~100 ms per extension;
   network enforcement is a JS guard (its escape hatches closed by the permission model, but not an OS
   firewall); packaged Electron must be proven to honour the flags.
3. **`isolated-vm` (Directus).** Pros: strong V8 isolate. Cons: a native addon (rebuild pain the repo
   already pays for with `better-sqlite3`), no Node APIs inside, so every library an author uses breaks;
   no crash isolation from native faults.
4. **OS sandbox (`sandbox-exec`, namespaces, AppContainer).** Pros: real network and fs boundary.
   Cons: three platform-specific implementations, macOS's is deprecated, Windows's is heavy, hostname
   allowlists need a proxy anyway. Right as a later layer, wrong as the first.
5. **Egress proxy only (HTTP(S)\_PROXY with a CONNECT allowlist).** Pros: hostname-accurate. Cons:
   only covers clients that honour the proxy; raw sockets and DNS walk around it. Useful only beside 2.

### Recommendation

Option 2. One Node subprocess per isolated extension, started with `--permission` and only the
fs grants it needs, a heap cap, a DorkOS network guard installed before any extension code runs, a
host-side broker for `allow.run`, and the whole `ctx` carried over the IPC channel by one typed
protocol table that a compile-time check keeps exhaustive. The router runs in the child and is
reached by real HTTP carried over that same channel, so no socket or pipe is opened. The approval
binds to the declared permission set. Every start runs a self-check, and an extension whose
restrictions cannot be confirmed does not start (fail closed). `worker` cannot carry permissions, so
it is a decision for Dorian whether to reserve it or ship it as crash isolation only.

## 6) Decisions

| #   | Decision                           | Choice                                                                    | Rationale                                                                                                                 |
| --- | ---------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Isolation mechanism                | Subprocess per extension, Node permission model                           | Only option where declared permissions are enforced by something other than the code they restrict                        |
| 2   | Network enforcement                | In-child guard backed by the permission model; called that, not "sandbox" | Node 24 has no network permission; the guard's bypass routes are the ones the model closes                                |
| 3   | `allow.run`                        | Host-brokered spawn; child has no spawn right                             | `--allow-child-process` is all-or-nothing, so a per-program list must be checked by the host                              |
| 4   | Router transport                   | HTTP carried over IPC as virtual connections                              | Real Express semantics incl. streaming, no socket/pipe, same on Windows                                                   |
| 5   | `ctx` over the boundary            | One protocol table, compile-time exhaustive over `DataProviderContext`    | DOR-2685 and `ctx.data` add members; a missed member must fail the build, not ship silently                               |
| 6   | Agent-driving powers when isolated | `ctx.agent.send` and `ctx.sessions.start` need a declared `allow.agents`  | An agent can run commands, so these are an escape route; the host is the only path, so the declaration is now enforceable |
| 7   | Consent                            | Approval binds to the declared set; widening asks again                   | Same-source updates keep approval today; without this an update could add hosts silently                                  |
| 8   | Unconfirmable restrictions         | Fail closed                                                               | A card that lists permissions nothing enforces is worse than no card                                                      |
| 9   | `worker` value, card wording       | Decisions for Dorian (see spec)                                           | Product calls: what the manifest promises, and what the card says about the page half                                     |

Next step: SPECIFY.
