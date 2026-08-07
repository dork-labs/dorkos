---
status: current
type: audit
created: 2026-08-06
---

<!-- Discovery audit for specs/identity-consistency/ (subagent report, extracted verbatim).
     Topic: How DorkOS models the human user today, community/member schema state, and the alignment path for a directory-listable user entity -->

# DorkOS Human User Identity — Research Report

## (a) What prior research prescribes

**`research/20260724_multi-user-communities.md`** (the foundational doc; superseded in places by the review exchange and ADRs below — treat as historical unless corroborated):

- Recommends **Approach B**: portable identity + authoritative-per-community server (the Buzz model), not federation, not server-issued-accounts-only.
- **Decision 5: "Email-first identity, keypair invisible underneath."** Passkeys are keypairs; nobody calls Touch ID web3 — DorkOS should do the same trick.
- **A4 (highest-value line per the review exchange): key the roster row on an opaque, stable identity string from day one** — never an email, never a community-local integer — so promoting to portable identity later is a data migration, not a rewrite.
- States plainly: _"What's genuinely missing: a **community** entity, a **member roster keyed on a portable identity**, a **channel** entity with membership, and **agent identity distinct from its owner's credentials**."_
- Frames the "weak reading" of multi-community membership (client holds N connections) as ~95% of the felt value at ~5% of the complexity — this is what shipped.

**`research/20260727_agent-identity-in-communities.md`**: Buzz gives every agent its own keypair + owner attestation (NIP-OA/NIP-AA), but the human never manages keys — the app generates and custodies them. The recommendation for DorkOS: **refuse the signature mechanism, keep the motivation** — an agent should be its own author, never rendered/attributed as its owner, admission should be _derived_ from the owner and re-evaluated per connection (never copied into a row requiring cleanup), and a credential that authenticates _as_ the human is compromise-equivalent to the human. This became `agentIdentityTokens` + D8's owner-vouched agent admission, not a keypair.

**`research/20260727_multi-user-review-exchange.md`** (the load-bearing document — an adversarial two-agent review that produced the actual ADRs): Settled that a **room is a membership-scoped durable stream, not a session**; that **an author is a member of a room**; that the read cursor scopes to `(member, room)`; and — critically for this task — found that **"the agent half of A4 is effectively done" was false at review time**: `resolve-message-author.ts` keyed authorship on the unstable `ctx.agent.id` (a ULID reconciler could rebuild), not the stable `agentPath`. This became ADR `260726-170126` (author identity keyed on the agents directory) for agents. **The human side was flagged as a bare placeholder constant, `HUMAN_AUTHOR_ID = 'human'`**, with no fix proposed in this exchange — that gap is what `specs/invites/` later closed (see §c/§d).

**`research/20260729_buzz-presence-signals.md`** and **`research/20260729_platform-presence-patterns.md`**: Document typing/presence/reaction/read-cursor mechanics (Buzz, Slack, Discord, Matrix, Telegram, iMessage). Load-bearing for _room conduct_, not directly for user identity — but establish that avatars in these systems are consistently emoji/color/photo render caches, never the identity key, and that presence is keyed on the connected principal, never inferred from a display name.

**`research/20260329_claude_code_agent_identity_model.md`**: Establishes Claude Code's own two-level agent identity (session UUID vs. ephemeral subagent `agent_id`, stable only by `agent_type` name) — informs DorkOS's own agent identity design (which independently converged on keying by directory/`agentPath`, not by ephemeral runtime id) but says nothing about human identity.

**Net prescription across all six:** key everything on an **opaque, stable, locally-minted id**; never key on email or a filesystem path; treat email/credential as separate from identity; agents get owner-derived, re-evaluated (never copied) admission; humans should not be forced into key management. None of the six research docs specifically discusses profile _images_ or a people+agents _directory_ — that requirement is not addressed anywhere in prior research and would need net-new design.

---

## (b) Current user model reality

**There is exactly one "person" concept today, and it is barely a record.**

1. **`packages/shared/src/config-schema.ts` `UserProfileSchema`** (lines 186–210): `roles`, `tools`, `displayName` (nullable, "what the user likes to be called"), `rolePromptDismissedAt`. **No email, no avatar/image field.** Explicitly documented as **local-only by tested invariant** — telemetry allowlists never carry it — and used in exactly two places: an agent-context `<user_profile>` block, and connector-recommendation matching (`specs/user-profile-onboarding/01-ideation.md`, status `implemented`). This is _not_ an identity record; it's free-form self-description for agent context, with no uniqueness, no key, and no relationship to auth.

2. **The local "DorkOS account"** — Better Auth (ADR `0311`), optional and off by default (ADR `0320`). `packages/db/src/schema/auth.ts` defines the standard Better Auth `user` table with `id`, `name`, `email`, `emailVerified`, **`image`** (present, standard Better Auth column), `role`. `apps/site/src/db/auth-schema.ts` (cloud) has the identical shape. **The `image` column exists in both schemas today and is read nowhere in the app** (`grep` for `.image` on any user/account/owner record returns nothing; `gravatar` appears nowhere in the entire repo). `findOwnerAccount()` (`apps/server/src/services/core/auth/accounts.ts`) deliberately narrows the local account to `{id, name}` only — email isn't even selected there.

3. **Where the UI surfaces it — genuinely buried, confirming the premise:**
   - `apps/client/src/layers/features/auth/ui/SecurityPanel.tsx` — Settings → Security tab → a "Require login" toggle; only when on, one row: `"Signed in" / currentUser?.email ?? 'Owner account'` + a Sign out button. No name, no avatar, nowhere else in the UI.
   - `apps/client/src/layers/features/settings/ui/CloudAccountTab.tsx` → `CloudLinkPanel` — Settings → "DorkOS account" tab — a device-link flow (RFC 8628-style, `apps/site/src/lib/auth.ts`) to link the install to a **separate, optional cloud identity** used only for analytics linking and update notifications. This is a different Better Auth instance (`apps/site`, Postgres) from the local one (`apps/server`, SQLite) — two independent accounts systems, not one.
   - `apps/site/src/layers/features/account/ui/AccountProfile.tsx` (`AccountUser` interface: `name`, `email`, `emailVerified`) — the actual dorkos.ai account page. Also no avatar field.

4. **Where the human's display name actually flows into the product, and why it's currently "You":** `apps/server/src/services/rooms/author-registry.ts` mints a single human author per install at `naturalKey: 'local'`, `displayName: 'You'` — hardcoded, permanently, regardless of any account. `apps/server/src/index.ts` (`resolveOperatorDisplayName`) notes explicitly: _`config.profile.displayName` is the only place a real human name is stored on this machine — NOT `roomAuthors`' own `displayName` for this same person, which `bindOwner` fixes at `'You'` forever on purpose._ The real name only ever reaches the wire when bridging into an external chat platform (Telegram etc.), never inside DorkOS's own rooms.

5. **The one bright spot: `bindOwner`.** The moment a local Better Auth owner account is created, `author-registry.ts` **rebinds the existing `'local'` author's `naturalKey` to `user:<betterAuthUserId>` in place**, keeping the same opaque author `id` and never moving history. This is exactly the "opaque stable id" pattern A4 asked for — but it only fires for the _owner_, keys on Better Auth's `id`, and still displays `'You'` inside DorkOS's own UI (not the account's real name), because that constant is deliberately never updated.

**Conclusion for (b): the human has no photo, no email surfaced in-product, and — inside rooms/cockpit — no real name.** The `image` field exists in both Better Auth schemas but is completely unused. Avatars everywhere in the cockpit (`apps/client/src/layers/entities/room/ui/MemberList.tsx`) are emoji + color + initials — the exact same render-cache shape used for agents — never a photo URL.

---

## (c) Community/member schema state

**`packages/shared/src/community-adapter.ts`** (spec `community-adapter`, status `specified`) is the real answer to "is there a member/person schema to align with" — **yes, and it is the most mature identity-shaped schema in the repo.**

- **`CommunityRef`** — opaque, locally-minted ULID per configured community connection (`LOCAL_COMMUNITY = 'local'` is the reserved ref for this machine's own rooms).
- **`CommunityMemberRef`** — `{community, memberId}`, opaque member id **as that community minted it**. Explicitly: _"nothing here is derived from a pubkey, an email or a filesystem path."_
- **`CommunityMemberSchema`** — `community`, `memberId`, `kind` (`human | agent | system`, reused `AuthorKindSchema`), `displayName` (render cache), `emoji`/`color` (render cache, no image URL), `role` (nullable, backend-declared vocabulary), `responseMode` (optional), **`ownerMemberId`** (nullable — set only for an agent admitted `owner-vouched`), `joinedAt`.
- This is deliberately a **capability-gated, multi-backend port**: three backends already exist in code — `apps/server/src/services/communities/local/` (SQLite rooms), `apps/server/src/services/communities/buzz/` (a real Buzz relay adapter, further along than the research docs' "throwaway spike" framing suggests — full protocol/socket/history/identity/projection modules with tests and even a live-relay integration test), and `apps/community` (Postgres, not yet built — `specs/community-server/` is still `ideation`).
- `packages/db/src/schema/rooms.ts` **`authors`** table is the underlying local storage: `id` (ULID, wire-facing), `kind`, `naturalKey` (server-side only, never on the wire — `agentPath` for an agent, `'local'` or `'user:<id>'` for a human, `'system'`), `displayName`, `emoji`, `color`, `mintedForManifestId`, `retiredAt`. Mint-on-first-use, resolved by `apps/server/src/services/rooms/author-registry.ts`.
- **`specs/invites/02-specification.md`** (status `specified`) is the concrete design for a _second_ local human and is the closest thing to a finished "person" schema in the repo:
  - §4.1: a second human's `naturalKey` is **`user:<betterAuthUserId>`** — same scheme `bindOwner` already uses for the owner. `AuthorRegistry` gains `human(userId, displayName)`.
  - §4.4–4.5: replaces `kind === 'human'` role/ownership checks with an injected `isOwnerAuthor(authorId)` predicate, and adds **`RoomWithRoster.viewerAuthorId`** so the client knows unambiguously which roster row is "me" (fixing a real bug: `members.find(m => m.author.kind === 'human')` breaks the instant a second human exists).
  - §6.3: the join screen collects **`name`** and **`email`** (as `username`, unverified) and a password. No avatar field anywhere in the invite/registration flow.
  - §3: roles are just `owner` / `member`, default-deny allow-list, no permissions table, no per-room roles — explicitly scoped down ("no admin console... not building").

**What this schema does NOT have:** an avatar/photo image field anywhere on `CommunityMember`, `AuthorRecord`, or the invite join screen — only `emoji`/`color` render caches shared with agents. There is also no cross-room, cross-community, install-wide "list every person and agent I know" query today; `listMembers` is scoped to one room in one community.

---

## (d) Recommended alignment path for a directory-listable user entity

**There is an identity-key scheme to align with, and it should not be reinvented.** The repo has now converged (research → review exchange → ADRs → shipped `specs/invites`) on one repeated pattern:

> **Identity key = opaque, locally-minted id.** Natural key = `user:<betterAuthUserId>` for a human tied to a local account, `agentPath` for an agent, `'local'` for the not-yet-owned single-user default. Never key on email or filesystem path. Render cache = `displayName` + `emoji`/`color`. Membership/room-scoped state lives on a separate `(member, room)` row, never on the identity row itself.\*\*

Concretely, to make the logged-in user a real "person" entity a directory could list without hardcoding:

1. **Stop hardcoding `'You'`.** `author-registry.ts`'s `LOCAL_HUMAN_DISPLAY_NAME = 'You'` is intentionally frozen forever, even after `bindOwner` — that decision needs revisiting for a directory use case specifically (a directory has no "you" framing; it needs the real name). The `authors` table already carries the real, current display name after `bindOwner` fires (`SET display_name = '<owner account name>'`) — a directory reading `authors` directly (rather than through room-scoped UI that special-cases the viewer as "You") would already see it correctly. This argues for **building the directory off `AuthorRegistry`/`authors`, not inventing a second table.**

2. **The account image field already exists and is unused — surface it.** Both Better Auth `user` tables (local `packages/db/src/schema/auth.ts`, cloud `apps/site/src/db/auth-schema.ts`) have `image: text('image')`, standard Better Auth shape, ready to hold a URL. Nothing populates or reads it yet. This is the natural seam for "profile image like Slack/Discord": Better Auth's own client already supports `updateUser({ image })`, and Better Auth ecosystem conventions (Gravatar fallback, initials fallback) are a known, off-the-shelf pattern — **but this repo has zero prior art for it**, so it's genuinely new work, not a wire-up.

3. **`CommunityMemberSchema`/`AuthorRecord`'s `emoji`/`color`/`displayName` render-cache triplet is the identity-rendering vocabulary the whole cockpit already speaks** (rooms, agents, MemberList avatars). A photo-avatar capability should be **added as a fourth optional render-cache field** (e.g., `imageUrl`) alongside emoji/color rather than replacing them — every existing avatar renderer (`Avatar` component consuming `color`+`emoji`+initials fallback) would need one more optional prop, which is a small, additive change consistent with how `responseMode` was added to `CommunityMemberSchema` as an orthogonal optional field.

4. **A directory is a new read surface, not a new identity model.** The data to list "every person and agent I know" already exists in fragments: `authors` (this install's local roster across all rooms), `agents` (the mesh-sconed agent registry), and — once `apps/community`/Buzz backends are live — `CommunityAdapter.listMembers()` per room per community. **No existing query aggregates "all people + all agents across all rooms/communities into one list."** That's the actual gap: not identity modeling, but a cross-room/cross-community projection query plus a UI widget (`AgentHub`, ADR `0254`, is the nearest existing precedent for "one sole surface listing every agent" and is the shape a people+agents directory should probably extend or sit beside, rather than something under Settings).

5. **The owner-vouched agent-admission shape (D8, `agentAdmission: 'owner-vouched'`, `ownerMemberId`) is already exactly what "OTHER people and their agents appear in the app" (Buzz-like) needs.** A remote member's agents show up in `listMembers()` with `ownerMemberId` set to that member — the schema already expresses "this agent belongs to that person," which is the load-bearing relationship a Buzz-like directory needs to group agents under their owner. This groundwork is **already laid**; what's missing is only the concrete `apps/community` backend (`specs/community-server/` is still `ideation`) and a UI that reads it.

**In short: don't define a new person/member schema.** Align the "prominent profile" work with the account layer (Better Auth `user`, surface `name`/`email`/`image`), align the "directory entry" work with `AuthorRegistry`/`authors` + `CommunityAdapter.listMembers()` (the schema exists, the aggregation query and UI don't), and extend the existing emoji/color render-cache convention with an optional image field rather than forking a new avatar system.

---

## (e) Open questions

1. **Should `AuthorRegistry`'s `'You'` literal change for the owner once a directory needs their real name?** Room UI relies on `'You'` never changing (ADR reasoning: "the right word from the operator's own cockpit seat"); a directory needs the opposite. These may need to diverge — render `'You'` in room contexts (comparing against `viewerAuthorId`) but the real name in a directory context — rather than changing the stored value.
2. **Does `image` get populated locally (file upload / OS avatar) or only via the future cloud-linked account?** The local Better Auth instance runs fully offline; an avatar concept needs to decide whether it's local-file-based, Gravatar-by-email, or deferred entirely to the optional cloud link (`CloudLinkPanel`) — which not every install will have.
3. **Two separate Better Auth instances (local `apps/server` vs. cloud `apps/site`) currently hold two independent identity records for the same person.** A "prominent account menu" needs to decide which one it's showing, or reconcile them — this dual-identity seam isn't resolved anywhere in current specs/ADRs.
4. **Cross-community, cross-room directory aggregation has no existing service.** `CommunityRegistry` (per ADR-0310-style degradation) aggregates _rooms_; nothing aggregates _members_ across communities into a single "everyone I know" list yet — this would be new server-side work, not present in `specs/community-adapter/`'s scope (explicitly listed as "out" — UI is out of scope there).
5. **`specs/community-server/01-ideation.md` is still status `ideation`**, and is the actual gate on "other people's agents showing up" (Buzz-like, requirement (c) in the prompt) — the `CommunityAdapter` port and Buzz backend are ready, but there's no committed `apps/community` deployable yet to have real remote members to list.
6. **Whether avatar/profile-image work should route through `specs/user-profile-onboarding` (already `implemented`, currently local-only, no email/avatar) or through `specs/accounts-and-auth`/`specs/invites`'s account layer** — these are two different owning specs today and a "prominent profile" feature sits at their intersection.
