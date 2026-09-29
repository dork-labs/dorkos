---
slug: connections-health
title: 'Connections that never leave you stuck'
status: ideation
created: 2026-09-28
builds-on: [specs/connections-one-list, specs/connection-app-details]
---

# Connections that never leave you stuck — design decisions

The one-list redesign made Connections simple to look at. This round makes it simple to **live with**: when something goes wrong, the person sees one honest line and one button, or nothing at all, because DorkOS fixed it itself.

## 1. What we found (2026-09-28)

A person tried to disconnect Gmail. Their DorkOS account link had ended the night before, so the panel said "Disconnecting didn't finish" and offered "Try disconnecting again", which could never work; Remove and Sign in again were both blocked. Their Gmail sign-in was, in fact, still live at the service. An audit of every state and journey (`connections-audit.md` beside this file) found the same shape across Connections:

- **Nothing decides "can agents use this now, and if not, what's the one fix".** About fifteen predicates, server and client, each rebuild it from raw fields. Three deciding facts aren't in the owner's view at all: whether the way to the app is healthy, whether the way can run actions, and whether the sign-in is still valid (it is only written when a sign-in completes). So the most common failures show as green rows.
- **Dead ends.** Rows that can never be removed; a retry that can never succeed; a rejected access sync that stays rejected; "Sign in again" that pauses the account and never unpauses on failure.
- **Agents are told to guess.** They must invent action names to request access, then are refused by exact-string match right after the person allowed it; a granted but unusable account silently disappears; refusals carry jargon and no next step; destructive actions are approved from a card that shows only ids.
- **Levels are snapshots.** "Read" quietly becomes "custom" whenever the service adds or reclassifies an action.
- **Plain words break down** in failure states: "instance", "authority", "managed", raw enum values and ids.

## 2. Principles (the bar every item is judged against)

1. **Your choice is final the moment you make it.** Disconnect and Remove always succeed locally, at once. Anything still owed at the service is DorkOS's job, done in the background and retried; the person sees it only if they can do something DorkOS can't (e.g. "remove DorkOS's access in your Google account", with the link).
2. **One truth.** The server computes one `ConnectionReadiness` for every account: a state, the one fix, who can make it (the person, or DorkOS on its own), when DorkOS will try again, and the words for the owner and for the agent. Every surface renders it; none re-derives it.
3. **Exactly one fix per problem.** One line, one button. No problem without a way out; no button that can't work.
4. **Green means usable.** A row is only shown as ready when agents can actually use it now.
5. **Agents never guess.** They ask by level ("read Gmail"), learn why an account is unavailable, and get a refusal that says what the person must do.
6. **A level is a promise.** "Read" means "everything this app lets agents read", now and as the app changes (never more than the level's class).
7. **Plain words, from one place.** One copy table on the server; no internal nouns reach a person.
8. **For developers:** one readiness function with a state table and tests; no state built by hand in fixtures that production can't reach.

## 3. The plan (MoSCoW)

**Must**

- **H1 One truth** — `ConnectionReadiness` in shared schemas; derived once on the server (way health, can-run-actions, sign-in status, lifecycle, sync); on the summary, the agent's `unavailable[]`, refusals and the chat card; the client renders it and stops deriving. Green means usable.
- **H2 Fresh facts** — keep sign-in and way status current: a periodic account reconcile per way, an auth error during an action marks the sign-in expired, provider status refreshed at boot and on failure with an automatic re-check.
- **H3 No dead ends** — Disconnect/Remove are always local and final (cleanup owed moves to a background job; if it can't run, the panel says what the person can do at the service and offers Remove); a rejected access sync is re-staged or re-scoped per agent instead of failing the connection; "Sign in again" never leaves an account paused; needs-review can be confirmed without an edit and names the true cause; relinking the same account keeps grants where the service allows (the hosted half is tracked privately); an account gone at the service ends cleanly (DOR-2474).
- **H4 Requests tell the truth** — agents request by level; "not granted" checks by class, not exact names; every request status carries a note; one answer model (the chat card is used on the page too); dedupe ignores the reason and a per-agent rate limit (DOR-2497); tool timeouts fit the hold.
- **H5 Destructive approval shows what it does** — app, account, action and a readable summary of the arguments.
- **H6 Plain words** — one server copy table; remove internal nouns, raw enums, ids and JSON from every surface; fix false billing/custody lines, the key hint and the key toasts.

**Should**

- **H7 A level is a promise** — levels stored as intent; new or reclassified actions of the same class join automatically; never widens past the class; ADR.
- **H8 Events and chat apps** — one chat per subscription, visible failures, removable rows, a proper route gate; an in-app switch for chat apps instead of an environment variable.
- **H9 Docs match the product** — rewrite stale/false pages; extend the vocabulary gate to `docs/`.
- **H10 Per-chat app switch** (DOR-2448) — turn an app on or off for one chat.
- **H11 Test hygiene** — DOR-2472, DOR-2478.

**Could (later)**: Allow once (DOR-2437), one-tap from Telegram/Slack (DOR-2449), login-off wide writes (DOR-2440). DOR-2438 (per-app level wording) is superseded by Look/Change and H7.

**Hosted side (tracked privately)**: a revoke must end its apps' sign-ins at the service (urgent); a same-person relink keeps connections; the hosted classifier matches this one.

## 4. Order

Wave 1 (parallel): H1 + H2 (coordinated: H2 writes the facts, H1 reads them), H5, H8, H9.
Wave 2: H3, then H4 (both build on H1).
Wave 3: H6, H7, H10, H11.
Each item: its own worktree, a separate adversarial review against `REVIEW.md`, merged before the next item that depends on it.
