---
slug: everything-is-a-space
number: 261015-042934
created: 2026-10-15
status: ideation
---

# Everything is a space: hubs, space servers and agent computers

**Slug:** everything-is-a-space
**Author:** Claude, for Dorian Collier
**Date:** 2026-10-15
**Linear:** DOR-2932 (umbrella, parent DOR-2735)
**Decision:** ADR [261015-042933](../../decisions/261015-042933-everything-is-a-space-hubs-space-servers-and-agent-computers.md)
**Status:** Agreed. The design below was reviewed over six rounds by four reviewers (architecture, product, security and open source, DorkOS Cloud), and Dorian approved it with all the recommended picks on 2026-10-15. Do not reopen it; change it only through a new decision.

"Hub" is the internal word for a person's own DorkOS. It never appears in anything a person reads. The app says **Private** for the private space and **space** for everything else.

## 1) What Dorian asked for (#dorkos, 2026-10-14 and 15)

**Launch scope.** Quality beats December 8. At launch:

- web sign-up and the full app on the web;
- team spaces on DorkOS Cloud;
- the full app for a teammate with no computer;
- cloud agents;
- Cloud's defaults for when credits run out.

**Your DorkOS account is the door,** the way Claude Code's remote control works.

- **Experience 1.** Away from home, at dorkos.ai, Dorian sees and uses every agent: the ones on his Mac and the ones in the cloud. When the Mac is shut down, its agents show offline and the cloud ones keep going.
- **Experience 2.** A person signs up on the web, pays, and never installs anything. New agents default to cloud agent computers, or can live on a linked Mac.

From dorkos.ai or from a local DorkOS, he sees and talks to all of his agents, wherever they are, plus everyone else's agents in his spaces.

**His mental model:**

- everything is a space;
- an account gets a private space;
- working with others means making a separate space;
- every server is a space server with at least one space, and servers talk to each other;
- each space has a home address;
- you can sign in from anywhere;
- any instance can be a home;
- you can create a space on another server.

His words on the private space (2026-10-15): "Even though this space is private, I should be able to make it available to me through other servers. For example, when I log into dorkos.ai, I should be able to access my private space as well as the other shared spaces."

## 2) The model: one program, three roles

Until the after-launch merge it is still two programs (the DorkOS server and the space server). The roles are the same either way.

| Role               | Holds                                                                                                                                                        | Where                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **Hub**            | One person's DorkOS: the **private space** (the computer's own rooms behind `LOCAL_COMMUNITY`, built), agents' brains, the account directory view, one inbox | Your Mac (with or without an account); your **cloud hub** (lazy, below); a self-hoster's server             |
| **Space server**   | Shared spaces: people and agents as members; rooms, docs, files                                                                                              | spaces.dorkos.ai for team spaces, plus a separate host for the Community Space; self-hosted                 |
| **Agent computer** | A sealed runtime and workspace. No account secrets.                                                                                                          | Cloud agent computers; the sealed computer on a Mac (an experiment behind a flag); the Mac itself, as today |

**Everything is a space:**

- the private space is a space on your hub;
- team spaces are spaces on a space server;
- every server holds at least one space, which is already true at the community port;
- servers connect only by **pairing** (built), never by taking another server's word for who someone is.

**Each computer keeps its own pairings with spaces.** A teammate's mention reaches a Mac directly, as it does today, without the hub or the relay. The hub only shows those pairings.

### 2.1 Cloud hubs

- **Made lazily,** the first time a person with a hub-eligible account opens the full app. Never made at sign-up.
- **Who is sent to their hub:** an account holder who opens a space's own address goes to their hub view **only if they already have a hub**. Everyone else uses the space's own page, so about 20,000 Community Space visitors do not each get a hub. The redirect goes only through dorkos.ai, never to an address taken from the request.
- **Sleeps when idle.** An agentless hub costs little. A free hub left unused for six months is archived, with notice.
- **The warm pool:**
  - a pooled hub has **no owner** and refuses every sign-in until it is assigned (today's "the first visitor becomes the owner" is off on hubs);
  - on assignment it gets new keys: its auth secret, its front-door proof and its address;
  - making a hub needs a verified account and is rate-limited;
  - an unauthenticated request never wakes a hub.
- **A hub never holds hosting-supplier credentials.** It asks Cloud's API to start or stop its own computers, and Cloud makes the call, so a compromised hub cannot reach anyone else's machines.
- **No hub runs agents.**

**Cloud team spaces:** members sign in with a DorkOS account. "Continue with DorkOS" can itself offer Google. Every member is then hub-eligible, which gives a teammate with no computer the full app.

### 2.2 The private space

- **Locked to everyone but you.** You open it from any server or window you sign in to: dorkos.ai, your Mac's app, a library browser. Your own Mac reaches it as you, pinned to your account id. Nobody else ever can.
- **Locked by structure:**
  - no invite or join routes, and pairing only by the owner's own computers;
  - no shareable address;
  - only its owner as a member;
  - a test pins each of these as refusing;
  - Cloud support cannot join it.
- **Shown as "Private",** with a lock: "Just you and your agents."
- **"Invite someone"** opens "Start a team space from this", which moves or copies rooms, docs and agents.
- **Once a Mac is linked,** new Mac agents post to the **cloud** private space by default. The Mac's older rooms stay "On Dorian's MacBook". You reach them away from home through the page move, and the app explains in one sentence what that second place is.

### 2.3 Experience 1: all your agents from anywhere (the session relay)

**What the relay carries:** chats only, the way Claude Code's remote control carries a conversation.

- the durable session stream (snapshot, then `Last-Event-ID` replay, then live `seq`);
- sending messages;
- approvals;
- interrupt.

The terminal, files, settings, connections and previews are never relayed. They open as a page move to the Mac's own managed remote address, behind the Mac's own login ("Open on Dorian's MacBook").

**How it travels:**

- **Chats:** the Mac dials **its own hub** (the address and key it pinned), and Cloud's existing command stream wakes it ("a viewer is open"). No tunnel and no cost per Mac, so **chatting with your Mac's agents from the web is free.** It works for self-hosters too.
- **Page moves** for full control use **managed remote access** (built: the tunnel, edge proof, revoke, idle-close, metering).
- The **protocol is part of the open program**, so a self-hoster's hub can relay over their own tunnel. A self-hosted hub needs its own wake channel.

**Version handshake:** the hub and the Mac agree on the session-protocol version. A Mac too old or too new for something says "this computer needs an update for X" instead of breaking.

**What the Mac controls, even against a compromised Cloud:**

- **Turning it on happens only at the Mac,** by its signed-in owner. The consent says, in at most 15 words, "Your DorkOS account, or DorkOS itself, can run commands here through your agents." "Learn more" adds that Mac chats pass through your own DorkOS in the cloud.
- **Levels are set on the Mac.**
  - **Chat** (the default): chats, messages, approvals.
  - **Full control from anywhere:** terminal, file writes, connections, permission and trust changes, installs, exports. It works through the page move.
  - The link step says: turn Full control on before you leave, because it cannot be turned on remotely.
- **Only at the Mac:** turning it on, changing its level, removing runtime credentials, unlinking.
- **Revoke works locally and offline.**
- **Pinning:**
  - at turn-on the Mac saves the issuer, the **account id** (never an email), the **hub's address and key**, a per-Mac relay credential and a passkey public key;
  - "a viewer is open, dial in" never carries an address; the Mac reaches only what it pinned;
  - after a password or email change, the relay waits 24 to 72 hours.
- **A relayed caller is its own caller kind.**
  - It never counts as "at this computer".
  - Using your Mac from the web needs login on at the Mac with an owner account; managed access refuses to open otherwise (`exposure-guard.ts`). The hub's relay credential is a new caller kind in the Mac's session gate, beside cookies and API keys, and it never counts as a person.
  - The Mac shows a "remote session active" indicator and a notice for each new device.
  - Every relayed action goes into the Mac's own audit record.
- **Passkey-signed approvals:**
  - the challenge is bound to the approval id, the decision, a hash of the exact tool input and a one-time value from the Mac;
  - the person verifies on the device itself;
  - the passkey's site is dorkos.ai, through a step-up popup.
  - **Honest limit:** this stops forged or replayed approvals, such as from a stolen relay credential. It does **not** stop a compromised Cloud, which serves the page and could send a harmful chat message or show a harmless-looking approval. The consent text says so. Only a native or desktop app whose code Cloud does not serve could do better.
- **An away Mac agent** shows its name, "away since …", and messages waiting for it. It never shows its history. Mac transcripts are never copied into Cloud.

### 2.4 Experience 2: web only

- Sign up with a passkey. The card is asked for at your first cloud agent.
- Your hub comes from the warm pool. You get **one cloud agent computer per person by default** ("Works on: Cloud").
- The timed "under a minute" run measures both cold starts.
- **"Works on"** offers Cloud, or a linked Mac that is online.
- **Honest limit: at launch, cloud agents run on OpenCode.**
  - The weekend spike checks whether Doe runs inside a cloud computer. If it does not, the web default is not DorkOS's own engine (PRINCIPLES 5), and Dorian decides.
  - Claude Code and Codex on cloud computers come after launch.
  - If a marketplace package does not work on cloud agents, the app says so.

### 2.5 Hub and agent computer

- **Models:** the computer reaches models directly, with a short-lived token capped per computer (Cloud's model gateway). It never sees account keys.
- **The hub's tool bridge** carries the agent's identity, and each tool call gets that agent's permissions.
  - Tools that set up the hub are refused from agent computers, **except** an owner-granted **setup level for DorkBot**: create agents, change settings, install. DorkBot's job needs it.
  - A turn one agent starts on another computer runs at the teammate tier, unless the owner allowed that pair.
- **DorkBot runs on an agent computer.**
  - Onboarding for people with no computer (free users, agentless teammates) **must not depend on DorkBot**. It is plain app onboarding.
  - One DorkBot per account; it lives where the account started.
  - For web-only people DorkBot needs a cloud computer, and so a card. Onboarding says so honestly.
- **An isolated network per account.** Hubs and computers are never on Cloud's own network.

### 2.6 Two hubs (a Mac and a cloud hub) are peers

- They are joined by the account directory. They **do not sync**; syncing would be XL or more.
- The private space lives in the cloud. The Mac's own rooms stay the Mac's and work fully offline.
- The sidebar is the same everywhere.

### 2.7 Other people's agents

- **You interact through the space conversation:** DMs and mentions.
- **You never see another person's chat view.**

| Caller       | May wake                                                | May read                                                                                  | May do                                                              |
| ------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| You          | always                                                  | everything                                                                                | full power                                                          |
| **Teammate** | yes, within the card limit the owner set for that space | the shared project and public notes only. No transcripts, search, memory or private chats | the stranger tier, plus **"ask the owner"**                         |
| **Stranger** | no, unless approved                                     | as a teammate                                                                             | read-only tools, no shell, no connections, the outsider output caps |

**"Ask the owner" must never become a confused-deputy path:**

- the card shows the **exact operation and its full arguments**, not the agent's summary, and "requested by <teammate> in <space>";
- approving runs exactly what was approved;
- there is **no "allow always"** for requests that start from a teammate;
- requests expire, and each teammate is rate-limited;
- the card says where the result will be posted.

**After launch:** a sandboxed teammate tier that can act directly.

### 2.8 Addresses

**One subdomain per person, behind a wildcard front door:** `<opaque id>.dorkos.app`.

**Why this and not one shared app address:**

- **Mini apps lead the story.** On a per-person address, a hub's own mini apps run at launch, as they do today.
- On a shared address, no mini app could run on the web until the sandbox rewrite (XL), because one person's script could install a service worker for everyone using that browser after them.
- Each person still has **one stable address**, so one installable phone app each.
- One wildcard certificate keeps hub addresses out of the public certificate logs.
- **The cost:** a Public Suffix List entry for `dorkos.app` (apply now). Until it reaches browsers, `__Host-` cookies and same-origin checks on every change, WebSocket upgrade and stream.

**The front door runs in Cloud's customer network, beside the hubs,** never in Cloud's own.

**Front door rules:**

- a proof secret per hub, so a hub refuses any traffic that skipped the front door;
- each hub answers only to its exact address;
- a signed routing table;
- no logging of bodies or cookies;
- the front door checks the login before any wake.

**Passkeys** use dorkos.ai as their site, through a **step-up popup**:

- the challenge comes from the Mac;
- dorkos.ai shows the exact action itself, never text the hub supplies;
- the result goes only to the exact opener address (checked on both sides), with opener isolation set.

**Reserved names:** `dorkos.app` itself and its service names are never hubs. Opaque ids can never collide with them.

**Mini apps:**

- **At launch,** a hub page loads only its own hub's mini apps.
- **Shared mini apps in spaces, and other computers' mini apps,** come after launch, on a sandbox domain with a message bridge.
- The Mac's previews never render inside the hub page.
- A hub's own mini apps run as the owner, so they can reach the Mac at the Chat level. A person still approves a mini app before it loads. This is accepted trust by default.

**Uploads and files** come from a separate user-content domain, served as downloads with `nosniff`. The user-content and sandbox domains are registrable domains of their own, never under `dorkos.app`, and go on the Public Suffix List too (or give each file a random subdomain).

### 2.9 Signing in anywhere

**In a browser:**

- a passkey from your phone;
- **"Public computer" mode:** the session ends when the browser closes, there is an idle sign-out, and the relay works at the Chat level only;
- a notice for each new sign-in, and "sign out everywhere";
- the account name always shows;
- sign-in is protected against forgery.

**From another DorkOS:** add the home address, sign in and pair. That DorkOS's owner then holds your pairing grant, so the app says "Only connect your own computers. Elsewhere, use a browser."

### 2.10 Creating spaces

- **On Cloud:** always through Cloud's API (the host client exists). Host keys never leave Cloud.
- **On a self-hosted server:** your account there, then its API.

### 2.11 Space servers (Cloud and self-hosted)

Every space page gets the same protections:

- uploads from a separate address;
- a strict content security policy (no inline scripts, no eval);
- room-only power for a space sign-in;
- no hub-only screens;
- the team-space host kept separate from the Community Space host.

### 2.12 Self-hosted, no DorkOS account

- **The operator's server is a hub plus a space server,** with its own logins.
- **Members** with Macs pair them. Members without one use the space's own page at launch; a self-hosted hub for several people needs equal accounts, after launch.
- **The relay** reaches a member's Mac only if that member turned it on with that server as their own door.
- **Disclosure:** where hubs live on the operator's server, the operator controls those members' agents and connections.
- **Nothing talks to DorkOS Cloud** unless "Continue with DorkOS" is on.

### 2.13 A Mac as a space's home

After launch (PGlite, XL). Neither experience needs it.

## 3) What stays from the earlier agreed plans

- the cloud computer lifecycle (make, sleep, wake, upgrade, delete);
- egress rules, snapshots and erasure;
- account security: passkeys, the 24 to 72 hour hold after a password or email change, support access recorded in the audit trail;
- billing: the owner pays; credits pay for hours and disk; per-space card limits; who may wake an agent;
- Cloud's defaults for when credits run out (accepted by Dorian, all of them);
- export and import;
- what is open source;
- the "Where my data is" row, which now says the relay passes your hub.

## 4) Launch scope added because the date moved

- **One inbox** (L). The Mac needs a lasting outbound channel for notes to its hub, because it dials in only while a viewer is open.
- **Search across spaces and your agents** (L). Partial when the Mac is off, because Mac transcripts never go to Cloud; room search covers only the rooms the hub mirrors. Both limits are stated.
- **Team billing** (M app, plus Cloud): seats only (Dorian, 2026-10-15).
- **Access levels and guests at invite time:** after launch (Dorian, 2026-10-15; equal accounts, DOR-2743).

## 5) Size and date

- **App:** about 15 L and 10 M, roughly 18 to 20 chat-weeks, across three app chats.
- **Cloud:** four chats from the weekend: the hub fleet, the computer fleet, team spaces (with the host split and its launch gates), and billing.
- **End to end:** about December 11, if the hub image boots on Cloud by November 10 (target November 3).
- **Then about three weeks of:** the security review, the 20,000-viewer test, and measuring.
- **No Show HN over the holidays.**
- **Launch: late January 2027** (Cloud's safer window: January 19 to 26). It assumes this weekend's spike is green.

> **Changed 2026-10-15** (ADR [261015-125850](../../decisions/261015-125850-this-computer-and-other-devices.md)): the login groundwork for this computer and other devices lands before launch. End to end moves to about December 22 to January 5, and launch to **early February 2027** (about February 2 to 9). The current schedule is in [02-specification.md](02-specification.md).

## 6) Dorian's decisions (2026-10-15, "lets move forward with your picks")

1. **Three app chats,** starting after the weekend usage reset. Target late January 2027.
2. **Chatting with your Mac's agents from the web is free.** Full control from the web (terminal, files) rides managed remote and comes with a paid plan or a cloud computer.
3. **Team billing at launch: seats only.**
4. **Access levels and guests come after launch** (DOR-2743).
5. **Keep a December 8 soft launch of the DorkOS Community Space.**
6. **Buy dorkos.app** for several years. Dorian makes this purchase himself.
7. **People outside the US can join a team space.** Paying stays US-only.
8. **One docs PR** updates the canon to match (this spec's PR).
9. **DorkBot for web-only people lives on a cloud computer, which needs a card.** Onboarding says so honestly.

Also owed by Dorian, on the critical path: the DNS token for Cloud's domains, which the weekend spike needs.

## 7) How the disagreements were settled

| Question                   | Settled as                                                                                          | Why                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| A hub for every account?   | Lazy: made on first full-app open; redirect only if a hub already exists                            | Free accounts and Community visitors cost nothing, and teammates still get the full app |
| A Mac hub and a cloud hub  | Peers; new Mac agents post to the cloud private space                                               | No sync (XL or more), and the plane case still works                                    |
| Mac actions over the relay | Chats-only relay; levels set on the Mac; passkey-signed approvals, with their limit stated honestly | Experience 1 needs nobody at the Mac, and the trust is stated plainly                   |
| How the relay travels      | An open session protocol; full control over managed remote                                          | Reuses what is built and stays open for self-hosters                                    |
| Teammate power             | Stranger tier plus "ask the owner", with anti-confused-deputy rules                                 | Safe at launch; the sandboxed tier comes after                                          |
| Address                    | A per-person opaque subdomain behind a wildcard front door                                          | Mini apps work at launch; one address per person; nothing in the certificate logs       |
| Team-space sign-in         | A DorkOS account (Google through it)                                                                | Every member may get a hub, and so the full app                                         |

## 8) Options weighed and dropped

- **The space server serves the full app and reaches into members' computers.** Rejected by all four reviewers: whoever controls a space, ours or a stranger's, could act as you on your computer; it is XL or more; and it would sit in the process that must carry 20,000 viewers.
- **Every computer serves the full app at its own address, and dorkos.ai only lists them.** It works, but every Mac agent is a page move with a second sign-in, and there is no single list of all your agents. It fails Experience 1's feel.
- **One shared app address for everyone.** No mini app could run on the web until the sandbox rewrite.
- **Syncing the Mac hub and the cloud hub.** XL or more, for a case the page move already covers.
