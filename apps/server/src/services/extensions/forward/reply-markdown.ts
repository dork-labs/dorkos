/**
 * An agent's answer to a forwarded comment, made safe to render in a mini
 * app's page, which runs as the person (DOR-3325).
 *
 * @module services/extensions/forward/reply-markdown
 */
import { fromMarkdown } from 'mdast-util-from-markdown';

/**
 * A link target a reply may keep: web, mail, an in-page anchor, or a path. A
 * path may not start `//` or `/\`, which browsers read as another host.
 */
const SAFE_TARGET = /^(?:https?:\/\/|mailto:|#|\/(?![/\\]))/iu;

/** Whether a link target may stay. */
function isSafeTarget(target: string): boolean {
  return SAFE_TARGET.test(target.trim());
}

/** Whether a parsed tree holds any link, image or definition with a target that may not stay. */
function hasUnsafeTarget(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  const { url, children } = node as { url?: unknown; children?: unknown };
  if (typeof url === 'string' && !isSafeTarget(url)) return true;
  return Array.isArray(children) && children.some(hasUnsafeTarget);
}

/**
 * Agent markdown with no way to become HTML or a script or off-site link.
 * Allow-listed, not deny-listed, because markdown has more ways to spell a
 * link than a deny-list can name:
 *
 * 1. Every `&` and `<` is escaped, so no tag, autolink or character reference
 *    (`java&#115;cript:`) survives to be decoded.
 * 2. Every inline link or image target, and every reference definition at a
 *    line's start (`[1]: …`), keeps its target only when it is `http(s)://`,
 *    `mailto:`, an anchor or a path, and becomes `#` otherwise.
 * 3. The result is parsed as markdown, and every link, image and definition
 *    in the tree is checked again: inside quotes and lists, behind escaped
 *    labels, anywhere step 2's patterns did not reach. If any target is still
 *    unsafe, every bracket is escaped, so the reply carries no links at all.
 *
 * The mini app renders the result as markdown, never as HTML.
 *
 * @param text - The agent's post.
 */
export function defuseReplyMarkdown(text: string): string {
  const safe = (target: string) => (isSafeTarget(target) ? target : '#');
  const rewritten = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(
      /\]\(\s*((?:[^()\s]|\([^()]*\))*)([^)]*)\)/gu,
      (_m, target: string, rest: string) => `](${safe(target)}${rest})`
    )
    .replace(
      /^( {0,3}\[[^\]]+\]:\s*)(\S+)/gmu,
      (_m, head: string, target: string) => `${head}${safe(target)}`
    );
  if (!hasUnsafeTarget(fromMarkdown(rewritten))) return rewritten;
  return rewritten.replace(/[[\]]/g, (bracket) => `\\${bracket}`);
}
