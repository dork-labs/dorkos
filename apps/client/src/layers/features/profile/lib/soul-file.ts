/**
 * SOUL.md, composed — the one place the profile decides what that file should
 * say (spec `profile-unification` §1.4, §1.5).
 *
 * The file is two halves: a generated trait block between markers, and the
 * prose a person wrote under it. **Both editors that touch it have to write the
 * whole file**, because whichever half they are not editing still has to be
 * there afterwards — the Instructions page keeps the traits it is not changing,
 * and the personality pickers keep the prose they never showed.
 *
 * @module features/profile/lib/soul-file
 */
import type { Traits } from '@dorkos/shared/mesh-schemas';
import { buildSoulContent, extractCustomProse } from '@dorkos/shared/convention-files';
import { DEFAULT_TRAITS, renderTraits } from '@dorkos/shared/trait-renderer';

/**
 * SOUL.md as it should be on disk for these traits and this prose.
 *
 * @param traits - The agent's traits, partial or whole — the rest default.
 * @param prose - What the operator wrote, without the trait block.
 */
export function soulFile(traits: Partial<Traits> | undefined, prose: string): string {
  return buildSoulContent(renderTraits({ ...DEFAULT_TRAITS, ...traits }), prose);
}

/**
 * The update that changes an agent's personality.
 *
 * **The manifest is not enough.** A turn only gets the new traits if SOUL.md
 * already carries the trait markers — `agent-context.ts` regenerates the block
 * in place and does nothing when there is no block to regenerate — so an agent
 * whose SOUL.md was hand-written, or absent, kept talking exactly as before
 * while the profile showed the personality you picked (DOR-1253). Writing the
 * file alongside the manifest is what the retired panel always did, and what makes
 * the change reach the prompt.
 *
 * @param agent - The manifest as read, for the prose already in the file.
 * @param traits - The traits just picked.
 */
export function personalityUpdate(
  agent: { soulContent?: string | null },
  traits: Traits
): { traits: Traits; soulContent: string } {
  return { traits, soulContent: soulFile(traits, extractCustomProse(agent.soulContent ?? '')) };
}
