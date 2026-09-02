/**
 * The face an agent wears — one colour and one emoji — and the curated sets
 * both are picked from.
 *
 * Every agent gets a face the moment it is created (DOR-949). Before that, a
 * face was only ever set when a person chose one, so most agents rendered the
 * honest hash-plus-letter fallback and the rich look was the exception rather
 * than the rule.
 *
 * Two properties make the seed safe to run on every creation path:
 *
 * - **It only fills gaps.** Whatever the caller chose is passed straight
 *   through; the seed supplies the other half, or both when the caller chose
 *   nothing. Nothing this module does can overwrite a face somebody picked.
 * - **It is deterministic.** The pick is a hash of the agent's id, so the same
 *   agent resolves to the same face on every machine that reads its manifest,
 *   and re-running a creation that failed halfway produces the same face rather
 *   than a new one.
 *
 * The two sets are the SAME ones the avatar picker offers, which is why they
 * live here rather than in the client: a seeded colour must be a colour the
 * picker can show as selected, and a second palette on the server is how the
 * two would come to disagree.
 *
 * @module agent-face
 */

/** One colour the palette offers, with the name a picker labels it by. */
export interface AgentColorPreset {
  /** The CSS hex value written to `agent.color`. */
  hex: string;
  /** Plain-language label — what a person calls this colour. */
  name: string;
}

/**
 * The fixed colour palette an agent's face is painted from.
 *
 * Ten mid-weight hues (the Tailwind 500 rung), spaced far enough apart to stay
 * apart in a roster, and light enough for the avatar primitive to compute a
 * readable foreground over any of them.
 */
export const AGENT_COLOR_PRESETS: readonly AgentColorPreset[] = [
  { hex: '#ef4444', name: 'Red' },
  { hex: '#f97316', name: 'Orange' },
  { hex: '#eab308', name: 'Yellow' },
  { hex: '#22c55e', name: 'Green' },
  { hex: '#06b6d4', name: 'Cyan' },
  { hex: '#3b82f6', name: 'Blue' },
  { hex: '#6366f1', name: 'Indigo' },
  { hex: '#a855f7', name: 'Purple' },
  { hex: '#ec4899', name: 'Pink' },
  { hex: '#78716c', name: 'Stone' },
];

/**
 * The curated emoji an agent's face is picked from.
 *
 * Deliberately narrow: creatures, elements and tools that read as a character
 * at avatar size and carry no gesture, flag, or human likeness — nothing a
 * seeded pick could turn into a statement about the person running the agent.
 */
export const AGENT_EMOJI_SET: readonly string[] = [
  '\u{1F600}',
  '\u{1F60E}',
  '\u{1F916}',
  '\u{1F98A}',
  '\u{1F431}',
  '\u{1F436}',
  '\u{1F981}',
  '\u{1F438}',
  '\u{1F435}',
  '\u{1F984}',
  '\u{1F432}',
  '\u{1F989}',
  '\u{1F427}',
  '\u{1F43C}',
  '\u{1F98B}',
  '\u{1F338}',
  '\u{1F52E}',
  '\u{1F3AF}',
  '\u{1F680}',
  '\u{26A1}',
  '\u{1F30A}',
  '\u{1F340}',
  '\u{1F3A8}',
  '\u{1F3B5}',
  '\u{1F48E}',
  '\u{1F525}',
  '\u{1F308}',
  '\u{2B50}',
  '\u{1F9E0}',
  '\u{1F47E}',
];

/** A resolved face: both halves present, ready to write to a manifest. */
export interface AgentFace {
  /** CSS colour for the agent's avatar. */
  color: string;
  /** Single emoji drawn on the agent's avatar. */
  icon: string;
}

/** The half (or halves) of a face a caller already chose. */
export interface AgentFaceChoice {
  /** A colour a person or a package picked. Absent → seed one. */
  color?: string;
  /** An emoji a person or a package picked. Absent → seed one. */
  icon?: string;
}

/**
 * Compute a 32-bit FNV-1a hash of the given string.
 *
 * The one hash behind every derived-from-identity visual in DorkOS — the seeded
 * face here, and the client's hashed fallback colour and emoji — so an id
 * resolves the same way wherever it is read.
 *
 * @param str - The string to hash.
 * @returns An unsigned 32-bit integer.
 */
export function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Resolve the face an agent is created with: whatever was chosen, plus a
 * seeded pick for whatever was not.
 *
 * The two halves are hashed from DIFFERENT salts on purpose. The emoji set is a
 * whole multiple of the colour palette, so one hash would make the colour a
 * function of the emoji — thirty possible faces instead of three hundred, and
 * every agent wearing a given emoji wearing the same colour with it.
 *
 * @param agentId - The agent's id (a ULID at every creation path). The seed.
 * @param chosen - A face a person or a package already picked, in part or whole.
 * @returns A complete face — the chosen halves untouched, the rest seeded.
 */
export function seedAgentFace(agentId: string, chosen?: AgentFaceChoice): AgentFace {
  const colorIndex = fnv1aHash(`${agentId}:color`) % AGENT_COLOR_PRESETS.length;
  const iconIndex = fnv1aHash(`${agentId}:icon`) % AGENT_EMOJI_SET.length;
  return {
    // Truthiness, not `??`: an empty string is not a face somebody chose, it is
    // a field that was cleared or never filled. Treating `''` as a choice is how
    // an agent ends up with a blank avatar that no picker can explain.
    color: chosen?.color || AGENT_COLOR_PRESETS[colorIndex].hex,
    icon: chosen?.icon || AGENT_EMOJI_SET[iconIndex],
  };
}

/**
 * True when a string is a single emoji grapheme (including variation-selector
 * and ZWJ sequences).
 *
 * The gate on every face that comes from OUTSIDE this module — a marketplace
 * package's `icon`, which its schema allows to be either an emoji or an
 * arbitrary identifier like `"package"`. Only an emoji can be worn as a face or
 * shown as selected in the picker; anything else is not a face, and the caller
 * should let {@link seedAgentFace} supply one instead.
 *
 * @param value - Candidate icon string.
 */
export function isSingleEmoji(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^\p{Extended_Pictographic}[\u{FE0F}\u{200D}\p{Extended_Pictographic}]*$/u.test(trimmed);
}
