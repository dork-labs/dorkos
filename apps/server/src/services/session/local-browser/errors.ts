/** Machine-readable refusal plus short app copy. Raw Playwright errors never reach the UI. */
export class LocalBrowserError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/** Keep browser navigation on websites rather than browser settings or local files. */
export function assertLocalBrowserUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new LocalBrowserError(
      'unsupported_address',
      'Use a website address starting with http or https.'
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new LocalBrowserError(
      'unsupported_address',
      'Use a website address starting with http or https.'
    );
}
