---
id: 261120-040300
title: Prove sole-chat handoff after an owned browser launch
kind: hygiene
status: active
actor: agent
gates: [wf.desktop-smoke.packaged-runtime]
prs: [4041]
ratchet-release: []
field-changes: []
---

Per-chat pages left Chrome's startup tab unowned. The unchanged exclusivity guard
correctly refused a lone chat's sign-in handoff. Capture a sole blank, opener-free
startup Page inside an admitted physical launch, before theme probes or leases.
Turn restore off before that launch without removing cookies or Sessions. Consume
the exact identity once after creating the chat's Page, with another admission check
at close dispatch. Existing profiles and ambiguous pages receive no cleanup.

The packaged proof now asserts that each fresh or reopened context contains exactly
the registered chat Page, records launch/page counts and restore preferences, and
retains native visibility, cookie, quit, TCC and plain-window checks. All real Chrome
measurements remain CI-only. No retry, timeout or required-check set changes.

The harness helper also uses a local structural connection type, so its scripts test
does not import the server graph under scripts' stricter TypeScript configuration.
Its four identity/closed-handle tests and scripts typecheck remain enabled.

Host red-first evidence: startup-blank handoff failed while its no-startup control
passed; the no-op cleanup helper failed three tests with six preservation controls
passing. Three host mutations were killed: different blank identity, removed context
identity fence, and initial-page adoption. Exact source hashes were restored.
Revert if cleanup reaches a later, restored or held page, or any identity becomes a
chat grant without the server creating its Page.
