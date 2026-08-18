/**
 * What one prompt is asking for, in the agent's own terms — the half-sentence
 * that follows an agent's name.
 *
 * One phrasing, two readers: the sidebar's Heads up row prints it as the
 * secondary line, and `features/ask`'s headline puts the agent's name in front
 * of it ("Meeting Notes wants to edit standup.md"). A second copy would be a
 * second vocabulary for one fact.
 *
 * **It never invents.** The SDK prompt carries a title, a display name, a
 * description and a blocked path; a diff stat, a preview and a verb for a tool
 * that named none are not among them. Each rung below is something the prompt
 * actually said, and the last one says only that a tool wants to run.
 *
 * @module entities/attention/model/describe-interaction
 */
import type { PendingInteractionDTO } from '@dorkos/shared/types';
import { getToolLabel } from '@/layers/shared/lib';

/**
 * A label that says more than the tool's own name, or nothing.
 *
 * The test is the same for both sources and that is the point. `getToolLabel`
 * is the transcript's own phrasing — "Edit standup.md", "Run 'npm test'" — and
 * it falls back to echoing the tool name when the input tells it nothing. **The
 * SDK's `displayName` does exactly the same thing**: for a `Write` it is the
 * bare word "Write", which produced "dorkbot wants to write" with no file in it
 * on every fleet-wide card (DOR-1330 review). So a candidate that merely
 * repeats the tool name is treated as absent, and the next rung runs.
 *
 * @param candidate - The label to weigh, when there is one.
 * @param toolName - The tool being asked about.
 */
function informative(candidate: string | undefined, toolName: string): string | undefined {
  if (candidate === undefined) return undefined;
  return candidate.trim().toLowerCase() === toolName.trim().toLowerCase() ? undefined : candidate;
}

/**
 * What to call the agent behind a prompt when nothing has resolved its name.
 *
 * The last segment of the working directory, which is what the operator calls it
 * anyway. The wire carries no name on purpose — a copied name goes stale the
 * moment an agent is renamed — so this is the honest floor, and a surface that
 * holds the roster passes the real name instead.
 *
 * @param cwd - The session's working directory.
 */
export function agentNameFromCwd(cwd: string): string {
  return basename(cwd);
}

/** The last segment of a path — what a person calls the file, or the folder. */
function basename(filePath: string): string {
  return filePath.split('/').filter(Boolean).pop() ?? filePath;
}

/** Lower the first letter, so a label reads as the tail of a sentence. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * What this prompt is asking for, as a phrase that follows an agent's name.
 *
 * @param interaction - The pending prompt.
 * @returns e.g. `wants to edit standup.md`, `has a question`.
 */
export function describeInteraction(interaction: PendingInteractionDTO): string {
  if (interaction.type === 'question') return 'has a question';
  if (interaction.type === 'elicitation') {
    return `needs something from ${interaction.serverName}`;
  }
  const action =
    informative(interaction.displayName, interaction.toolName) ??
    informative(getToolLabel(interaction.toolName, interaction.input), interaction.toolName);
  if (action !== undefined) return `wants to ${lowerFirst(action)}`;
  if (interaction.blockedPath !== undefined) {
    return `needs your OK for ${basename(interaction.blockedPath)}`;
  }
  return `needs your OK to run ${interaction.toolName}`;
}
