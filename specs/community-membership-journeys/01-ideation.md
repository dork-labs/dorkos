---
slug: community-membership-journeys
number: 260920-203200
created: 2026-09-20
status: ideated
linear-issue: DOR-2179
project: Community Membership Journeys
---

# Community membership journeys

## Brief

Make joining and returning to an independent Community feel as clear as joining a Slack workspace while preserving DorkOS's standalone identity and security boundaries. A person should always know whether they are deploying a host, creating a community on an existing host, joining a community, joining a channel, connecting one DorkOS installation, signing out, disconnecting, or leaving.

This design consumes the independently accepted DOR-2171 host-account and tenant-membership contract and the reviewed DOR-2175 host/community lifecycle contract. Both are upstream; this work defines journeys and handoffs, not their persistence implementation.

## Existing behavior

- The singleton browser accepts an invitation secret from the URL fragment, copies it into `sessionStorage`, posts it for preview/preflight, and posts it again after account sign-in.
- Better Auth accounts and sessions currently exist on the host, but singleton membership lookup and removal can end the whole host session.
- A community invitation may optionally add its redeemer to one channel. Existing members can join public channels directly; private channels require an explicit add or invitation.
- A DorkOS installation connects through a separate pairing approval and receives a personal grant. That grant is not the browser account session or community membership.
- Bootstrap currently combines first account, owner claim, community name, and first channel. The tenancy and administration contracts separate first-host bootstrap from later community creation.

## Options considered

### Invitation handoff

1. Put the secret in a query string. Simple routing, but it reaches server logs, referrers, analytics, screenshots, and copied URLs.
2. Keep the secret in a fragment and browser storage through sign-in. The server does not receive the fragment automatically, but extensions, history restoration, and browser storage retain the reusable credential longer than needed.
3. **Selected:** deliver the secret in the HTTPS fragment, synchronously capture it in memory and erase the fragment before any asynchronous work, then exchange it for a short-lived HttpOnly admission transaction. OAuth and account steps carry only the transaction cookie; redemption never needs the raw invite again.

### Desktop handoff

1. Put the invitation secret in a custom-protocol URL. Convenient, but exposes a membership credential to OS dispatch and conflates membership with installation access.
2. Import the browser session into the app. Removes a step, but duplicates host cookies and weakens device separation.
3. **Selected:** finish host membership in the browser, then connect a DorkOS installation through the existing verifier-bound pairing approval. No invitation or browser session secret crosses into the local app.

### Returning people

1. Require a new invite on every device. Easy to explain technically, frustrating and incorrect for a host-wide account with an active membership.
2. Treat matching email as membership everywhere. Convenient, but violates the accepted account/membership separation and can silently grant access.
3. **Selected:** sign in to the host account and show its live memberships. An active returning member needs no invitation. A removed member needs a new tenant-bound invitation, which reactivates the existing membership identity without reviving old grants or agents.

## Principles

- One screen asks for one kind of authority.
- Community names explain choices; immutable IDs determine every request.
- A secret leaves the address bar immediately and never enters a query string, log, analytics event, local storage, or DorkOS connection record.
- Joining a community and connecting a DorkOS installation are separate, visible steps.
- Signing out, disconnecting, leaving, and removing a member state their exact scope before acting.
- Expired, revoked, exhausted, wrong-tenant, and malformed invitations fail safely with one recovery path: ask for a new invitation.
- No journey depends on DorkOS Cloud.

## Result

Proceed to SPECIFY and DECOMPOSE. DOR-2180 owns membership protocol changes, DOR-2181 owns entry-point UX, and DOR-2182 owns cross-device and cross-host proof. DOR-2183 separately owns the persistent community switcher layout.
