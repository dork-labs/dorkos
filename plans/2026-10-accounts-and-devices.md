# Plan: accounts, login and devices before launch

**Tickets:** DOR-2964 to DOR-2971, children of DOR-2932 (project "Everything is a space"). **Decision:** ADR [`261015-125850`](../decisions/261015-125850-this-computer-and-other-devices.md), which amends ADR 0320. **Spec it folds into:** [`everything-is-a-space`](../specs/everything-is-a-space/02-specification.md). **Approved:** Dorian, direct chat, 2026-10-15 ("Let's go with A for the slip"). **Written:** 2026-10-15, against `origin/main` `69f7e0c729`.

Nothing in this plan is built yet. No public surface may say any of it works until the step that ships it passes its tests (the demo-claim gate in [`meta/ROADMAP.md`](../meta/ROADMAP.md)).

## Why

Turning login back on hit a dead end: an owner from an earlier login existed, Settings only offered to create a new one, and the duplicate-email error fired before the "registration closed" hook that would have routed to "sign in as the owner". The sign-up form also saved the email as the account name. Underneath that, one global "Require login" switch decides both whether your own Mac asks you for a password and whether other devices can get in, and the "is this local" test trusts a same-host proxy that rewrites Host. The launch plan adds three more ways in (the relay, managed remote, a phone on Wi-Fi), so the fix goes in before the steps that build on the gate.

## In one paragraph

Every request is classified as **this computer**, **other device**, **relayed** or **hub**. This computer is trusted by default, with a visible "Ask for a password on this computer too". Other devices always need a person session, and each session is bound to the route that made it. Wi-Fi sessions get a lower level and work only on a remembered network. The desktop window and the CLI sign themselves in without a file. "Your devices" replaces Remote access. The work is split into steps placed inside the three chats of the everything-is-a-space plan, ahead of the steps that depend on them.

## Order across the three chats

| Ticket   | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Where                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| DOR-2964 | **S1, stop the dead end.** Login & security checks whether an owner exists. If one does, it offers "Sign in as" with the owner's email plus the password, verified by a real sign-in before login turns on, with "Forgot it?" pointing at `dorkos auth reset-password`. The duplicate-email error routes to that path. An account name equal to its email is ignored for display, and sign-up stops sending the email as the name. The false "Change it in Settings › Login & security" copy goes. No locked switch. | now, ahead of the chats       |
| DOR-2965 | **F0, the classifier and the registration seam** (2 to 4 days). One registration-policy function (`local-open`, `setup-code`, `provisioned`, `closed`) and one request classifier (this computer, other device, relayed, hub). Forwarding headers make a request "other device"; the own tunnel enters through a marked ingress; a local request with a non-loopback `Origin` or `Referer` is "other device" and triggers a one-time banner. Contract-first `cloud-api` change to `seats.ts` `authEnabled`.          | chat A, before A2             |
| DOR-2966 | **F3, the desktop window signs in by itself.** The server mints a one-time token (only when an owner exists, after creating the owner's session), hands it to the shell over the process channel, never an environment variable; the window swaps it for an ordinary cookie kept off disk. Reuses A5's `Sec-Fetch-Site` check.                                                                                                                                                                                       | chat A, after A5, before A4   |
| DOR-2967 | **F1, the gate sweep.** Every gate decides by this computer versus other devices. MCP and A2A decide per caller kind, not from the global flag. Remove the "login on means a user exists" assumption from types and the sites that read it, and say which user a credential-less local request acts as.                                                                                                                                                                                                              | chat B, after B1, before B2   |
| DOR-2968 | **F5, server safety.** Setup codes; `reset-password` revokes every session and says what it cannot cut yet; 30-day rolling sessions; the plain-http Secure-cookie trap detected and explained; `--password` warns about shell history; the MCP local token loads on first use; turning exposure on says external MCP clients need a key.                                                                                                                                                                             | chat B, before B2             |
| DOR-2969 | **F4, devices, route binding and the Wi-Fi level.** Person sessions with their route recorded; sign-out closes live streams and sockets; route binding; the Wi-Fi level; the remembered network; Mac-only controls.                                                                                                                                                                                                                                                                                                  | inside B3 (chat B)            |
| DOR-2970 | **D, the "Your devices" screen**, launch minimum.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | chat C, after C11 (reuses F4) |
| DOR-2971 | **After launch.** Managed remote access as the "through your DorkOS account" row, a cross-origin handoff, automatic routing, Touch ID and Windows Hello step-up, passkeys, Wi-Fi on Windows, "Continue with DorkOS" at the Mac (capped by ADR 261015-042933 rule 5).                                                                                                                                                                                                                                                 | after launch                  |

So chat A runs A1, F0, A2, A3, A5, F3, A4 and onward. Chat B runs B1, F1, F5, B2, then B3 with F4 inside it. Chat C runs its lane as before, then C11 and D. A matching DorkOS Cloud change follows the public `cloud-api` contract.

## Rules the build must hold

- **Route binding.** Every session records how it was made (local, Wi-Fi, tunnel, managed). A session arriving by another route is refused. The route is decided by F0's classifier, never by the cookie's name or the Host alone. Replay test: a Wi-Fi cookie with its `__Secure-` prefix restored, sent to the tunnel or managed address, gets a 401.
- **Wi-Fi level** (plain http). Allowed: chat, reading, and approvals that are not front-door settings. Refused, each with its own test: the terminal and its WebSocket, file writes, API key creation, `/mcp` and A2A by cookie, Owner-only front-door settings, pairing, sign-out-all. Sessions last 7 days, rolling.
- **Remembered network.** Wi-Fi is explicit: "Let devices on this Wi-Fi in?", asked once, at Add a device. The network is identified by gateway MAC plus subnet. The app shows "On for Home network. Off elsewhere." and a "paused" state when the router, a mesh or a VPN changes the gateway. The listener binds only the remembered interface and subnet (today it binds every interface) and rechecks on every network change.
- **Mac-only controls** (ADR 261015-042933 rule 5). The away switch, Add a device and sign-out-all need a person cookie on this computer.
- **A local person cookie, no file.** The desktop gets one through F3. The npm CLI mints a startup link in memory: single use, 60 seconds, redeemed by POST, then a clean URL. `dorkos open` refuses with no TTY or inside an agent environment. No DorkOS tool or API route mints links. The managed browser refuses links to its own address. Each link is logged. The docs say this stops an eager agent, not a determined one.
- **Pairing.** Minting and confirming both need a person cookie; the trusted screen shows a matching number; a code is single use, lasts 5 minutes and is rate-limited. The docs say plain-http Wi-Fi cannot stop an attacker relaying traffic on the same network; only https can.
- **Docker and insecure binds.**

  | Case                               | Behaviour                                                                                                                                                                            |
  | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | Insecure bind, no owner            | Open, with a loud boot warning and an in-app banner, for one release. Then the first boot prints a setup code, and the image default changes in that release, with a changelog note. |
  | Insecure bind, owner exists        | A password for every browser request. The CLI inside the container is still this computer (loopback peer and Host, no forwarding headers).                                           |
  | npm on a server, non-loopback bind | Unchanged: refused without an owner.                                                                                                                                                 |

- **"Ask for a password on this computer too"** stays visible in Settings.
- **"Your devices" at launch:** this computer, person sessions (name, last active, how it last connected), Sign out on each, Add a device, the Wi-Fi line, and your own tunnel under Advanced. Sessions on your DorkOS in the cloud stay on the DorkOS account page; relay pins stay under the chat app connection. No claim of automatic routing. Wi-Fi pages say there are no notifications on Wi-Fi; the https origin is the one to install as an app; pairing is per origin.
- **Owed:** the extension API's `requireLogin` advice, and about 15 docs files that say "Require login".

## Builder notes

- F1's acceptance is the full matrix below.
- Name the remembered-network residual in the threat model: a targeted evil twin that clones the gateway's MAC and subnet is out of scope.
- Offer "install as app" on your own tunnel only with a reserved, stable domain. A random tunnel address changes on every start and orphans the app and its notifications.
- Docker with an owner: the CLI inside the container still classifies as this computer. Add a test.
- Relay pins must stay revocable at the Mac while it is offline (B3).
- F3: the one-time-token plugin needs an existing session, so the server creates the owner's session before minting, and mints only when an owner exists.
- "Strictly local" for registration means loopback peer and loopback Host, with no insecure-bind shortcut and never managed-ingress traffic.
- Revocation needs a registry of live connections keyed by session id; nothing closes streams per session today.
- A minimal same-host nginx config (no forwarding headers, Host rewritten to loopback) still classifies as this computer for same-origin GET streams. Writes are caught by the `Origin` rule. Name the residual in `docs/self-hosting/threat-model.mdx` and `reverse-proxy.mdx`.

## Acceptance matrix (F1)

Every gated surface, against every caller kind, with "Ask for a password on this computer too" on and off, and exposure on and off.

- **Surfaces:** `/api`, `/mcp`, A2A, SSE streams, the terminal WebSocket, rooms and community streams.
- **Caller kinds:** local, Wi-Fi, own tunnel, managed remote, relayed, insecure bind, same-host proxy with forwarding headers, same-host proxy without them.

## Threat model

Defended: other devices and people on the network; web pages (DNS rebinding, cross-site requests, previews on other localhost ports); a Wi-Fi cookie replayed through another route; an eager agent minting a person session through a product path we built.

Not defended, and the docs say so: a malicious agent running as the same OS user; an active relay attacker on the same Wi-Fi during plain-http pairing; a targeted evil twin of the remembered network; the minimal-proxy GET residual above; other OS users on a shared computer unless "Ask for a password on this computer too" is on.

## The slip

Expected about 2 weeks, range 1 to 3. Launch moves from late January 2027 (January 19 to 26) to early February 2027 (about February 2 to 9). The Community Space soft launch stays December 8, 2026.

- F0 in chat A gives A2 about 1.5 weeks instead of 2; A3 lands about November 5 to 7, inside the November 10 fallback. Past November 10, the spec's cut list applies.
- Chat B adds F1 with its matrix (about 1 to 1.5 weeks), F5 (about 0.5). B2 moves to about November 16 to 22; B3 with F4 inside lands about November 23 to December 3; B4 to B9 each shift about 2 weeks.
- End to end (L1a) moves from about December 11 to about December 22 to January 5, through the holidays. Hardening (L1b) is compressed, and the buffer absorbs a week.
- Moving F3 into chat A, right after A5, saves chat B about half a week.
