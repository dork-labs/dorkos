declare const normalized: unique symbol;

/**
 * A message's subject and plain-text body, ready to send. The address is added at send time.
 * Only {@link plainTextMail} can make one, so every composer's text has passed its line-ending
 * and control-character clean-up: no bare carriage return can reach the SMTP body, where
 * `\r.\r` could end the message early on a server that treats a lone CR as a line end.
 */
export interface ComposedMail {
  readonly subject: string;
  readonly text: string;
  readonly [normalized]: true;
}

const CONTROL = /\p{Cc}/u;
const CONTROLS = /\p{Cc}/gu;

/**
 * Build a plain-text message from a one-line subject and paragraphs. No HTML, no tracking, no
 * rewritten links: a paragraph goes out exactly as written, with a blank line between each.
 * Every CRLF and bare CR becomes a line feed, other control characters are dropped from the body, and a subject that is
 * empty, longer than 200 characters, or holds any control character is refused, because a line
 * break there would start a new mail header.
 */
export function plainTextMail(subject: string, paragraphs: readonly string[]): ComposedMail {
  const line = subject.trim();
  if (!line || line.length > 200 || CONTROL.test(line))
    throw new Error('A mail subject must be one line of 1 to 200 characters');
  const text = paragraphs
    .map((paragraph) =>
      paragraph
        .replace(/\r\n?/gu, '\n')
        .replace(CONTROLS, (control) => (control === '\n' ? control : ''))
        .trim()
    )
    .filter(Boolean)
    .join('\n\n');
  if (!text) throw new Error('A mail body must have at least one paragraph');
  return { subject: line, text: `${text}\n` } as ComposedMail;
}
