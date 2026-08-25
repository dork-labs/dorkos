/**
 * The dorkos.ai home page: one continuous, scroll-driven animation built
 * around a single live chat, plus the promo film and the close.
 *
 * Route-private to `/` by Next's `_` convention. Inside the folder the parts
 * import each other by relative path; this barrel is the door for the two
 * readers outside it — `page.tsx`, and the `/test/storyboard` design surface
 * that drives these same components so it cannot drift from what ships. It
 * therefore exports only what those two ask for, and grows when they do.
 *
 * @module app/(marketing)/_components
 */

// The page
export { HomeExperience } from './HomeExperience';
export { PageNav } from './PageNav';
export { ExtensionNoiseGuard } from './ExtensionNoiseGuard';
export { NIGHT_VARS, INSTALL_COMMAND, SHELL } from './theme';

// Pieces the storyboard pins, one frame at a time
export { Hero } from './Hero';
export { CloseSection } from './CloseSection';
export { BeatHeadline } from './BeatHeadline';
export { ChatWindow } from './ChatWindow';
export { LaptopFrame } from './LaptopFrame';
export { Dock } from './Dock';
export { AvatarTile } from './AvatarTile';
export { HumanFace } from './avatars';

// The data and timing the storyboard reads, so its numbers are the live ones
export { CAST, type CastMember } from './cast';
export { DOCK } from './dock-apps';
export { CHAT_SCRIPT, PART_ONE_COUNT } from './chat-script';
export { nextBeat, type Beat } from './beats';
export { STAGE_TIMING, chatScaleAt, shellOpacityAt, captionOpacityAt } from './stage-timing';
