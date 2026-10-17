/**
 * The agent's doc tools (DOR-2984): read a markdown doc and write it back
 * without overwriting what people are typing in it.
 *
 * `doc_write` is the safe way for an agent to change a doc a person may have
 * open: the write is merged into the live doc against what this session last
 * read, so cursors and unsaved typing survive. With nobody editing, it is a
 * plain file write. Either way the doc's previous bytes are kept, so a person
 * can restore them. Refused while the `docs.enabled` experiment is off.
 *
 * @module services/runtimes/claude-code/mcp-tools/doc-tools
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';
import {
  DocBaseError,
  DocChangedError,
  DocRefusal,
  docsEnabled,
  getDocCollab,
  type DocAgentCaller,
} from '../../../docs/collab/index.js';

/** What the doc tools read about the calling session, at call time. */
export interface DocToolSession {
  /** The session's working directory: where a relative doc path starts. */
  cwd?: string;
  /** The session id, so this session's reads are its own bases. */
  sessionKey?: string;
  /** The calling agent's name, as people editing the doc see it. */
  agentName?: () => Promise<string | undefined>;
}

const OFF = 'Docs are turned off on this computer, so the doc tools are unavailable.';

/** The refusal an agent reads for each way a doc call can fail, or `null` for a bug. */
function refusalOf(err: unknown): string | null {
  if (err instanceof DocRefusal) return err.message;
  if (err instanceof DocChangedError || err instanceof DocBaseError) return err.message;
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'This doc doesn’t exist.';
  return null;
}

/** The caller, as the doc service names it. */
async function callerOf(session: DocToolSession): Promise<DocAgentCaller> {
  const name = await session.agentName?.().catch(() => undefined);
  return {
    writer: { kind: 'agent', ...(name ? { name } : {}) },
    ...(session.sessionKey ? { sessionKey: session.sessionKey } : {}),
  };
}

/**
 * Run one doc call with the shared refusals.
 *
 * @param session - The calling session.
 * @param deps - For the default working directory.
 * @param args - The doc the call names.
 * @param run - The call.
 */
async function withDoc(
  session: DocToolSession,
  deps: McpToolDeps,
  args: { path: string; cwd?: string },
  run: (doc: { cwd: string; path: string }, caller: DocAgentCaller) => Promise<object>
) {
  const service = getDocCollab();
  if (!docsEnabled() || !service) return jsonContent({ error: OFF }, true);
  try {
    const doc = { cwd: args.cwd ?? session.cwd ?? deps.defaultCwd, path: args.path };
    return jsonContent(await run(doc, await callerOf(session)));
  } catch (err) {
    const refusal = refusalOf(err);
    if (refusal) return jsonContent({ error: refusal }, true);
    const message = err instanceof Error ? err.message : 'The doc call failed';
    return jsonContent({ error: message }, true);
  }
}

/**
 * Factory for the `doc_read` handler.
 *
 * @param deps - Shared MCP tool dependencies.
 * @param session - Reads the calling session at call time.
 */
export function createDocReadHandler(deps: McpToolDeps, session: () => DocToolSession) {
  return (args: { path: string; cwd?: string }) =>
    withDoc(session(), deps, args, async (doc, caller) => {
      const { markdown, live } = await getDocCollab()!.read(doc, caller);
      return { path: args.path, live, markdown };
    });
}

/**
 * Factory for the `doc_write` handler.
 *
 * @param deps - Shared MCP tool dependencies.
 * @param session - Reads the calling session at call time.
 */
export function createDocWriteHandler(deps: McpToolDeps, session: () => DocToolSession) {
  return (args: { path: string; markdown: string; cwd?: string }) =>
    withDoc(session(), deps, args, async (doc, caller) => {
      const { live, changed } = await getDocCollab()!.write(doc, args.markdown, caller);
      return { path: args.path, live, changed };
    });
}

const PATH = z
  .string()
  .min(1)
  .describe('The markdown file (.md), relative to your working directory');
const CWD = z
  .string()
  .optional()
  .describe('The folder the path is relative to. Defaults to your working directory.');

/**
 * The doc tool definitions: name, description, input schema, and handler.
 *
 * @param deps - Shared MCP tool dependencies.
 * @param session - Reads the calling session at call time.
 */
export function getDocTools(deps: McpToolDeps, session: () => DocToolSession) {
  return [
    tool(
      'doc_read',
      'Read a markdown doc as it is now, including what people editing it have typed but not ' +
        'yet saved. Read a doc this way before changing it: your next change to it is merged ' +
        'against this read.',
      { path: PATH, cwd: CWD },
      createDocReadHandler(deps, session)
    ),
    tool(
      'doc_write',
      'Replace a markdown doc’s content without overwriting what people are typing in it. ' +
        'Your change is merged with their edits since you last read the doc; with nobody editing, ' +
        'the file is written. The previous version is kept, so a person can restore it. Use ' +
        'this rather than your file tools for any doc a person may have open. A line that is ' +
        'exactly a directive (`::note`) is an embed; to mean the text itself, write `\\::note`.',
      {
        path: PATH,
        markdown: z.string().describe('The whole doc, as markdown'),
        cwd: CWD,
      },
      createDocWriteHandler(deps, session)
    ),
  ];
}
