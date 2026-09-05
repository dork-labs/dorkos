/**
 * Plain text with bare `http(s)` URLs turned into real links — the renderer for
 * strings that are **machine output rather than prose**: runtime and transport
 * error messages, adapter failures, widget errors.
 *
 * ## Why not just render error text as markdown
 *
 * Every other text surface in the app goes through Streamdown (`MarkdownContent`
 * / `StreamingText`), which already linkifies. Error text deliberately does not,
 * for two reasons:
 *
 * 1. **Fidelity.** An error string is whatever a provider, a sidecar, or a stack
 *    trace produced. It routinely contains `*`, `_`, backticks, `#`, `-`, `>`,
 *    `[`, JSON braces and newlines. Markdown would restructure exactly the
 *    string a person is trying to read literally — swallowing backticks,
 *    promoting a leading `#` to a heading, turning a `-` prefixed line into a
 *    list, collapsing the line breaks of a stack trace. `details` is already a
 *    `<pre>` for that reason; the message deserves the same honesty.
 * 2. **Spoofing.** Error text is untrusted — it can be authored by a remote
 *    provider. Markdown would let it render `[https://dorkos.ai/settings](
 *    https://attacker.example)`: a link whose visible label lies about its
 *    destination, inside DorkOS's own error chrome. Here the label is the
 *    NORMALIZED href — the string the browser will actually request, not the
 *    string the provider wrote — so a label that reads as one host while
 *    resolving to another is not expressible. See {@link normalizeUrl} for why
 *    showing the raw match was not enough (a Cyrillic `о` falsified it).
 *    Markdown images (a tracking beacon fired by an error message) and the
 *    whole raw-HTML/`allowedTags` question also stop existing.
 *
 * What is *not* reinvented is the link itself: every anchor is the shared
 * {@link MarkdownLink}, so the confirm-before-navigate {@link LinkSafetyModal},
 * `rel="noopener noreferrer"`, `target="_blank"` (which the desktop shell's
 * window-open handler routes to the system browser) and the modified-click
 * policy are identical to every other link in the app.
 *
 * Callers own the wrapper element and its whitespace handling — this renders a
 * bare fragment so it drops into a `<p>`, a `<pre>` or a `<span>` alike.
 */
import { memo, useMemo, type ReactNode } from 'react';
import { MarkdownLink } from './markdown-link';

/**
 * Bare `http(s)` URLs only. Deliberately narrow, in three ways:
 *
 * - `www.`-style and scheme-less hosts stay text — guessing a scheme for
 *   untrusted input is how a linkifier starts inventing destinations.
 * - `<>"'` and the backtick end a match, so a URL quoted or angle-bracketed
 *   inside an error message does not swallow its own delimiter.
 * - `[` and `]` end a match too. Without that, markdown link syntax an untrusted
 *   error could contain — `[https://dorkos.ai/settings](https://attacker.example)`
 *   — matched as ONE URL through the `](`, producing an anchor whose visible
 *   label opened with a decoy host. The cost is that a bracketed IPv6 literal
 *   (`http://[::1]:8080/`) stays plain text, which is the right trade for a
 *   surface whose whole job is to be un-spoofable.
 */
const URL_SCANNER = /https?:\/\/[^\s<>[\]"'`]+/gi;

/** Trailing characters that end a sentence far more often than they end a URL. */
const SENTENCE_PUNCTUATION: ReadonlySet<string> = new Set(['.', ',', ';', ':', '!', '?', "'", '"']);

/** Closing brackets that only belong to a URL when it opened them itself. */
const BRACKET_PAIRS: ReadonlyMap<string, string> = new Map([
  [')', '('],
  [']', '['],
  ['}', '{'],
]);

/**
 * Trim the punctuation a sentence left on the end of a matched URL.
 *
 * `Add credits at https://openrouter.ai/settings/credits.` must not link the
 * full stop, and `(see https://dorkos.ai/docs)` must not link the paren — but
 * `https://en.wikipedia.org/wiki/Foo_(bar)` must keep the one it opened, so a
 * closing bracket is only dropped when it is unbalanced within the match.
 *
 * **Linear, and that is load-bearing.** The first version recounted both
 * brackets across the whole remaining string on every iteration while removing
 * one character, which is O(n²) — and `)` and `}` are not excluded from
 * {@link URL_SCANNER}, so a single match can end in an arbitrarily long run of
 * them. A provider error ending in 40,000 `)` froze the main thread for ~19
 * seconds, inside a `useMemo` during render, with no spinner and no recovery.
 * Balances are now counted once up front and decremented as characters come
 * off the end, so the whole pass is one scan (DOR-1661 review, red 1).
 *
 * @param raw - One raw `URL_SCANNER` match.
 * @returns The match with its sentence tail removed.
 */
function trimUrlTail(raw: string): string {
  const openCount = new Map<string, number>();
  const closeCount = new Map<string, number>();
  for (const [closer, opener] of BRACKET_PAIRS) {
    closeCount.set(closer, 0);
    openCount.set(opener, 0);
  }
  // One pass over the match, not one pass per character removed.
  for (const char of raw) {
    const open = openCount.get(char);
    if (open !== undefined) {
      openCount.set(char, open + 1);
      continue;
    }
    const close = closeCount.get(char);
    if (close !== undefined) closeCount.set(char, close + 1);
  }

  let end = raw.length;
  while (end > 0) {
    const char = raw[end - 1];
    if (SENTENCE_PUNCTUATION.has(char)) {
      end -= 1;
      continue;
    }
    const opener = BRACKET_PAIRS.get(char);
    if (opener !== undefined && closeCount.get(char)! > openCount.get(opener)!) {
      closeCount.set(char, closeCount.get(char)! - 1);
      end -= 1;
      continue;
    }
    break;
  }
  return raw.slice(0, end);
}

/**
 * The URL a browser would actually go to, or `null` when this match must not
 * become a link.
 *
 * **This is the whole anti-spoofing story, and the raw string is not it.** The
 * label being character-for-character the href is only un-spoofable if the
 * browser navigates to the characters shown — and it does not. It normalizes
 * first: `https://dоrkos.ai` with a Cyrillic `о` (U+043E) is requested as
 * `https://xn--drkos-jye.ai`, `dorkos.ai。evil.example` becomes the host
 * `dorkos.ai.evil.example` under UTS46, and a U+202E right-to-left override in
 * a path renders a `.exe` as `.png`. Rendering the RAW match therefore showed
 * the reader a destination that was not the destination — inside DorkOS's own
 * error chrome, from text a remote provider authored (DOR-1661 review, red 3).
 *
 * So the normalized `href` is what gets shown AND what gets opened: punycode,
 * `%E2%80%AE` and a collapsed host are all visible, and divergence between the
 * two genuinely stops being expressible.
 *
 * Normalizing is not enough on its own for one shape: userinfo survives it
 * intact (`https://dorkos.ai@evil.example/x` normalizes to itself, host
 * `evil.example`), so a reader still reads the decoy first. Those are refused
 * outright rather than rendered — a bare URL inside an error message that
 * carries credentials is either a phishing shape or a leaked secret, and
 * neither should become something to click.
 *
 * @param candidate - A trimmed `URL_SCANNER` match.
 * @returns The normalized absolute URL, or `null` to leave the match as text.
 */
function normalizeUrl(candidate: string): string | null {
  let parsed: URL;
  try {
    // `try`/`catch` rather than `URL.canParse`: this runs under jsdom in tests
    // as well as in a browser, and the constructor is the one form both have
    // had forever.
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '') return null;
  return parsed.href;
}

/** A run of literal text, or a URL to render as a link. */
type Segment = { kind: 'text'; value: string } | { kind: 'link'; url: string };

/**
 * Split a string into literal runs and linkable `http(s)` URLs.
 *
 * A match that survives {@link trimUrlTail} but that {@link normalizeUrl}
 * refuses — a bare `https://`, or a URL carrying credentials — stays literal
 * text rather than becoming a dead or deceptive link.
 *
 * A link segment's `url` is the NORMALIZED form, while the cursor advances by
 * the length of the RAW match it came from. The two are deliberately different
 * numbers: normalization can lengthen (`dоrkos.ai` → `xn--drkos-jye.ai`) or
 * shorten the string, and advancing by the normalized length would slice the
 * surrounding text at the wrong offset.
 *
 * @param text - The raw string to scan.
 * @returns The string's segments in order; a string with no URL yields one
 *   text segment.
 */
export function splitOnUrls(text: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  // A fresh regex per call: `URL_SCANNER` is global, so a shared instance would
  // carry `lastIndex` between calls and skip matches.
  const scanner = new RegExp(URL_SCANNER.source, URL_SCANNER.flags);
  for (let match = scanner.exec(text); match !== null; match = scanner.exec(text)) {
    const raw = trimUrlTail(match[0]);
    const url = normalizeUrl(raw);
    if (url === null) continue;
    if (match.index > cursor) {
      segments.push({ kind: 'text', value: text.slice(cursor, match.index) });
    }
    segments.push({ kind: 'link', url });
    cursor = match.index + raw.length;
    // The trimmed tail is punctuation belonging to the sentence, so rewind the
    // scanner to it rather than letting the match consume it.
    scanner.lastIndex = cursor;
  }
  if (cursor < text.length) segments.push({ kind: 'text', value: text.slice(cursor) });
  return segments;
}

/**
 * Whether a string contains at least one URL this module would linkify.
 *
 * Exported for callers that must decide whether a piece of untrusted text
 * carries a destination worth surfacing on its own line — see
 * `ErrorMessageBlock`, which uses it to tell a provider message that adds a
 * link from one that only paraphrases DorkOS's own copy.
 *
 * @param text - The string to scan.
 */
export function containsUrl(text: string): boolean {
  return splitOnUrls(text).some((segment) => segment.kind === 'link');
}

export interface LinkifiedTextProps {
  /** The literal string to render. Untrusted — see this module's TSDoc. */
  text: string;
}

function LinkifiedTextImpl({ text }: LinkifiedTextProps): ReactNode {
  const segments = useMemo(() => splitOnUrls(text), [text]);
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'text' ? (
          segment.value
        ) : (
          // Index keys are safe here: the list is derived from `text` alone and
          // is rebuilt whole whenever it changes — nothing is reordered in place.
          <MarkdownLink key={index} href={segment.url}>
            {segment.url}
          </MarkdownLink>
        )
      )}
    </>
  );
}

/**
 * Render untrusted plain text with its bare `http(s)` URLs as real, confirmed
 * links. Renders a bare fragment — the caller owns the wrapping element and its
 * whitespace handling.
 *
 * @param props - The literal string to render.
 */
export const LinkifiedText = memo(LinkifiedTextImpl);
