/**
 * The home page: a short hero, the 56-second film, the turn out of it, and a
 * scroll-driven animation around one live chat that proves the film's promise.
 *
 * Route-private by Next's `_` convention. Inside the folder the parts import
 * each other by relative path; this barrel is the door for the two readers
 * outside it — `(marketing)/page.tsx`, and the `/test/storyboard` design
 * surface that drives these same components so it cannot drift from what
 * ships. It therefore exports only what those two ask for, and grows when
 * they do.
 *
 * The parts are grouped by what they draw: `cast/` the faces and their bridge
 * cards, `film/` the player and its cuts, `chat/` the conversation, `dock/`
 * the tiles that fly out of it, `macbook/` the machine it lands in, `stage/`
 * the scroll-driven animation that runs all of that, `tutorials/` the clips
 * rail, and `nav/` the pill. What is left at the top level is the page's own
 * spine — its sections, its words and its two calls to action.
 *
 * @module app/(marketing)/_components
 */

// The page
export { HomeExperience } from './HomeExperience';
export { ExtensionNoiseGuard } from './ExtensionNoiseGuard';
export { HomeNav } from './nav';
export { INSTALL_COMMAND, MACBOOK } from './theme';

// Pieces the storyboard pins, one frame at a time
export { Hero } from './Hero';
export { FilmSection } from './film/FilmSection';
export { CastBridge } from './cast/CastBridge';
export { CloseSection } from './CloseSection';
export { BeatHeadline } from './BeatHeadline';
export { ChatWindow } from './chat/ChatWindow';
export { MacbookFrame } from './macbook/MacbookFrame';
export { Dock } from './dock/Dock';
export { Avatar } from './cast/Avatar';

// The data and timing the storyboard reads, so its numbers are the live ones
export { CAST, DAVE, RUNTIMES } from './cast/cast';
export { DOCK } from './dock/dock-apps';
export { CHAT_SCRIPT, PART_ONE_COUNT } from './chat/chat-script';
export { nextBeat, type Beat } from './stage/beats';
export { SEAT_LIFT } from './macbook/macbook-geometry';
export {
  STAGE_TIMING,
  captionOpacityAt,
  chatScaleAt,
  layBackAt,
  machineArrivalAt,
  machineOpacityAt,
  seatAt,
} from './stage/stage-timing';
