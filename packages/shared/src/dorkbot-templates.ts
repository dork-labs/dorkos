/**
 * DorkBot-specific scaffold templates.
 *
 * DorkBot is the first agent on every DorkOS team. When created via the
 * agent creation pipeline, it gets an additional AGENTS.md file that
 * orients it within the DorkOS ecosystem.
 *
 * @module shared/dorkbot-templates
 */

import { siteUrl } from './links.js';
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
    'You are DorkBot, the first agent on this DorkOS team.',
    '',
    '## About DorkOS',
    '',
    'DorkOS is a workspace for people and agents, built for founders. People use it to build',
    'and run their business with a team of agents: agents join the team chat, take on real',
    'work, and build mini apps, the custom tools a business runs on (the app calls them',
    'extensions). The person owns their files, their AI plans and their data. Describe only',
    'what the docs say works today.',
    // Hardcoded on purpose, unlike the `<dorkos_context>` pointer the server
    // builds from `DORKOS_DOCS_BASE_URL` (DOR-660). This package ships wherever
    // it is depended on — including the CLI directly — so it cannot
    // import the server's `env.ts`; and this string is written into DorkBot's
    // `.dork/AGENTS.md` ONCE at creation, so an override read here would be
    // baked into the file forever rather than resolved per boot. Consequence to
    // know about: on an instance that sets DORKOS_DOCS_BASE_URL, DorkBot carries
    // two docs pointers that disagree — this one, and the server's per-turn one.
    `For full documentation: ${siteUrl('/llms.txt')}`,
    '',
    '## Your job',
    '',
    'You are a co-worker, not an assistant. Help the person run their business: take on the',
    'work they give you, build a mini app when they ask for a tool, show them around DorkOS,',
    'set things up, and run the scheduled work you are given. You have DorkOS tools for',
    'scheduled tasks, rooms, messaging (Relay), and agent discovery (Mesh).',
  ].join('\n');
}

/** The offer that closes DorkBot's welcome when agents can already reply. */
const WELCOME_OFFER = 'Want a first tool? Pick one below, or tell me what you need.';

/**
 * DorkBot's first-run welcome in #team (spec `one-minute-onboarding` §3),
 * posted by the server once the first run lands. Token-free: the words are
 * fixed, only the name changes.
 *
 * @param path - The first-run path the person picked; `null` reads as no AI.
 * @param name - What to call the person; falls back to "there".
 * @param opts - `aiReady: false` on Own AI while an AI app still waits for
 *   its sign-in, so the welcome asks for it instead of offering a tool.
 */
export function dorkbotWelcomeText(
  path: 'dorkos' | 'own' | 'none' | null,
  name: string | null,
  opts: { aiReady?: boolean } = {}
): string {
  const cleaned = name?.replace(/\s+/g, ' ').trim().slice(0, 60);
  const who = cleaned ? cleaned : 'there';
  switch (path) {
    case 'dorkos':
      return `Hi ${who}. Your agents run on DorkOS. Usage is in Settings.\n\n${WELCOME_OFFER}`;
    case 'own':
      if (opts.aiReady === false) return `Hi ${who}. Sign in to an AI app to start.`;
      return `Hi ${who}. Your agents are ready.\n\n${WELCOME_OFFER}`;
    default:
      return `Hi ${who}. Agents need AI to reply. Connect DorkOS or your own.`;
  }
}

/**
 * DorkBot's lines on the one-time sidebar cards that ask for a name, a handle
 * and the kind of work a person does, for installs that never answered.
 *
 * Every line is authored and token-free. Keeping them in one place keeps
 * DorkBot's voice consistent and makes the copy unit-testable.
 */
export const DORKBOT_ONBOARDING_LINES = {
  /**
   * The name-and-handle card (DOR-677). The ask, then why it matters in plain
   * terms.
   */
  identityCardPrompt: [
    'What should I call you?',
    'Your name and @handle show beside everything you write, so people and agents know who is talking.',
  ],
  /** Thanks line after the name-and-handle card saves. */
  identityCardSaved: 'Got it. That is how you show up now.',
  /** Honest error line when a card's answer could not be saved. */
  saveError: "I couldn't save that. Try again?",
  /** Thanks line after roles are saved from the role card. */
  profileSaved: 'Noted. Your agents know now.',
  /**
   * The role card (spec `user-profile-onboarding`), never a modal. The ask,
   * then where the answer goes — `ProfilePromptCard` appends a real, clickable
   * path to Settings › Profile after the second line rather than baking it into
   * this string (FB-11 / DOR-1972).
   */
  profileCardPrompt: [
    'I work better knowing who I work with. What kind of work do you do?',
    'Stored on this machine, for your agents only.',
  ],
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
    relay: 'Your first chat app is set up. Want to see where your apps live?',
    mesh: "That's two agents now. Want to see your team?",
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
  /** The Relay occasion tour, fired on the first chat app set up. */
  relay: {
    relayIntegrations:
      'Right here. Every app you connect shows up in this list, so you can check on it or add more.',
  },
  /** The Mesh occasion tour, fired when a second agent joins the fleet. */
  mesh: {
    teamRoster: 'Here is your team. You and every agent you run, on one page. Add more any time.',
  },
} as const;

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
