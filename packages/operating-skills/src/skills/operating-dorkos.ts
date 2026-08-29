import type { OperatingSkill } from '../pack.js';
import { TOOL_NAME_NOTE } from '../tool-name-note.js';

/**
 * The umbrella skill: orients an agent to DorkOS as an operating surface, routes
 * it to the right actuation channel (CLI vs in-session MCP tools), and teaches
 * the permission tiers and the approval handshake that gate what it can run.
 *
 * ## This body sits at exactly the 150-line cap
 *
 * `pack.test.ts` fails at 151, so the next edit here MUST cut a line before it
 * adds one. That is a real constraint, not an annoyance: every line is injected
 * into the context of every agent DorkOS seeds. DOR-509 paid for three
 * corrections by deleting CLI prose that restated, 15 to 60 lines later, facts
 * the reader had already been given. Look for that shape first — this file has
 * historically grown by restating itself, and trimming a restatement costs the
 * reader nothing.
 */
export const operatingDorkos: OperatingSkill = {
  name: 'operating-dorkos',
  description:
    "Use when operating DorkOS itself on the user's behalf: creating or editing agents, " +
    'scheduling tasks, installing marketplace packages, reading the activity feed, changing ' +
    'settings, or checking for updates. Explains the dorkos CLI, dorkos call, permission tiers ' +
    'and approvals, when to use the CLI versus in-session tools, and where live facts come from.',
  body: `# Operating DorkOS

${TOOL_NAME_NOTE}

You are running inside DorkOS: the control layer a person uses to run many AI
agents. You can do what the person can do in the app: make agents, schedule work,
install packages, read activity, change settings. Siblings: managing-agents, scheduling-tasks,
using-the-marketplace, reading-activity, answering-dorkos-questions, working-in-room-repos.

## Two ways to act, pick one

1. **In-session MCP tools** (the \`dorkos\` tool server, in Claude Code sessions).
   Structured results, no shell. Prefer them when they exist: \`create_agent\`,
   \`update_agent\`, \`tasks_*\`, \`activity_list\`, \`agents_recent_activity\`,
   \`config_get\`/\`config_patch\`, \`check_update\`, \`mesh_*\`, \`relay_*\`, \`marketplace_*\`.

2. **The \`dorkos\` CLI** (shell). Works from every runtime, including Codex and
   OpenCode where MCP tools are not injected. This is the universal surface.

Do not mix channels for one operation: use the MCP tool where one exists, else the CLI.

## Discover, then act

Ask the running instance what it can do rather than guessing. \`dorkos capabilities\`
prints id, tier, and title for every capability (\`--json\` pipes the raw catalog into
jq). In-session, \`list_capabilities\` answers with less: one compact line each, one
page at a time, so discovery cannot flood your context. Narrow with \`domain\` or
\`query\`, ask \`detail:'full'\` for JSON Schemas, page with \`cursor\`, and read the
\`guidance\` line when a page left something out. Run any entry by id:

    dorkos call <capability-id> [--input '<json>'] [--approval <token>]
    dorkos call operator.activity_list --input '{"limit":5}'

\`dorkos call\` is the universal actuation path: most capabilities have no curated
CLI verb of their own. It prints raw JSON on stdout.

The catalog covers capabilities only. The agent, task, relay, mesh, binding,
extension, and UI tools are registered straight onto the MCP server: they appear
in your own tool list, not in the catalog, and \`dorkos call\` cannot reach them.
They carry a tier all the same and answer to the same gate. Some have a CLI verb
instead (see the list below); relay, mesh, binding, extension, and UI have none, so
without the MCP tools they are out of reach entirely. Say that plainly rather than
hunting for a command.

## Permission tiers

Every capability in the catalog carries a tier. Read it before you act:

- \`observe\` only reads. It always runs.
- \`act\` changes something recoverable. It runs, and DorkOS records it in the
  activity feed under your name.
- \`destructive\` cannot be undone. It does NOT run until a person approves it.
  \`marketplace.uninstall\` is the destructive capability in the catalog;
  \`tasks_delete\` and \`mesh_unregister\` are the destructive tools outside it. A
  destructive tool advertises an \`approvalToken\` argument, which is how you spot
  one from its own schema.

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
  capability by id, and nothing else.
- \`dorkos agent list|show <path-or-id>|create|update\` manage agents.
- \`dorkos task list|create|trigger <id>|runs\` manage tasks. No update, no delete.
- \`dorkos activity [--actor <t>] [--category <c>] [--type <e>] [--limit <n>]\` reads the feed.
- \`dorkos version --check\` shows the current server version and the latest release.
- \`dorkos marketplace list|refresh|validate\` read sources. Only a person may \`add\` or \`remove\` one: see using-the-marketplace.
- \`dorkos install <name>\` / \`dorkos uninstall <name>\` install/remove packages;
  \`uninstall\` is gated and answers with the approval payload (using-the-marketplace).

\`capabilities\`, \`call\`, \`agent\`, \`task\`, \`activity\`, and \`version\` take \`--json\`;
\`marketplace\`, \`install\`, and \`uninstall\` do NOT, and passing it is an error, not a
no-op. Exit code is \`0\` on success, non-zero when no server is reachable, the
request fails, or a call is waiting on an approval.

## Where live facts come from

Skills teach procedure. They do NOT hold live state. Never guess the current
agents, tasks, versions, or settings. Read them: \`mesh_list\` or
\`dorkos agent list --json\`; \`dorkos task list|runs --json\`; \`config_get\` for
settings; \`activity_list\` or \`dorkos activity --json\`; \`check_update\` or
\`dorkos version --check\`, whose latest-version field reads as unknown in dev
builds or when the registry is unreachable. Report what you read; do not upgrade
DorkOS yourself.

## Changing settings

User settings live in the server config, not in the client. Read the current shape
with \`config_get\` first, then send a partial object under a \`patch\` key:

- Tool: \`config_patch({ "patch": { "ui": { "theme": "dark" } } })\`
- CLI: \`dorkos call operator.config_patch --input '{"patch":{"ui":{"theme":"dark"}}}'\`

The \`patch\` wrapper is required. Deep-merge semantics: nested objects merge, arrays
replace wholesale. It runs the same validation as the settings UI, so an unknown key
or a bad value is rejected. Only change settings when the user asked.

Status-line items are pinned, not toggled: \`ui.statusBar.pins\` is a list of item ids
(\`cwd\`, \`git\`, \`runtime\`, \`model\`, \`context\`, \`usage\`, \`permission\`), and because
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
