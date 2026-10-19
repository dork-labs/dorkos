const REGION_NAMES = new Intl.DisplayNames('en', { type: 'region' });
const EITHER = new Intl.ListFormat('en', { type: 'disjunction' });

// Countries whose English name reads with "the" in a sentence ("I live in the United States").
const WITH_THE = new Set([
  'US',
  'GB',
  'NL',
  'PH',
  'AE',
  'CZ',
  'DO',
  'BS',
  'GM',
  'CF',
  'KM',
  'MV',
  'MH',
  'SB',
  'VA',
]);

/** One country's English name, as it reads in a sentence; the code itself if it has no name. */
function countryName(code: string): string {
  const name = REGION_NAMES.of(code) ?? code;
  return WITH_THE.has(code) ? `the ${name}` : name;
}

/**
 * The host's allowed countries as they read after "live in": "the United States", or
 * "the United States, Canada, or Mexico".
 */
export function countryList(codes: string[]): string {
  return EITHER.format(codes.map(countryName));
}
