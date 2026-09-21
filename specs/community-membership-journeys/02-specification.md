---
slug: community-membership-journeys
number: 260920-203200
created: 2026-09-20
status: specified
linear-issue: DOR-2179
project: Community Membership Journeys
---

# Community membership journey and handoff contract

**Status:** Approved

**Date:** 2026-09-20

## Overview

An independent Community host has one account system and one or more private communities. People enter through a host sign-in or a tenant-bound invitation, select only communities where they hold an active membership, and connect each DorkOS installation through a separate pairing approval. The product names each boundary directly and never treats host authority, membership, channel access, browser sessions, or installation grants as interchangeable.

This specification consumes DOR-2171's immutable community IDs, host-wide accounts, tenant memberships, qualified routes, and pending-owner model. It consumes DOR-2175's host/community authority matrix and lifecycle states. Implementation begins only after those foundations land.

## Goals

- Define complete paths for first host operator, later community owner, invited person, returning member, another device, expired/revoked invitation, and owner departure.
- Keep invitation secrets out of query strings, persistent browser storage, logs, analytics, referrers, and DorkOS connection records.
- Make joining, channel access, installation pairing, disconnect, sign-out, and leave visibly different actions.
- Preserve host sessions and other memberships when one tenant relationship ends.
- Provide reliable recovery states without public community enumeration.

## Non-goals

- Provisioning Fly, Neon, object storage, DNS, or a new Community host. The self-hosted launcher owns deployment.
- The persistent community switcher visual system. DOR-2183 owns that surface after this route/state contract.
- Open signup, public directories, email-domain auto-join, portable identity, SCIM, or DorkOS Cloud organizations.
- Email delivery infrastructure. Owners/admins can copy a safe invitation link; delivery is outside this contract.
- Changing the DOR-2175 owner-transfer or lost-owner recovery rules.

## Vocabulary and action boundaries

| Action                    | Result                                                                             | Does not do                                          |
| ------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Deploy a new host         | Creates independently owned service infrastructure                                 | Create a tenant on an existing host                  |
| Create community          | Host operator creates `pending_owner`, then an authorized account claims ownership | Grant content access from host authority alone       |
| Join community            | Creates or reactivates one tenant membership for the signed-in host account        | Connect a local DorkOS installation                  |
| Join channel              | Adds an active community member to one channel                                     | Create an account or community membership            |
| Connect this installation | Pairing grants one local DorkOS server tenant-scoped access                        | Sign the browser in or create membership             |
| Disconnect installation   | Revokes one personal grant and removes its local credential                        | Leave the community or sign the browser out          |
| Sign out this browser     | Ends the current host browser session                                              | Revoke memberships or connected installations        |
| Leave community           | Deactivates one membership and its tenant-derived credentials                      | Delete the host account or affect another membership |

Labels, confirmations, success messages, and audit events use these terms consistently.

## Entry routing

- `/` is a host entry route. An unauthenticated visitor sees sign-in and no community directory.
- A signed-in account with zero active memberships sees an empty membership chooser plus, only if authorized, a host-administration path.
- One active membership enters its canonical `/c/:communityId` route.
- Several active memberships show a chooser of only that account's visible descriptors. The last authorized choice may be remembered by immutable ID; stale or inaccessible choices are ignored.
- `/c/:communityId` resolves the immutable tenant before content lookup. Inaccessible IDs return the accepted non-disclosing response.
- Archived memberships may enter their canonical read-only route under DOR-2175. Suspended and deletion-pending communities route to the chooser with their safe typed state.

## First host and later community creation

First-host setup remains one atomic, explicitly host-scoped bootstrap: create the first host operator account, first community, owner membership, and first channel. The bootstrap secret is single-use and cannot recover a later owner.

Later creation starts only in host administration. A host operator supplies initial presentation settings and an idempotency key. The host creates the final UUID in `pending_owner` and returns a 24-hour private owner-claim handoff. The operator may claim it personally only by switching into an authenticated tenant-claim step; host authority alone does not make them a member. A claim may also be handed to another intended owner. The community becomes visible to ordinary tenant traffic only after atomic claim.

“Create community” never links to provider provisioning. “Deploy a new host” opens the self-hosting entry point with a plain explanation that this creates separate infrastructure.

## Invitation model

An owner or admin creates a row-backed, signed, tenant-bound invitation with expiry, use limit, and optional channel target. The displayed HTTPS link is canonical `/c/:communityId/join#invite=<secret>`. The secret never appears before `#`.

Before the app starts any asynchronous work or renders third-party content, a minimal inline admission bootstrap synchronously reads the fragment into one ephemeral in-memory value and immediately replaces the URL with `/c/:communityId/join`. A failed or hung network request therefore cannot leave the secret in the visible URL or current history entry. The bootstrap then:

1. posts the ephemeral secret over same-origin HTTPS to the qualified preflight endpoint;
2. validates signature, tenant, issuer authority, lifecycle, expiry, revocation, and remaining uses;
3. creates a random, ten-minute, single-browser pending admission bound to invite ID, community ID, and a hash of its HttpOnly cookie;
4. clears the in-memory secret after successful exchange or any terminal navigation/unmount. A retry control may reuse it only while the same clean-URL page remains alive.

The raw invitation is never written to local/session storage, a cookie, logs, error text, telemetry, DOM attributes, service-worker caches, or OAuth state. Preview returns only community name, inviter display name, optional channel name, and expiry after successful preflight. Every invalid public case uses the same non-oracular message and offers “Ask for a new invitation.” Rate limits bind origin/IP and invite identity without logging the token.

Account creation or sign-in continues under the pending-admission cookie. OAuth callbacks return to the clean join URL. After authentication, an account-confirmation transition atomically binds the still-live pending admission to exactly one host account ID. An already bound transaction cannot be rebound or redeemed by another account in the same browser. Redemption uses the account-bound pending admission, not the raw invite, locks the invite/community/account membership, and atomically:

- creates one new membership and tenant handle; or
- returns an existing active membership unchanged; or
- reactivates an inactive membership with the same member ID and handle;
- adds the optional channel membership when allowed;
- records one use per host account, consumes the admission, writes an audit event, and creates a short-lived content-free consumed receipt keyed by transaction, tenant, invite, and account.

Redemption rechecks every preflight condition. Concurrent final-seat claims yield one winner. Replay from another browser, tenant, or account without both the matching pending cookie and bound account fails. If redemption committed but the response or navigation was lost, the consumed receipt returns the same membership result to that same transaction/account without reopening admission or incrementing invite use again. Receipts expire with a bounded retention and carry no invite secret. Reactivation never revives personal grants, agents, agent credentials, pairing state, channel memberships other than the invitation target, or old event cursors.

## Returning member and another device

An active returning member signs in to the host and selects an existing membership; no invitation is required. A person signed in on another browser follows the same host-account path. A removed member may still sign in to the host but cannot enter that tenant until a new invitation reactivates the membership.

Browser sessions remain host-wide. Signing out one browser invalidates that session only. Password recovery follows DOR-2171 and revokes affected credentials across all memberships; it is not a membership recovery shortcut.

## Channel membership

Public channels remain discoverable to active community members and may be joined directly. Private channels are non-discoverable until an owner/admin adds the member or a tenant-bound invitation names that channel. Redeeming a channel-targeted invitation as an existing member joins only that channel and does not create a duplicate community membership.

Leaving a channel removes only `channel_members` state and its channel-local cursor. It does not leave the community, revoke the browser session, or disconnect an installation. Owners/admins cannot use channel membership to bypass tenant role checks.

## Connect this DorkOS installation

Membership admission completes in the host browser before installation connection begins. The local DorkOS app starts pairing from the canonical community link, validates and pins the origin plus immutable community UUID under DOR-2171, generates a verifier-bound challenge, and opens the clean host approval route.

The signed-in member sees the exact community, installation label, requested scope, and expiry, then approves or denies. The local server polls with its verifier and receives the personal grant directly. No invitation secret, host cookie, OAuth token, approval code, or personal grant travels through a query string or custom-protocol URL. The local credential store never receives the browser session.

Connecting a second installation creates a separate grant. “Disconnect this installation” revokes only the selected grant and deletes its local credential. “Disconnect all my installations from this community” requires recent reauthentication and revokes that membership's personal grants without leaving. Server state is authoritative; a revoked grant appears disconnected rather than merely unavailable.

## Leave, removal, and owner departure

Leaving requires recent reauthentication, the community name, and a scope summary: membership ends; tenant-owned personal grants and agents are revoked; other host memberships and the account remain. The transaction deactivates only the selected membership, removes its channel memberships, revokes its personal/agent credentials, ends its tenant streams, and writes audit. Host sessions continue and route to another membership or the chooser.

An owner cannot leave until ownership is transferred under DOR-2175. The interface links to transfer, then returns to the leave review. It never offers host-operator authority as a substitute. Admin/member removal follows the same tenant-scoped revocation and routing behavior. A later invitation may reactivate identity but no prior machine authority.

## Failure and resume behavior

- Reload after successful exchange resumes from the HttpOnly pending transaction and clean URL. Reload before exchange completion has no secret in the URL and requires reopening the invitation.
- An expired pending transaction does not consume an invite use; the original fragment is already gone, so the person asks for/reopens a valid invitation.
- An expired, revoked, exhausted, malformed, wrong-tenant, archived, suspended, or deletion-pending invitation cannot create or reactivate membership.
- If account creation succeeds but redemption fails, the host account remains and the screen states that membership was not added. Retrying a live pending admission is idempotent.
- If membership redemption succeeds but navigation fails, reload derives the membership from server state and enters the canonical route.
- Pairing approval, polling, and disconnect remain independently retryable and idempotent.

## Management experience

The invitation review leads with community name and inviter. Account choices are “Create an account on this host” and “Sign in to this host.” After joining, the primary action is “Open community”; “Connect this DorkOS installation” is a separate next step with a one-sentence explanation.

The membership/settings surface lists browser action, this installation, other connected installations, channel membership, and community membership separately. Destructive actions name their scope. All paths work by keyboard and at narrow phone width, preserve focus across steps, announce async errors, and never depend on color alone.

## Verification matrix

Use two hosts; two communities on host A; one community on host B; accounts with zero, one, and two memberships; a removed member; owner/admin/member roles; two browsers; and two DorkOS installations.

- First-host bootstrap and later pending-owner creation cannot mint membership from host authority alone.
- Raw invite secrets are absent from requests before fragment exchange, browser storage, callback URLs, logs, telemetry, DOM, history after replacement, and connection records.
- Expired/revoked/exhausted/wrong-tenant/malformed links have the same public failure shape and no side effect.
- New account, existing active member, inactive member reactivation, OAuth callback, account-binding race, final-seat race, lost response, reload, and retry paths are atomic and idempotent.
- A failed or permanently hung preflight leaves a clean URL/history entry before the first request and exposes no secret to subsequently loaded content.
- A channel invitation for an existing member adds only that channel; private channel IDs remain non-disclosing elsewhere.
- Another browser signs in without a new invitation; another installation requires its own explicit pairing grant.
- Sign out, disconnect one/all, leave, removal, and password recovery revoke exactly their stated scopes.
- Owner leave is blocked until transfer; host operator status cannot bypass it.
- Every A1 action leaves A2 and host B sessions, memberships, grants, streams, caches, and view state unchanged.
- The full journey works with DorkOS Cloud egress blocked.

## Implementation phases

1. DOR-2180 implements tenant-bound pending admission, redemption/reactivation, lifecycle revocation, channel-target handling, and pairing/disconnect contracts after DOR-2172/2173.
2. DOR-2181 implements host entry, invitation review, account continuation, creation/deployment choices, connected-installation controls, and scoped leave UX after the APIs stabilize.
3. DOR-2182 proves the full cross-device, cross-host, failure, accessibility, and isolation matrix after DOR-2174 and DOR-2178.

## Open questions

All decisions required for implementation are resolved. Email delivery, public discovery, organization policy, and the persistent switcher layout remain separate work.

## Related ADR

- `260920-203201` — Exchange invitation fragments for server-side admission transactions

## References

- DOR-2171 / PR #1943 — accepted tenant identity, routing, and pairing contract
- DOR-2175 / PR #1947 — reviewed host/community authority and lifecycle contract
- `plans/community-next-phase.md` section D
- `apps/community/src/routes/invites.ts`
- `apps/community/src/routes/members.ts`
- `apps/community/src/routes/channels.ts`
- `apps/community/src/routes/pairings.ts`
- `apps/community/src/browser/CommunityApp.tsx`
- `apps/community/src/browser/components/Admission.tsx`
- `apps/server/src/services/communities/remote/pairing-service.ts`
- `packages/shared/src/community-connections.ts`
