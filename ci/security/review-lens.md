# Security review lens

The criteria DorkOS Security reviews a pull request against. The cloud reviewer
(`.github/workflows/claude-code-review.yml`) reads **main's** copy of this file,
so a pull request cannot edit the lens it is judged by. DOR-5099 and DOR-5100,
under DOR-5098 (every merge gate in the cloud).

This repository is public. This file holds review criteria only: never known
open issues, exploit paths or anything that would help an attacker. Security
keeps those privately.

## The severity bar: who is the attacker?

DorkOS runs a person's own agents on their own machine, with access to their
accounts, files and money. Security protects the person and their agents **from
outsiders**. It does not fence in the person's own agents.

A finding is a **Must** only when one of these holds:

1. **An outsider is in the attack.** A web page, email, chat message, marketplace
   app or extension, another person, a remote device, a crafted tag or PR, or a
   supply-chain input. Text from outside that steers an agent (prompt injection)
   counts.
2. **An agent quietly raises its own standing power**, for example by widening
   its own grants or approvals, or editing what every agent loads, without the
   person seeing it.
3. **Real secrets or data leave the person's control** (credentials, cookies,
   tokens going somewhere new), or a release or CI path can be hijacked.

**Not a Must:** anything a Bypass agent could already do directly with its own
shell or files, or hardening a test-only setting. If the only attacker is the
person's own agent acting on its own, drop it.

Evidence over vibes: every Must names the file and line, the concrete attack,
and who the attacker is. If you can't name the attacker, it is not a Must.

## What to check, by area

Apply the areas the diff touches. Each item names the attack it stops.

**Sign-in, sessions and the request gate**

- A new route under `/api`, `/mcp` or another listener sits behind the session
  gate, and path checks survive a trailing slash, a doubled slash and a
  different case. Stops: an unauthenticated route reachable from another device.
- Whether a request is "this computer" comes only from the socket peer or the
  listener's ingress mark, never from a header. Stops: spoofed locality through a
  proxy, tunnel or Host header.
- CORS refuses a disallowed Origin; the Host check reads the raw Host; GET
  handlers have no side effects; WebSocket and stream upgrades run the same
  origin, gate and credential checks as HTTP. Stops: CSRF, DNS rebinding,
  cross-site socket hijack.
- Person-only actions use the shared caller-authority helpers, not an ad hoc
  "no agent header" check. Stops: an agent or API key acting as the person.
- Cookies stay `HttpOnly`, `SameSite=Lax` and `Secure` in production. Server-set
  auth fields can't be set from input. Secret comparisons are constant-time over
  fixed-length digests. Secret files are mode 0600 and never logged.

**Text reaching a model that holds tools (prompt injection)**

- A new way to start a turn declares its origin, and an outsider origin starts at
  the most limited power on every runtime. An unknown or failed lookup is treated
  as a stranger, never as the person.
- The sender is stamped by the server, never taken from the request payload.
- Untrusted text is fenced and labeled with DorkOS's own constants. It can't
  start the message as a slash command, and it can't expand `@path` file
  references.
- A turn's limits and marks carry through every later effect: posts, spin-off
  chats, schedules, memory, extensions. Stops: laundering outside text into a
  turn with full power.
- Third-party text never appears in the room's own voice or as a system notice.
- New exfiltration channels in a limited turn (posts, notifications, browser
  navigation, connector writes, attachments) are counted and capped.

**Permissions, tiers and approvals**

- Clamping a mode never loosens it, and agents can't pick person-only modes.
- Destructive and permission-changing actions still ask for unidentified or
  outsider callers.
- The approval hash covers the input, the change and the authority, and tokens
  are single-use, hashed and expire.
- Anything that widens what agents can do is a governance change: the review
  states plainly what it grants and the attack it enables.
- Agent allow lists never grant a general tool by prefix (`git`, `gh`, an
  interpreter, a package runner). Their flags become write or exec primitives.

**Connectors, grants and holds**

- Every route that changes access checks who the operator is before it touches
  anything. No connector capability can write its own grants.
- The execute path keeps every check, in order, and the authority digest covers
  any field that changes meaning. Stops: approve X, execute Y.
- Classification only ever moves stricter. Revisions are immutable.
- Loosening hold eligibility, or adding a principal kind that skips holds, blocks
  the merge.
- No bearer, OAuth token or key in argv, logs, files or the environment. New
  secrets go in the credential store, not `config.json`.

**Extensions, mini apps, marketplace and relay**

- No new API accepts an author, sender or `from` field from the caller. Request
  schemas stay strict.
- A mini app's writes in the person's name need a real user gesture in host UI.
  Extension or room text shown in host UI is sanitized, with no raw HTML.
- Every new server capability for an extension is declared, shown at approval,
  and isolated per extension. The network guard still refuses DorkOS's own port.
- Approval is bound to path, version, origin and digest, and updates ask again.
  Installs, hooks and global plugins stay person-gated.
- Inbound relay adapters verify a signature or secret before parsing, with a
  constant-time compare, and outsider text gets an external author and a limit
  whatever the binding's mode.

**Local servers (previews, companions, dev tools on loopback)**

- Check Host against the server's own loopback names and port on every route and
  upgrade. Matching Origin and Host prove nothing (a rebinding page sets both).
  Check what interface it binds.

**CI, release and supply chain**

- A workflow that holds a secret or a write token never runs code from the pull
  request's checkout. It runs main's copy (`git show origin/main:<path>`) or a
  pinned remote action.
- Untrusted PR text (titles, bodies, branch names, comments) never reaches a
  shell through `${{ }}` interpolation. Pass it through `env:`.
- Tokens get the least permissions the job needs. `pull_request_target` and
  `workflow_run` jobs never check out and run PR code.
- New dependencies, install scripts and GitHub Actions come from known
  publishers. Actions are pinned. Release and publish paths keep their checks.

**Proof**

- Every new "allow" path has a negative test with real-world inputs that fails
  without the fix. Every "never", "fails closed" or "cannot" comment has a test.

## Posting the verdict (cloud reviewer)

- Post exactly one verdict for the head you reviewed, through the review helper:
  `security-verdict pass 0`, or `security-verdict fail <musts> <categories>`.
  Categories come from a fixed list: `auth`, `injection`, `permissions`,
  `connectors`, `extensions`, `secrets`, `ci`, `supply-chain`, `other`.
- **Never describe a Must, an attack or an exploit path in any public comment.**
  The verdict line carries only the count and the categories. The author gets the
  details from Security.
- Shoulds and hardening ideas that don't meet the bar are not Musts. Leave them
  out of the security verdict.
