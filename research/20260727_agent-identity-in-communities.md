---
title: 'Agent identity in communities — how Buzz attaches an agent to a human, and what survives in a no-user-facing-keys world'
date: 2026-07-27
type: external-source-review
status: active
tags:
  [
    buzz,
    nostr,
    nip-oa,
    nip-aa,
    agent-identity,
    owner-attestation,
    invites,
    community-server,
    api-keys,
  ]
feature_slug: community-server
---

# Agent identity in communities

- **Date:** 2026-07-27
- **Status:** active
- **Question:** In Buzz, how does a person connect their own AI agents to a community they belong to? Does that require a credential separate from their normal login, why or why not, and what is the resulting security model? Then: which of that reasoning survives translation into DorkOS, where D3 commits us to zero user-facing cryptographic keys?
- **Method:** Source review only. No relay was run. Every claim about Buzz carries a `file:line` from the checkout.
- **Buzz anchor:** `654f384906b5c720a60a199d85031a6f1cb6efc9` — `fix(desktop): read the newest pair-scoped harness log (#3134)`, 2026-07-27 11:45:03 -0400, `github.com/block/buzz`, branch `main`, Apache-2.0. Shallow clone (`--depth 1`), so **no git history was available** — every "they removed X" style claim below is inferred from the code's present shape and labelled as such.
- **DorkOS anchor:** working tree at `5a84de271` plus the uncommitted `specs/invites/`, `specs/agent-trust/`, `specs/capability-registry/`.
- **Prior art this builds on:** `research/20260727_buzz-protocol-capability-spike.md` (same Buzz commit; read it first for the transport, room and roster picture), `research/20260724_multi-user-communities.md` §"Agent identity via owner attestation".

> **Citation discipline.** Same rule as the spike: never assert "Buzz does X" from knowledge of Nostr. Claims sourced only to a Buzz markdown file or a NIP draft are labelled **[doc-only]** or **[NIP-only]**. A NIP draft describes intent; it is not evidence that the relay implements it. Where code and doc disagree, the code wins and the disagreement is recorded.

---

## Executive summary

**Buzz's answer: the agent gets its own keypair, and the human's app signs a short attestation binding it to the human's. The user fills in a name and a description, clicks a button, and everything else is invisible.**

The mechanism is NIP-OA (owner attestation): a four-element tag `["auth", <owner-pubkey>, <conditions>, <sig>]`, where the signature is the owner's Schnorr signature over `SHA256("nostr:agent-auth:" || <agent-pubkey> || ":" || <conditions>)` (`docs/nips/NIP-OA.md:31-46`; built at `crates/buzz-sdk/src/nip_oa.rs:109-111`, signed at `:160-165`). The agent presents that tag inside its own NIP-42 AUTH event; the relay verifies it, checks that the **owner** is a community member, and admits the agent without ever creating a membership row for it (`crates/buzz-relay/src/handlers/auth.rs:75-78, 217-238`; `crates/buzz-relay/src/api/mod.rs:81-105`).

**Is that a credential separate from the human's login? Yes.** But separation is not what they were buying. What they were buying is that the agent is a **separate principal** — a different author, a different member of a channel, a different row in the audit log, permissioned on its own identity. `README.md:47`: _"Let an agent triage a bug without giving it the keys to the kingdom. Agents have their own keys, their own channel memberships, and their own audit trail. Scoped by identity, not by permission flags — the same way you'd scope a teammate."_

**They explicitly rejected API tokens for this.** The comment sits in the creation path: _"Agents authenticate via the auth tag in their kind:0 profile event. **No tokens are minted.**"_ (`desktop/src-tauri/src/commands/agents.rs:709-710`), and agent spawn actively scrubs `BUZZ_ACP_API_TOKEN` and `BUZZ_API_TOKEN` from the child environment (`desktop/src-tauri/src/managed_agents/runtime.rs:782-784`). Buzz _has_ an `api_tokens` table; nothing in the relay consumes it (§2.8).

**The framing this research was commissioned under is half wrong, and the wrong half is the useful part.** Buzz does not make users manage keys either. The desktop app generates the human's keypair on first run (`desktop/src-tauri/src/app_state.rs:178-190`), generates each agent's keypair in the Tauri backend (`desktop/src-tauri/src/commands/agents.rs:676-684`), and stores all of them in the OS keyring — _"This covers both the human identity key and every managed-agent key"_ (`SECURITY.md:76-81`). The one deviation: after creating an agent, a modal shows the agent's nsec once, captioned _"Save the private key now… this secret is only revealed here"_ (`desktop/src/features/agents/ui/SecretRevealDialog.tsx:31-58`). Copying it is optional — the app already holds it and injects it into the agent subprocess itself. So the real difference between Buzz and DorkOS is **custody and recovery**, not keys-versus-no-keys.

**Recommendation, stated up front.** Answer `specs/invites/` open question #8 as **no member API keys in v1**, and remove that bullet from §3.2. Not because members are untrusted — because the credential serves no beat the MVP has. Under community-server D2 the adapter is server-side, so an invited member's agents authenticate to **her own** DorkOS server and never to the community; under Track B (two humans, one install) §3.2 already forbids her from creating or adding an agent, so she has none on that machine. A Better Auth API key is a standing bearer credential replaying her full role (`session-gate.ts:106-132`) with no room scoping — the one thing in §3.2 the room model does not bound. Defer it. The agent-credential question has a real answer, and it is `agentIdentityTokens`, not a member key (§6).

---

## 1. The question, and why it is being asked now

Two live specs collide on one undecided point. `specs/invites/02-specification.md` §3.2 currently lets an invited `member` _"create, name, and revoke API keys owned by her"_, and §17 flags that as open question #8 — listed as allowed only because community-server §4's fifth MVP beat is _"she brings her agents"_ (`specs/invites/02-specification.md:303, 773`). Meanwhile `specs/community-server/01-ideation.md` §7 open question 4 — _"how does an agent authenticate to a remote community?"_ — is undecided and points at Buzz's NIP-OA as the prior art to read first (`:187`). Both questions are one question: **does an agent need a credential of its own, separate from the human who owns it, and does that credential have to be visible to the human?** D3 has already committed us to _"zero user-facing keys, in every path"_ (`:92`), so if the second half is yes, D3 has to bend. This document exists to find out whether it does.

---

## 2. How Buzz does it

### 2.1 The shape, in one paragraph

Every principal — human, agent, workflow, relay — is a secp256k1 keypair. `buzz-auth` supports exactly two auth methods, NIP-42 over WebSocket (kind:22242) and NIP-98 over HTTP (kind:27235), both pure Schnorr verification with _"No JWT validation, no token management, no IdP runtime dependency"_ (`crates/buzz-auth/src/lib.rs:3-16, 54-60, 97-98`). An agent is therefore a _second_ keypair, not a mode of the first. What connects the two is one signed tag.

### 2.2 The credential: a NIP-OA `auth` tag

Exactly four elements (`docs/nips/NIP-OA.md:31-41`):

```json
["auth", "<owner-pubkey-hex>", "<conditions>", "<sig-hex>"]
```

Preimage is `nostr:agent-auth:` ‖ `agent_pubkey_hex` ‖ `:` ‖ `<conditions>`, SHA-256'd and signed BIP-340 by the **owner's** secret key (`docs/nips/NIP-OA.md:43-46`; `crates/buzz-sdk/src/nip_oa.rs:109-111`, `:160-165`). `<conditions>` is an `&`-joined clause list drawn from `kind=<n>`, `created_at<t`, `created_at>t`, validated at `crates/buzz-sdk/src/nip_oa.rs:36-105`.

Three properties are load-bearing and all three are enforced in code:

- **Self-attestation is rejected** — `<owner-pubkey-hex>` may not equal the agent pubkey (`docs/nips/NIP-OA.md:66`; `crates/buzz-sdk/src/nip_oa.rs:151-156`). An agent cannot bootstrap itself.
- **Two tags mean zero tags** — fail-closed, with the reasoning in its own test: _"a second forged tag cannot smuggle an alternate delegation past the gate"_ (`crates/buzz-relay/src/handlers/auth.rs:26-36, 337-349`).
- **The conditions string is signed verbatim** — no reordering, deduping, normalizing or canonicalizing before hashing (`docs/nips/NIP-OA.md:70-71`).

**In the shipping product the conditions string is empty.** The desktop app calls `compute_auth_tag(&compat_owner, &compat_agent, "")` (`desktop/src-tauri/src/commands/agents.rs:711-721`). So every real Buzz attestation is unconditional and never expires. Hold that thought for §4.4.

### 2.3 How the relay consumes it (NIP-AA)

NIP-AA is the relay half: _"An agent whose owner is a relay member MAY gain implicit relay access — without being explicitly enrolled in the member list — by presenting a NIP-OA `auth` tag during NIP-42 authentication."_ (`docs/nips/NIP-AA.md:13`). Its six-step algorithm is at `docs/nips/NIP-AA.md:71-115`. In code:

1. The tag is pulled from the signed AUTH event **before** verification consumes it, _"integrity-protected by the event's Schnorr signature — if tampered, NIP-42 verification will fail before we ever inspect it"_ (`crates/buzz-relay/src/handlers/auth.rs:75-78`).
2. NIP-42 runs first, crypto only (`auth.rs:86-90`).
3. The ban gate runs, and it cascades — §4.3.
4. Membership is enforced by `enforce_relay_membership`, which falls back to the NIP-OA owner: verify the tag, resolve the owner, ask whether the **owner** is a relay member, return `MembershipDecision::ViaOwner(owner)` (`crates/buzz-relay/src/api/mod.rs:81-101`, called from `auth.rs:217-238`).
5. The relationship is persisted first-write-wins by `materialize_nip_oa_owner` (`crates/buzz-relay/src/api/mod.rs:169-232`) into `users.agent_owner_pubkey`, a community-scoped FK column (`migrations/0001_initial_schema.sql:168-174`). The write is a conditional UPDATE guarded on `agent_owner_pubkey IS NULL` — _"this makes 'first mint wins' atomic — no TOCTOU race between concurrent mints"_ (`crates/buzz-db/src/user.rs:291-325`).
6. The owner is stashed on the connection's auth context (`auth.rs:257-275`).

**Two config flags gate this, and the code defaults disagree with every shipped deployment.** `require_relay_membership` and `allow_nip_oa_auth` both default `false`, asserted by the config's own tests (`crates/buzz-relay/src/config.rs:483-485, 520, 954-955, 966-967`). But `deploy/compose/.env.example:14-18` sets both `true` under _"Production defaults"_; the Helm chart ships `requireRelayMembership: true`, `allowNipOaAuth: true` (`deploy/charts/buzz/values.yaml:109, 114`) with a comment calling the first _"the production default"_ (`values.yaml:80`); and even the local mesh-dev recipe turns both on (`Justfile:318-319`).

So the honest statement: **the bare library default is an open relay where NIP-OA is unnecessary; every deployment path Buzz publishes is a closed relay where NIP-OA is the agent's admission mechanism.** This corrects an emphasis in the prior spike, which reported the code defaults without the deployment configs.

On an open relay the owner is still extracted, unconditionally — _"No feature flag needed: NIP-OA is cryptographically self-proving"_ (`auth.rs:240-253`) — because other subsystems (observer frames, deletion authority, channel-add policy, git push) read the binding. **The owner relationship is recorded as a fact about identity, separately from whether it currently grants admission.** That separation is worth stealing.

### 2.4 "Virtual membership"

Step 6 of NIP-AA grants access **without** a persistent membership record, retaining the owner in session state _"to support owner-scoped session enumeration, termination, and quota aggregation"_ (`docs/nips/NIP-AA.md:113`), re-derived per connection (`:145`). **[NIP-only]** for the term; the code's equivalent is that `check_relay_membership` runs per AUTH and writes no `relay_members` row for the agent (`crates/buzz-relay/src/api/mod.rs:61-111`). The owner _is_ retained on the auth context (`crates/buzz-auth/src/lib.rs:79`, set at `auth.rs:266`) — but none of the three uses that retention was for are built (§4.3, §4.7).

### 2.5 What the human actually does

This is where "does she need a separate credential" gets its real answer: **she needs one, and she does not manage it.**

**The flow.** From a channel, "Add agents" (`desktop/src/features/channels/ui/AddChannelBotDialog.tsx:210, 236`) or from the Agents screen (`desktop/src/features/agents/ui/AgentsView.tsx:139-140`). Creating one asks for an avatar, an **Agent name** (placeholder `"Fizz"`), **Agent instructions** (_"Describe what this agent should do."_), a runtime picker and an optional model (`desktop/src/features/agents/ui/AgentDefinitionDialog.tsx:783, 800, 810, 822`). Submit → `createManagedAgent` → the agent is added to the channel with `role: "bot"` and started (`desktop/src/features/agents/channelAgents.ts:114-118, 132-153, 354, 396`). No key, token, or URL is requested at any point.

**Behind that button, in the Tauri backend:**

1. `let keys = Keys::generate();` — the agent's keypair (`desktop/src-tauri/src/commands/agents.rs:676-677`). This is the only non-test mint site. There is **no import path** for an agent key.
2. The nsec is bech32-encoded (`:681-684`), persisted on the record (`:881`), then pushed into the OS keyring with the inline JSON copy blanked on success (`desktop/src-tauri/src/managed_agents/storage.rs:348-353`). If the key cannot be read back, spawn is **refused rather than run keyless** (`storage.rs:199-207`).
3. The owner attestation is signed **in the same process, with the logged-in human's secret**, obtained from `AppState::signing_keys()` (`desktop/src-tauri/src/commands/agents.rs:711-721`; `app_state.rs:302-317`). The relay never mints — every non-test `compute_auth_tag` call in `crates/buzz-relay/` is inside `mod tests`.
4. The tag is published inside the agent's `kind:0`, signed by the _agent's_ key, and sent with an `x-auth-tag` header (`desktop/src-tauri/src/relay.rs:440-479`).
5. The tag is persisted on the record but **deliberately excluded from the published `kind:30177` projection** — the module doc lists `auth_tag` alongside `private_key_nsec` and `env_vars` as MUST-NEVER-publish (`desktop/src-tauri/src/managed_agents/agent_events.rs:10-24`).
6. `buzz-acp` is spawned as a local subprocess (`desktop/src-tauri/src/managed_agents/runtime.rs:894-899`; default command `"buzz-acp"`, `types.rs:775`) with `BUZZ_PRIVATE_KEY`, `BUZZ_RELAY_URL` and `BUZZ_AUTH_TAG` in its environment (`runtime.rs:577-578, 786`) — matching `AGENTS.md:161-166`.

**The one place a key is shown.** After creation a modal titled **"Agent created"** displays the nsec with _"Save the private key now. The app can keep running the harness locally, but this secret is only revealed here."_ and a "Copy key" button (`desktop/src/features/agents/ui/SecretRevealDialog.tsx:31-58`). The only required action is clicking **Done**. **This is a backup affordance, not a step.** It is the single deviation from "the user never handles a key", and it is the deviation D3 exists to refuse.

**The human's own key is also app-generated** (`desktop/src-tauri/src/app_state.rs:178-190`), with a real loss state: `identity_lost` is set when the keyring is empty and no fallback exists, and _"the frontend checks this flag via `get_identity` and routes to the nsec re-import step"_ (`app_state.rs:76-87`; `models.rs:11`). A `get_nsec` command exists (`desktop/src-tauri/src/lib.rs:680`) — which is the only thing that makes re-import possible. Buzz's own vision doc costs this out: _"Losing your private key means losing your identity. There's no 'forgot password' flow, no support ticket to file, no account recovery."_ (`VISION_SOVEREIGN.md:216-220`.)

**Remote agents are a real, and honest, exception.** Deploying an agent to a discovered provider ships the agent's secret and attestation in the payload — `"private_key_nsec"`, `"auth_tag"` (`desktop/src-tauri/src/commands/agents_deploy.rs:119-120`) — and the UI says so: _"This provider … will receive your agent's private key. Only use providers from trusted sources."_ (`desktop/src/features/agents/ui/WhereToRunSection.tsx:99-104`.)

### 2.6 Getting the agent into a room

Connecting to the community and joining a channel are separate acts, and the second has two rules DorkOS should notice.

- **The agent publishes its own profile** — kind:10100, _"Agent metadata + owner reference (replaceable, agent-authored)"_ (`crates/buzz-core/src/kind.rs:86-87`). Its handler reads one field, `channel_add_policy` (`crates/buzz-relay/src/handlers/side_effects.rs:1115-1147`). Enum `('anyone','owner_only','nobody')`, default `anyone` (`migrations/0001_initial_schema.sql:37, 169`).
- **Adding a principal is kind:9000**, authorized as _"open channels allow any authenticated user; private channels require the actor to be an existing member (**any role can invite**)"_ (`side_effects.rs:313-318`). Only _elevated_ roles require an elevated granter (`:320-328`).
- **Self-add is unconditional; third-party add checks the target's policy**, and `owner_only` is enforced against the NIP-OA-proven owner:

```rust
// Self-add: always allowed regardless of policy.
if target_pubkey == actor_bytes { return Ok(()); }
// Third-party add: check channel_add_policy on the target.
… "owner_only" => { … if actor_bytes != owner_bytes {
        return Err(anyhow::anyhow!(
            "policy:owner_only — only the agent owner can add this agent")); } }
   "nobody" => { return Err(anyhow::anyhow!(
        "policy:nobody — this agent has disabled external channel additions")); }
```

(`side_effects.rs:366-398`.)

**Two transferable findings.** First: **a plain member of a private channel can add an agent without an admin.** `MemberRole::Bot` is not elevated (`crates/buzz-core/src/channel.rs:134-136`), so no elevated-grant guard fires. Second: **the agent's own declared policy, not the adder's role, is what prevents conscription** — and it defaults to `anyone`, so out of the box any channel member can put any agent in any room they share.

### 2.7 Community invites, for contrast

Invites admit a _human_ to the community, not an agent to a channel. `POST /api/invites` requires owner or admin (`crates/buzz-relay/src/api/invites.rs:230-245`); `/api/invites/claim` is _"deliberately exempt from the relay-membership gate: the whole point is that the caller is not a member yet. NIP-98 proves control of the joining pubkey; the HMAC on the code proves an admin authorized the join."_ (`invites.rs:1-13`.) The token is a stateless HMAC blob, role-capped at `member` at both mint and verify (`crates/buzz-relay/src/invite_token.rs:33-38`), multi-use until expiry (72h default, 30d max, `:29-31, 52-56`), with coarse revocation: _"rotate the relay keypair, or remove the member after the fact"_ (`:37-38`). **Nothing in the invite path mentions agents. An invited member's agents ride in on §2.3, not on the invite.**

### 2.8 The API-token dead end

Buzz has an `api_tokens` table with scopes, per-channel restriction, expiry, a 10-token-per-owner atomic limit, revocation and last-used tracking (`crates/buzz-db/src/api_token.rs:9-80`; `migrations/0001_initial_schema.sql:472-491`). `NOSTR.md:88-91` and `:335` both assert _"Users with valid API tokens bypass the allowlist."_

**No code consumes them.** Every caller of `get_api_token_by_hash`, `create_api_token`, `list_tokens_by_owner`, `revoke_token` and `revoke_all_tokens` outside `crates/buzz-db/` is a doc-comment in a conformance test. No route mints one (`crates/buzz-relay/src/router.rs:63-125`). WS auth is _"Pure crypto verification — no API tokens, no JWT, no DB token lookups"_ (`crates/buzz-relay/src/handlers/auth.rs:41`); HTTP auth accepts only `Authorization: Nostr <base64>` plus a dev-mode `X-Pubkey` header (`crates/buzz-relay/src/api/bridge.rs:79-127`). No `Bearer` handling exists anywhere in `crates/buzz-relay/src/`.

**And the refusal is deliberate on the agent path specifically.** `desktop/src-tauri/src/commands/agents.rs:709-710`: _"Agents authenticate via the auth tag in their kind:0 profile event. **No tokens are minted.**"_ Spawn removes any inherited token vars: `command.env_remove("BUZZ_ACP_API_TOKEN"); command.env_remove("BUZZ_API_TOKEN");` (`runtime.rs:782-784`).

So _"does Buzz use API keys for agents?"_ → **there is a table for them, a doc that claims they work, an explicit code comment saying agents do not use them, and no auth path that honours one.** With a depth-1 clone I cannot prove removal versus never-wired; the residual `require_auth_token` flag now gates only a dev header, which _reads_ like a remnant, but that is inference.

### 2.9 The agent cannot create an agent

Worth its own line because it is the cleanest expression of the trust boundary. `buzz-cli` has no agent-create command — the subcommands are `draft-create`, `draft-update`, `archive`, `unarchive`, `archived` (`crates/buzz-cli/src/lib.rs:259-345`). `draft-create` mints **no key and no attestation**; it publishes an encrypted request to the owner's desktop and returns:

```rust
obj.insert("saved".into(), false.into());
obj.insert("message".into(),
    "Draft sent to Buzz Desktop for owner review. Nothing changes until the owner saves it.".into());
```

(`crates/buzz-cli/src/commands/agents.rs:36-41`; owner identified from `BUZZ_AUTH_TAG` at `:20, 154-156`.) **Only the human's own app can bring a new principal into existence.**

---

## 3. Why they did it that way — their stated reasoning

### 3.1 The agent is a colleague, not a permission bit

The clearest statement is a _product_ argument, not a cryptographic one:

> **"Let an agent triage a bug without giving it the keys to the kingdom.** Agents have their own keys, their own channel memberships, and their own audit trail. Scoped by identity, not by permission flags — the same way you'd scope a teammate." (`README.md:47`)

> "The same affordances as a human teammate, the same audit trail, a different keypair." (`README.md:40`)

> "**Agents are members, not bots.** Add an agent to a channel the same way you add a person." (`README.md:60`)

And the security doc makes the mechanism follow from it:

> "Channel membership is the **only** access control mechanism. There are no separate ACL lists or capability taxonomies. If a principal (human or agent) is a member of a channel, they can read and write to it." (`SECURITY.md:57-61`)

That is the whole design in one sentence. **Because there is no capability taxonomy, scoping an agent must be done by giving it a distinct identity — there is no other lever.** The separate credential is a consequence of refusing to build a permission system, not an independent goal.

The code holds the line even where it is inconvenient. `MemberRole::Bot` has `permission_level() == 0` and _"Bot never meets any requirement"_ (`crates/buzz-core/src/channel.rs:142-157`), which would block git push — so the git policy layer promotes it back, with the comment: _"Bot is a designation (what it is), not a permission tier (what it can do)."_ (`crates/buzz-relay/src/api/git/policy.rs:380-386`.) **`Bot` is a label, not a privilege level.** (Its inertness has a side effect worth noting: because Bot is not elevated, granting it is unprivileged — §2.6.)

### 3.2 The synchronization hazard — the stated motivation for NIP-AA

> "NIP-43 defines relay membership metadata; relays that enforce membership restrict access to an explicit member list… an operator who adds a human member must also separately enroll every agent that human runs.
>
> This creates friction and a synchronization hazard. When a human's membership is revoked, their agents remain enrolled until manually removed. When a human spawns a new agent, it cannot connect until the operator adds it.
>
> NIP-AA closes this gap… If the owner's membership is later revoked, the agent's next connection attempt fails automatically — no separate cleanup required." (`docs/nips/NIP-AA.md:17-21`)

This is the argument DorkOS most needs, and it is **independent of cryptography.** It says: an agent's admission should be _derived_ from its human's and evaluated at connection time, not _copied_ into a durable row that must then be kept in sync. Any store can implement that. Buzz implements it with a signature because Buzz has no account table; the property being bought is "no orphaned agent rows", not "no server-side state".

### 3.3 Why not NIP-26 delegation — the deliberate refusal to let the agent be the human

> "NIP-26 defines a sound Schnorr-signature mechanism for proving that one key authorized another key subject to explicit conditions. **NIP-26 assigns the event to the delegator semantically, and that semantic MUST NOT be reused for agent provenance.** This NIP reuses NIP-26 as prior art for the credential format and signing flow and defines the credential as authorization evidence only… An event that includes a valid `auth` tag remains authored by `event.pubkey`." (`docs/nips/NIP-OA.md:13-17`)

> "This NIP does not define impersonation. This NIP does not define key derivation. This NIP does not define relay-side author rewriting." (`docs/nips/NIP-OA.md:19-23`)

> "Clients MUST treat the agent key in `event.pubkey` as the only author key for the event. Clients MUST NOT display the owner key as the author… MUST NOT merge the event into owner-authored timelines, author indexes, or pubkey-filtered results for the owner… any such display MUST be clearly distinguished from authorship (for example, 'authorized by \<owner\>')." (`docs/nips/NIP-OA.md:86-89`)

**This is the most portable principle in the design, and it costs nothing to adopt.** An agent acting on your behalf must never be rendered, indexed, or attributed as you. The moment it is, every audit trail and every "who said that" question is corrupted.

### 3.4 Independent keys, so a compromised agent is not a compromised human

> "The owner key and the agent key are independent keys. Compromise of the agent secret key MUST NOT imply compromise of the owner secret key. Compromise of the agent secret key permits only signatures by the compromised agent key." (`docs/nips/NIP-OA.md:95-97`)

This is why the agent does not reuse the human's key, stated plainly. It generalizes: **a credential that authenticates as the human is compromise-equivalent to the human**, whether it is a secret key, a session cookie, or a bearer API key.

### 3.5 Reputation — the weakest and least transferable argument

> "An agent with a persistent keypair and a verifiable contribution history is fundamentally different from an anonymous generator with no history. The agent has skin in the game. Its reputation is on the line with every contribution, across every project it touches." (`VISION_SOVEREIGN.md:186-191`)

This depends on a global, portable, cross-community identity — exactly what a DorkOS per-community opaque member id refuses by design (D3). Treat it as Nostr-native colour, not a requirement. Note Buzz doubles down on it operationally: agents are deliberately not pinned to a community, and the per-record relay pin is _ignored_ — _"agents-everywhere, #2122: every agent is eligible on every community"_ (`desktop/src-tauri/src/relay.rs:56-71`).

### 3.6 What they admit it costs

> "Key management is harder than 'sign in with Google.' Losing your private key means losing your identity. There's no 'forgot password' flow, no support ticket to file, no account recovery… The same property that makes your identity uncensorable makes it unrecoverable if you lose the key."
>
> "Most developers don't have a nostr keypair. Onboarding friction is real… You'll lose some people at the door who would have clicked 'sign in with GitHub' without thinking." (`VISION_SOVEREIGN.md:216-232`)

Block wrote down, in their own repository, the exact reason D3 exists.

---

## 4. The security model

### 4.1 What the agent can do that its owner cannot: almost nothing, by design

NIP-AA is categorical:

> "Channel-level, group-level, quota, and role checks MUST continue to evaluate the agent's own pubkey… **NIP-AA does not grant the agent the owner's channel memberships, group roles, or administrative privileges.**" (`docs/nips/NIP-AA.md:131`)
>
> "Virtual members MUST NOT be granted relay administration privileges… MUST NOT be permitted to modify relay membership." (`:137-139`)
>
> "When multiple pubkeys are authenticated on a single connection, the relay MUST NOT combine their privileges; each pubkey's access is evaluated independently." (`:133`)

**Implemented, though partly by construction rather than by an explicit virtual-member check.** Relay-admin kinds 9030–9033 resolve `sender_role` from the sender's own `relay_members` row (`crates/buzz-relay/src/handlers/relay_admin.rs:133-147`); a virtual member has no such row, so the role resolves empty and the command is refused. Moderation authority works the same way (`crates/buzz-relay/src/handlers/moderation_authz.rs:96-100`). Channel writes go through `is_member_cached` on the **authoring** pubkey (`crates/buzz-relay/src/handlers/ingest.rs:1802-1813`), so **an agent cannot post to a channel its owner is in unless the agent is itself a member.**

Three things only an agent can do, and they are narrow:

1. **Author kind:44200 turn metrics.** Requires `is_agent_owner(event.pubkey, p_tag)` — the author must be a registered agent `p`-tagging its own registered owner (`crates/buzz-relay/src/handlers/ingest.rs:2007-2042`). A human with no owner binding can never publish this kind. Neatly, the agent **cannot read its own telemetry back** — the kind is result-gated to pubkeys appearing in a `p` tag (`crates/buzz-core/src/kind.rs:129`; `crates/buzz-core/src/filter.rs:23-33`), and the agent is the author, not the `p`.
2. **Be protected by `channel_add_policy`** (§2.6).
3. **Get double a human's message quota.** See §4.7 — this one is a bug, not a feature.

### 4.2 What the owner can do that the agent cannot: moderate the agent's output

The asymmetry runs the other way for artifacts, and this part **is implemented**. Fourteen sites consult `is_agent_owner(target, actor)` — "is `actor` the registered owner of `target`". The authorization-relevant ones:

| Site                                | What it authorizes                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `handlers/ingest.rs:833`            | kind:40003 message **edit** — owner may edit their agent's message                                                       |
| `handlers/side_effects.rs:204, 224` | kind:5 NIP-09 **deletion** (a-tag and e-tag forms)                                                                       |
| `handlers/side_effects.rs:432`      | kind:9001 channel member removal — a non-elevated member may remove **their own** agent                                  |
| `handlers/side_effects.rs:558`      | kind:9002 EDIT_METADATA (name/about/archived/visibility/ttl)                                                             |
| `handlers/side_effects.rs:661, 682` | kind:9005 DELETE_EVENT, kind:9008 DELETE_GROUP                                                                           |
| `handlers/event.rs:1024`            | observer frame (kind 24200) authorization                                                                                |
| `api/git/policy.rs:333, 346-350`    | git push: _"A cryptographically verified managed-agent owner has the same repository authority as the agent key itself"_ |

`actor_owns_any_owner_agent` lets a human administer a channel their agent owns _even without being a member of it_ (`side_effects.rs:235-256`), reached via a deliberate membership-gate bypass for kinds 40003/9002/9005/9008 justified at `ingest.rs:1789-1801`: _"per-kind validators are the authority… Bypassing the generic member/open gate here lets the owning human act on private agent channels without being a member."_

The intent is encoded as an e2e contract: owner **can** edit, delete, rename, archive and delete-group on the agent's content, even in private channels they are not in; third parties **cannot**; and **no test and no code grants the agent any authority over its owner's content** (`crates/buzz-test-client/tests/e2e_human_edit_agent_content.rs:1-11, 100-142, 147-186, 640-788, 793-816`).

**The rule: capability does not flow downward from owner to agent, but authority over the agent's artifacts flows upward from agent to owner.** The human is answerable for what their agent did, so the human must be able to undo it. One sharp edge in their implementation: a non-member owner may _delete_ their agent's private channel but may not _remove a member_ from it — _"We intentionally do NOT check `is_agent_owner` for non-members — you must be in the channel to remove anyone, even your own bot."_ (`side_effects.rs:439-443` versus `:554-557, :673-676`.)

### 4.3 Ban, timeout, and removal — three different answers

**Ban cascades owner → agent, and only in that direction.**

> "NIP-OA cascade: a ban on the authenticated pubkey blocks it directly; a ban on its cryptographically-proven owner cascades to the agent (owner ban ⇒ agents banned; agent ban is agent-only). The owner is extracted from the self-proving auth tag with no DB round-trip." (`crates/buzz-relay/src/handlers/auth.rs:101-105`; implemented `:119-184`, fail-closed on DB error `:107-131`.)

Nothing anywhere maps agent → owner for authorization, so banning an agent affects only that pubkey.

**Three gaps, all real, all in code:**

1. **Timeout does not cascade at all.** _"Timeout has no auth-seam presence (it is write-block-only), so an owner-timeout does not cascade to the owner's agents — a deliberate Phase-1 asymmetry."_ (`crates/buzz-relay/src/handlers/ingest.rs:1629-1638`.) Time a human out and their agents keep writing.
2. **The ban cascade does not run on the HTTP submit path.** `POST /events` does membership and NIP-OA materialization (`crates/buzz-relay/src/api/bridge.rs:797-824`) but the downstream write gate is author-only (`ingest.rs:1639`). An agent whose owner is banned can still submit over NIP-98.
3. **Banning does not close live agent sessions.** `handle_ban` disconnects only sockets bound to the banned pubkey (`crates/buzz-relay/src/handlers/moderation_commands.rs:195-200` → `state.rs:1018-1050`).

**Removal does essentially nothing.** Both removal paths — the kind:9031 admin command (`crates/buzz-relay/src/handlers/relay_admin.rs:223-279`) and the `buzz-admin remove-member` CLI (`crates/buzz-admin/src/main.rs:223-249`) — delete one `relay_members` row and republish the list. No session teardown, no channel-membership cleanup, **no agent enumeration**. There is no query anywhere of the form `WHERE agent_owner_pubkey = <owner>`: the only reads of the column are single-row point checks (`crates/buzz-db/src/user.rs:336, 361`) and `IS NULL` aggregate counts for usage metrics (`crates/buzz-db/src/usage.rs:47-48, 268-270`). The effect is purely prospective: on the agent's _next_ connection, `check_relay_membership` finds the owner is not a member and denies — **and only if the relay is closed.** On an open relay the check short-circuits (`crates/buzz-relay/src/api/mod.rs:118-120, 131`) and removal has no effect on the agent whatsoever.

NIP-AA prescribes the missing piece and it was not built: _"Operators who require immediate session termination MUST disconnect active WebSocket connections when revoking a member. The relay SHOULD expose a mechanism to enumerate and terminate sessions by owner pubkey."_ (`docs/nips/NIP-AA.md:147`) **[NIP-only]** — the owner _is_ retained in session state for exactly this, and nothing consumes it.

**The binding is permanently immutable.** `set_agent_owner` is a conditional UPDATE guarded on `IS NULL` (`crates/buzz-db/src/user.rs:291-325`); there is no rebind, no clear, no unset anywhere. Two subsystems depend on that immutability for correctness — the DB layer hoists the owner lookup outside a transaction _"because `agent_owner_pubkey` is immutable… so its value cannot change under us and needs no serialization"_ (`crates/buzz-db/src/channel.rs:550-555`), and the observer cache uses a 5-minute TTL on the same reasoning (`crates/buzz-relay/src/state.rs:603-607`). Adding a revoke path later means touching both.

**So the credential cannot be revoked by the owner alone.** NIP-AA says so:

> "An agent that possesses a valid `auth` tag can reconnect as long as the owner remains an active relay member… Revocation requires one of: (a) removing the owner from the relay's member list, (b) the `auth` tag's `created_at` conditions expiring, or (c) the relay applying an independent denylist. **NIP-OA credentials are reusable capabilities — the owner cannot unilaterally revoke a previously issued `auth` tag.**" (`docs/nips/NIP-AA.md:153`)

The desktop UI matches: "Delete agent" stops the process, deletes the record, removes the nsec from the keyring and files a NIP-IA archive request with reason `retired` (`desktop/src-tauri/src/commands/agents.rs:1317-1393`) — but **there is no UI that revokes the attestation.** Since (b) is unavailable in practice (§2.2: conditions are empty), and (c) is not built, the only real lever is (a).

### 4.4 The scope-expansion warning they wrote against themselves — and then realized

> "**Credential scope warning**: An `auth` tag presented during NIP-42 authentication grants connection-level access regardless of any `kind=` clauses… issuing any valid `auth` tag — even one with narrow `kind=` conditions — grants the agent **full relay-level read and write access** unless the relay implements optional per-event enforcement." (`docs/nips/NIP-AA.md:121`)
>
> "A credential issued for event-provenance purposes (e.g. `kind=1`) becomes a relay-login credential when used in NIP-AA; this semantic expansion is by design." (`:123`)

Plus a footgun: multiple `kind=` clauses are conjunctive, so `kind=1&kind=7` authorizes **nothing** (`:127`). And `created_at` is agent-controlled, so timestamp clauses bound authorization only in combination with the relay's ±120s AUTH freshness window (`:149-151`; `docs/nips/NIP-OA.md:100-102`).

**The shipping product resolves all of this by using no conditions at all** (`desktop/src-tauri/src/commands/agents.rs:711-721`). Every real Buzz attestation is an unconditional, non-expiring, full-access capability.

**This is the lesson DorkOS should take negatively.** A credential whose scope is baked into an unforgeable signature cannot be narrowed after issue, so the issuer is pushed toward issuing broad ones — and then the enforcement point has to re-derive scope per action anyway. DorkOS's `agentIdentityTokens.tierCeiling` on a mutable row (`packages/db/src/schema/agent-identity.ts:45-54`) does the same job and can be tightened without reissuing anything.

### 4.5 The privacy trade

> "Presenting an `auth` tag during NIP-42 authentication discloses the owner-agent relationship to the relay… an intentional disclosure — the relay needs this information to perform the membership check. Relays SHOULD NOT expose the owner-agent relationship to other relay members beyond what is necessary." (`docs/nips/NIP-AA.md:171-173`)
>
> "Including an `auth` tag intentionally links the owner key and the agent key. Verifiers MAY correlate all events that reuse the same owner key and agent key pair." (`docs/nips/NIP-OA.md:107-108`)

An agent may omit the tag to avoid the link, at the cost of the provenance claim (`NIP-OA.md:109`; `NIP-AA.md:175`).

### 4.6 What the owner gets to see

The owner-agent relation underwrites observability. NIP-AO defines kind:24200 observer frames — ephemeral, NIP-44-encrypted, _"strictly scoped to the agent↔owner relationship"_, for _"debugging, auditing, and control — without that telemetry being stored on any relay or visible to third parties"_ (`docs/nips/NIP-AO.md:9-33`). Implemented: the relay authorizes each frame against the connection's session owner or a cached `is_agent_owner` check, refusing with `"restricted: observer frame is not authorized for this agent owner"` (`crates/buzz-relay/src/handlers/event.rs:998-1050`), rate-limits agent→owner telemetry at 100/s and deliberately exempts owner→agent control frames (`:917-936, 1053-1058`). The desktop surfaces it as a live session transcript alongside raw process logs (`desktop/src/features/profile/ui/UserProfilePanelTabs.tsx:551, 618`; `desktop/src-tauri/src/commands/agent_logs.rs:11-14`).

### 4.7 Quota amplification — the one place the model is actively broken

NIP-AA warns: _"Relays SHOULD aggregate rate limits and quotas by owner pubkey across all virtual members derived from that owner. Without owner-scoped aggregation, a single member can mint many agent keys and multiply per-pubkey quotas."_ (`docs/nips/NIP-AA.md:135`.)

**Not implemented, and inverted.** Every quota key is `(community, acting pubkey)` with no owner term (`crates/buzz-auth/src/rate_limit.rs:201-207`; `crates/buzz-pubsub/src/rate_limiter.rs:100-110`). Worse, the connection reads `is_agent = ctx.agent_owner_pubkey.is_some()` and selects a _higher_ budget (`crates/buzz-relay/src/connection.rs:604-650`): defaults are **agent 120/min, human 60/min** (`crates/buzz-auth/src/rate_limit.rs:87-88, 96-97`). A human with N agents commands `60 + 120N` messages per minute on independent counters. The HTTP path is not tiered at all, leaving three `agent_*_per_min` config fields with no consumer (`crates/buzz-relay/src/api/bridge.rs:29`; `rate_limit.rs:100-107`).

**Directly relevant to DorkOS.** The same amplification exists for any design where one member can mint many agent principals, and `specs/invites/02-specification.md` §14.6 already names the analogous exposure: _"there is no per-member budget… The global cap is the only ceiling."_ Buzz is the worked example of what happens when per-principal quotas meet a principal a member can mint at will.

---

## 5. What survives translation

### 5.1 Principles that hold with no keys anywhere

| #   | Principle                                                                                                                   | Why it is not about cryptography                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **The agent is its own author. Never render, index, or attribute its output as its owner's.**                               | `docs/nips/NIP-OA.md:86-89` is a _client rendering_ rule. It needs an author id and the discipline not to collapse it. DorkOS already has the id (`packages/db/src/schema/rooms.ts:30-65`).                           |
| 2   | **Admission is derived from the owner and re-evaluated per connection, never copied into a row that must be kept in sync.** | The stated motivation (`docs/nips/NIP-AA.md:17-21`) is operational — orphaned enrolments. A join on a members table delivers it. Buzz's own removal path (§4.3) proves what happens when you rely on cleanup instead. |
| 3   | **Capability does not flow owner → agent. The agent is permissioned on its own identity.**                                  | `docs/nips/NIP-AA.md:131`; enforced by looking up the acting pubkey, not by any key property (`ingest.rs:1802-1813`).                                                                                                 |
| 4   | **Authority over artifacts flows agent → owner. The human can undo what their agent did.**                                  | An ordinary DB predicate, `is_agent_owner` (§4.2). Nothing crypto about it.                                                                                                                                           |
| 5   | **The agent gets a say in being conscripted.**                                                                              | `channel_add_policy ∈ {anyone, owner_only, nobody}` — a column and a match arm (`migrations/0001_initial_schema.sql:37`; `side_effects.rs:366-398`).                                                                  |
| 6   | **A separate identity is what makes least privilege possible when you refuse to build a permission system.**                | `SECURITY.md:57-61`. The deepest point, and entirely architecture-independent.                                                                                                                                        |
| 7   | **A credential that authenticates as the human is compromise-equivalent to the human.**                                     | `docs/nips/NIP-OA.md:95-97`. True of session cookies and bearer tokens exactly as of secret keys.                                                                                                                     |
| 8   | **Only the human's own app may bring a new agent principal into existence.**                                                | `crates/buzz-cli/src/commands/agents.rs:36-41` — the agent-facing CLI can only _request_. A pure authorization boundary.                                                                                              |

### 5.2 What is a Nostr artifact, not a considered choice

| #   | Buzz mechanism                                                                                                  | Why it is an artifact                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | **The attestation is a signature rather than a row.**                                                           | A Nostr relay has no account store to join against, so the credential must carry its own proof. The cost is stark: the owner **cannot revoke an issued tag** (`docs/nips/NIP-AA.md:153`), and Buzz compounded it by making the DB binding permanently immutable so it could be cached (`crates/buzz-db/src/channel.rs:550-555`; `state.rs:603-607`). DorkOS has Better Auth and SQLite. A **mutable** row is strictly better — but only if we keep it mutable. |
| B   | **The human holds a key at all.**                                                                               | Even Buzz hides it (`SECURITY.md:76-81`; `app_state.rs:178-190`), and their vision doc costs it out honestly (`VISION_SOVEREIGN.md:216-232`). The one visible key — the reveal modal (`SecretRevealDialog.tsx:31-58`) — is a backup affordance for a system with no password reset. **D3 survives untouched.**                                                                                                                                                 |
| C   | **`kind=`/`created_at` conditions inside the credential.**                                                      | Scope is baked into the signature because there is nowhere else to put it. The result: a warning that any tag grants full access (`NIP-AA.md:121`), a conjunction footgun (`:127`), a clock the constrained party controls (`:151`) — and a product that ships with the conditions field empty (`commands/agents.rs:711-721`). `tierCeiling` on a mutable row is the same idea without any of it.                                                              |
| D   | **"Virtual membership" — no persistent row for the agent.**                                                     | Exists so the relay need not garbage-collect rows for ephemeral principals. DorkOS agents are already first-class `roomMembers` rows with a `responseMode`; a real row is better, **provided principle 2 is honoured by checking the owner at read time rather than deleting rows on removal.**                                                                                                                                                                |
| E   | **Portable cross-community reputation** (`VISION_SOVEREIGN.md:186-196`; agents-everywhere at `relay.rs:56-71`). | Requires a global identity. D3 deliberately files a remote member under a per-community opaque id and accepts that one person is two rows in two communities (`specs/community-server/01-ideation.md:86-90`). Incompatible by choice, and the choice is right.                                                                                                                                                                                                 |
| F   | **Disclosing the owner-agent link to the relay** (`NIP-AA.md:171`).                                             | Trivially true when the server already stores the relationship; not a trade DorkOS has to make.                                                                                                                                                                                                                                                                                                                                                                |

### 5.3 The honest scorecard on D3

D3 says _"zero user-facing cryptographic keys… nothing to write down and nothing to lose."_ Nothing in §5.1 challenges it. Buzz needed a key because it has no server-side identity; DorkOS has one, and every property Buzz buys with the attestation is available to us as a foreign key plus a predicate. The community-server amendment already reached the right conclusion for the relay case — _"The Nostr keypair is infrastructure, not identity"_ (`specs/community-server/01-ideation.md:119`) — and the same sentence covers the agent case.

**The one thing D3 does not answer, and this document cannot dodge:** an agent process is not a browser and cannot hold a session cookie. Something must be handed to it. DorkOS already decided what: a minted, hashed, expiring, revocable token delivered through the process env (`agent-token-env.ts:21-64`). That is not a _user-facing_ key — the user never sees, types, saves or loses it — so D3 is satisfied. §6 answers only whether that token should become an _authorization_ credential, and when.

---

## 6. Options for DorkOS

### 6.0 What DorkOS already has

Three facts, two of them easy to miss:

1. **A per-agent identity token already exists and ships.** `agentIdentityTokens` stores a SHA-256 digest keyed on `agentPath`, with a `tierCeiling`, idle and absolute expiry, and per-`agentPath` revocation (`packages/db/src/schema/agent-identity.ts:33-76`). Minted per spawn and injected as `DORKOS_AGENT_TOKEN` (`apps/server/src/services/core/agent-identity/agent-token-env.ts:21-64`), presented as `X-DorkOS-Agent` (`apps/server/src/middleware/agent-identity.ts:31`), resolved by middleware that **never rejects a request**: _"identity is attribution, not authorization"_ (`agent-identity.ts:12-20`).
2. **DorkOS has already decided the agent credential must not widen anything.** ADR `260725-133220`: _"Hiding does not help: dropping a credential can never widen what a caller may do, which is the only property that makes the gate worth having."_ Identity contributes exactly one thing to enforcement — a ceiling that can only narrow.
3. **The only remote transport credential DorkOS has today is a per-user API key that replays the user's full role.** `verifyRequestAuth` accepts a `Bearer` key and returns `{ userId, credential: 'api-key' }` (`apps/server/src/services/core/auth/session-gate.ts:106-132`); the CLI reads it from `DORKOS_API_KEY` or a key file (`packages/cli/src/lib/api-client.ts:15, 33, 153-184`).

Fact 3 is the whole problem. Facts 1 and 2 are most of the solution.

### 6.1 Does an invited member need a credential distinct from her session to attach an agent?

**Distinct from her session: yes, eventually — an agent process cannot hold a browser session. Distinct from her _login_, i.e. something she creates and manages: no, and not in v1.** Buzz agrees on both halves: the agent has its own credential, and the human neither mints it nor is required to keep it.

But the more important finding is that **in v1 the question does not arise**:

- **Track A (community-server).** D2 puts the `CommunityAdapter` on the server, justified in part by _"Keys never touch the browser… On the local server that is a `0600` file"_ (`specs/community-server/01-ideation.md:78`). Priya's agents talk to **her own** DorkOS install; her install talks to the community. Her agents never authenticate to the community, so they need no community credential at all. On her own install she is the owner, so she needs no member key either.
- **Track B (two humans, one install).** §3.2 already forbids a member from creating an agent, adding one to a room, or changing a response mode (`specs/invites/02-specification.md:308-312`). She has no agents on that machine. A member API key would let her drive the rooms API from a script — a _different, unstated_ feature, not "she brings her agents".

So the bullet at `:303` answers a beat neither track routes through it.

### 6.2 The four options

**Option 1 — Ship member API keys as §3.2 currently allows.**
Cheap: the `apiKey()` plugin already mints per-user keys (`apps/server/src/services/core/auth/index.ts:137`) and `roleGate` caps them at `member`.
Against: the spec's own admission that _"scoping a member's key to her rooms is not enforced by anything in this spec beyond `roleGate`"_ (`:773`). A key is a standing bearer credential with its owner's full authority, no expiry, no room binding, no per-key audit distinction — the exact "credential issued for one purpose becomes a login credential" expansion NIP-AA warns about (`docs/nips/NIP-AA.md:123`). And if the intended use is "her agent uses her key", it violates §5.1 principles 1, 3 and 7 at once: the agent authenticates as her, is permissioned as her, and compromising it compromises her.

**Option 2 — Defer member API keys entirely from v1.** ✅ **Recommended.**
Remove the bullet at `:303`; drop the per-user API-key endpoints from the §3.3 allow-list (they stay owner-reachable, unchanged); add one line to §3.2's "may not" list and one sentence to §17 recording _why_ — the MVP beat routes through D2's server-side adapter, not a member credential. Cost: nothing the MVP needs. Benefit: the default-deny allow-list gets shorter, and no standing credential is created before there is a use for it.

**Option 3 — The local server holds the community session; the agent never authenticates to the community.**
Not really an alternative — it is what D2 already specifies, and §6.1 is why it makes Option 2 safe. Worth naming so the decision reads as "D2 already answered this", not "we forgot".

**Option 4 — Promote `agentIdentityTokens` into an agent admission credential with an owner reference.** _(the v2 shape, not v1)_
When posting to a remote community lands, the agent's token gains an owner (`ownerUserId` beside `agentPath`) and the community admits the agent because its owner is a member, re-checked per connection. This is NIP-AA with a join instead of a signature, and it inherits §5.1 principles 1–8 without a key. Four things must be resolved when it is specced, and Buzz supplies the evidence for each:

- **The token becomes authorization, which ADR `260725-133220` currently forbids** (_"identity is attribution, not authorization"_). The resolution is that the two roles differ: as an _admission_ credential to a remote community it decides whether the connection happens; as a _capability_ credential inside the local install it still only narrows. Presenting it must never widen anything locally. Say this explicitly or the ADR reads as violated.
- **Revocation must be a read-time join, not a delete.** §5.1 principle 2. Buzz's removal path is the counter-example: no enumeration, no cleanup, no effect on an open relay (§4.3).
- **The owner binding must stay mutable.** Buzz froze theirs to enable caching and thereby lost the ability to rebind or revoke (`crates/buzz-db/src/user.rs:291-325`; `channel.rs:550-555`). Cache the lookup, not the immutability.
- **Quota must aggregate by owner from day one.** §4.7 and `specs/invites/` §14.6 describe the same hole; Buzz shows it becoming an amplifier rather than merely a gap.

### 6.3 Recommendation

1. **Answer open question #8: no member API keys in v1.** Option 2. The strongest argument is not risk — it is that the feature does not serve the beat it was listed for.
2. **Record the reason in the spec**, not just the decision, or the bullet returns the first time someone re-reads beat 5.
3. **Do not add an owner column to `agentIdentityTokens` yet.** It would be unread, and AGENTS.md forbids half-migrations. Name it as task one of the agent-attachment spec.
4. **Adopt two rules now, in the room model, because they are cheap and hard to retrofit:**
   - _An agent's output is never attributed to its owner._ No owner-authored view may absorb it; if the UI ever shows the relationship it reads "run by Dorian", never renders as Dorian (`docs/nips/NIP-OA.md:86-89`). `authors.kind` already keeps them separate; the rule governs what we may do with that later.
   - _Authority over an agent's artifacts flows to its owner_ (`side_effects.rs:220-229`). DorkOS has no owner concept on agents yet, so this is a note for the same future spec.
5. **Take two design cues when agents become remote members:** the agent, not the adder, decides who may put it in a room (`side_effects.rs:366-398`) — the natural companion to `roomMembers.responseMode`; and **only a human's own install may mint an agent principal** (`crates/buzz-cli/src/commands/agents.rs:36-41`), which DorkOS gets for free today and should keep.
6. **Refuse the mechanism, keep the motivation.** Do not build an attestation signature. Buzz's own spec and shipping product document why a signed capability is worse than a mutable row: the owner cannot revoke it, the scope cannot be narrowed after issue, the expiry clock is controlled by the party being constrained — and the product ships with the scope field empty (`docs/nips/NIP-AA.md:121-127, 149-153`; `desktop/src-tauri/src/commands/agents.rs:711-721`).

---

## 7. What I could not determine

1. **Whether Buzz's `api_tokens` path was removed or never wired.** The clone is `--depth 1`, so there is no history. I can prove no code consumes a token in this checkout and that agents deliberately do not use one (`commands/agents.rs:709-710`); I cannot prove intent about the table itself. `NOSTR.md:88-91`'s claim that token holders bypass the allowlist is unsupported by code either way.
2. **Whether per-event `kind=` enforcement exists.** NIP-AA makes it optional (`docs/nips/NIP-AA.md:125`). Not traced — and moot in practice, since shipping attestations carry no conditions.
3. **Whether the desktop ever adds an agent to the relay-member roster.** I found the NIP-OA auto-admission path (`crates/buzz-relay/src/api/mod.rs:81-105`) and the `buzz-admin add-member` CLI, but no desktop code that enrols an agent directly. On a closed relay this implies agents are admitted purely via owner membership + attestation, which is consistent with NIP-AA but was not traced end-to-end on the WebSocket path.
4. **Whether `x-auth-tag` is honoured on `POST /events`.** The header is sent (`desktop/src-tauri/src/relay.rs:462-464`) and `check_relay_membership` accepts one, but that route's handler was not traced to its `enforce_relay_membership` call. Relevant because §4.3 gap 2 (no owner ban cascade on HTTP) depends on it.
5. **What Buzz's hosted deployments actually run.** The two hosted relays are Block-internal (`Justfile:519, 546`), so `deploy/` is the best available evidence of production posture, not proof of it.
6. **Whether the `Guest` role's "read-only" contract is enforced anywhere outside git.** `crates/buzz-core/src/channel.rs:115-116` documents it as read-only, but channel writes check membership presence only (`crates/buzz-relay/src/state.rs:827-842`). This looks like an unenforced contract rather than a subtlety I missed, but I did not exhaust the ingest path.

**Resolved during this review** (previously listed as unknown): removal does not terminate agent sessions or enumerate agents (§4.3); owner-scoped quota aggregation is not implemented and is inverted (§4.7); there is no community-owned agent concept — every agent record is owner-authored under the owner's pubkey (`desktop/src-tauri/src/commands/agents.rs:36-42`), `admin-web/src` has no agent surface, and the relay never spawns one.

---

## Sources

- Buzz source, `github.com/block/buzz` @ `654f384906b5c720a60a199d85031a6f1cb6efc9` (2026-07-27), Apache-2.0, shallow clone. All `crates/…`, `desktop/…`, `docs/nips/…`, `deploy/…`, `migrations/…`, `Justfile`, `README.md`, `AGENTS.md`, `SECURITY.md`, `NOSTR.md`, `VISION*.md` citations resolve against that commit.
- DorkOS: `packages/db/src/schema/agent-identity.ts`, `packages/db/src/schema/auth.ts`, `packages/db/src/schema/rooms.ts`, `apps/server/src/services/core/agent-identity/`, `apps/server/src/middleware/agent-identity.ts`, `apps/server/src/services/core/auth/`, `apps/server/src/routes/room-caller.ts`, `packages/cli/src/lib/api-client.ts`.
- DorkOS specs: `specs/invites/02-specification.md` (§3.2, §3.3, §14.6, §17 Q8), `specs/community-server/01-ideation.md` (D2, D3, §7 Q4), `specs/agent-trust/` (§3.1, §3.2).
- DorkOS decisions: ADR `260725-133220` (tier decides the gate; identity only caps it), ADR `260726-022250` (agent tokens expire on two clocks), ADR `260726-170126` (author identity keyed on the agents directory), ADR-0105 (header as agent identity surface), ADR-0320 (optional-by-default local login).
- Prior research: `research/20260727_buzz-protocol-capability-spike.md`, `research/20260724_multi-user-communities.md`.
