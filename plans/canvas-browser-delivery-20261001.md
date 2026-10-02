# Canvas and browser delivery plan

Prepared 2026-10-01. Flow planning overview, not a frozen specification or canonical DECOMPOSE task list.

## Direction and scope

The operator agreed to the DorkOS-managed Playwright browser direction and a focused engine package inside the monorepo. Validate it with a bounded prototype before freezing production interfaces. The proposed `packages/browser` is a private engine library; server policy, shared contracts, client presentation and executable distribution retain their application homes.

Organize the programme into two separate workstreams under the reopened **Canvas and Browser in Rooms** project, with relay tickets retaining their **Relay, Mesh & A2A** home:

1. **Doc Channel:** durable, granted, two-way application events and independent live document state. Use LifeOS as the first consumer.
2. **Managed browser:** persistent profiles, clean contexts, independent unattended agent browsers, optional viewing, shared control and no separate Chrome app icons.

The browser engine is not a prerequisite for Doc Channel. Doc Channel must work with the existing content surfaces; application events and browser automation have different authority and durability requirements. Keep them as distinct Flow specs and delivery histories. Shared frame/identity decisions must be reconciled at their integration boundary.

Sources: [Doc Channel specification](../specs/doc-channel/02-specification.md), [source audit](../specs/doc-channel/04-source-audit.md), [Flow routing](../specs/doc-channel/00-flow-routing.md), [browser ideation](../specs/shared-browser-control/01-ideation.md), [browser research](../research/20261001_shared-browser-control.md).

## Order of work

| Wave                                     | Work                                                                                                                                                                                            | Exit condition                                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 0. Scope and tracker reconciliation      | Fresh Flow/config/WIP/ownership check; reconcile seven existing tickets, avoid duplicate capture, record browser work separately; review Doc Channel draft and define bounded browser prototype | Honest stage/readiness/relations; implementation units with clear acceptance criteria                      |
| 1. Containment and correctness           | DOR-2663 served-document isolation; DOR-2660 namespace ownership/boundary routing; real signed-JSON regression for DOR-2661; corrected DOR-2662 bridge threat model                             | Relevant red-to-green evidence; bridge contract ready for Doc Channel rollout                              |
| 2A. Doc Channel foundation               | Review SPECIFY → DECOMPOSE: schemas/store, declarations/grants, event log, bounded durable outbox, busy-session delivery and receipts, independent live state                                   | Core behavior verified under busy/restart/revoke/duplicate conditions                                      |
| 2B. Managed-browser prototype            | SPECIFY → DECOMPOSE → EXECUTE: local standalone browser/viewer experiment with profile and control gates                                                                                        | Measured findings justify proceeding or show required design revisions                                     |
| 3A. Doc Channel v1 consumer              | Frames/widgets, upstream delivery and agent downstream/state tools; LifeOS transport migration and end-to-end proof                                                                             | User actions and agent replies survive the lifecycle cases in the spec without operator impersonation      |
| 3B. Browser production design and engine | Revise SPECIFY from prototype findings; explicit ADR amendment; engine package, lifecycle, profile persistence, temporary contexts, bounded tooling                                             | Two independent unattended agent browsers work without a viewer; persistent identity/clean mode verified   |
| 4. Browser viewing and sharing           | Optional Browser panel viewer, input, takeover, participant access and room sharing; installation/recovery/distribution                                                                         | Same-page proof across agent/person and clients; acceptable accessibility/input/latency and macOS behavior |
| 5. Authorized Doc extensions             | Doc Channel v1.1 MCP apps/editors/presence and narrow write grant; v2 standalone access/bindings/grant UI; deeper diagnostics; personal-Chrome/TouchID remains outside scope                    | Separate authorized v1.1/v2 specs and tasks                                                                |

Waves are dependency order, not promises of calendar duration or authorization to run every lane simultaneously. Browser prototyping can overlap early fixes/spec refinement. Doc Channel foundation can overlap unresolved frame work, but frame rollout cannot bypass its containment/bridge dependencies.

## Keep the seven tickets independent

- **DOR-2663:** first bounded canvas isolation fix; prove top-level and framed behavior in a real browser.
- **DOR-2660:** preserve agent/doc namespace ownership and match subject boundaries; reserve the new doc principal before exposing relay-based channel routing.
- **DOR-2661:** reproduce signed JSON using the real app/parser/HMAC path before changing it. Independent of Doc Channel's frame transport.
- **DOR-2662:** resolve the threat model first. A secret in the same JavaScript world is not proof that only the shim authored a message. Its corrected contract gates frame rollout.
- **DOR-2665:** existing detailed design already adapted locally; review and reconcile it, then DECOMPOSE. Do not restart ideation or enlarge it with browser replacement.
- **DOR-2664:** document caller authority precisely. If new process/capability restrictions are desired, shape them separately rather than silently expanding the docs task.
- **DOR-2666:** decide the broader Relay HTTP receipt/status contract in IDEATE. Doc Channel has its own explicit outbox/receipt contract and should not wait for unrelated HTTP redesign.

Only actual blockers get typed relations. Refine coarse parent dependencies to specific delivery tasks after decomposition. Separate tickets/PRs preserve independent review and avoid one large canvas/relay/browser change.

## Prototype scope and location

Start in an isolated worktree under proposed `scripts/browser-control-prototype/`, with a real Chromium process, local viewer, input transport and fake authenticated test site. After proving the mechanics, stabilize the engine in `packages/browser` and add a development-only DorkOS integration. The prototype is an experiment, not a promise to retain throwaway code or a reason to bypass production authority.

Acceptance gates:

1. Named profile login survives browser restart; clean context has none of its state; switching back restores the saved profile.
2. Two independent scripted agent workers run concurrently with every viewer closed. Reopening a view sees the current page, not another rendering.
3. Two viewers share one tab; control handoff and human takeover prevent interleaved or queued stale actions.
4. Real mouse/key input, screenshots, console/errors/network, navigation/popups and reconnect all refer to the right tab.
5. Phone input, clipboard/IME, accessibility and tunnel latency are evaluated with measurable acceptance criteria set in the prototype spec.
6. Headless operation has no Chrome Dock/app-switcher icon or focus stealing on the pinned macOS build. Viewing never requires a headed launch.
7. Resource limits, shutdown/crash behavior and executable installation are understood. No real model billing or operator email credentials are needed for initial mechanical proof.

## Sessions and ownership

Use this chat as the programme coordinator and decision record. It maintains the dependency overview and integration contract; it does not compete with workers on their files.

Use separate implementation chats/worktrees for bounded delivery units:

- **Containment/relay fix lane:** one existing issue at a time. DOR-2662 may need its own design-focused context before implementation.
- **Doc Channel lane:** spec/decomposition and then dependency-ordered PR-sized phases. Continue from checked-in spec/task/implementation artifacts.
- **Browser lane:** prototype first; later package/integration phases follow the measured result.
- **Independent review:** separate review context per implementation PR, as required by Flow, before opening a PR.

The three implementation chats are active. The coordinator released three fenced source lanes after DOR-2663 review and PR-head verification converged: Doc foundation, browser prototype and one bounded supporting issue. A healthy merge-group wait does not block an independent supporting issue. Research and independent review proceed in parallel. Direct human assignment permits scoped Flow advancement despite the global queue-ranking cap, with ownership guards intact. Shared ignored Flow journal/run-state writes are authorized; tracked changes remain worktree-owned.

DOR-2663 implementation, independent exact-head review and fresh local/PR-head verification have converged. PR2457 merged through the normal queue at 2026-10-01T21:55:52Z as `d19d3ee73534dc9b69474bedffe9840db74ed931`; Flow DONE succeeded. DOR-2660 is now claimed in its prepared isolated worktree under the coordinator’s capacity refinement. Isolation merge is verified; Doc frame rollout still waits the bridge contract; Relay routing waits namespace ownership. Other supporting tickets are related work rather than blanket foundation blockers.

Before switching contexts, record Done, Next, Open questions and Next command. `03-tasks.json` remains canonical once DECOMPOSE generates it; Linear plans are projections. Do not write a pretend canonical task file against an unfrozen spec.

## Current delivery checkpoint

Supporting scope: DOR-2660, DOR-2661, DOR-2662, DOR-2663, DOR-2664 and DOR-2666, each an independent PR. This lane owns this overview; Doc and browser implementation belong to their respective chats. All validated Doc v1/v1.1/v2 scopes and five browser production requirements are authorized. Personal Chrome and TouchID remain outside scope.

DOR-2663 PR2457 carries reviewed head `882f8aed868f3f5247477bad8f0fa190d31c8ec8`. Fresh 132 server tests, four real Chromium regressions, API generation and `pnpm verify` (42 typecheck/lint and 20 test/build tasks) pass. Independent GPT-6.1 Sol / Medium review reports zero important findings/nits. All PR-head and full merge-group checks passed. Verified merge and Flow DONE are recorded.

DOR-2660 is claimed on `codex/relay-namespace-ownership`, based on pinned main `d19d3ee73534dc9b69474bedffe9840db74ed931`. Its bounded specification and four dependency-ordered tasks passed preparatory contract review, including pre-save active/pending cross-type reservations. Source tasks 1.1–1.3 have worker red/green and mutation proof. Fresh parent verification and independent spec review are underway; initial-start/config-edit and short-wildcard Doc-root findings are corrected with767 focused tests passing. Delayed-unregister identity fencing and nested/sibling outbound HMAC proof are now corrected and independently compliant. Fresh pinned-Node24 integrated focused819 tests pass; affected gate and exact-pushed-head quality review remain pending. Bridge and receipt designs are frozen/decomposed with source tasks pending; signed-JSON design is independently converged, frozen/decomposed and source-unclaimed. DOR-2664 remains ready/unclaimed. Doc retains the next schema/migration window.

Every delegate uses the operator-selected GPT-6.1 Sol / Medium setting. Scoped tracker writes, commit, push, independent pre-PR review, normal queue entry, verified merge, Flow DONE and safe owned cleanup are authorized. No paid inference, personal logins or operator-authored app messages are authorized.

The project ship dial remains person/missing. Explicit scoped human authority permits normal `gh pr merge --auto` after independent review converges on the exact pushed head. Record reviewer identity, verdict and evidence truthfully in Flow REVIEW; preserve all forge protections, verify merge, then Flow DONE. Do not impersonate a person through `flow review --by person`, fabricate reviewer tokens or alter project calibration.

Next: isolation is merged and DONE; resolve namespace review findings, repeat fresh gates, then review the exact pushed head before its PR. Supporting issues remain sequential source scopes. Shared metadata and direct-assignment WIP questions are resolved.

Evidence: `specs/served-document-isolation/04-implementation.md`; source audit: `specs/canvas-relay-supporting/00-preflight.md`. DOR-2663 is merged and DONE; the remaining five supporting scopes are unfinished. Project pulse: 21 of 27 done, 6 open; close-out skipped with reason `rollup-incomplete`.

Doc foundation task1.1 PR2458 verified merged as `e3210be2cb14c823696a213f4df0ab21fa8acdd8` at2026-10-01T22:44:08Z. This does not complete the Doc parent. Doc retains0138 accounting/schema window; supporting receipt source remains unclaimed until explicit handoff. Namespace integrated this verified main with all owned bytes preserved; final affected gates and pushed-head review remain pending.

Independent quality preflight found repeated registration of the same active webhook instance stops its own winner. This bounded lifecycle correction is implemented: active-instance registration is a no-op after ownership checks, with a real signed-inbound red/green regression, mutation proof and exact routing/publication assertions. Independent preflight found no remaining semantic issue in the correction. Parent final focused14files820tests pass; source is handed back and stable. The parent stopped only its superseded Node24 verification tree (exit143); its log is incomplete evidence, not a pass. Fresh final verification and exact-pushed-head review follow the corrected handback.

Namespace final pinnedNode24 affected verification settled0:59quality/build and35test/build tasks pass, including23958server/17597client/2101Relay tests. Task1.4 local verification/evidence preparation complete. Commit/push, independent exact-head quality review, scoped PR, verified normal-queue merge and FlowDONE remain pending; no routing or frame gate release is claimed.
