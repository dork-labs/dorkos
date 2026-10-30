/**
 * First-@ addressing (DOR-3401): which `@mentions` in a channel message ask
 * somebody to answer, and which only send them a copy.
 *
 * The first `@mention` names the addressee, and a run of mentions joined only
 * by spaces, commas, `&`, `+`, `/` or "and" names them all, so
 * `@ana @bo: ship it` asks both. Every later mention is a **cc**: the person
 * or agent sees it in their next read of the room, and no agent takes a turn
 * for it. Naming somebody twice keeps the first reading, so an addressee is
 * never also a cc.
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
 * The only text allowed between two mentions of one leading run. Anything else,
 * a colon included, ends the run: `@ana: ask @bo` asks Ana and copies Bo.
 */
const RUN_GAP = /^[\s,&+/]*(?:and[\s,&+/]+)?$/i;

/**
 * Mark every mention after the leading run as a cc.
 *
 * @param text - The raw message text the spans index into.
 * @param spans - The resolved mentions, in any order.
 * @returns The same spans in text order, each with `cc: true` when it only
 *   copies its author in. Addressee spans carry no `cc` field at all.
 */
export function markCc<T extends AddressableSpan>(
  text: string,
  spans: readonly T[]
): Array<T & { cc?: true }> {
  const ordered = [...spans].sort((a, b) => a.offset - b.offset);
  const addressees = new Set<string>();
  let runOpen = true;
  return ordered.map((span, index) => {
    if (runOpen && index > 0) {
      const previous = ordered[index - 1]!;
      runOpen = RUN_GAP.test(text.slice(previous.offset + previous.length, span.offset));
    }
    if (runOpen) addressees.add(span.authorId);
    return addressees.has(span.authorId) ? span : { ...span, cc: true as const };
  });
}

/**
 * Who a message only copies in: authors with a cc span and no addressee span.
 *
 * @param spans - Spans already marked by {@link markCc}, or stored ones.
 * @returns Distinct author ids, in text order. Empty for spans with no marks,
 *   which is how every message written before this rule reads.
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
