/**
 * Every caller reads `flow order` (DOR-5064). The order of work is one
 * function in the `/flow` plugin, ranked from Linear fields. Before it, briefs
 * and heartbeats each said how to pick the next item ("the highest-ranked
 * unstarted Must in FIX-QUEUE.md"), and each quietly became its own order.
 *
 * Crude on purpose (research/20261122_work-sequencing.md §3.10 item 4): a
 * paragraph or list item in one of these files that talks about "what's next",
 * "next unstarted", "highest-ranked Must" or "FIX-QUEUE" must name `flow order`
 * in the same block, so no file can describe another way to pick work without
 * pointing at the one that counts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The tracked files that tell a person or an agent what to work on next. */
const CALLER_FILES = ['contributing/prioritization.md', '.dork/HEARTBEAT.md', 'AGENTS.md'] as const;

/**
 * Words that describe picking the next item ("what's" with either apostrophe),
 * plus the retired fix queue and its rule.
 */
const PICKING_WORDS = /what[’']s next|next unstarted|highest-ranked must|fix-queue/i;

/** The command every such paragraph must name. */
const THE_ORDER = 'flow order';

/**
 * The blocks that talk about picking the next item without naming `flow order`.
 * A block is a paragraph (text between blank lines) or one list item, so one
 * item in a checklist cannot borrow `flow order` from its neighbour.
 *
 * @param text - A Markdown file's contents.
 * @returns Each offending paragraph, trimmed to its first line.
 */
function strayPickers(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .flatMap((paragraph) => paragraph.split(/\n(?=\s*[-*] )/))
    .filter((paragraph) => PICKING_WORDS.test(paragraph) && !paragraph.includes(THE_ORDER))
    .map((paragraph) => paragraph.trim().split('\n')[0] ?? '');
}

describe('every caller reads flow order (DOR-5064)', () => {
  it.each(CALLER_FILES)('%s never says what is next without flow order', (file) => {
    expect(strayPickers(readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('the rubric has the section the callers point at', () => {
    const rubric = readFileSync('contributing/prioritization.md', 'utf8');
    expect(rubric).toContain('## How the order is computed');
    expect(readFileSync('AGENTS.md', 'utf8')).toContain(
      'contributing/prioritization.md#how-the-order-is-computed'
    );
  });

  it('flags a paragraph that picks work without flow order, and passes one that names it', () => {
    expect(strayPickers("Take what's next in FIX-QUEUE.md.")).toHaveLength(1);
    expect(strayPickers('A freed lane takes the NEXT UNSTARTED Must.')).toHaveLength(1);
    expect(strayPickers('What’s next is the top of the queue.')).toHaveLength(1);
    expect(strayPickers("What's next comes from `flow order -n 5 --json`.")).toEqual([]);
    expect(
      strayPickers("Ask `flow order --projects`.\n\nThen take what's next by hand.")
    ).toHaveLength(1);
    expect(strayPickers('Ship the next release.')).toEqual([]);
    expect(strayPickers('Take the highest-ranked Must.')).toHaveLength(1);
    expect(strayPickers('Read FIX-QUEUE.md first.')).toHaveLength(1);
  });

  it('reads each list item on its own, so a neighbour cannot vouch for it', () => {
    const checklist = [
      '- [ ] Run `flow order --projects`.',
      "- [ ] Then take what's next by hand.",
      '  * nested: the next unstarted Must.',
    ].join('\n');
    expect(strayPickers(checklist)).toEqual([
      "- [ ] Then take what's next by hand.",
      '* nested: the next unstarted Must.',
    ]);
    expect(strayPickers("- [ ] What's next comes from `flow order`.\n- [ ] Ship it.")).toEqual([]);
  });
});
