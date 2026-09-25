---
slug: agent-template-creation
created: 2026-09-25
status: specified
linearIssue: DOR-2325
---

# Creating an agent from a template or a marketplace package runs the package checks

## Problem

The app created a marketplace agent by cloning the package's `source` as a template: `agentPackageToCreationSeed`, then `POST /api/agents/create`, then `createAgentWorkspace`, then `downloadTemplate`.

- **No package check ran on that path.** There was no validator, no disclosure binding and no card, so an agent package's `.claude/settings.json` hooks and allow rules, a root `.mcp.json`, and `.dork/agent.json` `mcpServers` all landed.
- **The route took any template from any caller.** `dorkos agent create --template` can be called from an agent's session, so one agent could create another whose sessions run a template's hooks. That is an escalation.

## Decision

### Marketplace agents go through the installer

**Server.** `POST /api/agents/create` accepts `package: { name, marketplace?, approvedDisclosure, approvedContentHash }`. That is the preview's `disclosed` and `contentHash`, sent back untouched.

- **Person only.** A caller that is not a trusted person gets 403 `operator_only`, because an agent installs with `marketplace_install`, which asks a person.
- **One stage.** The route calls `MarketplaceInstaller.install`, which:
  - stages the package once and validates it (DOR-2314's refusals included);
  - holds it to `approvedDisclosure`;
  - for agent packages, refuses a staged copy whose content hash is not `approvedContentHash` (409 `disclosure_changed`);
  - creates the agent from the staged copy in `agents/<package>`, where updates find it.
- **Identity.** The person's chosen display name, face, persona, runtime and capabilities reach the creator as `InstallRequest.agentIdentity`.
- **One per package.** A package already installed is refused (409 `COLLISION`). `package.name` must be a package name (`PackageNameSchema`), never a path or an address, because it also names the folder checked for that collision.
- **No internal switches.** The route drops `skipTemplateDownload`, which skips the existing-folder check and the template gate, from every request. Only the installer's staged copy sets it.

**An agent installing an agent package.** `POST /api/marketplace/packages/:name/install` from a caller that is not a trusted person always raises the `marketplace.install` card for an agent package, whatever `projectPath` says. The card names and binds the folder it lands in (`computeTargetDir`, the flow's own), its staged content hash and what its skills run. The install is then held to that hash (`approvedContentHash`), and `marketplace_install` passes the same hash. A declined card lands nothing, and a token replayed for different bytes raises a new card.

**App.**

- A gallery pick from the marketplace and a seeded offer are both treated as a marketplace package. The arrival card and the naming step fetch its preview (`useOfferSchedules`), which already feeds the schedule offer, and send `package` with its approval.
- The directory is fixed to the package folder and shown in place of the directory picker.
- A preview the server refuses still blocks Create (DOR-2314).

### Raw templates are cloned once and shown first

- **Template gate.** `createAgentWorkspace` refuses a template unless it is given a `templateGate` (`services/core/agent-templates/template-gate.ts`). The template is cloned into a staging folder, the clone's `.git` is removed, and `inspectTemplate` reads:
  - its content hash;
  - `findAgentWorkspaceConfig`, the DOR-2314 rule, which gains DOR-2326's git-directory refusal when that lands;
  - `readRunnableDeclarations(dir, { agentWorkspace: true })`, which gains DOR-2327's skill-text commands when that lands.

  Only after the gate lets it through is the clone copied (links stripped) into the agent's folder.

- **Settings, written out.** `inspectTemplate` also reads every file under the findings (`settings`), never following a link. Each file's text is shown verbatim, with every invisible, direction-changing or control character written as `<U+XXXX>`. A file over 32 KB, or one that is not text, is named with its size and not shown. The card prints each file behind a `│ ` gutter, and a card too long to hold it all is refused rather than cut. The app shows each file in a collapsed section, and the CLI prints it with the same gutter.

- **A person** gets `personTemplateGate`. A template that brings nothing lands. One that brings anything gets 409 `template_needs_review` with what it brings, and the retry carries `approvedTemplateHash`. A person's own template is disclosed, never refused.
- **Anyone else** gets `cardTemplateGate`: always an approval card, operation `create-agent-from-template` on capability `agents.create_from_template`. The card is bound to the agent's name, its folder, the template's bytes and what its skills run, and lists everything it carries. The response is 202 `requires_confirmation`, and the retry carries `confirmationToken`. With no provider, the request is refused.
- **The app.** A custom template URL that needs review shows `TemplateReviewNotice` in the naming step, with **Create with these** and **Don't create it**.
- **The CLI.** `dorkos agent create --template` prints what the template brings and asks; `--yes` skips the question. On a card, it prints the `--approval` retry.

## Non-goals

- A skill's `` !`cmd` `` text is disclosed once DOR-2327 lands; this path picks it up with no change.
- Project-scope marketplace agents: the app creates marketplace agents globally, as `dorkos marketplace install` does by default.
