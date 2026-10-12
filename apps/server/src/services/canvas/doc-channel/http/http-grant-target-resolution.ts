import { agents, authors, sessionMetadata, and, eq, isNull } from '@dorkos/db';
import { parseScope } from '../../scopes.js';
import { queueKeyOf } from '../../../session/resolution/session-key-registry.js';
import { DocRouteGrantError, type DocGrantAuthority } from '../grant-policy.js';
import type { ServerPrincipalClaims } from '../../../connectors/principal/server-principal.js';
import type { docInstallationOwner } from '../current/doc-source-policy.js';
import type { readOriginalHttpMembership } from './http-principal-membership.js';
import type { OriginalDocHttpCompositionDependencies } from './http-composition-contracts.js';

/**
 * Resolve a grant's native agent/session target through the constructing composition.
 *
 * The composition supplies its original membership reader and current installation
 * owner. This helper keeps no authority registry: each resolution rechecks active
 * agent identity, canonical session scope and the same captured room membership.
 */
export function createOriginalHttpGrantTargetResolver(
  deps: OriginalDocHttpCompositionDependencies,
  membership: (
    roomId: string,
    claims: ServerPrincipalClaims
  ) => ReturnType<typeof readOriginalHttpMembership>,
  currentOwner: () => ReturnType<typeof docInstallationOwner>
): DocGrantAuthority['resolveTarget'] {
  return (input, tx) => {
    const scope = deps.documents.lifecycle.resolveScope(input.scope);
    const parsed = parseScope(scope);
    if (input.route.to === 'log')
      return { agentId: null, agentPath: null, sessionId: null, runtime: null, scope };
    const agentId =
      input.route.to === 'agent:owner' || input.route.to === 'room:self'
        ? input.openerAgentId
        : input.route.to.slice(6);
    const executor = tx ?? deps.db;
    const agent = agentId
      ? executor.select().from(agents).where(eq(agents.id, agentId)).get()
      : undefined;
    if (!agent || agent.status !== 'active') throw new DocRouteGrantError('TARGET_UNAVAILABLE');
    let sessionId: string | null = parsed.kind === 'session' ? parsed.id : null;
    if (parsed.kind === 'session' && input.route.to !== 'agent:owner') {
      const candidates = executor
        .select()
        .from(sessionMetadata)
        .where(
          and(
            eq(sessionMetadata.agentPath, agent.projectPath),
            eq(sessionMetadata.runtime, agent.runtime)
          )
        )
        .all();
      const canonical = new Set(
        candidates.map((candidate) =>
          deps.documents.lifecycle
            .resolveScope(`session:${queueKeyOf(candidate.sessionId)}`)
            .slice(8)
        )
      );
      if (canonical.size !== 1) throw new DocRouteGrantError('TARGET_UNAVAILABLE');
      sessionId = [...canonical][0]!;
    }
    if (parsed.kind === 'room') {
      const author = executor
        .select()
        .from(authors)
        .where(
          and(
            eq(authors.kind, 'agent'),
            eq(authors.naturalKey, agent.projectPath),
            isNull(authors.retiredAt)
          )
        )
        .get();
      if (
        !author ||
        !membership(parsed.id, {
          kind: 'agent',
          owner: currentOwner(),
          agentId: agent.id,
          agentPath: agent.projectPath,
        })
      )
        throw new DocRouteGrantError('TARGET_UNAVAILABLE');
      sessionId = deps.roomStore.getRoomSession(parsed.id, author.id);
    }
    if (!sessionId) throw new DocRouteGrantError('TARGET_UNAVAILABLE');
    sessionId = deps.documents.lifecycle.resolveScope(`session:${queueKeyOf(sessionId)}`).slice(8);
    const session = executor
      .select()
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, sessionId))
      .get();
    if (
      !session?.runtime ||
      session.agentPath !== agent.projectPath ||
      session.runtime !== agent.runtime
    )
      throw new DocRouteGrantError('TARGET_UNAVAILABLE');
    return {
      agentId: agent.id,
      agentPath: agent.projectPath,
      sessionId,
      runtime: session.runtime,
      scope,
    };
  };
}
