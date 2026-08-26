/**
 * `/new`: a short hero, the 56-second film, the turn out of it, and a
 * scroll-driven animation around one live chat that proves the film's promise.
 *
 * This is where the next home page is being worked out. The published home
 * page at `/` is a different composition entirely and shares nothing here.
 *
 * Route-private by Next's `_` convention. Inside the folder the parts import
 * each other by relative path; this barrel is the door for the two readers
 * outside it — `new/page.tsx`, and the `/test/storyboard` design surface that
 * drives these same components so it cannot drift from what ships. It
 * therefore exports only what those two ask for, and grows when they do.
 *
 * @module app/(marketing)/new/_components
 */

// The page
export { HomeExperience } from './HomeExperience';
export { ExtensionNoiseGuard } from './ExtensionNoiseGuard';
export { HomeNav } from './nav';
export { FOOTER_SOCIAL_LINKS } from './footer-social-links';
export { INSTALL_COMMAND, MACBOOK } from './theme';

// Pieces the storyboard pins, one frame at a time
export { Hero } from './Hero';
export { FilmSection } from './FilmSection';
export { CastBridge } from './CastBridge';
export { CloseSection } from './CloseSection';
export { BeatHeadline } from './BeatHeadline';
export { ChatWindow } from './ChatWindow';
export { MacbookFrame } from './MacbookFrame';
export { Dock } from './Dock';
export { Avatar } from './Avatar';

// The data and timing the storyboard reads, so its numbers are the live ones
export { CAST, DAVE, RUNTIMES } from './cast';
export { DOCK } from './dock-apps';
export { CHAT_SCRIPT, PART_ONE_COUNT } from './chat-script';
export { nextBeat, type Beat } from './beats';
export { SEAT_LIFT } from './macbook-geometry';
export {
  STAGE_TIMING,
  captionOpacityAt,
  chatScaleAt,
  layBackAt,
  machineArrivalAt,
  machineOpacityAt,
  seatAt,
} from './stage-timing';
