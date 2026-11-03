/**
 * One agent's Block Buddy, as a still pose (DOR-3065).
 *
 * @module shared/ui/block-buddy
 */
import { memo } from 'react';
import type { BuddyRenderer } from '@/layers/shared/lib/block-buddy/store';
import { useIsMobile } from '@/layers/shared/model';
import type { IdentityStatus } from './status-dot';

interface BlockBuddyProps {
  /** The loaded renderer. Holding it here keeps the package out of the entry chunk. */
  renderer: BuddyRenderer;
  /** The agent's id. */
  seed: string;
  /** The tile's side in pixels. Under 24 draws the mini face crop. */
  size: number;
  /** The side on a phone, where the slot differs. Same face, more of the buddy. */
  phoneSize?: number;
  /** The pose to hold. A state never changes the face, only the pose. */
  status: IdentityStatus;
}

/**
 * Draws the buddy from the renderer's cache, filling its parent.
 *
 * `dangerouslySetInnerHTML` is safe here: the renderer's only input is a hash of
 * the agent's id, so no user string can reach this markup.
 */
export const BlockBuddy = memo(function BlockBuddy({
  renderer,
  seed,
  size,
  phoneSize,
  status,
}: BlockBuddyProps) {
  const isMobile = useIsMobile();
  const svg = renderer.drawBuddy(seed, isMobile && phoneSize ? phoneSize : size, status);
  if (svg === null) return null;
  return (
    <span
      aria-hidden
      data-slot="block-buddy"
      className="block size-full rounded-[inherit] [&>svg]:block [&>svg]:size-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
});
