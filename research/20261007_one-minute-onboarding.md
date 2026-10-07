---
title: 'One-minute onboarding: audit of the first run today, and a DorkOS-first path under a minute'
date: 2026-10-07
type: internal-architecture
status: active
tags:
  [
    onboarding,
    first-run,
    dorkos-account,
    credits,
    stripe,
    status-bar,
    dorkbot,
    mini-apps,
    vision-202610,
  ]
---

# One-minute onboarding: audit of the first run today, and a DorkOS-first path under a minute

**Date:** 2026-10-07. **Asked by:** Dorian (vision brief item 19, "DorkOS first, ready in under a minute").

**The decisions this designs for:** a new user can use DorkOS right away with no Claude, ChatGPT or OpenRouter subscription. The default path is a DorkOS account, DorkOS Cloud and DorkOS credits, on DorkOS's own runtime. No runtime name, model name, agent name or new concept appears while getting started. The account is the default but can be skipped, and free local use with no account stays true. A card is required for credits (no free starter credits), captured fast with Stripe Link, Apple Pay or Google Pay. DorkOS picks the model; a person can change it in Settings and from a status-bar item that is hidden by default but can be pinned.

**How this was made.** A read-only pass over the install scripts, the CLI, the desktop shell, the onboarding feature, the connect flows, the status bar, settings, docs and the public cloud contract, at commit `fdfe99110`. Timings are estimates from constants in the code plus typical network times; nothing was measured live. The private cloud repo was not read. Companion report: `research/20261007_dorkos-runtime.md`.

---

## The answer in one paragraph

Underneath, "no subscription needed" already works: link a DorkOS account and credits pay for Claude Code. What is wrong is the order and the names. Today's first run is runtime-first (a "Connect your first runtime" gate naming Claude Code, Codex and OpenCode), credits appear only inside a runtime's card and only when nothing is signed in, linking takes two windows and an email verification, and a six-beat scripted chat follows. From a cold start with no AI account it takes about **4 to 8 minutes** after install; with Claude Code already signed in, about **1 to 2 minutes**. The new path has **three screens and about 25 to 60 seconds from the first screen to the first agent reply**: one welcome with "Continue with DorkOS", one browser page that signs you in (Google, Apple or GitHub) and saves a card (Link, Apple Pay or Google Pay) in one go, then you land in #team where DorkBot offers to build your first mini app. "Use my own AI sign-in" and "Continue without an account" are always one click away. Two things can break it and need Cloud's help: a hold on the first purchase, and paid plans being US-only and 18 or older, which makes the default path US-only at launch and the own-key path everyone else's real first run. The model item in the status bar becomes hidden by default with a one-line change. Install time is outside the minute and needs its own fix: the npm package carries about 480 MB of bundled Claude Code and Codex binaries that the new default path does not need.

---

## 1. Today's first run, step by step

### 1.1 Install (before the app opens)

- **npm / npx.** `packages/cli/package.json` depends on `@anthropic-ai/claude-agent-sdk` (whose darwin-arm64 binary is about 207 MB) and `@openai/codex` (about 277 MB), plus native `better-sqlite3`. Install takes 1 to 3 minutes; docs say "a minute or two" (`docs/getting-started/installation.mdx:30`).
- **`curl | bash`** (`apps/site/scripts/install.sh`) installs Node checks plus `npm install -g dorkos`, then offers "Run setup wizard now?" only when stdin is a terminal (`:108`). Under a pipe it never asks, but `installation.mdx:58` says it does. Small docs bug.
- **First `dorkos` run** (`packages/cli/src/cli.ts`): checks for the Claude Code binary and prints a yellow "Claude Code CLI not found" warning with Anthropic install links if it cannot launch one (`check-claude.ts:53-68`; normally silent because the binary is bundled), creates `~/.dork/config.json`, picks port 4242, prints the banner and opens the browser (only from a terminal).
- **Desktop** (`apps/desktop`): no splash. The window stays hidden until first paint or a 4 s fallback (`window-manager.ts:330`), while the server can take up to 70 s before giving up (`shared/boot-timeouts.ts:33`). macOS asks "Move to Applications?" on first launch. Claude Code and Codex are bundled. Desktop-owned UI names no runtimes.

### 1.2 In the app

The client shows a full-screen onboarding overlay instead of the app until onboarding is completed or dismissed (`apps/client/src/AppShell.tsx:614-636`, rule in `features/onboarding/model/use-onboarding.ts:82-86`). Four stages (`onboarding-stage.ts:15`), each with Back and "Skip all setup":

| #   | Stage                                                                                 | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Can skip?            |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| 1   | Welcome (`WelcomeStep.tsx`)                                                           | "Welcome to DorkOS", "Your agents are minutes away.", Get started / Skip all setup. About 1.2 s of animation before the button.                                                                                                                                                                                                                                                                                                                                                | Yes                  |
| 2   | Requirements (`SystemRequirementsStep.tsx`)                                           | A scan held for at least 2.2 s: "Looking for Claude Code, Codex, and OpenCode on your machine." Then either **"You're ready"** ("Claude Code is connected. New chats will start with it.", a "Change" menu listing every runtime, "N more to set up") or **"Connect your first runtime"** ("DorkOS runs Claude Code, Codex or OpenCode.") with one card per runtime. In the second case there is **no Continue button**: connect something, go back, or skip everything.       | Only by skipping all |
| 2a  | Connect card (`RuntimeConnectFlow.tsx:42-137`)                                        | Credits lead **only** when that runtime has no sign-in at all and credits are wired for it (`entities/runtime/lib/credits-offer.ts:96-107`). Signed out of DorkOS, only Claude Code is wired (`credits-protocols.ts:217`). The card says "Use DorkOS credits" and "One account for Claude Code.", then "OTHER WAYS": "Sign in with Claude", "Anthropic API key", and so on.                                                                                                    |                      |
| 2b  | Account link (`features/cloud-link/ui/PendingLinkCode.tsx`)                           | A device code (RFC 8628): "Enter this code to link", copy, "Open the approval page" (new tab; may be popup-blocked). On dorkos.ai: sign up, **verify email** ("Sign-in stays blocked until you do", `docs/account/index.mdx:62`), approve. The app polls, mints a credits token, makes credits the default for runtimes with no sign-in (`credits-defaults.ts:260`). With no balance it then says "Your DorkOS account has no credits left to spend." and opens a top-up page. |                      |
| 3   | Power (`OnboardingPowerStep.tsx`)                                                     | "Choose your power level": "Unlock full power" / "Keep asking me first" / "Decide later".                                                                                                                                                                                                                                                                                                                                                                                      | Yes                  |
| 4   | DorkBot conversation (`OnboardingConversation.tsx`, script in `onboarding-script.ts`) | Scripted and token-free (ADR 260722-111314). About 1.1 s per line. Beats: arrival, name and @handle, personality, kind of work, "look around this machine" scan (up to 8 s), then "what are we building today?" with chips "Show me around", "Help me set up a project", "Just exploring for now". The first message lands in a DorkBot session; "Show me around" or skipping lands in #team.                                                                                  | Each beat            |

What DorkBot offers on first run: nothing about mini apps, the account or credits. Its seeded `AGENTS.md` still says "DorkOS is the operating system for autonomous AI agents" (a retired line, `packages/shared/src/dorkbot-templates.ts:20-43`). DorkBot is created with `runtime: 'claude-code'` (`apps/server/src/services/mesh/ensure-dorkbot.ts:159`). None of its operating skills teaches building a mini app.

### 1.3 Honest timing

| Step                                         | Claude Code already signed in            | No AI account at all                                                                                                                 |
| -------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Install (npm or desktop download)            | 1 to 3 min                               | same                                                                                                                                 |
| Welcome                                      | 2 to 3 s                                 | 2 to 3 s                                                                                                                             |
| Requirements scan                            | 3 to 5 s, then "You're ready"            | 3 to 5 s, then "Connect your first runtime"                                                                                          |
| Account link on credits                      | never offered                            | **2 to 5 min** (sign-up and email verification dominate; social sign-in about 45 to 90 s) plus a top-up page if the balance is empty |
| Power step                                   | 5 to 10 s                                | 5 to 10 s                                                                                                                            |
| DorkBot script                               | 40 to 90 s answered, about 15 s skipping | same                                                                                                                                 |
| First real reply                             | 3 to 8 s                                 | 3 to 8 s                                                                                                                             |
| **Total, first screen to first agent reply** | **about 1 to 2 min**                     | **about 4 to 8 min**                                                                                                                 |

Without an existing Claude, ChatGPT or OpenRouter account and without the patience to make a DorkOS account mid-flow, a person today gets stuck on the requirements step or skips into an app where no agent can reply.

### 1.4 Decisions on file that this changes

- `specs/dorkos-account-by-default/01-ideation.md` decision D4: "Credits only as a peer option in the connect step; DorkBot says nothing about accounts; no sign-in step (keeps ADR 260722-111314)." **The 2026-10-07 decision reverses D4.**
- ADR 260722-111314 (onboarding is a scripted DorkBot conversation in a client-side overlay; its beats map to the `ONBOARDING_STEPS` config list; the first message dissolves the overlay into a real session). **The new design changes it, so it needs amending, not just keeping:** the name, personality and discovery beats leave the first run, an account step arrives, and the scripted welcome moves into #team (a durable room log), where a client-written DorkBot line is a new mechanism. What survives is the principle: the welcome is scripted and spends no tokens. One ADR should supersede D4 and amend 260722-111314 together.
- **Config trap:** do not track the new account step by adding a member to `ONBOARDING_STEPS` (`packages/shared/src/config-schema.ts:461`). Widening a list makes older builds throw away the whole config (`apps/server/src/services/core/config/widened-leaves.ts:50-53`). Use a separate scalar field.
- ADR 261001-000811 (credits are a Runs on choice): keep the rule that a session runs on credits only when a person picked them or was told. Pressing "Continue with DorkOS" and adding a card is that pick, for new installs; the landing message says it plainly. Existing installs keep their runtime and payer.

---

## 2. Every place a runtime, model or vendor name (or a non-DorkOS-first choice) appears

About 120 places in the client, plus docs. The full sweep with line numbers is long; these are the groups and the worst offenders. Paths: `L/` = `apps/client/src/layers/`, `S/` = `packages/shared/src/`.

**First, merge the three label tables.** Names come from `L/entities/runtime/config/runtime-descriptors.ts:67-111` (labels, logos, and subtitles like "Anthropic · frontier models in the cloud"), `S/agent-runtime.ts:390-404` (`RUNTIME_DISPLAY_NAMES`, which also builds server copy like "Connect {name}"), and a hard-coded switch in `L/features/chat/lib/stop-copy.ts:107-111`. One table, with a "DorkOS runtime has no visible name" rule, makes most of the list below a one-place change.

| Surface                 | Where                                                                                                                                                                       | Shows today                                                                                                                                                       | Change                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Onboarding requirements | `L/features/onboarding/ui/SystemRequirementsStep.tsx:45, 178, 183, 454-511, 522-548`                                                                                        | "Connect your first runtime", "Looking for Claude Code, Codex, and OpenCode", "Claude Code is connected", a runtime picker                                        | Replace the stage with the account stage (section 3). Runtime setup moves to "Use my own AI sign-in"     |
| Runtime cards           | `L/entities/runtime/ui/RuntimeSetupDialog.tsx:286-382`                                                                                                                      | logos, names, "Setup details", "enable `runtimes.<type>`"                                                                                                         | Only under "Use my own AI sign-in" and Settings                                                          |
| Connect flow            | `L/features/runtime-connect/ui/RuntimeConnectFlow.tsx:67-123`, `login-copy.ts:36-52`, `LoginConnect.tsx`                                                                    | credits lead only when nothing is signed in; "Sign in with Claude", "Anthropic API key", "Sign in with ChatGPT"                                                   | Same, as the secondary path                                                                              |
| Credits card            | `L/widgets/credits-offer/ui/CreditsOfferCard.tsx:114, 236`                                                                                                                  | "One account for Claude Code."                                                                                                                                    | Drop the name                                                                                            |
| OpenCode picker         | `L/features/runtime-connect/ui/OpenCodeProviderPicker.tsx:103-120`                                                                                                          | **"Recommended"** on OpenRouter ("Claude, GPT, Gemini and 300+ more")                                                                                             | DorkOS credits is the recommended card                                                                   |
| Status bar model item   | `L/features/status/model/status-bar-registry.ts:487`                                                                                                                        | always visible: "Opus", "Sonnet", "GPT-5.3 Codex"                                                                                                                 | Hidden by default (section 6)                                                                            |
| Status bar Runs on item | `status-bar-registry.ts:442`, `RuntimeItem.tsx`                                                                                                                             | "Claude Code" with the Anthropic logo before the first message                                                                                                    | Hidden for the DorkOS runtime                                                                            |
| Chat rows and errors    | `BirthCertificate.tsx:43, 67`, `ModelSubstitutedRow.tsx:27`, `AuthErrorActions.tsx`, `ErrorMessageBlock.tsx`, `RuntimeSigninBanner.tsx`                                     | "runs on Claude Code", "DorkOS credits don't cover Opus, so this ran on Sonnet", "Sign in to Claude Code again"                                                   | No names on the DorkOS runtime; tier words ("a faster model") on credits                                 |
| Settings, Runtimes      | `L/features/settings/ui/runtimes/RuntimesTab.tsx:68, 118`, `RuntimeCardHeader.tsx`, `ModelRow.tsx`, `EffortRow.tsx`                                                         | default falls back to `claude-code`; "Runtimes are the AI tools that do the work."                                                                                | Lead with "Your agents run on DorkOS"; runtimes under Advanced                                           |
| Settings, Runs on       | `ClaudeAccountsSection.tsx:393-468`, `CreditsRunsOnSection.tsx:65-132`                                                                                                      | DorkOS credits listed **last** / second, after the person's own sign-in                                                                                           | Credits first                                                                                            |
| Settings, power source  | `PowerSourceSection.tsx:57-90`, `runtime-connect/lib/power-source.ts`                                                                                                       | "On your computer (Ollama)", "Cloud via OpenRouter", "Your own API key"                                                                                           | Add credits and lead with it                                                                             |
| Settings, account       | `L/features/settings/ui/DorkosAccountTab.tsx:37-66`, `UseCreditsFor.tsx`, `CreditsNotices.tsx`                                                                              | "Use one account for Claude Code", one switch per runtime                                                                                                         | Credits-first copy, one switch                                                                           |
| Agent creation and team | `NamingStep.tsx:239`, `RuntimePicker.tsx`, `ArrivalConfirm.tsx:109`, `TeamMemberCard.tsx:24`, `agent-columns.tsx`, `EntryRunWithMenu.tsx`, `NewMenu.tsx`, `RuntimeMark.tsx` | "Runs on Claude Code", runtime logos, "Claude Code · Opus" on team cards                                                                                          | Default to DorkOS; picker under Advanced; team cards show role and responsibilities                      |
| Discovery               | `DiscoveryView.tsx`, `CandidateCard.tsx:18-20`                                                                                                                              | "Claude Code project"                                                                                                                                             | "Project"                                                                                                |
| CLI                     | `packages/cli/src/check-claude.ts:62-65`                                                                                                                                    | "Claude Code CLI not found" with Anthropic links                                                                                                                  | Silent when the default runtime is DorkOS                                                                |
| DorkBot                 | `S/dorkbot-templates.ts:20-43`                                                                                                                                              | retired category line, "development workflow"                                                                                                                     | Rewrite around the business and mini apps                                                                |
| Docs                    | `docs/index.mdx:18, 56`, `getting-started/what-is-dorkos.mdx`, `installation.mdx`, `quickstart.mdx`, `desktop-app.mdx`, `account/index.mdx:14, 29`, `guides/runtimes.mdx`   | "at least one agent signed in; Claude Code is the easiest start", `export ANTHROPIC_API_KEY`, "credits pay for Claude Code"; quickstart never mentions onboarding | Rewrite around the new first run once it ships (the demo-claim gate: do not describe it before it works) |

Six browser specs pin copy on these screens and will fail only in the merge queue if the words change: `apps/e2e/tests/onboarding-power.spec.ts`, `full-power-door.spec.ts`, `chat-mock.spec.ts`, `chat/status-line-fit.spec.ts`, `dashboard-sidebar/sidebar-groups.spec.ts`, `control-center/control-center.spec.ts`.

---

## 3. The new default path: under one minute

The clock runs from the first screen of the app to DorkBot's first line in #team (both in-app). Three screens, one of them in the browser.

### Screen 1: Welcome (in the app, about 3 s)

- The DorkOS mark, "You, Multiplied.", and one line: "Build and run your business with an agent team."
- Primary button: **Continue with DorkOS**. Under it, one small line while paid plans are limited: "Needs a card. US only, 18 or older." (today's rule, `apps/client/src/layers/features/cloud-link/ui/CloudEligibilityNote.tsx:10-17`), so nobody outside it finds out only after a trip to the browser.
- Two quiet links: **Use my own AI sign-in** and **Continue without an account**.
- No scan, no animation hold before the button, no runtime names. The machine scan for existing agents and projects moves to later (section 3, "What moves out").

### Screen 2: Sign in and add a card (the browser, about 20 to 40 s)

Pressing the button opens dorkos.ai in the default browser at the address the contract already returns with the code filled in (`verification_uri_complete`, `packages/cloud-api/src/session.ts:178-182`), so nobody types or copies a code. One page, two parts:

1. **Sign in:** Continue with Google, Apple or GitHub (one click when already signed in to that service; the email is verified by them, so no verification email). Email sign-up stays available but uses a one-time code typed on the same page instead of a link that blocks sign-in.
2. **Add a card:** Stripe's Express Checkout buttons on top (Link, Apple Pay, Google Pay), the card form below. It saves the card for later charges (a SetupIntent, "set up future payments"; [Setup Intents](https://docs.stripe.com/payments/setup-intents), [Express Checkout Element](https://docs.stripe.com/elements/express-checkout-element)). Stripe marks later charges as merchant-initiated, so the person is usually not asked to confirm again, though a bank can still ask.
3. **Money, in plain view:** a monthly spending limit as a visible field the person can change, and auto top-up as an explicit choice (on or off), not something switched on silently. Prices are on the pricing page; link to it.
4. **Done:** "You're in. Go back to DorkOS." The approval completes only once a card is saved.

Because this page runs in the person's real browser (Safari, Chrome), Apple Pay and Google Pay work as they do on any website. The desktop app never has to show a wallet itself, which matters because nothing confirms Apple Pay works inside an Electron window.

**The first charge must be spendable at once.** The public contract has first-purchase holds (`purchased.holds`, `pendingMicro`: credit "paid for that is not spendable yet, because a hold is still in force", `packages/cloud-api/src/billing.ts:190-202`). With no free starter credits, a hold on the first purchase would leave DorkBot unable to reply right after signup. Either the first purchase is spendable immediately, or the app must say how long the wait is. This is a Cloud need (section 8).

### Screen 3: Land in #team (in the app, about 5 s)

- The app has been polling the device code (every 2.5 s today, `use-cloud-link.ts:40`, within the contract's `interval`); it sees the approval, mints the credits token, waits for credits to report ready (`GET /api/cloud/credits`), sets the DorkOS runtime as the default with credits as the payer, and closes onboarding on its own. The person does not click "back".
- It lands on **#team** (the home room), not a DorkBot DM.
- DorkBot's welcome is scripted (no tokens), uses the name from the sign-in, and says three short things: hello; "Your agents run on DorkOS credits. Your usage is in Settings."; and an offer with chips: **"Build me a tracker for my customers"**, **"Make a daily plan board"**, **"Something else"**. Pressing a chip is the first real turn: DorkBot hands the job to its `builder` helper, which builds the mini app with `create_extension` on the DorkOS runtime (runtime report, section 4.2), and the person approves it in Activity (people approve mini apps; agents never approve their own).
- **How the scripted line lives in #team** is new and needs designing: either a real room message posted by the server on DorkBot's behalf (durable, visible on every device) or a client-only card above the room that disappears once answered. Recommended: the server posts it, so the first-run history is real.

### The clock

Same start and end points for old and new: first screen of the app to the first real agent reply.

| Step                                                                | Fast case      | Typical        |
| ------------------------------------------------------------------- | -------------- | -------------- |
| Welcome, read and press                                             | 2 s            | 4 s            |
| Browser opens dorkos.ai                                             | 2 s            | 3 s            |
| Sign in with Google/Apple/GitHub (already signed in there)          | 5 s            | 12 s           |
| Add a card with Link, Apple Pay or Google Pay, set the limit        | 8 s            | 20 s           |
| App notices approval (poll every 2.5 s), mints token, credits ready | 3 s            | 7 s            |
| Land in #team, DorkBot's scripted welcome appears                   | 2 s            | 4 s            |
| Press a chip; first real reply starts streaming                     | 3 s            | 6 s            |
| **Total, first screen to first agent reply**                        | **about 25 s** | **about 56 s** |

Today's comparable number (section 1.3, first screen to first reply, no AI account): about 4 to 8 minutes. Server boot before the first screen (3 to 15 s) is outside both.

Slow cases that break the minute: a person with no wallet and no Link who types a card (add 30 to 60 s), email sign-up (add 20 to 40 s), a corporate browser that blocks the new tab (show the address and a "copy" button as the fallback, as today), and any first-purchase hold.

The mini app itself takes longer than a minute to build. That is fine: the goal is "up and running", meaning signed in, paid for, and talking to an agent that acts. Building the mini app is the first thing they do, not part of setup.

### What moves out of the first run

| Today                               | New home                                                                                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requirements scan and runtime cards | "Use my own AI sign-in" path, and Settings › Advanced                                                                                                            |
| Power step                          | Dropped once the audit trail lands ("trusted by default"); until then, the existing moments rail asks later, the first time an agent wants to do something risky |
| Name and @handle                    | Taken from the sign-in; editable in profile                                                                                                                      |
| Personality, kind of work           | A DorkBot follow-up after the first mini app, or the profile page                                                                                                |
| "Look around this machine"          | A DorkBot offer after the first mini app ("Want me to find projects already on this computer?")                                                                  |
| Tour                                | The "Show me around" chip stays available in #team                                                                                                               |

---

## 4. The skip paths

The account is the default, never a wall. Both escapes sit on Screen 1 and keep working later from Settings.

- **Use my own AI sign-in.** Two kinds of "own": a key or a local model on the DorkOS runtime (it takes an OpenAI or Anthropic key, any OpenAI-compatible server, or Ollama; see the runtime report, section 4.2), or a vendor app (Claude Code, Codex, OpenCode) on the person's own sign-in, through today's requirements and connect screens, reworded (no "first runtime" heading). Runtime names are allowed here, because the person asked for them. If the CLI no longer bundles the vendor binaries (section 7), this path downloads the one the person picks, with progress.
- **Continue without an account.** Lands in #team with no AI connected. DorkBot's scripted welcome says, in one line, that agents need a DorkOS account or the person's own AI to reply, with two buttons. Everything that does not need a model (rooms, installed mini apps, setting up tasks) works. "Free local use with no account" stays true.
- **Outside the paid-plan countries or under 18.** The note under the Screen 1 button says so up front, and "Use my own AI sign-in" is the path for them. **This means the default path is US-only at launch** unless paid plans widen first; for most of a global audience the own-key path is the real first run. That makes the own-key path on the DorkOS runtime part of launch, not a nice-to-have.

---

## 5. Product rules this design keeps

- **Money:** a session runs on credits only when a person picked them (AGENTS.md, seven money paths; ADR 261001-000811). "Continue with DorkOS" plus a saved card is the pick; the first DorkBot line states it.
- **Copy:** never write "no AI subscription needed" (a DorkOS plan is one); never "free" for credits; at most 15 words per block (`pnpm check:copy-length`); no "we".
- **Demo-claim gate:** no docs, site or release-note line describes this flow until it works end to end.
- **Cloud privacy:** the app learns only what the public contract says. Card details never touch the app or this repo.

---

## 6. The status-bar model item: hidden by default, pinnable

- **Today:** the `model` item is always shown (`L/features/status/model/status-bar-registry.ts:487`, `promote: () => true`). It is already pinnable: it is in the session group and in the pin list enum (`S/config-schema.ts:984-1003`, `model` at `:988`), and the `⋯` popover has a pin toggle per row (`SessionPopover.tsx:180-181, 308-323`).
- **Change:** `promote: () => false`, so it appears only when pinned. It then lives in the `⋯` "extra items" popover like the others. Optionally, promote it in one case: when a turn ran on a different model than the agent's setting (a fallback), so the person notices.
- **No config migration.** Pins default to `[]`. Do not seed `pins: ['model']`, and do not add or remove enum members: a new list member makes older builds throw away the whole config (`apps/server/src/services/core/config/widened-leaves.ts:50-53`).
- **The Runs on item** (`status-bar-registry.ts:442`) should also stay hidden for the DorkOS runtime, since there is nothing to choose on a session that already started (runtimes are fixed per session, ADR-0255).
- **Follow-ons:** effort and fast mode live inside the model popover, so with the item hidden they are reached by pinning or from the session panel. Update `status-bar-registry.test.ts:52-53, 279, 290-301`, `promoted-items.test.ts`, the budget comments in `status-budget.ts:77-85`, `apps/e2e/tests/chat/status-line-fit.spec.ts`, and the dev playground's `StatusLineShowcases.tsx`.
- **Settings:** the agent's settings get a "Model" row: "Chosen by DorkOS" by default, with the options shown as plain tiers first (quick, standard, strongest) and the exact model names behind "Show all models".

---

## 7. Install: the part the minute does not cover

The minute starts when the app opens. Install is separate and today it is slow for a reason the new default no longer needs:

- **Make the bundled agent binaries optional.** The npm package and the desktop app ship Claude Code (about 207 MB) and Codex (about 277 MB). With the DorkOS runtime as the default, neither is needed until a person picks "Use my own AI sign-in". Download the chosen one then, with progress. Expected effect: the npm install drops from about 500 MB to tens of MB, and the desktop download shrinks by the same amount.
- **Desktop splash.** Show a window with the DorkOS mark and "Starting…" at once instead of a hidden window for up to 70 s.
- **Fix the curl installer's docs line** ("asks if you'd like to run the setup wizard" is false under a pipe).

---

## 8. What DorkOS Cloud must provide

Described as needs from the app's side, using only the public contract in `packages/cloud-api`. Nothing here comes from the private repo.

1. **Credits for everyone with a card.** Any account with a saved card can mint an inference token, with no plan purchase needed first. The balance contract can already express an allowance on a free account (`GET /v1/balance`, `billing.ts:181-215`); the service decides the rule.
2. **No hold on the first spend.** The first purchase (or the card itself) must be spendable at once, or the first agent turn fails right after signup (section 3).
3. **Sign-in plus card on the approval page.** The device-code approval page signs the person in (Google, Apple, GitHub, or email with a one-time code, no blocking verification email) and saves a card with Stripe (Link, Apple Pay, Google Pay, card form; set up for future payments), with a visible monthly limit and an explicit auto top-up choice. The approval completes only after a card is saved.
4. **The filled-in address.** Return `verification_uri_complete` on every device code (the field already exists, `session.ts:178-182`) so the app can open the page with the code in it.
5. **A "card on file" fact in the contract.** Add a field (for example `paymentMethodOnFile: boolean`) to `GET /v1/entitlements` or `/v1/balance`, so the app can tell "linked but no card" from "ready" and offer the right button. Contract-first: a DOR issue for `packages/cloud-api`, then a CLD issue for the service (the cross-repo rule).
6. **Model tiers in the catalog** (optional for launch). An optional `tier` field on catalog models, so the app can offer quick, standard and strongest without naming vendors (the model shape names none today, `inference.ts:146-154`). Same contract-first route. Until then, `recommendedOn` picks the one default.
7. **Served formats for the DorkOS runtime.** Every token lists the formats the DorkOS runtime will use (`served`, `inference.ts:89-97`).
8. **Fast token minting after approval,** so "credits ready" follows approval within a few seconds.
9. **The vendor terms questions** from the runtime report (Anthropic in writing; an OpenRouter enterprise agreement if any model goes through OpenRouter) answered before launch.

---

## 9. Build list (after the usage hold)

In the order that unblocks the first run soonest. Sizes are rough.

| #   | Work                                                                                                                                                                                                                                                                                                            | Where                                                                       | Size               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------ |
| 1   | ADR: account-first onboarding (supersedes spec D4, amends ADR 260722-111314)                                                                                                                                                                                                                                    | `decisions/`                                                                | small              |
| 2   | Contract: card-on-file field (and later a model tier field); CLD issue for the page and the first-spend hold                                                                                                                                                                                                    | `packages/cloud-api` + CLD                                                  | small              |
| 3   | DorkOS runtime phases 0 to 3, including own-key support                                                                                                                                                                                                                                                         | see the runtime report                                                      | about 5 to 6 weeks |
| 4   | New Screen 1 and the auto-closing link wait; old requirements stage moves under "Use my own AI sign-in"                                                                                                                                                                                                         | `features/onboarding`, `features/cloud-link`                                | medium             |
| 5   | Land in #team; DorkBot welcome script with mini-app chips; a DorkBot skill that teaches when to hand a mini app to the `builder` helper, with the `create_extension` how-to in the builder's prompt, and full-page mini apps (add a `page` template; today's templates have none, `extension-tools.ts:557-580`) | `onboarding-script.ts`, `dorkbot-templates.ts`, `packages/operating-skills` | medium             |
| 6   | One runtime label table; hide names for the DorkOS runtime; credits first in every Runs on list                                                                                                                                                                                                                 | `entities/runtime`, settings sections                                       | medium             |
| 7   | Status-bar model item hidden by default; model row in settings with tiers                                                                                                                                                                                                                                       | `status-bar-registry.ts`, settings                                          | small              |
| 8   | Optional agent binaries; desktop splash                                                                                                                                                                                                                                                                         | `packages/cli`, `apps/desktop`                                              | medium             |
| 9   | Docs and DorkBot copy rewrite, after it works                                                                                                                                                                                                                                                                   | `docs/getting-started/*`, `docs/account`                                    | medium             |
| 10  | Browser specs for the new first run; update the six that pin old copy                                                                                                                                                                                                                                           | `apps/e2e`                                                                  | medium             |

---

## 10. Decisions for Dorian

1. **Where the card is taken.** Recommended: on the same dorkos.ai page as sign-in, before approval completes (one browser visit). The other choice: link first, then open a second "add a card" page from the app. Simpler for Cloud, but it adds a round trip and breaks the minute.
2. **The default path is US-only at launch** while paid plans are US-only and 18 or older. Recommended: accept that, say it under the button, and make "use your own key" on the DorkOS runtime a launch item so everyone else gets a real first run. The other choice: widen paid-plan eligibility before launch (a Cloud and legal question).
3. **Where onboarding lands.** Recommended: #team, with a server-posted DorkBot welcome offering the first mini app. Today it lands in a private DorkBot chat.

---

## Sources

- Repo, at `fdfe99110`: `apps/site/scripts/install.sh`, `packages/cli/src/{cli.ts,check-claude.ts,init-wizard.ts}`, `apps/desktop/src/main/*`, `apps/client/src/AppShell.tsx`, `apps/client/src/layers/features/onboarding/*`, `features/runtime-connect/*`, `features/cloud-link/*`, `widgets/credits-offer/*`, `entities/runtime/*`, `features/status/*`, `features/settings/*`, `packages/shared/src/{agent-runtime.ts,config-schema.ts,dorkbot-templates.ts}`, `apps/server/src/services/mesh/ensure-dorkbot.ts`, `apps/server/src/services/core/cloud/*`, `packages/cloud-api/src/{session.ts,billing.ts,inference.ts,routes.ts}`, `docs/getting-started/*`, `docs/account/index.mdx`, `specs/dorkos-account-by-default/01-ideation.md`, ADR 260722-111314, ADR 261001-000811, ADR 261002-221210.
- Stripe: [Setup Intents](https://docs.stripe.com/payments/setup-intents), [save and reuse cards](https://docs.stripe.com/payments/save-and-reuse-cards-only), [Express Checkout Element](https://docs.stripe.com/elements/express-checkout-element), [Apple Pay](https://docs.stripe.com/apple-pay), [credits-based pricing](https://docs.stripe.com/billing/subscriptions/usage-based/use-cases/credits-based-pricing-model).
- Precedents: Zed, Warp, Kilo Code, Cline and Amp pricing pages, summarised in `research/20261007_dorkos-runtime.md` section 5.5.

## Gaps

- All timings are estimates; measure the new path with a stopwatch on a clean machine once built.
- No public Stripe number for how long Link or wallet checkout takes; the 8 to 20 s range is our estimate.
- Apple Pay inside an Electron window is unconfirmed, which is why the design keeps the card page in the real browser.
