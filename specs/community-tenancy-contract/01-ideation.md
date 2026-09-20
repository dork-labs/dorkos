---
slug: community-tenancy-contract
number: 260920-192428
created: 2026-09-20
status: ideation
linear-issue: DOR-2171
project: Multi-Community Hosting
---

# Community tenant identity, authorization, and migration

## Brief

Let one independent Community host serve more than one community while preserving the complete standalone experience. An account belongs to the host; a membership belongs to one community. Every authorization decision must name the immutable community being accessed, and an existing single-community deployment must upgrade without changing its community, member, channel, entry, or file identities.

## Evidence from the current implementation

The schema is already partly tenant-shaped: communities, members, channels, agents, handles, and audit events carry `community_id`, and the room data path checks it in many channel operations. The remaining singleton assumptions are concentrated at the edges:

- `communities.singleton` is both `UNIQUE` and constrained to `true`.
- `members.user_id` is globally unique, so a host account can have only one membership.
- browser authentication resolves a member with `WHERE user_id = ?`, without a community selector.
- `/api/v1/community` selects the first community, and all browser routes are unqualified.
- bootstrap grants and the owner-exists check are host-wide rather than community-scoped.
- invitation redemption locks a membership by user alone, preventing a second membership.
- pairing requests start without a community and can be viewed or approved by any signed-in member selected by the singleton resolver.
- removing one membership deletes every Better Auth session for the host account, even if other memberships remain.
- offline password recovery chooses the first active membership and revokes only that membership's grants and agents while changing a host-wide credential.
- relational tables often infer tenancy through one foreign key. Several joins do not prove that a channel, member, agent, invite, entry, cursor, attachment, or export belongs to the same community.
- `entries.mentions` and `export_archives.channel_ids` store tenant-owned references in UUID arrays, which composite foreign keys cannot validate element by element.
- rate-limit and cleanup jobs use host-global keys or unqualified candidate scans. These are safe only where the later mutation re-establishes tenant ownership.
- the local connection request accepts only an origin, its SSRF-safe parser rejects paths, and pairing discovers the singleton community before it starts. Two private communities at one origin therefore need a canonical community link that selects a UUID without public enumeration.
- the remote adapter is configured for one community per instance and calls unqualified `/api/v1/*` routes; discovery currently assumes one remote community per origin.
- browser state has no community chooser or active-community route context.

## Chosen direction

Use one PostgreSQL database with mandatory row scoping by immutable community UUID. Keep Better Auth accounts and sessions host-wide, and make `(community_id, user_id)` the membership identity. A signed-in account may hold several memberships, but a cookie proves only account authentication; each request must separately resolve and authorize the community membership.

Use `/c/:communityId` as the canonical browser boundary and `/api/v1/communities/:communityId/*` as the canonical tenant API boundary. The UUID is stable through renames and domain moves. The UI shows community names and a Slack-like switcher, so people rarely handle UUIDs directly. Existing unqualified routes remain a compatibility alias only when the host has exactly one community; once a second community exists they fail with an explicit selection response rather than guessing.

Model host operation separately from community ownership. A host operator can create, suspend, inspect metadata for, and recover communities, but receives no channel or message access without a membership in that community. Each active or suspended community has exactly one active owner membership; a newly created `pending_owner` community has none until its tenant-bound owner claim is redeemed. Standalone deployments bootstrap the first host operator and first community owner atomically, preserving today’s setup.

## Alternatives considered

### One database per community

This gives a strong physical boundary, but makes one host responsible for connection pools, migrations, backups, and provisioning across an unbounded set of databases. It also fights the existing schema, which is already mostly scoped by `community_id`. Keep database-per-host as an operator deployment choice; it is not the application tenancy model.

### Host-derived or name-derived tenant addresses

Subdomains and slugs are readable, but renames and domain moves would change identity or require aliases everywhere. Keep names as mutable display data and UUIDs as the authorization and routing key. A later vanity address may resolve to the UUID without replacing it.

### Put host authority on the owner membership

That would give a community role power over unrelated communities and make transfer or removal ambiguous. A separate host-operator relation keeps deployment administration outside community content authority.

## Risks to retire in the specification

- a confused-deputy request that supplies one community in the path and an object from another community;
- a session or pairing started before a community is selected;
- cross-community side effects during removal, password recovery, exports, cleanup, quotas, and credential revocation;
- migration that changes stable IDs or silently makes an old route choose the wrong community;
- a host operator reading community content through operational authority;
- a compatibility alias that remains active after a second community is created;
- a rollback that tries to collapse real multi-community data into the old singleton schema.

## Outcome

Freeze the contract in `02-specification.md`, record the lasting architecture in ADR `260920-192429`, then decompose the implementation without changing production behavior in this work item.
