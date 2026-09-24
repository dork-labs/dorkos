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

A task (also called a schedule) runs an agent on a cron timer, or on demand.
DorkOS runs tasks in the background; you set them up and read their history.

The \`tasks_*\` tools are registered straight onto the MCP server, so they do NOT
appear in \`dorkos capabilities\` and \`dorkos call\` cannot reach them. The CLI
has \`dorkos task list|create|trigger|runs\` and NO \`update\` or \`delete\`. So a
session without the \`tasks_*\` tools (Codex, OpenCode) can read, create, and run
tasks, but not edit, disable, or delete one: say it has to be done from the
DorkOS Tasks page or a Claude Code session, not from a command that does not exist.

## List tasks and their runs

Read current state before changing anything:

- Tasks: \`tasks_list\` tool, or \`dorkos task list --json\`.
- Run history: \`tasks_get_run_history\` with \`schedule_id\` (and optional \`limit\`),
  or \`dorkos task runs [--schedule <id>] [--status <status>] [--limit <n>] --json\`.

## Create a task

- Tool: \`tasks_create\` with \`name\`, \`prompt\` (the instruction the agent runs each
  time), \`cron\` (required, e.g. \`"0 2 * * *"\` for daily at 2am), \`reason\`
  (required, see below), \`target\` (required, see below), and optional
  \`description\`, \`timezone\` (IANA, e.g. \`"America/New_York"\`), \`maxRuntime\`
  (e.g. \`"5m"\`, \`"1h"\`) to cap how long a run may take, and \`runtime\`, \`model\`
  and \`effort\` (see below).
- CLI: \`dorkos task create --name <name> --description <text> --prompt <text>
  --target <agent-id-or-global> [--cron <expr>] [--timezone <tz>]
  [--runtime <id>] [--model <id>] [--effort <level>]\`.

Only the CLI can create a manual-only task (omit \`--cron\`); the tool requires a cron.

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
task does; the reason says why it should exist at all, addressed to the person who
has to approve it. All they see is your sentence, your name, and the times the
cron would actually fire, so a blank or padded reason is a task they will reject
(an empty one is refused). Write the sentence you would say out loud: "You asked
me to keep an eye on the overnight builds, and this checks them at 7am so the
summary is waiting for you."

### Say where it lives, too

\`target\` is required and there is no default. Give your own agent id to file the
task under yourself, so it lives in your folder and its runs happen there against
your files, or \`"global"\` for a task that belongs to no agent. A task
filed in the wrong place runs against the wrong files, so DorkOS will not guess.
An agent it has never heard of is refused and nothing is created. Under an agent
installed from the marketplace, your task stays through the package's updates; it
is refused (\`schedule_package_owned\`) if the package uses that name itself, or if
the package came from an older DorkOS (it works after the package's next update).

Where a task lives is decided once. \`tasks_update\` refuses \`target\` or
\`agentId\` (the whole call); to move a task, delete it and create it again.

### The approval gate

A task you create is NOT live yet, whichever way you created it. Both
\`tasks_create\` and \`dorkos task create\` leave it at \`pending_approval\`. Tell the
user it needs their approval; do not promise it will run before they give it.

Moving a task to \`active\` IS that approval, so it is not yours to do:
\`tasks_update\` refuses \`status\` and changes nothing else in the same call.

**Editing an approved task sends it back for approval.** The user approved the
\`prompt\`, the \`cron\` and the \`timezone\` together, since a new timezone moves
when it runs. Change any of the three and DorkOS stops the task at once and asks
them again. Your edit is saved, it just waits, and the reply says so with
\`needsReapproval: true\`. Name the task and tell the user it is waiting on them.
Every other field is free, \`enabled\` included: that is how you turn a task on or off.

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
Packages installed by an older DorkOS don't offer it yet.

- \`tasks_delete\` removes a task permanently, and it is \`destructive\` tier. It does
  NOT run until a person approves it: the first call comes back with the
  \`approval_required\` payload described in operating-dorkos, and you retry the same
  call with an \`approvalToken\` argument once they say yes. Tell the user what you
  are about to delete and that a card is waiting for them, then wait. A refusal is
  the answer, not an obstacle to work around.

### Two fields you cannot set

Do not send \`permissionMode\` or \`status\` to \`tasks_create\` or \`tasks_update\`. A
task runs later with nobody watching, so how much it may do without asking, and
whether it may run at all, are the user's choice. Either one makes DorkOS refuse
the whole call, other fields included; send the rest without it, and tell the
user to open the task in DorkOS for those.

## Run a task now

\`dorkos task trigger <id>\` starts a run now (to test one, or run a cron-less one).

## Cron quick reference

\`minute hour day-of-month month day-of-week\`. Examples: \`0 2 * * *\` every day
at 02:00, \`0 9 * * 1\` every Monday at 09:00, \`*/15 * * * *\` every 15 minutes.
Pass the user's timezone when the time of day matters; without one, it runs in the
server's zone.

## Reading run results

Each run has a status (e.g. success, failed, running). When the user asks "did my
nightly job work?", read \`tasks_get_run_history\` / \`dorkos task runs\` and report
the most recent runs and their statuses in plain terms, newest first.`,
};
