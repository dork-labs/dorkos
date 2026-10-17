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
 * **The same reach as the agent's own file tools, never more.** A doc must be
 * inside the session's folder or one of the turn's folder grants; `doc_write`
 * is refused inside a read-only grant, exactly as `Edit` and `Write` are
 * (`messaging/directory-grants.ts`). A doc anywhere else is refused outright,
 * where a file tool would at least have asked.
 *
 * @module services/runtimes/claude-code/mcp-tools/doc-tools
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { DirectoryGrant } from '@dorkos/shared/agent-runtime';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';
import {
  DocBaseError,
  DocChangedError,
  DocNotReadError,
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
  /** The turn's folder grants beyond `cwd`; absent means none. */
  grants?: readonly DirectoryGrant[];
}

/** What this session may do to a file: as its own `Edit` and `Write` may. */
type DocAccess = 'write' | 'read' | 'none';

/**
 * This session's reach over `file` (canonical): its own folder and write
 * grants may be written, read grants only read, anything else neither.
 */
async function accessTo(file: string, session: DocToolSession): Promise<DocAccess> {
  const inside = (root: string) => file === root || file.startsWith(root + path.sep);
  const cwd = session.cwd ? await fs.realpath(session.cwd).catch(() => null) : null;
  if (cwd && inside(cwd)) return 'write';
  let access: DocAccess = 'none';
  for (const grant of session.grants ?? []) {
    if (!inside(grant.path)) continue;
    if (grant.access === 'write') return 'write';
    access = 'read';
  }
  return access;
}

const OUTSIDE =
  'This doc is outside your folder and the folders you were given. Ask for access first.';
const READ_ONLY = 'You can read this folder but not change it, so this doc can’t be written.';

const OFF = 'Docs are turned off on this computer, so the doc tools are unavailable.';

/** The refusal an agent reads for each way a doc call can fail, or `null` for a bug. */
function refusalOf(err: unknown): string | null {
  if (err instanceof DocRefusal) return err.message;
  if (
    err instanceof DocChangedError ||
    err instanceof DocBaseError ||
    err instanceof DocNotReadError
  ) {
    return err.message;
  }
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
  needs: 'read' | 'write',
  run: (doc: { cwd: string; path: string }, caller: DocAgentCaller) => Promise<object>
) {
  const service = getDocCollab();
  if (!docsEnabled() || !service) return jsonContent({ error: OFF }, true);
  try {
    const doc = { cwd: args.cwd ?? session.cwd ?? deps.defaultCwd, path: args.path };
    const access = await accessTo((await service.resolve(doc)).file, session);
    if (access === 'none') return jsonContent({ error: OUTSIDE }, true);
    if (needs === 'write' && access === 'read') return jsonContent({ error: READ_ONLY }, true);
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
    withDoc(session(), deps, args, 'read', async (doc, caller) => {
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
    withDoc(session(), deps, args, 'write', async (doc, caller) => {
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
        'Read the doc first: your change is merged with their edits since that read. With ' +
        'nobody editing, the file is written. The previous version is kept, so a person can ' +
        'restore it. Use ' +
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
