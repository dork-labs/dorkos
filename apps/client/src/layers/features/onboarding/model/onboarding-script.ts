/**
 * The scripted onboarding conversation as data (ADR 260722-111314).
 *
 * DorkBot's side of the first-run dialogue is a fixed sequence of beats. Each
 * beat opens with one or more authored lines (from `@dorkos/shared`), optionally
 * shows an inline widget, and either auto-advances or waits for the user. This
 * module is pure and unit-testable; all timing, state, and side effects live in
 * `use-onboarding-conversation`.
 *
 * @module features/onboarding/model/onboarding-script
 */
import { DORKBOT_ONBOARDING_LINES, generateVoiceSample } from '@dorkos/shared/dorkbot-templates';
import type { Traits } from '@dorkos/shared/mesh-schemas';
import type { ChatMessage, GroupPosition, MessageGrouping } from '@/layers/shared/model';

/** The ordered beats of the onboarding conversation. */
export const BEAT_ORDER = ['arrival', 'personality', 'discovery', 'handoff'] as const;

/** One beat of the scripted conversation. */
export type BeatId = (typeof BEAT_ORDER)[number];

/** A single beat: its opening lines and the inline affordance it shows. */
export interface OnboardingBeat {
  id: BeatId;
  /** DorkBot lines revealed when the beat opens. */
  lines: readonly string[];
  /** The inline widget shown once the beat's lines have all revealed. */
  widget?: 'personality' | 'discovery';
  /** Whether the real composer is enabled during this beat. */
  composerEnabled: boolean;
}

/**
 * The beats, in order. Arrival opens with DorkBot's greeting and rolls straight
 * into the personality prompt; the last beat (handoff) is the only one whose
 * composer is live.
 */
export const ONBOARDING_BEATS: readonly OnboardingBeat[] = [
  {
    id: 'arrival',
    lines: [...DORKBOT_ONBOARDING_LINES.arrival],
    composerEnabled: false,
  },
  {
    id: 'personality',
    lines: [DORKBOT_ONBOARDING_LINES.personalityPrompt],
    widget: 'personality',
    composerEnabled: false,
  },
  {
    id: 'discovery',
    lines: [DORKBOT_ONBOARDING_LINES.discoveryPrompt],
    widget: 'discovery',
    composerEnabled: false,
  },
  {
    id: 'handoff',
    lines: [DORKBOT_ONBOARDING_LINES.handoffPrompt],
    composerEnabled: true,
  },
];

/** Look up a beat by id. */
export function getBeat(id: BeatId): OnboardingBeat {
  const beat = ONBOARDING_BEATS.find((b) => b.id === id);
  if (!beat) throw new Error(`Unknown onboarding beat: ${id}`);
  return beat;
}

/**
 * DorkBot's one-sentence sample line in the voice of the chosen personality.
 * Delegates to the shared template so the copy lives in one place.
 *
 * @param traits - The personality traits currently selected in the picker.
 * @param presetId - The selected preset's id, when a named preset (not Custom) is picked.
 */
export function voiceSampleFor(traits: Traits, presetId?: string): string {
  return generateVoiceSample(traits, presetId);
}

/**
 * Build a scripted chat message renderable by the real message components.
 *
 * @param id - Stable message id (used to swap the voice-sample bubble in place).
 * @param role - Who is speaking.
 * @param text - The message text (rendered as a single text part).
 */
export function buildScriptMessage(
  id: string,
  role: 'user' | 'assistant',
  text: string
): ChatMessage {
  return {
    id,
    role,
    content: text,
    parts: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
  };
}

/**
 * Compute per-message grouping for the message list, grouping consecutive
 * same-role messages so the real `MessageItem` styling reads correctly.
 *
 * @param messages - The revealed messages, in order.
 */
export function computeGrouping(messages: readonly ChatMessage[]): MessageGrouping[] {
  const result: MessageGrouping[] = [];
  let groupIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    const role = messages[i].role;
    const prevSame = i > 0 && messages[i - 1].role === role;
    const nextSame = i < messages.length - 1 && messages[i + 1].role === role;
    if (!prevSame) groupIndex++;
    let position: GroupPosition;
    if (!prevSame && !nextSame) {
      position = 'only';
    } else if (!prevSame) {
      position = 'first';
    } else if (nextSame) {
      position = 'middle';
    } else {
      position = 'last';
    }
    result.push({ position, groupIndex });
  }
  return result;
}
