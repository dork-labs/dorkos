/**
 * Doc comments as an agent sees them, with no editor open (DOR-2983): threads
 * placed in the markdown on disk by Blintz's headless anchors, a found thread
 * with no exact span still returned, an orphaned thread reported as such, and
 * a range that cannot be anchored refused with words that say what to do.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initBoundary } from '../../../../lib/boundary.js';
import { anchorForRange } from '../anchor-model.js';
import {
  UNADDRESSABLE_RANGE_MESSAGE,
  createThreadOnRange,
  listThreadsForAgent,
} from '../comment-agent-view.js';
import { resolveDocLocation, type DocLocation } from '../doc-location.js';
import { createCommentHarness } from './comment-harness.js';

const MARKDOWN = [
  '# Launch',
  '',
  'Ship it on **Friday** please.',
  '',
  'A snake\\_case word lives here.',
  '',
].join('\n');

let space: string;
let doc: DocLocation;

beforeEach(async () => {
  space = realpathSync(mkdtempSync(path.join(tmpdir(), 'doc-comments-')));
  writeFileSync(path.join(space, 'plan.md'), MARKDOWN);
  await initBoundary(space);
  doc = await resolveDocLocation(space, 'plan.md');
});

afterEach(() => {
  rmSync(space, { recursive: true, force: true });
});

describe('agent doc comments', () => {
  it('opens a thread on a raw range and places it back on the same words', async () => {
    const h = createCommentHarness();
    const start = MARKDOWN.indexOf('Friday');
    const { thread } = await createThreadOnRange(
      h.service,
      doc,
      { author: h.agentAuthor('scout') },
      {
        start,
        end: start + 'Friday'.length,
        body: 'Is Friday firm?',
      }
    );
    expect(thread.anchor).toMatchObject({ v: 1, quote: 'Friday' });

    const [view] = await listThreadsForAgent(h.service, doc);
    expect(view).toMatchObject({
      id: thread.id,
      match: 'exact',
      quote: 'Friday',
      span: { start, end: start + 6, markdown: 'Friday' },
      comments: [expect.objectContaining({ author: 'scout', authorKind: 'agent' })],
    });
  });

  it('returns a found thread with no exact span when its words have no exact source', async () => {
    const h = createCommentHarness();
    const start = MARKDOWN.indexOf('A snake');
    const end = MARKDOWN.indexOf('here.') + 'here.'.length;
    await createThreadOnRange(
      h.service,
      doc,
      { author: h.agentAuthor('scout') },
      {
        start,
        end,
        body: 'Rename this.',
      }
    );

    const [view] = await listThreadsForAgent(h.service, doc);
    expect(view).toMatchObject({
      match: 'exact',
      quote: 'A snake_case word lives here.',
      span: null,
    });
  });

  it('reports a thread whose words were deleted as orphaned, and keeps it', async () => {
    const h = createCommentHarness();
    const start = MARKDOWN.indexOf('Friday');
    await createThreadOnRange(
      h.service,
      doc,
      { author: h.agentAuthor('scout') },
      {
        start,
        end: start + 6,
        body: 'Is Friday firm?',
      }
    );
    writeFileSync(path.join(space, 'plan.md'), '# Launch\n\nNothing left.\n');

    const [view] = await listThreadsForAgent(h.service, doc);
    expect(view).toMatchObject({ match: 'orphaned', quote: 'Friday', span: null });
  });

  it('refuses a range that ends inside an escaped run, telling the agent to widen it', async () => {
    const h = createCommentHarness();
    const inside = MARKDOWN.indexOf('case');
    expect(await anchorForRange(MARKDOWN, inside, inside + 4)).toBeNull();

    await expect(
      createThreadOnRange(
        h.service,
        doc,
        { author: h.agentAuthor('scout') },
        {
          start: inside,
          end: inside + 4,
          body: 'x',
        }
      )
    ).rejects.toMatchObject({ code: 'UNADDRESSABLE_RANGE', message: UNADDRESSABLE_RANGE_MESSAGE });
    expect(h.service.list(doc)).toEqual([]);
  });

  it('refuses a range outside the doc', async () => {
    const h = createCommentHarness();
    await expect(
      createThreadOnRange(
        h.service,
        doc,
        { author: h.agentAuthor('scout') },
        {
          start: 5,
          end: MARKDOWN.length + 10,
          body: 'x',
        }
      )
    ).rejects.toMatchObject({ code: 'UNADDRESSABLE_RANGE' });
  });
});
