import type { OperatingSkill } from '../pack.js';
import { TOOL_NAME_NOTE } from '../tool-name-note.js';

/** Teaches an agent to schedule tasks and read their run history. */
export const schedulingTasks: OperatingSkill = {
  name: 'scheduling-tasks',
  description:
    'Use when scheduling recurring work, creating or editing a task, running a task now, ' +
    'or checking whether past task runs succeeded. Covers cron schedules, the task approval ' +
    'gate, scheduling for an agent installed from the marketplace, retiming or copying a ' +
    "package's own schedule, and reading run history.",
  body: `# Scheduling tasks

${TOOL_NAME_NOTE}

A task (also called a schedule) runs an agent on a cron timer, or on demand. DorkOS runs tasks in the background; you set them up and read their history.

The \`tasks_*\` tools are registered straight onto the MCP server, so they do NOT appear in \`dorkos capabilities\` and \`dorkos call\` cannot reach them. The CLI has \`dorkos task list|create|trigger|runs\` and NO \`update\` or \`delete\`. So a session without the \`tasks_*\` tools (Codex, OpenCode) can read, create, and run tasks, but not edit, disable, or delete one: say it has to be done from the DorkOS Tasks page or a Claude Code session, not from a command that does not exist.

## List tasks and their runs

Read current state before changing anything:

- Tasks: \`tasks_list\` tool, or \`dorkos task list --json\`.
- Run history: \`tasks_get_run_history\` with \`schedule_id\` (and optional \`limit\`),
  or \`dorkos task runs [--schedule <id>] [--status <status>] [--limit <n>] --json\`.

Only a task with \`enabled: true\` and \`status: "active"\` can run; one switched off, paused or waiting cannot wake. \`approvedAt\`, \`approvedBy\` and \`approvedVia\` say when, by whom (a person, an agent, or \`policy\` for a DorkOS rule) and where the standing approval was given; with \`approvedVia: "unknown"\`, \`policy\` also means DorkOS didn't record who approved it. All three are null when none is recorded.

## Create a task

- Tool: \`tasks_create\` with \`name\`, \`prompt\` (the instruction the agent runs each
  time), \`cron\` (e.g. \`"0 2 * * *"\` for daily at 2am; left out only for a
  one-shot task, below), \`reason\`
  (required, see below), \`target\` (optional, see below), and optional
  \`description\`, \`timezone\` (IANA, e.g. \`"America/New_York"\`), \`maxRuntime\`
  (e.g. \`"5m"\`, \`"1h"\`) to cap how long a run may take, and \`runtime\`, \`model\`
  and \`effort\` (see below).
- CLI: \`dorkos task create --name <name> --description <text> --prompt <text>
  --target <agent-id-or-global> [--cron <expr>] [--timezone <tz>]
  [--runtime <id>] [--model <id>] [--effort <level>]\`.

Only the CLI can create a manual-only task (omit \`--cron\`).

### A one-shot task, with its own exact commands

For work that runs once (a backfill), send \`runOnce: true\` and no \`cron\`: it runs once, as soon as it is live, and never again. To let that run use commands without asking, also send \`permissionMode: "dontAsk"\` and \`allowList\`, each entry one exact command: \`Bash(/absolute/path/to/program --flags)\`.
- Exact lines only: no wildcards, \`:*\`, shell characters (\`; | & $ < >\`, backticks, quotes) or \`..\`, and no program that runs another (\`sh\`, \`python3\`, \`env\`, \`timeout\`, \`git\`, \`make\`, a link to one). Up to 20, Claude Code only, and only if your own level runs commands without asking. One bad entry refuses the call.
- No card, from your own chat, for your own new task. From a turn that read outside words, a scheduled run or another agent it is refused: use \`requestedAllow\` for the person's card. DorkOS records each program's bytes; if one changes, or your own level drops before it runs, the run fails and nothing runs. If it can't run when it turns on (parked, switched off), it runs once it is on again.
- **When it is done, take them back:** \`tasks_update\` with only \`id\` and \`allowList: []\`. Removing needs no approval and is recorded. Adding to an existing task is not yours: use \`requestedAllow\`.

### Where it runs, and on what

Three optional fields, and leaving all three out is the right answer for almost
every task:

- \`runtime\`: \`"claude-code"\`, \`"codex"\` or \`"opencode"\`. Left out, the task runs
  wherever its target agent runs, and on DorkOS's default runtime when the task
  belongs to no agent. Name one only when the user asked for that runtime by
  name. A runtime the user has not turned on **fails the run** rather than
  quietly running somewhere else, so do not guess.
- \`model\`: a model id, written the way the resolved runtime writes it
  (\`"claude-sonnet-4-5"\`, \`"gpt-5.5"\`, \`"ollama/qwen2.5-coder"\`). A model belongs
  to one runtime's vocabulary: an id from the wrong runtime is not checked when
  you write it and is reported when the task runs. Left out, the task uses the
  agent's model, then the user's default for that runtime.
- \`effort\`: how hard the model thinks. Left out, the agent's setting, then the
  user's default. A runtime with no such setting ignores it.

On \`tasks_update\`, sending \`null\` for any of the three **clears** it, so the task
goes back to following its agent. Omitting a field leaves it as it was.

### Say why, in your own words

\`reason\` is required and it is not the description. The description says what the
task does; the reason says why it should exist at all, addressed to the person.
Often all they see is your sentence, your name, and the times the cron would
fire, so a blank or padded reason gets paused or rejected (an empty one is refused). Write the sentence you would say out loud: "You asked
me to keep an eye on the overnight builds, and this checks them at 7am so the
summary is waiting for you."

### Say where it lives, too

Omit \`target\`, use \`"global"\`, or give your own agent id to file the task under yourself, in your own folder. A global request still waits for a person to approve it. If your agent has no folder of its own, or its folder is the data folder or another protected folder, creation is refused before anything is written. Below Full autonomy, so is a schedule whose folder is the home folder. A person's own global schedules keep their existing placement.
An agent it has never heard of is refused and nothing is created. Under an agent
installed from the marketplace, your task stays through the package's updates; it
is refused (\`schedule_package_owned\`) if the package uses that name itself, or if
an older DorkOS installed it, until the person chooses **Check files** on it.

Where a task lives is decided once. \`tasks_update\` refuses \`target\` or
\`agentId\` (the whole call); to move a task, delete it and create it again.

### Live at once, or waiting for approval

Read the returned \`status\`. \`active\`: DorkOS trusts its agents, so a task you
create in a session is live and the person is told, with Pause; say what you
scheduled and when it runs. \`pending_approval\`: it waits (the person chose
Careful, you omitted \`target\` or used \`"global"\`, or it came over the external MCP connection or without your agent
token); tell them it needs their approval, and promise nothing before that.

Moving a task to \`active\` IS a person's approval, so it is not yours to do:
\`tasks_update\` refuses \`status\` and changes nothing else in the same call.

**Editing can send a task back for approval.** Change the \`prompt\`, \`cron\` or
\`timezone\` of a task that came from a file or a package, or of any task on
Careful, and DorkOS stops it at once and asks the person again. Your edit is
saved and the reply says \`needsReapproval: true\`: tell them it is waiting on them.
Otherwise your edit keeps it running. Every other field is free, \`enabled\` included: that is how you turn a task on or off.

This is the tasks scheduler's own gate, not the capability approval flow in
operating-dorkos: there is no \`approvalToken\`, only telling the user and waiting.

## Edit or disable a task (tools only, no CLI)

Both are MCP tools with no \`dorkos task\` equivalent, so without them, neither.

- Tool: \`tasks_update\` with the schedule \`id\` and any of \`name\`, \`prompt\`, \`cron\`,
  \`enabled\` (true/false to turn it on or off), \`timezone\`, \`maxRuntime\`
  (e.g. \`"5m"\`, \`"1h"\`), \`runtime\`, \`model\`, \`effort\` (\`null\` clears any of the
  last three; see "Where it runs, and on what" above).

A schedule that came with an installed package can only be turned on or off, or
given a new \`cron\` or \`timezone\`; any other change is refused
(\`schedule_package_owned\`). DorkOS keeps the new timing itself, leaves the
package's files alone, and keeps it through the package's updates. Send
\`resetTiming: true\`, on its own, to put it back on the package's timing. A change
to when an approved schedule runs stops it at once until the user approves it again.
To change what it does, the user can press **Make my own copy** on it in DorkOS: a
new schedule for the same agent, filled in, and by default the package's one off.
For a package an older DorkOS installed, it needs **Check files** first.

- \`tasks_delete\` removes a task permanently, and it is \`destructive\` tier. It does
  NOT run until a person approves it: the first call comes back with the
  \`approval_required\` payload described in operating-dorkos, and you retry the same
  call with an \`approvalToken\` argument once they say yes. Tell the user what you
  are about to delete and that a card is waiting for them, then wait. A refusal is
  the answer, not an obstacle to work around.

### Two fields that are the user's

On your own task, from your own chat, set \`permissionMode\` up to your level; higher is
refused. It keeps running, and the user is told with an Undo; a raise after the user put a mode back
waits for them, and a raise from a scheduled run or a heartbeat is refused, with the user told. Another agent's task, a linked worktree or
outside words ask the user (outside words cap the mode lower; the refusal names the highest you can set). \`status: "active"\`, sent alone, approves: it asks the user, never your own or
your chain's work, never from /mcp. Switched off, either field refuses the whole call.
**Need more than you may set?** Ask instead: \`requestedPermissionMode\` and \`requestedAllow\` (up to 20 exact rules, each naming one specific action; a whole tool, the home folder, any web domain or any command an interpreter runs is refused) go to the person, who sees them when they approve the task. Rules work only for Claude Code runs: a task on any other runtime refuses them. Both apply only to that task's runs, and nothing applies until a person approves it.

**Edited its SKILL file with file tools?** Its runs are then capped at \`dontAsk\` (only the tools already allowed; some steps may fail) until it is accepted. Accept your own edit in the same turn, from your own chat, in two calls: \`tasks_update\` with just the task's \`id\` keeps the cap and replies with what changed (untrusted text) and its \`hash\`; read it, then call again with \`acceptFileHash\` set to that hash.
Missed it? Those two calls on your next ordinary turn are the fix. A scheduled run, a heartbeat, a chat either messaged or started, or a turn that read outside words cannot accept it; the user can, from the task.

## Run a task now

\`dorkos task trigger <id>\` starts a run now (to test one, or run a cron-less one).

## Cron quick reference

\`minute hour day-of-month month day-of-week\`. Examples: \`0 2 * * *\` every day at 02:00, \`0 9 * * 1\` every Monday at 09:00, \`*/15 * * * *\` every 15 minutes. Pass the user's timezone when the time of day matters; without one, it runs in the server's zone.

## Reading run results

Each run has a status (e.g. success, failed, running). When the user asks "did my nightly job work?", read \`tasks_get_run_history\` / \`dorkos task runs\` and report the most recent runs and their statuses in plain terms, newest first.`,
};
