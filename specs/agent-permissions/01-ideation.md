---
slug: agent-permissions
id: 260923-223844
created: 2026-09-23
status: ideation
tracker: DOR-2278
---

# Agent Permissions: one default for everyone, a few agents set differently

**Slug:** agent-permissions
**Author:** Claude (with Dorian, 2026-09-23)
**Date:** 2026-09-23
**Evidence:** session `e687427b-61fc-4a5d-b889-48e2067730fe`. DorkBot was asked to make a channel for a project. `create_room` came back `tool_group_disabled`, and DorkBot handed the job back to the person: "open DorkBot's settings, go to the Tools tab, turn on Manage rooms, and tell me to go again."

---

## 1) Intent & Assumptions

### The brief (operator's words, kept)

- Every agent permission gets **(1) a global setting** and **(2) per-agent overrides**.
- Model it on the power level: set the default to "Fully autonomous" and **see which agents override it**.
- When a global default is set or changed, **ask whether to also change the agents that override it**.
- **One standard way**, with shared UI/UX and shared code wherever possible. Exceptions are allowed but have to be justified.
- **Default to giving agents far more control than today**, with a few exceptions: "we don't want to give an agent [the power] to nuke our entire system with a single mistake."
- Agents should be able to **request to do pretty much anything**, and that request should be able to turn the permission on.
- Most things get **three states: Blocked, Ask, Allowed**.
- Every settings change is **auditable**.
- The Control Center gets a **summary only** (operator's choice, 2026-09-23).
- On what stays locked, the operator picked the **looser** list: installing MCP servers and marketplace packages _asks_ rather than being locked.
- "10x it": work out what the user actually wants, the journey, where to delight, where progressive disclosure fits, and how to be insanely powerful while looking simple.

### What the user actually wants

Under the settings request sits a simpler wish: **"Let my agents get on with it. Bother me only when it really matters. When I say yes, remember it. Show me what happened."**

Today's shape works against every part of that:

- The block is silent until an agent hits it.
- It dead-ends the conversation ("go to Settings, then tell me to go again").
- Undoing it takes one trip to Settings per agent.
- It leaves no record of who changed what.

Kai runs 10 agents across 5 projects and will not visit 35 settings pages. Priya reads the source, and wants one clear, auditable rule she can reason about.

### Assumptions

- "Request … and to be able to turn it on" means: an agent can ask for anything, and **a person's yes** turns it on, for this one time or from now on. An agent never grants itself a permission. That invariant is what keeps "Blocked" and "Ask" meaningful. _(Confirmed by the operator, 2026-09-23.)_
- Login is off on most installs, so the server cannot tell a person's HTTP call from an agent's `curl`. The audit trail has to say so honestly (see §3, audit gaps).
- The full-power consent door (spec `full-power-defaults`) stays the first-run moment that sets the global posture. This work widens what it sets. It does not replace it.

### Out of scope (named so they aren't lost)

- **DOR-2096** (push/PR/publish from unattended turns has no gate). This fits the model later as an area ("Publish & push"), but it is new gating, not the permission framework.
- **DOR-2159** (artifact-bound capabilities cannot be standing). Separate engine rule.
- **DOR-2112** (files area and ROOM.md in every room). A rooms feature, not a permission.
- The connector (Accounts) grant model. Accounts already have their own per-agent grants and approval flow. Folding them in is a later decision (§6, open item).
- Multi-user roles. One operator per install, as today.

## 2) Pre-reading Log

- `apps/server/src/services/core/capabilities/tool-group-enforcement.ts`: the only per-agent switch that actually refuses a call (`roomsManage`). It fails closed, `approvable: false`, and runs before the tier gate.
- `packages/shared/src/mesh-schemas.ts:166-191, 558, 571`: `enabledToolGroups` (`roomsManage` absent means off), `tierCeiling` (per agent, only a person can raise it).
- ADR `260828-123331`: "`undefined` means OFF for this key, not 'inherit': there is no global twin, because a second and weaker path to the same grant would be a way around the first." **This work supersedes that line.** Its worry dissolves once the global default and the agent override live in one resolver with one audit trail.
- `specs/rooms-management-tools/01-ideation.md:265`: `create_room` gets around the per-room turn cap. Since then the turn limits overhaul made the per-agent-per-cascade limit and the global hourly cap the real brakes, so this argues for keeping those caps human-only, not for keeping room creation off.
- `packages/shared/src/config-schema.ts:1428, 1483, 2209-2216`: `runtimes.defaultTrustStop` (+ per runtime), `agentContext.*Tools` (global, with a per-agent tri-state override).
- `apps/client/src/layers/features/agent-settings/ui/ToolsTab.tsx:83-91, 184-260, 279`: `ToolGroupRow` (inherit badge + reset, local to the file), `ManageRoomsCard` (no inheritance), `TierCeilingCard`.
- `apps/client/src/layers/widgets/control-center/*`: dial, switches, `OverridesLedger` (rows are runtime, session, task, binding; **never agents**).
- `apps/client/src/layers/features/settings/ui/runtimes/ExecutionExceptionsStrip.tsx` + `entities/agent/model/use-execution-exceptions.ts`: the only existing "agents that differ" list, hard-wired to runtime/model/effort/account.
- `apps/server/src/services/core/operator/config-write.ts:390-457`, `routes/config.ts:540-551`, `routes/mesh.ts:554`: config writes go to a log line only; `PATCH /api/config` is `unattributed`; agent manifest PATCHes emit **no** Activity event.
- `packages/shared/src/activity-schemas.ts:18-25`: Activity categories and actor types already exist and fit.
- `specs/full-power-defaults/02-specification.md:37-41`: what full power deliberately left locked.

## 3) Codebase Map

- **Gates today, three of them, each shaped differently:**
  1. **Tool-group gate** (`roomsManage`): per agent, on/off, fails closed.
  2. **Tier ceiling**: per agent, observe/act/destructive, only a person can raise it.
  3. **Tier approval**: destructive-tier capabilities always raise an approval card; standing grants only work with login on.
  - The trust stop (power level) is a fourth, separate thing. It decides when the _runtime itself_ (Claude Code / Codex / OpenCode) asks before editing files or running commands. It is global + per runtime + per session/task/binding. **Not per agent.**
- **Three "inherit" UIs, none shared:** `ToolGroupRow`, `TrustRow`, `ExecutionExceptionsStrip`. No "apply to overriding agents?" prompt exists anywhere.
- **Write policies:** `CONFIG_WRITE_POLICY` and `AGENT_WRITE_POLICY` mark each field `agent-writable | operator-only | tighten-only`. These are the natural home for "an agent may never raise a permission".
- **Audit:** `capability.auto_approved / denied / approval_required` exist. `agent.updated`, `config.changed` and `capability.invoked` do not exist in production code.
- **Blast radius of this work:** the capability registry (`registry.invoke`), the agent manifest schema + migration, the config schema + migration, the agent settings Tools tab, the Settings Tools tab, the Control Center, the full-power door, the approval card, Activity, and the MCP tool descriptions agents read.

## 5) Research

### Prior art worth stealing

1. **iOS / macOS app permissions.** You are asked _at the moment of use_, in context, with "Allow once / While using / Always". Nobody pre-configures a settings page. The settings page is a _record_ of answers, which you can edit later. **Steal: ask in context, and remember the answer.**
2. **Claude Code `allow / ask / deny` rules.** The same three states the operator proposed, which Kai already knows. **Steal: the vocabulary shape, in plain words.**
3. **Google Workspace org units / GitHub org base permissions.** One default for everyone, overrides lower down, and an honest "N places set this differently" count. GitHub asks when the base permission changes. **Steal: the exceptions count and the "what about the ones set differently?" question.**
4. **Browser site settings.** A per-site override list under each global switch ("Allowed on 3 sites"). **Steal: the exceptions chip that expands into a list.**
5. **macOS "Recently changed" / Time Machine.** A change you can see is a change you can trust. **Steal: undo from history.**

### Approaches considered

1. **Add a global twin for `roomsManage` only.** Quick, and fixes today's pain. But it grows a fourth one-off pattern, which is exactly what the operator asked to stop.
2. **A generic "inheritable setting" UI wrapped around each existing gate.** Shared pixels over three unlike engines (on/off, a ceiling, a tier). The UI would promise one model while the code kept three.
3. **Recommended: one permission model.** **Areas** × **three states** × **global default + agent override** × **one resolver + one gate + one audit trail + one set of UI parts**. The tool-group gate and the tier ceiling fold into it and are retired, not kept alongside.

**Recommendation: approach 3.** It is the only one where "looks simple" is true all the way down.

## The design (the 10x)

### One sentence

> **Pick how much power your agents have. When one needs more, it asks right where you're working, and your answer is remembered.**

### The model

- **Area**: a plain-language group of things an agent can do. The first cut:

  | Area                   | What's in it (capabilities)                                                               | Proposed default ("Full power") |
  | ---------------------- | ----------------------------------------------------------------------------------------- | ------------------------------- |
  | **Rooms**              | create, add/remove people, rename/topic, leave, **archive** (new, DOR-2094), merge        | Allowed                         |
  | **Tasks & schedules**  | create, edit, pause, run now; _delete_                                                    | Allowed; _delete asks_          |
  | **Other agents**       | update another agent's settings (not permissions), sidebar groups, register; _unregister_ | Allowed; _unregister asks_      |
  | **Tools & packages**   | marketplace install/uninstall, MCP add/import/update/enable                               | Ask                             |
  | **DorkOS settings**    | ordinary config (notifications, UI, memory…)                                              | Ask                             |
  | **Safety limits** 🔒   | turn limits, relay caps, boundaries/nope rules, concurrency                               | Ask (floor)                     |
  | **Permissions** 🔒     | changing any agent's permissions or the defaults                                          | Ask (floor)                     |
  | **Reach & secrets** 🔒 | tunnel, server file boundary, login, env/secret passing, credentials                      | Ask (floor)                     |
  | **Files & commands**   | the runtime's own trust stop (today's power level)                                        | Autonomy                        |

- **Three states:** **Blocked** (can't, and can't ask), **Ask** (asks you each time), **Allowed** (just does it).
- **🔒 The floor.** A few areas can be set to Blocked or Ask, **never Allowed**. This is the "no single mistake nukes the system" line, stated as a rule instead of a list of special cases: _an agent can never, on its own, widen anyone's power, remove a safety brake, or open this machine to the outside._ A person's yes can still say "yes, this once". That keeps "request pretty much anything" true.
- **Resolution:** `agent override ?? global default ?? built-in default`, then clamped by the floor. It is computed in one server function, read fresh on every call (today's tool-group gate already does this), and exposed to the client as `{ state, source: 'agent' | 'default' | 'floor' }` so every surface can say _why_.

### Progressive disclosure: four layers, most people live in the first

1. **One choice.** At first run, in the Control Center and in Settings: **Careful · Balanced · Full power** (presets that set every area at once). "Custom" appears only once you change something, as "Full power, 2 changes". _Most users never go deeper._
2. **Areas.** Settings → **Permissions**: one row per area, a three-way switch, and an **exceptions chip** ("2 agents differ ›").
3. **One agent.** Agent settings → **Permissions**: the same rows, each reading "Same as everyone (Allowed)" until you change it. Changed rows get a dot and "Reset to default".
4. **Specific actions.** Hidden unless needed (for example "Tasks: delete"), under "Show individual actions". Only where an area's actions really differ in risk.

The same component renders layers 2 and 3. The only difference is the source it writes to.

### Progressive discovery: the settings page is mostly a record of answers

**The request card, the heart of it.** When an agent hits Ask or Blocked, it doesn't dead-end. In the chat, room or Activity, you get:

> **DorkBot wants to create #proj-lunar-metamorphosis** with you, @lifeos, @meeting-notes, @trame-algo-playground
> **[Allow] [Always allow] [Deny]**

- Three answers, operator's wording (2026-09-23): **Allow** (this once), **Deny**, and **Always allow**.
- **Always allow is narrow on purpose: this specific thing, for this specific agent.** "Always allow DorkBot to create rooms" is not "Allow DorkBot all of Rooms", and not "all agents". The operator wants to stop being asked about _that thing_ without widening anything else. It writes a per-agent, per-action override (layer 4) through the same path Settings uses, so it shows up in the agent's Permissions page ("Rooms: Ask, except create rooms: Allowed"), the exceptions chip, and the audit trail. Widening a whole area or everyone stays a deliberate act in Settings.
- **Every answer is audited**, including Allow and Deny: a `permission.answered` Activity event names the agent, the action, the answer, when, and where you answered. Always allow also writes the `permission.changed` event for the override it creates.
- The agent **continues on its own** after a yes. There's no "tell me to go again". That was the actual failure in session `e687427b`.
- On a floor area only **Allow** and **Deny** appear, and one line says why Always allow isn't offered there.
- **Blocked** means the agent may still _ask to be unblocked_. That's a single, rate-limited request card ("DorkBot is blocked from Rooms and is asking to be allowed"), never a loop. This is what "request pretty much anything" means in practice.

**Gentle suggestions, used sparingly.** After you tap "Allow once" 3 times in 7 days for the same agent and area, the card highlights **Always allow**. It asks once, then goes quiet if you dismiss it. It is never a badge or a nag.

### The global change question (operator's requirement)

Changing a default when agents differ opens one small dialog:

> **Rooms is now Allowed for everyone.** 2 agents are set differently:
> ☐ security-auditor: Blocked ☐ test-bot: Ask
> **[Keep their settings] [Update selected]**

- The default selection is nothing checked, so the safe choice is the easy one.
- A floor area going _up_ never auto-selects.
- The dialog also shows the effect before you commit: "affects 33 agents".
- One component, used for every area and for the preset switch.

### Audit: every change, one trail, with undo

- Every permission change writes a single `permission.changed` Activity event: _who_ (you / an agent's request approved by you / the preset / a migration), _what_ (area, before → after), _where_ (global or which agent), _from which surface_ (Settings, Control Center, request card, agent tool, API).
  - A bulk update writes one event naming each agent it touched.
- Honest actor: with login off, an HTTP write that did not come through the app is recorded as "unverified caller", never as "you". Agent-origin writes come through the capability registry with an agent identity and are always named.
- **Permission history** (Settings → Permissions → History, and per agent): a timeline filtered from Activity, with **Undo** on each row. Undo is a new change, so it is audited too.
- **"Why?" on every row.** Hovering a state shows its source: "Allowed, from the default (Full power), changed by you on Sep 23 via the request card".
- The existing `capability.auto_approved / denied / approval_required` events keep recording the _uses_. This adds the _changes_. Together they answer "what could it do, and what did it do".

### Control Center (summary only, the operator's choice)

- The dial becomes the **preset** (Careful · Balanced · Full power · Custom).
- The overrides ledger gains **agent rows** for any area ("security-auditor: Rooms Blocked"), each with one tap to reset.
- There are no per-area switches. "Edit permissions ›" goes to Settings.

### Delight, short list (each must pass "would removing it hurt?")

1. The request card that finishes the job after a yes. This is the headline delight, because the old shape made you do the work twice.
2. The "why?" on every state: never a mystery refusal again.
3. Undo in history: trust grows when mistakes are cheap.
4. The honest preview: "affects 33 agents" before you commit.
5. Quiet memory: "always" lives where you answered, with no settings trip.

### Shared code (the "one standard way")

- **Shared (`packages/shared`):**
  - `permission-areas.ts`: the area registry. Each entry has id, label, one-line description, capability ids, floor, and preset defaults.
  - `PermissionState`.
  - The resolver's pure function.
- **Server:**
  - One gate inside `registry.invoke` replaces `enforceToolGroupGrant` and the tier-ceiling check. Every capability declares its `area`, and a census test fails when one doesn't, the same way `CapabilityToolGroup` works today.
  - Config: `permissions.preset` and `permissions.defaults.<area>`.
  - Manifest: `permissions.<area>?`, where absent means inherit.
  - Write policies: `permissions.*` is operator-only, written only by a person or through an approved request.
  - Semver migrations: `roomsManage: true` becomes `rooms: allowed`; absent becomes inherit. `tierCeiling: observe` becomes Blocked on every act area, and `act` becomes delete-asks.
- **Client:**
  - `<PermissionRow>` (three-way switch + source + reset + why)
  - `<ExceptionsChip>`
  - `<ApplyToOverridesDialog>`
  - `<PresetPicker>`
  - `<RequestCard>`
  - `usePermissions(agentId?)`, `useOverridingAgents(area)`
  - `ToolGroupRow`, `ManageRoomsCard` and `TierCeilingCard` are removed, not kept alongside.
- **The exceptions pattern** is generic enough that `ExecutionExceptionsStrip` (runtime/model/effort) can later move onto `<ExceptionsChip>`. That's noted, not required here.

## 6) Decisions

| #   | Decision                             | Choice                                                                                                                                               | Rationale                                                                                                                                                              |
| --- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Shape                                | One permission model (areas × Blocked/Ask/Allowed × default + agent override) that replaces the tool-group gate and the tier ceiling                 | The operator asked for one standard way; wrapping three unlike engines in one UI would lie                                                                             |
| 2   | Control Center                       | Summary only: preset dial + agent rows in the overrides ledger                                                                                       | Operator's choice 2026-09-23                                                                                                                                           |
| 3   | What stays locked                    | The looser list: packages and MCP installs **ask**. A floor of three areas (Safety limits, Permissions, Reach & secrets) can never be Allowed        | Operator's choice + "no single mistake nukes the system"                                                                                                               |
| 4   | Three states                         | Blocked / Ask / Allowed for most things                                                                                                              | Operator's proposal; matches Claude Code's allow/ask/deny                                                                                                              |
| 5   | Agents can request anything          | Yes; a person's answer decides: Allow (once), Deny, or Always allow (this action, this agent). An agent never grants itself. Every answer is audited | Operator's requirement; the invariant keeps the states meaningful                                                                                                      |
| 6   | Global change prompt                 | A dialog listing agents that differ, nothing pre-checked, with an effect preview                                                                     | Operator's requirement; the safe choice is the easy one                                                                                                                |
| 7   | ADR `260828-123331` "no global twin" | Superseded by a new ADR at SPECIFY                                                                                                                   | One resolver + one audit trail removes the "weaker second path" it guarded against                                                                                     |
| 8   | Per-agent power level (trust stop)   | It becomes the "Files & commands" row with the same inherit/override (confirmed 2026-09-23)                                                          | The operator asked whether the agent "Permissions" card _is_ the power level. It isn't (that card is the tier ceiling). Folding both into one list ends the confusion. |

### Open for SPECIFY

- **Connector grants (Accounts):** fold them into an area now, or leave their existing grant flow alone? _Leaning: leave them, and link from the Permissions page._
- **Blocked + tool visibility:** should Blocked also hide the area's tools from the agent's context (merging `agentContext.*Tools`), leaving a one-line "you can ask for X"? _Leaning: yes. It cuts noise and retires another setting._
- **Standing grants** (`approvals.standingGrants`, login-only today) become per-agent "Always allow" overrides, which work with login off because the write goes through a person's tap. Confirm the login-off threat model with the security lens.
- **Phasing** (proposed):
  1. **Foundation + Rooms.** Registry, resolver, gate, migration, shared UI parts, audit + history, and room archive (DOR-2094). DorkBot's exact failure goes away here.
  2. **The request card** with auto-continue. Absorbs DOR-2093's "no approval path past the ceiling".
  3. **Every other area**, plus presets, the first-run door and the Control Center; retire the tier ceiling.
  4. **Delight:** suggestions, undo, the "why?" everywhere.

**Next step:** `/flow:specify agent-permissions`.
