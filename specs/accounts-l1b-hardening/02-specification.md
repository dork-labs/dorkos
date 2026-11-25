---
slug: accounts-l1b-hardening
number: 261119-021000
created: 2026-11-19
status: draft
parent: everything-is-a-space
---

# M4: L1b hardening and the rest of the accounts work

**Status:** Draft. Planning only; no code lands from this document.
**Author:** Claude, for Dorian Collier
**Date:** 2026-11-19 (state checked against `origin/main` on 2026-11-18)
**Milestone:** M4 "L1b hardening and the rest of launch", due **January 29, 2027**, in the Linear project "Your DorkOS account, devices and private space (Feb launch)"
**Parent spec:** [`everything-is-a-space`](../everything-is-a-space/02-specification.md) (cited as "the parent"; read its step table first). Its ideation: [`01-ideation.md`](../everything-is-a-space/01-ideation.md).
**Decisions it carries out:** ADR `261015-042933` (the design) and ADR `261015-125850` (this computer and other devices). Plan: [`plans/2026-10-accounts-and-devices.md`](../../plans/2026-10-accounts-and-devices.md).

> **Changed 2026-11-24 by ADR `261124-150515` (sequence, not dates).** The dates, the launch and the "before launch / after launch" split in this document are retired, milestone due dates included. What it decided to build, and the order where one step needs another, stand. The live order is `meta/ROADMAP.md`.
> For B9's outbox, and anything else that must survive a restart, see ADR `261124-150517` (follow-up work saved with the turn, recovery with caps).

## Overview

The parent spec lists every launch step. Most of chats A and B, plus the F steps, have merged. This spec covers what is left for the last milestone: eleven steps, in build order. It does not restate the parent's design. It says, per step, what exists today, what is still missing, and when the step is done.

Two things are new since the parent:

- **Security's standing Must (October 20)** for anything a phone reaches: HTTPS or a passkey for every phone session; trust follows identity, never the network; the remembered-network binding must never become the auth.
- **Design ownership.** The Designer owns the UI for "Your devices" (`design-devices.md`), export (`design-export.md`) and the inbox (`design-inbox.md`), and writes the copy for the credits states and for cross-space search. None of those design notes exists yet. A step with a Designer part does not start its UI before the note lands.

Sizes follow `contributing/prioritization.md`: 1 under an hour, 2 half a day, 3 a day, 5 a few days, 8 about a week.

## Goals

- Finish the launch steps the parent lists and has not built: A10, A11, B9, B10, C10, C11, C12 and D (parent, "The step list").
- Close two small follow-ups: DOR-2995 and DOR-2977.
- Run L1b as the parent defines it (parent, "Launch gate"): the security review, the timed runs, and the docs and canon moves for what passed.

## Non-goals

- Everything in the parent's "Non-goals (before launch)" list still holds.
- Everything in ADR `261015-125850`'s "Neutral" list stays after launch (DOR-2971): automatic routing, a cross-origin handoff, Touch ID and Windows Hello step-up, Wi-Fi on Windows, "Continue with DorkOS" at the Mac. Passkeys at the Mac are on that list too; open question 1 asks whether Security's Must pulls part of it in.
- No change to the relay protocol beyond what B9 adds.
- No public claim for anything here until it ships and passes (`meta/ROADMAP.md` demo-claim gate).

## Build order at a glance

| #   | Step     | Ticket   | Size | Depends on                                  | Designer    |
| --- | -------- | -------- | ---- | ------------------------------------------- | ----------- |
| 1   | C11      | DOR-2960 | 5    | A4 (merged); Cloud contract                 | copy review |
| 2   | D        | DOR-2970 | 8    | C11, B3; Security threat model first        | owns UI     |
| 3   | A10      | DOR-2942 | 3    | A8; Cloud credit states; A11 for one part   | owns copy   |
| 4   | A11      | DOR-2943 | 8    | A8                                          | owns UI     |
| 5   | C10      | DOR-2959 | 3    | C5; Cloud seat billing                      | copy review |
| 6   | B9       | DOR-2952 | 8    | B2, B6; Cloud wake for a note               | owns UI     |
| 7   | B10      | DOR-2953 | 5    | B7                                          | owns copy   |
| 8   | C12      | DOR-2961 | 3    | B2                                          | none        |
| 9   | nickname | DOR-2995 | 2    | DOR-3065, C5                                | none        |
| 10  | banner   | DOR-2977 | 1    | none                                        | copy review |
| 11  | L1b      | DOR-2963 | 8    | every step above, in slices from December 1 | none        |

_Retired 2026-11-24 (ADR 261124-150515): kept as a record of the old plan. The order of the steps stands; the dates do not._

Total: 54 points. It fits before January 29 alongside M3 only with 2–3 app lanes from late November and the cut list ready to use (see "Cut list").

## The steps

### 1. C11: Signing in anywhere (DOR-2960)

**Goal.** Every sign-in to your account is visible and can be ended from one place. You hear about each new one. From another person's DorkOS you can add your home and pair, with a warning.

**What exists.**

- This computer's signed-in devices and "Sign out everywhere else": `apps/server/src/routes/devices.ts` (`GET /api/devices/sessions`, `DELETE /api/devices/sessions/:id`, `POST /api/devices/sign-out-all`), `services/core/auth/sessions/signed-in-devices.ts`, `apps/client/src/layers/features/auth/ui/SignedInDevicesSection.tsx`, `features/auth/model/use-signed-in-devices.ts`, shapes in `packages/shared/src/signed-in-devices.ts`. Merged in #3051 and #3089.
- Signing out closes live streams through the session-delete hook (`services/core/auth/sessions/live-connections.ts`).
- Sign-out of other devices needs a person at this computer and a front-door step-up (`runFrontDoorWrite`).
- On a hub, "Continue with DorkOS" sign-in and public-computer mode: `services/core/hub/hub-sign-in.ts`, `public-computer.ts` (#2991, #2993, #3003).

**What is missing.**

- A notice for each new sign-in.
- Account-wide sign-out: ending every session the account issuer holds, which signs you out of your hub and every DorkOS where you used "Continue with DorkOS". `packages/cloud-api/src/session.ts` has `GET /v1/session` only; there is no list or revoke route.
- "From another DorkOS: add the home address, sign in and pair", with "Only connect your own computers. Elsewhere, use a browser."

**What to build.**

- **Contract first, agreed with Cloud** (`packages/cloud-api/src/session.ts`, `routes.ts`): an account sign-in list (opaque id, device name, where, first and last used, whether it is the caller's); revoke one; revoke all but the caller's; and a "new sign-in" event on the existing command stream. Tests in `packages/cloud-api`. Never an email or an IP address in a list row.
- **Server.** On a hub: a route group `/api/account/sign-ins` that proxies the three calls for the signed-in owner only, with a fresh sign-in (as A2's setup routes). On every computer: a new sign-in to this computer (any route but `local`) writes an audit row and raises one notification through the existing notifications service.
- **Client.** On a hub, the account page gains "Signed in to your account" with Sign out on each and "Sign out everywhere". On a Mac, the existing section stays; the notice reuses the inbox bell.
- **Pairing from another DorkOS.** A "Add your home" flow in Settings: type the hub address, sign in in a popup, pair. It reuses the hub link code (`services/core/hub-relay/link-codes.ts`). The warning line is shown before the address field.
- No config change.

**Security notes.** Revoke-all must not depend on the hub being awake: Cloud revokes at the issuer, and the hub re-checks its session against the issuer on its next request. The notice must name the device and route, never a token. Pairing from someone else's DorkOS hands that owner your pairing grant; the warning is mandatory and tested.

**User-facing parts.** Designer reviews copy. App copy follows `writing-app-copy`.

**Tests (failing first).** cloud-api shape tests; a hub route refuses an agent, an API key, the relay and a stale sign-in; a new sign-in by Wi-Fi, tunnel and managed raises exactly one notice; a revoke-all from Cloud makes the hub's next request a 401; the pairing flow shows the warning before any input.

**Size.** 5.
**Depends on.** A4 (merged). Cloud: the sign-in list, revoke and the new-sign-in event.
**Done when.** You can see and end every sign-in to your account from your hub. A new sign-in anywhere raises one notice. Pairing from another DorkOS works and warns first.

### 2. D: "Your devices" replaces Remote access (DOR-2970)

**Goal.** One screen lists every device that can reach this computer and every way in, each with its own off switch. It replaces Settings > Remote access (parent step D; ADR `261015-125850` rule 12).

**What exists.**

- The signed-in devices list (step 1 above).
- Route binding (#3004) and the Wi-Fi level (#3061): `services/core/auth/sessions/wifi-level.ts`, `wifi-raise-guard.ts`, `wifi-turn-ceiling.ts`.
- The Remote Access master switch (DOR-3650, #3680 and #3734): `middleware/remote-access-switch.ts`, `features/settings/ui/remote-access/RemoteAccessSwitch.tsx`, config `remoteAccess.enabled` in `packages/shared/src/config-sections.ts`. It ships on and closes every way in when off.
- Wi-Fi access: `services/core/lan-access/lan-access.ts`, `routes/lan-access.ts`, `features/settings/ui/lan-access/LanAccessSection.tsx`.
- **Gap against the ADR:** the Wi-Fi listener binds every interface (`ALL_INTERFACES = ['::', '0.0.0.0']` in `lan-access.ts`). There is no remembered network (no gateway MAC, no "paused" state). ADR rule 7 and the plan's "Remembered network" rule are not built. Wi-Fi is plain http until DOR-3173 (`lan-trust.ts`).

**What to build.**

- **Threat model first, by Security,** before any code. It is Security's and stays private; the public threat-model doc changes only for residuals Security clears for publishing.
- **Remembered network.** `services/core/lan-access/remembered-network.ts`: read the gateway MAC and subnet; store them; recheck on every network change; "paused" when they differ. The listener binds only the remembered interface and subnet. The binding narrows who can connect; it never admits anyone. Every Wi-Fi request still needs a person session (rule 3). A test pins that a matching network with no session is a 401.
- **Config.** `lanAccess.rememberedNetwork` (gateway MAC hash, subnet, label), following `adding-config-fields`: Zod field, default absent, a semver-keyed conf migration, docs, test. Store a hash of the MAC, never the raw value.
- **Transport rule (Security, 2026-11-19).** The rule is on the transport, not the device type. At launch no phone session runs over plain http; phones join over an https route (own tunnel with a reserved domain, managed remote, a hub). On an unencrypted Wi-Fi route, sign-in uses a one-time device code minted at the Mac instead of the password, and an owner-level session is issued there only after a per-device opt-in made at the Mac, with a plain warning (DOR-4744, Wi-Fi sign-in hardening; lands before Dec 8 in M2, so D builds on it). Off by default, Sign out per device and the listener bound to the remembered interface (never `ALL_INTERFACES`) still ship in D. Phone-versus-laptop detection is UX only and never counts as a control. DOR-3173 (an encrypted listener) brings phones back after launch.
- **Client.** `features/settings/ui/YourDevicesTab.tsx` replaces `RemoteAccessTab.tsx`. Rows: this computer; each person session (name, last active, how it last connected) with Sign out; Add a device; the Wi-Fi line ("On for Home network. Off elsewhere."); the master switch at the top; your own tunnel under Advanced. Hub sessions link to the account page (step 1). Relay pins stay under the chat app connection. `RemoteAccessTab.tsx`, `RemoteAccessModeChoice.tsx` and their showcases are removed, not left beside it. The Control Center row (`widgets/control-center/ui/RemoteAccessRow.tsx`) points to the new tab.
- **Mac-only controls.** Add a device, sign-out-all and the away switch need a person session on this computer (rule 8). Already true for sign-out-all; add tests for the other two.

**Security notes.** Trust follows identity: no request is let in for being on the remembered network. Name the evil-twin residual in the docs (plan, "Builder notes"). Wi-Fi pages say there are no notifications on Wi-Fi and no installable app.

**User-facing parts.** Designer owns the UI in `design-devices.md`. No build before it lands.

**Tests (failing first).** Listener binds only the remembered interface; a network change pauses it; a paused listener refuses; a matching network without a session gets 401; a phone session on plain http is refused; Security's required tests from the private threat model; each row's Sign out works; the master switch still closes every way in; the old tab's tests move, not vanish.

**Size.** 8.
**Depends on.** DOR-4744 (M2). C11, B3 (part merged: #2994, #2997, #3010). Security's threat model. Designer's note.
**Done when.** Settings shows "Your devices" and no Remote access tab. Wi-Fi binds only the remembered network and pauses visibly when it changes. Security signs off the threat model and the matrix passes.

### 3. A10: When credits run out (DOR-2942)

**Goal.** The app side of Cloud's defaults: a warning before credits run out, a stopped computer shown read-only with its data kept, an offer to export, and a notice before deletion. Mac agents and spaces keep working (parent A10).

**What exists.**

- `apps/client/src/layers/features/cloud-plan/ui/CreditsNotices.tsx`: the `filled`, `offer` and `signed-in` notices only.
- `CreditsGauge.tsx`, `ExportAccountData.tsx` (whole-account export), `DeleteAccount.tsx`.
- In the contract: `packages/cloud-api/src/hubs.ts` `CloudComputerStopReasonSchema` already has `out_of_credits`, with the service's own words; `billing.ts` has the balance and an `exhausted` status.

**What is missing.** The low-balance notice, the read-only stopped computer, the export offer and the deletion notice.

**What to build.**

- **Contract first, agreed with Cloud** (`billing.ts`, `hubs.ts`): a low-balance flag Cloud decides (the app never computes a threshold); for a stopped computer, when its data will be deleted, if a date is set; nothing about prices.
- **Shared.** Extend `CloudCreditsNotice` in `@dorkos/shared/cloud-schemas` with `low-balance`, `computer-stopped` and `deletion-scheduled`.
- **Server.** `services/core/cloud/credits-availability.ts` maps the contract to those notices.
- **Client.** New rows in `CreditsNotices.tsx`. A cloud agent on a computer stopped for credits opens read-only: history readable, composer replaced by one line and a Top up button. The export offer links to A11's one-agent export, or to `ExportAccountData` until A11 lands.
- No config change.

**Security notes.** The read-only state is enforced on the hub (sends to a stopped computer are refused), not only hidden in the UI.

**User-facing parts.** Copy only from the Designer. Nothing is written before it arrives.

**Tests (failing first).** Each notice renders from a fixture; a send to a stopped-for-credits computer is refused with a clear error; Mac agents and space rooms still send; the deletion notice shows the date Cloud gave.

**Size.** 3.
**Depends on.** A8. Cloud: the credit states and the deletion date. A11 for the one-agent export link (see "Contradictions").
**Done when.** All four states show with the Designer's copy. A stopped cloud agent is readable and cannot be sent to. Mac agents and spaces keep working.

### 4. A11: Export and import one agent with its transcripts (DOR-2943)

**Goal.** Take one agent, with its chats, out of any DorkOS and into another. A cloud export imports into a local DorkOS on day one (parent A11).

**What exists.**

- Space export: `apps/server/src/services/spaces/exports/*`, `routes/community/exports.ts`, `packages/shared/src/community-export-archive.ts`, client `apps/client/src/space/exports.ts`.
- Room export: `services/rooms/room-export.ts`, `packages/shared/src/room-export-schemas.ts`.
- Whole-account data export from Cloud: `ExportAccountData.tsx`, `cloud-api` `AccountExportRequestSchema`.
- No export of one agent, and no import of anything agent-shaped.

**What to build.**

- **Archive format** in `packages/shared/src/agent-export-archive.ts`: a versioned zip with a manifest; `.dork/agent.json`; the agent's instructions, memory and skills; its schedules; its transcripts per runtime (Claude Code JSONL, Codex threads, OpenCode store) as each runtime stores them; a hash per file. Never credentials, API keys or connection tokens; the manifest lists what was left out.
- **Server.** `services/mesh/agent-export/` builds and reads the archive. Each runtime adds an export and import pair behind the `AgentRuntime` interface, so the SDK stays inside its adapter dir. Routes: `POST /api/agents/:id/export` (person only), `POST /api/agents/import` (person only, Owner-level). Import makes a new agent id, never overwrites, and shows what it will add before it writes.
- **Cut-list fallback:** "everything" export (every agent at once) is a loop over this. It is the first thing dropped.
- No config change.

**Security notes.** An imported archive is untrusted input: size caps, path checks on every entry, no symlinks, hooks and plugins inside it need a yes (the AGENTS.md rule for code from strangers). An agent cannot export another agent or a person's chats (`audit-trail` §3.4).

**User-facing parts.** Designer owns the UI in `design-export.md`.

**Tests (failing first).** Round trip per runtime; a cloud-agent export imports on a Mac; a zip with `../` paths, a symlink or an oversize entry is refused; no secret appears in an archive (scan test); an agent caller is refused.

**Size.** 8 (5 if "everything" is cut, which it already is in this plan).
**Depends on.** A8.
**Done when.** One agent with its chats exports from a cloud computer and imports into a local DorkOS, for each runtime. Nothing secret is in the archive.

### 5. C10: Seats at invite (DOR-2959)

**Goal.** When you invite someone to a team space, you see the seat count and who pays before you send (parent C10).

**What exists.**

- `apps/client/src/layers/features/cloud-plan/ui/SeatManagement.tsx` (seat list, assign, release; shows Cloud's refusal words as given).
- `packages/cloud-api/src/seats.ts` (orgs, members, invitations, seats).
- Invites: `apps/server/src/services/spaces/invites.ts`, `features/community-hosting/ui/StartCommunityDialog.tsx`, `HostedCommunitiesDialog.tsx`.
- The teammate card limit per space (#3040).

**What to build.**

- **Contract first, agreed with Cloud** if needed: a seat preview for an invite (seats used, seats included, whether this invite adds a seat, who pays). Prices are never in the contract; Cloud's words are shown as given, as `SeatManagement.tsx` already does.
- **Client.** The invite form shows one line above Send. If the invite needs a seat change, it shows Cloud's refusal and a link to the account page.
- Fix the stale comment in `SeatManagement.tsx` `memberLabel`: `MemberSchema` now carries `displayName`; use it.

**Security notes.** None beyond showing only the caller's own org.

**User-facing parts.** Designer reviews copy.

**Tests (failing first).** The line renders from a fixture; a refusal shows Cloud's words; a member with a display name is labelled by it.

**Size.** 3.
**Depends on.** C5. Cloud: seat billing and the preview.
**Done when.** The invite form shows seats and who pays before Send, in Cloud's words.

### 6. B9: One inbox (DOR-2952)

**Goal.** Notes from your Mac (an agent finished, an approval waits) reach your hub even when no viewer is open. The hub shows one inbox for every computer and space (parent B9).

**What exists.**

- The local inbox: `features/inbox/*`, `widgets/inbox-bell/*`, `entities/notifications/*`.
- The relay: the Mac dials its pinned hub only when Cloud says a viewer is open (`services/core/session-relay/relay-dialer.ts`, `services/core/hub-relay/*`).
- No outbound note channel.

**What to build.**

- **Protocol** in `packages/shared` (the relay protocol, not `cloud-api`): a `note` operation, signed by the Mac's relay credential, carrying kind, agent, a short line and a link. No transcript content.
- **Mac.** `services/core/session-relay/relay-notes.ts`: a durable outbox; it dials the hub to deliver, then hangs up. Retry with backoff. Off when Remote Access is off or the relay is off.
- **Hub.** A note endpoint beside `relay-endpoint.ts`; notes land in the hub's inbox store; one inbox lists them with space and local items, grouped by computer.
- **Cloud.** The hub may be asleep. Waking it for an authenticated note dial needs Cloud's front door (contract first, agreed with Cloud). The rule "an unauthenticated request never wakes a hub" stands.

**Security notes.** A note is display-only. Opening one goes through the relay as today; nothing in a note is executed or trusted as an approval. Rate-limit per computer.

**User-facing parts.** Designer owns the UI in `design-inbox.md`.

**Tests (failing first).** Protocol conformance on both sides; a note from an unpinned key is refused; the outbox survives a restart; an asleep hub is woken by a signed dial and not by an unsigned one; a note carries no transcript text.

**Size.** 8.
**Depends on.** B2, B6. Cloud: waking a hub for a signed note dial.
**Done when.** A Mac agent finishing while no viewer is open shows up in the hub's inbox within a minute of the hub waking. The inbox lists every computer and space.

### 7. B10: Search across spaces and your agents (DOR-2953)

**Goal.** From your hub, search your rooms, the spaces it mirrors and your reachable computers. The app states the two limits (parent B10).

**What exists.** `apps/server/src/services/search/*` indexes this computer only (rooms and Claude Code, Codex and OpenCode transcripts). Remote rooms the app mirrors: `services/communities/remote/mirror-store/`.

**What to build.**

- **Rooms first (the cut-list floor).** Index mirrored space rooms in the same FTS5 index, tagged by space.
- **Reach into computers.** A `search` relay operation: the hub fans the query out to computers that are connected now, merges results, and marks each with its computer. Results from a computer are snippets and links only; opening one goes through the relay.
- **Client.** `MessageSearchDialog.tsx` gains a source filter and the two limit lines.

**Security notes.** A relayed search runs at the Chat level and never returns tool output (the existing index rule). Agents keep a person's own chats from agents that identify themselves (`audit-trail` §3.4); the relayed query carries the caller kind.

**User-facing parts.** Copy only from the Designer, including the two limit lines.

**Tests (failing first).** A mirrored room is found; an off Mac is listed as not searched; an agent caller does not see a person's chats over the relay; no tool output in results.

**Size.** 5 (3 for rooms-only).
**Depends on.** B7.
**Done when.** One search from the hub returns rooms, mirrored spaces and connected computers, and says what it could not reach.

### 8. C12: The self-hosted hub's wake channel (DOR-2961)

**Goal.** A self-hosted hub wakes a member's Mac for the relay without Cloud (parent C12; ADR `261015-042933` rule 8).

**What exists.** The wake seam: `services/core/hub-relay/computer-waker.ts` takes an injected wake through `setHubRelayWaker`; only Cloud's wake is wired.

**What to build.** A waker for self-hosted hubs over the operator's own channel: the Mac keeps one outbound long-poll to its pinned hub while the relay is on, and the hub answers it to wake. Nothing talks to Cloud unless "Continue with DorkOS" is on. Where members' DorkOS lives on the operator's server, the app shows the disclosure that the operator controls those members' agents and connections. Config: none new if the long-poll rides the existing relay pin; otherwise a field via `adding-config-fields`.

**Security notes.** The long-poll is to the pinned address and key only. A wake carries no address.

**User-facing parts.** None beyond the disclosure line (copy review).

**Tests (failing first).** A self-hosted hub wakes a Mac with no Cloud configured; no request goes to Cloud (network spy); the disclosure shows on an operator-hosted hub.

**Size.** 3.
**Depends on.** B2.
**Done when.** A self-hosted hub opens a member's Mac chat with no Cloud in the path.

### 9. Agent copy keeps its nickname (DOR-2995)

**Goal.** When an agent is copied out of the private space ("Start a team space from this", C5), the copy keeps its nickname.

**What exists.** Nothing for the copy path on `origin/main`; it waits on DOR-3065.

**What to build.** Carry the stored `nickname` through the copy unchanged (generate and store it on the source first if it has none). A clash with an agent already in the target space gets " II", " III" (Block Buddies spec §17, agreed with the Designer). Never copy the source's ULID.

**Security notes.** The copy never carries the private agent's id across the wall.
**User-facing parts.** None new.
**Tests (failing first).** A copied agent keeps its nickname; a copy of a copy keeps it too; a clash gets " II"; the new agent's id differs from the source's.
**Size.** 2.
**Depends on.** DOR-3065, C5.
**Done when.** A copied agent shows the same nickname in the team space.

### 10. Foreign-origin one-time suggestion (DOR-2977)

**Goal.** ADR `261015-125850` rule 1 asks for a one-time banner suggesting "Ask for a password on this computer too" when a local request names a foreign page.

**What exists.** `noteForeignOrigin` in `apps/server/src/lib/request-classifier.ts`, called from `http/api-chain.ts`, logs one warning per process. No banner.

**What to build.** Record the first occurrence (page origin only, never the full address) in a small server state; expose it on the existing server-info route; the client shows one dismissible notice that links to the setting. Dismissal is stored, so it shows once.

**Security notes.** Never store or show a path or query (the existing `pageOrigin` rule).
**User-facing parts.** Copy review.
**Tests (failing first).** The notice shows after one foreign-origin request, once; dismissal sticks; no path or query is stored.
**Size.** 1.
**Depends on.** none.
**Done when.** The banner appears once and links to the setting.

### 11. L1b: Hardening (DOR-2963)

**Goal.** As the parent defines it: the security review and its fixes, the timed "under a minute" runs, and the docs and canon moves for whatever passed.

_Retired 2026-11-24 (ADR 261124-150515): kept as a record of the old plan. The order of the steps stands; the dates do not._

**What changes from the parent.** The review starts **December 1, in slices, in merge order**, instead of one block in January. Each slice is reviewed against its merged PRs. Fixes are their own PRs, each citing the slice.

**Review slices.**

| Slice | Step                 | Ticket    | Merged PRs                                                          |
| ----- | -------------------- | --------- | ------------------------------------------------------------------- |
| 1     | F0 classifier        | DOR-2965  | #2908, #2911, #2923                                                 |
| 2     | A2 hub mode          | DOR-2934  | #2959, #2965, #2980, #2989, #2996, #3007, #3014                     |
| 3     | A3 hub image         | DOR-2935  | #2971, #2973                                                        |
| 4     | A5 address hardening | DOR-2937  | #2968, #2975, #3006                                                 |
| 5     | F3 desktop sign-in   | DOR-2966  | #2977                                                               |
| 6     | A4 sign-in on a hub  | DOR-2936  | #2991, #2993, #3003                                                 |
| 7     | F1 gate sweep        | DOR-2967  | #2962, #2967                                                        |
| 8     | F5 server safety     | DOR-2968  | #2970, #2972, #2974                                                 |
| 9     | B1 relay, hub side   | DOR-2944  | #2949, #2978, #2984, #2985, #2995                                   |
| 10    | B2 relay, Mac side   | DOR-2945  | #2979, #2981, #2983, #2987                                          |
| 11    | B3 consent and pins  | DOR-2946  | #2994, #2997, #3010 (parts 1 to 4 not found by search; confirm)     |
| 12    | F4 route binding     | DOR-2969  | #3004, #3051, #3061, #3105                                          |
| 13    | B4 passkey approvals | DOR-2947  | #3106, #3109, #3115, #3118 (titled B4a to B4c; no DOR id in titles) |
| 14    | B5 full control      | DOR-2948  | none found by search                                                |
| 15    | C7 teammate tier     | DOR-2956  | #3005, #3040                                                        |
| 16    | New steps            | this spec | C11, D, A10, A11, B9, B10, C12 as each merges                       |

The parent's order (A2 to A5, then B1 to B5, then C7) is kept. F0 goes first because A2 builds on it; F3 and F1, F5, F4 sit beside the steps that touch the same auth code.

**Also in L1b.**

- **Timed runs.** The "under a minute" run for both cold starts (web-only sign-up to first cloud turn; Mac install to first turn), three runs each, on a clean `DORK_HOME` under `/Volumes/ext-ssd-1/dork-os/test-homes/`. Results kept under `evidence/`.
- **Docs and canon.** A "Where my data is" row (today the phrase is not in `docs/` or `meta/`; it lands as a new section in `docs/concepts/architecture.mdx`), and the line that chats with your Mac's agents from the web pass through your own DorkOS in the cloud. The ~15 docs files that say "Require login" and the extension API's `requireLogin` advice (plan, "Owed").
- **ROADMAP.** `meta/ROADMAP.md` moves only for what passed its slice and its tests. Anything else stays "coming".

**Size.** 8 (review only; fixes are sized as they are found).
**Depends on.** Every step above, slice by slice.
**Done when.** Every slice has a signed review with its fixes merged. Both timed runs are under a minute. Docs and ROADMAP move only for what passed.

## Cut list

_Retired 2026-11-24 (ADR 261124-150515): kept as a record of the old plan. The order of the steps stands; the dates do not._

In this order; Dorian decides each cut.

1. **C12**, the self-hosted wake channel. Self-hosters reach the Mac by page move.
2. **B10's reach into computers.** Ship rooms-only search (3 points).
3. **A11's "everything" export.** One agent only. This plan already assumes this cut.

## Plan if Cloud slips

| Cloud piece                  | Step | Fallback                                                                                                                                   |
| ---------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Account sign-in list, revoke | C11  | Ship the per-computer notice and pairing; hubs show "Manage sign-ins on dorkos.ai" with a link. Account-wide sign-out waits.               |
| Credit states, deletion date | A10  | Show the stop reason the contract already has (`out_of_credits`) and the read-only state; hold low-balance and deletion notices.           |
| Seat preview                 | C10  | Show `SeatManagement` beside the invite form, and Cloud's refusal words on Send.                                                           |
| Waking a hub for a note dial | B9   | Notes deliver when the hub is next awake (the outbox holds them). The inbox says "Updates from your Mac arrive when you open DorkOS here." |

No step here is blocked on Cloud for its local half. Each contract change is its own PR in `packages/cloud-api`, agreed with Cloud before any code uses it.

## Open questions

1. **Does plain-http Wi-Fi meet Security's Must?** **Decided (Security, 2026-11-19):** no phone sessions over plain http at launch; on unencrypted Wi-Fi, sign-in and owner-level sessions follow DOR-4744 (step 2's "Transport rule"). The threat model is Security's and stays private.
2. **A10 before A11?** The parent says A10 depends on A11 (the export offer). **Recommended:** keep the build order; A10's export offer links to the whole-account export until A11 lands, then switches.
3. **Account-wide sign-out: does it include sessions at each Mac?** **Recommended:** no. It ends issuer sessions and hub sessions. A Mac's own sessions are the Mac's (ADR 0319 keeps the identities apart). The Mac still shows the notice.
4. **Where does the new-sign-in notice go on a hub?** **Recommended:** the hub's inbox, plus an email from Cloud. Cloud owns the email.
5. **Is B9 one inbox or two?** **Recommended:** one list, grouped by computer and space, built on the existing inbox, not a new surface.
6. **Does the self-hosted waker (C12) need a new config field?** **Recommended:** no. Ride the existing relay pin.
7. **Who signs off each L1b slice?** **Recommended:** Security, with the step's builder fixing. A slice with no reviewer by December 8 goes to Dorian.

## Contradictions found

- **Remembered network.** The plan and ADR rule 7 put the remembered network and the narrowed bind in F4 (DOR-2969). F4's PRs merged, but the listener still binds every interface and there is no remembered network. This spec moves the work into D.
- **A10 depends on A11** in the parent, but the milestone order puts A10 first. See open question 2.
- **Wi-Fi sessions.** Security's rule for Wi-Fi sessions is newer than the plan; see open question 1. The plan also lists passkeys as after launch (DOR-2971).
- **Stale comment.** `SeatManagement.tsx` says `MemberSchema` has no display name; it now has `displayName`. Fixed in C10.
- **D and the master switch.** The parent's D list omits the Remote Access master switch (DOR-3650), which landed after it. D keeps it at the top.
- **Dates.** The parent puts L1b in January 6 to 24; this milestone runs to January 29, and the review starts December 1.

## Related ADRs

`261015-042933`, `261015-125850` (amends `0320`), `0319`, `261018-124422`, `261006-225605`.
