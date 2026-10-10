# One-minute onboarding and automatic model choice — specification

**Linear:** DOR-2783, DOR-2784. **Ideation:** [`01-ideation.md`](01-ideation.md). **ADRs:** [`261010-143210`](../../decisions/261010-143210-the-first-run-is-account-first-and-lands-in-team.md) (the first run), [`261010-143211`](../../decisions/261010-143211-dorkos-picks-the-model-per-chat.md) (model choice). **Research:** `research/20261007_one-minute-onboarding.md` ("research §n").

Five build PRs after this one, in the order of §9. Each ships something a person can use.

## 1. What a new person sees

```
 Welcome ──► Continue with DorkOS ──► (browser: sign in + card) ──► #team, DorkBot's welcome + three chips
    │
    ├──► Use my own AI ──► key, local model, or an AI app sign-in ──► #team
    └──► Continue without an account ─────────────────────────────► #team (welcome says how to connect AI)
```

The clock runs from the Welcome screen to DorkBot's first real reply in #team. The bar is under 60 seconds on the DorkOS path with a wallet or saved card, and on the own-AI path with a key in hand or a local model running. A browser test enforces it (§8).

## 2. Screens (client, `features/onboarding`)

The four-stage machine (`welcome`, `requirements`, `power`, `conversation`) is replaced by four new stages: `welcome`, `connecting`, `own-ai`, `landing`. The `?onboarding=` search param keeps working with the new values; a stale value lands on `welcome` (as today).

### 2.1 Welcome

- The DorkOS mark, "You, Multiplied." and "Build and run your business with an agent team."
- Primary button **Continue with DorkOS**. Under it, the eligibility line from `CLOUD_ELIGIBILITY_TEXT` (`CloudEligibilityNote.tsx`), unchanged: it is word for word the pricing page, so it is reused, never paraphrased.
- Two quiet links: **Use my own AI** and **Continue without an account**.
- No scan, no animation hold before the button can be pressed, no runtime, model or vendor names.

### 2.2 Connecting (DorkOS path)

- Pressing Continue calls `POST /api/onboarding/first-run { path: 'dorkos' }` (§4.1), then starts the existing device link (`useCloudLink().start({ origin: 'onboarding' })`) and opens `verificationUriComplete` (§5.1) in a new tab at once. No code to type.
- The screen says "Finish in your browser." with the code and a Copy button as the fallback for a blocked tab ("Open the page again", the address as text).
- It advances on its own, with no click, when the server reports the state **ready** (§5.2). It shows "Add a card to finish." with a button to the billing page when the account is linked but has no card on file, and "Paid plans are US only. Use your own AI instead." with a link to Own AI when the service refuses eligibility.
- Cancel returns to Welcome and cancels the code. Choosing another path afterwards undoes this one's writes (§4.1).

### 2.3 Own AI

One list, DorkOS engine first, each a single row:

| Row                      | What it asks                                            | Result                                                     |
| ------------------------ | ------------------------------------------------------- | ---------------------------------------------------------- |
| An OpenAI API key        | the key                                                 | Doe on `api-key`, model chosen by DorkOS (§6.3)            |
| An Anthropic API key     | the key (refuses `sk-ant-oat…`, as `validateDoeSecret`) | same                                                       |
| An OpenRouter key        | the key                                                 | same                                                       |
| A model on this computer | nothing when Ollama answers on its default port         | Doe on `local`, first model the server lists               |
| An AI app you sign in to | opens today's runtime connect cards, reworded           | Claude Code, Codex or OpenCode on the person's own sign-in |
| Other service            | endpoint, format, key (today's `DoeInferenceForm`)      | Doe on `api-key` or `local`                                |

Names are allowed on this screen, because the person asked for them. "Runtime" never appears ("AI app" instead). Saving calls `POST /api/onboarding/first-run { path: 'own', ... }` (§4.1) and goes to Landing.

### 2.4 Landing

- Calls `POST /api/onboarding/welcome` (§4.2), marks onboarding complete (`completedAt`), and navigates to #team (the well-known `team` room).
- In #team, a chip strip sits under DorkBot's welcome while the welcome is the newest entry and the person has not posted in the room. Chips: **Build me a tracker for my customers**, **Make a daily plan board**, **Something else**. A chip posts the person's message `@dorkbot <chip text>` (Something else focuses the composer with `@dorkbot ` filled in). The strip is a client component in `widgets/room-view`, keyed on `onboarding.welcomeEntryId`.
- On the no-AI path the welcome's text asks the person to connect AI, and the strip shows **Continue with DorkOS** and **Use my own AI** instead, opening Settings › DorkOS account and the Own AI list in a dialog.

### 2.5 What leaves the first run

`SystemRequirementsStep`, `OnboardingPowerStep` and `OnboardingConversation` leave the overlay. The requirements step's connect cards stay as the "AI app you sign in to" row. The conversation's widgets (identity, personality, profile, discovery) are deleted with their beats when nothing else imports them; the name comes from the sign-in (`/api/cloud/status` account name when present) and is editable on the profile page. The `FullPowerDoor` stays in the moments rail and Control Center. "Show me around" stays reachable from the help menu, as today.

## 3. Copy

All strings follow `writing-app-copy` (15 words a block, no "we", "chat" not "session"). DorkBot's welcome (server, `packages/shared/src/dorkbot-templates.ts`):

- DorkOS path: "Hi {name}. Your agents run on DorkOS. Usage is in Settings." then "Want a first tool? Pick one below, or tell me what you need."
- Own AI path: "Hi {name}. Your agents are ready." then the same offer.
- No AI: "Hi {name}. Agents need AI to reply. Connect DorkOS or your own."

`{name}` falls back to "there". The seeded DorkBot `AGENTS.md` loses the retired category line and describes running a business and building mini apps (research §1.2).

## 4. Server: first-run API (`apps/server/src/routes/onboarding.ts`, new)

### 4.1 `POST /api/onboarding/first-run`

Body: `{ path: 'dorkos' } | { path: 'own', choice: OwnAiChoice } | { path: 'none' }`. Records `onboarding.firstRunPath` (§7), stamps `onboarding.runtimeDefaultSetAt`, and applies the person's pick. **Each call first undoes the previous path's writes**: the credits record it wrote goes back to `{ runsOn: 'own-sign-in', chosenBy: 'user' }`, and `runtimes.default` and DorkBot's runtime return to what they were before the first call (kept in memory of the route's first call as `onboarding.priorRuntime`, §7). So "press Continue, cancel, save a key" never leaves credits armed.

- **`dorkos`:** `runtimes.default = 'doe'` and DorkBot's manifest `runtime = 'doe'`. The credits record is **not** written here: a new link resets every credits choice in `fillCreditsGaps` (`credits-defaults.ts`, the `linkedTo` account check). Instead the new-link hook (`setOnNewLink` in `index.ts`), after `fillCreditsGaps`, writes `cloud.credits.defaults.doe = { runsOn: 'credits', chosenBy: 'user', announced: true, signInReoffered: false }` when `onboarding.firstRunPath === 'dorkos'` and `completedAt` is null. That is the person's pick, so no "DorkOS chose for you" notice follows. Nothing spends until then; a credits turn with no live token refuses (ADR 261001-000811).
- **`own` with a Doe choice** (`openai`, `anthropic`, `openrouter`, `local`, `custom`): stores the key with `storeDoeCredential`, writes `runtimes.doe.inference` from the preset (§6.3), sets `runtimes.default = 'doe'` and DorkBot on `doe`.
- **`own` with `agent-app`:** writes nothing beyond the undo; the connect cards keep `useOnboardingRuntimeDefault` (it moves with them out of `SystemRequirementsStep`) to pick the default runtime from what signed in.
- **`none`:** records the path only.

Existing installs never reach this route (the overlay shows only while `completedAt` and `dismissedAt` are null). The route refuses with 409 once `completedAt` is set. It sits behind the same bars as `doe-setup-router.ts` (loopback or a signed-in Owner, `refuseUnlessAccountOwner`), because it stores a credential and changes the default runtime, and it calls the existing guarded helpers (`storeDoeCredential`, the mesh manifest write-through) so `gate-bypass-scan.test.ts` keeps one caller list per helper; the scan's allowlist grows by this file with its reason. Every write is the person's own choice in the app, so the money-path rule holds.

### 4.2 `POST /api/onboarding/welcome`

Idempotent. Posts DorkBot's welcome into #team, stores the entry id in `onboarding.welcomeEntryId`, and returns it. A second call returns the stored id without posting. It must start no agent turn: `RoomService.post` dispatches triggers and #team seats every agent, so the welcome goes through the non-dispatching system-post path (`room-system-posts.ts`, as `postMoment` does), widened to allow DorkBot as the author. A test proves no turn starts and no notification is sent.

## 5. Cloud link and credits readiness

### 5.1 The filled-in address

`cloud-link.ts` forwards the device response's `verification_uri_complete` as `StartLinkResult.verificationUriComplete` (optional; absent when the service sends none). The client opens it when present, else today's `verificationUri?code=` (`PendingLinkCode.openVerification`).

### 5.2 Readiness

`GET /api/cloud/credits` gains `readiness: 'unlinked' | 'linked' | 'needs-card' | 'ready' | 'refused'`:

- `ready`: linked, a credits token is held that serves a format Doe can use, and the catalog names a `recommendedOn` model for it.
- `needs-card`: linked, and the balance says `paymentMethodOnFile: false` (§5.3).
- `refused`: minting answered `entitlement_required` (eligibility).
- `linked`: anything else while linked (still minting, catalog not read yet).

The client polls it every 2.5 s while Connecting is on screen. `StartLinkResult` lives in `packages/shared/src/cloud-schemas.ts`; the new optional field lands there.

### 5.3 Contract change (its own PR, label `cloud-contract`)

`packages/cloud-api` `BalanceSchema` gains `paymentMethodOnFile: z.boolean().optional()` — whether the account has a saved payment method that later charges can use. Absent means unknown and is never read as "no card". README rules: a new optional field inside `/v1`; the billing JSON-schema baseline is regenerated. The app treats unknown as "do not block": readiness follows the token and catalog.

### 5.4 What DorkOS Cloud must build (CLD issue, named in the PR body without private detail)

1. The device-code approval page signs the person in (Google, GitHub, Apple; email with a one-time code, no blocking email check) and saves a card (Link, Apple Pay, Google Pay, card form; for future payments) with a visible monthly limit and an explicit auto top-up choice, and completes approval only after the card is saved.
2. Return `verification_uri_complete` on every device code.
3. Any account with a saved card can mint an inference token; no plan purchase first.
4. No hold on the first spend.
5. Fill `paymentMethodOnFile` on `/v1/balance`.
6. Mint quickly after approval; every token's `served` lists the formats the catalog recommends models in, and the catalog names a `recommendedOn` model for at least one of them.

## 6. Automatic model choice (DOR-2784)

### 6.1 Doe on credits with nothing chosen

`runtimes.doe.inference: null` means "chosen by DorkOS". At a chat's first turn (`execute-turn.ts`, today the "Choose a model in DorkOS runtime settings." refusal), when `agentRunsOnCredits` says yes for the chat's agent (one rule, not restated here), the runtime builds the chat's inference from the catalog: for each format in the preference order `anthropic-messages`, `openai-responses`, `openai-chat-completions` that the held token serves, take the model whose `recommendedOn` names it. First match wins. The frozen record is `{ source: 'dorkos-credits', provider: 'dorkos', protocol, endpoint: <token endpoint>, model, contextWindow, maxOutputTokens }` from the catalog entry. No match refuses with `CreditsUnavailableError('no-models')`, never another payer. A person's per-chat or per-agent model choice wins when credits serve it (today's `resolveCreditsLaunchModel` rule).

Credits not chosen and nothing configured keeps today's refusal, reworded: "Connect AI to use this agent." with the Own AI action.

### 6.2 The model list

`getSupportedModels` for Doe on credits returns the catalog's models for the served formats, the auto-picked one first with `isDefault: true` and the description "Chosen by DorkOS". With an explicit inference it returns that one model, as today. Model names show only where a person goes looking (the model popover, Settings).

### 6.3 Own key and local presets

A table in `apps/server/src/services/runtimes/doe/presets.ts`: per service, protocol, endpoint and a short preference list of model id prefixes. After the key is saved, the server reads the service's model list (`GET {endpoint}/models`, with the key), picks the first listed id matching a preference in order, else the first listed. Context window and output limit come from the service's list when it reports them, else a conservative 128,000 / 8,192 (32,768 / 4,096 for local). Nothing reaches a service before the person pressed Save. A failing list read keeps the key and shows "Couldn't reach {service}. Check the key." The preset ids and preference lists are app data, changeable in Settings, never shown during the DorkOS path.

### 6.4 Status bar

- `model` item: `promote: () => false`, on every runtime and for existing installs too. That is intended (Dorian, 2026-10-07: hidden by default). It shows only when pinned (it is already in `StatusBarPinSchema`), and in the `⋯` popover with its pin toggle. No config change, no seeded pin (research §6).
- `runtime` (Runs on) item: also stays unpromoted when the chat's runtime is `doe` (nothing to choose once a chat started, ADR-0255). "Runs on: DorkOS" still reads in the pinned item, the agent's settings and the Runs on list.
- Tests updated: `status-bar-registry.test.ts`, `promoted-items.test.ts`, the budget comments in `status-budget.ts`, `apps/e2e/tests/chat/status-line-fit.spec.ts`, and `StatusLineShowcases.tsx`.

### 6.5 Settings

The DorkOS runtime card in Settings gets a **Model** row: "Chosen by DorkOS" by default, a menu of the catalog's models (or the own-key service's), and "Chosen by DorkOS" to go back (writes `inference: null` on credits; on own key, re-runs the preset pick). The agent dialog's model row reads the same way for agents on Doe.

## 7. Config

`OnboardingStateSchema` gains two scalars (never a widened list; research §1.4):

- `firstRunPath: z.enum(['dorkos', 'own', 'none']).nullable().default(null)`
- `welcomeEntryId: z.string().nullable().default(null)`
- `priorRuntime: z.string().nullable().default(null)`: the default runtime before the first-run route's first call, for its undo.

Migration key `0.106.0` (above `0.105.0`, the highest today; `0.104.0` is held by work in flight) seeds all three as `null` on stored onboarding blocks, following the `adding-config-fields` skill. The second declaration of the defaults, the `onboarding` object literal in `UserConfigSchema`, gains them too (the twice-declared-defaults trap). `ONBOARDING_STEPS` is unchanged; the `power`, `meet-dorkbot`, `profile` and `discovery` members stay valid for older builds.

## 8. Proof

- **Unit:** route tests for §4 (each path's writes, 409 after completion, idempotent welcome), readiness (§5.2) for every state, the auto-pick rule (§6.1) including the refusal, presets (§6.3) with a fake `/models`, status-bar promotion.
- **Test-mode Cloud.** Three seams, all only under `DORKOS_TEST_RUNTIME`:
  1. `v1-client.ts`'s `createCloudApiClient` gains the `fetch` the client already accepts, so one fake `FetchLike` answers `/v1/balance` (with `paymentMethodOnFile`), `/v1/entitlements`, the inference token and the models catalog, beside the link handshake `fake-cloud-link.ts` already scripts.
  2. The fake's `verification_uri_complete` points at a local page the server mounts in test mode (`/api/test/fake-cloud/approve?code=`), which approves the code, so opening it at once never reaches the real site.
  3. Doe is registered in test mode beside `TestModeRuntime` (today only the production branch registers it), and the token's endpoints point at an in-process fake OpenAI-compatible stream that answers with a canned reply.

  Nothing leaves the machine; no money-path flag is involved.

- **Browser:** `apps/e2e/tests/onboarding/first-run.spec.ts` runs the DorkOS path (the fake approves on page open) and the own-AI path (a fake local endpoint), and stops the clock at **DorkBot's first real reply to a chip**, not at the scripted welcome. It asserts under 60 seconds from Welcome, and that no runtime, model or vendor name is visible on the DorkOS path. Old specs that pin removed copy are updated or deleted: `onboarding-power.spec.ts` moves its door assertions to `full-power-door.spec.ts`.
- **Live dogfood:** a fresh data directory on an own dev port, stopwatched, on both paths: the DorkOS path with the test-mode Cloud, and the own-AI path with a local model.

## 9. Build PRs

| #   | PR                                                                                                | Ticket   | Ships                                                         |
| --- | ------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------- |
| 0   | This spec and the two ADRs                                                                        | both     | the plan                                                      |
| 1   | Contract: `paymentMethodOnFile` (§5.3), label `cloud-contract`                                    | DOR-2783 | the field Cloud fills                                         |
| 2   | DorkOS picks the model: §6.1, §6.2, §6.4, §6.5                                                    | DOR-2784 | Doe runs with no setup on credits; model hidden in status bar |
| 3   | Own AI presets (§6.3) and the first-run server API, readiness, welcome, config (§4, §5.1-5.2, §7) | DOR-2783 | a key or local model works in one step                        |
| 4   | The new first run (§2, §3), test-mode Cloud and the browser proof (§8)                            | DOR-2783 | Welcome to #team in under a minute                            |
| 5   | Getting-started docs and ROADMAP demo-claim move, once 4 is merged and proven                     | DOR-2783 | public words match the product                                |
