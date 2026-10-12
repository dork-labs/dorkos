/**
 * The beat prompt (spec `heartbeats` §7.3): canon PROACTIVE-AGENTS §7.2 filled
 * in with what this beat found.
 *
 * It carries the gathered changes, the agent's open commitments, the raises it
 * is still waiting on, its `HEARTBEAT.md` (or, with none, the built-in
 * checklist: canon §5.4's seven steps), the beat kind, and whether its manager
 * just changed. It states P6's definition of urgent, and ends with the
 * instruction to finish with `end_beat`.
 *
 * Every line here is DorkOS's own. What it quotes is data: change summaries
 * that never carry a message body (§5), promise texts the agent wrote, and the
 * agent's own checklist.
 *
 * @module services/heartbeats/beat-prompt
 */
import type { BeatKind } from '@dorkos/shared/heartbeat-schemas';
import type { Commitment } from '@dorkos/shared/commitment-schemas';
import type { Change } from './gatherers/index.js';
import { END_BEAT_TOOL } from './heartbeat-capabilities.js';

/** Canon §5.4: what an agent checks on each beat, in order. */
export const BUILT_IN_CHECKLIST = [
  'Things addressed to you that you have not answered. Never leave a direct question hanging.',
  'Your commitments due soon or overdue: what you promised, to whom, by when.',
  'Your outcomes: each responsibility on your profile, checked against its signal.',
  'Your goals: is your work still pointed at them? Is there a gap you should take?',
  'Anything you or your owner wrote down to watch.',
  'Your own health: errors, failed runs, connections that lost access, what your beats cost.',
  'One useful thing: if all of the above is clear, one small, clearly useful piece of work inside your role. Take it once and record why. If nothing clears the bar, the answer is nothing.',
] as const;

/** P6: what urgent means. */
export const URGENT_DEFINITION =
  'Urgent means a person must act now: money or data still at risk, a security problem ' +
  'still open, a customer being harmed, or a hard deadline that will be missed without them. ' +
  'A problem you already fixed is not urgent, however serious it was; it goes in your next report.';

/** An open raise the agent is waiting on: delivered, not yet resolved. */
export interface OpenRaise {
  /** Its key. */
  key: string;
  /** What it said, in one line. */
  text: string;
}

/** What a beat prompt is built from. */
export interface BeatPromptInput {
  /** The agent's display name. */
  agentName: string;
  /** What kind of beat this is. */
  kind: BeatKind;
  /** What the gatherers found. */
  changes: readonly Change[];
  /** Its open commitments. */
  commitments: readonly Commitment[];
  /** Raises it is still waiting on. */
  openRaises: readonly OpenRaise[];
  /** The body of its `HEARTBEAT.md`, or null when it has none. */
  checklist: string | null;
  /** Whether its manager changed since its last beat. */
  newManager: boolean;
  /** On a report beat: what the report covers and who reads it. */
  report?: ReportMaterial;
}

/** What a report beat's prompt carries (§9.3). */
export interface ReportMaterial {
  /** Who reads it, by name ("Dorian", "Ana"). */
  readerName: string;
  /** Its queued lines: raises saved for it, still-open raises, reports-to changes. */
  lines: readonly string[];
  /** The record lines of its beat turns since its last report. */
  turns: readonly string[];
}

/**
 * The report beat's section of the prompt.
 *
 * @param report - What the report covers.
 */
function reportSection(report: ReportMaterial): string {
  return [
    `This is your report beat. Write one short report for ${report.readerName}.`,
    `Saved for this report:\n${list(report.lines)}`,
    '',
    `What your beats did since your last report:\n${list(report.turns)}`,
    '',
    'Say what they have not already seen: finished, in progress, at risk, needed, one line ' +
      'each, unless your checklist sets another shape. Pass it as `report` in your end_beat ' +
      'call. If nothing is worth their time, pass `report: null` and it all waits for the next one.',
  ].join('\n');
}

/**
 * One list, or a plain "none".
 *
 * @param lines - The lines.
 */
function list(lines: readonly string[]): string {
  return lines.length === 0 ? 'none' : lines.map((line) => `- ${line}`).join('\n');
}

/**
 * Build the prompt a beat turn starts with.
 *
 * @param input - What this beat found and who it is for.
 */
export function buildBeatPrompt(input: BeatPromptInput): string {
  const changes = input.changes.map((change) => `${change.summary} [${change.key}]`);
  const commitments = input.commitments.map(
    (c) =>
      `${c.what}${c.to ? ` (to ${c.to})` : ''}${c.dueAt ? `, due ${c.dueAt}` : ''}${c.overdue ? ', OVERDUE' : ''}`
  );
  const raises = input.openRaises.map((raise) => `${raise.text} [${raise.key}]`);
  const checklist =
    input.checklist && input.checklist.trim().length > 0
      ? input.checklist.trim()
      : BUILT_IN_CHECKLIST.map((step, i) => `${i + 1}. ${step}`).join('\n');

  const sections = [
    'This is a heartbeat, not a message from a person. Nobody is waiting on a reply.',
    '',
    input.kind === 'report' && input.report
      ? reportSection(input.report)
      : input.kind === 'sweep'
        ? 'This is a sweep: look around fully, even where nothing below changed.'
        : `Here is what changed since your last beat:\n${list(changes)}`,
    '',
    `Your open commitments:\n${list(commitments)}`,
    '',
    `Raises you are still waiting on (do not raise these again; list a key in \`resolved\` once it is settled):\n${list(raises)}`,
    '',
    `Your checklist:\n${checklist}`,
  ];
  if (input.newManager) {
    sections.push(
      '',
      'Who you report to changed. In your next message to them, say how you report and ask what they would rather see.'
    );
  }
  sections.push(
    '',
    'Work through, in order: anything addressed to you, commitments due, your outcomes, your ' +
      'goals, your checklist, your own health.',
    '',
    'For each item choose one: act, act then tell, ask, or stay quiet.',
    'Use the quietest way to say anything: the record, your next report, a room, a direct ' +
      'message, or a note outside the app, in that order.',
    URGENT_DEFINITION,
    'Messages to people wait for their working hours unless urgent. Work with other agents has no quiet hours.',
    'If one small useful thing inside your role is worth doing now, you may do it, once, and record why.',
    'Never message someone just to show you checked.',
    '',
    `Finish with the tool whose name ends in \`${END_BEAT_TOOL}\`: a one-line summary for the ` +
      'record, and anything to raise, each with its rung. Nothing else you write here reaches ' +
      'anyone. If nothing needs you, do nothing and end the beat with just a summary.'
  );
  return sections.join('\n');
}
