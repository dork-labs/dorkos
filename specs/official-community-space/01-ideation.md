---
slug: official-community-space
number: 261007-001135
created: 2026-10-07
status: ideation
---

# The DorkOS Community Space

**Slug:** official-community-space
**Author:** Claude (IDEATE for Dorian Collier)
**Date:** 2026-10-07
**Linear:** DOR-2764 (parent DOR-2735)

## 1) Intent & Assumptions

- **Task brief:** one official DorkOS space where everyone using DorkOS chats, shares tips and learns. Every new DorkOS account (people only) joins it. It stays reachable when the spaces experiment (DOR-2740) is off. Our own agents host it. Moderation works from day one. A stranger's message never gives anyone's agents power, and tests prove it. It survives a Show HN spike, has monitoring, and soft-launches with current users for about two weeks. It is the launch centerpiece and gates the launch date.
- **Assumptions:**
  - "A DorkOS account" is the DorkOS Cloud account (sign-up on the Cloud control plane). The app's local login account is a different thing and is not in scope.
  - The space runs on the existing shared Community host. Its operation (machines, database, DNS, deploys) lives in the private Cloud repo; this spec covers only the public server, the app and the docs.
  - Every moderation feature lands in the public Community server for every community, not as an official-only special case.
- **Out of scope:** an agent moderator (a follow-up once reports exist), running several server copies at once (the server is vertical-only; see the spec's scale target), message editing, content filters, and opening any other space while the experiment is off.

## 2) Pre-reading Log

- The 2026-10 vision brief and launch checklist (Dorian's working notes, not in the repo): the space is the centerpiece; everything else about spaces stays behind the switch; no community place, status page or code of conduct exists today.
- `apps/community/src/schema.ts`: `admissionPolicy` is `invite_only | closed` only; members are people only; agents belong to one member.
- `apps/community/src/routes/community/invites.ts:404-570`: the only way in is an invite (max 100 seats, 30 days). Redeem reactivates a removed member, so there is no ban.
- `apps/community/src/routes/community/events.ts:231-520`: one live stream per channel, each polling the database about 8 times a second. The pool is `10 + 2 × export concurrency` connections (`main.ts:46-49`), 12 by default. This is the main obstacle to thousands of people.
- `apps/community/src/app.ts:144`: `/health` answers `ok` without touching the database. No metrics.
- `apps/server/src/services/communities/remote/remote-room-subscription-bridge.ts`: a space message reaches a local agent only on a fresh human @mention, and the turn is marked `externalAuthor`, and a NEW session is seeded `'none'` (`turn-origin.ts:215`); an existing session keeps its level. No test covers the whole chain from a space message to that seed. Space rooms get no "people outside this computer post here" framing (`services/rooms/service/room-core.ts:216-219`).
- DOR-2740 worktree (`dor-2740-spaces-experimental`, session 6baaf5dc): `spaces.enabled` (default off), `requireSpacesEnabled` on `/api/communities`, `/api/community-connections` and `/api/cloud/communities`, and a `dispatchEnabled` gate on the bridge. All whole-feature, no per-space exception yet.
- Cloud side (read for planning only; nothing from it is recorded here beyond what the public app already shows): Sign in with DorkOS exists for the shared host, so a DorkOS account can sign in to a space without a separate password.

## 3) Codebase Map

- **Community server:** `apps/community/src/` (admission, members, channels, entries, events, host limits, browser UI under `browser/`).
- **Wire contract:** `packages/shared/src/community-wire.ts`, `packages/shared/src/community-adapter.ts`, conformance in `packages/test-utils/src/community-conformance.ts`.
- **App server:** `apps/server/src/services/communities/remote/*` (pairing, connection store, adapter, subscription bridge), routes `community-connections.ts`, `remote-communities.ts`, `cloud-communities.ts`.
- **App client:** `entities/community`, `features/dashboard-sidebar/ui/context/*`, `widgets/room-view/ui/RemoteCommunity*`, `features/onboarding`.
- **Blast radius:** every community (moderation and admission are general), the DOR-2740 gate, onboarding, docs.

## 5) Research

- **Auto-join, option 1: Cloud creates the membership at sign-up.** Silent, but the host would need Cloud's user ids and a host route that writes membership, which breaks the rule that the host's operator keys never reach space content. Rejected.
- **Auto-join, option 2: an open space.** A new admission policy, `open`, lets in anyone who signs in through the host's single sign-on service, with no invite (never a password sign-up, so the host does not become open account creation). With Sign in with DorkOS, a new DorkOS account is a member the first time it shows up. The app lists the official space from day one and offers to connect it at onboarding. **Recommended.** Honest limit: the person still clicks once, on the space's own page (age check and sign-in consent). Nothing can be silent.
- **Scale, option 1: more pool connections.** Cheap, but polling grows with every open stream. Rejected.
- **Scale, option 2: Postgres `LISTEN/NOTIFY` with in-process fan-out.** One listening connection, streams wake on a notice and read once. Access checks cached and dropped on membership changes. **Recommended.**

## 6) Decisions

No questions for Dorian were needed to start: the brief fixes the outcome, and every choice above is reversible in code. The decisions are recorded in `02-specification.md`.
