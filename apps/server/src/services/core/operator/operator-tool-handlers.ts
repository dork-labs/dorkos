/**
 * Transport-neutral handlers for the self-service & observability MCP tools
 * (`update_agent`, `update_agent_boundaries`, `activity_list`, `config_get`,
 * `config_patch`, `sidebar_add_to_group`, `sidebar_remove_from_group`,
 * `check_update`, `agents_recent_activity`).
 *
 * Each handler is a thin wrapper over existing service logic — the agent-update
 * service, `ActivityService`, `ConfigManager` (via the shared config-patch
 * service), `update-checker`, and the recent-sessions fan-out — so no route
 * validation is duplicated. Handlers take plain args and return an MCP
 * text-content result, importing neither MCP SDK. Each is wrapped by a
 * {@link CapabilityDefinition} in
 * {@link module:services/core/operator/operator-capabilities}, whose `invoke`
 * unwraps this envelope to the plain payload the registry contract requires.
 *
 * @module services/core/operator/operator-tool-handlers
 */
import path from 'node:path';
import { z } from 'zod';
import { ListActivityQuerySchema } from '@dorkos/shared/activity-schemas';
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import type { SidebarItemRef, SidebarPrefs } from '@dorkos/shared/config-schema';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import type { AgentIdentity } from '../agent-identity/agent-identity-service.js';
import type { DisplayNameWriter } from '../../identity/display-name-provenance.js';
import { validateBoundaryOrDorkHome, BoundaryError } from '../../../lib/boundary.js';
import { SERVER_VERSION } from '../../../lib/version.js';
import { configManager } from '../config-manager.js';
import { updateAgentManifest, AgentUpdateError } from './agent-updater.js';
import { sanitizedConfigSnapshot } from './config-patch.js';
import {
  applyGuardedConfigWrite,
  OPERATOR_TOOL_AUTHORITY,
  type GuardedConfigWriteResult,
} from './config-write.js';
import {
  addSidebarItems,
  appendSidebarGroup,
  liftFromOtherGroups,
  newSidebarGroup,
  removeSidebarItems,
  replaceSidebarGroup,
  resolveSidebarGroup,
  storedSidebarPrefs,
} from './sidebar-groups.js';
import { getLatestVersion } from '../update-checker.js';
import { listRecentSessions } from '../../session/index.js';

/**
 * The MCP text-content result shape every operator handler returns. A
 * locally-defined structural type (not the MCP SDK's `CallToolResult`) so this
 * shared layer stays SDK-free; both servers' handler slots accept it because
 * their `CallToolResult` is a strict superset of this shape.
 */
export type OperatorToolResult = {
  /** One or more text blocks carrying the JSON-encoded tool payload. */
  content: { type: 'text'; text: string }[];
  /** Set on failure paths so MCP clients can distinguish errors from payloads. */
  isError?: boolean;
};

/** Build a single-block JSON tool result, flagging `isError` on failure paths. */
function jsonResult(data: unknown, isError = false): OperatorToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    ...(isError && { isError: true }),
  };
}

/**
 * Resolve an agent's project directory from either `agent_id` or `cwd` (exactly
 * one, mutually exclusive). Inlined here — rather than importing the runtime's
 * `resolveAgentCwd` — so this shared module never pulls the Claude Agent SDK
 * into the external MCP server's import graph.
 *
 * @param deps - Tool deps; `meshCore` is required to resolve an `agent_id`.
 * @param args - The `agent_id` or `cwd` selector.
 * @returns The resolved agent project directory (not yet boundary-validated).
 */
function resolveAgentPath(deps: McpToolDeps, args: { agent_id?: string; cwd?: string }): string {
  if (!args.agent_id && !args.cwd) {
    throw new Error('Either agent_id or cwd must be provided to identify the agent.');
  }
  if (args.agent_id && args.cwd) {
    throw new Error('Provide either agent_id or cwd, not both.');
  }
  if (args.cwd) return args.cwd;
  if (!deps.meshCore) {
    throw new Error('Mesh is not enabled. Cannot resolve agent_id without Mesh.');
  }
  const projectPath = deps.meshCore.getProjectPath(args.agent_id!);
  if (!projectPath) {
    throw new Error(`Agent not found: ${args.agent_id}`);
  }
  return projectPath;
}

/**
 * Turn a failed manifest write into the structured `isError` payload both
 * agent-editing handlers return, so the two never drift on how a boundary
 * violation or a blocked field reads to a model.
 *
 * @param err - Whatever the update path threw.
 * @param fallback - The message for an error neither typed class covers.
 * @returns The `isError` tool result.
 */
function agentUpdateFailure(err: unknown, fallback: string): OperatorToolResult {
  if (err instanceof BoundaryError) {
    return jsonResult({ error: err.message, code: err.code }, true);
  }
  if (err instanceof AgentUpdateError) {
    return jsonResult(
      { error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) },
      true
    );
  }
  return jsonResult({ error: err instanceof Error ? err.message : fallback }, true);
}

/** Editable self-edit fields accepted by `update_agent`, beyond the agent selector. */
export interface UpdateAgentArgs {
  agent_id?: string;
  cwd?: string;
  displayName?: string;
  description?: string;
  persona?: string;
  personaEnabled?: boolean;
  traits?: Record<string, number>;
  conventions?: Record<string, unknown>;
  color?: string | null;
  icon?: string | null;
  soulContent?: string;
  /**
   * The most this agent may ever do. Lowering it is the agent's own call;
   * raising or clearing it is refused by `agent-updater.ts` (DOR-486).
   */
  tierCeiling?: CapabilityTier | null;
  /** Present only so the handler can refuse it — see the guard in the handler. */
  nopeContent?: unknown;
}

/**
 * The code `update_agent` returns for a patch that reaches for NOPE.md, on
 * either of the two fields that change it.
 *
 * All-or-nothing, like the manifest's other blocked-field guards: a patch that
 * names one of them applies none of itself, so an agent cannot be told half a
 * change landed.
 */
const NOPE_NEEDS_APPROVAL_CODE = 'NEEDS_APPROVAL';

/**
 * The one sentence both NOPE.md guards answer with.
 *
 * @param what - What the caller tried to change, in the words of the patch.
 * @returns The refusal message, naming the gated tool as a searchable ending.
 */
function nopeRefusal(what: string): string {
  return (
    `${what} is changed with the boundaries tool, whose name ends in ` +
    '`update_agent_boundaries`; it asks a person to approve the change first. Nothing here was ' +
    'changed. Send the rest of this patch again without it.'
  );
}

/**
 * `update_agent` — apply a self-edit patch to an agent manifest, enforcing the
 * exact PATCH `/api/agents/current` guards (immutable slug, system-agent
 * identity protection) via the shared {@link updateAgentManifest} service.
 *
 * `nopeContent` is refused here (DOR-1698): see the guard below.
 *
 * @param deps - Tool deps (`meshCore` for `agent_id` resolution + DB sync).
 * @returns The bound handler.
 */
export function createUpdateAgentHandler(deps: McpToolDeps) {
  return async (args: UpdateAgentArgs): Promise<OperatorToolResult> => {
    try {
      const { agent_id, cwd, ...patch } = args;
      // Guard: an agent may ask to rewrite its own boundaries, but not without
      // a person seeing it (DOR-1698).
      //
      // NOPE.md is handed to the runtime as `safetyBoundaries` on every turn, and
      // this capability is tier `act` — the gate lets it through without asking
      // anybody. A tier is per-capability, not per-field, so the write moved to
      // `operator.update_agent_boundaries` at tier `destructive` rather than
      // becoming a second, quieter door to the same file.
      //
      // Refused rather than ignored, for the reason the `account` guard in
      // `agent-updater.ts` gives: an agent told nothing would report the change
      // as done. The field stays on this capability's INPUT SCHEMA so this guard
      // can see it at all — `registry.invoke` parses before invoking and
      // `z.object` strips undeclared keys.
      //
      // Not in `agent-updater.ts`, unlike the operator-only guards there: this is
      // about the approval a surface asks for, and `PATCH /api/agents/current`
      // (the cockpit's own boundaries editor) is a person doing the editing.
      //
      // Both fields are `z.unknown()` on the input schema, so `in` is the whole
      // test: naming either at all — a string, `null`, a number — is a patch
      // about NOPE.md and gets the pointer, never a type error that would send a
      // model off to fix its JSON and try the same door again.
      if ('nopeContent' in patch) {
        return jsonResult(
          {
            error: nopeRefusal("An agent's safety boundaries (NOPE.md)"),
            code: NOPE_NEEDS_APPROVAL_CODE,
          },
          true
        );
      }
      // The MUTE is the stronger of the two and used to be free: `conventions.nope`
      // decides whether the runtime is given the file at all
      // (`runtimes/shared/agent-context.ts`), so an agent that could set it could
      // switch its own boundaries off without deleting a byte and without a card.
      // The other three convention toggles stay writable here.
      if (
        patch.conventions &&
        typeof patch.conventions === 'object' &&
        'nope' in patch.conventions
      ) {
        return jsonResult(
          {
            error: nopeRefusal(
              'Whether an agent is given its safety boundaries (conventions.nope)'
            ),
            code: NOPE_NEEDS_APPROVAL_CODE,
          },
          true
        );
      }
      const resolved = resolveAgentPath(deps, { agent_id, cwd });
      const agentPath = await validateBoundaryOrDorkHome(resolved);
      const updated = await updateAgentManifest({
        agentPath,
        body: patch,
        meshCore: deps.meshCore,
      });
      return jsonResult(updated);
    } catch (err) {
      return agentUpdateFailure(err, 'Failed to update agent');
    }
  };
}

/** The agent selector plus the two ways `update_agent_boundaries` changes NOPE.md. */
export interface UpdateAgentBoundariesArgs {
  agent_id?: string;
  cwd?: string;
  /** Replacement NOPE.md body. */
  nopeContent?: string;
  /** Whether the runtime is given NOPE.md at all (`conventions.nope`). */
  enabled?: boolean;
}

/**
 * `update_agent_boundaries` — change an agent's NOPE.md through the same
 * {@link updateAgentManifest} service `update_agent` uses, as its own
 * `destructive` capability so a person approves the change first (DOR-1698).
 *
 * Covers both ways the boundaries can stop saying what they said: replacing the
 * text, and muting the injection. They ride one capability because they have the
 * same effect on the agent, so gating one and not the other would gate nothing.
 *
 * @param deps - Tool deps (`meshCore` for `agent_id` resolution + DB sync).
 * @returns The bound handler.
 */
export function createUpdateAgentBoundariesHandler(deps: McpToolDeps) {
  return async (args: UpdateAgentBoundariesArgs): Promise<OperatorToolResult> => {
    try {
      const { agent_id, cwd, nopeContent, enabled } = args;
      // Both fields are optional, so a call naming neither has nothing to do.
      //
      // **This refusal is LATE, and the window is accepted rather than absent.**
      // `registry.invoke` parses, then gates, then invokes — so an empty call
      // mints a real approval card first, and a person can be asked about a
      // change that was never going to happen. They approve, the retry lands
      // here, and gets this refusal. That is a nuisance, not a bypass: nothing is
      // written on either path, and the card names the same capability it always
      // does.
      //
      // The obvious cure does not work, and the reason is NOT the one that is
      // usually given. A `.refine()` here WOULD run before the gate (measured on
      // this repo's Zod 4: `.refine()` on a `ZodObject` returns a `ZodObject`,
      // keeps `.shape`, and still converts through `z.toJSONSchema` — the Zod 3
      // `ZodEffects` problem is gone). What it would cost is the answer's shape.
      // The MCP surface rebuilds its arguments from `.shape` alone
      // (`capabilityInputShape`), so a refine rides only the registry's own
      // parse, and a failed parse propagates as a raw `ZodError` rather than the
      // `{ error, code }` envelope every other refusal on this surface returns —
      // `mcp-projection` re-wraps `CapabilityToolError` and nothing else.
      //
      // So: a typed sentence a model can act on, at the cost of one avoidable
      // card for a caller that sent an empty patch. Flip it the other way only
      // with a plan for the error shape.
      if (nopeContent === undefined && enabled === undefined) {
        return jsonResult(
          {
            error:
              'Nothing to change. Send nopeContent (the new NOPE.md text), enabled (whether the ' +
              'agent is given it at all), or both.',
            code: 'VALIDATION',
          },
          true
        );
      }
      const resolved = resolveAgentPath(deps, { agent_id, cwd });
      const agentPath = await validateBoundaryOrDorkHome(resolved);

      // The mute rides `conventions.nope` and names nothing else.
      // `updateAgentManifest` merges a nested field into the object already on
      // disk (DOR-1719), so the other three switches keep whatever the person set
      // — they used to be read here and sent back unchanged, because the write
      // replaced the object and `ConventionsSchema` defaults every key to `true`,
      // which switched SOUL.md, MEMORY.md and the knowledge block back on behind
      // the operator's back.
      const updated = await updateAgentManifest({
        agentPath,
        body: {
          ...(nopeContent !== undefined ? { nopeContent } : {}),
          ...(enabled !== undefined ? { conventions: { nope: enabled } } : {}),
        },
        meshCore: deps.meshCore,
      });
      return jsonResult(updated);
    } catch (err) {
      return agentUpdateFailure(err, "Failed to change the agent's safety boundaries");
    }
  };
}

/**
 * `activity_list` — query the append-only activity feed through
 * {@link ActivityService}, validating args with the same
 * {@link ListActivityQuerySchema} the HTTP route uses.
 *
 * @param deps - Tool deps (`activityService`).
 * @returns The bound handler.
 */
export function createActivityListHandler(deps: McpToolDeps) {
  return async (args: Record<string, unknown>): Promise<OperatorToolResult> => {
    if (!deps.activityService) {
      return jsonResult({ error: 'Activity feed is not available in this instance.' }, true);
    }
    const parsed = ListActivityQuerySchema.safeParse(args);
    if (!parsed.success) {
      return jsonResult(
        { error: 'Validation failed', details: z.flattenError(parsed.error) },
        true
      );
    }
    try {
      const result = await deps.activityService.list(parsed.data);
      return jsonResult(result);
    } catch (err) {
      return jsonResult(
        { error: err instanceof Error ? err.message : 'Failed to fetch activity events' },
        true
      );
    }
  };
}

/**
 * `config_get` — return the allowlisted user config snapshot (via
 * {@link sanitizedConfigSnapshot}). Neither a secret nor a credential reference
 * may reach the tokenless external `/mcp` surface or the model's context; the
 * projection in `config-disclosure.ts` is the authority on what does.
 *
 * @returns The bound handler (no deps; reads the config singleton).
 */
export function createConfigGetHandler() {
  return async (): Promise<OperatorToolResult> => {
    try {
      return jsonResult(sanitizedConfigSnapshot());
    } catch (err) {
      return jsonResult(
        { error: err instanceof Error ? err.message : 'Failed to read config' },
        true
      );
    }
  };
}

/**
 * Name the agent making a config write, for the writer field every guarded write
 * carries.
 *
 * The directory name is the legible handle when an identity carries no display
 * name — the same fallback `capability-attribution.ts` uses for the same reason,
 * so the Activity feed and a display-name receipt cannot name one agent two
 * different ways. `null` when the surface resolved nobody, which is a fact
 * rather than an omission: an unresolved identity writes the same config and
 * simply cannot be named.
 *
 * @param identity - The calling agent, when the surface resolved one.
 * @returns The writer every config-writing operator handler passes.
 */
function agentWriter(identity?: AgentIdentity): DisplayNameWriter {
  return {
    kind: 'agent',
    agentName: identity ? identity.displayName || path.basename(identity.agentPath) : null,
  };
}

/**
 * `config_patch` — deep-merge a partial config and persist it through
 * {@link applyGuardedConfigWrite}, the same guarded step `PATCH /api/config` and
 * `dorkos config set` go through. A user-settings mutation: the tool description
 * flags that it requires explicit user intent.
 *
 * Posture-bearing settings are refused before anything is written. This is the
 * AGENT surface: tier `act` means no approval is asked, so leaving the patch
 * unbounded let an agent turn off login, which is the one setting the destructive
 * approval gate depends on. The refusal comes from
 * {@link OPERATOR_TOOL_AUTHORITY} rather than living inside `applyConfigPatch`,
 * because the cockpit's own enable-login and disable-login flows go through that
 * shared function via `PATCH /api/config` and must keep working. See
 * `config-write-policy.ts` for the classification and its reasoning.
 *
 * A patch that touches even one operator-only path is refused whole: no partial
 * write, so an agent cannot smuggle a posture change in behind a legitimate one.
 *
 * **This is also where an agent-set display name gets its receipt** (DOR-1022).
 * `profile.displayName` stays writable here — DorkBot saving "call me Dorian" is
 * the onboarding flow — but since DOR-979 that name is what the roster and the
 * account menu call the person, so the write now records WHO made it. The name
 * of the writing agent is the identity the surface resolved, and `null` when it
 * resolved none; the record itself is `operator-only`, so a patch can never
 * write or clear it directly.
 *
 * @param identity - The calling agent, when the surface resolved one. Read only
 *   for the display-name receipt; nothing about the write depends on it.
 * @returns The bound handler (no deps; writes via the config singleton).
 */
export function createConfigPatchHandler(identity?: AgentIdentity) {
  return async (args: { patch?: Record<string, unknown> }): Promise<OperatorToolResult> => {
    const result = applyGuardedConfigWrite({
      patch: args.patch,
      authority: OPERATOR_TOOL_AUTHORITY,
      source: 'the config_patch tool',
      writer: agentWriter(identity),
    });
    if (!result.ok) {
      if (result.kind === 'invalid') {
        return jsonResult(
          { error: result.error, ...(result.details ? { details: result.details } : {}) },
          true
        );
      }
      const { error, code, paths, message } = result.refusal;
      return jsonResult({ error, code, paths, message }, true);
    }
    // Echo the redacted post-write snapshot — never the raw config, which
    // would leak secrets into the model context and the persisted transcript.
    // Projected from the config the write RETURNED rather than re-read from the
    // store, which is the convention `sanitizedConfigSnapshot` documents for a
    // post-write caller: `PATCH /api/config` does the same, and the value is
    // already in hand either way.
    return jsonResult({
      success: true,
      config: sanitizedConfigSnapshot(result.config),
      ...(result.warnings.length > 0 && { warnings: result.warnings }),
    });
  };
}

/** The sidebar section a caller names, and the members it wants filed there. */
export interface SidebarAddToGroupArgs {
  /** The section, by id or by name (name matched without case). */
  group: string;
  /** The agents and rooms to file there. */
  items: SidebarItemRef[];
  /** Make the section when no section answers to `group`. */
  createIfMissing?: boolean;
}

/** The sidebar section a caller names, and the members it wants out of it. */
export interface SidebarRemoveFromGroupArgs {
  /** The section, by id or by name (name matched without case). */
  group: string;
  /** The agents and rooms to take out of it. */
  items: SidebarItemRef[];
}

/**
 * Persist an edited `ui.sidebar` through the one guarded write path.
 *
 * ## Why the WHOLE section goes back, on a capability whose point is narrowness
 *
 * Because that is the key's write contract, and it is not this module's to
 * change: `ui.sidebar` is stored as one value, `deepMerge` replaces arrays
 * rather than merging them, and the client sends the complete section on every
 * drag (the header of `entities/config/model/use-sidebar-prefs.ts`). What these
 * capabilities narrow is the READ-MODIFY step — the config is read HERE, at call
 * time, so the payload can never be a snapshot a model took several turns ago.
 *
 * ## Why the patch names nothing but `ui.sidebar`
 *
 * `applyGuardedConfigWrite` refuses a patch that so much as NAMES an
 * operator-only setting, and refuses it whole. Building the patch here, from a
 * config this process just read, means no argument a caller sends can put a
 * second section in it: `group` and `items` are the only inputs, and neither is
 * a config path. So the person-only guard on these two capabilities is
 * structural rather than checked, which is the strongest form it can take.
 *
 * @param next - The complete sidebar prefs to store.
 * @param source - How this write reached DorkOS, for the audit line.
 * @param identity - The calling agent, when the surface resolved one.
 * @returns The guarded write's own result, for the caller to answer with.
 */
function writeSidebarPrefs(
  next: SidebarPrefs,
  source: string,
  identity?: AgentIdentity
): GuardedConfigWriteResult {
  return applyGuardedConfigWrite({
    patch: { ui: { sidebar: next } },
    authority: OPERATOR_TOOL_AUTHORITY,
    source,
    writer: agentWriter(identity),
  });
}

/** Turn a refused or invalid sidebar write into the `isError` payload a model reads. */
function sidebarWriteFailure(result: GuardedConfigWriteResult): OperatorToolResult {
  if (result.ok) throw new Error('sidebarWriteFailure called on a write that succeeded.');
  if (result.kind === 'invalid') {
    return jsonResult(
      { error: result.error, ...(result.details ? { details: result.details } : {}) },
      true
    );
  }
  const { error, code, paths, message } = result.refusal;
  return jsonResult({ error, code, paths, message }, true);
}

/**
 * `sidebar_add_to_group` — file agents and rooms under one sidebar section,
 * touching no section but that one and whichever one an item moved out of
 * (DOR-2055).
 *
 * The defect this replaces: to add three agents to one section an agent had to
 * re-send the entire `ui.sidebar.groups` array through `config_patch`, because
 * arrays replace wholesale. A drag the person made in between would have been
 * overwritten in silence, and one mistyped section in that payload would have
 * deleted every other section they had.
 *
 * Filing something that already sits in another hand-sorted section is a MOVE,
 * matching the client's `moveToGroup` and the single-parent membership every
 * other surface assumes; the sections it left come back as `movedFrom` so the
 * answer says where it went from. See {@link liftFromOtherGroups}.
 *
 * @param identity - The calling agent, when the surface resolved one. Read only
 *   for the audit line's writer field; nothing about the write depends on it.
 * @returns The bound handler.
 */
export function createSidebarAddToGroupHandler(identity?: AgentIdentity) {
  return async (args: SidebarAddToGroupArgs): Promise<OperatorToolResult> => {
    // Read at CALL time, never from anything the caller sent: the whole point is
    // that the sections this write preserves are the ones stored right now.
    const prefs = storedSidebarPrefs(configManager.get('ui'));
    const found = resolveSidebarGroup(prefs.groups, args.group);

    // A section nobody has is a refusal unless the caller said to make one — and
    // `createIfMissing` answers only THAT refusal. An ambiguous name or a smart
    // section is a different question, and creating a second section called
    // "DorkOS" because two already exist is the opposite of what was asked.
    if (!found.ok && !(found.code === 'SIDEBAR_GROUP_NOT_FOUND' && args.createIfMissing)) {
      return jsonResult({ error: found.error, code: found.code, sections: found.sections }, true);
    }

    const created = found.ok ? undefined : newSidebarGroup(args.group.trim());
    const target = found.ok ? found.group : created!;
    const { items, added, alreadyPresent } = addSidebarItems(target.items, args.items);
    const group = { ...target, items };
    const filed = created ? appendSidebarGroup(prefs, group) : replaceSidebarGroup(prefs, group);

    // Lift EVERY ref the caller named, not only the ones newly appended: after
    // this call each named item is in the section that was asked for and in no
    // other, which is also what makes a repeated call a no-op rather than a
    // slow drift back into two homes.
    const { groups, movedFrom } = liftFromOtherGroups(filed.groups, group.id, args.items);
    const next = { ...filed, groups };

    const result = writeSidebarPrefs(next, 'the sidebar_add_to_group tool', identity);
    if (!result.ok) return sidebarWriteFailure(result);

    return jsonResult({
      success: true,
      group,
      created: created !== undefined,
      added,
      alreadyPresent,
      movedFrom,
      ...(result.warnings.length > 0 && { warnings: result.warnings }),
    });
  };
}

/**
 * `sidebar_remove_from_group` — take agents and rooms out of one sidebar
 * section, leaving every other section exactly as it was (DOR-2055).
 *
 * The symmetric half of {@link createSidebarAddToGroupHandler}, minus
 * `createIfMissing`: there is nothing to make when the section a caller wants to
 * empty does not exist. Taking the last member out leaves the section standing
 * and empty — see {@link removeSidebarItems} for why deleting it would be a
 * second change nobody asked for.
 *
 * @param identity - The calling agent, when the surface resolved one.
 * @returns The bound handler.
 */
export function createSidebarRemoveFromGroupHandler(identity?: AgentIdentity) {
  return async (args: SidebarRemoveFromGroupArgs): Promise<OperatorToolResult> => {
    const prefs = storedSidebarPrefs(configManager.get('ui'));
    const found = resolveSidebarGroup(prefs.groups, args.group);
    if (!found.ok) {
      return jsonResult({ error: found.error, code: found.code, sections: found.sections }, true);
    }

    const { items, removed, notPresent } = removeSidebarItems(found.group.items, args.items);
    const group = { ...found.group, items };
    const result = writeSidebarPrefs(
      replaceSidebarGroup(prefs, group),
      'the sidebar_remove_from_group tool',
      identity
    );
    if (!result.ok) return sidebarWriteFailure(result);

    return jsonResult({
      success: true,
      group,
      removed,
      notPresent,
      ...(result.warnings.length > 0 && { warnings: result.warnings }),
    });
  };
}

/**
 * `check_update` — report the running server version and the latest published
 * version from the npm registry (via the cached {@link getLatestVersion}).
 * `latestVersion` is `null` in dev builds or when the registry is unreachable.
 *
 * @returns The bound handler (no deps).
 */
export function createCheckUpdateHandler() {
  return async (): Promise<OperatorToolResult> => {
    const latestVersion = await getLatestVersion();
    return jsonResult({ version: SERVER_VERSION, latestVersion });
  };
}

/**
 * `agents_recent_activity` — the per-agent latest-activity map behind
 * `GET /api/sessions/recent`. Fans out {@link listRecentSessions} across every
 * registered agent's project directory and returns each agent joined with its
 * most-recent session `updatedAt`, plus the raw `agentActivity` map and any
 * per-runtime `warnings`.
 *
 * @param deps - Tool deps (`runtimeRegistry` for the fan-out; `meshCore` for the
 *   agent roster).
 * @returns The bound handler.
 */
export function createAgentsRecentActivityHandler(deps: McpToolDeps) {
  return async (args: { limit?: number }): Promise<OperatorToolResult> => {
    if (!deps.runtimeRegistry) {
      return jsonResult({ error: 'Runtime registry is not available in this instance.' }, true);
    }
    const limit = args.limit ?? 10;
    const roster = deps.meshCore ? deps.meshCore.listWithPaths() : [];
    const runtimes = deps.runtimeRegistry.listRuntimes();
    const { agentActivity, warnings } = await listRecentSessions({
      runtimes,
      agentPaths: roster.map((a) => a.projectPath),
      limit,
    });
    // Join the roster with its latest activity for a legible, agent-keyed view;
    // keep the raw path→timestamp map too (the route's `agentActivity` field).
    const agents = roster
      .map((a) => ({
        id: a.id,
        name: a.name,
        displayName: a.displayName ?? null,
        projectPath: a.projectPath,
        lastActivity: agentActivity[a.projectPath] ?? null,
      }))
      .filter((a) => a.lastActivity !== null)
      .sort((x, y) => Date.parse(y.lastActivity!) - Date.parse(x.lastActivity!));
    return jsonResult({ agents, agentActivity, warnings });
  };
}
