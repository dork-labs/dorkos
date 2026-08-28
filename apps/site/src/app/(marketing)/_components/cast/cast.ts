import type { ComponentType } from 'react';
import { AnthropicLogo, CodexLogo, OpenCodeLogo } from '@dorkos/icons/adapter-logos';

/** Stable key for each speaker, used as a chat sender and a layout id. */
export type CastKey = 'otto' | 'pip' | 'hal';

/** Everyone who can speak in the demo chat: the three agents, plus Dave. */
export type SpeakerKey = CastKey | 'dave';

/** One face in the demo chat. `K` narrows it to the agents, or to Dave alone. */
export interface CastMember<K extends SpeakerKey = SpeakerKey> {
  key: K;
  /** Display name. The film sets these uppercase on its name tags; we do that in CSS. */
  name: string;
  /** Identity colour: the avatar ring, and the name above the bubble. */
  ring: string;
  /** Looping face, 720x720, no audio track. */
  loop: string;
  /** First-frame still, used as the poster and as the reduced-motion face. */
  still: string;
  /**
   * Relative size of this face against the others.
   *
   * Only Pip differs, at 0.86, and it is narrative rather than layout. Six
   * generation batches failed to make Pip read as the small one, because equal
   * circular crops defeat it, so the film fixes it in code. 0.86 and not 0.80:
   * in a row of aligned avatars 0.8 reads as a bug rather than a small robot.
   */
  sizeScale: number;
}

/** Which coding-agent runtime an agent runs on, plus its brand mark. */
export interface AgentRuntime {
  runtime: string;
  RuntimeLogo: ComponentType<{ size?: number; className?: string }>;
  runtimeColor: string;
}

/**
 * The three agents from the film, in the order they arrive in it.
 *
 * Names, colours and sizes are locked by the film's `characters.md` and are not
 * ours to re-pick: Otto is the doer, Pip the small eager one, Hal the straight
 * man who barely speaks. The colours come from `chat-ui.tsx` (see
 * `film-tokens.ts` for why two of them are not brand tokens).
 */
export const CAST: readonly CastMember<CastKey>[] = [
  {
    key: 'otto',
    name: 'Otto',
    ring: '#e8801f',
    loop: '/promo/cast/otto.mp4',
    still: '/promo/cast/otto.jpg',
    sizeScale: 1,
  },
  {
    key: 'pip',
    name: 'Pip',
    ring: '#4a90a4',
    loop: '/promo/cast/pip.mp4',
    still: '/promo/cast/pip.jpg',
    sizeScale: 0.86,
  },
  {
    key: 'hal',
    name: 'Hal',
    ring: '#c9b458',
    loop: '/promo/cast/hal.mp4',
    still: '/promo/cast/hal.jpg',
    sizeScale: 1,
  },
];

/**
 * Dave, the person in the chat.
 *
 * His ring is the brand accent rather than a lane colour, because he is the
 * user and not an agent, and the ring is how you tell those apart at a glance.
 */
export const DAVE: CastMember<'dave'> = {
  key: 'dave',
  name: 'Dave',
  ring: '#e85d04',
  loop: '/promo/cast/dave.mp4',
  still: '/promo/cast/dave.jpg',
  sizeScale: 1,
};

/**
 * Which runtime powers which agent.
 *
 * This mapping is the page's own invention, not the film's: the film's agents
 * have personalities, not runtimes. It is here because running Claude Code,
 * Codex and OpenCode side by side in one window is the product's headline
 * difference, and the badges are what say so without a sentence. Reassigning
 * any of the three is a one-line change and breaks nothing.
 */
export const RUNTIMES: Record<CastKey, AgentRuntime> = {
  otto: { runtime: 'Claude Code', RuntimeLogo: AnthropicLogo, runtimeColor: '#d97757' },
  pip: { runtime: 'Codex', RuntimeLogo: CodexLogo, runtimeColor: '#f5f0e6' },
  hal: { runtime: 'OpenCode', RuntimeLogo: OpenCodeLogo, runtimeColor: '#4cc38a' },
};

/** Everyone in the chat, keyed for direct lookup by sender. */
export const SPEAKERS: Record<SpeakerKey, CastMember> = {
  dave: DAVE,
  ...Object.fromEntries(CAST.map((member) => [member.key, member])),
} as Record<SpeakerKey, CastMember>;
