---
slug: marketplace-update-disclosure-binding
number: 260924-114458
created: 2026-09-24
status: specified
linear-issue: DOR-2306
project: Marketplace Package Management
---

# Updates and global plugins run only what a person approved

**Slug:** marketplace-update-disclosure-binding
**Author:** Claude Code
**Date:** 2026-09-24

---

## 1) Intent & Assumptions

- **Task brief (DOR-2306, Urgent, security, found in the DOR-2195 review):** globally installed plugins, skill-packs and adapters load straight into every DorkOS Claude Code session through the SDK (`plugin-activation.ts`), with their hooks and MCP servers. Nothing on that path checks consent; Harness Sync's consent covers project installs only. Two ways in run hooks or MCP servers nobody has seen:
  1. `POST /api/marketplace/packages/:name/update` and `POST /api/marketplace/updates` with `apply: true`. Tier `act`, no card, nothing bound: an agent with a shell can call them.
  2. Extensions approved by id (same class, documented; see Non-goals).
- **Asked for:** bring the HTTP apply and global activation to the DOR-2195 standard (the MCP `marketplace_update` apply binds the approval to the new version's disclosed effects); make `ConfirmUpdatesDialog` show those disclosures so the person approves what they see; bind the approval to exactly what they saw, with no gap if the source moves between preview and apply; global activation fails closed.
- **Assumptions:** DOR-2195 (`7ed6ee577`) is in the base: `disclosed-effects.ts`, `planInstallations({ disclose })`, `applyPlan(plan, approved)`, the installer's stage-once update that refuses a `DisclosureChangedError` before removing anything, and `TokenConfirmationProvider` update cards. DOR-2245 is rebasing onto the installer files in parallel, so `marketplace-installer.ts` must not change.

## 2) Codebase map

- **HTTP applies:** `routes/marketplace.ts` (`POST /packages/:name/update` → `UpdateFlow.run({ apply })`; `POST /updates` → `applyInstalledUpdates`, gated only by the `marketplace.install` tier check, which is `act`).
- **MCP apply (the standard):** `marketplace-mcp/tool-update.ts` → `applyApprovedUpdates` (plans with `disclose`, asks through `confirmationProvider`, applies held to each approved disclosure).
- **Activation:** `runtimes/claude-code/claude-code-runtime.ts#refreshActivatedPlugins` → `installed-scanner.ts#listEnabledPluginNames` (every global plugin, skill-pack, adapter) → `plugin-activation.ts` (`{ type: 'local', path }`). Runs at boot and on every `onPluginsChanged`.
- **Project consent (the model to match):** `harness/hook-consent.ts` (`harness.approvedHooks` / `refusedHooks`, `<name>@<digest>`, operator-only), `hook-approval.ts` (card + wait loop), `ask-withheld-hooks.ts`.
- **App:** `ConfirmUpdatesDialog.tsx` (lists installations, prepared for this item), `InstalledPackagesView.tsx` (row Update applies directly), `use-apply-updates-with-toast.ts`, `ApplyUpdateTarget` (an object "so a binding can travel with it later (DOR-2306)").
- **CLI:** `packages/cli/src/commands/update.ts` (`--apply` sends a blind apply), `install.ts` (previews and prompts).

## 3) Findings that shaped the design

- The HTTP check (`GET /updates`) does not disclose, so a person using the app has never been shown what an update runs.
- An agent can read any disclosure the app can, so "send back what you were shown" binds time-of-check to time-of-use but does not prove a person looked. Only the approval card does that for an agent.
- Global activation is downstream of every install path (HTTP, MCP, CLI, a hand edit under `~/.dork/plugins`), so a consent check there closes all of them at once, the same way Harness Sync's projection gate does for project hooks ("the gate is on the CONTENT, not the install").
- A plugin is loaded whole: the SDK has no switch to load a plugin without its hooks (`skipMcpDiscovery` drops only `.mcp.json`). Withholding means leaving the plugin out.
- Scheduled jobs are not loaded by the SDK; they have their own gate (`pending_approval` on first sighting). So activation consent binds what activation actually starts.

## 4) Options considered

| Question                           | Options                                                                      | Chosen                                                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How the app's apply is bound       | (a) opaque server digest echoed back; (b) the full disclosure echoed back    | **(b)**: the server receives the literal thing the dialog rendered, and compares with the same canonicalization the approval hash uses                         |
| Agents over HTTP                   | (a) refuse, point at the MCP tool; (b) same card as MCP `marketplace_update` | **(b)**: one standard on both surfaces, and the CLI in an agent's session keeps working through a card                                                         |
| Per-package apply route            | (a) bind it too; (b) retire it, one apply door                               | **(b)**: one door to secure; the CLI moves to it                                                                                                               |
| Where global consent lives         | (a) new config field; (b) the existing hook-decision lists                   | **(b)**: same decision ("let an installed package run commands automatically"), same operator-only guard, already listed and revoked by `dorkos harness hooks` |
| Existing global plugins on upgrade | (a) seed consent for what is on disk; (b) withhold and ask                   | **(b)**: fail closed. Seeding would approve whatever is on disk at upgrade time, which is exactly the content nobody vetted                                    |

## 5) Recommended direction

Specify as one spec (`02-specification.md`): bound HTTP apply + agent card, disclosure in every check, global activation consent recorded at a person's approval and asked for when missing, app dialog disclosures, app install binding (so an app install is not asked about twice), CLI parity.
