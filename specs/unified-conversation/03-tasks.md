# Unified conversation — task breakdown

**Spec:** `specs/unified-conversation/02-specification.md` (id `260818-001825`)
**Generated:** 2026-08-18 (DECOMPOSE) · **Canonical file:** `03-tasks.json` — this document is a projection of it, for browsing and diffs.

**48 tasks across 5 phases.** Each phase is **one pull request, from one worktree, by one builder agent, adversarially reviewed against `REVIEW.md` before the PR opens**. Each phase lands on `main` with nothing half-migrated and deletes what it replaces. Every task body in `03-tasks.json` is self-contained: it names the files, the exports, the deletions, the invariants and the acceptance command, and carries the spec's code blocks verbatim.

## Why five phases and not the spec's four

The specification writes four pull requests. Its P4 carries the timeline, the composer host, the Dev Playground restructure and the docs — the largest deletion list in the programme plus a page rename plus a documentation set. That is two reviewable units, not one, and they gate on different evidence: the timeline and composer are gated by the **existing browser suites**, while the playground and docs are gated by the **registry test and a page that renders the real components**. So P4 is split:

- **Phase 4** — timeline, composer host, the two target adapters, the `AssistantMessageContent` split, the P4 deletions, `pnpm knip` clean, the full room + chat browser suites green.
- **Phase 5** — the `chat` → `conversation` page rename, the five sections, the showcase moves, the stale skill line, the docs, and the spec close-out.

Nothing else in the spec's phasing moved.

## The graph

```
1.1 slice + model contract
 ├─▶ 1.2 Message.* seven parts ─┐
 ├─▶ 1.3 entry-actions run-with ┼─▶ 1.5 host wiring + delete two rows
 └─▶ 1.4 rows + time formatter ─┘        ├─▶ 1.6 tests
                                          ├─▶ 1.7 playground
                                          └─▶ 1.8 changelog   ──▶ 1.9 P1 acceptance
                                                                     │
 ┌───────────────────────────────────────────────────────────────────┘
 ├─▶ 2.1 deriveLaneState ──▶ 2.2 LiveLane ──┬─▶ 2.5 mount + delete two status lines
 └─▶ 2.3 GET /rooms/:id/sessions ───────────┴─▶ 2.4 LivePeek
                                              ├─▶ 2.6 tests (lane table, route, 2 browser)
                                              ├─▶ 2.7 playground
                                              └─▶ 2.8 changelog ──▶ 2.9 P2 acceptance
                                                                     │
 3.1 wire module + transport ──▶ 3.2 projector seam ──▶ 3.3 broadcaster + ledger
   ──▶ 3.4 route + answer guard ──▶ 3.5 allowlist both ends + transports
   ──▶ 3.6 attention store + real kind ──▶ 3.7 features/ask ──▶ 3.8 five surfaces + lane rung
        ├─▶ 3.9 server tests (18-case authority table)   ┐
        ├─▶ 3.10 client + browser tests                   ├─▶ 3.13 P3 acceptance
        ├─▶ 3.11 playground                               │
        └─▶ 3.12 changelog                                ┘
                                                                     │
 ┌───────────────────────────────────────────────────────────────────┘
 ├─▶ 4.1 use-timeline-scroll ──▶ 4.2 Conversation.Timeline ──▶ 4.3 mount + delete two lists
 ├─▶ 4.4 two ConversationTarget adapters ───────────────────┴─▶ 4.5 Composer + Footer
 └─▶ 4.6 AssistantMessageContent split                        ├─▶ 4.7 tests + knip
                                                              └─▶ 4.8 changelog ──▶ 4.9 P4 acceptance
                                                                     │
 ├─▶ 5.1 page rename (7 touch points) + skill fix ─┬─▶ 5.2 Surfaces + Message row
 └─▶ 5.5 docs + openapi                            ├─▶ 5.3 Timeline + Composer
                                                    └─▶ 5.4 Live lane + Asks
                                                        ├─▶ 5.6 04-implementation + manifest
                                                        └─▶ 5.7 changelog ──▶ 5.8 P5 acceptance
```

**Critical path (30 tasks):** 1.1 → 1.2 → 1.5 → 1.6 → 1.9 → 2.1 → 2.2 → 2.4 → 2.6 → 2.9 → 3.1 → 3.2 → 3.3 → 3.4 → 3.5 → 3.6 → 3.7 → 3.8 → 3.10 → 3.13 → 4.1 → 4.2 → 4.3 → 4.5 → 4.7 → 4.9 → 5.1 → 5.2 → 5.6 → 5.8.

The long pole is **phase 3**, which is a single unbroken chain from the wire shape to the five rendering surfaces: the server half cannot be parallelised (each link needs the one before it to exist), and the client half needs the server half to exist before the store can be seeded. Phases 1, 2, 4 and 5 all have a three-wide front near their start.

**Widest parallel fronts:**

- **P1 after 1.1** — 1.2, 1.3 and 1.4 are mutually independent (different directories, no shared file).
- **P2 at the top** — 2.1 and 2.3 are independent (client model vs server route), and 2.3 also runs alongside 2.2.
- **P3 at the tail** — 3.9, 3.11 and 3.12 all run alongside 3.10.
- **P4 at the top** — 4.1, 4.4 and 4.6 are mutually independent.
- **P5 after 5.1** — 5.2, 5.3 and 5.4 are three independent section builds, and 5.5 (docs) runs from the phase-4 gate without waiting for the rename at all.

## Phase 1 — Row and row kinds (9 tasks)

| #       | Outcome                                                                                                    | Size   | Deps          |
| ------- | ---------------------------------------------------------------------------------------------------------- | ------ | ------------- |
| **1.1** | The `features/conversation` slice exists: capabilities, target, context, row kinds, moved variants         | medium | —             |
| **1.2** | Seven `Message.*` parts, one variant call, no surface checks                                               | large  | 1.1           |
| **1.3** | One hover-action system; `RunWithMenu.tsx` deleted, `run-with` is an `entry-actions` action id             | medium | 1.1           |
| **1.4** | Dividers, notice, moment and thread-reply rows moved; one time formatter                                   | medium | 1.1           |
| **1.5** | Both widgets render `Message.*`; the two body renderers exist; ten files deleted                           | large  | 1.2, 1.3, 1.4 |
| **1.6** | `Message.test.tsx`, `no-surface-switches.test.ts`, `row-kinds.test.ts`; room + chat suites green unchanged | medium | 1.5           |
| **1.7** | The playground shows the `Message.*` matrix and the moved rows                                             | medium | 1.5           |
| **1.8** | Phase 1 changelog fragment (or `skip-changelog`, honestly judged)                                          | small  | 1.5           |
| **1.9** | Phase acceptance — the reviewer's browser check, `pnpm verify`, `pnpm knip`                                | small  | 1.6, 1.7, 1.8 |

## Phase 2 — The live lane, the peek, and the placement move (9 tasks)

| #       | Outcome                                                                                           | Size   | Deps          |
| ------- | ------------------------------------------------------------------------------------------------- | ------ | ------------- |
| **2.1** | `deriveLaneState` — the ten-rung priority stack, absorbing `strip-state.ts`                       | large  | 1.9           |
| **2.2** | `Conversation.LiveLane` — fixed `h-6`, always mounted, one live region, one tab stop              | large  | 2.1           |
| **2.3** | `GET /api/rooms/:id/sessions` (ids only, person-authors only) + `use-room-sessions`               | medium | 1.9           |
| **2.4** | `LivePeek` — who, elapsed, replying-to, Open its session, the honest Stop                         | large  | 2.2, 2.3      |
| **2.5** | Lane mounted on both surfaces; `ChatStatusStrip`, `RoomPresenceLine`, `RoomStalledNotice` deleted | large  | 2.2           |
| **2.6** | `lane-state.test.ts`, `rooms-sessions.test.ts`, `lane-no-shift.spec.ts`, `peek.spec.ts`           | large  | 2.4, 2.5      |
| **2.7** | The playground shows every `LaneState` and both peek shapes                                       | medium | 2.5           |
| **2.8** | Phase 2 changelog fragment (user-facing; does not claim the Ask)                                  | small  | 2.5           |
| **2.9** | Phase acceptance — the reviewer's browser check, including killing the server                     | small  | 2.6, 2.7, 2.8 |

## Phase 3 — The Ask, end to end (13 tasks)

| #        | Outcome                                                                                                    | Size   | Deps     |
| -------- | ---------------------------------------------------------------------------------------------------------- | ------ | -------- |
| **3.1**  | `@dorkos/shared/interaction-events` + the `exports` subpath + `listPendingInteractions` on `Transport`     | medium | 2.9      |
| **3.2**  | `onProjectorInteractionChange` seam, three fire points, `listPendingInteractionsAcrossSessions`            | medium | 3.1      |
| **3.3**  | `session-list-broadcaster` broadcasts both events; `bindingForSession` on the ledger, injected as a port   | medium | 3.2      |
| **3.4**  | `GET /api/sessions/pending-interactions` above `/:id`, and `requirePersonToAnswer` on six answer routes    | large  | 3.3      |
| **3.5**  | Both allowlist ends in one PR; real `HttpTransport` **and** `DirectTransport` implementations              | medium | 3.4      |
| **3.6**  | `usePendingInteractions` in `entities/attention`; the degradation at `derive-attention-signals.ts` deleted | large  | 3.5      |
| **3.7**  | `features/ask` — `AskCard.*`, the three moved prompts, `AskStack`, receipts; `ApprovalCard` re-based       | xl     | 3.6      |
| **3.8**  | Header pill, sidebar, home triage, lane and transcript all draw the same card; lane rung 1 goes live       | large  | 3.7      |
| **3.9**  | Server tests: 6 routes × 3 callers, projector seam, ledger redirect, SSE ordering, the allowlist           | xl     | 3.4, 3.5 |
| **3.10** | Client tests + `ask-anywhere.ts` (answer from `/tasks`, assert the agent carries on)                       | large  | 3.8      |
| **3.11** | The playground shows the card family, the stack, the countdown thresholds and the five receipts            | medium | 3.8      |
| **3.12** | Phase 3 changelog fragment, including a `### Security` bullet                                              | small  | 3.8      |
| **3.13** | Phase acceptance — the reviewer's browser check, including the `curl … X-DorkOS-Agent` 403                 | small  | 3.9–3.12 |

## Phase 4 — Timeline and composer host (9 tasks)

| #       | Outcome                                                                                         | Size   | Deps     |
| ------- | ----------------------------------------------------------------------------------------------- | ------ | -------- |
| **4.1** | `use-timeline-scroll.ts` — one hook, the room's contract and thresholds win                     | large  | 3.13     |
| **4.2** | `Conversation.Timeline` — the one virtualized list, plus `PendingRow`                           | xl     | 4.1      |
| **4.3** | Both surfaces mount it; `MessageList`, `RoomTimeline`, both scroll hooks, `RoomPendingRow` gone | large  | 4.2      |
| **4.4** | `session-target.ts` and `room-target.ts` — the room has no `queue`, and shows no queue chrome   | medium | 3.13     |
| **4.5** | `Conversation.Composer` + `Conversation.Footer`; both composer hosts deleted                    | xl     | 4.3, 4.4 |
| **4.6** | `AssistantMessageContent.tsx` split under 500 lines, behaviour identical                        | medium | 3.13     |
| **4.7** | Timeline + composer units, the full existing browser suites unchanged, `pnpm knip` clean        | large  | 4.5, 4.6 |
| **4.8** | Phase 4 changelog fragment (one honest bullet: long channels scroll smoothly)                   | small  | 4.5      |
| **4.9** | Phase acceptance — the reviewer's browser check, first two sentences                            | small  | 4.7, 4.8 |

## Phase 5 — Dev Playground Conversation page and docs (8 tasks)

| #       | Outcome                                                                                                 | Size   | Deps     |
| ------- | ------------------------------------------------------------------------------------------------------- | ------ | -------- |
| **5.1** | `chat` → `conversation` across seven touch points; `maintaining-dev-playground` line 233 fixed          | medium | 4.9      |
| **5.2** | _Surfaces_ (three capability objects, one fixture set) and _Message row_ (the four-axis matrix)         | large  | 5.1      |
| **5.3** | _Timeline_ (dividers → long virtualized run) and _Composer_ (both adapters, queue vs no queue)          | large  | 5.1      |
| **5.4** | _Live lane_ (every state) and _Asks_; the identity page loses its presence entry                        | large  | 5.1      |
| **5.5** | design-system live lane + one status vocabulary, architecture, state-management, the user page, openapi | large  | 4.9      |
| **5.6** | `04-implementation.md`, manifest → `implemented`, the three draft ADRs reviewed                         | medium | 5.2–5.5  |
| **5.7** | Phase 5 changelog fragment or an honest `skip-changelog`                                                | small  | 5.2–5.5  |
| **5.8** | Phase acceptance — the reviewer's browser check, third sentence, plus a regression re-run               | small  | 5.6, 5.7 |

## Rules that hold across every phase

- **No `surface ===` below `Conversation.Root`.** Behaviour branches on `ConversationCapabilities` only, and `no-surface-switches.test.ts` (task 1.6) is the mechanical guarantee. It is extended, never weakened, as new `ui/` files land.
- **The lane is `h-6`, never `min-h`, and always mounted.** Zero layout shift is a structural property, not a promise. jsdom cannot see it; `lane-no-shift.spec.ts` is the only test that can.
- **Both ends of the SSE allowlist in the same pull request.** `interaction_pending` and `interaction_resolved` land in `GENERIC_EVENTS` in the PR that adds the broadcasts, and neither goes in `NOT_BROADCAST_BY_LITERAL`.
- **Each phase deletes what it replaces.** Nothing behind a flag, nothing kept "just in case". `pnpm knip` runs at the end of every phase and a phase is not done while it reports a new orphan.
- **Changelog fragment ids are minted at execution time** with `node --experimental-strip-types .claude/scripts/id.ts`, never pre-allocated here — two branches stamping their own clocks is what keeps the filenames collision-free.
- **Every test names its seeded defect.** A check that cannot fail is worse than none; red-before, green-after, with the mutation actually run.
- **Adversarial review runs on the branch before the PR opens**, against `REVIEW.md`.

## Assumptions this decomposition wrote in, where the spec left room

These are DECOMPOSE-stage defaults, chosen and recorded rather than escalated. Each is reversible and named in the task that carries it.

1. **P4 is split into two pull requests.** The spec says four PRs; this decomposition says five, for the reason in "Why five phases" above. The spec's phase content is unchanged — only the PR boundary moved.
2. **The P4 "Reviewer's browser check" is quoted verbatim in both tasks 4.9 and 5.8**, with a line saying which sentences each phase owns. Splitting the paragraph would have edited the spec's words; duplicating it does not.
3. **Playground parity is a task in phases 1, 2 and 3**, not deferred to phase 5. The `maintaining-dev-playground` skill requires parity on every UI change, so each phase updates the showcases for what it introduces **on the existing pages**; phase 5 only restructures. The lane's `ask` state is the one showcase that cannot exist before phase 3, and task 3.11 carries it.
4. **The lane's `ask` rung is typed against a placeholder in P2** and switched to the real `InteractionPendingEvent` in task 3.8. The spec puts `LaneState` in P2 and the Ask in P3 without saying how the type resolves across the gap. A TSDoc line marks the rung unreachable so a cold reader does not read it as dead code.
5. **`GET /api/rooms/:id/sessions` may leave the openapi regeneration to phase 5.** The spec lists `pnpm docs:export-api` once, in P4's docs table, while the route lands in P2. Task 2.3 permits either, and task 5.5 owns the regeneration of record.
6. **The peek's `scrollToRow` handle is an interim in P2.** `ConversationTimelineHandle` does not exist until P4, so task 2.4 asks the P2 lists to expose the same `scrollToRow(rowId, { flash })` signature and task 4.3 swaps it for the real handle. The spec assumes the P4 handle when describing a P2 feature.
7. **`AssistantMessageContent`'s split seams are named as "to be confirmed against the file as it stands after P3."** The spec sets the 500-line bar and no seam. Task 4.6 proposes splitting by part kind and forbids behaviour change, which makes the seam a builder judgement with a hard invariant rather than a guess written into the plan.
8. **The changelog fragment for phases 1, 4 and 5 may legitimately be `skip-changelog`.** The spec asks for "one fragment per phase". The `writing-changelogs` audience test says a change only a DorkOS builder notices takes the label instead. The tasks state the test and let the builder answer it rather than forcing an invented user benefit — which the `AGENTS.md` honesty gate would refuse anyway.
9. **`entry-actions` gains one action id and no redesign.** The spec says `features/entry-actions` is the survivor and `RunWithMenu`'s popover body becomes the action's content. Task 1.3 forbids re-designing the menu while moving it, so a look change cannot hide inside a merge.
10. **Sub-issue promotion is left to the orchestrator.** Four tasks are `xl` (3.7, 3.9, 4.2, 4.5), which is at or above the default `subIssueThreshold`. `issue` and `parentIssue` are `null` on every task here; the orchestrator promotes one sub-issue per phase and fills them.

## What was checked against the tree, not taken from the spec

- `apps/client/src/dev/sections/chat-sections.ts` carries exactly **51** entries with `page: 'chat'` — the spec's figure holds.
- `.claude/skills/maintaining-dev-playground/SKILL.md:233` still reads _"Add the page component to `PAGE_COMPONENTS` in `dev/DevPlayground.tsx`"_, and the Files-to-Know row for `dev/DevPlayground.tsx` is at **:262**. Task 5.1 fixes both.
- Every showcase file the spec names exists: `MessageShowcases.tsx`, `StatusShowcases.tsx`, `StatusLineShowcases.tsx`, `RoomPresenceShowcases.tsx`, `InputShowcases.tsx`, `ApprovalsShowcases.tsx`, `ApprovalReceiptShowcases.tsx`, `ToolShowcases.tsx`, `RoomThreadShowcases.tsx`, `RoomsShowcases.tsx`, `RoomDeliveryShowcases.tsx`, `TrustDialShowcases.tsx`, `SessionInspectorShowcases.tsx`, `ChipShowcases.tsx`, `MiscShowcases.tsx`.
- There is no `dev/pages/ConversationPage.tsx` today; `ChatPage.tsx` is the file task 5.1 renames.

---

### Task bodies

`03-tasks.json` holds the full, self-contained body for every task — the file paths, the verbatim code blocks from the specification, the deletion lists, the invariants and the acceptance commands. Read it, not this summary, before executing a task.
