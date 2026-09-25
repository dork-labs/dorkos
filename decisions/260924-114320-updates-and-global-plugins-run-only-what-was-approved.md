---
id: 260924-114320
title: Updates and global plugins run only what a person approved
status: accepted
created: 2026-09-24
spec: marketplace-update-disclosure-binding
superseded-by: null
---

# 260924-114320. Updates and global plugins run only what a person approved

## Status

Accepted (auto-extracted from spec: marketplace-update-disclosure-binding)

## Context

A globally installed plugin loads into every Claude Code session through the SDK, with its hooks, MCP and language servers, monitors and `bin/` commands. DOR-2195 bound the MCP update apply to what the new version runs, but the HTTP apply reinstalled with nothing shown and nothing bound (tier `act`, so any agent with a shell could call it), and activation loaded whatever sat under `~/.dork/plugins` without asking. The SDK cannot load a plugin without its hooks.

## Decision

The HTTP apply has one door, `POST /api/marketplace/updates`, whose body names each installation with the version, the disclosure and the staged files' content hash it was shown; the server recomputes all three and refuses the batch (409) if any moved, and the installer re-checks the disclosure before removing anything. An agent additionally needs the same approval card `marketplace_update` raises, and an agent's global install that runs anything or replaces a global package needs the `marketplace_install` card.

Global activation loads a package that runs anything on its own only when a person approved the install that put it there: its name, what it declares (read at refresh), and the content hash the installer recorded in its install metadata: the hash of the staged package exactly as it came through the channel, taken before the npm step and including any shipped `node_modules` and lockfile, the same hash the preview showed. The landed folder is never re-hashed (`<name>@global-<digest>` in the hook-decision lists). One approval per package; every install, update or removal forgets the earlier ones. A yes is recorded only after an install landed whose recorded hash is the one the person was shown, or when a card or the terminal is answered against that recorded hash. The runtime checks when it builds its plugin list, at boot and after every marketplace change; it never re-hashes the install folder.

**The threat boundary.** An approval binds what arrives through DorkOS's install and update channel: code fetched from a source by the app, the terminal, or an agent's MCP or HTTP call. It does not police a local process editing files on disk. Anything running as the person, an agent's shell included, can already write `~/.claude/settings.json` hooks or any script directly, so re-hashing the folder every turn would cost speed and churn and buy no real boundary. A declaration that names one of the unhashed paths is still never approvable (below). One that reaches it through `${CLAUDE_PLUGIN_DATA}` (the install's `.dork/data`, which no package may ship), or a script that writes there at run time, runs code written locally after the install, no different from a hook that downloads and runs code.

Around that boundary:

- A package installed before hashes were recorded is held back ("installed before approvals were recorded; review it"); its Review card shows it as it is now, and a decision records that hash in its metadata.
- A linked (developer) install has no install event, so it is approved by name and real path, and its card and row say it runs whatever is in that folder.
- A package may not ship DorkOS's runtime state (`.dork/data`, `.dork/secrets.json`, the install records): the installer refuses it, since those paths are left out of the hash and a shipped install record must never stand in for the one the installer writes. Refused rather than stripped, so what installs is always what the author published. A declaration that points into one of those paths is never approvable.
- Anything the refresh cannot read about one package holds that package back; a refresh that fails as a whole loads no global package.
- When the approved set shrinks, a warm process that loaded a withdrawn plugin relaunches before its next turn (a plugin reload can add but never unload), and that reload is never held for prompt-cache cost.
- Deciding a held-back package outside a card takes the same bar as deciding a card: a trusted caller, and under sign-in, a signed-in session.

A held-back package is visible on its row, reviewable, and listed at startup. Existing global plugins are withheld until approved rather than grandfathered.

## Consequences

### Positive

- Every package that arrives through the install channel (HTTP, MCP, CLI) runs only once a person approved exactly that install, down to its bytes.
- The app shows what an update runs, with the old value beside anything changed, and the install is held to it.
- Checking costs nothing per turn: the recorded hash is read, never recomputed.

### Negative

- After upgrading, each global plugin that runs programs of its own is paused until a person allows it once.
- A plugin is withheld whole, skills included, because the SDK has no partial load.
- A local edit to an installed package's files is not caught (the stated boundary), nor are files outside the package that a hook reads at run time.
- A linked install runs whatever is in its folder once approved.
