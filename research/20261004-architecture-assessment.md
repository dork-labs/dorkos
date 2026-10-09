# Architecture assessment, October 4, 2026

**Public source:** `116297e14f7c357d24010ba34b9ceaa1b44aef99`. **Comparison:** October 1 atlas source `996161118a84f938fe76b6e569ba077dfb7a574a`. Three independent read-only audits covered local lifecycle/runtime delivery, public Cloud/Spaces boundaries, and Projects/extensions/documents/browser foundations. Linear and open PRs were read on October 4. This is an architecture assessment, not a fresh runtime verification or production certification.

**Historical context:** the [October 9 vision-reset assessment](20261009-vision-reset-architecture-assessment.md) supersedes the permanent-topology recommendation below. Separate servers still describe today's implementation, but the accepted direction is one local/hosted program. Doe and production isolated backends have also advanced; preserve the findings below as evidence at their dated source.

## Judgment

Keep the existing topology: the local app owns agent execution, independent Community servers own Spaces content and membership, and optional Cloud services own hosted account/control operations. These are useful authority and failure boundaries. Cloud completion removes a reason to postpone adoption work; it does not remove the boundaries.

The largest remaining architectural debt is **ownership of effects over time**. There are good checks at entry and increasingly good domain-specific recovery stores. The weaker seam is what happens after acceptance: who owns a running task, which generation may finish it, what stops on revocation, and what evidence permits storage closure or a replacement process. This assessment prioritizes those contracts over additional service extraction.

## What changed since the last assessment

| Area                        | Current public source                                                                                                                                                                                                                                       | Consequence                                                                                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credits                     | [Choice ADR](../decisions/261001-000811-credits-are-a-runs-on-choice-not-a-flag.md), [runtime-format ADR](../decisions/261002-221210-codex-and-opencode-run-on-credits-by-request-format.md), PRs #2442/#2495/#2502                                         | A Runs on choice authorizes credits. The environment variable can disable them; it cannot authorize spending. Claude Code, Codex and OpenCode have different payer scopes.                                                        |
| Dynamic extensions          | [Tool binding](../apps/server/src/services/extensions/agent-tools/tool-binding.ts), [registry](../apps/server/src/services/core/capabilities/registry.ts), PRs #2544/#2547/#2548/#2549/#2550                                                                | Tools and skills appear and disappear with the extension. Destructive tools always require a person. Existing chats and background work participate in that lifetime.                                                             |
| Dev links                   | [Serial lane](../apps/server/src/services/marketplace/dev-links/dev-link-lane.ts), PRs #2521/#2527/#2537/#2534/#2542                                                                                                                                        | Owner-approved mutable folders are a distinct trust mode. Changes coalesce through serialized reload/projection, with new executable authority requiring consent.                                                                 |
| Isolated extension backends | [Production lifecycle](../apps/server/src/services/extensions/extension-server-lifecycle.ts), [existing specification](../specs/isolated-extension-backends/02-specification.md), PRs #2551/#2553/#2554                                                     | Consent and child-process foundations are merged. The production start path still returns `isolation_not_ready`; remaining context/lifecycle/tool phases are active work.                                                         |
| Document delivery           | [Grant revalidation](../apps/server/src/services/canvas/doc-channel/grant-revalidation.ts), [runner](../apps/server/src/services/canvas/doc-channel/delivery/runner.ts), root [composition](../apps/server/src/index.ts), PRs #2458/#2464/#2466/#2470/#2471 | Durable document events, grants, delivery and diagnostics are wired. Host-frame generation correlates lifetime; it does not authenticate arbitrary scripts in the document. Native publication/checkbox PRs remain separate work. |
| Relay observations          | [HTTP receipt boundary](../apps/server/src/routes/relay-delivery-receipts.ts), [durable store](../packages/relay/src/delivery-receipt-store.ts), PR #2494                                                                                                   | Eligible HTTP agent deliveries expose accepted/delivered/failed/unknown observations. Receipts do not add durable dispatch, POST idempotency, replay or task-success guarantees.                                                  |
| Managed browser             | [Engine](../packages/browser/src/engine.ts), [egress evidence limits](../apps/server/src/services/browser/egress/broker/README.md)                                                                                                                          | Private fixture/research mechanisms now have substantial generation, authority, quota and cleanup contracts. Production managed-browser activation is not wired.                                                                  |
| Spaces setup                | [Published launcher evidence](../specs/community-self-host-launcher/04-live-gate.md), PRs #2528/#2529                                                                                                                                                       | Setup has more interruption recovery. The recorded disposable-provider gate, pending complete launch-acceptance receipt and any actual deployment remain different evidence.                                                      |

The source review includes the public app and its wire contracts. Private service completion is not imported into public documentation as undisclosed deployment or commercial claims.

## What we got right

1. **Authority follows the data.** A Community server decides membership and content access. Cloud hosting management does not make the control plane a proxy for every channel or archive. OIDC authenticates a person; invitations, claims and memberships still authorize tenant actions.
2. **Execution engines remain replaceable without pretending they are identical.** SDK confinement, runtime capabilities and conformance preserve a common app. Claude launch choice, Codex conversation/home binding and OpenCode sidecar-wide payer mode reflect real engine constraints.
3. **The extension platform has one guarded invocation path.** Contribution registration, tier approval, tool namespaces, skill projection and unload belong to existing owners. Flow uses public extension seams rather than becoming a privileged core workflow engine.
4. **Derived state is increasingly identified honestly.** Local Community mirrors, search indexes and marketplace backups do not become authority merely by existing. Confirmed removal and an unexplained outage have different recovery behavior.
5. **Acceptance is increasingly separated from completion.** Durable session acceptance, document delivery and Relay observations each have a defined boundary. Preserve their differences; a single universal delivery state would discard meaning.
6. **Project identity is independent of worktree location.** Canonical main-checkout identity is useful for account policy and extension orchestration. Reported roots do not grant discovery authority.

## Ranked changes

### 1. Turn lifecycle design into safe handoff behavior

This is the first implementation candidate. [Admin reset/restart](../apps/server/src/routes/admin.ts) catches cleanup failure and starts a successor regardless (`276–299`). [Shared cleanup](../apps/server/src/index.ts) releases the instance lock without claiming complete writer quiescence (`6349–6352`). Startup failure cleanup also awaits fixture/document closure before reporting the initial error (`6397–6411`); rejection can interrupt original-error reporting.

Admission closure is already implemented. It prevents new main-listener work, but does not drain previously admitted work, background tasks, other listeners or external children. A timeout observes uncertainty; it does not cancel a writer.

**First chunk:** select the existing [DOR-2482 laboratory](../specs/shutdown-handoff-outcomes/02-specification.md), using disposable SQLite, the real workspace owner, a second held consumer and fake delete/lock/spawn ports. Prove failed, unknown and timed-out owners grant no resource handoff. Then implement an exclusive terminal-operation owner and adopt one production cohort. Keep original-failure-preserving startup rollback under DOR-2483 and retention ownership under DOR-2484.

**Acceptance:** no deletion, DB close, authority release or successor launch without the required resource-specific evidence; concurrent terminal requests share one winning operation. The lock currently lives inside the reset target, so exclusion during recursive deletion needs its own proof. Availability after an uncertain cleanup must have a deliberate recovery path.

### 2. Make recovery and payer evidence describe the actual failure boundary

Reuse DOR-2349 and existing domain matrices. There is substantial delivered coverage; the next step is reconciling it with newer seams, not writing a parallel broad suite.

- **Credits:** the [runtime ADR](../decisions/261002-221210-codex-and-opencode-run-on-credits-by-request-format.md) explicitly leaves Codex subagent requests untested (`46`). Binary suites can skip when the binary is absent. Extend the existing unpaid fake-endpoint tests to nested work and emit executed/skipped/runtime-version receipts. Prove that missing or rotated credits never bill an alternate payer. This is an evidence gap, not a demonstrated payer escape.
- **Moves:** [local staging](../apps/server/src/services/core/cloud/community-move-upload.ts) is cleaned on boot. Multipart retry survives a network interruption within the held local process; local-server restart requires cancel/start again. Destination-worker restart has different durable progress. Capability expiry, browser loss, local restart and remote restart need separate rows. A restart-safe reissue design would require a public contract proposal, not persisting a secret casually.
- **Revocation/restore:** map installation revocation, disconnected-copy cleanup retry, historical backup restore and erasure-journal reapplication to owners and observable outcomes. Unknown connection inventory intentionally prevents orphan sweeping.
- **Documents/Relay:** document receipts and Relay target observations have different scopes. Verify accepted-then-crash, revocation before claim and unknown settlement at their real composition boundaries. Do not equate delivery with successful agent work.

**First chunk:** a bounded matrix reconciliation with one demonstrated missing executable case per selected boundary. Paid/live verification remains explicitly gated. Any CI change requires the CI Steward protocol; this assessment adds no required check.

### 3. Complete Cloud migration with explicit authority and retirement criteria

Stable instance identity has already been fixed. Do not restart the token-hash proposal or reopen credits selection as unbuilt work.

The public site still has conditional account forwarding/local fallback. [Managed forwarding](../apps/site/src/lib/cloud-accounts/forward.ts) now has a second independent switch. App legacy routes, website compatibility forwarding, current service routes and cron ownership are related but different migration units.

**First chunk:** refresh the DOR-2348/DOR-1798/DOR-2442 route and authority-mode inventory with existing owners. For each route family record the authoritative owner, released callers, compatibility path, job owner and deletion condition. Preserve the required full production release after handover without rollback before retiring local account implementation. Public source alone cannot establish that gate.

Keep DOR-2086's managed remote consumer separate: service command contracts do not supply the missing app enrollment/ingress implementation. Existing tunnel traffic remains its own data path.

### 4. Finish executable-extension isolation, then own reload and delivery composition

DOR-2686 is already active and should finish under its present owner. Current in-process tool deadlines are cooperative: [tool binding](../apps/server/src/services/extensions/agent-tools/tool-binding.ts) schedules a timer and invokes the handler on the same server thread (`373`, `400–401`). A synchronous loop cannot be interrupted by that timer. Permission approval controls the allowed operation; it cannot supply process isolation.

**First acceptance slice:** real production discovery → permission-bound consent → subprocess start → context/tool invocation → hung-child termination → observed exit → contribution removal/restart. Include stale results after unload and permission changes during reload. Child foundations alone do not meet it.

After the active programme converges, extract one existing composition owner where root glue is load-bearing. Document delivery is a good candidate: its runner drains an active pass, while root additionally detaches hints and aborts dispatch preparation. Test the composed owner, not only the runner. Coordinate with the document programme and DOR-2482. Align startup marketplace recovery's Mesh-derived project enumeration with canonical known projects without letting reported roots authorize filesystem cleanup.

### 5. Narrow consumer contracts incrementally

At this baseline `AgentRuntime` is 2,096 lines, `Transport` 3,667 and server root 6,426. These are maintenance signals, not proof of defects.

**Runtime first slice:** DOR-2346's minimal turn-lease lifecycle, replacing response-shaped lock vocabulary while preserving token-matched release, runtime-started ownership, TTL and liveness. The dispatcher already supplies lifecycle objects. Browser disconnect must not become implicit cancellation of durable work.

**Client first slice:** extract domain interfaces behind the existing injected Transport facade. [HttpTransport](../apps/client/src/layers/shared/lib/transport/http-transport.ts) already composes domain method modules. Start with one consumer such as Canvas or Community, and make its mocks implement the needed contract. Preserve FSD direction and one injection point. Avoid a new universal transcript store, transport framework or package per interface.

## Execution order and limits

Select lifecycle laboratory proof first. Recovery reconciliation can proceed independently. Active extension, document, browser and Community owners retain their current work. Cloud inventory can progress now; removal waits for its release/rollback evidence. Interface decomposition follows caller evidence and has lower urgency than unsafe terminal effects.

Linear readback: DOR-2346 remains Triage; DOR-2344/2348/2349/2482/2483/2484/2086/1798 remain In Progress; DOR-2442 Backlog. DOR-2623/2633/2685/2696/2666 are Done. DOR-2686 and the launch-acceptance receipt DOR-2600 remain In Progress. Open PRs include isolated context wiring #2556, sign-in linking #2555, launch evidence #2533, document publication #2522 and checkbox writes #2507. This dated snapshot grants no new readiness and closes no umbrella.

The local-trust posture still cannot distinguish a person from a program that strips its agent header with login off. Existing source documents this; DOR-505 is marked Done, so that status must not be interpreted as cryptographic separation in this posture. Any change needs its own product/compatibility decision. It is not solved by renaming a caller or adding an unverified boolean.

No paid inference, live provisioning, deployment, user messages, source refactor or new tracker work was performed. Code paths, tests and prior receipts were inspected, not freshly executed. The implementation risks above should become focused executable proofs when selected. Historical specs/checkpoints can lag merged source; neither their headers nor issue status alone determines shipped behavior.
