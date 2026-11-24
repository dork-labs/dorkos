/**
 * Line-level markdown rewrites the release commit needs, each one aware of
 * code: text inside a fenced block or an inline code span is never touched.
 *
 * - {@link backtickMentions}: GitHub turns a bare `@word` in release notes into
 *   a real ping (v0.129.0 pinged three strangers). The daily release puts the
 *   handle in backticks instead of refusing, so no person is needed. The rule
 *   for what counts as a mention is `.claude/scripts/release_mentions.py`'s,
 *   ported as is: emails, versions, URL paths, escapes and npm scopes pass.
 * - {@link escapeMdx}: `docs/changelog.mdx` is MDX, where a bare `{` opens an
 *   expression and a bare `<` opens a tag, so a fragment bullet holding either
 *   breaks the site build (v0.74.0). The docs copy escapes them; the
 *   `CHANGELOG.md` copy stays as written.
 *
 * @module scripts/release/markdown
 */

const FENCE = /^\s*(?:>\s*)*(`{3,}|~{3,})(.*)$/;
const INLINE_CODE = /(?<!`)(`+)(?!`).+?(?<!`)\1(?!`)/g;
// Same lookbehind as release_mentions.py: it is what lets emails, versions,
// URL paths and escaped `\@word` through.
const MENTION =
  /(?<![A-Za-z0-9_+\-/\\])@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(\/[A-Za-z0-9._-]+)?/g;

/**
 * Apply `rewrite` to the prose of each line, skipping fenced blocks and inline
 * code spans. Fence rules match `release_mentions.py`: a closing fence uses the
 * opening character, is at least as long, and has no info string; a backtick in
 * the info string makes the line inline code, not a fence.
 */
export function mapProse(lines: readonly string[], rewrite: (prose: string) => string): string[] {
  const out: string[] = [];
  let open: string | undefined;
  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (open !== undefined) {
      const marker = fence?.[1];
      if (marker && marker[0] === open[0] && marker.length >= open.length && !fence[2]?.trim())
        open = undefined;
      out.push(line);
      continue;
    }
    if (fence?.[1] && !(fence[1][0] === '`' && fence[2]?.includes('`'))) {
      open = fence[1];
      out.push(line);
      continue;
    }
    out.push(mapOutsideInlineCode(line, rewrite));
  }
  return out;
}

/** Put every bare `@handle` that GitHub would ping in backticks. */
export function backtickMentions(lines: readonly string[]): string[] {
  return mapProse(lines, (prose) =>
    prose.replace(MENTION, (match: string, _handle: string, scope: string | undefined) =>
      scope ? match : `\`${match}\``
    )
  );
}

/** The bare `@handle`s GitHub would ping, in order; empty when the text is safe. */
export function findMentions(lines: readonly string[]): string[] {
  const found: string[] = [];
  mapProse(lines, (prose) => {
    for (const match of prose.matchAll(MENTION)) if (!match[2]) found.push(`@${match[1]}`);
    return prose;
  });
  return found;
}

/** Escape a bare `{` and `<` for MDX, as `\{` and `&lt;` (the archive's own spelling). */
export function escapeMdx(lines: readonly string[]): string[] {
  return mapProse(lines, (prose) => prose.replace(/(?<!\\)\{/g, '\\{').replace(/</g, '&lt;'));
}

function mapOutsideInlineCode(line: string, rewrite: (prose: string) => string): string {
  let out = '';
  let last = 0;
  for (const match of line.matchAll(INLINE_CODE)) {
    const start = match.index ?? 0;
    out += rewrite(line.slice(last, start)) + match[0];
    last = start + match[0].length;
  }
  return out + rewrite(line.slice(last));
}
