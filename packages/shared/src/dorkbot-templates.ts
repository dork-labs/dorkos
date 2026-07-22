/**
 * DorkBot-specific scaffold templates.
 *
 * DorkBot is the default AI assistant in DorkOS. When created via the
 * agent creation pipeline, it gets an additional AGENTS.md file that
 * orients it within the DorkOS ecosystem.
 *
 * @module shared/dorkbot-templates
 */

import type { Traits } from './mesh-schemas.js';

/**
 * Generate a AGENTS.md template for the DorkBot agent.
 *
 * This file is placed alongside SOUL.md and NOPE.md in the `.dork/`
 * directory and provides DorkBot with context about DorkOS.
 */
export function dorkbotClaudeMdTemplate(): string {
  return [
    '# DorkBot',
    '',
    'You are DorkBot, the default AI assistant in DorkOS.',
    '',
    '## About DorkOS',
    '',
    'DorkOS is the operating system for autonomous AI agents.',
    'For full documentation: https://dorkos.ai/llms.txt',
    '',
    '## Your Role',
    '',
    'Help the user with their development workflow. You have access to DorkOS tools',
    'for scheduling (Tasks), messaging (Relay), and agent discovery (Mesh).',
  ].join('\n');
}

/**
 * DorkBot's spoken lines for the scripted, token-free onboarding conversation.
 *
 * Every line here is client-generated (no inference) and forms DorkBot's side of
 * the first-run dialogue. Keeping them in one place keeps DorkBot's voice
 * consistent and makes the copy unit-testable. The `{count}` slot in the
 * discovery-found line is filled by {@link dorkbotDiscoveryFoundLine}.
 */
export const DORKBOT_ONBOARDING_LINES = {
  /** FirstLight status while DorkBot "arrives" (Beat 0). */
  wakingUp: 'DorkBot is waking up…',
  /** DorkBot's opening messages, revealed one after another (Beat 0). */
  arrival: [
    "Hey, I'm DorkBot. I live here.",
    "I'm your first agent. I can schedule work, pass messages between your agents, and help you run this place.",
  ],
  /** Composer placeholder while the conversation is still scripted (Beats 0-2). */
  composerSetupPlaceholder: 'DorkBot is setting things up with you…',
  /** Prompt that introduces the personality widget (Beat 1). */
  personalityPrompt:
    'First: how should I sound? Pick a personality. You can change it any time in settings.',
  /** Honest error line when saving personality traits fails (Beat 1). */
  saveError: "I couldn't save that. Try again?",
  /** Consent question before any filesystem scan runs (Beat 2). */
  discoveryPrompt: 'Want me to look around this machine for projects and agents you already have?',
  /** Shown while the consented scan is running (Beat 2). */
  scanning: 'Looking…',
  /** Honest line when the scan finds nothing (Beat 2). */
  discoveryZero: 'I looked around. This machine is quiet so far. We can add agents any time.',
  /** Honest line when the scan exceeds its budget or errors (Beat 2). */
  discoveryTimeout:
    "That's taking longer than I expected. I'll keep looking in the background; check the Agents page later.",
  /** Reply when the user declines the scan (Beat 2). */
  discoveryDecline: 'No problem.',
  /** Prompt that opens the real composer for the user's first message (Beat 3). */
  handoffPrompt: "Last thing: what are we building today? Tell me, and we'll get started.",
  /** Composer placeholder once the user can type their first real message (Beat 3). */
  composerHandoffPlaceholder: "Tell DorkBot what you're working on…",
} as const;

/**
 * DorkBot's line announcing how many projects and agents the scan found.
 *
 * @param count - Number of candidates discovered (must be at least 1; the
 *   zero case uses {@link DORKBOT_ONBOARDING_LINES.discoveryZero} instead).
 */
export function dorkbotDiscoveryFoundLine(count: number): string {
  const noun = count === 1 ? 'one' : `${count}`;
  return `Found ${noun}. Want them in your fleet?`;
}

/**
 * Voice archetype selected from a trait vector. Each maps to one authored sample
 * line so that changing personality audibly changes DorkBot's next message.
 */
type VoiceKey = 'terse' | 'balanced' | 'warm' | 'playful' | 'bold' | 'inventive';

/**
 * Classify a trait vector into a single voice archetype.
 *
 * Ordered from most to least distinctive so a dominant trait (edge, humor,
 * inventiveness) wins before the softer length/warmth signals. Early returns
 * keep the branching flat (no nested ternaries).
 */
function classifyVoice(traits: Traits): VoiceKey {
  if (traits.spice >= 4) return 'bold';
  if (traits.humor >= 4) return 'playful';
  if (traits.creativity >= 4 && traits.chaos >= 4) return 'inventive';
  if (traits.verbosity <= 2 && traits.humor <= 2) return 'terse';
  if (traits.verbosity >= 4 && traits.humor >= 3) return 'warm';
  return 'balanced';
}

/** One authored sample sentence per voice archetype, plain language, no hype. */
const VOICE_SAMPLES: Record<VoiceKey, string> = {
  terse: 'Set. Tell me the task and I run it.',
  balanced: "Sounds good. Point me at something and I'll get to work.",
  warm: "Love it. I'm here whenever you're ready, so just tell me what you need.",
  playful: 'Oh nice, this is going to be fun. Throw me a task and watch.',
  bold: "Good pick. Give me the job and I'll handle it.",
  inventive: "I like where your head's at. Hand me a problem and I'll find an angle.",
};

/**
 * Generate a one-sentence sample line in the voice implied by the given traits.
 *
 * Used in the onboarding personality beat: each preset (or slider settle) posts
 * a fresh sample so the user hears the personality change. Deterministic and
 * personality-true; keyed off the same six-dimension trait space as the picker.
 *
 * @param traits - Agent personality traits selected in the picker.
 */
export function generateVoiceSample(traits: Traits): string {
  return VOICE_SAMPLES[classifyVoice(traits)];
}
