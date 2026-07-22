# DorkBot Is the Onboarding — Specification (Tier 1, DOR-417)

**Id:** 260722-110713 · **Status:** specified · **Depends on:** Tier 0 (DOR-416) overlay latch — Tier 1 branches from main after DOR-416 merges.

## Summary

Replace the Meet-DorkBot screen, the discovery screen, and the finish screen with one scripted, client-driven conversation with DorkBot. The flow becomes: Welcome → Ready gate → **Conversation** → (dissolves into a real session). All DorkBot speech in the conversation is client-generated and token-free; real inference starts with the user's first real message. No server changes, no config-schema changes, no migration.

## The conversation script

The conversation surface looks and behaves like a DorkOS chat: DorkBot messages on the left rendered with the real message components, an input composer at the bottom, choice chips where the script offers options. Between lines, DorkBot "types" (TypingDots) with short staged reveals; `prefers-reduced-motion` collapses reveals to instant. A click/tap anywhere in the message area fast-forwards the current reveal. Scripted DorkBot messages announce via `aria-live="polite"`.

### Beat 0 — Arrival

FirstLight treatment (reuse `FirstLight` with a synthesized record for DorkBot: name, avatar, "DorkBot is waking up…"), ~1.5s, then the first messages appear:

> Hey, I'm DorkBot. I live here.
>
> I'm your first agent. I can schedule work, pass messages between your agents, and help you run this place.

The composer is visible from the start but disabled with placeholder "DorkBot is setting things up with you…" until Beat 3.

### Beat 1 — Personality (replaces MeetDorkBotStep)

> First: how should I sound? Pick a personality. You can change it any time in settings.

An inline widget renders under this message: `PersonalityPicker` in `compact` mode (preset pills + radar; Custom reveals `TraitSliders`). On every preset selection (or slider settle), DorkBot posts a **sample line in that voice** as a new scripted message, replacing the previous sample (one sample bubble, content swaps). Sample lines are authored per preset in `packages/shared/src/dorkbot-templates.ts` (new `generateVoiceSample(traits)` alongside `generateFirstMessage`; keyed off the same trait space, personality-true, one sentence each, plain language, no hype).

A choice chip **"That's the one"** advances: PATCH traits to the DorkBot manifest exactly as today (`useUpdateAgent` with `{defaultDirectory}/dorkbot`), then `completeStep('meet-dorkbot')`. Failure: DorkBot says an honest error line ("I couldn't save that. Try again?") with a retry chip; the flow never advances on a failed save.

### Beat 2 — Discovery (replaces AgentDiscoveryStep, becomes consent-first)

> Want me to look around this machine for projects and agents you already have?

Chips: **"Sure, look around"** / **"Not now"**.

- **Consent:** the scan starts _now_ (`useDiscoveryStore.startScan()`), not before — this is more privacy-honest than today's prefetch-during-personality, which is removed. DorkBot shows "Looking…" with the scanning indicator. Resolution:
  - **Candidates found:** "Found {N}. Want them in your fleet?" followed by inline `CandidateCard`s (reuse from `entities/discovery`, wired to `useRegisterAgent` + `buildRegistrationOverrides`, `useActedPaths` semantics preserved) plus an "Add all" chip and a "Done" chip. Advance → `completeStep('discovery')`.
  - **Zero results:** "I looked around. This machine is quiet so far. We can add agents any time." Advance → `completeStep('discovery')`.
  - **Timeout (8s, keep the existing budget) or scan error:** "That's taking longer than I expected. I'll keep looking in the background; check the Agents page later." Advance → `skipStep('discovery')`. (The shared store keeps any late results for the mesh panel, same as today.)
- **Decline:** "No problem." → `skipStep('discovery')`.

### Beat 3 — Handoff (replaces OnboardingComplete)

On reaching this beat, write `completedAt` (`completeOnboarding()`), preserving today's refresh-persistence semantics; the Tier 0 latch guarantees the overlay survives the refetch.

> Last thing: what are we building today? Tell me, and we'll get started.

The composer enables (placeholder: "Tell DorkBot what you're working on…"). Optional suggestion chips that _insert text into the composer_ (never auto-send): "Show me around", "Help me set up a project", "Just exploring for now".

**On submit:** a brief celebration (Tier 0's bounded confetti), then dissolve: register a pending first message for a fresh session id (see Dissolve mechanics), `navigate({ to: '/session', search: { dir: defaultAgentPath, session: newSessionId } })`, `onComplete()` (sets `onboardingHiddenForSession`). The user lands in a real session where their message appears as **their own user message** and DorkBot's reply is real inference.

There is no finish screen. Deleting it deletes the unmount race's blast radius too.

### Skip semantics (unchanged contract)

"Skip setup" stays in the nav bar throughout the conversation → `dismiss()` (dismissedAt), exactly today's semantics. The Welcome step's "Skip setup" is untouched. Step dots are removed from `OnboardingNavBar` (a conversation is not a dotted wizard); the nav bar keeps Back (to the ready gate) and Skip setup.

## Architecture

### New modules (feature `onboarding`)

- `model/onboarding-script.ts` — the script as data: ordered beats, each `{ id, lines(traits), widget?, chips?, advance }`. Pure, unit-testable. Copy lives in `@dorkos/shared/dorkbot-templates` (new functions; keeps DorkBot's voice in one place).
- `model/use-onboarding-conversation.ts` — reducer/state machine: current beat, revealed messages (`ChatMessage[]` synthesized: `{ id, role, content, parts: [{type:'text',text}], timestamp }`), typing state, fast-forward, advance/choice handlers. No transport calls of its own; it receives the mutation callbacks (traits PATCH, discovery actions, complete/skip/dismiss) as an injected port so tests drive it synchronously.
- `ui/OnboardingConversation.tsx` — the surface: FirstLight arrival, message list, inline widgets, chips, `ChatInput`.

### Reuse decisions (validated against source)

- **Messages:** render scripted messages with `MessageItem`/`UserMessageContent`/`AssistantMessageContent` in a plain scroll container — **not** `MessageList`: ~a dozen messages need no virtualizer, and this avoids its required live `sessionId`. Text renders through the real `StreamingText` (`sessionId` omitted, which is supported by design).
- **Composer:** `ChatInput` directly (fully controlled, zero session imports). Never `ChatInputContainer`.
- **FirstLight:** rendered standalone with a synthesized `AgentBirthRecord`-shaped object for DorkBot.
- **Personality:** `PersonalityPicker compact` (or the `PersonalityPickerPanel` template) — identical trait-save call shape as the deleted step.
- **Discovery:** `CandidateCard` + `useRegisterAgent` + `buildRegistrationOverrides` + `useActedPaths`, wired inline.
- **FSD compliance:** onboarding (feature) rendering chat/agent-hub components is UI composition across features — allowed. The dissolve mechanism lives in `shared/model` (see below), so no feature→feature model import exists.

### Dissolve mechanics (the one new mechanism)

The only production auto-send path is the agent-birth kickoff, and `kickoff: true` deliberately suppresses the user bubble (built for "agent says hello first"). Our case is the opposite: the user's words must render as their message. Extend the existing mechanism rather than building a parallel one:

- `shared/model/agent-birth/agent-birth-store.ts`: `AgentBirthRecord` gains `kind: 'kickoff' | 'first-message'` (default `'kickoff'`; all existing call sites unchanged).
- `use-auto-kickoff.ts`: when the claimed/registered record has `kind: 'first-message'`, submit via the normal submission path (user bubble renders, message goes to the server as a standard turn) instead of `submitKickoff`. Same empty+idle+unfired guards, same one-retry + `markGreetingFailed` honesty on failure (failure copy adjusted: the _message_ failed to send — surface the standard send-failure affordance rather than a greeting-failed line).
- Onboarding registers `{ kind: 'first-message', kickoffMessage: <user's text>, path: defaultAgentPath, ... }` under the fresh session id before navigating. `claimByPath` re-keying works unchanged.
- **Regression guard:** existing kickoff behavior (create-agent flow) must be covered by tests before and after the change.

### Deletions (complete, no legacy left)

- `MeetDorkBotStep.tsx`, `AgentDiscoveryStep.tsx`, `OnboardingComplete.tsx` + their tests (assertions migrate to the new surface's tests where still meaningful).
- `dorkbotFirstMessage` / `setDorkbotFirstMessage` app-store field and the `ChatEmptyState` DorkBot-welcome branch + `layoutId="dorkbot-first-message"` (superseded: the real session now opens with a real first turn). `generateFirstMessage` is retired or absorbed into the new template set — no orphan exports.
- `OnboardingFlow` step-index machinery for steps 0/1 (`MEET_DORKBOT_STEP`, `DISCOVERY_STEP`, `routeAfterMeetDorkbot`, discovery decision/timeout logic — the timeout budget moves into the conversation's discovery beat), step dots in `OnboardingNavBar`, `totalSteps` honesty logic.
- The discovery prefetch-on-meet-dorkbot effect (scan is consent-gated now).

### Persistence mapping (no schema change)

`ONBOARDING_STEPS` stays `['meet-dorkbot', 'discovery']`: Beat 1 completes `meet-dorkbot`, Beat 2 completes/skips `discovery`, Beat 3 writes `completedAt`. `startedAt`, `dismissedAt`, Replay-setup, ProgressCard, and the upgrade migration are all untouched.

## Test plan

- `onboarding-script.test.ts` — beat ordering, line generation per traits, chip-advance transitions, fast-forward, reduced-motion collapse.
- `OnboardingConversation.test.tsx` — arrival renders FirstLight then messages; composer disabled until Beat 3; personality selection posts a voice sample and "That's the one" PATCHes traits (call shape identical to the old MeetDorkBot assertions: path + traits); trait-save failure shows retry and does not advance; discovery consent starts the scan (and no scan starts without consent), candidate approve registers with `buildRegistrationOverrides`, zero-result and timeout lines, decline skips; Beat 3 writes `completedAt` on reach; submit registers a `first-message` birth record and navigates with a fresh session id.
- `use-auto-kickoff` tests — `kind: 'first-message'` submits as a normal user turn; existing `kickoff` behavior unchanged (regression).
- `OnboardingFlow.test.tsx` — rewrite: Welcome → Requirements → Conversation; Skip-all dismisses; no step dots.
- Delete/migrate `magic-transition.test.tsx` (dorkbotFirstMessage mechanism is gone).

## Acceptance (fresh-install walkthrough, browser-verified in Docker)

1. Ready gate → DorkBot arrives and speaks; no forms, no step dots.
2. Personality selection audibly changes DorkBot's sample line; saved traits persist to the manifest (verify via a later real turn's persona).
3. No filesystem scan occurs before the user consents; consent path shows results or the honest zero line; decline is respected.
4. First real message lands in a live session as the user's own message; DorkBot's reply is real inference in the chosen personality; onboarding never reappears on refresh.
5. "Skip setup" works at every beat with today's dismiss semantics.
6. Zero tokens consumed before the user's first message.

## Execution plan

Single worktree, single implementing agent (opus), phased commits: (1) script engine + conversation surface, (2) personality beat, (3) discovery beat, (4) handoff/dissolve + deletions + test migration. Auditor review per REVIEW.md before PR. Tier 2 (DOR-418) and Tier 3 (DOR-419) build on this surface and are specified separately after Tier 1 lands.

## Risks

- **Kickoff-path extension** touches live chat submission: mitigated by the regression tests and the `kind` default preserving existing behavior.
- **Timers/animation flake in tests:** the reducer is synchronous and injectable; UI tests drive beats via the reducer, not real timers.
- **Copy drift:** all DorkBot lines live in `@dorkos/shared/dorkbot-templates` with unit tests asserting personality inflection; the writing-for-humans standard applies.
