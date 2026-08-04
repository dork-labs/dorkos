# A13.2 — mutation-check log (chats-as-channels)

> **A13.2:** No test in this suite passes when the mechanism it names is deleted — verified by deleting each once during EXECUTE.

This criterion has no artifact of its own and evaporates if skipped. It is exactly the "verification that cannot fail" `.claude/rules/testing.md` warns about. So each load-bearing mechanism below was **actually deleted or disabled once**, its naming test run and observed **RED**, then the mechanism **restored** and the suite observed **GREEN**. This is the record of that run (DOR-881, worktree `dor-881-phase1-closeout`).

A representative set was chosen across the mechanisms that carry the feature's security and correctness weight: the ingest dedup, the delivering-author check, echo suppression, `sanitizeIdentity` at the store, the fence/`ownRecent` defuse, the consent gate's `canReply` branch, and the transcript probe.

| #   | Mechanism                                             | Source site (at HEAD)                                                                                              | Mutation applied                                                                    | Naming test                                                                                                                                                                                         | Result                                                                                                                                    |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Ingest dedup** (§5.2 step 1)                        | `chat-bridge/ingest.ts` — the `findInboundRefByPlatformMessage` guard                                              | Guard condition forced to `false` so a redelivered message is never recognised      | `ingest.test.ts` → `"A5.1: the same platform message id ingested twice → one entry, one turn"`                                                                                                      | **RED** — the second ingest hit the `room_bridge_messages` UNIQUE index (`SqliteError`) instead of deduping gracefully → restored → GREEN |
| 2   | **Delivering-author check** (§6.6 step 2, A6.5)       | `chat-bridge/deliver.ts` — `if (!isOperator && !isAgent) return 'refused_author'`                                  | `&& false` appended so the guard never fires                                        | `deliver.test.ts` → `"A6.5: a post whose author is neither the bound agent nor the operator is refused inside deliver, before any publish"`                                                         | **RED** — a foreign author's post published instead of being refused → restored → GREEN                                                   |
| 3   | **Echo suppression** (§6.3, A6.1)                     | `chat-bridge/deliver.ts` — `if (existing) return existing.direction === 'inbound' ? 'echo' : 'noop'`               | Rewritten to catch only `'outbound'` refs, so an `inbound` ref no longer suppresses | `deliver.test.ts` → `"A6.1: an inbound message never round-trips back to the platform"`                                                                                                             | **RED** — the inbound entry round-tripped back to the chat → restored → GREEN                                                             |
| 4   | **`sanitizeIdentity` at the store** (§9.2/§9.3, A9.2) | `chat-bridge/ingest.ts` — `sanitizeIdentity(payload.threadName)` on the forum-topic label                          | Sanitize call dropped, raw `threadName` written to the inbound ref                  | `bridged-room-security.test.ts` → `"A9.2: a hostile display name, chat title, and forum topic name render in the preamble with no \`<\` or \`>\` at all, all through the one \`sanitizeIdentity\`"` | **RED** — the stored ref held the raw `<topic>…` markup → restored → GREEN                                                                |
| 5   | **Fence / `ownRecent` defuse** (§9.2, A9.5)           | `runtimes/shared/room-context-block.ts` — `body()` → `defuseSystemTags(text, SYSTEM_TAGS)`                         | `body()` returns `text` unchanged                                                   | `bridged-room-security.test.ts` → `"A9.5: external text the agent quotes back lands in \`ownRecent\` (outside the fence) with its tags defused"`                                                    | **RED** — quoted external tags survived undefused in `ownRecent` → restored → GREEN                                                       |
| 6   | **Consent gate `canReply` branch** (§6.6, A6.4)       | `relay/initiate-consent.ts` — `checkBridgePrincipal`'s `if (bindingAllowsReply(binding)) return { allowed: true }` | Condition forced to `true` so a reply is allowed regardless of `canReply`           | `deliver.test.ts` → `"A6.4: an agent answer reaches the chat with canReply on, is blocked with canReply off"`                                                                                       | **RED** — the `canReply: false` case delivered instead of blocking → restored → GREEN                                                     |
| 7   | **Transcript probe** (§7.3, A7.2)                     | `chat-bridge/adopt-session.ts` — `if (!exists) return this.fresh(...)` after `hasTranscript`                       | `&& false` appended so a failed probe no longer forces a fresh start                | `adopt-session.test.ts` → `"A7.2: a sessionMap id that FAILS the transcript probe starts fresh with the pointer-less notice"`                                                                       | **RED** — a session that failed the probe was adopted anyway → restored → GREEN                                                           |

## Findings worth carrying forward

- **A9.2 pins the store, not the render.** Bypassing the render-time label sanitizer (`room-context-block.ts` `label()`) alone left A9.2 **green** — the test builds hostile input, hands it to the real `ChatBridge.ingest` raw, and asserts the _stored_ ref is already sanitized. The load-bearing sanitize for that criterion is the store-time call in `ingest.ts`; the render-time `label()` is defence-in-depth. Both matter, but only the store-time deletion turns A9.2 red, which is the honest thing for the test to pin (a render-only guard would let a pre-render reader see raw markup). Mutation #4 targets the site the test actually names.
- **Dedup has two layers.** Deleting the application-level dedup (#1) still failed the write at the DB UNIQUE index rather than silently double-ingesting — so the invariant is defended twice. The naming test still goes red (it asserts _one entry, one turn_, and a thrown write is neither), which is the point: the test fails when the graceful mechanism is gone, regardless of the backstop.

## How to reproduce

Each row is reproducible by re-applying the mutation and running the single named test:

```bash
pnpm vitest run <naming-test-file> -t "<criterion id>"
```

Restore verification for the whole set (all mechanisms in place):

```bash
pnpm vitest run \
  apps/server/src/services/relay/chat-bridge/__tests__/ingest.test.ts \
  apps/server/src/services/relay/chat-bridge/__tests__/deliver.test.ts \
  apps/server/src/services/relay/chat-bridge/__tests__/bridged-room-security.test.ts \
  apps/server/src/services/relay/chat-bridge/__tests__/adopt-session.test.ts \
  apps/server/src/services/relay/__tests__/binding-router-bridge.test.ts
# → Test Files 5 passed (5), Tests 77 passed (77)
```
