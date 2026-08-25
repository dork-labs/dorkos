/**
 * Components and data for the dorkos.ai home page: one continuous,
 * scroll-driven animation built around a single live chat, plus the promo
 * video and the close.
 *
 * Route-private to `/` by Next's `_` convention. The only other reader is the
 * `/test/storyboard` design surface, which drives these same components so it
 * cannot drift from what ships.
 *
 * @module app/(marketing)/_components
 */

// Page composition
export { HomeExperience } from './HomeExperience';
export { PageNav } from './PageNav';
export { ExtensionNoiseGuard } from './ExtensionNoiseGuard';
export { Hero } from './Hero';
export { StageSection } from './StageSection';
export { PromoSection } from './PromoSection';
export { PromoPlayer } from './PromoPlayer';
export { CloseSection } from './CloseSection';

// Stage pieces
export { BeatHeadline } from './BeatHeadline';
export { ChatWindow } from './ChatWindow';
export { ChatHeader } from './ChatHeader';
export { ChatMessage } from './ChatMessage';
export { SystemMessage } from './SystemMessage';
export { TypingDots } from './TypingDots';
export { IntegrationBadge } from './IntegrationBadge';
export { LaptopFrame } from './LaptopFrame';
export { AppDock } from './AppDock';
export { DockSlot } from './DockSlot';
export { AgentCard } from './AgentCard';
export { AvatarTile, type TileSize } from './AvatarTile';
export { Eyebrow } from './Eyebrow';
export { InstallCommand } from './InstallCommand';
export { DownloadMacButton } from './DownloadMacButton';
export { AppleLogo } from './AppleLogo';

// Cartoon faces
export { RosieFace, JohnnyFiveFace, WalleFace, HumanFace, type FaceProps } from './avatars';

// Data and hooks
export { CAST, AGENTS_BY_KEY, type CastMember, type AgentKey } from './cast';
export {
  INTEGRATIONS,
  findIntegration,
  integrationLayoutId,
  type Integration,
  type IntegrationId,
} from './integrations';
export {
  CHAT_SCRIPT,
  PART_ONE_COUNT,
  isAgentLine,
  senderName,
  senderColor,
  agentLayoutId,
  type ChatLine,
  type Sender,
} from './chat-script';
export { BEAT_COPY, nextBeat, type Beat, type BeatCopy } from './beats';
export { NIGHT_VARS, INSTALL_COMMAND, SHELL } from './theme';
export {
  PROMO_CUTS,
  PROMO_CAPTIONS,
  PROMO_SECONDS,
  PROMO_POSTER_ALT,
  PHONE_CUT_QUERY,
  type PromoCut,
  type PromoAssets,
} from './promo-cuts';
export { POP, clamp01, ramp } from './motion-tokens';
export { STAGE_TIMING, chatScaleAt, shellOpacityAt, captionOpacityAt } from './stage-timing';
export { useChatPlayback, type ChatPlayback } from './use-chat-playback';
export { useSectionProgress } from './use-section-progress';
