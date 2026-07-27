---
slug: invites
id: 260727-161438
created: 2026-07-27
status: specified
---

# Specification: Invites — a second person on one install

- **Slug:** invites
- **Id:** 260727-161438
- **Date:** 2026-07-27
- **Status:** specified
- **Tracker:** DOR-594 (B1)
- **Anchors:** codebase = `7099013d2` (`origin/main` @ `19bd5def2`, plus the unpushed community-server ideation commit)

Read [`01-ideation.md`](01-ideation.md) first for what is inherited from `specs/community-server/` and must not be re-argued.

---

## Overview

One person already owns a DorkOS install. This spec lets that person hand a link to a second person, who opens it, sees who invited her and to which channel, fills one form, and lands in that conversation able to post. She gets a new role, `member`, which grants exactly that and nothing else.

Four things have to be built and one thing has to be fixed:

**Built.** A signed invite link. A registration rule that admits a holder of a valid invite and nobody else. A second role. A preview page and a join screen that render before any session exists.

**Fixed.** Three shipped call sites read the author kind `'human'` as if it meant "the owner of this machine". Until they mean "the owner", any second human is silently a full operator of the whole install. That is the load-bearing work here.

## Background / Problem Statement

`apps/server/src/services/core/auth/index.ts` closes registration once any user row exists:

```ts
const existing = db.select({ id: user.id }).from(user).limit(1).get();
if (existing) {
  throw new APIError('FORBIDDEN', { code: 'REGISTRATION_CLOSED' /* … */ });
}
return { data: { ...userData, role: 'owner' } };
```

That is the correct default and it stays the default. The module docstring names its own successor: _"A future invites spec reopens registration via invitation tokens only."_ ADR-0320's consequences say the same thing from the trust side: _"invites wait for a viewer/operator role model in a fast-follow spec."_ `accounts-and-auth` §"Implementation Phases" P3 listed it. Nobody wrote it.

The room primitive shipped in the meantime (DOR-521 → DOR-526), which is what makes this small: a room is already a membership-scoped durable stream with a per-`(member, room)` read cursor, and an invited person is a row in `room_members`. There is no messaging work here at all.

### What the code says that the plan did not

Three corrections, each of which becomes required work below.

**1. `'human'` currently means "owner".** `apps/server/src/services/rooms/room-service.ts`:

```ts
/** Human authors are the operator; nothing in a single-player cockpit hides from them. */
private seesEveryRoom(viewerAuthorId: string): boolean {
  return this.authors.getById(viewerAuthorId)?.kind === 'human';
}

private requireOperator(viewerAuthorId: string, what: string): void {
  if (this.authors.getById(viewerAuthorId)?.kind === 'human') return;
  throw new RoomError('OPERATOR_ONLY', `Only you can change ${what}`);
}
```

A second human author passes both. She would read every room on the install, including the owner's DMs with agents, and could add or remove any member anywhere. `specs/community-server/` §5 says "the schema is already multi-user-capable; the hook, an invite-token table, and a second role are what's missing." The schema is. The authorization is not.

**2. The client picks the human member by `find`.** `apps/client/src/layers/widgets/room-view/ui/ChannelsPage.tsx:35` and `apps/client/src/layers/entities/room/model/use-mark-room-read.ts:64` both do `room?.members.find((member) => member.author.kind === 'human')` to locate the viewer's own membership. With two humans in a room, whichever sorts first wins: Priya's unread divider tracks Dorian's cursor, and marking read advances the wrong row. The client has no concept of "which author am I" because until now there was only one, and nothing on the wire tells it.

**3. The registration rule is written twice.** `packages/cli/src/commands/auth-instance.ts` carries a byte-for-byte copy of the hook, under a comment that says _"Keep the registration policy here in lock-step with the server factory."_ Adding a third state to a rule that lives in two files is how two files disagree.

### The word "operator" is already taken

`accounts-and-auth` P3 proposed `viewer`/`operator` as the second role. Both are wrong here, and the reason is in the source:

- `operator` already means the opposite of a lesser role. `RoomError('OPERATOR_ONLY')` is thrown at agents to protect the person running the machine, and `apps/server/src/services/core/operator/` is the MCP self-service and observability capability domain, also the owner's. Naming a restricted role `operator` inverts a term that is load-bearing in two subsystems.
- `viewer` denies posting. The whole point of the flow is that she lands in the conversation and talks.

This resolves `specs/community-server/` open question #5. See §3.

## Goals

- A second person can join one channel on an existing install, from a link, with no account anywhere else and nothing to install.
- Registration stays closed by default. A bare `POST /api/auth/sign-up/email` from the internet fails exactly as it does today.
- An invited person can see and post in the rooms she is a member of, and nothing else on the install.
- The `'local'` author sentinel becomes an account binding without moving a single message, membership, or read cursor.
- An install that never invites anyone is byte-for-byte unaffected in behavior.
- Zero user-facing cryptographic keys, zero new services, zero new user-visible configuration to make an invite work.

## Non-Goals

- A general permission system, a policy engine, or more than two roles. §3.4.
- Anything remote: `CommunityAdapter`, Buzz, `apps/community`, Postgres, federation. Track A owns those.
- Per-member model budgets or per-member filesystem scoping. §14.6 states the residual honestly instead.
- Social sign-in on the local server. §6 resolves this and explains why it belongs to `apps/community`.
- Email anywhere in the local path: no SMTP, no verification, no emailed invites. The link is delivered by whatever the owner already uses.
- Password reset for a member. `dorkos auth reset-password` stays owner-only; a member who loses her password is removed and re-invited.
- Members inviting other members. Only the owner mints invites in v1.

## Technical Dependencies

- **better-auth 1.6.23** and **@better-auth/api-key ^1.6.23**, already installed in `apps/server`. Two facts verified against the installed types:
  - `databaseHooks.user.create.before` has signature `(user, context: GenericEndpointContext | null) => Promise<boolean | void | { data }>` (`@better-auth/core/dist/types/init-options.d.mts:1142`). The context carries the originating request, so the invite token can reach the hook. It is `null` when a user is created outside a request, which the policy treats as "no invite" and therefore fails closed.
  - `user.additionalFields.role` is declared `input: false` in both auth factories, so `role` is not settable by a client on sign-up or on `update-user`.
- **node:crypto** (`createHmac`, `hkdfSync`, `randomBytes`, `timingSafeEqual`). No new dependency. No JWT library: §1.1 explains why.
- **Existing, reused unchanged:** `resolveBetterAuthSecret` (`services/core/auth/secret.ts`), the `RoomService`/`RoomStore`/`AuthorRegistry` trio, the durable room SSE stream, `turn-budget.ts`, `session-gate.ts`, `exposure-guard.ts`, Drizzle + `better-sqlite3`.

---

## 1. The invite token

### 1.1 Format

A branded, compact, HMAC-signed token. Two base64url segments joined by a dot, behind a fixed prefix:

```
dorkinv_<base64url(payload-json)>.<base64url(hmac-sha256)>
```

**Not a JWT.** A JWT carries its own algorithm in a header, which is the source of the entire `alg: none` and algorithm-confusion class of bugs. This token has no algorithm field: the verifier only ever computes HMAC-SHA-256 and compares. There is nothing to negotiate, so there is nothing to confuse. It also avoids adding a JWT dependency to a server that has none.

The `dorkinv_` prefix follows the existing `dork_mcp_*` convention and makes the token greppable by secret scanners.

Verification order, always, with no early exit that depends on payload contents:

1. Split on the last `.`; reject anything that does not yield two segments.
2. Recompute the HMAC over the raw payload segment and compare with `crypto.timingSafeEqual`.
3. Only then parse the payload JSON and check `v` and `exp`.

Parsing before verifying would make the parser an attack surface reachable by unsigned input. Comparing without `timingSafeEqual` would make the endpoint a timing oracle.

### 1.2 What signs it

**Derive a dedicated invite key from the existing Better Auth secret, with HKDF.**

```
inviteKey = hkdfSync('sha256', betterAuthSecret, salt='', info='dorkos:invite:v1', 32)
```

Reuse the secret, do not reuse the key. Reusing `resolveBetterAuthSecret`'s output means an invite works on a fresh install with nothing configured: that resolver already handles environment override → persisted `0600` file → generate-and-persist, and it already survives restarts. Adding a second secret file would duplicate that whole bootstrap for no benefit.

Deriving a separate key with a fixed `info` string buys domain separation, which matters for two concrete reasons:

- A signature produced for an invite can never be replayed as a session cookie signature, and vice versa, because the two are computed under different keys.
- "Revoke every outstanding invite" would otherwise have to be done by rotating the session secret, which signs every live session out. With a derived key the two are still coupled at the root (see the cost below), but revocation does not need the root at all: §1.4 revokes per-row.

**Cost, accepted and stated:** rotating `BETTER_AUTH_SECRET` invalidates every outstanding invite as well as every session. That is already a "sign everyone out" event, so folding invites into it is not a new surprise. It is documented in the operator docs (§15).

**Rejected — a second secret file.** More `0600` bootstrap code, another thing to back up, another thing to lose, for a property HKDF already provides.

### 1.3 What the token carries

```jsonc
{
  "v": 1,
  "jti": "<16 random bytes, base64url>", // the invites row id
  "exp": 1785000000, // unix seconds
  "cn": "Dork Labs", // community name, frozen at mint
  "inv": "Dorian", // inviter display name, frozen at mint
  "ch": "backend", // channel title, frozen at mint
}
```

The display fields are in the token so the preview page renders from the token alone. Two reasons, in order of weight:

1. **The preview endpoint must be unauthenticated** (§5), which means it is an exemption in `session-gate.ts` reachable by anyone who can reach the install. An unauthenticated endpoint that looks up by an id you supply is an enumeration oracle. One that requires a valid 256-bit HMAC before it looks at anything is not: without the signature it returns the same nothing for every input.
2. It removes a join across `invites`, `rooms`, `authors`, and `user` from a path that has no session to scope it with.

**The token is not a capability, and the payload is not trusted for anything but display.** Redemption reads the `invites` row by `jti` and takes the role, the room, and the seat state from the row. So even a token whose payload someone managed to alter and re-sign could not escalate: a forged `role` field does not exist in the payload and would be ignored if it did.

**No room id in the token, and none in the preview response.** The preview does not need it, and `POST /api/auth/sign-up/email` carries the token itself rather than a room id. Keeping the room id off both surfaces removes the only identifier a link-holder could otherwise carry into a probe of `/api/rooms/:id`.

**What a link-holder can read without redeeming it.** The three display fields are base64, not encrypted, so anyone holding the link can decode the community name, the inviter's name, and the channel title without opening the page. That is identical to what the preview page shows them, so it adds no exposure. §14.2 covers it.

### 1.4 Lifetime, seats, revocation

| Property   | Default    | Notes                                                                                                                                                                                                                                                     |
| ---------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expiry     | **7 days** | Long enough for "I'll do it this weekend"; short enough that a link in a chat scrollback stops working. Stored on the row **and** mirrored in `exp`; both are checked and the row wins. Mirroring alone would make an expiry unshortenable after minting. |
| Seats      | **1**      | An invite is addressed to a person, which is the flow in §10.                                                                                                                                                                                             |
| Revocation | Per-row    | `revoked_at`. Instant, no key rotation, no effect on live sessions.                                                                                                                                                                                       |

**Why a default of 1 is safe, and why it is the honest one.** The obvious objection is that a one-seat link pasted into a group chat fails for the second person. The answer is that widening is non-destructive: raising `max_uses` updates the row and **the already-pasted link keeps working**, because the token only carries `jti` and `exp`, neither of which changes. So the owner can start narrow and widen in one click without regenerating or re-sending anything. That property is what makes 1 the right default rather than a merely cautious one.

The invite panel therefore has no form when the link is created (§10 beat 1) and grows controls on the link afterwards: a used/remaining count, "Let more people use it", and "Turn off this link".

**Revoking does not remove anyone who already joined.** It only stops further redemptions. Removing a person is a separate, explicit action (§3.2), and the copy says so.

**Rejected — an unlimited "anyone with the link" mode.** It is one config field away and can be added later by allowing `max_uses: null`, but shipping it in v1 makes the default question ambiguous and gives the first honest mistake unbounded blast radius on an install that holds the owner's filesystem.

**Rejected — binding the invite to Priya's email address.** It would make replay (§14.3) impossible, but it requires the owner to type an email into the invite form, and it requires Priya to prove that email before she can see the preview. Both are explicitly refused by the experience contract. The seat limit and the short expiry are the compensating controls.

### 1.5 The `invites` table

New Drizzle table in `packages/db/src/schema/invites.ts`, exported from the package barrel. Additive: no existing table changes shape.

```ts
export const invites = sqliteTable(
  'invites',
  {
    /** The `jti` in the token. 16 random bytes, base64url. */
    id: text('id').primaryKey(),
    /** The room the redeemer joins. */
    roomId: text('room_id').notNull(),
    /** The Better Auth user id of the owner who minted it. */
    createdByUserId: text('created_by_user_id').notNull(),
    /** The role granted on redemption. Read from HERE, never from the token. */
    role: text('role').notNull(),
    /** Seats. Never null in v1; nullable is reserved for an unlimited link. */
    maxUses: integer('max_uses').notNull().default(1),
    /** Seats consumed. Incremented by the atomic guard in §2.3. */
    usedCount: integer('used_count').notNull().default(0),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('invites_room_id_idx').on(table.roomId)]
);
```

Deliberately absent: the token itself, any hash of it, and the invitee's email. The token is reconstructible from `id` plus the derived key, so storing it would be a second copy of a credential for no gain, and there is no invitee identity to store because §1.4 rejected binding one.

A companion table `invite_redemptions (invite_id, user_id, redeemed_at)` records who used which seat. It is what makes "who did Dorian let in, and on what link" answerable, and it is what the repair path in §7.3 reads to decide whether work is outstanding.

---

## 2. Registration

### 2.1 The policy

One rule, three branches, evaluated in order:

```
decideRegistration({ userCount, invite }):
  userCount === 0                        → allow, role = 'owner'      // unchanged
  invite is valid and a seat was claimed → allow, role = invite.role
  otherwise                              → refuse FORBIDDEN / REGISTRATION_CLOSED
```

The refusal keeps today's exact status, code, and message, so nothing that already handles `REGISTRATION_CLOSED` changes. A bare `POST /api/auth/sign-up/email` with no invite header still fails, on an install with an owner, exactly as it does now.

Fail-closed by construction rather than by care: the invite branch is only reachable when a validated invite is present, and every way of failing to produce one (no header, malformed token, bad signature, expired, revoked, no seats, `context === null`) falls through to the third branch. There is no path where an error in invite handling produces an _allow_.

### 2.2 How the invite reaches the hook

The sign-up request carries the token in a request header:

```
X-DorkOS-Invite: dorkinv_<payload>.<sig>
```

Read from `context.headers` in the `before` hook. A header rather than a body field because Better Auth validates the sign-up body against the declared user fields, and an undeclared extra property is at best ignored and at worst rejected. A header passes through untouched and is available on `GenericEndpointContext`.

`context` is typed `GenericEndpointContext | null`. `null` means the user was created outside a request, which no invite path does. The policy treats it as "no invite", so it lands on the owner-only branch.

### 2.3 Consuming a seat

The seat is claimed inside the `before` hook, with a single conditional UPDATE:

```sql
UPDATE invites
   SET used_count = used_count + 1
 WHERE id = ?
   AND used_count < max_uses
   AND revoked_at IS NULL
   AND expires_at > ?
```

If it reports zero changed rows, the invite is refused. `better-sqlite3` is synchronous and SQLite takes a write lock for the statement, so two people racing on the last seat cannot both win. Checking-then-updating in two statements could.

**Direction of failure, chosen deliberately.** The seat is consumed _before_ the user row is inserted. If the insert then fails, the seat is burned and the person has to ask for a new link. The alternative ordering loses a seat's worth of protection whenever the reverse happens. We over-consume rather than over-admit.

### 2.4 Where the rule lives

`decideRegistration` moves to `packages/shared` as a **pure function over facts** — it takes a resolved user count and a resolved invite, and returns a decision. It does no I/O and touches no database, which is the only reason it can be shared: `@dorkos/shared` must not depend on `@dorkos/db`.

Both call sites keep their own thin reader and call the shared predicate:

- `apps/server/src/services/core/auth/index.ts` reads the user count and resolves the invite from the request header.
- `packages/cli/src/commands/auth-instance.ts` reads the user count and passes `invite: null` always, because `dorkos auth enable` only ever creates the first user.

This mirrors the shape `exposure-guard.ts` already uses: pure predicates (`isExposureAllowed`, `checkBindAllowed`) plus separate readers (`readExposureState`). It also deletes the "keep this in lock-step by hand" comment, which is the actual defect being fixed.

---

## 3. Roles

### 3.1 The name

Two roles: **`owner`** and **`member`**.

`member` is a plain word a non-developer reads correctly on the first pass, it is already the product's vocabulary (`room_members`, `MemberList.tsx`, "each login is a community member" in community-server §1), and it claims no position on a ladder that does not exist. `operator` and `viewer` are both refuted above.

Existing rows keep `role: 'owner'`. The `user.role` column is already `text` and nullable, so this is not a schema change.

### 3.2 What a `member` may do

**May:**

- Sign in, sign out, change her own name and password.
- See and post in rooms she is a member of. Nothing else on the install is visible.
- Read and advance **her own** read cursor.
- Open a thread off an entry in a room she is in.
- Create, name, and revoke API keys **owned by her**, which inherit her role and nothing more.

**May not:**

- See a room she is not a member of. Not by listing, not by id: `requireVisibleRoom` answers `ROOM_NOT_FOUND` for both "no such room" and "not yours", and that behavior is preserved for her.
- Add, remove, or reconfigure any member, in any room, including her own response mode.
- Create, revoke, or list invites.
- Read or write instance configuration, toggle login, or start or stop a tunnel.
- Create, edit, delete, or run agents outside a room she belongs to.
- Manage workspaces, install marketplace packages, or read the activity feed.
- Grant or change standing permissions. `agent-approval-settings` §3.0 already reserves those for a browser-session credential; they now additionally require `owner`.

### 3.3 Default-deny, and the test that keeps it honest

The gate is **an allow-list, not a deny-list**, and this is the single most important structural choice in §3.

A `member` is refused every gated route unless that route is explicitly classified member-reachable. A new router added next month is owner-only until somebody classifies it, which means the failure mode of forgetting is "Priya gets a 403" rather than "Priya can rewrite the config".

This costs existing installs nothing: the owner passes everything, and until someone mints an invite there are no non-owner users. The classification only ever bites for `member`.

Mechanics, kept to the minimum that works:

- One predicate, `resolveRole(userId): 'owner' | 'member'`, resolved from the `user` row. Roles are never read from a token, a key, or a client.
- One middleware, `roleGate`, mounted immediately after `sessionGate` in `app.ts`. It reads `res.locals.user`, resolves the role, attaches it, and for a `member` refuses any path not on the allow-list with `403` / `FORBIDDEN_FOR_ROLE`.
- The allow-list is a single exported array of matchers in `services/core/auth/member-routes.ts`, with a one-line justification comment per entry. It is short: the rooms surface (scoped by membership already), `/api/auth/*`, `/api/health`, and the per-user API-key endpoints.
- **A coverage test enumerates every router mounted in `app.ts` and asserts each is classified.** An unclassified router fails the build. Without this, the allow-list rots silently, which is the known failure mode of every list like it.

### 3.4 What we are not building

No permissions table, no per-room roles, no role hierarchy, no capability grants, no admin console. If a future need cannot be expressed as "owner or member", that is a new spec, and `packages/db`'s schema is not pre-shaped for it here.

---

## 4. Who a second human is

### 4.1 The `naturalKey`

A human author's `naturalKey` becomes:

```
user:<betterAuthUserId>
```

Opaque (Better Auth ids are random), carries no personal data, and survives the person changing her email or her display name. That is community-server D3's rule applied one layer down, and it is additive with the remote case D3 actually describes: a remote member later mints under a different scheme through the same `AuthorRegistry.resolve` path, and no existing row moves.

The email is deliberately not the key. `author-registry.ts` already argues this for paths: _"A raw path would put `/Users/dorian/…` in front of every member of every room, which is a privacy defect we would have to undo under migration."_ An email address is the same defect one layer up.

`AuthorRegistry` gains `human(userId, displayName)` and loses nothing. `localHuman()` stays, and §11 explains exactly when each is used.

### 4.2 Rebinding the `'local'` sentinel

`author-registry.ts` wrote down the plan for this before the plan existed:

> _"The single human author v1 mints. It gets an account binding when accounts land, without moving any message."_

That is precisely what happens. At owner creation, in the same synchronous transaction:

```sql
UPDATE authors
   SET natural_key = 'user:<ownerId>', display_name = '<owner account name>'
 WHERE kind = 'human' AND natural_key = 'local'
```

The opaque `id` does not change. Every `room_entries.author_id`, every `room_members` row, every `room_sessions` binding, and every read cursor keeps pointing at the same author. Nothing is migrated, nothing is rewritten, and the whole justification for the opaque-id indirection is collected in one statement.

There is no race with a concurrently minted `user:<ownerId>` row, because a human author is only ever minted through `resolveCaller`, and `resolveCaller` returns `localHuman()` until this rebind runs.

The display name changes from `'You'` to the owner's account name. That is visible, and it is correct: `'You'` was only ever right while there was exactly one person, and it renders as `'You'` to Priya the moment there are two. §4.5 makes the client render "you" by identity instead of by literal.

### 4.3 `resolveCaller`

`apps/server/src/routes/room-caller.ts` currently reads:

```ts
if (identity) return service.authorRegistry.resolveAgent(identity.agentPath, identity.displayName);
return service.authorRegistry.localHuman();
```

It gains one branch, between the two:

```
agent identity header present   → resolveAgent(...)                       // unchanged
res.locals.user present         → human('user:' + userId, user.name)      // new
otherwise                       → localHuman()                            // unchanged
```

`res.locals.user` is only ever set by `sessionGate`, which only runs when `auth.enabled` is `true`. So on a login-off install the third branch is the only reachable one and behavior is identical to today. That is the whole of the compatibility story for §11.

Ordering matters and is deliberate: the agent identity header is checked first, so an agent acting under the owner's session still posts as itself.

### 4.4 The two predicates that must stop meaning "human"

Both in `room-service.ts`:

```ts
private seesEveryRoom(viewerAuthorId: string): boolean {
  return this.authors.getById(viewerAuthorId)?.kind === 'human';   // → is the OWNER
}

private requireOperator(viewerAuthorId: string, what: string): void {
  if (this.authors.getById(viewerAuthorId)?.kind === 'human') return;   // → is the OWNER
  throw new RoomError('OPERATOR_ONLY', `Only you can change ${what}`);
}
```

Both become an owner-identity check against a single injected `isOwnerAuthor(authorId): boolean`, supplied to `RoomService` through `RoomServiceDeps` in the same style as the existing `maxAgentDepth()` injection, so the rooms domain still reads no config and no auth module directly.

`isOwnerAuthor` has two modes and one meaning:

- **No owner account exists** (`auth.enabled` off, or on with no users): the `'local'` author is the owner. This is what keeps the single-user install identical.
- **An owner account exists:** the author bound to `user:<ownerUserId>` is the owner, and nobody else is.

`RoomError('OPERATOR_ONLY')` keeps its code and its 403. Its message, `Only you can change ${what}`, is now read by someone for whom "you" is wrong, and becomes: `"Only <owner name> can change ${what}."`

### 4.5 The client has to know which author it is

`ChannelsPage.tsx:35` and `use-mark-room-read.ts:64` both find the viewer's membership with `members.find((m) => m.author.kind === 'human')`. That is not a style problem, it is a correctness bug the moment a second human is in a room: two members match, `find` returns the first, and Priya reads and writes Dorian's cursor.

The client cannot fix this on its own because nothing on the wire tells it who it is. So:

- `RoomWithRoster` gains **`viewerAuthorId: string`** — the author id the server resolved for this request. It is already computed on every one of these routes (`resolveCaller(res).id`), so this adds no work, and it is the same value the server scopes the read by, which makes it authoritative rather than inferred.
- Both call sites become `members.find((m) => m.author.id === room.viewerAuthorId)`.
- Author rendering ("You" versus a name) compares ids against `viewerAuthorId` instead of matching on `kind === 'human'`.

**Rejected — a `GET /api/me` endpoint.** It would be a second round trip on every room open to learn something the room response already knows, and it would drift from the per-request resolution whenever the two disagree.

---

## 5. The invite preview

```
GET /api/invites/preview?token=<token>       (unauthenticated)
```

Exempt in `session-gate.ts`, because it runs before any account exists. Response:

```jsonc
{
  "status": "valid", // valid | expired | revoked | exhausted
  "communityName": "Dork Labs",
  "inviterName": "Dorian",
  "channelName": "backend",
  "expiresAt": "2026-08-03T12:00:00.000Z",
}
```

**What it does not return, and why.** No room id (§1.3), no member count, no other member names, no agent names, no owner email, no other channels, no version, no path, no host. A person deciding whether to accept an invitation needs to know who is asking and to what. Everything else is the install's business.

**Why it is not an enumeration oracle.** The signature is verified before anything else happens. Every failure — malformed, bad signature, unknown `jti` — returns the identical `404 { "code": "INVALID_INVITE" }`. There is no response shape, status, or timing that distinguishes "you guessed a token that does not exist" from "you guessed a token whose signature is wrong", and forging a signature means forging HMAC-SHA-256 under a 256-bit key.

`status` values other than `valid` do require the row, and they are only reachable with a signature that already proves the invite was issued by this install. So the row read is gated behind proof of issuance, not exposed by it.

**The community name.** DorkOS has no such field today. This spec adds one optional config field, `community.name`, defaulting to `null`; when it is null the preview falls back to `"<owner name>'s DorkOS"`. One field, one default, no required setup, and it is what makes the preview say something a human recognizes. It is a `conf`-backed schema change and therefore needs a semver-keyed migration per `contributing/configuration.md` and the `adding-config-fields` skill. Flagged as a guess in §17.

---

## 6. The join screen, and the Google/GitHub question

**Resolved: email and password only. No Google, no GitHub, no "Continue with your DorkOS account" — not in v1, and not because of effort.**

### 6.1 Why not Google and GitHub on the local server

Not an ease-of-use judgment. It is structurally blocked by a decision the auth module already made on purpose.

`apps/server/src/services/core/auth/index.ts` sets **no `baseURL`**, and says why at length:

> _"No `baseURL`: this server answers on many origins — loopback, a LAN IP, a dynamic ngrok tunnel, or a reverse proxy — so the origin is derived from each incoming request rather than pinned to one URL."_

Google and GitHub both require **exact, pre-registered OAuth redirect URIs**. A local DorkOS has no stable one: it is `localhost:4242` here, a LAN address there, and a fresh ngrok hostname after every restart on the free tier. Registering a redirect URI for an origin that changes on restart is not a setup burden, it is an impossibility.

On top of that, every self-hoster would have to register two OAuth applications and carry four secrets, for a product whose pitch is that you run it yourself. And `apps/client` does not use `better-auth/client` at all — `apps/client/src/layers/features/auth/model/auth-client.ts` is a hand-rolled REST wrapper — so the social redirect flow would need new client machinery as well.

**This asymmetry with `apps/site` is not an inconsistency; it is a consequence of where each app runs.** `apps/site` has exactly one fixed public origin, which is precisely what makes OAuth work there. So does `apps/community` (D4), which copies that setup deliberately. Social sign-in belongs to the app with a stable front door, and that is not this one.

### 6.2 Why not "Continue with your DorkOS account"

The RFC 8628 device flow shipped, and it is the wrong tool here on three counts.

**It is not a sign-in flow.** It links _an instance_ to _an account_: the machine's owner approves, and the cloud returns a scoped API key to the instance (`apps/site/src/lib/auth.ts`, the `/device/token` after-hook). There is no path that turns a third party's cloud identity into a local `user` row and a local session. Building one is an identity federation the codebase does not have.

**It would put us in the middle.** community-server §4 states the design principle: _"The community's owner runs the server, owns the roster, holds the messages. DorkOS-the-company is nowhere in the middle."_ Requiring a dorkos.ai round trip to join Dorian's install contradicts that in the first thirty seconds of the first user's first experience.

**The UX fails requirement #3 on its own.** Device flow is: read an 8-character code, open a second site on a second domain, sign in there, approve, come back. That is three screens on two origins. The requirement is one screen.

It is still the right _third_ button later. community-server §4 already frames it correctly: _"A DorkOS account becomes one optional button beside Google and GitHub — a convenience for people in several communities, never an authority."_ The word doing the work is _several_. On one self-hosted install with one community, a portable identity has nothing to be portable across.

### 6.3 What the join screen is

One page. The preview block on top, the form directly beneath it, no navigation between them. She reads before she types, and it is still one screen.

Three fields:

| Field    | `autocomplete` | Notes                                                                                                                                                                                                     |
| -------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name     | `name`         | What people see in the room. Not a username, nothing to invent, no uniqueness rule. Better Auth's `user.name` is `NOT NULL`, so it is asked for rather than derived from an email.                        |
| Email    | `username`     | Matches the existing `LoginScreen` and `OwnerSetupScreen`, so a password manager associates the credential with this origin correctly. Never verified, never emailed (`requireEmailVerification: false`). |
| Password | `new-password` | One field with a reveal toggle. No confirm field: managers fill one field, and a second `new-password` input makes some of them offer to save the wrong value.                                            |

Submitting posts to `/api/auth/sign-up/email` with the `X-DorkOS-Invite` header, then navigates to the room. No verification wall, no second step, no "check your email".

**The client needs a public route.** Today `apps/client` has no unauthenticated route at all: `AuthGuard` wraps `RouterProvider` in `main.tsx` and swaps the whole tree for `LoginScreen` when the auth-required signal is set. `/join/:token` must render _through_ that guard. The narrowest change is for `AuthGuard` to pass through when the location is `/join/*`, keeping the guard's overlay model and adding exactly one exempt path.

---

## 7. Landing in the conversation

### 7.1 What happens on redemption

In the `after` hook, in one synchronous `better-sqlite3` transaction:

1. **Mint the author.** `authorRegistry.human('user:' + userId, name)`.
2. **Admit her to the room.** `RoomService.admitInvitedMember(roomId, authorId)`, a new named method. It is needed because `addMember` is operator-only and she is not the operator, and it exists as a _named service method_ rather than a raw store call so that the one place that bypasses `requireOperator` is one auditable place with a docstring, not a store write buried in auth code. It writes `responseMode: 'mention-only'`, which is what a channel join already uses.
3. **Set her read cursor to the room's current `max(seq)`.**
4. **Write the join notice.**
5. **Record the redemption** in `invite_redemptions`.

### 7.2 The read cursor is the difference between "in the conversation" and "homework"

At `lastReadSeq = 0` she opens a channel with two years of history and every message unread. At `max(seq)` she lands at the bottom of a live conversation, history scrollable above her, nothing shouting. Requirement #4 is "she lands in the conversation, not an empty state", and an unread badge over the entire archive is its own kind of empty state.

`max(seq)` it is. This matches what joining a Slack channel does, and it is the reason to do the join server-side at redemption rather than lazily on first open.

### 7.3 The join notice, and the repair path

`RoomNoticeCode` gains **`member_joined`**. The enum's own docstring instructs this: _"a new member-facing event earns a new code here rather than a free-text convention."_ The notice is authored by the system author with `subjectAuthorId` set to the new member, which is exactly the shape the schema documents for "written by the system, about somebody else".

The `after` hook is **non-throwing**, mirroring `seedLegacyMcpApiKey`'s established pattern: it must never fail the sign-up it runs inside. Because it is one synchronous SQLite transaction on the connection that just created the user, the realistic failure is process death mid-write. The repair is an idempotent `reconcileInviteRedemptions()` at startup, alongside `ensureDorkBot()`: any `invite_redemptions` row whose user has no membership in the invite's room gets one. Cheap, bounded, and it uses a reconciler pattern the codebase already runs for agents.

### 7.4 The stream needs nothing

`GET /api/rooms/:id/events` is already membership-scoped and already does snapshot → gap-free replay → live. Once the `room_members` row exists, she is a reader. There is no new streaming work in this spec, which is the dividend of the room primitive having shipped first.

---

## 8. Data model changes

**New (`packages/db`):** `invites`, `invite_redemptions`. One generated Drizzle migration.

**Changed:** nothing. `user.role` takes a second value in an existing nullable `text` column. `authors.natural_key` takes a new format in an existing column, and the one pre-existing row is rebound by §4.2 rather than by a migration.

**Config:** `community.name`, optional, default `null`, with a semver-keyed migration.

**Shared schemas (`packages/shared`):** `RoomNoticeCode` gains `member_joined`; `RoomWithRoster` gains `viewerAuthorId`; new `InvitePreview`, `CreateInviteRequest`, `Invite` schemas; `decideRegistration` and its types.

## 9. API changes

| Route                             | Auth     | Purpose                                                     |
| --------------------------------- | -------- | ----------------------------------------------------------- |
| `GET /api/invites/preview?token=` | **none** | Render the preview. Session-gate exemption. §5.             |
| `POST /api/invites`               | owner    | Mint a link for a room. Returns the token and the full URL. |
| `GET /api/invites`                | owner    | List live invites with seat counts and who redeemed them.   |
| `PATCH /api/invites/:id`          | owner    | Raise `maxUses`. Does not change the token.                 |
| `DELETE /api/invites/:id`         | owner    | Revoke. Instant.                                            |

Changed: `POST /api/auth/sign-up/email` accepts `X-DorkOS-Invite`. Every gated route may now answer `403 FORBIDDEN_FOR_ROLE`. `RoomWithRoster` responses carry `viewerAuthorId`.

**The invite URL is built from the reachable origin.** If a tunnel is live, the tunnel origin; otherwise the bind address. §14.5 covers what the UI must say when that address is `localhost`.

## 10. User experience

### The four beats

**1. Dorian clicks Invite in a channel and gets a link.** No form. The channel menu gains one item, `Invite`. Clicking it mints the invite and shows the link with a copy button. Under it, one line:

> Anyone with this link can join #backend. It works once, and it stops working in 7 days.

And two actions: `Let more people use it` and `Turn off this link`.

**2. Priya opens it and sees who invited her and where, before signing up.**

> **Dorian invited you to #backend**
> Dork Labs · Dorian runs this community.

**3. One screen to join.** Name, email, password, directly under the invitation, with the autocomplete attributes in §6.3. Button: `Join`. No username, no email verification, no second step.

**4. She lands in the conversation.** At `/channels/<roomId>`, scrolled to the live end, nothing marked unread, with `Priya joined` as the most recent entry.

### When it does not work

| Situation              | What she reads                                                                 |
| ---------------------- | ------------------------------------------------------------------------------ |
| Expired                | This invite has expired. Ask Dorian for a new link.                            |
| Revoked                | This invite no longer works. Ask Dorian for a new link.                        |
| All seats used         | This invite has already been used. Ask Dorian for a new link.                  |
| Malformed or bad       | This link doesn't work. Check that you copied all of it, or ask for a new one. |
| Already has an account | You already have an account here. Sign in instead.                             |
| Wrong password later   | (unchanged) The existing `LoginScreen` rate-limit and error copy.              |

Every one of them names the person who can fix it, because the person who can fix it is a human she knows and not a support queue.

### Refused, and stated so on purpose

- **An email required to preview an invite.** The preview is the invitation. Making her identify herself to read it turns it back into a form.
- **"Install the app to continue."** She joins in a browser.
- **Any screen with the word "server" on it that she has to read.** This includes the ownership line: community-server §4 proposes _"This community runs on Dorian's server"_, which contains exactly the word this brief refuses. Resolved in favor of the refusal: the line is **"Dorian runs this community."** It says the same thing and does not ask her to hold a concept she does not need. Recommended for community-server's own copy too. Flagged in §17 as a contradiction between the two documents.
- **Any user-facing key, code, fingerprint, or secret.** She copies nothing, writes nothing down, and has nothing to lose.

## 11. Migration

**An install that never invites anyone changes in no observable way.** That is a requirement, not an aspiration, and it holds because of where the branches sit:

| Install state                             | Behavior                                                                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.enabled: false`, no users (default) | `sessionGate` is a pass-through, so `res.locals.user` is never set, so `resolveCaller` returns `localHuman()` on every request. `isOwnerAuthor` treats the `'local'` author as the owner. `roleGate` never runs. Identical. |
| Owner exists, never invited anyone        | The `'local'` author rebinds to `user:<ownerId>` and takes the owner's account name. Still one human, still the owner, still sees and does everything. One visible change: their name in a roster instead of `You`.         |
| Owner plus members                        | The new behavior.                                                                                                                                                                                                           |

**Schema:** additive only. Two new tables; no column added, dropped, or retyped on an existing one.

**Config:** one optional field with a default, so an untouched `config.json` keeps working.

**Rollback:** dropping the two tables and reverting the predicates returns the install to owner-only. The rebound `authors.natural_key` is the one thing that does not revert, and it does not need to: `isOwnerAuthor` in its no-owner mode looks for the `'local'` key, so a rollback that also removed the owner account would strand it. Documented for the release; a rollback with the owner account intact is unaffected.

## 12. Testing Strategy

**Unit (server).**

- Token: round-trips; rejects a flipped payload byte, a truncated signature, a swapped segment, an empty signature, and `alg`-style prefix games; expired rejected; uses `timingSafeEqual`; the derived key differs from the Better Auth secret.
- `decideRegistration`: all three branches, plus `context === null`, plus every invalid-invite reason falling through to refuse. A test that asserts the _refusal_ is the default when the invite argument is malformed in any way.
- Seat consumption: the conditional UPDATE claims exactly one seat; a second attempt on a 1-seat invite reports zero rows; a revoked and an expired invite both report zero rows.
- `isOwnerAuthor`: both modes; a `member` author is not the owner; the `'local'` author is the owner only while no owner account exists.
- `roleGate`: a `member` is refused an owner-only path and allowed an allow-listed one; an owner passes both; the gate is inert when `auth.enabled` is false.
- **The allow-list coverage test:** every router mounted in `app.ts` is classified. An unclassified one fails. This is the test that keeps §3.3 true a year from now.

**Integration (server, supertest, in-memory SQLite).**

- Full path: owner signs up → mints an invite → preview renders → second sign-up with the header succeeds → the member is in `room_members` → `GET /api/rooms/:id/events` streams to her → she posts and the entry commits.
- **The negative that matters most:** `POST /api/auth/sign-up/email` with no header, with a garbage header, with an expired token, and with a revoked token, on an install that has an owner. All four return `FORBIDDEN` / `REGISTRATION_CLOSED`.
- Escalation: a `member` calling `POST /api/rooms/:id/members`, `PATCH /api/config`, `POST /api/agents`, and `GET /api/rooms` for a room she is not in. All refused, and the room case answers `ROOM_NOT_FOUND` rather than `403`, so it does not confirm the room exists.
- A member's API key gets the member's role, not the owner's.
- A member cannot set her own role through `POST /api/auth/update-user`.
- Preview returns the identical body and status for a bad signature and an unknown `jti`.
- `POST /api/invites` is refused when `auth.enabled` is false (§14.5).

**Client (RTL, mock `Transport`).**

- `/join/:token` renders through `AuthGuard` with no session.
- The preview shows the inviter, the channel, and the community, and the form is on the same screen.
- Each of the five failure states renders its own copy.
- **The read-cursor regression:** a room with two human members resolves the viewer's membership by `viewerAuthorId`, not by `find(kind === 'human')`. This test fails against today's code, which is the point of writing it.

**E2E (Playwright, `apps/e2e`).** Owner enables login → creates an invite → a second browser context opens the link → joins → sees the channel with the live conversation and no unread badge → posts → the owner's context receives it on the stream.

**Mocking.** No network anywhere. Time is faked for expiry. The derived key is deterministic from a fixed test secret.

## 13. Performance

Preview: one HMAC and one indexed primary-key read. Redemption: two extra synchronous statements inside a transaction that already exists. `roleGate`: one `user`-row read per gated request, on the same path that already reads a session — cached alongside Better Auth's existing 5-minute cookie cache so it does not add a read to hot paths like SSE reconnect. `viewerAuthorId` is a value the handler already computed. Nothing here is on a streaming path.

## 14. Security Considerations

### 14.1 Token forgery

**Failure mode.** Someone constructs a payload naming themselves an owner, signs it with a guessed or leaked key, and gets an owner account on a machine that holds the owner's filesystem and model quota.

**Why it fails.** The key is 256 bits, derived by HKDF from a secret that is either operator-supplied or 32 bytes from `randomBytes`, stored `0600`, with `secret.ts` actively repairing loosened permissions on read. The signature is HMAC-SHA-256 with no algorithm negotiation, verified before the payload is parsed, compared with `timingSafeEqual`.

**And if it did not fail:** the payload has no `role` field, and redemption reads the role, the room, and the seats from the `invites` row keyed by `jti` (§1.3). A forged token that decoded perfectly would still only grant what the row it names says, and a row it does not name does not exist. Forgery is not a single point of failure.

### 14.2 Token enumeration

**Failure mode.** A script sprays `/api/invites/preview` with guesses to harvest community names, inviter names, and channel names across the internet, or to discover which hosts run DorkOS.

**Why it fails.** A guess must carry a valid HMAC. Every failure returns byte-identical `404 { "code": "INVALID_INVITE" }` with no timing difference, so there is no signal to hill-climb on. The endpoint is rate-limited per IP. The row is only read after the signature proves the invite was issued here, so the database is behind the proof rather than in front of it.

**Residual, stated.** The endpoint's existence reveals that a host runs DorkOS. `/api/health` already does, so this adds nothing. And a legitimately obtained link does leak the three display fields to whoever holds it, decodable from the URL without opening the page (§1.3). If Dorian pastes an invite somewhere public, the community name, his name, and the channel title are public. That is a property of the link, not a defect in the endpoint, and the docs say it plainly.

### 14.3 Replay

**Failure mode.** The link is forwarded, screenshotted, or leaked from a chat log, and a stranger joins in Priya's place. Or the same token is submitted twice to take two seats.

**The second one cannot happen:** the seat is claimed by an atomic conditional UPDATE (§2.3) under SQLite's write lock.

**The first one can, and is accepted by design.** An invite link is a bearer credential; whoever holds it can join. Binding it to an email would prevent this and is rejected in §1.4 because it requires an email to preview, which the experience contract refuses. The controls that remain are real but partial: one seat by default, a 7-day expiry, instant revocation, a `member_joined` notice that names the person who actually joined, and the fact that joining grants one room and nothing else. A stranger who redeems Priya's invite lands in one channel, visible to everyone in it, under a name the owner can see and remove. This is the honest characterization and it belongs in the docs, not just here.

### 14.4 Privilege escalation via role

**Failure mode A — the one that exists in shipped code.** `seesEveryRoom` and `requireOperator` grant on `kind === 'human'`. A member minted as a human author reads every room on the install, including the owner's DMs with agents, and rewrites any roster anywhere. This is not hypothetical: it is the current behavior, and it activates the instant a second human author exists. §4.4 is the fix, and the integration tests in §12 are written against it specifically.

**Failure mode B — a client sets its own role.** Blocked by `input: false` on `user.additionalFields.role` in both auth factories, and by the fact that `decideRegistration` returns the role rather than accepting one. Tested against `update-user` as well as sign-up.

**Failure mode C — a member's API key outranks her.** `verifyRequestAuth` resolves an API key to its owner's `userId` via `referenceId`; `roleGate` resolves the role from the `user` row. A key cannot carry a role its owner does not have, because a key does not carry a role at all.

**Failure mode D — a route nobody classified.** The allow-list is default-deny (§3.3), so a new router is owner-only until classified, and the coverage test fails the build until somebody does.

### 14.5 Interaction with ADR-0320's exposure guard

**Minting an invite requires `auth.enabled === true`.** `POST /api/invites` refuses with `409 AUTH_REQUIRED_FOR_INVITES` otherwise, routing the client into owner setup the same way `AUTH_REQUIRED_FOR_EXPOSURE` already does.

**The failure mode if it did not.** Dorian mints an invite on a login-off install. Priya opens the link. `sessionGate` is a pass-through when `auth.enabled` is false, so she does not get a member's access; she gets **unauthenticated access to the entire API**, including config, agents, and the filesystem routes. An invite on a login-off install is not a weaker invite, it is a public link to an ungated machine. The guard has to refuse at mint time.

**It reads `auth.enabled` directly, not `canExpose()`.** This is deliberate and it matters: `checkBindAllowed` honors `DORKOS_ALLOW_INSECURE_BIND=true`, the container escape hatch, which permits a non-loopback bind with no login at all. Routing the invite gate through the exposure guard would let that escape hatch open registration. It must not, so the invite gate reads the flag itself.

**A localhost-only install produces a link that does not work for her,** and the UI has to say so rather than hand over a broken URL. When no tunnel is live and the bind is loopback, the invite panel shows:

> This link only works on this computer. Turn on remote access so someone else can join.

**Turning the tunnel off revokes nothing.** Members simply cannot reach the install until it is back. Sessions and memberships survive. Documented, because the alternative reading — that closing the tunnel removes people — is the one an operator will assume.

### 14.6 What a member can spend, and what runs on the owner's machine

ADR-0320 wrote this down as the reason invites were deferred:

> _"anyone who can drive agents on an instance effectively has the server process's filesystem access and spends the owner's Claude quota. This is why registration is owner-only until the viewer/operator model exists."_

The role model does not repeal that. It bounds it:

- She reaches only rooms she was admitted to, so she can only trigger agents that are members of those rooms.
- `turn-budget.ts` caps automatic turns per room and globally, and it _"counts without asking who is calling"_, so it applies to her identically.
- She cannot add an agent to a room, create an agent, or change an agent's response mode.

**What is not bounded, stated plainly:** there is no per-member budget. A member posting in a room with an agent in it spends the owner's model quota and causes that agent to run with the server process's filesystem access, inside whatever workspace that room is bound to. The global cap is the only ceiling. Inviting someone is a statement of trust in that person, and the docs say exactly that, in those words, on the page where the owner clicks Invite. A per-member budget is named future work, not a claim.

### 14.7 The widened unauthenticated surface

`/api/invites/preview` is the first `/api/*` route exempted from `sessionGate` for reasons other than auth or health. Constrained accordingly: `GET` only, one query parameter, no write, rate-limited, fixed response shape, and no branch reachable before the signature check. The exemption is added to the documented list in `session-gate.ts` with its justification, matching how the workbench exemptions are already recorded there.

### 14.8 Account enumeration on join

A holder of a _valid_ invite who submits an email that already has an account learns that it does. That is existing Better Auth sign-up behavior, and the join screen surfaces it deliberately because "you already have an account, sign in" is the correct thing to tell the person it actually happens to. It is gated behind holding a valid invite, and the accounts on a self-hosted install are the owner and whoever the owner invited. Accepted; noted so it is a decision rather than an oversight.

## 15. Documentation

- `docs/`: a new "Invite someone to your DorkOS" page written to `writing-for-humans` — what a link is, that it works once, that it expires, how to revoke it, and, plainly, that inviting someone lets them talk to agents that run on your computer and spend your model quota. Update "Securing your instance" for roles and for the invite-requires-login gate.
- `contributing/authentication.md`: the token format, the derived key, the registration policy's single source of truth, the allow-list and its coverage test, and the `isOwnerAuthor` two-mode rule.
- `contributing/configuration.md`: `community.name` and its migration.
- `changelog/unreleased/`: one fragment. It must not claim the flow works end to end before it has been driven by a real second person on a real install (the demo-claim gate).
- ADR candidates in §18.

## 16. Implementation Phases

**Phase 1 — make a second human safe.** This ships alone and is worth shipping alone, because it fixes live behavior. `isOwnerAuthor` injected into `RoomService`; `seesEveryRoom` and `requireOperator` converted; `viewerAuthorId` on `RoomWithRoster`; both client call sites fixed; `resolveCaller` gains its session branch; the `'local'` rebind at owner creation; `roleGate` with the allow-list and its coverage test.

**Phase 2 — invites.** The `invites` and `invite_redemptions` tables; the token module; `decideRegistration` extracted to `packages/shared` and adopted by both auth factories; the five routes; the exposure gate; `admitInvitedMember`; the `member_joined` notice code; `reconcileInviteRedemptions`.

**Phase 3 — the experience.** The `Invite` menu item and the link panel; `/join/:token` and the `AuthGuard` carve-out; the preview and join screens with the copy in §10; the failure states; `community.name`; the docs.

Phase 1 has no dependency on Phase 2 and closes the escalation described in §14.4A, so it goes first even if invites slip.

## 17. Open Questions

### Resolved 2026-07-27 by Dorian

| #   | Question                      | Decision                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2   | Default seats                 | **1**, as specced — and the seat _tracking_ requirement is explicit: we must record who was admitted by which link, in a shape that already supports multi-person links so nothing breaks if we widen later. §1.5's `invite_redemptions (invite_id, user_id, redeemed_at)` plus row-side `max_uses`/`used_count` already satisfies this. No change.                        |
| 4   | Role name                     | **`member`**, on the §3.1 evidence.                                                                                                                                                                                                                                                                                                                                        |
| 5   | Owner display name            | **Keep `You` until a second member exists**, then render everyone under their real name. Chosen over "always show real names" specifically so a solo user sees _no_ change the day they turn on **Require login** — the change arrives with the second person, which is when `You` actually becomes ambiguous. Note this narrows what the §16 Phase 1 changelog may claim. |
| 1   | `community.name` config field | **Add it**, with its semver-keyed migration. A derived `"<owner>'s DorkOS"` is worse than a name the owner chooses, and the preview needs one.                                                                                                                                                                                                                             |
| 3   | Expiry                        | **7 days**, as specced.                                                                                                                                                                                                                                                                                                                                                    |
| 6   | Name field on the join screen | **Ask for it.** A person's first appearance in a room should not be an email local-part.                                                                                                                                                                                                                                                                                   |
| 7   | Extract `decideRegistration`  | **Extract to `packages/shared`.** The three-strike rule yields to the existing "keep in lock-step by hand" comment in `auth-instance.ts`, which is already a live hazard.                                                                                                                                                                                                  |
| 9   | `member_joined` notice code   | **Yes** — the enum docstring instructs it, and a silent membership change is worse.                                                                                                                                                                                                                                                                                        |
| 10  | Removing a member             | **Deferred to its own spec.** Account deletion, message retention, and what she sees on her next request are a coherent unit and not this one.                                                                                                                                                                                                                             |
| 11  | Rate limits                   | Implementation's call; follow whatever Better Auth uses for its own endpoints so the numbers are consistent.                                                                                                                                                                                                                                                               |
| 12  | `AuthGuard` carve-out         | Accepted as specced. Revisit if a second public surface appears.                                                                                                                                                                                                                                                                                                           |

**Still open — #8, member API keys.** Deliberately not decided yet. Dorian asked how Buzz handles attaching agents before we choose, since "she brings her agents" is the MVP's differentiating beat and we have committed to zero user-facing keys. See `research/20260727_agent-identity-in-communities.md`.

### Original list

Every guess below is a guess. None of them was papered over.

1. **`community.name` as a new config field.** Invented here because the preview needs a name and DorkOS has none. It costs a `conf` schema change and a semver migration. Alternative: derive `"<owner name>'s DorkOS"` always and add no field. Recommend adding it; confirm.
2. **Default seats = 1.** Argued from "widening is non-destructive" (§1.4), but it is still a product call. 1 or 5?
3. **Expiry = 7 days.** Picked as the interval that survives a weekend and not a quarter. No evidence behind the exact number.
4. **The role name `member`.** Recommended with evidence that `operator` and `viewer` are both wrong (§3.1). Naming is Dorian's.
5. **The owner's room display name changes from `You` to their account name** (§4.2). Strictly more correct once there are two people, and visible to an existing single user the moment they enable login. Acceptable?
6. **Asking for a Name field on the join screen.** Better Auth's `user.name` is `NOT NULL`, so it is either asked for or derived from the email local-part. Asking adds a field to a screen the brief wants minimal; deriving means her first appearance in the room is `priya.mehta`. Chose to ask. Confirm.
7. **Extracting `decideRegistration` to `packages/shared`.** Justified by the existing lock-step comment in `auth-instance.ts`, but it is a new shared export for a small predicate, and the DRY rule in `.claude/rules/conventions.md` is a three-strike rule at two copies. Extract, or accept a third hand-synced copy?
8. **Do members get their own API keys in v1?** Listed as allowed in §3.2 because community-server §4 beat 5 is "she brings her agents". But scoping a member's key to her rooms is not enforced by anything in this spec beyond `roleGate`, and that beat is Track A work. Ship member keys, or defer them?
9. **Extending `RoomNoticeCode` with `member_joined`.** The enum's docstring instructs exactly this, so it is a low-risk guess, but it is a shared-schema change that touches the client renderer. Confirm it is wanted rather than a silent membership change.
10. **Removing a member.** This spec gives the owner `removeMember` on the roster. It does not say whether her _account_ is deleted, whether her past messages remain, or what she sees on her next request. Deliberately unresolved; likely its own small spec.
11. **Rate-limit numbers** for the preview endpoint and for redemption. Not chosen. Better Auth has built-in rate limiting on its own endpoints; the preview route is ours and needs a number.
12. **The `AuthGuard` carve-out** (§6.3) is the narrowest change that works, but `apps/client` currently has no public route at all, so it is also the first. A real route-level split may be cleaner if more public surfaces follow.

### Contradictions found in the source material

Recorded here rather than smoothed over, because each one changes something.

- **`specs/community-server/` is not on `origin/main`.** It is on the local `HEAD` (`7099013d2`), one unpushed commit ahead. All citations here anchor on `7099013d2`.
- **community-server §5 understates Track B.** It says "the schema is already multi-user-capable; the hook, an invite-token table, and a second role are what's missing." Three shipped authorization sites and two client call sites are also missing (§"What the code says"). Phase 1 exists because of this.
- **community-server §4's ownership line contains the word this brief refuses.** _"This community runs on Dorian's server."_ Resolved to "Dorian runs this community" (§10).
- **The preview does read a row.** The brief asked for a preview that renders "without a DB round trip or a session". It renders without a session, and it renders its display fields from the token alone. It still reads one indexed row to answer revocation and seat state, because a revoked invite that previews beautifully and then fails at submit is a worse experience and a worse security story than one that says so up front. The property that actually matters — that the endpoint is not an oracle — is delivered by verifying the signature before touching the database, not by avoiding the database (§5).

## 18. Related ADRs

**Constraining:**

- ADR-0320 — optional-by-default local login, required on exposure. §14.5 and §14.6 live inside it.
- ADR-0311 — Better Auth as the single identity core.
- ADRs `260726-170125` / `260726-170126` / `260726-170127` — the room model, author identity, the cascade guard.
- ADR-0043 — file-canonical source of truth (the precedent behind the derived-cache reasoning in `author-registry.ts`).

**Candidates to extract from this spec:**

- _Invite links are signed, self-describing, and seat-limited; the role comes from the row, never the token._ (§1)
- _A restricted role is enforced by a default-deny allow-list with a build-failing coverage test, not a permission system._ (§3.3)
- _The local server does not gain social sign-in; a stable public origin is what OAuth requires, and only `apps/site` and `apps/community` have one._ (§6)

## 19. References

- `apps/server/src/services/core/auth/index.ts` — the registration hook this spec replaces
- `apps/server/src/services/core/auth/secret.ts` — `resolveBetterAuthSecret`, the root of the derived invite key
- `apps/server/src/services/core/auth/session-gate.ts` — the gate, `verifyRequestAuth`, and the exemption list
- `apps/server/src/services/core/auth/exposure-guard.ts` — ADR-0320's enforcement, and the insecure-bind escape hatch
- `apps/server/src/services/rooms/author-registry.ts` — the opaque-id boundary, and the `'local'` sentinel
- `apps/server/src/services/rooms/room-service.ts` — `seesEveryRoom`, `requireOperator`, `requireSeedingAllowed`
- `apps/server/src/services/rooms/turn-budget.ts` — the caps that apply whoever is calling
- `apps/server/src/routes/room-caller.ts` — `resolveCaller`
- `packages/cli/src/commands/auth-instance.ts` — the second copy of the registration rule
- `packages/db/src/schema/auth.ts`, `packages/db/src/schema/rooms.ts` — the tables
- `packages/shared/src/room-schemas.ts` — `RoomNoticeCode` and its "earn a new code" rule
- `apps/client/src/layers/features/auth/` — `LoginScreen`, `OwnerSetupScreen`, `AuthGuard`, the hand-rolled auth client
- `apps/client/src/layers/widgets/room-view/ui/ChannelsPage.tsx`, `apps/client/src/layers/entities/room/model/use-mark-room-read.ts` — the `find(kind === 'human')` bug
- `apps/site/src/lib/auth.ts` — the cloud instance, for the contrast in §6
- `specs/community-server/01-ideation.md`, `specs/accounts-and-auth/02-specification.md`, `specs/rooms/02-specification.md`
