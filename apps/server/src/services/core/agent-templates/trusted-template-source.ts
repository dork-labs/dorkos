/**
 * Whether an agent may create another agent from a template without a card
 * (spec `trusted-by-default-flip` §5.10, "Agents create agents like people do").
 *
 * A person and an agent create agents the same way under Trusted. The one
 * remaining question is the template's source: an address an agent typed could
 * be anybody's code, so only a template DorkOS itself ships (the built-in
 * catalog, `DEFAULT_TEMPLATES`) counts. The user catalog
 * (`agent-templates.json`) does not: it is written through `POST
 * /api/templates`, which any caller can reach, so an agent could add a source
 * and then use it. What the template brings that runs on its own still asks:
 * {@link cardTemplateGate} shows the card for any template that brings it.
 *
 * @module services/core/agent-templates/trusted-template-source
 */
import { DEFAULT_TEMPLATES } from '@dorkos/shared/template-catalog';
import { trustPosture } from '@dorkos/shared/permissions';
import type { AgentIdentity } from '../agent-identity/agent-identity-service.js';
import {
  permissionGateSources,
  resolveCallPermission,
  type PermissionGatedAction,
} from '../capabilities/permission-enforcement.js';
import { TEMPLATE_CREATION_CAPABILITY_ID } from '../../marketplace-mcp/confirmation-provider.js';

/** The addresses of the templates DorkOS ships. */
const BUILT_IN_SOURCES: ReadonlySet<string> = new Set(
  DEFAULT_TEMPLATES.map((t) => t.source).filter((source) => source !== '')
);

/**
 * Creating an agent from a template, as the permission gate weighs it: in
 * Other agents, where `create_agent` lives, so a person who set that area to
 * Ask or Blocked for an agent is asked here too.
 */
const TEMPLATE_CREATION_ACTION: PermissionGatedAction = {
  id: TEMPLATE_CREATION_CAPABILITY_ID,
  tier: 'destructive',
  area: 'agents',
};

/**
 * Whether a template creation may skip its card: the template is a built-in
 * one, the install is Trusted, and the calling agent's Other agents area
 * resolves Allowed. Anything that cannot be read answers `false`.
 *
 * @param template - The template address the request named.
 * @param identity - The calling agent, when one resolved.
 */
export async function templateFromTrustedSource(
  template: unknown,
  identity: AgentIdentity | undefined
): Promise<boolean> {
  if (typeof template !== 'string' || !BUILT_IN_SOURCES.has(template)) return false;
  let preset;
  try {
    preset = permissionGateSources().readConfig().preset;
  } catch {
    return false;
  }
  if (trustPosture(preset) !== 'trusted') return false;
  const permission = await resolveCallPermission({
    action: TEMPLATE_CREATION_ACTION,
    ...(identity ? { identity } : {}),
  });
  return permission?.state === 'allowed';
}
