/**
 * The `create_extension` tool's handler (DOR-3068): where an agent's new mini
 * app is created, whether its approval records the agent as its author, and
 * the Activity entry a Trusted approval leaves. Split from `extension-tools.ts`,
 * which defines the tool and re-exports these names.
 *
 * @module services/runtimes/claude-code/mcp-tools/extension-create-tool
 */
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';
import { resolveProposerName } from '../../../tasks/task-provenance.js';

/**
 * Which session is creating an extension, read at CALL time (the SDK rekeys a
 * session mid-first-turn, as `TaskProvenanceResolver` explains).
 *
 * Present only on the in-session server, where the caller is one of our
 * agents. Absent on the external `/mcp` server, whose caller cannot be told
 * from an outsider, so nothing it creates is approved without a person.
 */
export type ExtensionCreatorResolver = () => {
  /** The calling agent's own folder, the key its agent's name resolves from. */
  agentPath?: string;
  /** The calling session, read for the turn's marks (DOR-3036). */
  sessionId?: string;
  /** Whether the calling turn, or background work it carries, runs under a ceiling. */
  ceilinged?: boolean;
  /** Whether the calling chat is set to Full autonomy. */
  chosenFull?: boolean;
};

/**
 * Handler factory for `create_extension` — scaffolds a new extension with
 * manifest, starter code, compiles, and enables it in one step.
 *
 * On the in-session server the caller is one of our agents, so a Trusted
 * install approves the new copy as it is created (ADR 261006-225605) and the
 * approval is recorded in Activity as `extension.auto_approved`, naming the
 * agent, the copy and the permissions it covers.
 *
 * An agent's extension is created in its own folder, at
 * `.dork/extensions/<name>` (DOR-3068), and the approval records that folder
 * as its author, so edits to its server half keep running without a click.
 * Not for a turn that read a stranger's words or runs under a ceiling: that
 * create keeps today's approval rules and records no author, so every edit
 * waits for a person.
 *
 * @param deps - Shared MCP tool dependencies
 * @param resolveCreator - Who is creating it; absent on the external `/mcp` server.
 */
export function createCreateExtensionHandler(
  deps: McpToolDeps,
  resolveCreator?: ExtensionCreatorResolver
) {
  return async (args: {
    name: string;
    description?: string;
    template?: string;
    scope?: string;
  }) => {
    const manager = deps.extensionManager;
    if (!manager) {
      return jsonContent({ error: 'Extension system is not available' }, true);
    }

    const template = (args.template ?? 'dashboard-card') as
      'dashboard-card' | 'right-panel-tab' | 'command' | 'settings-panel' | 'data-provider';
    const scope = (args.scope ?? 'global') as 'global' | 'local';

    try {
      // The creating agent's folder: its extension is created there, and keeps
      // path trust only while it runs separately inside it (DOR-3068).
      const creator = resolveCreator?.();
      const agentPath = creator?.agentPath;
      // New code follows the agent's level (DOR-3440): at Full it approves itself with one
      // Activity line. Below Full or under a ceiling, it waits for a person and is pinned to its
      // files, so an edit waits again.
      const approves = creator?.chosenFull === true && creator.ceilinged !== true;
      const result = await manager.createExtension({
        name: args.name,
        description: args.description,
        template,
        scope,
        approveIfTrusted: resolveCreator !== undefined && approves,
        ...(agentPath ? { agentHome: agentPath, recordAuthor: approves } : {}),
      });
      if (result.autoApproved) {
        const name = (await resolveProposerName(agentPath)) ?? 'An agent';
        await deps.activityService?.emit({
          actorType: 'agent',
          actorLabel: name,
          ...(agentPath ? { actorId: agentPath } : {}),
          category: 'config',
          eventType: 'extension.auto_approved',
          resourceType: 'extension',
          resourceId: result.id,
          resourceLabel: result.id,
          summary: `${name} created extension ${result.id}, approved to run because agents are trusted`,
          metadata: { path: result.path, permissions: result.autoApproved },
        });
      }
      return jsonContent(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Extension creation failed';
      return jsonContent({ error: message }, true);
    }
  };
}
