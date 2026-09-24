/**
 * Resolve the permission that applies to one gated call (spec
 * `agent-permissions` D6): the action's declared area, the install's
 * `permissions` config, and the calling agent's own overrides, read FRESH on
 * every call.
 *
 * Each of the tier gate's three callers (`registry.invoke`,
 * `authorizeCapability`, `mcp-tool-gate.ts`) calls {@link resolveCallPermission}
 * and hands the answer to `enforceCapabilityTier`, whose request type makes the
 * field required. That is what makes every surface gated by construction: a
 * caller that forgets does not compile.
 *
 * ## The manifest file, never the SQLite cache
 *
 * `.dork/agent.json` is the source of truth for an agent's `permissions` and the
 * `agents` table is not: `packages/mesh/src/agent-registry.ts` has no column for
 * the field and its row reader hands back nothing for every agent. Asking the
 * cache would therefore report every agent as inheriting the defaults, and would
 * keep doing so after a person set it differently, which is a switch that
 * appears to work and does not. Reading the file is not an optimization to
 * revisit; it is the only place the answer exists.
 *
 * ## Deliberately not cached
 *
 * One warm `readFile` plus a Zod parse per call, on actions that are occasional
 * by construction: nothing on the room-turn hot path declares an area. A stale
 * permission is a correctness failure and this read is cheap, so the trade is
 * not close. It also means a change takes effect on the very next call, with no
 * restart and no cache to invalidate.
 *
 * ## Failing closed
 *
 * A manifest that is present but cannot be read or parsed resolves to Blocked
 * and is marked `unreadable`, so the gate refuses without offering an approval:
 * a permission nobody can read is a permission that is not held. A missing
 * manifest is not a failure: the caller inherits the defaults.
 *
 * @module services/core/capabilities/permission-enforcement
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { MANIFEST_DIR, MANIFEST_FILE } from '@dorkos/shared/manifest';
import { AgentManifestFileSchema } from '@dorkos/shared/mesh-schemas';
import {
  getPermissionArea,
  resolvePermission,
  type AgentPermissions,
  type PermissionAreaId,
  type PermissionConfigInput,
  type ResolvedPermission,
} from '@dorkos/shared/permissions';

import type { AgentIdentity } from '../agent-identity/agent-identity-service.js';
import type { GatedAction } from './tier-enforcement.js';
import { logger } from '../../../lib/logger.js';

/** A resolved permission, as the gate receives it. */
export interface CallPermission extends ResolvedPermission {
  /** Set when the agent's manifest could not be read: Blocked, and not approvable. */
  unreadable?: true;
}

/** Where the gate reads the two halves of a permission from. */
export interface PermissionGateSources {
  /** The install's live `permissions` config section. */
  readConfig: () => PermissionConfigInput;
  /**
   * One agent's stored overrides, read fresh. Resolves `undefined` when the agent
   * has no manifest or no `permissions`; THROWS when a manifest is present and
   * cannot be read, which the gate turns into a Blocked refusal.
   */
  readAgentPermissions: (agentPath: string) => Promise<AgentPermissions | undefined>;
  /**
   * Every action an agent can reach, with its area and the MCP tool name it is
   * listed under, so the tool-list builders can hide a Blocked one. Read per
   * build; empty until boot wires the registry.
   */
  listActions: () => readonly PermissionListedAction[];
}

/** One agent-reachable action, as the tool-list builders read it. */
export interface PermissionListedAction {
  /** Capability id or hand-registered tool name. */
  id: string;
  /** The action's tier. */
  tier: GatedAction['tier'];
  /** Its area, or `null` for an action with no switch. */
  area: PermissionAreaId | null;
  /** The MCP tool name the action is listed under, when it has one. */
  toolName?: string;
}

/** What an install is before anybody chose a preset: today's behaviour. */
const UNCHOSEN: PermissionConfigInput = { preset: null, defaults: { areas: {}, actions: {} } };

/**
 * Read an agent's `permissions` straight off its manifest file.
 *
 * `ENOENT`/`ENOTDIR` is "no manifest", which inherits. Everything else that is
 * not a clean parse throws, so the caller can fail closed: an unreadable file,
 * invalid JSON, or a manifest the schema refuses (an invalid state value
 * included, on purpose: a security control nobody can parse must be loud).
 *
 * @param agentPath - The agent's project directory.
 */
export async function readAgentPermissionsFromManifest(
  agentPath: string
): Promise<AgentPermissions | undefined> {
  const manifestPath = path.join(agentPath, MANIFEST_DIR, MANIFEST_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw err;
  }
  const parsed = AgentManifestFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`manifest failed validation: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data.permissions;
}

/** The sources used until boot wires the live config. */
const DEFAULT_SOURCES: PermissionGateSources = {
  readConfig: () => UNCHOSEN,
  readAgentPermissions: readAgentPermissionsFromManifest,
  listActions: () => [],
};

let sources: PermissionGateSources = DEFAULT_SOURCES;

/**
 * Wire the gate to the live config (and, in tests, a manifest reader). Called
 * once at boot beside `initCapabilityTierGate`.
 *
 * Until it runs, the config reads as "no preset chosen" (Unchanged), which is
 * exactly the behaviour before permissions existed, so nothing opens up.
 *
 * @param next - The sources to use; either half may be omitted to keep the default.
 */
export function initPermissionGate(next: Partial<PermissionGateSources>): void {
  sources = { ...DEFAULT_SOURCES, ...next };
}

/** Drop the wired sources. Test-only seam, mirroring `resetCapabilityTierGate`. */
export function resetPermissionGate(): void {
  sources = DEFAULT_SOURCES;
}

/**
 * The wired sources, for the tool-list builders that hide a Blocked action
 * (`runtimes/shared/permission-tool-filter.ts`). The gate itself never reads
 * through this: it resolves each call in {@link resolveCallPermission}.
 *
 * @returns The live sources.
 */
export function permissionGateSources(): PermissionGateSources {
  return sources;
}

/** A gated action, with the area it declares. */
export type PermissionGatedAction = Pick<GatedAction, 'id' | 'tier'> & {
  /** The permission area, or `null` for an action that is always allowed on its tier. */
  area: PermissionAreaId | null;
};

/**
 * Resolve the permission for one call, reading the config and the calling
 * agent's manifest fresh.
 *
 * Returns `null` for an action with no area (the tier alone decides). With no
 * identity (an unidentified caller that is not a trusted one) the agent layers
 * are skipped and the defaults decide (spec D11). A revoked or expired identity
 * resolves Blocked. A manifest read that fails resolves Blocked and
 * `unreadable`, which the gate refuses without an approval.
 *
 * @param request - The action and the calling identity.
 * @returns The permission to hand the gate, or `null` when the action has no area.
 */
export async function resolveCallPermission(request: {
  action: PermissionGatedAction;
  identity?: AgentIdentity;
}): Promise<CallPermission | null> {
  const { action, identity } = request;
  const area = action.area;
  // `undefined` too: a hand-built action from plain JS must not resolve an area it never named.
  if (area === null || area === undefined) return null;

  let config: PermissionConfigInput;
  try {
    config = sources.readConfig();
  } catch (err) {
    logger.error('[capabilities] permission config could not be read; refusing the call', {
      capabilityId: action.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return { area, state: 'blocked', source: 'default-area', layer: 'default', unreadable: true };
  }

  if (identity?.inactive) {
    return resolvePermission({
      area,
      actionId: action.id,
      tier: action.tier,
      config,
      inactive: true,
    });
  }

  let agent: AgentPermissions | undefined;
  if (identity) {
    try {
      agent = await sources.readAgentPermissions(identity.agentPath);
    } catch (err) {
      logger.error('[capabilities] agent permissions could not be read; refusing the call', {
        capabilityId: action.id,
        agentPath: identity.agentPath,
        err: err instanceof Error ? err.message : String(err),
      });
      return { area, state: 'blocked', source: 'agent-area', layer: 'agent', unreadable: true };
    }
  }

  return resolvePermission({
    area,
    actionId: action.id,
    tier: action.tier,
    config,
    ...(agent ? { agent } : {}),
  });
}

/**
 * The name of the tool an agent asks past Blocked with, as the model is told to
 * look for it: "the tool ending in `request_permission`". Every runtime prefixes
 * its MCP tools differently, so the sentence names the suffix, which is the one
 * part every surface shares.
 */
export const REQUEST_PERMISSION_TOOL = 'request_permission';

/**
 * The name an area goes by in a sentence an agent reads, e.g. "Rooms".
 *
 * @param area - The area.
 */
export function permissionAreaLabel(area: PermissionAreaId): string {
  return getPermissionArea(area)?.label ?? area;
}

/**
 * The sentence a refused agent reads for a Blocked permission (spec
 * `agent-permissions` D8). A direct call never raises a card; the sentence says
 * how to ask on purpose instead. The two endings nobody can ask past (settings
 * nobody could read, an identity that was turned off) say so and name no tool,
 * and travel with `approvable: false`.
 *
 * @param permission - The resolved Blocked permission.
 */
export function blockedPermissionMessage(permission: CallPermission): string {
  if (permission.unreadable) {
    return (
      "DorkOS could not read this agent's permissions, so it refused the call. " +
      "Ask the person to check this agent's settings."
    );
  }
  if (permission.source === 'inactive') {
    return "This agent's access was turned off or ran out, so it cannot do this. Ask the person.";
  }
  return (
    `${permissionAreaLabel(permission.area)} is blocked for this agent. You can ask the person ` +
    `with the tool ending in \`${REQUEST_PERMISSION_TOOL}\`: name the action, pass the exact ` +
    'arguments, and say why.'
  );
}

/**
 * Whether a call to this action can be held behind an approval card, which is
 * what decides whether its tool advertises the `approvalToken` retry argument.
 *
 * A destructive action always can. An `act` action can when it has an area,
 * because the person may set that area to Ask. An `observe` action never asks
 * on its own. The request tool (`forwardsApproval`) always can: it raises the
 * card of whatever action it asks for, and a retry presents that card's token.
 *
 * @param action - The action's tier and area.
 */
export function canRaiseApproval(action: {
  tier: GatedAction['tier'];
  area?: PermissionAreaId | null;
  forwardsApproval?: boolean;
}): boolean {
  // The request tool raises the card of the action it asks for, so it carries
  // the token that answers it.
  if (action.forwardsApproval === true) return true;
  if (action.tier === 'destructive') return true;
  return action.tier === 'act' && action.area !== undefined && action.area !== null;
}
