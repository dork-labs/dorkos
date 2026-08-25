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
import type { ProfileRecommendation } from './profile-recommendations.js';

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
    // Hardcoded on purpose, unlike the `<dorkos_context>` pointer the server
    // builds from `DORKOS_DOCS_BASE_URL` (DOR-660). This package ships wherever
    // it is depended on — the CLI takes it directly, the Obsidian plugin gets it
    // transitively through `@dorkos/client` and `@dorkos/server` — so it cannot
    // import the server's `env.ts`; and this string is written into DorkBot's
    // `.dork/AGENTS.md` ONCE at creation, so an override read here would be
    // baked into the file forever rather than resolved per boot. Consequence to
    // know about: on an instance that sets DORKOS_DOCS_BASE_URL, DorkBot carries
    // two docs pointers that disagree — this one, and the server's per-turn one.
    'For full documentation: https://dorkos.ai/llms.txt',
    '',
    '## Your Role',
    '',
    'Help the user with their development workflow. You have access to DorkOS tools',
    'for scheduling (Schedules), messaging (Relay), and agent discovery (Mesh).',
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
  /** Reply when the user skips the personality step without picking one (Beat 1). */
  personalitySkip:
    'Sticking with my default voice then. You can change it any time in my settings.',
  /**
   * The role-beat question (spec `user-profile-onboarding`). Two lines, revealed
   * one after the other: the question, then the privacy fact in the same breath.
   * The privacy line describes tested behavior (the profile is structurally
   * excluded from every telemetry payload), not marketing.
   */
  profilePrompt: [
    "Now I know how to sound. Here's one for you: what kind of work will we be doing together?",
    "Your answer stays on this machine. It's for me and your other agents, so we know who we work for. Nobody else sees it.",
  ],
  /** Reply when the user skips the role beat. Skipping counts as asked, forever. */
  profileSkip: 'No problem. Tell me any time.',
  /** Thanks line after roles are saved from the existing-user prompt card. */
  profileSaved: 'Noted. Your agents know now.',
  /**
   * The one-time existing-user prompt (sidebar card, never a modal). Users who
   * onboarded before the role beat existed hear the same question once, with the
   * same privacy fact in the same breath.
   */
  profileCardPrompt:
    'I work better knowing who I work for. What kind of work do you do? Your answer stays on this machine, for your agents only.',
  /** Consent question before any filesystem scan runs (Beat 2). */
  discoveryPrompt: 'Want me to look around this machine for projects and agents you already have?',
  /** Shown while the consented scan is running (Beat 2). */
  scanning: 'Looking…',
  /** Honest line when the scan finds nothing (Beat 2). */
  discoveryZero: 'I looked around. This machine is quiet so far. We can add agents any time.',
  /** Honest line when the scan exceeds its budget or errors (Beat 2). */
  discoveryTimeout:
    "That's taking longer than I expected. I'll keep looking in the background; check the Team page later.",
  /** Reply when the user declines the scan (Beat 2). */
  discoveryDecline: 'No problem.',
  /** Prompt that opens the real composer for the user's first message (Beat 3). */
  handoffPrompt: "Last thing: what are we building today? Tell me, and we'll get started.",
  /** Composer placeholder once the user can type their first real message (Beat 3). */
  composerHandoffPlaceholder: "Tell DorkBot what you're working on…",
} as const;

/**
 * DorkBot's spoken lines for the living tour (DOR-419).
 *
 * Every line is authored and token-free, in DorkBot's own voice. `offers` are
 * the one-line prompts shown as a suggestion chip when a subsystem introduces
 * itself at first use; the per-tour blocks are the spotlight captions, each
 * naming its target in plain language so the caption doubles as the screen-reader
 * announcement. Plain language, no em dashes.
 *
 * v1 note: these are fixed constants, NOT inflected by the user's chosen
 * personality traits (unlike the onboarding voice sample). Per-trait inflection
 * of tour captions is deliberately deferred — the copy stays consistent and
 * plainly readable for now; revisit if tours ever want DorkBot's voice to shift
 * with the selected personality.
 */
export const DORKBOT_TOUR_LINES = {
  /** The offer line for each occasion tour, shown as a chip in the session. */
  offers: {
    tasks: 'I put that on the schedule. Want to see where your scheduled work lives?',
    relay: 'Your first integration is set up. Want to see where your integrations live?',
    mesh: "That's two agents now. Want to see your fleet?",
  },
  /** The on-demand general tour: the composer, then the tabs above it. */
  general: {
    composer:
      'Start here. This box posts to #team, where you and every agent you run can talk. Type something and I answer. This is where most days begin.',
    homeTabs:
      'And the rest of Home is up here: what your agents have been doing, the work you scheduled, and your workspaces. That is the whole place. Go build something.',
  },
  /** The Tasks occasion tour, fired on the first scheduled task. */
  tasks: {
    tasksList:
      'Here it is. Every scheduled task lands in this list, with its next run and its history.',
  },
  /** The Relay occasion tour, fired on the first integration made. */
  relay: {
    relayIntegrations:
      'Right here. Every integration you add shows up in this list, so you can check on it or add more.',
  },
  /** The Mesh occasion tour, fired when a second agent joins the fleet. */
  mesh: {
    teamRoster: 'Here is your team. You and every agent you run, on one page. Add more any time.',
  },
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
 * The authored who/why phrasing behind {@link dorkbotProfileSuggestionLine},
 * one pair per canon role. Plain language, no em dashes, no hype.
 */
const PROFILE_SUGGESTION_PHRASES: Record<string, { who: string; why: string }> = {
  'software-development': {
    who: 'People who build software',
    why: 'so their agents can watch the code and the tickets',
  },
  hiring: {
    who: 'People who hire',
    why: 'so their agents can work the inbox and the pipeline',
  },
  marketing: {
    who: 'People who do marketing',
    why: 'so their agents can keep up with the campaigns and the channels',
  },
  writing: {
    who: 'People who write',
    why: 'so their agents can reach the drafts and the notes',
  },
  research: {
    who: 'People who do research',
    why: 'so their agents can gather sources and keep notes',
  },
  'business-ops': {
    who: 'People who run a business',
    why: 'so their agents can keep the inbox and the day-to-day moving',
  },
  design: {
    who: 'People who design',
    why: 'so their agents can stay close to the files and the feedback',
  },
  sales: {
    who: 'People in sales',
    why: 'so their agents can watch the pipeline and the follow-ups',
  },
};

/** Join up to three service names as spoken prose ("Gmail and Greenhouse"). */
function joinServiceNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/**
 * DorkBot's one authored suggestion line after the role beat saves
 * (spec `user-profile-onboarding` §The role beat).
 *
 * Names at most three services and never claims anything is set up or
 * configured — mid-onboarding OAuth is a non-goal. The copy deliberately ends
 * at "any time" rather than naming the Connections page: that page ships in
 * `specs/connector-completion`, and the demo-claim gate says nothing speaks of
 * a surface that does not exist yet. Once that spec lands, this is the line to
 * upgrade to "the Connections page has these waiting".
 *
 * @param recs - Suggestions from `recommendForRoles`; an empty array returns
 *   `''` (the beat advances silently instead of speaking).
 */
export function dorkbotProfileSuggestionLine(recs: readonly ProfileRecommendation[]): string {
  if (recs.length === 0) return '';
  const phrase = PROFILE_SUGGESTION_PHRASES[recs[0].role] ?? {
    who: 'People who do your kind of work',
    why: 'so their agents can meet them where the work happens',
  };
  const names = joinServiceNames(recs.slice(0, 3).map((r) => r.name));
  return `${phrase.who} usually connect ${names}, ${phrase.why}. You can set those up any time.`;
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
 * One distinct authored sample line per named personality preset, keyed by the
 * preset id used in the picker (`entities/agent/lib/personality-presets`).
 * A preset selection posts its own line, so switching presets audibly changes
 * DorkBot's voice even between adjacent archetypes; the trait-space classifier
 * ({@link VOICE_SAMPLES}) is only the fallback for Custom slider blends.
 */
const PRESET_VOICE_SAMPLES: Record<string, string> = {
  balanced: "Sounds good. Point me at something and I'll get to work, and I'll flag the big calls.",
  hotshot: "Say the word and it's shipped before you look up.",
  sage: "Happy to help, and I'll explain the why as we go so it sticks.",
  sentinel: "I'll check with you before anything risky, then move carefully.",
  phantom: "On it. You'll barely hear from me.",
  'mad-scientist': "Ooh, I already have three weird ideas. Let's try the fun one first.",
  'the-bro': 'Bet. Point me at the mess and I sort it out, no stress.',
  'drill-sergeant': 'Give me the target. I hit it. Next.',
};

/**
 * Generate a one-sentence sample line in DorkBot's voice for the chosen
 * personality.
 *
 * Used in the onboarding personality beat: each preset (or slider settle) posts
 * a fresh sample so the user hears the personality change. When a named preset
 * is selected, its authored line is returned so adjacent presets never collide;
 * a Custom trait blend (no preset id) falls back to the trait-space classifier.
 * Deterministic and personality-true.
 *
 * @param traits - Agent personality traits selected in the picker.
 * @param presetId - The selected preset's id, when a preset (not Custom) is picked.
 */
export function generateVoiceSample(traits: Traits, presetId?: string): string {
  if (presetId && PRESET_VOICE_SAMPLES[presetId]) {
    return PRESET_VOICE_SAMPLES[presetId];
  }
  return VOICE_SAMPLES[classifyVoice(traits)];
}
