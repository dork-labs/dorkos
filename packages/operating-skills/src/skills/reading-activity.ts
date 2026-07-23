import type { OperatingSkill } from '../pack.js';

/** Teaches an agent to read the activity feed and recent-agent activity. */
export const readingActivity: OperatingSkill = {
  name: 'reading-activity',
  description:
    'Use when the user asks what has been happening, what an agent did recently, which agents ' +
    'were active lately, or for a summary of recent events. Covers reading the activity feed with ' +
    'filters and the recent-agent activity map.',
  body: `# Reading activity

DorkOS records events (agent lifecycle, tasks, relay messages, config changes,
system events) in an activity feed. Read it to answer "what happened?" — never
invent events.

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

Each event carries when it happened, the actor, its category, an event type, and
a one-line summary. Reading the feed does not change anything.

## Which agents were active recently

- Tool: \`agents_recent_activity\` returns each agent joined with the timestamp of
  its most recent session, newest first — the same map the cockpit uses for
  "recently active".

Use this when the user asks "which of my agents have been busy?" rather than
scanning the whole feed.

## Summarizing well

When asked for a summary:

1. Pull the relevant slice — filter by actor, category, or time window instead of
   dumping everything.
2. Group by what the user cares about (per agent, per task, per day).
3. Report in plain language, newest first, and call out anything that failed.
4. If the feed is large, page with \`nextCursor\` / \`--limit\` rather than guessing.

Activity is read-only. Answering a "what happened" question should never mutate
state — only read.`,
};
