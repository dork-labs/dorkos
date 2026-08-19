# Design decisions already made — Chats as Channels

> **Read this before reopening anything.** These calls were made by Dorian on 2026-08-03 in a visual-companion session, recorded in [`plans/language-ia-simplification.md`](../../plans/language-ia-simplification.md) §"Phase 3 design decisions", and approved. [`02-specification.md`](./02-specification.md) implements them; it does not re-litigate them. DECOMPOSE cites **this** file when a task's rationale is "because the founder decided so," and cites the spec when the rationale is "because the code works this way."
>
> **File-naming note:** this file must never be renamed to `04-*`. Any `04-*` file in a spec directory auto-promotes the spec's status to `implemented`.

## D-1 — The three moves that compose (plan item 3)

Connection scoping is one model in three moves, and they were designed to compose rather than to be alternatives.

**Move 1 — connections belong to agents.** Connector accounts get a persisted agent-level attachment (a new store; today attachment is session-only and in-memory). Sessions inherit it automatically on start. Session-level attach/detach stays as an override, with precedence **session > agent and no merging** — the Claude Code MCP ladder pattern, where the highest-precedence scope wins wholesale (`research/20260803_connection-scoping-prior-art.md` §"Claude Code MCP config scoping"). Messaging bindings are already agent-scoped; the UI starts saying so.

**Move 2 — agent-first flow, nothing silent.** Every connect flow knows its agent — implied from an agent profile, or step 1 on the page. A messaging adapter cannot exist without a binding; the two are created atomically in the wizard. One chat routes to one agent, enforced at creation with an explicit "This chat reaches X. Move it to Y?" dialog, which kills the silent creation-order shadowing the 2026-08-03 audit found. Inbound from an unbound chat surfaces as a **claim card** ("Miguel messaged your bot — which agent should answer? / Ignore") instead of today's silent drop; nothing is said in-chat until claimed, so consent is preserved and made visible.

**Move 3 — chats-as-channels (this spec).** A bound external chat projects into a channel: inbound becomes a room post; the existing per-`(room, agent)` room-turn machinery answers; outbound is any session posting into the room, which the bridge delivers to the platform; the room log is the single shared history. The seams were verified present before the decision was made — the Telegram outbound `handleTypingSignal` comment, and the `room-trigger` / `writer.post` / late-delivery machinery.

**Rationale for treating Move 3 as its own program:** it is the only one of the three that answers a problem the industry has not solved. Every surveyed product keys the session on the chat identifier ("the chat IS the thread"), and the one product that tried to let several workers share an external chat documents it as a degradation, not a feature. DorkOS already owns a durable, multi-participant, mixed-runtime stream, so the bridge is plumbing on top of a primitive nobody else built.

## D-2 — Sequencing: Option A (plan item 4)

Moves 1 and 2 ship **alongside the language program**. Move 3 is spec'd immediately after the language waves and executed next, in the same autonomous run.

**Rationale.** Moves 1 and 2 change vocabulary and flows the language waves are already rewriting, so shipping them together avoids touching the same surfaces twice. Move 3 changes behaviour rather than words, has a much larger blast radius, and depends on Move 2's claim as its entry point — so it earns its own spec, its own review, and its own rollout.

**Consequence for this spec:** Move 2's outputs (the claim as a first-class act, one-chat-one-agent uniqueness, atomic adapter+binding creation, `resolve()` filtering `enabled`) are **assumed present**, not built here. The spec states the dependency explicitly in §2.3 and keeps a fallback entry point (bridging an existing binding from the connection detail sheet) so a slip in Move 2 does not block phase 1.

## D-3 — Stranger and group policy (plan item 8)

Telegram bots are publicly discoverable. Everything below follows from that one fact.

1. **An unclaimed chat NEVER triggers an agent.** No model run, no spend, no prompt-injection surface.
2. **A stranger's message renders as data on a cockpit claim card only.** The bot stays silent in-chat until the chat is claimed — deliberately quieter than Claude Code Channels' pairing-code pattern, which requires the bot to answer an unknown sender with a code.
3. **Claim cards collapse per chat.** `Ignore` mutes the chat; `Block` drops its future traffic without a card.
4. **A bot added to a group is a new group-kind chat** and goes through the same claim flow: "added to 'X' by Ana — which agent should join? / Ignore / Leave".
5. **Telegram privacy mode stays default-ON** (the bot sees only @mentions, replies, and commands), so a bridged channel's room log contains only what the bot legitimately received. Turning it off remains Telegram's own deliberate remove-and-re-add ritual — DorkOS never flips it and never offers to.
6. **The channel header states its visibility** — "sees mentions only" vs "sees everything" — so a person reading a bridged group is never misled about how much of it the log holds.
7. **In bridged group channels the agent is mention-gated by default**, per `meta/agent-etiquette.md`: over-participation, not silence, is the failure mode users complain about.

**Rationale.** The three properties being protected are: a stranger cannot make this machine spend money; a stranger cannot put text in front of a model without a person deciding they may; and a person is never told the bot saw more (or less) of a conversation than it did.

## D-4 — Audited facts these decisions correct (plan item 5)

The 2026-08-03 audit established five behaviours. They are facts about shipped code, not proposals, and Moves 1–3 exist partly to fix them.

| #   | Fact                                                        | Fixed by                                                  |
| --- | ----------------------------------------------------------- | --------------------------------------------------------- |
| 1   | Binding ties shadow silently by creation order              | Move 2 (uniqueness at creation, explicit move dialog)     |
| 2   | Unbound inbound drops silently                              | Move 2 (claim card)                                       |
| 3   | `resolve()` does not filter `enabled`                       | Move 2                                                    |
| 4   | Outbound identity is cwd/agent-derived, `canInitiate`-gated | Unchanged; Move 3 reuses the gate rather than widening it |
| 5   | Connector session attachments do not survive restart        | Move 1 (persisted agent-level store)                      |

## D-5 — Resolved by the founder's approval (plan items 7 and 6)

Settled, not open:

- "Connections" is the umbrella noun; Settings → Integrations is deleted entirely, with no stub.
- Default agent moves to the Agents page only.
- `docs/integrations/` gets a scope-note now; the directory rename is deferred.
- "Subagents" is kept as the term for the SDK-subagent sense.
- Two follow-ups are filed rather than solved here: a DorkOS-hosted Google OAuth app (folded into DOR-750, with counsel/CASA diligence), and marketplace bridge-line copy (two region-matched lines per D5 of the language plan).

## D-6 — The five spec questions, closed at the founder gate (2026-08-03)

Rev 1 of the specification left five questions open. All five were taken to the founder gate after the adversarial review and answered. They are **settled**; the spec implements them, and §16 of the spec now records only that they are closed.

**Q1 — Forum topics: one room or many?** → **Fold topics into one room in phase 1, and defer the split until Slack's `thread_ts` is in hand — but record the topic NAME alongside the id and render a sanitized per-entry label outside the fence.**
_Rationale:_ Slack threads are the harder constraint, and deciding for Telegram alone risks choosing twice. But a folded room without topic labels is an unreadable interleaving of several conversations, which would make the room log worse evidence than the chat it projects. The name is a label, so it goes outside the fence through `sanitizeIdentity`, at write time as well as render time. Spec §5.6, §9.2.

**Q2 — Does a bridged private chat get room kind `dm` or `channel`?** → **`dm` plus the origin mark, contingent on the bridge-row identity fix. If that fix proves invasive during implementation, fall back to kind `channel`.**
_Rationale:_ `dm` is the honest kind for a two-person chat, and the origin mark is exactly the affordance that separates "my private conversation with my agent" from "a stranger's conversation with my agent" in one list. The contingency is not optional politeness: `dm` is only safe because room identity moved to the bridge row (spec §3.2). The fallback is a kind swap, never a weakening of §3.2.

**Q3 — Can a bridged room hold more than one agent?** → **Refused in phase 1.**
_Recorded reason:_ outbound consent is **per binding**, so a second agent's delivery has no gate that names it — `checkSender` would correctly deny it, producing a half-silent room where one agent answers into the chat and the other answers only into the cockpit. That is worse than a clean refusal. Revisit only alongside a per-agent-per-chat consent model, not before.

**Q4 — Whose name does a cockpit post carry in the chat?** → **Any delivered post whose author is not the bound agent gets the author's display-name prefix, applied at delivery time only, never stored in the entry body.**
_Rationale:_ the bot is the only identity Telegram gives us, so without a prefix a person in the group cannot tell the operator speaking from the agent speaking — which is dishonest. Storing the prefix would corrupt the record: the log must hold exactly what the person typed, and a stored prefix would be re-applied on every re-delivery. Spec §6.7.

**Q5 — `deliverNotices` default.** → **Keyed on room kind: `true` for a bridged `dm`, `false` for a bridged `channel`. One per-bridge override. Scope stays exactly `turn_failed` + `halted`.**
_Rationale:_ who is standing on the other end. A bridged DM is usually the operator's own account, and silence after a crashed turn is the failure room conduct exists to prevent. A bridged group is other people, who do not need this machine's internals. Spec §6.2.
_Amended 2026-08-18 (DOR-1359):_ the scope is four codes — `awaiting_approval` and `agent_busy` joined it. The default, the seeding rule and the override are untouched; only the eligible set widened, to every notice that says an agent has stopped. Spec §6.2's amendment note.

## D-7 — Amendments the adversarial review forced (2026-08-03)

Recorded here because they change what "already decided" means for DECOMPOSE, not because the founder chose them — they are corrections to claims about shipped code.

1. **Room identity is the bridge row, never the member set.** Rev 1 proposed a bridged DM with roster `{operator, bound agent}`, which is byte-identical to the operator's own private DM with that agent — `findDmByMemberSet` would have returned the private conversation, landed strangers' messages in it, and made its private posts delivery candidates. The bridge create path bypasses member-set matching and `findDmByMemberSet` excludes bridged rooms in the query. Spec §3.2.
2. **`canReply` is unenforced today and this feature has to enforce it.** Rev 1 claimed the existing consent gate sufficed; it does not — replies ride the blanket `agent:*` exemption and `canReply` is read only for `permissionMode`. The bridge asserts a new **non-exempt** principal `relay.bridge.{reply|initiate}.{adapterId}.{chatId}`, and the gate gains exactly one non-exempt branch that enforces `canReply` and `canInitiate` against the classification the principal carries. The delivering-author check is **not** in the gate — amendment 4 puts it in `deliver`, which is the only place that can see an author. The exempt set is unchanged. Spec §6.4, §6.6, §11.1.
3. **`relay.bridge.*` must be server-only, or the audit trail is a lie.** Rev 2 made the bridge principal non-exempt so the consent gate would evaluate it — correct, but incomplete: `POST /api/relay/messages` rejects a client-asserted principal only when it is _exempt_ (`routes/relay.ts:202`), so a non-exempt one sails through. With `canReply` defaulting `true`, any local caller could have published arbitrary text as the bot, leaving no room entry and no external ref. Fixed with a second, wider predicate `isServerOnlyPrincipal` (exempt set ∪ `relay.bridge.*`) used by the HTTP route only; `isConsentExemptPrincipal` keeps its three branches and its one meaning. Spec §6.4, A6.10.
4. **The consent gate cannot classify provenance, and the type says so.** `InitiateConsentGate` is `(from, subject) => decision` (`packages/relay/src/types.ts:169`). Rev 2 asked it to read `cascadeRoot`, the external-ref table, and the delivering author — none of which it can see. Provenance classification and the delivering-author check moved into `deliver`, which holds all three; the gate's branch enforces only `enabled && (canReply | canInitiate)` on the classification the caller asserts. That is safe **only** because of the point above: `relay.bridge.*` is unassertable by a client, so `deliver` is the sole caller. The two fixes are one decision and must not be separated. Spec §6.6.
5. **The ambient tier is empty in the default posture.** Rev 1 described unmentioned group messages as quiet context. Two upstream gates — Telegram privacy mode, and `shouldProcessGroupMessage` at the shipped `'thread-aware'` default — drop them before publish. Ambient context exists only with privacy mode OFF _and_ `respondMode: 'always'`. This does not change D-3; it is the honest description of what D-3's posture produces, and §8's badge is exactly that description. Spec §5.4, §8.
6. **The server-only property is now enforced at the publish pipeline, not only at the route (DOR-889).** Amendments 3 and 4 left a stated residual risk: `relay.bridge.*` is unassertable by a client _solely_ because the HTTP route rejects it (`isServerOnlyPrincipal`, `routes/relay.ts`). Within the process, any code constructing the string can publish as the bot, and a **future** ingress that forwarded a caller-supplied `from` without re-implementing that route guard would be a full bypass with no second line of defense. The pipeline now carries that second line: `RelayPublishPipeline.publish` rejects any `relay.bridge.*` `from` that arrives without the `serverBridgePrincipal` trust marker on `PublishOptions` — an in-process argument, never a wire field, set by exactly the three legitimate publishers (`deliver`, the task-completion notifier, the `relay_notify_user` tool) and by nothing else. The route guard stays as the outer perimeter (belt-and-suspenders, unchanged); the pipeline guard makes the server-only property hold for **every** ingress by construction. The consent gate is unchanged — the pipeline guard runs ahead of it, so an unmarked bridge `from` is rejected before it is ever classified as a reply or an initiate. Spec §6.4, §11.

## What this spec deliberately leaves to DECOMPOSE and later stages

- Which phase each task belongs to — the spec's §12 gives the three phases; task boundaries are DECOMPOSE's job.
- Which of the two atomic-seed implementations in spec §3.4 to build (the invariant is fixed; the mechanism is not).
- Whether §3.2's bypass is a dedicated `createBridgedRoom` or a `dedupe: false` flag on `createRoom` — the property is fixed, the spelling is not.
- Nothing else. There are no open founder questions on this spec.
