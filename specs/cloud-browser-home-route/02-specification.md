---
slug: cloud-browser-home-route
id: 261113-215634
created: 2026-11-13
status: draft
---

# A cloud agent's browser can go out through your home connection (opt-in)

**Status:** Design outline. Security reviews the full design before build.
**Author:** DorkOS Code (agent)
**Date:** 2026-11-13
**Tracker:** DOR-4290 (Could). Blocked by DOR-2667.
**Why:** [Agent browser: keep building, adopt, or package?](../../research/20261113_agent-browser-build-vs-adopt.md), §4b and the Security addendum

## Problem

Sites score a visitor's network address before they look at the browser. A cloud agent computer sits on a data-center address, so it meets more bot walls and sign-in challenges than the person's own laptop, however honest its browser is. We don't rent residential proxies or solve captchas (decided Nov 11).

The honest options, best first:

1. The person takes over through the stream for the challenge (DOR-2667).
2. **This spec:** with the person's OK, one agent's browser goes out through the person's own home connection.
3. "Use my own Chrome" on the person's machine (DOR-3214).

## Outline

- **Two ends.** The person's own DorkOS (on their computer at home) runs a small relay. The cloud agent computer's Agent browser sends its web traffic to that relay as a proxy.
- **The link.** The cloud side reaches the home relay over an authenticated link between the person's own instances, with no open port at home. Which link carries it is the first open question below.
- **The tunnel.** Plain HTTP `CONNECT`. TLS stays end to end between the browser and the site, and the relay never decrypts it.
- **Scope.** Only the Agent browser's traffic for agents the person turned it on for. Never shell commands, HTTP tools or other users.
- **The switch.** Off by default. Turned on per agent by the person, with a consent card. A visible indicator while it's on. One click turns it off and cuts open connections.

## Acceptance: Security's 6 Musts (Nov 13)

1. **Public internet only.** The home relay refuses loopback, private, link-local, CGNAT, multicast, IPv6 ULA and link-local, and `.local` names. It checks the resolved address at connect time, at the home end, which stops DNS rebinding. Tests for each range, plus a rebinding name.
2. **A plain CONNECT tunnel.** TLS end to end, never decrypted. Agent browser traffic only: not shell or HTTP tools, not other users.
3. **Only the person's own instance can use it.** Mutual auth bound to account and device, revocable from either side, never a shared pool.
4. **A consent card:** "sites will see your home connection, and this agent's browsing will look like you". A visible on-indicator. One click turns it off and cuts open connections.
5. **Outsider holds still apply.** Per-agent page and bandwidth caps.
6. **An audit line per connection:** agent, chat, origin, time, bytes. If the home machine is offline, fall back to the normal cloud route, never to anything wider.

## Open questions for the design review

- Which existing instance-to-instance link carries the relay, and does it already give mutual auth bound to account and device (Must 3)?
- What bandwidth cap is fair by default, and what does the person see when it's hit?
- How does the consent card word the risk for a person who isn't technical, within the 15-word app-copy cap?
- Does the person's home router or ISP terms raise anything we should tell them?

## Out of scope

- Routing for browsers on the person's own computer (they already use the home connection).
- Any proxy pool, rented address or captcha service.

## Order and date

After DOR-2667. **Design ready for Security's review: Fri Dec 18, 2026.** The build is not scheduled; the PM decides after the review.
