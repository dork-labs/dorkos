# Design decisions: marketplace-dev-link

Draft decision records seeded at SPECIFY (spec `marketplace-dev-link`, DOR-2696). They live here,
not in `decisions/`, until the spec is implemented; `/adr:from-spec` promotes the ones that still
hold, applying the significance rubric. Each follows the `/flow` draft-ADR shape.

---

## D1. A dev link is a link in the package's normal slot, made real by a DorkOS-written registry

**Status:** Draft (extracted from spec: marketplace-dev-link)

### Context

Running a package from a working folder needs every consumer (installed list, extension discovery,
runtime plugin list, Harness Sync, global consent) to see the folder as the package. A hand-built
link in the slot (DOR-2194) is already half-understood by those consumers, but nothing creates one,
Harness Sync skips it, an install deletes it, and nothing tells a link DorkOS was asked to make from
one an agent or a cloned repo put there.

### Decision

A dev link is a symlink (a junction on Windows) at `{dorkHome}/plugins/<name>` or
`<project>/.dork/plugins/<name>`, plus a record in `{dorkHome}/marketplace/dev-links.json` written
only on a person's yes. A slot counts as dev-linked only while the record exists, the slot is a
link, and its realpath equals the recorded target. An installed copy in the slot is parked beside it
under the `.dorkos-devlink-parked` install-sibling marker and restored on unlink.

### Consequences

#### Positive

- Existing linked-install handling keeps working; in-package paths (`${CLAUDE_PLUGIN_ROOT}`, relDirs)
  are unchanged.
- The registry is the proof the harness containment rule and the trust code need before following a
  link.

#### Negative

- One path names two different things over time, so every path-keyed approval must also say which
  kind it was given to (D2).
- A separate root (no aliasing) was rejected as touching five scanners.

---

## D2. No trust crosses between a dev link and an installed copy

**Status:** Draft (extracted from spec: marketplace-dev-link)

### Context

Extension approvals bind id + directory + carrying plugin; project copies also bind a digest; copies
with a proven origin can run on a source-level trust and from snapshots. A link at an installed
copy's slot has the same directory and plugin name.

### Decision

A dev-linked copy never has a trusted origin (`originProblem: 'dev-link'`, decided before any record
or digest is read). Approvals given to it carry `devLink: <realpath>`, and path matching requires the
`devLink` values to be equal, so an installed copy's approval never covers a link and a link's never
covers the installed copy. Dev links emit no install telemetry and are never the installed version.

### Consequences

#### Positive

- Installed copies keep exactly today's trust; the ticket's "never satisfies a digest pin" holds by
  construction.

#### Negative

- One more optional field on `extensions.approvedSources`, and one more `originProblem` value every
  surface has to render.

---

## D3. Only a person creates a dev link, on a card that names the real path, every time

**Status:** Draft (extracted from spec: marketplace-dev-link)

### Context

A dev link runs whatever is in a folder, on every edit, without asking. The ticket requires that an
agent can never create one and that the card names the absolute path.

### Decision

`marketplace.link` is `tier: 'destructive'` with `area: null`: the tier gate needs a person's yes
bound to the exact input on every call, and no permission setting or "Always allow" can pre-approve
it. The input must be its own realpath. The HTTP route runs the same gate; unlink requires a trusted
caller and has no MCP tool in v1.

### Consequences

#### Positive

- One door for app, terminal and agents; the card always shows where the code lives.

#### Negative

- An agent helping build a plugin must ask every time it wants a link, by design.
- With login off, a caller that omits its agent header is still treated as the operator (DOR-505);
  Require login closes it.

---

## D4. One approval at link time covers what the folder runs then

**Status:** Draft (extracted from spec: marketplace-dev-link; pending Decision for Dorian 1)

### Context

The ticket's complaint is approval churn. Extension approvals are already per copy and not spent by
edits; global consent already approves a linked install by path.

### Decision

The link yes records extension approvals (bound to the dev link), a global-activation yes
(`linked:<realpath>`), and project hook approvals for what the folder declares at link time. Edits
never ask again; a new extension, hook or server asks once through its existing card.

### Consequences

#### Positive

- "Approve the folder once" holds; no new consent UI.

#### Negative

- Whoever can write the folder changes what runs. Stated on the card; the same trade
  `extension-load-policy.ts` already makes.

---

## D5. Hot reload drives the existing seams; it adds none

**Status:** Draft (extracted from spec: marketplace-dev-link)

### Context

DorkOS already has a per-extension recompile and restart (`reloadExtension`, behind
`reload_extensions`), a re-scan (`requestRefresh`), a post-change notifier for plugins, and a
watcher pattern with a measured sweep backstop (`skills-watcher.ts`).

### Decision

One chokidar watch per dev link, debounced 300 ms, with a periodic sweep and re-arm, classifies each
change and calls the matching existing seam: extension files → `reloadExtension`; skills, commands,
hooks → harness re-projection; manifests and declarations → `onPluginsChanged`. It broadcasts
`marketplace_dev_link_reloaded` for the badge.

### Consequences

#### Positive

- Reload behaves exactly like the dev extension loop authors already know.

#### Negative

- Hooks and servers still take effect at the next session, as for any install.
