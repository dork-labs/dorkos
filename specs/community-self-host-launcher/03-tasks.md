---
slug: community-self-host-launcher
number: 260920-200102
created: 2026-09-20
status: decomposed
last-decompose: 2026-09-20
---

# Guided Community self-host launcher implementation plan

This plan implements the frozen launcher contract in four ordered phases. The canonical machine-readable graph is `03-tasks.json`.

## Phase 1 — Release Artifact and Local Foundation

- [x] **1.1 Publish an immutable Community image and signed release manifest.** Add a Community-specific multi-platform release lane, bind migration compatibility to the tagged SQL corpus, and attach the manifest only after attestations and anonymous digest readback pass.
- [x] **1.2 Add deploy command dispatch and verified release resolution.** Resolve only the exact requested attested version from the packaged CLI; an absent or not-ready manifest stops before consent without any fallback.
- [x] **1.3 Build read-only preflight, launch planning and consent.** Check accounts and capabilities, render one exact plan, and require typed approval before writes.
- [x] **1.4 Add the secure journal, subprocess boundary and secret sink.** Persist only non-secret state and confine every credential-bearing provider response.

## Phase 2 — Provider Contracts and Fixtures

- [x] **2.1 Build the provider contract harness and sanitized fixtures.** Pin every trusted CLI and minimal Fly GraphQL response, then mutate each field the launcher relies on.
- [x] **2.2 Implement the Fly app, secret, Machine and release wrapper.** Return typed stable identities and prove the running digest and applied secret version.
- [x] **2.3 Implement the Neon project and direct TLS wrapper.** Record exact topology IDs while keeping the database URL in memory only.
- [x] **2.4 Implement the private Tigris creation and binding wrapper.** Use minimal Fly GraphQL operations, keep the local session token and raw response in the secret sink, and prove the private bucket's exact app binding independently.

## Phase 3 — Resumable Provisioning

- [x] **3.1 Create and prove the Fly app and private bucket.** Pre-journal intent and accept existing resources only with verifiable run provenance.
- [x] **3.2 Create and prove the Neon database topology.** Use provider identities rather than project-name equality and stop on ambiguous creation.
- [x] **3.3 Import runtime secrets and deploy the pinned one-Machine release.** Stream secrets over stdin, run the immutable image, and verify one healthy Machine.
- [x] **3.4 Complete resume, cancellation and uncertain reconciliation.** Re-read actual provider state, preserve retained resources, and never repeat an unprovable create.

## Phase 4 — Owner Handoff and Release Proof

- [x] **4.1 Add owner handoff and applied bootstrap-secret rotation.** Keep account creation in Community and prove replacement secrets are active before handoff.
- [x] **4.2 Package the launcher and document guided and manual operations.** Prove the installed CLI outside a checkout and keep the manual recipe as an auditable fallback.
- [ ] **4.3 Add the separately armed credentialed release gate.** Exercise the exact release across all three providers with explicit spend gates and verified cleanup.

## Dependency graph

```text
1.1 → 1.2 ─────────────────────────────┐
1.3 ───────────────┬→ 3.1 ─┐           │
1.4 → 2.1 ─┬→ 2.2 ┤       ├→ 3.3 → 3.4 → 4.1 → 4.2 → 4.3
            ├→ 2.3 ┴→ 3.2 ┘           │
            └→ 2.4 ─────→ 3.1         │
                                      │
1.2 ──────────────────────────────────┘
```

The release lane, read-only planning, and secure journal can begin together. After the shared contract harness exists, the three provider wrappers can proceed in parallel. Fly/Tigris provisioning and Neon provisioning can then proceed in parallel; secret import and deployment join both paths and the verified release digest. The owner handoff, packaged proof, and credentialed gate form the final critical path.
