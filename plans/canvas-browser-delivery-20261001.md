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

Three fenced source lanes are authorized: Doc foundation, browser implementation and one bounded supporting issue. One writer owns each checkout. Research and independent review can run in parallel. A healthy CI or merge-group wait permits the next independent supporting issue after the current source and exact pushed-head review converge; a real production review delta pauses the next writer. Direct human assignment permits scoped Flow advancement despite the global queue-ranking cap, with ownership guards intact. Shared ignored Flow journal/run-state writes are authorized; tracked changes remain worktree-owned.

Isolation and namespace are verified merged and Flow DONE. Namespace routing is released. Doc frame rollout still waits for the reviewed bridge lifetime API and real runtime/mount proof. Other supporting tickets are related work rather than blanket Doc foundation blockers.

Before switching contexts, record Done, Next, Open questions and Next command. `03-tasks.json` remains canonical once DECOMPOSE generates it; Linear plans are projections. Do not write a pretend canonical task file against an unfrozen spec.

## Current delivery checkpoint

Supporting scope: DOR-2660, DOR-2661, DOR-2662, DOR-2663, DOR-2664 and DOR-2666, each with an independent implementation PR. This lane owns the overview; Doc and managed-browser implementation belong to their respective chats. Every delegate uses the operator-selected GPT-6.1 Sol / Medium setting. Scoped tracker writes, commits, pushes, independent review before PR, normal queue entry, verified merge, Flow DONE and safe owned cleanup are authorized. No paid inference, personal logins or operator-authored app messages are authorized.

| Issue    | Verified state                                                                                                                                                    | Next boundary                                                                                                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DOR-2663 | [PR2457](https://github.com/dork-labs/dorkos/pull/2457) merged as `d19d3ee73534dc9b69474bedffe9840db74ed931` at 2026-10-01T21:55:52Z; Flow DONE/readback complete | Primary checkout and programme evidence retained                                                                                                                                                         |
| DOR-2660 | [PR2459](https://github.com/dork-labs/dorkos/pull/2459) merged as `6b7309b9fc13d8580c890f707b839d5527277f0b` at 2026-10-02T01:30:43Z; Flow DONE/readback complete | Namespace routing gate released; clean worktree archived after 52 ignored evidence files were copied and hash-verified                                                                                   |
| DOR-2661 | [PR2461](https://github.com/dork-labs/dorkos/pull/2461) merged as `4d7fe3a082ec9fe1f92ae0b236f5537b84f9917c` at 2026-10-02T02:43:13Z; Flow DONE/readback complete | All five source/test files match reviewed `306a5bec`; all 12 merge-group workflows passed (25 success, two skips). Clean worktree archived after 32 ignored evidence files were copied and hash-verified |
| DOR-2662 | Claimed at 2026-10-02T02:07:53Z; EXECUTE at 02:09:33Z, with one bounded source writer                                                                             | Complete frozen lifetime/request/recording/evidence contract and real browser proof, then independent exact-head review and delivery                                                                     |
| DOR-2664 | Bounded authority-docs contract and considered no-redesign rationale independently reviewed; clean environment refreshed to namespace main                        | Source unclaimed; execute after the bridge source slot converges                                                                                                                                         |
| DOR-2666 | Receipt contract independently frozen/decomposed; source unclaimed                                                                                                | Wait for actual Doc accounting/schema merge and explicit writer handoff; refresh migration census then                                                                                                   |

The JSON conflict after the namespace merge was real. Normal integration preserved both fixes, shared tests and both raw manifest records. Fresh Node24 verification passed 40 quality/build and 19 test/build tasks, including 23,977 server tests; 263 focused tests and 72 namespace controls pass. Independent exact-pushed-head review approved zero findings with a separate 19-case real-app run. Earlier JSON head `f9c3d578` and its gates remain historical evidence.

Bridge preparation is based on actual namespace main. Dependency builds, isolated Node24 SQLite readiness and five existing suites/132 tests pass. The first real-hook behavioral RED showed one unsolicited screenshot Transport call where zero was expected; its focused green also proves a known request succeeds. These are partial execution facts, not a completed bridge or permission to activate Doc frames. The frozen contract treats page-reported evidence as unverified; generation is a lifetime correlation, never script authentication.

Doc foundation task1.1 [PR2458](https://github.com/dork-labs/dorkos/pull/2458) merged as `e3210be2cb14c823696a213f4df0ab21fa8acdd8` at 2026-10-01T22:44:08Z. The Doc parent remains open. Doc owns the accounting/schema window; there is no receipt source release. Stream head `3899e19ab4d95646ccb18cf567d83dc62b9eece0` was inspected for narrow composition with its bottom `SessionWireEventSchema` union; Doc owns subsequent candidate work. Bridge edits stay in the agreed DevTools shared/host sections; no private Doc, grants, database or widget implementation is copied. Doc task3.2 remains gated on reviewed bridge runtime/mount proof.

Browser prototype [PR2460](https://github.com/dork-labs/dorkos/pull/2460) is verified merged at 2026-10-02T02:28:00Z as `9dc56fd45d81fbb3125fdc48cc7e5ee1af340b0a`. This is a prototype milestone; the browser parent and production requirements remain open.

The project ship dial remains person/missing. Explicit scoped human authority permits normal `gh pr merge --auto` after independent exact-head review and forge gates converge. Record reviewer identity, verdict and evidence truthfully in Flow REVIEW; preserve protections, verify actual merge, then Flow DONE. Never impersonate a person, fabricate reviewer tokens or alter calibration. Project close-out stays deferred while related work is open. Latest completed Relay pulse: 16 of 22 done, six open; disposition `skip`, reason `rollup-incomplete`.

Next: continue bridge execution and proof, then the remaining authority documentation and receipt fixes. Three supporting issues remain unfinished. Preserve ignored evidence before owned cleanup; no foreign checkout or process cleanup is authorized.
