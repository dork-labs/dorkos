/**
 * Cc addressing (DOR-3453): which `@mentions` in a channel message ask
 * somebody to answer, and which only send them a copy.
 *
 * Every `@mention` asks, unless the word `cc` comes before it on the same
 * line. So `cc @ana @bo` asks neither, and `@ana ship it, cc @bo` asks Ana and
 * copies Bo in. A cc'd person or agent sees the message in their next read of
 * the room, and no agent takes a turn for it. Naming somebody once outside a
 * cc asks them, so an addressee is never also a cc.
 *
 * This replaced first-@ addressing (DOR-3401), where every mention after the
 * leading run was a cc on its own. That rule failed silently on the most common
 * post: answer a person first, then hand work to agents further down.
 *
 * One module, read by both sides: the server marks each stored span at write
 * time, and the composer applies the same rule live as somebody types. A second
 * copy is how the grey chip in the composer starts disagreeing with who actually
 * wakes.
 *
 * Pure and offset-based: it never resolves a name. The caller hands in spans it
 * has already resolved, so "mentions resolve once, at write time" stays true.
 *
 * @module shared/mention-addressing
 */

/** The fields of a resolved mention this rule reads. */
export interface AddressableSpan {
  /** Offset of the `@` in the raw text. */
  offset: number;
  /** Length of the matched `@handle`, `@` included. */
  length: number;
  /** Who the mention resolved to. */
  authorId: string;
}

/**
 * The word `cc` on its own, in any case: `cc`, `CC:`, `(cc @bo)`. Not inside a
 * word (`accent`) and not a handle (`@cc`), because a letter, digit, `_`, `.`,
 * `-` or `@` before it rules it out.
 */
const CC_WORD = /(?:^|[^A-Za-z0-9_.@-])cc(?![A-Za-z0-9_])/i;

/**
 * Whether a mention at `offset` follows the word `cc` on its own line.
 *
 * @param text - The raw message text.
 * @param offset - Where the mention's `@` sits.
 */
function followsCc(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return CC_WORD.test(text.slice(lineStart, offset));
}

/**
 * Mark every mention that follows `cc` on its line as a cc.
 *
 * @param text - The raw message text the spans index into.
 * @param spans - The resolved mentions, in any order.
 * @returns The same spans in text order, each with `cc: true` when it only
 *   copies its author in. Addressee spans carry no `cc` field at all, and an
 *   author asked anywhere in the message has no cc span.
 */
export function markCc<T extends AddressableSpan>(
  text: string,
  spans: readonly T[]
): Array<T & { cc?: true }> {
  const ordered = [...spans].sort((a, b) => a.offset - b.offset);
  const copied = ordered.map((span) => followsCc(text, span.offset));
  const addressees = new Set(
    ordered.filter((_, index) => !copied[index]).map((span) => span.authorId)
  );
  return ordered.map((span, index) =>
    copied[index] && !addressees.has(span.authorId) ? { ...span, cc: true as const } : span
  );
}

/**
 * The line that tells an author who their post reached (DOR-3454):
 * "Woke @ana, @bo. Cc: @kai." The server returns it from the post tool, and the
 * app shows it under a person's own post, so a name that only got a cc never
 * fails silently.
 *
 * @param woke - Handles of the agents the post asked, `@` included, in text
 *   order. A person named is told, and takes no turn, so is not listed.
 * @param cc - Handles the post only copied in, `@` included, in text order.
 * @returns One or two short sentences. Names nobody as "Woke nobody."
 */
export function reachLine(woke: readonly string[], cc: readonly string[]): string {
  const asked = woke.length > 0 ? `Woke ${woke.join(', ')}.` : 'Woke nobody.';
  return cc.length > 0 ? `${asked} Cc: ${cc.join(', ')}.` : asked;
}

/**
 * Who a message only copies in: authors with a cc span and no addressee span.
 *
 * @param spans - Spans already marked by {@link markCc}, or stored ones.
 * @returns Distinct author ids, in text order. Empty for spans with no marks,
 *   which is how every message written before cc addressing reads.
 */
export function ccAuthors(spans: readonly (AddressableSpan & { cc?: boolean })[]): string[] {
  const addressed = new Set(spans.filter((span) => !span.cc).map((span) => span.authorId));
  const cc: string[] = [];
  for (const span of spans) {
    if (span.cc && !addressed.has(span.authorId) && !cc.includes(span.authorId)) {
      cc.push(span.authorId);
    }
  }
  return cc;
}
