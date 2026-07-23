import type { OperatingSkill } from '../pack.js';

/**
 * The umbrella skill — orients an agent to DorkOS as an operating surface and
 * routes it to the right actuation channel (CLI vs in-session MCP tools).
 */
export const operatingDorkos: OperatingSkill = {
  name: 'operating-dorkos',
  description:
    "Use when operating DorkOS itself on the user's behalf: creating or editing agents, " +
    'scheduling tasks, installing marketplace packages, reading the activity feed, changing ' +
    'settings, or checking for updates. Explains the dorkos CLI, when to use it versus in-session ' +
    'tools, and where live facts come from.',
  body: `# Operating DorkOS

You are running inside DorkOS: the control layer a person uses to run many AI
agents. You can do the things the person can do in the app: make agents, schedule
work, install packages, read activity, and change settings. This skill orients
you; the sibling skills (managing-agents, scheduling-tasks, using-the-marketplace,
reading-activity) cover each area.

## Two ways to act — pick one

DorkOS gives you two actuation channels. Prefer whichever your session already has.

1. **In-session MCP tools** (the \`dorkos\` tool server). Available in Claude Code
   sessions. Structured results, no shell. Use these when they exist: \`create_agent\`,
   \`update_agent\`, \`tasks_list\`/\`tasks_create\`/\`tasks_update\`/\`tasks_get_run_history\`,
   \`activity_list\`, \`agents_recent_activity\`, \`config_get\`/\`config_patch\`,
   \`check_update\`, and the \`marketplace_*\` family.

2. **The \`dorkos\` CLI** (shell). Works from every runtime, including Codex and
   OpenCode where MCP tools are not injected. This is the universal surface. Add
   \`--json\` to any operator verb for machine-readable output with no spinner or
   prose. Use the CLI when you have no in-session tools, or when you explicitly
   want stdout you can parse.

Do not mix channels for one operation. If an MCP tool exists for the job, use it;
otherwise shell out to \`dorkos ... --json\`.

## The dorkos CLI at a glance

The operator verbs hit the running server over its local HTTP API:

- \`dorkos agent list|show <path-or-id>|create|update\` — manage agents.
- \`dorkos task list|create|trigger <id>|runs\` — manage scheduled tasks.
- \`dorkos activity [--actor <t>] [--category <c>] [--type <e>] [--limit <n>]\` — read the feed.
- \`dorkos version --check\` — current server version and the latest release.
- \`dorkos marketplace list|add|remove|refresh|validate\` — manage sources.
- \`dorkos install <name>\` / \`dorkos uninstall <name>\` — install/remove packages.

Every operator verb takes \`--json\`. Exit code is \`0\` on success, non-zero when no
server is reachable or the request fails.

## Where live facts come from

Skills teach procedure. They do NOT hold live state. Never guess the current
agents, tasks, versions, or settings — read them:

- Current agents → \`dorkos agent list --json\` or the \`mesh_list\` tool.
- Current tasks and their runs → \`dorkos task list --json\`, \`dorkos task runs --json\`.
- Current settings → \`config_get\` tool or \`dorkos\` config surface.
- Recent activity → \`dorkos activity --json\` or \`activity_list\`.
- Version and updates → \`dorkos version --check\` or the \`check_update\` tool.

## Checking for updates

To see whether a newer DorkOS is out, run \`dorkos version --check\` (or call
\`check_update\`). It reports the running server version and the latest published
version. \`latest\` is \`unknown\` in dev builds or when the registry is unreachable.
Report the result to the user; do not upgrade DorkOS yourself.

## Changing settings

User settings live in the server config, not in the client. To change them, send
a partial config object through \`config_patch\` (in-session) — the same validated
path as the settings UI (\`PATCH /api/config\`). Deep-merge semantics: nested
objects merge, arrays replace. Example: hide the git status-bar item with
\`{ "ui": { "statusBar": { "showGit": false } } }\`. Read the current shape with
\`config_get\` first so you patch the right keys. Only change settings when the user
asked for it — this is their configuration.

## Rules of engagement

- **Confirm before destructive or account-wide changes.** Installing packages,
  deleting tasks, editing another agent's personality, or patching config all
  affect the user's system. Say what you will do, then do it.
- **Read before you write.** Fetch current state, act, then report what changed.
- **System agents are protected.** DorkBot and other system agents reject renames,
  deletion, and identity edits. Do not fight the guard.
- **Prefer one canonical command per job.** Do not script around a tool that
  already does the job.`,
};
