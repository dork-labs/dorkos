import type { OperatingSkill } from '../pack.js';

/** Teaches an agent to schedule tasks and read their run history. */
export const schedulingTasks: OperatingSkill = {
  name: 'scheduling-tasks',
  description:
    'Use when scheduling recurring work, creating or editing a task, running a task now, ' +
    'or checking whether past task runs succeeded. Covers cron schedules, the approval gate, ' +
    'and reading run history.',
  body: `# Scheduling tasks

A task (also called a schedule) runs an agent on a cron timer, or on demand.
DorkOS runs tasks in the background; you set them up and read their history.

## List tasks and their runs

Read current state before changing anything:

- Tasks: \`tasks_list\` tool, or \`dorkos task list --json\`.
- Run history: \`tasks_get_run_history\` (by \`schedule_id\`), or
  \`dorkos task runs [--schedule <id>] [--status <status>] [--limit <n>] --json\`.

## Create a task

- Tool: \`tasks_create\` with \`name\`, \`prompt\` (the instruction the agent runs each
  time), \`cron\` (e.g. \`"0 2 * * *"\` for daily at 2am), and optional \`description\`,
  \`timezone\` (IANA, e.g. \`"America/New_York"\`), and \`maxRuntime\` (e.g. \`"5m"\`).
- CLI: \`dorkos task create --name <name> --description <text> --prompt <text>
  --target <agent-id-or-global> [--cron <expr>] [--timezone <tz>]\`.

Omit \`cron\` for a manual-only task you trigger by hand.

### The approval gate

A task you create is NOT live yet. \`tasks_create\` sets its status to
\`pending_approval\`; the user must approve it in DorkOS before it runs. Tell the
user the task was created and needs their approval. Do not promise it will run
until they approve.

## Edit or disable a task

- Tool: \`tasks_update\` with the schedule \`id\` and any of \`name\`, \`prompt\`, \`cron\`,
  \`enabled\` (true/false to turn it on or off), \`timezone\`, \`maxRuntime\`.
- \`tasks_delete\` removes a task permanently — confirm with the user first.

## Run a task now

- CLI: \`dorkos task trigger <id>\` starts a run immediately and returns a run id.
- Use this to test a task, or to run an on-demand (cron-less) task.

## Cron quick reference

\`minute hour day-of-month month day-of-week\`. Examples:

- \`0 2 * * *\` — every day at 02:00.
- \`0 9 * * 1\` — every Monday at 09:00.
- \`*/15 * * * *\` — every 15 minutes.

Always pass the user's timezone when the time of day matters; cron with no
timezone runs in the server's zone.

## Reading run results

Each run has a status (e.g. success, failed, running). When the user asks "did my
nightly job work?", read \`tasks_get_run_history\` / \`dorkos task runs\` and report
the most recent runs and their statuses in plain terms, newest first.`,
};
