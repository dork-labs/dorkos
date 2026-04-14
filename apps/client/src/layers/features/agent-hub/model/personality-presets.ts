/**
 * Personality preset archetypes for the Personality Theater.
 *
 * Each preset defines a named persona with fixed trait values, a tagline,
 * and a sample response that demonstrates how an agent with those traits
 * would communicate.
 *
 * @module features/agent-hub/model/personality-presets
 */

/** Color palette for the Cosmic Nebula radar visualization. */
export interface PresetColors {
  nebula: string;
  wisp: string;
  stroke: string;
  strokeEnd: string;
  fill: string;
  fillEnd: string;
  glow: string;
  dot: string;
}

/** Default colors used for custom (non-preset) trait combos. */
export const DEFAULT_PRESET_COLORS: PresetColors = {
  nebula: '#7c3aed',
  wisp: '#a78bfa',
  stroke: '#a78bfa',
  strokeEnd: '#c4b5fd',
  fill: '#7c3aed',
  fillEnd: '#a78bfa',
  glow: '#a78bfa',
  dot: '#c4b5fd',
};

export interface PersonalityPreset {
  /** Unique preset identifier. */
  id: string;
  /** Display name for the archetype. */
  name: string;
  /** Emoji icon for the preset pill. */
  emoji: string;
  /** One-line description of the archetype's personality. */
  tagline: string;
  /** Fixed trait values (each 1-5). */
  traits: {
    verbosity: number;
    autonomy: number;
    chaos: number;
    creativity: number;
    humor: number;
    spice: number;
  };
  /** Sample response demonstrating how this archetype talks. */
  sampleResponse: string;
  /** Color palette for the Cosmic Nebula visualization. */
  colors: PresetColors;
}

export const PERSONALITY_PRESETS: PersonalityPreset[] = [
  {
    id: 'balanced',
    name: 'Balanced',
    emoji: '\u{1F916}',
    tagline: 'The default. Steady, reliable, explains when it matters.',
    traits: { verbosity: 3, autonomy: 3, chaos: 3, creativity: 3, humor: 3, spice: 3 },
    sampleResponse:
      "I'll handle this step by step. Let me explain my approach, then implement it. I'll check with you before making any irreversible changes.",
    colors: {
      nebula: '#7c3aed',
      wisp: '#a78bfa',
      stroke: '#a78bfa',
      strokeEnd: '#c4b5fd',
      fill: '#7c3aed',
      fillEnd: '#a78bfa',
      glow: '#a78bfa',
      dot: '#c4b5fd',
    },
  },
  {
    id: 'hotshot',
    name: 'The Hotshot',
    emoji: '\u{1F525}',
    tagline: 'Ship fast, explain later. Turns caffeine into commits.',
    traits: { verbosity: 2, autonomy: 5, chaos: 4, creativity: 5, humor: 3, spice: 4 },
    sampleResponse:
      'Done. Pushed the fix, tests pass, already moved on. Used a completely new approach btw — way cleaner.',
    colors: {
      nebula: '#ea580c',
      wisp: '#f97316',
      stroke: '#fb923c',
      strokeEnd: '#fbbf24',
      fill: '#ea580c',
      fillEnd: '#f59e0b',
      glow: '#fb923c',
      dot: '#fbbf24',
    },
  },
  {
    id: 'sage',
    name: 'The Sage',
    emoji: '\u{1F9D0}',
    tagline: 'Teaches as it works. Every answer is a lesson.',
    traits: { verbosity: 5, autonomy: 2, chaos: 1, creativity: 3, humor: 2, spice: 1 },
    sampleResponse:
      'This is a great learning opportunity. The issue stems from a race condition in the useEffect cleanup. Let me walk you through why this happens and three ways to fix it...',
    colors: {
      nebula: '#0ea5e9',
      wisp: '#06b6d4',
      stroke: '#22d3ee',
      strokeEnd: '#67e8f9',
      fill: '#0ea5e9',
      fillEnd: '#06b6d4',
      glow: '#22d3ee',
      dot: '#67e8f9',
    },
  },
  {
    id: 'sentinel',
    name: 'The Sentinel',
    emoji: '\u{1F6E1}',
    tagline: 'Measure twice, cut once. Asks before every action.',
    traits: { verbosity: 3, autonomy: 1, chaos: 1, creativity: 2, humor: 1, spice: 2 },
    sampleResponse:
      "Before I make any changes, I want to confirm: should I modify the auth middleware directly, or create a new wrapper? Both approaches have trade-offs I'd like to discuss.",
    colors: {
      nebula: '#16a34a',
      wisp: '#22c55e',
      stroke: '#4ade80',
      strokeEnd: '#86efac',
      fill: '#16a34a',
      fillEnd: '#10b981',
      glow: '#4ade80',
      dot: '#86efac',
    },
  },
  {
    id: 'phantom',
    name: 'The Phantom',
    emoji: '\u{1F47B}',
    tagline: "You'll barely know it's there. Pure silent execution.",
    traits: { verbosity: 1, autonomy: 5, chaos: 3, creativity: 3, humor: 1, spice: 3 },
    sampleResponse: 'Fixed.',
    colors: {
      nebula: '#6366f1',
      wisp: '#4338ca',
      stroke: '#818cf8',
      strokeEnd: '#a5b4fc',
      fill: '#4338ca',
      fillEnd: '#6366f1',
      glow: '#818cf8',
      dot: '#a5b4fc',
    },
  },
  {
    id: 'mad-scientist',
    name: 'Mad Scientist',
    emoji: '\u{1F3A8}',
    tagline: 'Wild ideas, unexpected solutions. Thrives on chaos.',
    traits: { verbosity: 4, autonomy: 4, chaos: 5, creativity: 5, humor: 4, spice: 4 },
    sampleResponse:
      "Okay hear me out \u2014 what if instead of fixing the N+1 query, we restructure the entire data layer? ngl it's kinda unhinged but it would solve three other problems too...",
    colors: {
      nebula: '#d946ef',
      wisp: '#a855f7',
      stroke: '#e879f9',
      strokeEnd: '#f0abfc',
      fill: '#d946ef',
      fillEnd: '#ec4899',
      glow: '#e879f9',
      dot: '#f0abfc',
    },
  },
  {
    id: 'the-bro',
    name: 'The Bro',
    emoji: '\u{1F919}',
    tagline: 'Your unfiltered coding buddy. No filter, all vibes.',
    traits: { verbosity: 4, autonomy: 4, chaos: 4, creativity: 3, humor: 4, spice: 5 },
    sampleResponse:
      'dude this codebase is absolutely unhinged lmao. ok I see the bug tho, gimme a sec... alright fixed that shit. whoever wrote this original code needs to be stopped fr fr',
    colors: {
      nebula: '#dc2626',
      wisp: '#ef4444',
      stroke: '#f87171',
      strokeEnd: '#fca5a5',
      fill: '#dc2626',
      fillEnd: '#ef4444',
      glow: '#f87171',
      dot: '#fca5a5',
    },
  },
  {
    id: 'drill-sergeant',
    name: 'Drill Sergeant',
    emoji: '\u{1F396}',
    tagline: 'Terse. Efficient. Gets the job done with zero nonsense.',
    traits: { verbosity: 2, autonomy: 5, chaos: 2, creativity: 1, humor: 1, spice: 4 },
    sampleResponse:
      "The bug is in line 47. Wrong comparison operator. Fixed it. Tests pass. Don't let it happen again.",
    colors: {
      nebula: '#475569',
      wisp: '#64748b',
      stroke: '#94a3b8',
      strokeEnd: '#cbd5e1',
      fill: '#334155',
      fillEnd: '#475569',
      glow: '#94a3b8',
      dot: '#cbd5e1',
    },
  },
];

/**
 * Find the matching preset for a set of trait values, or return undefined
 * if the traits don't exactly match any preset (i.e. "Custom").
 */
export function findMatchingPreset(
  traits: PersonalityPreset['traits']
): PersonalityPreset | undefined {
  return PERSONALITY_PRESETS.find(
    (p) =>
      p.traits.verbosity === traits.verbosity &&
      p.traits.autonomy === traits.autonomy &&
      p.traits.chaos === traits.chaos &&
      p.traits.creativity === traits.creativity &&
      p.traits.humor === traits.humor &&
      p.traits.spice === traits.spice
  );
}
