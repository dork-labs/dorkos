/**
 * Agent tools for comments on docs (DOR-2983): read a doc's threads, open a
 * thread on a raw markdown range, reply, and resolve or reopen.
 *
 * Agents usually work with no editor open, so threads are placed in the doc's
 * markdown as it is on disk now, exactly where the editor would put them
 * (`services/docs/comments/comment-agent-view.ts`).
 *
 * The agent writes as itself: its author is minted from its verified identity
 * (the session's agent home), never from an argument. A comment it writes in
 * a turn a comment woke continues that comment's chain of automatic replies,
 * found by the verified calling chat; any other comment it writes wakes
 * nobody it mentions (`services/docs/comments/comment-wake.ts`).
 *
 * Every tool refuses plainly while the `docs.enabled` experiment is off.
 *
 * @module services/runtimes/claude-code/mcp-tools/doc-comment-tools
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  DOC_COMMENT_BODY_MAX,
  DOC_PATH_MAX,
  type DocCommentUnreached,
} from '@dorkos/shared/doc-comments';
import { BoundaryError } from '../../../../lib/boundary.js';
import { DocPathError } from '../../../docs/doc-space.js';
import { docsEnabled } from '../../../docs/docs-experiment.js';
import {
  createThreadOnRange,
  DocCommentError,
  getDocComments,
  listThreadsForAgent,
  resolveDocLocation,
  type CommentWriter,
  type CommentWriteResult,
  type DocComments,
  type DocLocation,
} from '../../../docs/comments/index.js';
import { jsonContent } from './types.js';

/** Who is calling, from the verified session. */
export interface DocCommentToolCaller {
  /** The calling agent's home. */
  agentPath: string;
  /** The calling chat, when the call came from one. */
  sessionId?: string;
  /** The calling chat's working directory, the default folder a path is read from. */
  cwd?: string;
}

/** Why a reply limit or the machine kept a mention from waking an agent. */
const UNREACHED_REASON: Record<DocCommentUnreached['reason'], string> = {
  depth: 'the chain of automatic replies reached its limit',
  repeat: 'it was already woken as often as one chain allows',
  budget: 'this hour’s automatic turns are used up',
  unprompted:
    'you wrote this outside a turn a doc comment woke, and only such a turn can wake ' +
    'another agent. Ask the person to mention it, or message it with chat_send',
  unavailable: 'it could not take a message just now',
};

/** The doc a tool call names. */
const DocArgs = {
  path: z
    .string()
    .min(1)
    .max(DOC_PATH_MAX)
    .describe('The markdown doc (.md), relative to the folder (e.g. "notes/plan.md").'),
  cwd: z
    .string()
    .optional()
    .describe(
      'The folder the doc is in (absolute). Defaults to your working directory. A comment that ' +
        'woke you says which folder to use.'
    ),
};

const Body = z
  .string()
  .trim()
  .min(1)
  .max(DOC_COMMENT_BODY_MAX)
  .describe('What the comment says (markdown). Mention someone with @handle.');

/** What every tool here answers with. */
type ToolResult = ReturnType<typeof jsonContent>;

/** A write's answer, in words an agent can act on. */
function writeAnswer(result: CommentWriteResult): ToolResult {
  return jsonContent({
    threadId: result.thread.id,
    commentId: result.thread.comments.at(-1)?.id,
    ...(result.unreached.length > 0
      ? {
          notWoken: result.unreached.map(
            ({ name, reason }) => `${name} was not woken: ${UNREACHED_REASON[reason]}.`
          ),
        }
      : {}),
  });
}

/**
 * Run one tool call: the experiment, the caller, the doc, and every refusal
 * as a plain sentence.
 */
async function runDocTool(
  resolveCaller: () => DocCommentToolCaller | undefined,
  args: { path: string; cwd?: string },
  handle: (ctx: {
    comments: DocComments;
    doc: DocLocation;
    writer: () => CommentWriter;
  }) => ToolResult | Promise<ToolResult>
): Promise<ToolResult> {
  const comments = getDocComments();
  if (!docsEnabled() || !comments) {
    return jsonContent({ error: 'Doc comments are off on this computer.' }, true);
  }
  const caller = resolveCaller();
  const cwd = args.cwd ?? caller?.cwd;
  if (!cwd) return jsonContent({ error: 'Say which folder the doc is in, in "cwd".' }, true);
  try {
    const doc = await resolveDocLocation(cwd, args.path);
    const writer = (): CommentWriter => {
      const author = caller ? comments.directory.agentAuthor(caller.agentPath) : null;
      if (!caller || !author) {
        throw new DocCommentError(
          'NO_AUTHOR',
          'Only a registered agent can comment on a doc. This session has no agent identity.'
        );
      }
      return { author, ...(caller.sessionId ? { sessionId: caller.sessionId } : {}) };
    };
    return await handle({ comments, doc, writer });
  } catch (err) {
    if (
      err instanceof DocCommentError ||
      err instanceof DocPathError ||
      err instanceof BoundaryError
    ) {
      return jsonContent({ error: err.message }, true);
    }
    throw err;
  }
}

/**
 * The doc comment tool definitions: name, description, input schema, and
 * handler.
 *
 * The single source for all of that on BOTH MCP servers. The comment service
 * is the one boot wired, so the tools take no other dependency.
 *
 * @param resolveCaller - Who is calling, read at call time.
 */
export function getDocCommentTools(resolveCaller: () => DocCommentToolCaller | undefined) {
  return [
    tool(
      'doc_comment_list',
      "List the comment threads on a markdown doc, placed in the doc's text as it is now. Each " +
        'thread says how it was found (exact, moved, ambiguous: check before acting, or ' +
        'orphaned: its words are gone), the words it was opened on, and its span in the raw ' +
        'markdown with that text. A found thread can have no exact span (an escape, an entity, ' +
        'a wrapped paragraph or code): it is still there, so quote its words instead.',
      DocArgs,
      (args) =>
        runDocTool(resolveCaller, args, async ({ comments, doc }) =>
          jsonContent({ path: doc.path, threads: await listThreadsForAgent(comments.service, doc) })
        )
    ),
    tool(
      'doc_comment_create',
      'Open a comment thread on part of a markdown doc, given as a range of the raw markdown ' +
        '(character offsets, start inclusive, end exclusive). Ends inside markup snap to the ' +
        'text. A range that starts or ends inside an escape, an entity, a wrapped paragraph, ' +
        'code or frontmatter is refused: widen it to whole units. Mentioning an agent with ' +
        '@handle wakes it within the reply limits, but only from a turn a doc comment woke.',
      {
        ...DocArgs,
        start: z.number().int().min(0).describe('Where the range starts in the raw markdown.'),
        end: z.number().int().min(1).describe('Where it ends, exclusive.'),
        body: Body,
      },
      (args) =>
        runDocTool(resolveCaller, args, async ({ comments, doc, writer }) =>
          writeAnswer(
            await createThreadOnRange(comments.service, doc, writer(), {
              start: args.start,
              end: args.end,
              body: args.body,
            })
          )
        )
    ),
    tool(
      'doc_comment_reply',
      'Reply in a comment thread on a markdown doc. This is how you answer a comment that ' +
        'mentioned you: what you write in your chat is not posted. Mentioning an agent with ' +
        '@handle wakes it within the reply limits, but only from a turn a doc comment woke.',
      { ...DocArgs, threadId: z.string().min(1).describe('The thread.'), body: Body },
      (args) =>
        runDocTool(resolveCaller, args, async ({ comments, doc, writer }) =>
          writeAnswer(await comments.service.reply(doc, writer(), args.threadId, args.body))
        )
    ),
    tool(
      'doc_comment_resolve',
      'Mark a comment thread on a markdown doc resolved, or reopen it with resolved: false.',
      {
        ...DocArgs,
        threadId: z.string().min(1).describe('The thread.'),
        resolved: z
          .boolean()
          .optional()
          .describe('true (the default) to resolve it, false to reopen it.'),
      },
      (args) =>
        runDocTool(resolveCaller, args, ({ comments, doc, writer }) => {
          const thread = comments.service.setResolved(
            doc,
            writer(),
            args.threadId,
            args.resolved ?? true
          );
          return jsonContent({ threadId: thread.id, resolved: thread.resolved });
        })
    ),
  ];
}
