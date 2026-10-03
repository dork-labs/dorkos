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

All six supporting issues are verified merged and Flow DONE, with owned cleanup and both named140 returns recorded below. Namespace routing is released and the actual bridge API handoff is available. Doc-owned channel composition and runtime/mount acceptance remain open; bridge delivery alone does not release those gates. Other supporting tickets are related work rather than blanket Doc foundation blockers.

Before switching contexts, record Done, Next, Open questions and Next command. `03-tasks.json` remains canonical once DECOMPOSE generates it; Linear plans are projections. Do not write a pretend canonical task file against an unfrozen spec.

## Current delivery checkpoint

**Supporting closeout, 2026-10-03:** all six supporting issues are actually merged and Flow DONE. Owned implementation/review cleanup and both named140 return acknowledgements are complete. This three-document overview still needs its new reviewed PR and protected delivery. Broader Canvas, Relay, Doc and managed-browser parents remain open. The four-of-six preparation on 2026-10-02 was an earlier unshipped checkpoint.

Supporting scope: DOR-2660, DOR-2661, DOR-2662, DOR-2663, DOR-2664 and DOR-2666, each with an independent implementation PR. This lane owns the overview; Doc and managed-browser implementation belong to their respective chats. Every delegate uses the operator-selected GPT-6.1 Sol / Medium setting. Scoped tracker writes, commits, pushes, independent review before PR, normal queue entry, verified merge, Flow DONE and safe owned cleanup are authorized. No paid inference, personal logins or operator-authored app messages are authorized.

| Issue    | Verified state                                                                                                                                                                      | Next boundary                                                                                                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DOR-2663 | [PR2457](https://github.com/dork-labs/dorkos/pull/2457) merged as `d19d3ee73534dc9b69474bedffe9840db74ed931` at 2026-10-01T21:55:52Z; Flow DONE/readback complete                   | Primary checkout and programme evidence retained                                                                                                                                                         |
| DOR-2660 | [PR2459](https://github.com/dork-labs/dorkos/pull/2459) merged as `6b7309b9fc13d8580c890f707b839d5527277f0b` at 2026-10-02T01:30:43Z; Flow DONE/readback complete                   | Namespace routing gate released; clean worktree archived after 52 ignored evidence files were copied and hash-verified                                                                                   |
| DOR-2661 | [PR2461](https://github.com/dork-labs/dorkos/pull/2461) merged as `4d7fe3a082ec9fe1f92ae0b236f5537b84f9917c` at 2026-10-02T02:43:13Z; Flow DONE/readback complete                   | All five source/test files match reviewed `306a5bec`; all 12 merge-group workflows passed (25 success, two skips). Clean worktree archived after 32 ignored evidence files were copied and hash-verified |
| DOR-2662 | [PR2470](https://github.com/dork-labs/dorkos/pull/2470) merged as `6303271680cab557390c5f464c38910fc879022a` at 2026-10-02T14:54:55Z; Flow DONE/readback and owned cleanup complete | Actual public API handoff available; Doc-owned runtime/mount acceptance remains open                                                                                                                     |
| DOR-2664 | [PR2472](https://github.com/dork-labs/dorkos/pull/2472) merged as `bbfa433e05b621bf9d805b827066712a4be82183` at 2026-10-02T16:50:28Z; Flow DONE/readback and owned cleanup complete | Five reviewed files exact; caller authority documented without a new authentication mechanism                                                                                                            |
| DOR-2666 | [PR2494](https://github.com/dork-labs/dorkos/pull/2494) merged as `9984c87b784ddf99405426916bd406551b614618` at 2026-10-03T08:02:37Z; Flow DONE/readback and owned cleanup complete | Named140 RETURN accepted by BOTH Doc ROOT and programme; broader parents remain open                                                                                                                     |

The JSON conflict after the namespace merge was real. Normal integration preserved both fixes, shared tests and both raw manifest records. Fresh Node24 verification passed 40 quality/build and 19 test/build tasks, including 23,977 server tests; 263 focused tests and 72 namespace controls pass. Independent exact-pushed-head review approved zero findings with a separate 19-case real-app run. Earlier JSON head `f9c3d578` and its gates remain historical evidence.

DOR-2662 [PR2470](https://github.com/dork-labs/dorkos/pull/2470) merged as `6303271680cab557390c5f464c38910fc879022a` at 2026-10-02T14:54:55Z. All 52 owned files match reviewed head `74ac776a1da1353db905a35e880cdcbfcbf05ce4`. Flow DONE at 14:58:26.045Z, completed/agent-completed readback and run completion are verified. All 12 actual merge-group workflows passed (27 checks: 25 success, two skips).

Two distinct fresh independent whole-52-file reviews passed. Ten local gates passed on source snapshot `59d4b757e425af798884ddbc7f4e9c0b4187b6d7`: 660 permanent tests across 20 files, 15 coupled controls and two emitted-shim controls. Full quality tasks were 59 successful/55 cached; test tasks were 35 successful/31 cached. Final reviewed head changed only proof metadata; the other 51 files remain exact. 12 Chromium controls passed; 75 owned process births closed and reserved ports were released. These proofs remain attributed to their actual snapshots and runners. Page reports remain unverified; generation correlates a lifetime and authenticates no script.

Owned author and reviewer checkouts were archived; both paths and Git registrations are absent. The source remote branch is absent; the reviewer checkout was detached. Named retained copy sets contain 1,033 author/queue originals, 110 reviewer originals and 34 final-delivery originals, with hash parity. These are copy-set counts, not directory totals.

Evidence: `/Users/doriancollier/.codex/worktrees/5fa3/dorkos/.dork/flow/evidence/DOR-2662-final-delivery-630327/original-retained-manifest.json`, `/Users/doriancollier/.codex/worktrees/5fa3/dorkos/.dork/flow/evidence/DOR-2662-final-delivery-630327/originals/dor2662-flow-done.log`, `/Users/doriancollier/.codex/worktrees/5fa3/dorkos/.dork/flow/evidence/DOR-2662-final-delivery-630327/originals/dor2662-flow-done-readback.jsonl`, `/Users/doriancollier/.codex/worktrees/5fa3/dorkos/.dork/flow/evidence/DOR-2662-final-delivery-630327/originals/dor2662-source-actual-archive.json`, `/Users/doriancollier/.codex/worktrees/5fa3/dorkos/.dork/flow/evidence/DOR-2662-final-delivery-630327/originals/dor2662-stage1-actual-archive.json`, and `/tmp/dor2662-doc-mount-api-handoff-630327.md` with its JSON companion. These are coordinator-retained proof inputs; this metadata preparation reruns none of them.

DOR-2664 [PR2472](https://github.com/dork-labs/dorkos/pull/2472) merged as `bbfa433e05b621bf9d805b827066712a4be82183` at 2026-10-02T16:50:28Z. All five files match reviewed `d57e61502a3c6790e48766c1d2a6f889c29745da`. Flow DONE at 16:52:48.588Z and completed/agent-completed readback succeeded. Owned author and reviewer checkouts were archived; their paths and Git registrations are absent. Thirteen exporter tests and the normal affected verification remain attributed to the retained source-head evidence. This documentation delivery describes caller authority; it adds no authentication mechanism.

DOR-2666 [PR2494](https://github.com/dork-labs/dorkos/pull/2494) merged as `9984c87b784ddf99405426916bd406551b614618` at 2026-10-03T08:02:37Z, tree `70eb3ad47a6322676f8b6cb3c5cdc796c6892fad`. Independent full specification and distinct quality reviews approved pushed `34667e8e3e3508b987780cf286f115585b248a9a` with zero findings. All 57 owned paths match the protected candidate: 54 keep reviewed bytes; registry, API and Transport preserve the complete clean incoming union. All 12 exact-candidate workflows succeeded, with the full 27-job census retained, including six browser CI shards and four test shards. Flow DONE/run completion at 08:04:23.215Z and live completed/agent-completed readback for all six supporting items are recorded.

Receipt controls passed 358 tests in 16 files, including 20 real HTTP cases without skips. The three current-bound causal controls retain baseline/failure/restored proof. Normal verification on the composed250e source passed 61 quality tasks (seven cached) and 37 test/build tasks (three cached). Later main composition is attributed to the protected candidate, not that local run. These are fake-boundary/temp-SQLite/Core/Express/IPC controls and CI browser proof, not paid inference, personal login or native OS acceptance. The authoritative contract is in [the receipt specification](../specs/relay-delivery-receipts/02-specification.md).

Receipt author and reviewer checkouts were archived as `01a100d4-c576-7eb3-a641-d80e5e63ab68` and `01a100d5-62e5-7523-af79-c6349112b48e`; both paths and Git registrations are absent. Owned abandoned remote/local branches were removed only after the recovery bundle and all six prerequisite main ancestors were verified. Recovery bundle SHA256 `63280bcc625964aa17ae62adb7d243a6517799a2205822515cbd435457722bb6` and retained evidence remain outside those checkouts. Primary and foreign worktrees were untouched.

Historical schema chronology: Doc budget [PR2466](https://github.com/dork-labs/dorkos/pull/2466) merged as `bfbc102fb219beff7ad452ef52844e13fdd49a79` at 2026-10-02T14:00:21Z. Its warning migration138 has tag `20261002045158_doc_batch_waiting_warning`, when1790916718758. The original receipt139 reservation/generation followed that checkpoint. Incoming approval139 later superseded it. The same two receipt tables were normally regenerated at140 and both owners ratified the actual tuple; old receipt139 proof remains historical, and incoming approval139 was preserved.

Current receipt tuple: index140, version6, when1790998275968, tag `20261003033115_relay_delivery_receipts`, breakpoints true. All three generated files retain reviewed bytes. Supporting root issued the named140 RETURN at 2026-10-03T08:18:11.117465Z after actual merge/DONE/owned cleanup. Doc ROOT acknowledged at 08:20:10.292540Z; programme acknowledged at 08:22:30.980327Z and confirmed both recipient acknowledgements. This returns only the named allocation. It does not globally unfreeze private Doc/Room/token DDL or complete Doc acceptance.

Closeout custody: primary `.dork/flow/evidence/DOR-2666-actual-merge-closeout`, `DOR-2666-actual-queue-proof` and `DOR-2666-actual-owned-cleanup`; named return records are in `DOR-2666-named140-return/root-issued-return.json`, `doc-acknowledgement.json` and `programme-acknowledgement.json`. These are retained root observations, not new execution by this overview author.

The merged DevTools hook publicly returns only `resourceErrorCount`, `notePersonNavigated()` and `noteFrameLoaded()`. It exposes no public generation or invalidation subscription and grants no Doc authority. The actual eight-source API handoff describes host ref/load/source/remount seams; future Doc-owned channel composition and runtime/mount acceptance remain separate and unaccepted. The bridge merge does not complete Doc task3.2 or activate Doc frames.

### Historical early bridge checkpoint

Bridge preparation is based on actual namespace main. Dependency builds, isolated Node24 SQLite readiness and five existing suites/132 tests pass. The first real-hook behavioral RED showed one unsolicited screenshot Transport call where zero was expected; its focused green also proves a known request succeeds. These are partial execution facts, not a completed bridge or permission to activate Doc frames. The frozen contract treats page-reported evidence as unverified; generation is a lifetime correlation, never script authentication.

### Current remaining boundaries

Doc foundation task1.1 [PR2458](https://github.com/dork-labs/dorkos/pull/2458) merged as `e3210be2cb14c823696a213f4df0ab21fa8acdd8` at 2026-10-01T22:44:08Z. Its stream head `3899e19ab4d95646ccb18cf567d83dc62b9eece0` was the historical narrow composition inspection; it is not a current release or ownership receipt. Doc owns subsequent channel composition. No private Doc, grants, database or widget implementation is copied; the Doc parent and task3.2 runtime/mount acceptance remain open.

Browser prototype [PR2460](https://github.com/dork-labs/dorkos/pull/2460) is verified merged at 2026-10-02T02:28:00Z as `9dc56fd45d81fbb3125fdc48cc7e5ee1af340b0a`. This is a prototype milestone; the browser parent and production requirements remain open.

Historical project pulses were Relay16/22 and Canvas23/29 on 2026-10-02; they are not current rollups. The retained 2026-10-03 Relay, Mesh & A2A pulse reports 30/34 terminal items: 18 completed and 12 canceled, with four open. Policy disposition is `skip`, reason verbatim `rollup-incomplete`, in advisory mode. Associated active specs are zero under the recorded matching rule. The installed adapter has no callable `completeProject` capability despite its prose contract, and no project close occurred. Six supporting deliveries do not close the broader Canvas, Relay, Doc or browser parents.

Next: deliver this final three-document overview through fresh independent specification and distinct quality reviews, a new PR and the protected queue. Earlier overview PR2462 was a checkpoint, not this delivery. Preserve retained evidence before final owned cleanup. No foreign checkout or process cleanup is authorized.
