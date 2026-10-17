/**
 * Puts the doc comment tools on the external `/mcp` server (DOR-2983), so an
 * agent on any runtime can answer a comment that mentioned it.
 *
 * The names, descriptions, and input schemas come from `getDocCommentTools`,
 * the same definitions the in-session server uses, via
 * {@link registerFromDefinitions}. The external server carries no session, so
 * the caller is the agent the request's `X-DorkOS-Agent` token names, with no
 * calling chat: a comment it writes continues no reply chain, so it wakes
 * nobody it mentions. With no such agent, every write is refused.
 *
 * @module services/core/external-mcp/doc-comment-tools
 */
import type { ToolRegistrar } from '../mcp-tool-gate.js';
import type { AgentIdentity } from '../agent-identity/index.js';
import { getDocCommentTools } from '../../runtimes/claude-code/mcp-tools/doc-comment-tools.js';
import { ToolAnnotationPresets } from '../mcp-tool-metadata.js';
import { registerFromDefinitions, type ExternalToolConfigs } from './register-from-definitions.js';

const A = ToolAnnotationPresets;

/** The external-only additions for each doc comment tool. */
const DOC_COMMENT_EXTERNAL_CONFIGS: ExternalToolConfigs = {
  doc_comment_list: { annotations: A.readOnlyLocal },
  doc_comment_create: { annotations: A.mutateCreateLocal },
  doc_comment_reply: { annotations: A.mutateCreateLocal },
  doc_comment_resolve: { annotations: A.mutateUpdateLocal },
};

/**
 * Register the doc comment tools against `registrar`.
 *
 * @param registrar - The gated tool registrar from `mcp-server.ts`.
 * @param identity - The calling agent the request's token resolved to, if any.
 */
export function registerDocCommentTools(registrar: ToolRegistrar, identity?: AgentIdentity): void {
  // An inactive identity names who tried, never who may act.
  const caller = identity && !identity.inactive ? { agentPath: identity.agentPath } : undefined;
  registerFromDefinitions(
    registrar,
    getDocCommentTools(() => caller),
    DOC_COMMENT_EXTERNAL_CONFIGS
  );
}
