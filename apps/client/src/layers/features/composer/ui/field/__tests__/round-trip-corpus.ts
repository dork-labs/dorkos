/**
 * The markdown the composer must survive, as data.
 *
 * Adding a case is a data change. Every entry is parsed with
 * `COMPOSER_TRANSFORMERS` and written back with `$serializeWithOffsets`; unless
 * it declares otherwise, the result must equal the input exactly.
 *
 * **`normalizesTo` is not an escape hatch, it is the finding.** A handful of
 * inputs cannot round-trip to themselves because markdown spells one thing two
 * ways and the document model keeps only the thing: there is one bold bit, not
 * a `**`-bold and a `__`-bold, and one unordered list type, not three markers.
 * Deleting those cases would hide a real behaviour; asserting the exact output
 * pins it. Every entry — normalized or not — is additionally required to be a
 * FIXED POINT, which is the property the controlled loop actually depends on:
 * one pass may rewrite, a second pass may not.
 *
 * @module features/composer/ui/field/__tests__/round-trip-corpus
 */

/** One corpus entry. */
export interface RoundTripCase {
  readonly md: string;
  /** What the serializer writes back, when that is not `md` itself. */
  readonly normalizesTo?: string;
  /** Why it cannot be the identity. Required whenever `normalizesTo` is set. */
  readonly why?: string;
}

/** Every markdown shape the composer is required to survive. */
export const ROUND_TRIP_CORPUS: readonly RoundTripCase[] = [
  // Every supported syntax, alone.
  { md: '**bold**' },
  {
    md: '__bold__',
    normalizesTo: '**bold**',
    why: 'One bold format bit; the node cannot remember which of the two spellings made it.',
  },
  { md: '*italic*' },
  {
    md: '_italic_',
    normalizesTo: '*italic*',
    why: 'One italic format bit, same as bold.',
  },
  { md: '`code`' },
  { md: '# h1' },
  { md: '## h2' },
  { md: '### h3' },
  { md: '- a' },
  {
    md: '* a',
    normalizesTo: '- a',
    why: 'One unordered list type; `-`, `*` and `+` are three spellings of it.',
  },
  {
    md: '+ a',
    normalizesTo: '- a',
    why: 'One unordered list type; `-`, `*` and `+` are three spellings of it.',
  },
  { md: '1. a' },
  { md: '1. a\n2. b' },
  { md: '- a\n- b' },

  // Nested.
  { md: '- **bold item**' },
  { md: '# *ital head*' },
  { md: '**a `c` b**' },
  {
    md: '**_both_**',
    normalizesTo: '***both***',
    why: 'Bold+italic has one canonical spelling; the nesting order is fixed.',
  },
  { md: '**a**\n**b**' },

  // Every unsupported syntax, which must survive untransformed. This is the
  // half the stock serializer got wrong: it escaped all of them.
  { md: '> quote' },
  { md: '```\ncode\n```' },
  { md: '[text](url)' },
  { md: '~~strike~~' },
  { md: '| a | b |\n| --- | --- |' },
  { md: '---' },
  { md: '![alt](src)' },
  { md: '#### h4' },

  // Mentions, in every position the roster promotion has to cope with.
  { md: '@ana' },
  { md: 'hi @ana, ok' },
  { md: '(@ana)' },
  { md: '@ana @kai' },
  { md: 'see @ana.' },

  // The backslash-continuation rung depends on this surviving byte for byte.
  { md: 'foo\\' },
  { md: 'foo\\\\' },

  // Line endings and blank lines.
  { md: 'a\r\nb' },
  { md: 'line1\nline2' },
  { md: 'para1\n\npara2' },
  { md: '# h1\n\npara' },
  { md: 'para\n\n- a\n- b' },
  {
    md: 'a\n\n\nb',
    normalizesTo: 'a\n\nb',
    why: 'Two paragraphs is two paragraphs; the model has no third blank line to keep.',
  },

  // Empty and whitespace.
  { md: '' },
  {
    md: '   ',
    normalizesTo: '',
    why: 'The parser drops a whitespace-only document to one empty paragraph.',
  },

  // Literals that look like syntax but are not.
  { md: '2 ** 3' },
  { md: '*' },
  { md: '1.5x faster' },
];
