import type { OperatingSkill } from '../pack.js';

/**
 * The umbrella skill: orients an agent to DorkOS as an operating surface, routes
 * it to the right actuation channel (CLI vs in-session MCP tools), and teaches
 * the permission tiers and the approval handshake that gate what it can run.
 */
export const operatingDorkos: OperatingSkill = {
  name: 'operating-dorkos',
  description:
    "Use when operating DorkOS itself on the user's behalf: creating or editing agents, " +
    'scheduling tasks, installing marketplace packages, reading the activity feed, changing ' +
    'settings, or checking for updates. Explains the dorkos CLI, dorkos call, permission tiers ' +
    'and approvals, when to use the CLI versus in-session tools, and where live facts come from.',
  body: `# Operating DorkOS

You are running inside DorkOS: the control layer a person uses to run many AI
agents. You can do the things the person can do in the app: make agents, schedule
work, install packages, read activity, and change settings. This skill orients you;
the siblings (managing-agents, scheduling-tasks, using-the-marketplace,
reading-activity) cover each area.

## Two ways to act, pick one

1. **In-session MCP tools** (the \`dorkos\` tool server). Available in Claude Code
   sessions. Structured results, no shell. Use these when they exist: \`create_agent\`,
   \`update_agent\`, \`tasks_*\`, \`activity_list\`, \`agents_recent_activity\`,
   \`config_get\`/\`config_patch\`, \`check_update\`, \`mesh_*\`, \`relay_*\`, \`marketplace_*\`.

2. **The \`dorkos\` CLI** (shell). Works from every runtime, including Codex and
   OpenCode where MCP tools are not injected. This is the universal surface. Add
   \`--json\` to any operator verb for machine-readable output with no prose.

Do not mix channels for one operation: if an MCP tool exists for the job use it,
otherwise shell out to the CLI.

## Discover, then act

Ask the running instance what it can do rather than guessing. \`dorkos capabilities\`
prints a table of id, tier, and title (\`--json\` for the raw catalog, which pipes
into jq); the \`list_capabilities\` tool returns the same thing in-session. Then run
any entry by id:

    dorkos call <capability-id> [--input '<json>'] [--approval <token>]
    dorkos call operator.activity_list --input '{"limit":5}'

\`dorkos call\` is the universal actuation path: most capabilities have no curated
CLI verb of their own, and it is the only way a Codex or OpenCode session reaches
them. It prints raw JSON on stdout.

The catalog covers capabilities only. The agent, task, relay, mesh, binding,
extension, and UI tools are registered straight onto the MCP server: they appear
in your own tool list, not in the catalog, and \`dorkos call\` cannot reach them.
Only some have a CLI path instead: agent reads map to \`dorkos agent list|show\`
and tasks to \`dorkos task list|create|trigger|runs\`. Relay, mesh, binding,
extension, and UI have no CLI verb, so without the MCP tools they are out of
reach entirely. Say that plainly rather than hunting for a command.

## Permission tiers

Every capability in the catalog carries a tier. Read it before you act:

- \`observe\` only reads. It always runs.
- \`act\` changes something recoverable. It runs, and DorkOS records it in the
  activity feed under your name.
- \`destructive\` cannot be undone. It does NOT run until a person approves it.

## When a call comes back \`approval_required\`

A \`destructive\` call returns this payload instead of doing the work:

    { "status": "approval_required", "capabilityId": "...", "capabilityTitle": "...",
      "tier": "destructive", "approvalId": "...", "approvalToken": "...",
      "expiresAt": "...", "reason": "no_approval", "message": "...",
      "retry": { "channel": "...", "field": "...", "instructions": "..." } }

What to do:

1. Tell the person, in plain words, what you are trying to do and that an approval
   card is waiting for them in DorkOS. The \`message\` field is written for that.
2. Wait for their answer. Do not retry in a loop.
3. Retry with the SAME arguments plus the token:
   - MCP tool: add \`approvalToken: "<token>"\` to the arguments.
   - CLI: \`dorkos call <id> --input '<the same json>' --approval <token>\`
4. Changing ANY argument invalidates the approval. It covers one exact action.

Read \`reason\` to know where you stand: \`awaiting_decision\` means nobody has
answered yet, so present the SAME token again later rather than asking for a new
approval; \`expired\`, \`already_used\`, \`wrong_action\`, and \`unknown_token\` mean
DorkOS already asked again for you, so use the token in THIS payload from now on.

A refusal is a different payload, and \`approvable\` says whether asking again can
ever help:

    { "status": "denied", "reason": "tier_ceiling", "approvable": false, "message": "..." }

- \`approvable: false\` (\`tier_ceiling\`, \`enforcement_unavailable\`): no approval can
  unlock this. Stop and report it; do not look for a workaround.
- \`operator_denied\`: a person said no. Do not try again unless they ask you to.

\`retry.instructions\` in the payload always spells out the exact retry for the
surface you called from; follow it over anything you remember. Two marketplace
tools run an older, separate handshake with different field names
(\`status: requires_confirmation\` plus a \`confirmationToken\`): see
using-the-marketplace.

## The dorkos CLI at a glance

The operator verbs hit the running server over its local HTTP API:

- \`dorkos capabilities [--json]\` and \`dorkos call <id>\` (above) reach any
  capability by id, and nothing else: the \`tasks_*\`, \`relay_*\`, \`mesh_*\`, binding,
  extension, and UI tools are not capabilities.
- \`dorkos agent list|show <path-or-id>|create|update\` manage agents.
- \`dorkos task list|create|trigger <id>|runs\` manage tasks. No update, no delete.
- \`dorkos activity [--actor <t>] [--category <c>] [--type <e>] [--limit <n>]\` reads the feed.
- \`dorkos version --check\` shows the current server version and the latest release.
- \`dorkos marketplace list|refresh|validate\` read sources. Only a person may \`add\` or \`remove\` one: see using-the-marketplace.
- \`dorkos install <name>\` / \`dorkos uninstall <name>\` install/remove packages.
  \`uninstall\` is gated on a person's approval like every destructive path, and
  answers with the approval payload: see using-the-marketplace.

There is no \`dorkos relay\`, \`dorkos mesh\`, \`dorkos binding\`, or \`dorkos ui\`. Every
operator verb takes \`--json\`. Exit code is \`0\` on success, non-zero when no server
is reachable, the request fails, or a call is waiting on an approval.

## Where live facts come from

Skills teach procedure. They do NOT hold live state. Never guess the current
agents, tasks, versions, or settings. Read them:

- Agents: \`dorkos agent list --json\` or the \`mesh_list\` tool.
- Tasks and runs: \`dorkos task list --json\`, \`dorkos task runs --json\`.
- Settings: the \`config_get\` tool or \`dorkos call operator.config_get\`.
- Activity: \`dorkos activity --json\` or \`activity_list\`.
- Version: \`dorkos version --check\` or \`check_update\`. The latest version reads as
  unknown in dev builds or when the registry is unreachable. Report the result; do
  not upgrade DorkOS yourself.

## Changing settings

User settings live in the server config, not in the client. Read the current shape
with \`config_get\` first, then send a partial object under a \`patch\` key:

- Tool: \`config_patch({ "patch": { "ui": { "sidebar": { "recentsCollapsed": true } } } })\`
- CLI: \`dorkos call operator.config_patch --input '{"patch":{"ui":{"sidebar":{"recentsCollapsed":true}}}}'\`

The \`patch\` wrapper is required. Deep-merge semantics: nested objects merge,
arrays replace wholesale. It runs the same validation as the settings UI, so an
unknown key or a bad value is rejected. Only change settings when the user asked.

Status-line items are pinned, not toggled: \`ui.statusBar.pins\` is a list of item
ids (\`cwd\`, \`git\`, \`runtime\`, \`model\`, \`context\`, \`usage\`, \`permission\`). Because
arrays replace, patching \`pins\` sets the whole list.

## Rules of engagement

- **Read the tier before you act.** \`observe\` freely; say what you are doing on
  \`act\`; on \`destructive\`, expect to ask a person and wait.
- **Read before you write.** Fetch current state, act, then report what changed.
- **System agents are protected.** DorkBot and other system agents reject renames,
  deletion, and identity edits. Do not fight the guard.
- **Never route around a gate.** Do not script around a tool that already does the
  job, and do not reach for an ungated path because a gated one made you wait.`,
};
