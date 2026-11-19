/**
 * Names an app may not take, because they are DorkOS's own (DOR-4282).
 *
 * DorkOS draws an app's name beside everything the app shows, so the name has
 * to say whose it is. A name that starts with "DorkOS", or that is one of
 * DorkOS's own page names, is refused for every app DorkOS did not ship. The
 * check compares a folded form of the name, so spacing, case, punctuation,
 * width, invisible characters, accents and look-alike letters do not change
 * the answer.
 *
 * Pure, and shared by discovery, `create_extension` and the marketplace
 * install, so all three refuse the same names in the same words.
 *
 * @module @dorkos/extension-api/reserved-names
 */

/** The `error.code` of a record refused for its name. */
export const RESERVED_APP_NAME_CODE = 'reserved_name';

/** What a refused reserved name says, on the app's Settings row and to its maker. */
export const RESERVED_APP_NAME_MESSAGE =
  'Rename it. Names starting with DorkOS, or DorkOS’s own page names, are DorkOS’s.';

/** What a name mixing alphabets says. */
export const MIXED_SCRIPT_APP_NAME_MESSAGE =
  'Rename it. Names can’t mix Latin letters with letters from other alphabets.';

/** What a name using small-capital, phonetic or blank filler letters says. */
export const UNUSUAL_LETTER_APP_NAME_MESSAGE =
  'Rename it. Names can’t use small-capital, phonetic or blank letters.';

/** DorkOS's own page names, as written. They are folded once, in {@link reservedNames}. */
const RESERVED_PAGE_NAMES: readonly string[] = [
  'settings',
  'inbox',
  'activity',
  'connections',
  'marketplace',
  'security',
  'tasks',
  'team',
  'apps',
  'workspaces',
  'channels',
  'dorkbot',
];

/**
 * Characters that draw nothing or reorder text: every format character
 * (`\p{Cf}`, which holds the zero-width and bidi controls), plus the
 * zero-width and bidi ranges named outright so the rule reads on its own, and
 * the Hangul fillers, which are letters that draw as a blank.
 */
const INVISIBLE =
  /[\p{Cf}\u200B-\u200F\u2060\uFEFF\u202A-\u202E\u2066-\u2069\u115F\u1160\u3164\uFFA0]/gu;

/**
 * Letters no app name may use anywhere: the IPA extensions (U+0250–U+02AF),
 * the phonetic and small-capital blocks (U+1D00–U+1DBF), Latin Extended-D
 * (U+A720–U+A7FF) and the Hangul fillers. Read on the name as written and on
 * its NFKC form, since NFKC maps some of them onto others.
 */
const UNUSUAL_LETTERS = /[\u0250-\u02AF\u1D00-\u1DBF\uA720-\uA7FF\u115F\u1160\u3164\uFFA0]/u;

/**
 * Cyrillic and Greek letters that look like Latin ones, upper and lower case,
 * mapped before case is folded (Greek `Η` looks like `H`, its `η` like `n`).
 */
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  // Cyrillic capitals
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  Х: 'X',
  Ѕ: 'S',
  І: 'I',
  Ј: 'J',
  // Cyrillic small letters
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  і: 'i',
  ј: 'j',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  ѕ: 's',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  // Greek capitals
  Α: 'A',
  Β: 'B',
  Ε: 'E',
  Ζ: 'Z',
  Η: 'H',
  Ι: 'I',
  Κ: 'K',
  Μ: 'M',
  Ν: 'N',
  Ο: 'O',
  Ρ: 'P',
  Τ: 'T',
  Υ: 'Y',
  Χ: 'X',
  // Greek small letters
  α: 'a',
  ε: 'e',
  η: 'n',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ω: 'w',
};

/**
 * Latin letters that carry a stroke or lose a dot rather than an accent, so
 * removing combining marks does not reach them. Read after lower case.
 */
const LATIN_LOOK_ALIKES: Readonly<Record<string, string>> = {
  ø: 'o',
  ı: 'i',
  đ: 'd',
  ð: 'd',
  ł: 'l',
};

/** Digits written in place of letters, folded for the comparison only. */
const DIGIT_LOOK_ALIKES: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'l',
  '3': 'e',
  '5': 's',
};

/** Combining marks, removed after NFD so an accented letter compares as its base letter. */
const COMBINING_MARKS = /\p{M}/gu;

/**
 * A name in the folded form the reserved-name rule compares: NFKC, invisible
 * characters removed, look-alike letters from other alphabets mapped to
 * Latin, accents removed (NFD, then every combining mark), lower case,
 * stroked and dotless Latin letters mapped to their plain letter, look-alike
 * digits mapped to letters, `l` folded into `i` (with `I` and `1`, they look
 * alike in many fonts), and everything that is not a letter or a digit
 * (spaces, dots, dashes, underscores, no-break spaces) removed.
 *
 * Only the comparison uses this form; the name an app shows is left as written.
 *
 * @param name - The manifest's `name`.
 */
export function normalizedAppName(name: string): string {
  const visible = name.normalize('NFKC').replace(INVISIBLE, '');
  const latin = Array.from(visible, (char) => LOOK_ALIKES[char] ?? char).join('');
  const bare = latin.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
  return Array.from(bare, (char) => {
    const letter = LATIN_LOOK_ALIKES[char] ?? DIGIT_LOOK_ALIKES[char] ?? char;
    return letter === 'l' ? 'i' : letter;
  })
    .join('')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** The prefix no app's folded name may start with, folded the same way. */
const RESERVED_PREFIX = normalizedAppName('dorkos');

/** DorkOS's own page names, folded. An app's folded name may not equal one. */
const reservedNames: ReadonlySet<string> = new Set(RESERVED_PAGE_NAMES.map(normalizedAppName));

/**
 * Whether a name uses Latin letters beside letters of any other script. It
 * reads the NFKC form only, never the digit fold: digits have no script, so
 * `s3-sync` passes here and folds to letters only where reserved words are
 * compared. A name written wholly in one other script passes.
 */
function mixesScripts(name: string): boolean {
  const visible = name.normalize('NFKC').replace(INVISIBLE, '');
  const latin = /\p{Script=Latin}/u.test(visible);
  return latin && /(?!\p{Script=Latin})\p{L}/u.test(visible);
}

/** Whether a name uses a letter from {@link UNUSUAL_LETTERS}, before or after NFKC. */
function usesUnusualLetters(name: string): boolean {
  return UNUSUAL_LETTERS.test(name) || UNUSUAL_LETTERS.test(name.normalize('NFKC'));
}

/**
 * Why an app's name is refused, in the words the person sees, or `null` when
 * it may be used. Apply it to every app DorkOS did not ship (`origin` other
 * than `core`); DorkOS's own apps may carry its name.
 *
 * @param name - The manifest's `name`.
 */
export function reservedAppNameProblem(name: string): string | null {
  const folded = normalizedAppName(name);
  if (folded.startsWith(RESERVED_PREFIX) || reservedNames.has(folded)) {
    return RESERVED_APP_NAME_MESSAGE;
  }
  // Small capitals and phonetic letters are Latin by script, so the mix
  // check below cannot see them; they are refused wherever they appear.
  if (usesUnusualLetters(name)) return UNUSUAL_LETTER_APP_NAME_MESSAGE;
  // The look-alike table cannot list every letter, so a letter from another
  // script beside Latin ones is refused outright.
  if (mixesScripts(name)) return MIXED_SCRIPT_APP_NAME_MESSAGE;
  return null;
}
