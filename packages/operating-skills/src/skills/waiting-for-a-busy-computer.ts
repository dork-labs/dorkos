import type { OperatingSkill } from '../pack.js';

/**
 * How an agent's heavy shell jobs wait in the computer's one line (DOR-4209),
 * and how it should behave while they do.
 *
 * ## Why this is a skill
 *
 * The gate is invisible to the agent that waits: its shell call just starts
 * later, and the words about the wait go to the person's chat, not to the
 * model. An agent that does not know the line exists reads a long wait as a
 * hang, and the obvious fixes (send it to the background, hide it in a script,
 * run a suite one file at a time, flip a project's off switch) each put a heavy
 * job on top of the ones the line is holding back, which is the overload the
 * gate exists to stop. The rules are few, so they live here.
 *
 * Every fact below is read from the gate itself, not from a design note:
 *
 * - What is heavy: `apps/server/src/services/core/load-gate/heavy-classifier.ts`.
 * - The order, the slots and the load: `load-gate.ts` and `ticket-queue.ts`, with
 *   the shipped numbers in `packages/shared/src/config-schema/runtime-settings.ts`
 *   (`LoadGateSettingsSchema`).
 * - The words the chat shows: `runtime-wait.ts` (`loadWaitMessage`).
 * - What happens on Claude Code, the background gap and the card: the module
 *   doc of `runtimes/claude-code/tool-gate/load-gate-hook.ts`.
 * - The person's three actions, and that no agent may read the line:
 *   `job-actions.ts` and `routes/system-load-gate.ts`.
 * - Exit 75: this repo's `scripts/heavy-run-lock.sh` load guard. Other projects
 *   may have their own; the rule for a refusal is the same.
 *
 * Names no DorkOS tool, so it carries no tool-name note. Keep it that way: an
 * agent has no tool for the line, and naming one would suggest it does.
 */
export const waitingForABusyComputer: OperatingSkill = {
  name: 'waiting-for-a-busy-computer',
  description:
    'Use before you run a build, a test suite, a typecheck, lint, an install, a verify script, ' +
    'a Docker image build, or a git commit or push that runs hooks, and when a shell command ' +
    'seems stuck before it starts, the chat says it is waiting for the computer to calm down, ' +
    "or a run stops with exit 75. Covers which commands wait in the computer's one line for " +
    'heavy jobs and which run at once, what a wait looks like and how long it lasts, what only ' +
    'the person can do about it, and why you never work around it.',
  body: `# Waiting for a busy computer

Every agent on this computer shares one line for heavy shell jobs: builds, test
suites, installs. DorkOS holds a heavy command until the computer is quiet enough
and a slot is free, then runs it. A light command runs at once. A few agents
building at the same time can take a whole computer down; the line is how that
stops.

## What is heavy

DorkOS reads the command itself, through \`env\`, \`nice\`, \`nohup\`, \`timeout\`,
\`sudo\`, \`sh -c\` and \`$(...)\`. A command is heavy when any part of it is:

- \`tsc\`, \`make\`
- \`vitest\` or \`jest\` given anything but exactly one test file (a \`.test.\` or
  \`.spec.\` name). No file, two files, a folder or a name filter is a suite.
- \`playwright test\`, even for one file
- \`pnpm\`, \`npm\`, \`yarn\` or \`bun\`: an install (\`install\`, \`add\`, \`ci\`,
  \`update\`, \`remove\`...), any \`test\`, or a script or turbo task named \`build\`,
  \`verify\`, \`test\`, \`typecheck\`, \`lint\`, \`knip\`, \`e2e\` or \`smoke\` (also
  \`test:e2e\` and the like), including through \`exec\`, \`dlx\`, \`npx\` and
  \`--filter\`. \`bun test\` follows the one-file rule.
- \`vite build\`, \`next build\`, \`docker build\`, \`docker buildx build\`, compose builds
- \`git commit\` and \`git push\`, because they run hooks
- \`cargo build\`, \`test\`, \`check\`, \`clippy\`, \`run\`, \`install\`

Asking any of them for \`--version\` or \`--help\` is light. Everything else is
light, \`ls\`, \`git status\` and one test file included. The person can add or
remove commands in settings.

## What a wait looks like

You are told nothing, not even your place. Your shell call just starts later,
then returns the command's own output as usual. The person's chat shows the wait
instead, refreshed about once a minute, with the job's place and nothing about
the jobs ahead:

- "Waiting for the computer to calm down. 3rd in line." ("Next in line." at the front.)
- After an hour (the person's setting): "Still waiting for the computer. 3rd in
  line. It runs anyway in about 3h."

A job starts when the five-minute load average is under the limit (16 as shipped)
and a slot is free (one as shipped, for the whole computer). Each chat thread waits
as one: heavy calls in the same batch share its turn and never wait on each other.
Helpers each wait their own turn. A job that has waited four hours (as shipped)
runs anyway. The line only ever delays; it never refuses a command.

When a heavy command needs the person's OK, it gives its turn back while the card
waits, and runs straight away once approved.

## Exit 75 means try later

A project can guard its own heavy scripts too. One that gives up because the
computer stayed too busy exits **75** (EX_TEMPFAIL) and says the load was over its
limit, or stops a test run before any test starts because the machine is too busy.
That is not a failure of the command or of the code:

- Never report it as a failing test or a red build. Say it did not run.
- Wait, then run it once more later. Do not retry in a tight loop.
- The message may offer a switch that runs it anyway (in the DorkOS repo,
  \`DORKOS_HEAVY_LOCK=0\` or \`DORKOS_IGNORE_LOAD=1\`). That switch is the
  person's. Use it only when they tell you to.

## Never work around the line

Each of these puts a heavy job on top of the ones the line is holding back:

- **Background.** Run heavy commands in the foreground. On Claude Code, a heavy
  job sent to the background (\`run_in_background\`, \`&\`, \`nohup\`) waits for its
  turn to start and then gives it back, so the next one starts on top of it.
- **Hiding.** Do not tuck a heavy command into a script file or \`node -e\` so it
  reads as light.
- **Splitting.** Running the one test file you need is light and fine. Running a
  suite as a loop of single files to slip under the rule is not.
- **Settings and switches.** Do not turn the line off, raise its limits or remove a
  command from the heavy list. Only the person changes those settings.

## What only the person can do

At the computer running DorkOS, the Activity page lists the heavy jobs waiting.
For one job the person can **Let through** (run it now, past the limits), mark it
**Urgent** (ahead of every normal job) or **Move to front** (first, ahead of urgent
ones too). You cannot do any of these, and you cannot see the list or any other
agent's place. There is no tool for it.

Tell the person, in one line, only when a wait matters: urgent work is stuck
behind the line, or a run took far longer than it should because it waited. Name
the job and say they can let a waiting job through on the Activity page. Do not
ask them to let jobs through as a habit.

## Order your work

- Do the light work first: read code, run the one test file you changed. Run the
  suite once, when you need it.
- A shell call that was slow to start was waiting its turn, not hung. Do not kill
  it and run it again: that puts it at the back of the line.
`,
};
