---
slug: invites
id: 260727-161438
created: 2026-07-27
status: specified
---

# Ideation: Invites — a second person on one install

- **Slug:** invites
- **Date:** 2026-07-27
- **Author:** Claude (directed by Dorian)
- **Tracker:** DOR-594 (B1 — invites and multi-user auth on one install)
- **Anchors:** codebase = `7099013d2` (`origin/main` @ `19bd5def2` plus the community-server ideation commit, which was not yet pushed at time of writing).

## 1) Intent

Let a second person sign up on a DorkOS install that already has an owner, land in one specific channel, and post there. Nothing more.

Today that is impossible by construction. `apps/server/src/services/core/auth/index.ts` (`databaseHooks.user.create.before`) throws `FORBIDDEN` / `REGISTRATION_CLOSED` the moment any user row exists, and its own docstring names the fix: _"A future invites spec reopens registration via invitation tokens only."_ This is that spec.

This is Track B of `specs/community-server/` (`260727-155419`) §5, and it is the fast-follow `specs/accounts-and-auth/` §"Implementation Phases" P3 deferred and never wrote. It proves multi-user end to end on rooms that already ship, with zero distributed-systems risk: one install, one SQLite file, no new service, no protocol.

## 2) What this inherits, and does not re-argue

From `specs/community-server/01-ideation.md`, taken as settled:

- **D3 — a member's `naturalKey` is opaque and carries no personal data.** `apps/server/src/services/rooms/author-registry.ts` already keeps `naturalKey` off the wire, deliberately. The second human's key follows the same rule, so the eventual remote member (D3's real subject) is additive rather than a migration.
- **§4's experience contract.** Click Invite, get a link, no form. The invited person sees who invited her and where, before signing up. One screen to join. She lands in the conversation. Refused: email required to preview, "install the app to continue", and screens a joining member has to read that talk about servers.
- **Zero user-facing cryptographic keys**, in every path.
- **D1/D2/D4/D5 are Track A** and do not constrain this work. Nothing here creates a `CommunityAdapter`, touches Postgres, or assumes `apps/community` exists.

From `decisions/0320-optional-local-login-required-on-exposure.md`, taken as settled: local login is optional and off by default, and exposure beyond localhost hard-requires an owner account plus `auth.enabled`. Invites live entirely inside that rule and must not weaken it.

## 3) What reading the code changed

Three things the framing assumed, that the source contradicts. Each is carried into the specification as required work.

**The schema is multi-user-capable; the authorization is not.** Community-server §5 says "the hook, an invite-token table, and a second role are what's missing." Three shipped call sites treat the author kind `'human'` as if it meant "the owner":

- `room-service.ts:762` — `seesEveryRoom()` returns `true` for any `kind: 'human'` author.
- `room-service.ts:776` — `requireOperator()` passes any `kind: 'human'` author.
- `apps/client/src/layers/widgets/room-view/ui/ChannelsPage.tsx:35` and `apps/client/src/layers/entities/room/model/use-mark-room-read.ts:64` — both locate the viewer's membership with `members.find((m) => m.author.kind === 'human')`.

A second human minted as `kind: 'human'` therefore reads every room on the install (including the owner's DMs with agents), rewrites any roster, and shares a read cursor with whoever sorts first. Closing this is the load-bearing part of the work, not a detail.

**The registration rule already exists in two places.** `packages/cli/src/commands/auth-instance.ts` carries a second copy of the hook, with a comment instructing the next person to keep it in lock-step. Adding a third state to a rule that is written twice is how the two drift.

**A notice code is a closed enum, on purpose.** `packages/shared/src/room-schemas.ts` restricts `RoomNoticeCode` to `cascade_stopped | budget_reached` and says a new member-facing event "earns a new code here rather than a free-text convention." "Priya joined" is a new code.

## 4) Open decisions this spec has to resolve

1. Token format, what signs it, lifetime, seats, revocation.
2. What replaces owner-only registration, such that a bare `POST /api/auth/sign-up` from the internet still fails.
3. The name and the exact powers of one role beyond `owner` (community-server open question #5).
4. The `naturalKey` for human #2, and what happens to the `'local'` sentinel.
5. What the preview shows, and what a link leaks.
6. Whether the local server gains Google/GitHub sign-in, or "Continue with your DorkOS account", or neither.
7. How the invited person becomes a `roomMember` and starts receiving the durable stream.
8. What changes for an install that never invites anyone. (Required answer: nothing.)

## 5) Out of scope

- Anything remote: `CommunityAdapter`, Buzz, `apps/community`, Postgres, federation.
- A general permission system. One role, an allow-list, no policy engine.
- Per-member model budgets or per-member filesystem scoping.
- Agents as members of a remote community (community-server open question #4).
- Password reset for a member (the owner's `dorkos auth reset-password` path is unchanged and stays owner-only).

## 6) Related

- `specs/community-server/01-ideation.md` (`260727-155419`) — the five decisions this sits under
- `specs/accounts-and-auth/02-specification.md` (`0268`) — the identity core, and the P3 that deferred this
- `specs/rooms/02-specification.md` (`260726-170533`) — the membership-scoped durable stream an invited person lands on
- ADR-0320 — optional local login, required on exposure
- ADRs `260726-170125` / `260726-170126` / `260726-170127` — the room model, author identity, cascade guard
