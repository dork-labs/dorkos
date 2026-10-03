# Design decisions: extension-agent-tools-and-skills

Draft decision records seeded at SPECIFY (spec `extension-agent-tools-and-skills`, DOR-2685). They
live here, not in `decisions/`, until the spec is implemented; `/adr:from-spec` promotes the ones
that still hold, applying the significance rubric. D5 and D6 depend on Dorian's answers to the
spec's "Decisions for Dorian" 1 and 2 and are written for the recommended picks.

---

## D1. The capability registry is a frozen core plus a live extension layer

**Status:** Draft (extracted from spec: extension-agent-tools-and-skills)

### Context

`composeRegistry` froze every capability at boot and cached the catalog forever. Extensions start
and stop at runtime, and their tools must be gated, hidden, attributed and listed exactly like core
capabilities.

### Decision

Core domains are composed and validated at boot as before. The same registry object accepts
per-extension contributions through `contribute()`, which returns a removal handle or a refusal and
never throws. Contributions live under the reserved `ext_` domain prefix, are built by the host
(never by the extension), are checked against the same claim tables, and are added all-or-nothing.
The catalog and its version are recomputed on every change.

### Consequences

#### Positive

- One gate (`registry.invoke`) for every capability; consumers that read per call become live for
  free.
- Core conflicts still fail at boot; the docs composer and every census guard are unaffected.

#### Negative

- "The registry is immutable" no longer holds; anything that cached `capabilities` at boot must read
  it again.

### Alternatives rejected

- A second registry for extensions: two gates, and every consumer would merge two lists.

---

## D2. Extension tools live on the `dorkos` MCP server as `ext_<id>__<tool>`

**Status:** Draft (extracted from spec: extension-agent-tools-and-skills)

### Context

Tools must appear "under the extension's namespace" in Claude Code, Codex and OpenCode, with the
same identity resolution, approval hold and Blocked-tool hiding as core tools.

### Decision

Extension tools join the existing `dorkos` server (in-process for Claude Code, the runtime listener
for Codex/OpenCode) with tool name `ext_<id_underscored>__<tool>` and capability id
`ext_<id_underscored>.<tool>`. Core names never start with `ext_` or contain `__`.

### Consequences

#### Positive

- No second identity or hold seam; the runtime listener needs no new route.
- The capability id fits the permission action-id pattern, so per-tool overrides work unchanged.

#### Negative

- One malformed schema could empty the whole server's `tools/list`; D3 exists to prevent it.

### Alternatives rejected

- One MCP server per extension: better isolation, but duplicated identity/hold plumbing, more
  listener routes, and server-qualified claim keys in the registry.

---

## D3. A tool's input schema is a JSON Schema subset in the manifest, converted by the host

**Status:** Draft (extracted from spec: extension-agent-tools-and-skills)

### Context

The in-session server lists every tool in one `tools/list`; a `z.record` anywhere empties it
(SDK 0.3.257+ with zod 4.5.3+). Schemas defined in extension code would use a foreign Zod copy and
be invisible until the code runs.

### Decision

Tools declare `inputSchema` in `extension.json`, restricted to a subset that never converts to a
record (`additionalProperties` only `false`; no `patternProperties`, `$ref`, `propertyNames`). The
host converts with its own `z.fromJSONSchema`, refuses any `ZodRecord` in the result, and runs the
same conversion `tools/list` runs, at discovery. A refused tool is reported on the extension; its
siblings still load.

### Consequences

#### Positive

- A person can see every tool and tier before approving the code; marketplace validation can check
  them statically.
- One Zod copy; the listability property is checkable in a unit test.

#### Negative

- Map-shaped inputs are not expressible; authors use arrays of `{ key, value }`.

---

## D4. A warm Claude Code process relaunches when its DorkOS tool surface changed

**Status:** Draft (extracted from spec: extension-agent-tools-and-skills)

### Context

The launch fingerprint compares MCP servers by declared config with the live `instance` dropped,
which for the in-process `dorkos` server leaves only its name. A tool added or removed after launch
never reaches a warm process. Whether `setMcpServers` replaces an sdk server's tool list in place is
not live-verified.

### Decision

Add a `toolSurface` pin: a digest of the sorted tool names and input schemas of the `dorkos` server
the factory built, kept beside the instance (not sent to the CLI). Disposition `relaunch`, applied at
the next dispatch, never mid-turn. Move to `live` only after a live test proves in-place replacement.

### Consequences

#### Positive

- Extension tools, and permission-driven hiding, reach warm processes at the next turn as the
  agent-permissions spec already promised.

#### Negative

- A surface change costs each warm process its prompt cache once.

---

## D5. Extensions may register destructive-tier tools (pending Dorian, pick (a))

**Status:** Draft (extracted from spec: extension-agent-tools-and-skills)

### Context

The ticket asked whether a late-registered destructive tool is allowed at all, or extensions are
capped at `act`. Extension server code already runs in-process with the server's privileges once a
person approves it.

### Decision

Allowed. Every call to a destructive extension tool needs a person's approval bound to that exact
input, through the same hold and card as any destructive capability, and the card names the
extension.

### Consequences

#### Positive

- An honest author can ask for a card on a dangerous action; a cap would push the same action to
  `act` with no card.

#### Negative

- The tier is the author's claim; the host cannot prove an `observe` tool only reads. Mitigated by
  the approval card listing tools and tiers and by D6's area.

### Alternatives rejected

- Cap at `act`: protects nothing, removes the only per-call card an author could ask for.

---

## D6. Extension tools share one new permission area (pending Dorian, pick (a))

**Status:** Draft (extracted from spec: extension-agent-tools-and-skills)

### Context

Permission areas are a fixed list; per-action overrides live inside an area. An area-less tool would
be uncontrollable; an author-chosen area lets an author place a tool where the person already said
Allowed.

### Decision

A new `extensions` area ("Extension tools"). Every extension tool is an action in it, labelled with
its extension. Presets: Careful = Ask, Balanced = Allowed, Full = Allowed; destructive asks in all.

### Consequences

#### Positive

- One switch blocks all extension tools; per-tool overrides still work.

#### Negative

- The permissions page gains an area, and the area census guard moves deliberately.

---

## D7. Extension skills are delivered from a published ledger through the plugin path

**Status:** Draft (extracted from spec: extension-agent-tools-and-skills)

### Context

Skills must project like a plugin's (ADR 260706-192819) and un-project on unload. The harness also
runs from a terminal (`dorkos harness sync`) without the server, and its orphan sweep removes any
projection its plan lacks.

### Decision

After every rescan the server writes `{dorkHome}/extensions/running-skills.json`, the skills of every
enabled, approved, running-copy extension, read from the verified snapshot where there is one. The
harness reads it as a third installed source and delivers each skill exactly as a plugin at the same
scope: project symlinks `<id>__<skill>` for local extensions; global tiers plus SDK plugin activation
for global ones. A plugin's same-named skill wins.

### Consequences

#### Positive

- Terminal and server syncs plan the same thing; stopping an extension sweeps its skills.
- No new consent question.

#### Negative

- A derived file to keep honest; deleting it is safe (the next rescan rewrites it).
