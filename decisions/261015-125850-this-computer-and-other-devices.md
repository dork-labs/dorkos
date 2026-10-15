---
id: 261015-125850
title: This computer is trusted by default and other devices always sign in; sessions are bound to the route that made them
status: accepted
created: 2026-10-15
spec: everything-is-a-space
superseded-by: null
amends: [0320]
---

# 261015-125850. This computer is trusted by default and other devices always sign in; sessions are bound to the route that made them

## Status

Accepted (operator decision, direct chat, 2026-10-15). Dorian approved the accounts-and-devices plan and its schedule option A: "Let's go with A for the slip". The login groundwork lands before launch, and launch moves from late January 2027 to early February 2027 (about 2 weeks, range 1 to 3). The plan was agreed after two adversarial review rounds on each of two drafts. Build plan: [`plans/2026-10-accounts-and-devices.md`](../plans/2026-10-accounts-and-devices.md). Tickets: DOR-2964 to DOR-2971, children of DOR-2932.

**Amends** [0320](0320-optional-local-login-required-on-exposure.md) (it stays Accepted). Retired: the single global "Require login" switch as the thing that decides whether a request needs a person session, and "exposure hard-requires creating the owner account" as the only protection for exposed installs. What stands: no account is required to run DorkOS, exposure still needs an owner credential, Better Auth sessions and per-account API keys stay, and the tunnel passcode stays retired.

[0319](0319-account-first-cloud-identity-device-link.md) stands unchanged: the DorkOS account and the local login are never merged. This ADR does not make "Continue with DorkOS" a way to sign in at the Mac.

## Context

On 2026-10-15 the operator hit a dead end turning login back on. He had made an owner account on 2026-09-03 and later turned login off. Turning it off only flips `auth.enabled`; the owner stays in the database. Settings then offered only "Create an owner account", never "sign in as the owner you already have". Typing his own email failed with "User already exists. Use another email", because Better Auth's duplicate-email check runs before our registration-closed hook, and only the registration-closed error was mapped to the "owner exists" path. The sign-up form also saved the email as the account name, so the email showed as his name everywhere and the "what should we call you" prompt never fired.

The deeper problem is the model. One global switch decides both "does my own Mac ask me for a password" and "can another device reach this computer". The desktop window has no credential of its own, so turning login on means typing a password at your own Mac, and notification answers from the shell fail under login. Meanwhile the "is this caller local" test (loopback peer plus loopback Host) reads a same-host proxy that rewrites Host as local, which the code comments call safe only because login is global. Launch adds more routes in (the session relay, managed remote, a phone on Wi-Fi), so the global switch would get harder to reason about with every step of the [everything-is-a-space](../specs/everything-is-a-space/02-specification.md) plan.

## Decision

We will classify every request, and decide from that, not from one switch.

1. **One request classifier.** Every request is one of: **this computer**, **other device**, **relayed** (the session relay of ADR 261015-042933 rule 4) or **hub** (a cloud hub, where every request is remote). Any proxy forwarding header (`X-Forwarded-For`, `Forwarded`, `X-Real-IP`, `Via`, `X-Forwarded-Host`) makes a request "other device". DorkOS's own tunnel enters through a marked ingress, like managed remote. A "this computer" request carrying a non-loopback `Origin` or `Referer` is "other device", and DorkOS shows a one-time banner suggesting "Ask for a password on this computer too".
2. **This computer is trusted by default.** The person at the computer is already signed in to it. A visible setting, **"Ask for a password on this computer too"**, turns that off. It is a plain line in Settings, never hidden under Advanced.
3. **Other devices always need a person session.** No exposure path (Wi-Fi, own tunnel, managed remote, a non-loopback bind) lets a request through without one. MCP and A2A decide per caller kind, not from the global flag.
4. **One registration-policy seam** with four modes: `local-open`, `setup-code`, `provisioned` (hubs) and `closed`, decided per request. Owner-less sign-up from anything but a strictly local request needs a setup code. A setup code is at least 40 bits, single use, expires in an hour, prints to stdout and a 0600 file only, and is capped on failures.
5. **Sessions are bound to their route.** Each session records how it was made: local, Wi-Fi, tunnel or managed. A session arriving by another route is refused, decided by the classifier, never by the cookie's name or the Host alone.
6. **Wi-Fi sessions get a lower level.** Allowed: chat, reading, and approvals that are not front-door settings. Refused: the terminal and its WebSocket, file writes, API key creation, `/mcp` and A2A by cookie, Owner-only front-door settings, pairing and sign-out-all. A Wi-Fi session lasts 7 days, rolling.
7. **Wi-Fi is tied to a remembered network.** The person turns it on explicitly, once ("Let devices on this Wi-Fi in?"). DorkOS remembers the network by its gateway MAC and subnet, shows "On for Home network. Off elsewhere.", pauses visibly when the router, mesh or VPN changes, binds the listener only to the remembered interface, and rechecks on every network change.
8. **Mac-only controls.** Following ADR 261015-042933 rule 5, the away switch, Add a device and sign-out-all need a person session on this computer. A paired phone cannot use them.
9. **A local person session without a file.** The desktop window signs itself in: the server mints a one-time token, hands it to the shell over the process channel (never an environment variable), and the window swaps it for an ordinary session cookie kept off disk. The npm CLI mints a startup link in memory (single use, 60 seconds, redeemed by POST, then a clean URL). `dorkos open` refuses with no TTY or inside an agent environment. No DorkOS tool or API route mints these links, and the managed browser refuses them for its own address. Each link is logged.
10. **Pairing a device.** Minting and confirming a pairing both need a person session; the trusted screen shows a matching number; a code is single use, lasts 5 minutes and is rate-limited. Pairing is per origin.
11. **Docker and insecure binds change in three cases.** With no owner: today's open posture, with a loud warning, for one release; then the first boot prints a setup code, and the image's default changes in that release. With an owner: every browser request needs a password; the CLI inside the container still counts as this computer. npm on a server with a non-loopback bind: unchanged, refused without an owner.
12. **"Your devices" replaces Remote access.** At launch it lists this computer, each person session (name, last active, how it last connected) with its own Sign out, Add a device, the Wi-Fi line, and your own tunnel under Advanced. Hub sessions stay on the DorkOS account page; relay pins stay under the chat app connection.

A matching DorkOS Cloud change follows the public `cloud-api` contract, which changes first.

### Threat model

We defend against:

- other devices and people on the same network;
- web pages: DNS rebinding, cross-site requests, and previews on other localhost ports (cookie-authenticated writes need `Sec-Fetch-Site: same-origin`);
- a stolen Wi-Fi cookie replayed through the tunnel or managed address (route binding);
- an eager agent minting a person session through a product path we built.

Out of scope, and said so in the docs:

- a malicious agent running as the same OS user (trusted by default). The link guards stop an eager agent, not a determined one that scrapes process arguments;
- an active attacker relaying traffic on the same Wi-Fi during pairing over plain http. The matching number stops a racing redeemer and phishing, not a man in the middle; only https (a tunnel, managed remote or a hub) does;
- a targeted evil twin that clones the remembered gateway's MAC and subnet;
- a minimal same-host reverse proxy that forwards no headers, for same-origin GET streams. Writes are caught by the `Origin` rule; the residual is named in the reverse-proxy and threat-model docs;
- any other OS user on a shared computer, unless "Ask for a password on this computer too" is on.

## Consequences

### Positive

- No password at your own Mac, and notification answers work with other devices on.
- The dead end is gone: an existing owner is offered "Sign in as", and the email is never used as a name.
- A forwarded or proxied request can no longer pass as this computer, so exposure no longer leans on one global switch.
- A cookie stolen on Wi-Fi is useless anywhere else and cannot reach the terminal or create keys.
- One list shows every device that can reach your computer, and each can be signed out.
- The hub role (A2) builds on the same classifier and registration seam instead of a separate path.

### Negative

- Launch moves about 2 weeks, to early February 2027; end to end moves to about December 22 to January 5, through the holidays.
- A large sweep: every gated surface (`/api`, `/mcp`, A2A, SSE, the terminal WebSocket, rooms and community streams) is tested against every caller kind, with "Ask on this computer" on and off and exposure on and off.
- Docker installs with no owner hit a breaking change one release after the warning.
- Plain-http Wi-Fi has no notifications and no installable app; that needs an https origin, and pairing is per origin.
- Revoking a session must now close its live streams and sockets, which needs a new per-session connection registry.
- The published `requireLogin` advice in the extension API and about 15 docs files must be rewritten.

### Neutral

- Managed remote access becomes a "through your DorkOS account" row once it ships. Automatic routing, a cross-origin handoff, Touch ID and Windows Hello step-up, passkeys, Wi-Fi on Windows, and "Continue with DorkOS" at the Mac all come after launch.

## Alternatives considered

- **Do the rewrite after launch, ship only the dead-end fix now.** Rejected: the hub (A2), the relay (B2, B3) and sign-out everywhere (C11) all build on the gate. Doing them on the global switch and then rebuilding costs more than the slip.
- **"Continue with DorkOS" as the Mac's sign-in.** Rejected for launch: it would merge the two identities ADR 0319 keeps apart and make Cloud a way in to the Mac. It may come later behind a Mac-side switch, capped by ADR 261015-042933 rule 5.
- **Wi-Fi on automatically wherever it is needed.** Rejected: the listener binds every interface, so a travelling laptop would open sign-in and pairing pages to every café it joins, and every paired cookie would cross that network in clear text.
- **Automatic routing at launch** (one device entry, the road picked per connection). Rejected: the relay carries chats only, the Wi-Fi origin is not a secure context, and cookies and push subscriptions are per origin, so one app cannot switch roads. Claiming it would break the demo-claim gate.
