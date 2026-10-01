---
status: ideation
created: 2026-09-30
design-session: .dork/visual-companion/57890-1790807399
research: research/20260930_account-billing-profile-ia-patterns.md
linear: DOR-2626
---

# DorkOS account by default: discovery, usage and management

## Problem

The DorkOS account (the optional hosted, paid layer) is hard to find, hard to use and easy to misunderstand.

- It lives only under Settings › Access, beside the local password gate. It is absent from onboarding, runtime
  connect, both account menus and the top bar.
- "Account" means four things: the header menu's "Account" opens your profile; the phone and footer "Account"
  means the local identity; Settings › Access › "DorkOS account" is the cloud link; Runtimes › "Billing account"
  is a Claude config directory.
- Credits (DOR-2623) are switched on only by `DORKOS_CLOUD_CREDITS=1`, reach only Claude Code, and when on they
  beat the person's own Claude sign-in for every agent (a silent double-billing risk). The token lives only in
  memory, so a restart quietly drops credits; an expired token quietly falls back to another sign-in.
- "Workspace settings" opens global Settings; there is no workspace object. `/workspaces` means git worktrees.
- Spaces (called "communities" in code) use "host / hosted / hosting" throughout their copy, and the add-a-space
  menu has seven entries.
- Settings has 15 tabs; several are power-user configuration.

## Goals

1. **Discovery.** Anyone can find the account in one move, and meets an offer only at the moment they need it.
2. **Usage.** Every service fits one model; once someone has an account, DorkOS is the default wherever nothing
   else is set up. Overriding a default is an advanced move, one step away.
3. **Management.** Account details in the app; money changed on the web, one click away.

Non-goals: a billing "Team" object before seats need one; any offer for a service the server does not report as
wired (demo-claim gate); prices or plan names in this repo.

## The story

**You** (profile) → your **team** (the header name "Dorian's team" + the `/team` roster; this is what "workspace"
means, and the word stays out of UI copy) → optionally a **DorkOS account** attached to it (plan, credits, seats).
**This computer** is where it all runs.

## Decisions (operator, 2026-09-30)

| #   | Decision                            | Chosen                                                                                                                            |
| --- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Where the account lives in Settings | One "DorkOS account" tab, fixed directly after Profile in the You group                                                           |
| D2  | Credits model                       | "Fill the gaps": a runtime with no working sign-in runs on credits; one with its own sign-in keeps it, with a one-tap switch      |
| D3  | Right after sign-up                 | Fill the gaps automatically, one notice listing each switched runtime with Change and Undo all                                    |
| D4  | Onboarding                          | Credits only as a peer option in the connect step; DorkBot says nothing about accounts; no sign-in step (keeps ADR 260722-111314) |
| D5  | Space sign-in                       | The DorkOS account signs you into spaces that run on DorkOS (contract + control-plane work)                                       |
| D6  | Naming                              | User-facing "Community/Communities" → "Space/Spaces" now; code, routes, CLI, config, DB and contract later                        |
| D7  | Runtimes                            | Design assumes every runtime (Claude Code, Codex, OpenCode) can run on credits                                                    |

Copy rules: never "no AI subscription needed" (a DorkOS plan is one) — say "One account for <wired runtimes>";
never "host / hosted / hosting" for spaces; never "provider" in user copy (vocab gate).

## Design

### 1. Credits, done safely (money path first)

- Credits are **one more entry in each runtime's "Runs on" list** — the runtime's own sign-ins plus one shared
  "DorkOS credits" entry. No new per-runtime field. Claude Code's existing order (agent → project rule → machine
  default), the status-bar chip and "Continue on another account" inherit it.
- One section contract generalises `ClaudeAccountsSection` and `PowerSourceSection`, and declares each runtime's
  scope (`session` or `runtime`); agent and project rows appear only where supported. Code check: Codex builds a
  per-turn client with per-turn env (`codex-runtime.ts` `clientForTurn`), OpenCode sends `{providerID, modelID}`
  per prompt, so all three can be session-scoped, with credits registered as their own provider entry — never
  overwriting the person's `OPENAI_BASE_URL` or `config.toml`.
- **Resolved per session at launch, fail closed.** A session set to credits with no live token refuses the turn:
  "Couldn't reach DorkOS credits · Retry · Use <runtime> sign-in". The token refreshes before `expiresAt` and
  re-mints at startup.
- **Who chose it.** Each credits choice records `default` or `user`. A real sign-in appearing under a `default`
  choice is re-offered once. A sign-in that expires or runs out never auto-switches to credits: out of usage leads
  with "Keep going on DorkOS credits"; an expired sign-in leads with signing in again. Auto-continue never moves
  onto credits unless credits are on for that runtime.
- **Existing links are never armed by migration**; they get one dismissible offer.
- `DORKOS_CLOUD_CREDITS` becomes a **force-off kill switch** only.
- Credits become an `AgentRuntime` capability; the wired set derives from declarations; `runtimeConformance`
  covers the negatives (no token to non-declarers; fail closed; own sign-in gets no credits env). Per-protocol
  token endpoints are a contract-first change in `packages/cloud-api`.
- One ADR replaces the money-path rule; the AGENTS.md money-path table is updated; an invariant test proves no
  turn env carries `ANTHROPIC_AUTH_TOKEN` without a real link credential.
- Model picker, once `inference/models` is wired: filter credit-served models by the runtime's protocol.

### 2. Where the account lives

**Header menu** (owns identity per BC-43; trigger reads "Dorian's team"):

1. You (face, name) → View profile
2. DorkOS account · "Not signed in" / "Signed in · <label from the service>" (figure only when low) → account tab
3. Settings (was "Workspace settings")
4. Space rows
5. — version line

The duplicate "Account" row is deleted. The phone "You" tab shows the same two rows at the top.

**Settings › DorkOS account** (after Profile, never moves):

- Signed out: a calm explainer listing only benefits the server reports as wired/entitled (else one plain line), one
  button; link, eligibility and error states render inline. No badge, no dot.
- Signed in, one tab with sections: Plan · Credits (two numbers from the service: included this month / added) ·
  "Use credits for" (one switch per wired runtime — a view onto each runtime's machine default, no state of its
  own; off restores and names the previous sign-in) · What's on your account (runtimes on credits, connections,
  spaces) · Seats (only when they exist) · Manage on the web ↗ (change plan, add credits, invoices, export/delete)
  · Unlink this computer.

### 3. The default-first pattern (every surface)

One default card plus visible "Other ways" rows. First-time surfaces show the other ways as short visible rows
(Priya, Lil); repeat surfaces may collapse them. A privacy line where a default is offered: "Prefer to keep
everything on this computer? Use your own sign-in, or Ollama."

- A working local setup wins: "You're ready", no card.
- DorkOS leads only where nothing works yet, even signed out; choosing it starts the **one reusable link flow**
  in place (exported from `features/cloud-link`, injected at widget/app-shell level; one shared pending device
  code; the launching surface resumes its own context afterwards).
- The "One account for …" line names only runtimes the server reports as wired (today: Claude Code).
- Existing ngrok and Composio users are never moved onto a DorkOS default.

| Surface                                                              | Default                                                                    | Other ways                                  |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------- |
| Runtime connect, onboarding connect step, sign-in banner, auth error | "Use DorkOS credits" (label from entitlements: "Try…" / "Buy…")            | Sign in with Claude / ChatGPT · Paste a key |
| OpenCode model source                                                | DorkOS credits (once wired)                                                | OpenRouter · Ollama (private) · Own key     |
| Spaces                                                               | Start a space (runs on DorkOS) · Join a space                              | Advanced: run it on your own server         |
| Connections                                                          | DorkOS account, already chosen automatically once DOR-1798 switches it on  | Composio · Nango                            |
| Phone access                                                         | unchanged until the hosted remote-access service is wired; then one switch | Own ngrok token                             |

### 4. Spaces

- Menu: **Start a space** · **Join a space** (one flow: an address → connect; an invitation → the space's site,
  then back into Connect with the address filled — never a member whose computer isn't connected) · **Your
  spaces** (includes "Move one here") · **Advanced**: create on your own server, run your own.
- All user-facing "host" wording removed; `Hosted communities` → "Your spaces".
- User-facing "Community" → "Space" everywhere (copy, docs, messages), with a vocab-gate wave. Code identifiers
  are renamed later in their own issue.
- Sign in with your DorkOS account for spaces that run on DorkOS (D5).

### 5. Settings: 15 tabs → 11 visible + Advanced

- **You**: Profile · DorkOS account · Appearance · Preferences · Notifications
- **Agents**: Runtimes (leads with Runs on) · Permissions · Connections (key fields move to Advanced after DOR-1798)
- **This computer**: Login & security (the local half of today's Access tab) · Remote access · Privacy
- **Advanced** (folded): Server · Tools · Room limits (global defaults only; each room keeps its own) · Experiments · Danger zone

Existing `?settings=` deep links and the legacy map keep landing correctly; search reaches Advanced tabs.

### 6. Vocabulary

- **Profile** — who you are. **DorkOS account** — the hosted account. **Runs on** — which sign-in or credits pay
  for an agent ("Main (Claude sign-in)", "DorkOS credits"); "Billing account" goes away. **Login & security** —
  the local password gate. **Team** — the roster. **Space** — what code calls a community.
- Consider renaming the `/workspaces` page to "Worktrees" to avoid a Spaces/Workspaces clash.

### 7. Docs

Move account docs out of `docs/self-hosting/`; rename that section "Advanced: running DorkOS yourself"; one page
for running your own space server; add "Space" to the glossary.

## Delivery order

1. Credits done safely (rewrites DOR-2623) + ADR.
2. Honest wired-set copy (+ `CreditsSource.tsx` raw-id bug).
3. Account home: header menu, DorkOS account tab, Access dissolved, vocabulary.
4. Settings regroup.
5. Reusable link flow + default-first pattern.
6. Spaces: user-facing rename, "host" sweep, menu, Join flow.
7. Manage-on-the-web handoffs (server routes for portal/checkout/top-up).
8. Codex and OpenCode on credits (contract-first; DOR + CLD).
9. Sign into spaces with the DorkOS account (contract-first; DOR + CLD).
10. Docs moves.
    Later: model picker credit awareness; phone access on DorkOS; connections onto the shared contract routes; the
    code-level Spaces rename.
