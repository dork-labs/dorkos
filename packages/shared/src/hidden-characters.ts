/**
 * The one definition of a character a person cannot see (DOR-5060, DOR-5133).
 *
 * Two jobs read it. A consent surface SHOWS each one, as a `<U+202E>` marker,
 * so a command reads exactly as it will run (`revealHiddenCharacters` in
 * `marketplace-schemas.ts`). Text an agent reads DROPS them, so a model reads
 * what a person sees and nothing more (`untrusted-text.ts`). Both match the
 * same set, so the two can never disagree about what counts as hidden.
 *
 * The set is Unicode's own list of characters that draw nothing when a font
 * has no glyph for them (`Default_Ignorable_Code_Point`): the soft hyphen, the
 * combining grapheme joiner, the Arabic letter mark, the Hangul fillers, the
 * Mongolian vowel separator and free variation selectors, the zero-width
 * spaces and joiners, the bidi marks, overrides and isolates, the invisible
 * operators, the deprecated format characters, the BOM, every variation
 * selector and the whole tag block. To that it adds the line and paragraph
 * separators and the interlinear annotation marks, which are not on Unicode's
 * list but draw nothing either.
 *
 * Every pattern here is linear: each alternative is one code point, with
 * lookarounds at most two code points wide.
 *
 * @module shared/hidden-characters
 */

/** The hidden set, as the body of a `u`-mode character class. */
const HIDDEN_CLASS = '\\p{Default_Ignorable_Code_Point}\\u{2028}\\u{2029}\\u{FFF9}-\\u{FFFB}';

/**
 * A single U+FE0F straight after an emoji. It only asks for the emoji's colour
 * form (U+2764 U+FE0F, a red heart) and is in most emoji people type
 * (DOR-5075), so a consent surface does not mark it. A second selector, or one
 * after anything else, is marked.
 */
const EMOJI_COLOUR_SELECTOR = '(?<=\\p{Extended_Pictographic})\\u{FE0F}';

/**
 * Every hidden character, for showing to a person who is about to approve the
 * text. Unlike {@link stripHiddenCharacters} it marks the joiners and every
 * flag letter too: on a consent surface even a legitimate one is worth seeing.
 */
export const HIDDEN_CHARACTERS = new RegExp(`(?!${EMOJI_COLOUR_SELECTOR})[${HIDDEN_CLASS}]`, 'gu');

/**
 * A subdivision flag emoji pickers offer (England, Scotland, Wales). Its region
 * letters come from the tag block, which is hidden everywhere else.
 */
const SUBDIVISION_FLAG =
  '\\u{1F3F4}\\u{E0067}\\u{E0062}(?:\\u{E0065}\\u{E006E}\\u{E0067}|\\u{E0073}\\u{E0063}\\u{E0074}|\\u{E0077}\\u{E006C}\\u{E0073})\\u{E007F}';

/**
 * The U+FE0F an agent keeps after an emoji: only after one that draws as text
 * unless asked (U+2764, a heart). An emoji that already draws in colour
 * (U+1F44D, thumbs up) looks the same without it, so there it is a bit nobody
 * can see.
 */
const TEXT_EMOJI_COLOUR_SELECTOR =
  '(?<=(?!\\p{Emoji_Presentation})\\p{Extended_Pictographic})\\u{FE0F}';

/** The U+FE0F in a keycap (1, U+FE0F, U+20E3), whose base is not an emoji. */
const KEYCAP_SELECTOR = '(?<=[0-9#*])\\u{FE0F}(?=\\u{20E3})';

/**
 * Scripts whose letters join or change shape next to each other, where a
 * zero-width joiner or non-joiner changes what a person sees: the joining
 * scripts (Arabic, which Persian is written in, Syriac, NKo, Mongolian, Mandaic,
 * Adlam) and the Brahmic scripts of South and Southeast Asia. In any other
 * script, Latin, Cyrillic and CJK among them, a joiner changes nothing on
 * screen. Script extensions, so a combining mark these scripts share counts.
 */
const SHAPING_SCRIPTS = [
  'Arabic',
  'Syriac',
  'Nko',
  'Mongolian',
  'Mandaic',
  'Adlam',
  'Devanagari',
  'Bengali',
  'Gurmukhi',
  'Gujarati',
  'Oriya',
  'Tamil',
  'Telugu',
  'Kannada',
  'Malayalam',
  'Sinhala',
  'Tibetan',
  'Myanmar',
  'Khmer',
]
  .map((script) => `\\p{Script_Extensions=${script}}`)
  .join('');

/** A drawn letter or mark in one of the {@link SHAPING_SCRIPTS}. */
const SHAPING_LETTER = `(?![${HIDDEN_CLASS}])(?=[\\p{L}\\p{M}])[${SHAPING_SCRIPTS}]`;

/**
 * What a joiner may keep, and nothing else:
 *
 * - a joiner or non-joiner between two letters of a shaping script (Persian
 *   words, Devanagari conjuncts);
 * - a joiner after an emoji (with its colour selector or skin tone, if any)
 *   and before another, which is how families and the rainbow flag are
 *   spelled. A non-joiner next to an emoji does nothing, so it never stays.
 *
 * At an edge, in a run, or anywhere else it joins nothing.
 */
const KEPT_JOINER =
  `(?<=${SHAPING_LETTER})[\\u{200C}\\u{200D}](?=${SHAPING_LETTER})` +
  `|(?<=\\p{Extended_Pictographic}[\\u{FE0F}\\p{Emoji_Modifier}]?)\\u{200D}(?=\\p{Extended_Pictographic})`;

/** C0 controls but tab, LF and CR; DEL; and C1 but NEL. None draws anything. */
const DROPPED_CONTROLS = '\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F-\\x84\\x86-\\x9F';

/**
 * One pass over text an agent reads: group 1 is something to keep as written,
 * group 2 a line break (NEL, the line and paragraph separators), and any other
 * match goes.
 */
const AGENT_HIDDEN = new RegExp(
  `(${SUBDIVISION_FLAG}|${TEXT_EMOJI_COLOUR_SELECTOR}|${KEYCAP_SELECTOR}|${KEPT_JOINER})` +
    `|([\\u{85}\\u{2028}\\u{2029}])|[${HIDDEN_CLASS}${DROPPED_CONTROLS}]`,
  'gu'
);

/** What {@link stripHiddenCharacters} does with NEL and the line and paragraph separators. */
export interface StripHiddenOptions {
  /**
   * `'newline'` (default) turns each into `\n`, the break a person sees in a
   * message. `'drop'` removes it, for code: inside a string literal a `\n`
   * would end the string, where removing the character keeps the code valid.
   */
  lineBreaks?: 'newline' | 'drop';
}

/**
 * Drop every character a person cannot see from text an agent will read,
 * control characters included (tab, LF and CR stay).
 *
 * What stays is what draws something or changes how it draws: a colour
 * selector after an emoji that needs one, the selector in a keycap, a joiner
 * inside a Persian, Arabic or Indic word or an emoji sequence, and the
 * England, Scotland and Wales flags whole. Idempotent.
 *
 * @param text - Any text.
 * @param options - What to do with line breaks a person sees but `\n` is not.
 * @returns The text as a person sees it.
 */
export function stripHiddenCharacters(text: string, options: StripHiddenOptions = {}): string {
  const lineBreak = options.lineBreaks === 'drop' ? '' : '\n';
  return text.replace(AGENT_HIDDEN, (_match, kept?: string, separator?: string) =>
    kept !== undefined ? kept : separator !== undefined ? lineBreak : ''
  );
}

/** A real subdivision flag (group 1), or a flag letter standing anywhere else. */
const FLAG_OR_STRAY_FLAG_LETTER = new RegExp(`(${SUBDIVISION_FLAG})|[\\u{E0000}-\\u{E007F}]`, 'gu');

/**
 * Drop only the flag letters that are not part of a real subdivision flag.
 *
 * Narrower than {@link stripHiddenCharacters}: `isReactionEmoji` refuses any
 * value this would change, and a reaction has its own rule for selectors.
 *
 * @param text - Any text.
 * @returns The text with only its real subdivision flags' letters left in it.
 */
export function stripStrayFlagLetters(text: string): string {
  return text.replace(FLAG_OR_STRAY_FLAG_LETTER, (_match, flag?: string) => flag ?? '');
}
