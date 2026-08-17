import type { OperatingSkill } from '../pack.js';
import { TOOL_NAME_NOTE } from '../tool-name-note.js';

/** Teaches an agent to read the activity feed and recent-agent activity. */
export const readingActivity: OperatingSkill = {
  name: 'reading-activity',
  description:
    'Use when the user asks what has been happening, what an agent did recently, which agents ' +
    'were active lately, or for a summary of recent events. Covers reading the activity feed with ' +
    'filters, the recent-agent activity map, and how your own actions appear in the feed.',
  body: `# Reading activity

${TOOL_NAME_NOTE}

DorkOS records events (agent lifecycle, tasks, relay messages, config changes,
system events) in an activity feed. Read it to answer "what happened?" and never
invent events.

Both reads below are \`observe\` tier: they always run and change nothing.

## Read the feed

- Tool: \`activity_list\`. Filter by \`categories\` (comma-separated), \`actorType\`,
  \`actorId\`, and a time window (\`before\` / \`since\` ISO timestamps). Paginate with
  \`limit\` and the returned \`nextCursor\`.
- CLI: \`dorkos activity [--actor <type>] [--category <name>] [--type <event>]
  [--limit <n>] --json\`.
  - \`--actor\` is one of \`user\`, \`agent\`, \`system\`, \`tasks\`.
  - \`--category\` accepts comma-separated names.
  - \`--type\` narrows to a single event type (e.g. \`agent.registered\`).
  - \`--limit\` defaults to 50, max 100.
- By capability id, from any runtime:
  \`dorkos call operator.activity_list --input '{"limit":20}'\`

Each event carries when it happened, the actor, its category, an event type, and
a one-line summary. Reading the feed does not change anything.

## Which agents were active recently

- Tool: \`agents_recent_activity\` returns each agent joined with the timestamp of
  its most recent session, newest first: the same map the cockpit uses for
  "recently active".
- By capability id: \`dorkos call operator.agents_recent_activity\`

Use this when the user asks "which of my agents have been busy?" rather than
scanning the whole feed.

## Your own actions show up here

When DorkOS knows which agent you are, running a capability that changes
something records an event against you: \`actorType: agent\`, with event type
\`capability.invoked\` or \`capability.failed\`. Filter with \`--actor agent\` to
review what agents have been doing.

DorkOS knows who you are in two ways: inside a Claude Code session it reads your
identity from the session's working directory, and from a shell it reads the
identity token in your environment. When neither applies, your calls still run
normally, but NOTHING is recorded for them: there is no nameless entry, there is
no entry. OpenCode sessions are always in this position today. So never tell the
user to look in the feed for something you just did unless you know your session
is attributed. Say what you did instead.

## Summarizing well

When asked for a summary:

1. Pull the relevant slice: filter by actor, category, or time window instead of
   dumping everything.
2. Group by what the user cares about (per agent, per task, per day).
3. Report in plain language, newest first, and call out anything that failed.
4. If the feed is large, page with \`nextCursor\` / \`--limit\` rather than guessing.

Activity is read-only. Answering a "what happened" question should never mutate
state, only read.`,
};
