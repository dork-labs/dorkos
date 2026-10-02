---
slug: canvas-bridge-lifetime
number: 261001-201135
created: 2026-10-01
status: ideation
---

# Bound browser bridge reports to their page lifetime

**Slug:** canvas-bridge-lifetime
**Author:** Codex, GPT-6.1 Sol / Medium
**Date:** 2026-10-01

## 1) Intent & Assumptions

- **Task brief:** DOR-2662 needs a corrected trust model and a bounded implementation that prevents stale, unsolicited and oversized page reports from changing another page's state. Its contract gates Doc Channel frame rollout.
- **Assumptions:** The operator selected GPT-6.1 Sol with Medium reasoning for implementation and independent review, overriding Flow tier bindings. This document is preparatory IDEATE→SPECIFY work while global WIP is over capacity; it claims no implementation slot. The coordinating session owns tracker reads/writes through its resolved Linear adapter, stage transitions, estimates and final freeze. Shared ignored Flow project metadata and direct scoped routing are authorized; isolated run state must not reuse the primary checkout journal. All writes here are in the dedicated `codex/canvas-bridge-lifetime` worktree.
- **Assumptions:** Existing server authentication, session access, driver-seat arbitration, opaque served-document sandboxing and separate preview-listener origins remain authoritative. DOR-2663 resolves served-document isolation; this ticket does not substitute for it. `hello` is page protocol readiness, not proof the injected shim authored anything.
- **Out of scope:** Managed browser engine, Doc Channel grants, process allowlists, Relay receipts, arbitrary tools from the page, authenticated shim authorship, trustworthy browser-native screenshots and paid/live personal-account testing.

## 2) Pre-reading Log

- `AGENTS.md`, `REVIEW.md`, `.claude/rules/fsd-layers.md`: preserve architecture, inspect callers, prove guards with tests that fail when removed.
- Installed Flow `commands/flow.md`, `skills/ideating-features/SKILL.md`, `skills/specifying-work/SKILL.md`, canonical templates: draft artifacts do not imply approved scope or completed stages.
- Original `specs/doc-channel/00-flow-routing.md`, `04-source-audit.md`, `plans/canvas-browser-delivery-20261001.md`: same-world closure nonce cannot authenticate shim authorship; generation/provenance gates frame rollout.
- `decisions/260711-143246-devtools-bridge-postmessage-capture-channel.md`: in-page reports travel through the authenticated host, preserve sandboxing, carry potentially sensitive page data.
- `use-devtools-bridge.ts`: current source/origin checks, debounce buffers, lazy imports, driver claims and recordings have different lifetime clocks.
- `devtools-inject.ts`, `devtools-shim.ts`, `devtools-driving.ts`: a static inline script shares the page world; requests and rasterizer source are visible to page listeners.
- `session-devtools.ts`, `devtools-capture-store.ts`, browser-seat handlers, reads and recording: server schemas limit retention; waiters are keyed by request ID to survive canonical session rekeying.

## 3) Codebase Map

- **Primary components/modules:** client canvas `CanvasBrowserContent`, `use-resolved-frame`, `use-devtools-bridge`; server `workbench-serve/devtools-inject`, `devtools-shim`, `devtools-driving`; `session-devtools`, capture store and browser-seat `handlers`, `devtools-reads`, `recording`.
- **Shared dependencies:** `packages/shared/src/schemas.ts`, Transport API, session-event schemas/normalizer/projector, existing WORKBENCH bounds. A pure browser-safe wire validator belongs in shared code and must not pull server-only dependencies into the client.
- **Data flow:** eligible host resolution → sandboxed iframe → untrusted page protocol → host lifetime/correlation/validation → Transport → authenticated route → bounded store/pending request → explicitly page-reported tool result.
- **Feature flags/config:** No new flag or persistent config. Generation is ephemeral, random and host-owned; it is a correlation identifier rather than an authentication credential.
- **Potential blast radius:** All browser read/action/recording tools, room/session previews, multi-window driver claims, canonical first-turn session rekeying, same-document reloads and CSP-blocked previews.

## 4) Root Cause Analysis

1. Open an accepted preview and post `hello`, `batch`, or arbitrary `capture-result` from the page's own script.
2. Delay a capture's lazy rasterizer import, then change the frame source before it resolves.
3. Queue a console batch and change documents within the 300 ms debounce interval.
4. Send oversized arrays or repeated unsolicited `act-result` images during recording.

**Observed vs Expected:** Current source/origin checks accept current-page forgery. Unknown screenshot IDs can overwrite the latest screenshot; delayed requests can reach a newer frame; buffered entries can receive newer document metadata; parent buffers process some input before validating bounds. Expected: page reports remain untrusted, but only eligible current lifetimes and host-issued requests can affect their assigned state, within explicit host limits.

**Evidence:** `use-devtools-bridge.ts:394–418` accepts page-authored protocol/hello; `:359–365` reads current document facts at flush; `:465–469` spreads before capping; `:479–499` accepts unsolicited recording/action data; `:501–530` forwards unknown capture IDs; `:719–727` rereads current frame after import. `devtools-capture-store.ts:358–375` overwrites screenshot before finding a waiter. `session-devtools.ts:114–117` resolves action by request ID alone. `schemas.ts:6389–6394` assumes JSON input when stringifying args. Source line references describe the preparatory baseline, not future implementation.

**Root-cause hypotheses:** High confidence: window identity is mistaken for script identity; lifetime metadata is not captured atomically; response admission lacks a host pending-request table; server-only validation assumptions do not hold for structured-clone input.

**Decision:** Correct the claim and strengthen containment/correlation. Do not promise that current-page forgery becomes impossible.

## 5) Research

1. Same-world nonce or MessageChannel: useful correlation and stale-response controls; cannot prove shim authorship against page code that observes the exchange. Rejected as authentication.
2. Separate execution world or trusted browser capture: stronger provenance, but requires the managed browser/native engine and changes install/runtime scope. Deferred to that programme.
3. Host-owned lifetime plus bounded validated page protocol: achievable in existing architecture; rejects cross-frame, stale and unsolicited reports while honestly retaining page taint. Recommended.

Carry forward the existing 500-console/200-network entry caps, 20,000-character console text/stack, 16,384-character serialized args, 2,048-character URLs/errors, 900,000-character screenshot, 65,536-character outline, server 1,048,576-byte console/network budget, 60 action recording frames and 8 MiB encoded recording cap. Add parent cumulative bounds and request admission before allocation/forwarding.

## 6) Decisions

| #   | Decision          | Choice                                                                          | Rationale                                                   |
| --- | ----------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | Authorship        | All page evidence stays untrusted                                               | Scripts share one world and can imitate the shim            |
| 2   | Lifetime          | Host generation and per-request pinning                                         | Documents, sessions and async work can change independently |
| 3   | Server binding    | Optional generation in existing wire envelopes; strict when a request is bound  | Backward compatibility without downgrading new claims       |
| 4   | Session rekey     | Request ID remains the lookup key; validate expected client/document/generation | Canonical rekey cannot strand a valid response              |
| 5   | Parent validation | Bounded JSON-safe projection before Zod/server transport                        | Cycles and BigInt are legal structured-clone input          |
| 6   | Authority         | Preserve current sandbox/API gates; no page capabilities                        | Reporting does not grant tools or operator authority        |

Independent draft review identified two blocking gaps now incorporated into the specification: finishing recordings must remain lifetime-owned and admission-bounded through asynchronous decoding/encoding/upload, and a new response-injected shim must still activate through the existing ack from an old already-open host. The chosen revision explicitly supports initial legacy shim mode, forbids updated-host downgrade, makes repeated same-generation init idempotent, and separates compressed frame caps from sequential decoded-pixel resource limits. Independent design re-review by `/root/bridge_spec_adversarial` (GPT-6.1 Sol / Medium) converged with no remaining freeze blockers. The design is frozen; no browser evidence is claimed yet.

Next: coordinator projects the frozen specification and nine canonical pending tasks, then advances to implementation only when live ownership/capacity permits.
