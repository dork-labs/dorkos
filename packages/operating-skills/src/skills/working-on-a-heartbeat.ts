import type { OperatingSkill } from '../pack.js';
import { TOOL_NAME_NOTE } from '../tool-name-note.js';

/**
 * Teaches an agent how to work a heartbeat: what a beat is, how to end one with
 * `end_beat`, which rung to raise on, what urgent means, pace, resolved,
 * reports and commitments (spec `heartbeats` §8, §9, canon PROACTIVE-AGENTS P3
 * to P6).
 */
export const workingOnAHeartbeat: OperatingSkill = {
  name: 'working-on-a-heartbeat',
  description:
    'Use when a turn says it is a heartbeat, when ending a beat, when deciding whether and how ' +
    'loudly to tell someone what you found or did, when writing your regular report, or when ' +
    "checking on another agent's beats. Covers end_beat (summary, raises, rungs, urgent, pace, " +
    'resolved, report), commitments during a beat, and heartbeat_status.',
  body: `# Working on a heartbeat

${TOOL_NAME_NOTE}

## What a beat is

DorkOS wakes you on your own, on a timer or when something happens: a message
to you, a failed run, a promise coming due. That turn is a **beat**. The prompt
says so, lists what changed since your last beat, your open promises, and the
raises you are still waiting on. Nobody is waiting on a reply.

Most beats find nothing. That is a good beat. Silence costs nothing; noise
costs a lot.

## Proactive in work, quiet in speech

Initiative shows up as finished work and a line in the record, not as messages.
For each thing you find, pick one move:

- **Act**: it is inside your job and you are confident. Do it.
- **Act, then tell**: you acted, and someone would want to know soon (it affects
  their work, spends money, speaks for the business, or cannot be undone).
- **Ask**: the call belongs to someone else: taste, strategy, a relationship,
  spending past your limit, a promise to an outsider, work outside your role.
- **Stay quiet**: nothing changed, nothing is at risk, or someone has it.

Would a competent person in your job ask their manager about this? If not, act.
Never message someone just to show you checked.

## End every beat with end_beat

A beat ends with \`end_beat\`, once. **Nothing else you write in a beat reaches
anyone.** Free text in the beat chat goes nowhere.

- \`summary\`: the record line, under 200 characters. "Sent Acme the second
  reminder." or "Checked 4 things. Nothing new."
- \`raises\`: what to tell people, at most 10. Each has \`text\` (written for a
  busy reader), \`rung\`, optional \`to\` (absent means your manager),
  \`urgent\`, and \`about\` (the change keys from the prompt it is about).

If nothing needs anyone, call it with just a summary. A beat that ends without
\`end_beat\` delivers nothing and counts against you.

## Pick the quietest rung that works

1. **The record**: your summary. Always.
2. \`report\`: saved for your next regular report.
3. \`room\`: a post in \`roomId\` now, when people there need it now.
4. \`dm\`: a direct message to the one person who must act.
5. \`note\`: a note that leaves the app, for what a person would want to be
   interrupted for.

Most beats end on rung 1. A raise to another agent arrives as a message at once.

## Urgent means a person must act now

Money or data still at risk, a security problem still open, a customer being
harmed, or a hard deadline that will be missed without them. A problem you
already fixed is not urgent, however serious it was: it goes in your report.

Messages to people wait for their working hours unless \`urgent: true\`. Several
raises due together arrive as one message. Work with other agents has no quiet
hours. If your manager is away, messages wait for their return; an urgent one
still goes now.

## Raise once, then resolve

The prompt lists the raises you are still waiting on, each with its key. Do not
raise them again: DorkOS moves a repeat into your next report. When one is
settled (you fixed it, or they answered), list its key in \`resolved\`. A reply
in the DM it landed in closes it too.

Give a raise a stable \`key\` when the same fact may come up again, so the same
news is never sent twice.

## Pace

When something needs watching closely for a while (a deploy, a payment retry),
ask for faster beats: \`pace: { everyMinutes, untilIso, why }\`, 5 to 60
minutes, for at most 12 hours. It ends on its own.

## Your report

On a report beat the prompt says so and lists what is saved for it and what your
beats did since the last one. Say what your reader has not already seen:
finished, in progress, at risk, needed, one line each, unless your HEARTBEAT.md
sets another shape. Pass it as \`report\`. If nothing is worth their time, pass
\`report: null\` and it all waits. \`report\` works on report beats only.

When the prompt says who you report to changed, open your next message to them
with how you report and ask what they would rather see.

## Promises

Once you promise something, record it with \`commitment_add\`. When a promise
comes due you are woken for it; mark it kept with \`commitment_update\`, or move
the date and tell the person. A promise to an outsider (a date, a price, a
discount) is an ask first.

## Checking on other agents

\`heartbeat_status\` reads any agent's heartbeat: how it wakes, its last beats,
how many messages are held, and its measures (work that stuck, useful messages,
interruptions per useful outcome, mutes and pauses). A lead reads its reports'
this way. A target is a bet to compare against, not a grade.

## Your HEARTBEAT.md

\`.dork/HEARTBEAT.md\` in your folder says what you watch, how you judge, what
you never do unasked, and the shape of your report. Edits apply on your next
beat. With no file you wake only when something happens.
`,
};
