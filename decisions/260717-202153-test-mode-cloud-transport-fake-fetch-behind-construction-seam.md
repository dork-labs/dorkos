---
id: 260717-202153
title: Test-mode cloud transport — a DORKOS_TEST_RUNTIME-gated fake FetchLike behind a CloudLinkManager construction seam
status: proposed
created: 2026-07-17
spec: capture-cloud-link-stub
superseded-by: null
---

# 260717-202153. Test-mode cloud transport — a DORKOS_TEST_RUNTIME-gated fake FetchLike behind a CloudLinkManager construction seam

## Status

Proposed

## Context

The Settings → DorkOS account panel's pending→linked flip is real, shipped, and verified (`specs/accounts-and-auth`, `specs/cloud-account-management`), but the offline capture stack (`apps/e2e/capture`) could not photograph it: `CloudLinkManager.startLink()` fetches the real `https://dorkos.ai`, and the flip normally requires a human approving on the live site — neither reachable nor allowed inside the capture sandbox, which by design holds no cloud credentials and must emit zero packets. The process-wide manager was also an eagerly-constructed module singleton (`export const cloudLinkManager = new CloudLinkManager()`), so even though the class already accepted an injectable `fetchImpl`, no composition point existed to inject anything.

## Decision

We fake exactly one thing — the `FetchLike` HTTP transport to `dorkos.ai` — and let everything else run for real, the same honesty model `demo-scenarios.ts` applies to the agent backend. `createFakeCloudLinkFetch()` (`services/runtimes/test-mode/fake-cloud-link.ts`) scripts the four device-flow endpoints in-process with pinned deterministic content (user code `DORK-2F7Q`, account label `Dork Labs`) and a call-counted auto-flip: two `authorization_pending` polls, then the access token — so the real state machine, real token persistence, all four `/api/cloud/*` routes, and the real client panel drive a genuine pending→linked flip offline.

To make that injectable, we reseated the singleton to a construction seam: `initCloudLinkManager(options?)` + `getCloudLinkManager()` (throws `'CloudLinkManager not initialized'` pre-init), mirroring the `get/setWorkspaceManager` accessor-pair precedent. The `configManager` mutable-export pattern was considered and rejected as a foot-gun — a mutable export that is `undefined` until boot, with no pre-init guard. The composition root (`start()` in `index.ts`) owns construction: the `DORKOS_TEST_RUNTIME` branch injects the fake via dynamic `import()` (mirroring `TestModeRuntime`), and the production branch calls `initCloudLinkManager()` with no options — real `fetch`, real defaults, byte-for-byte today's behavior. Production `cloud-link.ts` carries zero test branches.

Unreachability is layered, asserted rather than assumed: **structural** (the fake is reached only by the gated dynamic import, so it is absent from a shipped build's module graph), **runtime** (the factory throws unless the validated `env.DORKOS_TEST_RUNTIME` boolean is true), and **test** (a prod-default-construction test spies `globalThis.fetch` to prove the no-options path uses the real transport, and an import-graph test asserts `cloud-link.ts` / `cloud-link-client.ts` / `routes/cloud.ts` never name the fake module).

Scope: two docs stills (`accounts-pending`, `accounts-linked`) for the MVP, embedded at the two "Linking from Settings" steps of `docs/self-hosting/dorkos-accounts.mdx`; a flip loop is deliberately deferred (see Follow-ups).

## Consequences

### Positive

- The capture pipeline photographs a genuine pending→linked flip with zero packets leaving the process — a stronger offline guarantee than before, since a real `fetch` would previously have escaped the sandbox
- Production behavior is untouched: the seam is a construction refactor; `initCloudLinkManager()` with no options reproduces the old eager singleton exactly, and the pre-init guard turns any ordering bug into a loud, helpful error instead of a silent `undefined` dereference
- The fake's per-`device_code` poll counting makes a future unlink→relink drive deterministic for free
- The seam is the general-purpose injection point any future cloud-transport test double needs — no further production edits required

### Negative

- One more module-singleton accessor pair to know about (three idioms now coexist: `configManager`'s mutable export, `get/setWorkspaceManager`, and this `init/get` pair)
- The fake must track the real device-flow wire contract by hand; a cloud-side contract change surfaces as a broken capture drive rather than a compile error (mitigated by the `satisfies DeviceCodeResponse` check on the code endpoint)
- Routes resolve the manager through `getCloudLinkManager()` on every call — a negligible but nonzero indirection

## Follow-ups for DONE

Recorded here as a pointer for the DONE stage to file as a tracker issue (DECOMPOSE/EXECUTE do not write to the tracker):

1. **The flip loop.** A single `loop` of the in-place pending→linked flip is the more literal, more compelling reading than two stills, but it needs the fake to hold `pending` long enough to record the code and then flip inside the loop window, and it carries marketing weight plus a larger size budget than this spec's size-3 scope justified. The seam and fake make it cheap once scoped: `PENDING_POLLS_BEFORE_APPROVAL` and the interval constants in `fake-cloud-link.ts` are exactly the knobs a loop drive would retune.

## Related

- **`specs/accounts-and-auth` / `specs/cloud-account-management`** — the shipped, verified device flow, `cloud.instanceToken` sensitive-field persistence, and pending→linked lifecycle this decision photographs; none of it changes
- **TestModeRuntime / test-control precedent** (`index.ts` runtime-registration block, `routes/test-control.ts`) — the env-gated, dynamic-import composition-root substitution the seam mirrors
- **`demo-scenarios.ts`** — the honesty template: fake the unreachable dependency only, run everything else for real
