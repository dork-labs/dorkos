/**
 * Create a clickable hyperlink in terminals that support OSC 8.
 *
 * Falls back to plain text in non-TTY environments or when
 * `NO_COLOR` / `TERM=dumb` is set.
 *
 * @param text - Display text for the link
 * @param url - Target URL
 */
export function link(text: string, url: string): string {
  if (
    !process.stdout.isTTY ||
    process.env.NO_COLOR !== undefined ||
    process.env.TERM === 'dumb'
  ) {
    return text;
  }

  // OSC 8 hyperlink: \e]8;;URL\e\\TEXT\e]8;;\e\\
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
}
