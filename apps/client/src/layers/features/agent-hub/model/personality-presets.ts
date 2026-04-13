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
    tone: number;
    autonomy: number;
    caution: number;
    communication: number;
    creativity: number;
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
    traits: { tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 },
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
    traits: { tone: 4, autonomy: 5, caution: 2, communication: 2, creativity: 5 },
    sampleResponse:
      'Done. Pushed the fix to feature/auth-refactor. Tests pass, types check, no regressions. Already moved on to the next item.',
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
    traits: { tone: 5, autonomy: 2, caution: 4, communication: 5, creativity: 3 },
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
    traits: { tone: 3, autonomy: 1, caution: 5, communication: 4, creativity: 2 },
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
    traits: { tone: 1, autonomy: 5, caution: 3, communication: 1, creativity: 3 },
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
    traits: { tone: 4, autonomy: 4, caution: 1, communication: 4, creativity: 5 },
    sampleResponse:
      "Okay hear me out \u2014 what if instead of fixing the N+1 query, we restructure the entire data layer to use a materialized view? It's unconventional but it would solve three other problems too...",
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
      p.traits.tone === traits.tone &&
      p.traits.autonomy === traits.autonomy &&
      p.traits.caution === traits.caution &&
      p.traits.communication === traits.communication &&
      p.traits.creativity === traits.creativity
  );
}
