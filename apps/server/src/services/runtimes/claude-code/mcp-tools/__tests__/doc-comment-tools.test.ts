/**
 * The agent's doc comment tools (DOR-2983): refused plainly while the
 * experiment is off, a found thread with no exact span returned and said so,
 * a range that cannot be anchored refused with what to do, and a mention the
 * reply limits stopped reported back to the agent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initBoundary } from '../../../../../lib/boundary.js';
import { createCommentHarness } from '../../../../docs/comments/__tests__/comment-harness.js';
import type { DocComments } from '../../../../docs/comments/index.js';

const state = vi.hoisted(() => ({
  enabled: true,
  comments: null as DocComments | null,
}));

vi.mock('../../../../docs/docs-experiment.js', () => ({ docsEnabled: () => state.enabled }));
vi.mock('../../../../docs/comments/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../docs/comments/index.js')>()),
  getDocComments: () => state.comments,
}));

const { getDocCommentTools } = await import('../doc-comment-tools.js');

const MARKDOWN = 'Ship on **Friday**.\n\nA snake\\_case word.\n';

let space: string;

beforeEach(async () => {
  space = realpathSync(mkdtempSync(path.join(tmpdir(), 'doc-comment-tools-')));
  writeFileSync(path.join(space, 'plan.md'), MARKDOWN);
  await initBoundary(space);
  state.enabled = true;
});

afterEach(() => {
  rmSync(space, { recursive: true, force: true });
});

/** The tools, called as the scout agent from a chat in the space. */
function tools(sessionId = 'scout-chat') {
  const h = createCommentHarness();
  state.comments = { service: h.service, directory: h.directory, waker: h.waker };
  const list = getDocCommentTools(() => ({ agentPath: '/agents/scout', sessionId, cwd: space }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const definition = list.find((tool) => tool.name === name)!;
    const result = (await definition.handler(args as never, {})) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    return { data: JSON.parse(result.content[0]!.text), isError: result.isError === true };
  };
  return { h, call };
}

describe('doc comment tools', () => {
  it('refuses plainly while the experiment is off', async () => {
    const { call } = tools();
    state.enabled = false;
    const result = await call('doc_comment_list', { path: 'plan.md' });
    expect(result).toEqual({
      data: { error: 'Doc comments are off on this computer.' },
      isError: true,
    });
  });

  it('lists a found thread with no exact span, rather than calling it orphaned', async () => {
    const { call } = tools();
    const start = MARKDOWN.indexOf('A snake');
    await call('doc_comment_create', {
      path: 'plan.md',
      start,
      end: MARKDOWN.indexOf('word.') + 5,
      body: 'Rename this.',
    });

    const { data } = await call('doc_comment_list', { path: 'plan.md' });
    expect(data.threads).toEqual([
      expect.objectContaining({ match: 'exact', quote: 'A snake_case word.', span: null }),
    ]);
  });

  it('refuses a range that cannot be anchored, saying to widen it', async () => {
    const { call } = tools();
    const inside = MARKDOWN.indexOf('case');
    const result = await call('doc_comment_create', {
      path: 'plan.md',
      start: inside,
      end: inside + 4,
      body: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.data.error).toContain('Widen it to whole words, lines or paragraphs');
  });

  it('tells the agent when its mention woke nobody', async () => {
    const { call } = tools();
    const start = MARKDOWN.indexOf('Friday');
    const { data } = await call('doc_comment_create', {
      path: 'plan.md',
      start,
      end: start + 6,
      body: '@quill have a look',
    });
    expect(data.notWoken).toEqual([
      'quill was not woken: the chain of automatic replies reached its limit.',
    ]);
  });

  it('replies and resolves as the calling agent', async () => {
    const { call } = tools();
    const start = MARKDOWN.indexOf('Friday');
    const { data } = await call('doc_comment_create', {
      path: 'plan.md',
      start,
      end: start + 6,
      body: 'Firm?',
    });
    await call('doc_comment_reply', { path: 'plan.md', threadId: data.threadId, body: 'Yes.' });
    const resolved = await call('doc_comment_resolve', {
      path: 'plan.md',
      threadId: data.threadId,
    });
    expect(resolved.data).toEqual({ threadId: data.threadId, resolved: true });

    const listed = await call('doc_comment_list', { path: 'plan.md' });
    expect(listed.data.threads[0].comments.map((c: { body: string }) => c.body)).toEqual([
      'Firm?',
      'Yes.',
    ]);
  });

  it('refuses a doc outside the boundary', async () => {
    const { call } = tools();
    const result = await call('doc_comment_list', { path: 'plan.md', cwd: tmpdir() });
    expect(result.isError).toBe(true);
  });
});
