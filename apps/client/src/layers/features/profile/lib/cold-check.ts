/**
 * The cold check behind "Ask {agent}" (DOR-4115): the first message of a new
 * chat that asks an agent what it thinks it can do in DorkOS before it looks,
 * then has it check its real levels and name every place it was wrong.
 *
 * "Cold" is the point. The answer it gives before any tool call is what it
 * would act on in a real turn, so a gap between that answer and the list on
 * its profile is a gap in what it was told, not a typo in the list.
 *
 * @module features/profile/lib/cold-check
 */

/**
 * The cold-check prompt for one agent.
 *
 * Names the permissions tool by the end of its name only: each runtime reaches
 * DorkOS tools under its own prefix, and the agent knows its own.
 *
 * @param agentName - The agent's display name, so the check reads as addressed to it.
 */
export function coldCheckPrompt(agentName: string): string {
  return [
    `${agentName}, a quick check of what you know about yourself.`,
    '',
    '1. Without calling any tool or reading any file, list what you can do in DorkOS, area by area. For each, say whether you think it is Allowed, Ask or Blocked for you, or what else decides it.',
    '2. Then call the DorkOS tool whose name ends in `list_my_permissions` and compare.',
    '3. Finish with a short list of every place your first answer was wrong or missing, or say it matched.',
  ].join('\n');
}
