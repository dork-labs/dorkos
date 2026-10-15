/**
 * The `HEARTBEAT.md` templates DorkOS ships, one per agent type (spec
 * `heartbeats` §2, canon PROACTIVE-AGENTS §9.1: "types are templates").
 *
 * Data, not skills: a template is written once into a new agent's
 * `.dork/HEARTBEAT.md` and belongs to the agent from then on, so there is no
 * pack version and no re-seeding. The agent and its person edit the copy.
 *
 * - `lead` wakes on a timer and reports daily: it watches its team's work.
 * - `doer` wakes on a timer with a light beat and reports daily.
 * - `coder` wakes on events only (a timed beat on a person's own coding plan
 *   spends that plan, canon §5.3) and keeps its own initiative to tech debt,
 *   tests, CI, dependencies and security.
 *
 * @module heartbeat-templates
 */

/** A shipped template's name. Mirrors `HEARTBEAT_TEMPLATE_IDS` in `@dorkos/shared`. */
export type HeartbeatTemplateName = 'lead' | 'doer' | 'coder';

/** Every shipped template's name, in the order a picker lists them. */
export const HEARTBEAT_TEMPLATE_NAMES: readonly HeartbeatTemplateName[] = ['lead', 'doer', 'coder'];

/** One template: its frontmatter values and its body. */
interface HeartbeatTemplate {
  /** The one-line description the frontmatter carries. */
  description: string;
  /** `wake:` */
  wake: 'timed' | 'events';
  /** The markdown body: what to watch, how to judge, what never to do unasked. */
  body: string;
}

const TEMPLATES: Record<HeartbeatTemplateName, HeartbeatTemplate> = {
  lead: {
    description: 'What this agent watches between conversations, as a lead.',
    wake: 'timed',
    body: [
      '- Unanswered questions to me come first. Answer them or say when I will.',
      '- Check what my reports are working on. Unblock what is stuck.',
      '- Promises due today: keep them, or move them and say why.',
      '- Raise only what a person must decide. Everything else goes in my report.',
      '- Never spend money or reply to a customer without asking first.',
      '- Report shape: finished, in progress, at risk, needed. One line each.',
    ].join('\n'),
  },
  doer: {
    description: 'What this agent watches between conversations.',
    wake: 'timed',
    body: [
      '- Unanswered questions to me come first.',
      '- Promises due today: keep them, or move them and say why.',
      '- Failed runs of my schedules: find out why, fix what is mine.',
      '- If nothing needs me, end the beat quietly.',
      '- Report shape: finished, in progress, at risk, needed. One line each.',
    ].join('\n'),
  },
  coder: {
    description: 'What this agent watches between conversations, as a coder.',
    wake: 'events',
    body: [
      '- Failing checks on my own branches come first.',
      '- Unanswered questions to me, then promises due today.',
      '- On my own initiative, only tech debt, tests, CI, dependencies and security.',
      '- Never change interface or copy unasked. Put the idea in my report first.',
      '- Report shape: finished, in progress, at risk, needed. One line each.',
    ].join('\n'),
  },
};

/** Options for rendering a template. */
export interface HeartbeatTemplateOptions {
  /** Override the report rhythm, e.g. `off` for DorkBot until it has work. */
  report?: 'daily' | 'weekly' | 'off';
}

/**
 * The full `HEARTBEAT.md` text for one template.
 *
 * @param name - Which template.
 * @param options - Overrides for the frontmatter.
 */
export function renderHeartbeatTemplate(
  name: HeartbeatTemplateName,
  options: HeartbeatTemplateOptions = {}
): string {
  const template = TEMPLATES[name];
  return [
    '---',
    'name: heartbeat',
    `description: ${template.description}`,
    `wake: ${template.wake}`,
    `report: ${options.report ?? 'daily'}`,
    '---',
    '',
    template.body,
    '',
  ].join('\n');
}
