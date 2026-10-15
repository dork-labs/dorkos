---
slug: request-classifier
id: 261015-144648
created: 2026-10-15
status: specified
---

# One request classifier and the registration-policy seam (F0)

**Status:** Approved (scope set by DOR-2965, plan and ADR approved by Dorian 2026-10-15)
**Author:** DorkOS (agent)
**Date:** 2026-10-15
**Ticket:** DOR-2965, a child of DOR-2932
**Decision:** ADR [261015-125850](../../decisions/261015-125850-this-computer-and-other-devices.md) (amends 0320), rules 1 and 4
**Plan:** [`plans/2026-10-accounts-and-devices.md`](../../plans/2026-10-accounts-and-devices.md), step F0

There is no `01-ideation.md`: the ticket, the plan and the ADR already read as a design, and this spec adapts them.

## Overview

Two small, pure answers every later login step builds on:

1. **Where did this request come from?** One classifier names every request as `this-computer`, `other-device`, `relayed` or `hub`, and records the route it came in by.
2. **May an owner-less sign-up happen here?** One function names the registration mode for a request: `local-open`, `setup-code`, `provisioned` or `closed`.

F0 builds both, tests them against every caller kind, and wires them only where the ticket needs them. **What the gate does with the answer does not change here.** The gate sweep is F1 (DOR-2967); setup codes are F5 (DOR-2968); hub mode is A2 (DOR-2934).

## Background / Problem Statement

Today "is this caller local" is `isLocalCaller` (`lib/caller-authority.ts`): loopback TCP peer plus loopback `Host`, with a `DORKOS_ALLOW_INSECURE_BIND` shortcut and a managed-ingress override. Its own comments name the hole: a same-host proxy that rewrites `Host` to `localhost` (default nginx `proxy_pass`, `ngrok --host-header=rewrite`, cloudflared `httpHostHeader`, `ssh -L`) reads as local. That is safe today only because login is global. ADR 261015-125850 retires the global switch, so the hole must close first.

Registration today is one hook (`services/core/auth/index.ts`, `databaseHooks.user.create.before`): open while the `user` table is empty, closed after. It does not know where the request came from, and A2 needs a third answer (the owner comes from provisioning).

## Goals

- One pure classifier with the four kinds, the forwarding-header rule, the `Origin`/`Referer` rule, no insecure-bind shortcut, and a hub posture.
- Every request carries the route it arrived by, so F4's route binding (ADR rule 5) can read it: `local`, `wifi`, `own-tunnel`, `managed`, `relay`, `hub` or `network`.
- The person's own ngrok tunnel enters through a marked loopback ingress, as managed remote access already does.
- One registration-policy function, decided per request, consumed by the sign-up hook with today's behavior kept.
- The public `cloud-api` contract says what `authEnabled` means under the new model, before the DorkOS Cloud twin (CLD-389) starts.
- Tests for every caller kind named in the ticket, including Docker with an owner.

## Non-Goals

- Changing any gate, refusal or route's behavior because of the new kind (F1, DOR-2967). `isLocalCaller` keeps its meaning, its insecure-bind shortcut included, until F1 replaces it.
- Setup codes (F5, DOR-2968), the Docker warning and the image default change (F5).
- Hub mode itself and how provisioning creates the owner (A2, DOR-2934).
- The one-time "Ask for a password on this computer too" banner. The setting it names does not exist until F1, and a banner pointing at a missing setting would be a false claim. F0 logs one warning instead and exposes the reason; F1 adds the banner beside the setting.
- Naming the minimal-proxy residual in `docs/self-hosting/reverse-proxy.mdx` and `threat-model.mdx`. The docs describe the gate, and the gate changes in F1, so the docs change there.
- The ADR: already written and approved as 261015-125850 (PR #2906).
- Route binding on sessions (F4, inside B3), the Wi-Fi level, the remembered network.

## Technical Dependencies

- Node `node:async_hooks` `AsyncLocalStorage` (built in), to carry the request's class into Better Auth's database hook.
- `@ngrok/ngrok` `forward({ addr })`, unchanged; only the address it forwards to moves.
- No new packages.

## Detailed Design

### 1. Ingress marks (`services/core/remote/ingress-mark.ts`)

Today the file marks one thing: managed. It grows to name the listener a request came in on:

```ts
/** The listener a request came in on, beyond the main one. */
export type IngressKind = 'managed' | 'own-tunnel' | 'wifi' | 'relay';

export function markIngress(req: IncomingMessage, kind: IngressKind): void;
/** The ingress that admitted this request, or `'direct'` for the main listener. */
export function ingressOf(req: IncomingMessage): IngressKind | 'direct';
```

`isManagedIngress` stays as the managed activity count's question (`ingressOf(req) === 'managed'`). `markManagedIngress` becomes `markIngress(req, 'managed')`. A `WeakMap` replaces the `WeakSet`, so nothing outlives the request.

- **`managed`**: set by the managed ingress, as today.
- **`own-tunnel`**: set by the new own-tunnel ingress (section 3).
- **`wifi`**: set for every request and upgrade the Wi-Fi listener (`services/core/lan-access`) takes from a non-loopback peer. A loopback peer is never marked: the Wi-Fi listener binds every interface while the main one binds `localhost` (`::1` alone on macOS), so a client dialing `127.0.0.1` lands on the Wi-Fi listener and is still this computer.
- **`relay`**: reserved for B2 (DOR-2946), which marks what the session relay carries. Nothing sets it in F0.

### 2. `RequestFacts` (`http/request-facts.ts`)

`managedIngress: boolean` becomes `ingress: IngressKind | 'direct'`, read by `honoRequestFacts` through `ingressOf`. Every reader moves (`isLocalCaller`, the extension bridge, tests); the managed check reads `facts.ingress === 'managed'`. Upgrades are not classified in F0; F1 builds the same facts for them when the gate moves onto the classifier.

### 3. The own-tunnel ingress (`services/core/remote/own-tunnel-ingress.ts`)

A loopback listener of its own, like the managed ingress but with no edge proof (an own ngrok tunnel has none):

- listens on `127.0.0.1` at a free port, opened when the own tunnel starts, closed when it stops;
- marks every request and upgrade `own-tunnel`, then hands requests to the front door's listener and upgrades to the main server's upgrade router;
- `TunnelManager` points `ngrok.forward({ addr })` at this port **when the tunnel targets this server's configured port** (`DORKOS_PORT`; production, where the server serves the app). Both ngrok ingresses are attached once the main listener is up; boot starts the own tunnel after that.
- While an own ngrok listener refused to close (`byoUnclosed`), the ingress stays open: closing it would free its port for whatever binds there next, and make that public. Every close goes through one guard.

When the tunnel targets another port (the Vite dev server in development, or an operator's `TUNNEL_PORT`), the front door cannot serve that target, so the tunnel forwards there directly, as today. Those requests still classify as `other-device` because ngrok adds `X-Forwarded-For` (rule 4 in section 4). The spec names this, so nobody reads the ingress as covering dev.

### 4. The classifier (`lib/request-classifier.ts`)

Pure. Takes facts, never a framework request:

```ts
export type RequestKind = 'this-computer' | 'other-device' | 'relayed' | 'hub';
export type RequestRoute =
  'local' | 'wifi' | 'own-tunnel' | 'managed' | 'relay' | 'hub' | 'network';
export type OtherDeviceReason =
  | 'ingress' // arrived through own-tunnel, managed or Wi-Fi
  | 'peer-not-loopback' // TCP peer is another machine (Docker bridge, LAN, non-loopback bind)
  | 'host-not-loopback' // Host names something else (a public name, DNS rebinding)
  | 'forwarded' // a proxy forwarding header is present
  | 'foreign-origin'; // Origin or Referer names another site

export interface RequestClass {
  kind: RequestKind;
  route: RequestRoute;
  /** Set only when kind is 'other-device': the first rule that decided it. */
  reason?: OtherDeviceReason;
}

export type ServerRole = 'computer' | 'hub';

export function classifyRequest(
  facts: Pick<RequestFacts, 'peerAddress' | 'headers' | 'ingress'>,
  role: ServerRole
): RequestClass;
```

Rules, in order (first match wins):

1. **Hub.** `role === 'hub'` ⇒ `{ kind: 'hub', route: 'hub' }`. A hub has no "this computer" at all.
2. **Relay.** `ingress === 'relay'` ⇒ `{ kind: 'relayed', route: 'relay' }`. A relayed caller is never a person at this computer (ADR 261015-042933 rule 5).
3. **Marked ingress.** `own-tunnel`, `managed` or `wifi` ⇒ `other-device`, reason `ingress`, route = the ingress.
4. **Forwarding headers.** Any of `X-Forwarded-For`, `Forwarded`, `X-Real-IP`, `Via`, `X-Forwarded-Host` present, even empty ⇒ `other-device`, reason `forwarded`, route `network`. A proxy adds these; a local caller never does; an attacker cannot strip what the proxy adds. (`X-Forwarded-Proto` alone is not on the list: it carries no address and the local desktop shell never sends it either, so adding it buys nothing the five do not.)
5. **Peer.** TCP peer not loopback ⇒ `other-device`, reason `peer-not-loopback`, route `network`. **No `DORKOS_ALLOW_INSECURE_BIND` shortcut**: a browser in Docker arrives from the bridge gateway and is another device.
6. **Host.** `Host` not loopback ⇒ `other-device`, reason `host-not-loopback`, route `network`.
7. **Origin / Referer.** An `Origin` that is present and not a loopback origin, or (with no `Origin`) a `Referer` whose origin is not loopback ⇒ `other-device`, reason `foreign-origin`, route `network`. The literal `Origin: null` is not loopback. Browser writes through a proxy always carry the public `Origin`, which is what this catches.
8. Otherwise ⇒ `{ kind: 'this-computer', route: 'local' }`.

"Loopback" reuses `isLoopbackPeer`, `isLoopbackHostHeader` and `isLoopbackHost` from `lib/trusted-origins.ts`, so the classifier and today's guards cannot disagree on what loopback is. A desktop window's own origin (`app://`, `file://` or the dev renderer) needs a check: the classifier must not call the desktop shell another device. Section 7's tests pin each origin the shell sends today.

### 5. The one warning (`lib/request-classifier.ts`)

`noteForeignOrigin(facts, class)`: the first time in a process that a request classifies `other-device` for reason `foreign-origin`, log one `warn` line naming only the page's origin (never a `Referer`'s path or query, where an invite link or an OAuth code can sit): DorkOS looks like it is behind a proxy that forwards no headers, and other-device rules will apply to it once F1 ships. Called from the session gate's existing read of the request; it changes no answer. F1 adds the banner and the setting.

### 6. The registration-policy seam (`services/core/auth/registration-policy.ts`)

```ts
export type RegistrationMode = 'local-open' | 'setup-code' | 'provisioned' | 'closed';

export interface RegistrationFacts {
  /** The request's class; hub provisioning (A2); or other code in this process. */
  caller: RequestClass | 'provisioning' | 'in-process';
  /** Whether any account exists. */
  hasUsers: boolean;
  role: ServerRole;
}

export function decideRegistration(facts: RegistrationFacts): RegistrationMode;
export function registrationAllowed(mode: RegistrationMode, caller: RegistrationCaller): boolean;
```

Rules, in order:

1. `hasUsers` ⇒ `closed` (today's rule), on a hub too.
2. `role === 'hub'` ⇒ `provisioned`. Only hub provisioning may create the owner; every sign-up request is refused.
3. `caller === 'provisioning'` (anywhere but a hub) ⇒ `closed`.
4. `caller === 'in-process'` or `caller.kind === 'this-computer'` ⇒ `local-open`.
5. `caller.kind === 'other-device'` ⇒ `setup-code`.
6. Otherwise (the relay, which is never a person; a hub-kind request on a computer) ⇒ `closed`.

**How A2 creates a hub's owner.** Provisioning runs `withRegistrationCaller('provisioning', () => auth.api.signUpEmail(…))`. `registrationAllowed('provisioned', 'provisioning')` is the one allow in that mode, so the owner goes through Better Auth (password and account records included) with no table writes by hand. A2 decides the provisioning inputs; the seam is ready.

**Carrying the class to the hook.** Better Auth's `user.create.before` hook sees no socket. `http/better-auth.ts` classifies the request and runs `auth.handler` inside `withRegistrationCaller(class, fn)`, an `AsyncLocalStorage` scope (which also takes `'provisioning'`); the hook reads `currentRegistrationCaller()`. With no scope the call came from no network request (a test, or server code calling `auth.api` directly) and is `'in-process'`. Every network path into Better Auth goes through that one mount, and a test pins that the mount sets the scope. The CLI's `dorkos auth` uses its own instance and hook (`packages/cli/src/commands/auth-instance.ts`) and is untouched.

**Enforcement in F0 keeps today's behavior:**

| Mode          | The hook in F0                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `closed`      | refuse with `REGISTRATION_CLOSED`, exactly as today                                                                   |
| `provisioned` | refuse with `REGISTRATION_CLOSED`, except the `provisioning` caller (no hub exists in F0, so nothing reaches it)      |
| `local-open`  | allow, stamp `owner`                                                                                                  |
| `setup-code`  | allow, stamp `owner`, as today. F5 (DOR-2968) requires the code here, after ADR rule 11's one release of loud warning |

**The server role.** `lib/server-role.ts` exports `currentServerRole(): ServerRole`, returning `'computer'`. It is the one place A2 sets `'hub'`; every caller of the classifier and the policy reads it there, so hub mode turns both on at once.

### 7. Code structure

| File                                                         | Change                                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------- |
| `apps/server/src/lib/request-classifier.ts`                  | new: classifier, labels, one warning                                 |
| `apps/server/src/lib/server-role.ts`                         | new: `ServerRole`, `currentServerRole`                               |
| `apps/server/src/services/core/remote/ingress-mark.ts`       | `IngressKind`, `markIngress`, `ingressOf`                            |
| `apps/server/src/services/core/remote/own-tunnel-ingress.ts` | new: the marked loopback listener                                    |
| `apps/server/src/services/core/remote/tunnel-ingresses.ts`   | new: builds both ngrok ingresses for `TunnelManager.attachIngresses` |
| `apps/server/src/services/core/tunnel-manager.ts`            | forward to the own-tunnel ingress for the server's port              |
| `apps/server/src/services/core/lan-access/*`                 | mark Wi-Fi requests and upgrades                                     |
| `apps/server/src/http/request-facts.ts`                      | `ingress` replaces `managedIngress`                                  |
| `apps/server/src/lib/caller-authority.ts`                    | reads `facts.ingress === 'managed'`; no meaning change               |
| `apps/server/src/services/core/auth/registration-policy.ts`  | new: the mode, the scope, the reader                                 |
| `apps/server/src/services/core/auth/index.ts`                | the hook asks `decideRegistration`                                   |
| `apps/server/src/http/better-auth.ts`                        | runs the handler inside the scope                                    |
| `packages/cloud-api/src/seats.ts`                            | `authEnabled` description                                            |

`apps/server/src/index.ts` is over the 500-line ratchet and must not grow: wiring there replaces lines, never adds them.

### 8. The `cloud-api` contract (`packages/cloud-api/src/seats.ts`)

`AgentClaimRequestSchema.authEnabled` keeps its name, type and optionality (a client one release behind keeps working; absent still reads as false). Its meaning changes from "the instance's Require login switch is on" to:

> Whether the reporting instance requires a signed-in person for every request that does not come from this computer itself. With `hasUsers`, this is the exposure predicate: other devices must sign in, and there is an owner to sign in as.

An instance before F1 reports its login switch, which is exactly that fact on those versions. An instance after F1 reports `true`, because other devices always sign in there. The private side's predicate (`authEnabled && hasUsers`) keeps its form; CLD-389 updates its own reading and docs. No private detail appears in this repo.

## User Experience

Nothing a person sees changes in F0. One log line can appear (section 5). Sign-up, sign-in, the tunnel, Wi-Fi access and managed remote access behave as before; the tunnel's traffic now enters by a second loopback port, which nobody sees.

## Testing Strategy

Unit tests, each with a purpose comment.

**Classifier (`lib/__tests__/request-classifier.test.ts`)**, one table row per caller kind the ticket names, asserting kind, route and reason:

| Caller                                                                                           | Expected                                 |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| browser at `localhost`, loopback peer, loopback `Origin`                                         | this-computer, local                     |
| CLI or MCP client on loopback, no `Origin`                                                       | this-computer, local                     |
| desktop shell (each origin it sends)                                                             | this-computer, local                     |
| phone on Wi-Fi (Wi-Fi mark, LAN peer)                                                            | other-device, wifi, ingress              |
| own tunnel through its ingress (loopback peer, public `Host`)                                    | other-device, own-tunnel, ingress        |
| own tunnel through its ingress with `Host` rewritten to localhost                                | other-device, own-tunnel, ingress        |
| managed remote access                                                                            | other-device, managed, ingress           |
| relayed (relay mark)                                                                             | relayed, relay                           |
| any request on a hub                                                                             | hub, hub                                 |
| non-loopback bind, LAN peer                                                                      | other-device, network, peer-not-loopback |
| Docker browser: bridge-gateway peer, insecure bind set                                           | other-device, network, peer-not-loopback |
| Docker with an owner: CLI inside the container (loopback peer and `Host`, no forwarding headers) | this-computer, local                     |
| same-host proxy with `X-Forwarded-For` (each of the five headers, and an empty value)            | other-device, network, forwarded         |
| same-host proxy with no forwarding headers, `Host: 127.0.0.1:4242`, public `Origin`              | other-device, network, foreign-origin    |
| the same with only a public `Referer`                                                            | other-device, network, foreign-origin    |
| `Origin: null` on loopback                                                                       | other-device, network, foreign-origin    |
| DNS rebinding: loopback peer, `Host: evil.example`                                               | other-device, network, host-not-loopback |
| raw socket from the LAN forging `Host: localhost`                                                | other-device, network, peer-not-loopback |
| IPv6 `::1`, `::ffff:127.0.0.1`, `127.0.0.2` peers                                                | this-computer, local                     |

Plus: the classifier ignores `DORKOS_ALLOW_INSECURE_BIND` (it takes no such input), and `isLocalCaller` still honors it (unchanged behavior, pinned).

**Ingress marks:** a marked request reads back its kind; an unmarked one reads `direct`; the managed activity count still sees only managed requests.

**Own-tunnel ingress (`own-tunnel-ingress.test.ts`)**, on real loopback sockets: a request through it reaches the front door marked `own-tunnel`; an upgrade through it reaches the upgrade router marked; close stops it; `TunnelManager` forwards to it when the target is the server's port and directly otherwise (ngrok mocked at the SDK seam the existing tunnel tests use).

**Wi-Fi marking:** a request through the Wi-Fi listener's handler and its upgrade path is marked `wifi`.

**Registration policy (`registration-policy.test.ts`)**: every row of section 6's rules; the hook allows and refuses exactly as before for `local-open`, `setup-code` and `closed`; a sign-up POST through the mounted handler runs inside the scope (the hook sees the class, not `'in-process'`); a direct `auth.api.signUpEmail` call is `'in-process'`.

**Contract (`packages/cloud-api/src/__tests__/contract.test.ts`)**: the claim still parses with and without the two fields; the description states the new meaning.

The existing suites that read `managedIngress` move to `ingress` and must pass unchanged in meaning: `request-facts`, `managed-ingress`, the extension bridge, the browser registry owner scope.

## Performance Considerations

The classifier is a handful of header reads per request. The own-tunnel ingress adds one loopback hop for tunnel traffic, the same cost managed access already pays.

## Security Considerations

- The classifier is strictly tighter than `isLocalCaller`: everything it calls `this-computer` today's guard also calls local, minus the insecure-bind shortcut, forwarded and foreign-origin requests. Nothing it builds is consulted for an allow in F0.
- The own-tunnel ingress listens on loopback only, so it opens nothing new to the network. Its mark makes own-tunnel traffic `other-device` whatever `Host` it carries, closing `--host-header=rewrite` for the built-in tunnel.
- The registration scope fails toward today's behavior, never past it: no scope means `in-process`, which is reachable only from code in this process.
- Residuals, named for F1's docs: a same-host proxy that forwards no headers and serves a same-origin GET (no `Origin`, no `Referer`) still reads as this computer. Writes are caught by the `Origin` rule.

## Documentation

- This spec.
- `contributing/` gets no new guide in F0; F1 updates the gate guide when the gate reads the classifier.
- No user docs change in F0 (see Non-Goals).

## Implementation Phases

- **Phase 1, the contract (PR 1):** this spec, the manifest entry, and the `cloud-api` description with its contract test. Lands first so CLD-389 can start.
- **Phase 2, the classifier (PR 2):** sections 1 to 5 and their tests.
- **Phase 3, the registration seam (PR 3):** section 6 and its tests.

## Open Questions

- ~~**Does F0 show the "Ask for a password on this computer too" banner?**~~ (RESOLVED) **Answer:** No; F0 logs one warning and F1 adds the banner. **Rationale:** the setting it names arrives in F1, and a banner pointing at nothing is a false claim.
- ~~**What does a call with no request scope count as?**~~ (RESOLVED) **Answer:** `in-process`, treated as this computer. **Rationale:** only code in this process can make one; failing closed would break every test that signs up directly and protect nothing a network caller can reach.
- ~~**Does the own tunnel go through the ingress in development?**~~ (RESOLVED) **Answer:** No; only when it targets the server's own port. **Rationale:** in development the app is on the Vite server, which the front door does not serve; ngrok's `X-Forwarded-For` keeps that traffic `other-device`.
- ~~**Rename `authEnabled` in the contract?**~~ (RESOLVED) **Answer:** No; keep the name and change the description. **Rationale:** a rename breaks a client one release behind, and the private predicate keeps its form.
