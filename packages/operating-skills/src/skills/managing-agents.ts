import type { OperatingSkill } from '../pack.js';

/** Teaches an agent to create and edit agents, including self-edit etiquette. */
export const managingAgents: OperatingSkill = {
  name: 'managing-agents',
  description:
    "Use when creating a new DorkOS agent, editing an agent's personality or settings, " +
    'editing your own persona, or listing the agents on this system. Covers create/update ' +
    'fields, self-edit etiquette, and the limits on system agents like DorkBot.',
  body: `# Managing agents

An agent is a workspace on disk (\`.dork/agent.json\` plus SOUL.md/NOPE.md) that
DorkOS registers and runs. You can create new agents and edit existing ones,
including yourself.

## List who exists

Never guess the roster. Read it:

- Tool: \`mesh_list\`.
- CLI: \`dorkos agent list --json\`, or \`dorkos agent show <path-or-id> --json\` for one.

Recently active agents come from \`agents_recent_activity\` (see reading-activity).

## Create an agent

- Tool: \`create_agent\` with \`name\` (kebab-case slug), optional \`directory\`,
  \`description\`, and \`runtime\` (defaults to \`claude-code\`).
- CLI: \`dorkos agent create --name <slug> --path <dir> [--template <ref>]
  [--display-name <name>] [--description <text>]\`.

Creation scaffolds the workspace (manifest, SOUL.md, NOPE.md, cross-harness
instruction files) and seeds this Operating DorkOS skill pack into the new
agent's \`.agents/skills/\`, so every new agent knows how to run DorkOS too.

## Edit an agent

Use \`update_agent\` (in-session) or \`dorkos agent update\` (CLI). Editable fields:

- \`displayName\` — human-facing name.
- \`description\` — one-line summary.
- \`persona\` / \`soulContent\` — the personality. Prefer \`soulContent\` (full SOUL.md
  body); \`persona\` is legacy prose.
- \`personaEnabled\` — whether the persona is injected.
- \`traits\` — personality trait scores.
- \`conventions\` — working conventions.
- \`color\` / \`icon\` — visual identity (pass an empty value / \`null\` to clear).
- \`nopeContent\` — full NOPE.md body (the "never do this" list).

Target the agent with \`agent_id\` OR \`cwd\` (the tool), or \`--path <dir>\` (the CLI).

The slug (\`name\`) is immutable. You cannot rename an agent by editing it.

## Self-edit etiquette

Editing YOUR OWN agent is fine and expected — when the user says "be more concise"
or "stop doing X", update your own SOUL.md/NOPE.md or traits directly.

Before editing a DIFFERENT agent's manifest or personality, confirm with the user
first. Changing another agent's identity is a bigger action than tuning your own.

## System agents are protected

DorkBot and any agent with \`isSystem: true\` are system agents. The server rejects:

- renaming them,
- deleting or unregistering them,
- changing their identity fields (namespace, system flag).

You can still adjust their non-identity settings when asked, but do not try to
work around the guard — it is enforced server-side and will return an error.

## After you change an agent

Report what changed in plain terms ("Renamed the review bot to 'Critic' and made
it terser"). The cockpit reflects agent edits live, so the user sees it too.`,
};
