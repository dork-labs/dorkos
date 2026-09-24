const FENCE = /^ {0,3}((`{3,})|(~{3,}))/;
const QUOTE = /^ {0,3}>/;
const INLINE_CODE = /`[^`]*`/g;
/** One `@` address token as the resolver reads it; group 1 is the address without `@`. */
export const MENTION_ADDRESS = /@([A-Za-z0-9][A-Za-z0-9_.-]*)/g;
/** Trailing punctuation the resolver drops from an address before its second lookup. */
export const MENTION_TRAILING_STRIP = /[.\-_]+$/;

/** One currently joined channel identity that may be addressed. */
export interface AddressableMember {
  id: string;
  handle: string;
}

/**
 * Blank out fenced code, inline code, and quoted lines, keeping every other character at its
 * position, so an address found in the result sits at the same index in the original text.
 */
export function maskedText(text: string): string {
  const lines = text.split('\n');
  const fenced = new Set<number>();
  for (let at = 0; at < lines.length; at += 1) {
    const opener = FENCE.exec(lines[at]);
    if (!opener) continue;
    let close = -1;
    for (let end = at + 1; end < lines.length; end += 1) {
      const candidate = FENCE.exec(lines[end]);
      if (
        candidate &&
        candidate[1][0] === opener[1][0] &&
        candidate[1].length >= opener[1].length &&
        lines[end].slice(lines[end].indexOf(candidate[1]) + candidate[1].length).trim() === ''
      ) {
        close = end;
        break;
      }
    }
    if (close < 0) continue;
    for (let index = at; index <= close; index += 1) fenced.add(index);
    at = close;
  }
  return lines
    .map((line, index) =>
      fenced.has(index) || QUOTE.test(line)
        ? ' '.repeat(line.length)
        : line.replace(INLINE_CODE, (span) => ' '.repeat(span.length))
    )
    .join('\n');
}

/** Resolve joined roster handles once, before persisting a community post. */
export function resolveCommunityMentions(
  text: string,
  roster: readonly AddressableMember[]
): string[] {
  const byHandle = new Map(roster.map((member) => [member.handle.toLowerCase(), member.id]));
  const seen = new Set<string>();
  const mentions: string[] = [];
  for (const match of maskedText(text).matchAll(MENTION_ADDRESS)) {
    const raw = match[1].toLowerCase();
    const found = byHandle.get(raw) ?? byHandle.get(raw.replace(MENTION_TRAILING_STRIP, ''));
    if (found && !seen.has(found)) {
      seen.add(found);
      mentions.push(found);
    }
  }
  return mentions;
}
