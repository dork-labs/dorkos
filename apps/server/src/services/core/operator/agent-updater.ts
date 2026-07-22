/**
 * Agent self-edit service — the single implementation of the PATCH
 * `/api/agents/current` update semantics (traits, conventions, displayName,
 * SOUL.md/NOPE.md content), shared by the HTTP route and the `update_agent` MCP
 * tool so neither re-implements (and drifts on) the identity guards.
 *
 * The caller resolves and boundary-validates the agent's project directory; this
 * module owns only the manifest-level rules: schema validation, the immutable
 * `name` guard, the system-agent identity protections, convention-file writes,
 * the null-clears-field merge, and the best-effort Mesh DB sync (ADR-0043).
 *
 * @module services/core/operator/agent-updater
 */
import { z } from 'zod';
import { readManifest, writeManifest } from '@dorkos/shared/manifest';
import {
  UpdateAgentRequestSchema,
  UpdateAgentConventionsSchema,
} from '@dorkos/shared/mesh-schemas';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { writeConventionFile } from '@dorkos/shared/convention-files-io';

/**
 * Identity fields that cannot be changed on a system agent (`isSystem: true`).
 * A system agent's slug, display name, description, namespace, and system flag
 * are fixed at creation — DorkBot and friends must remain addressable and
 * un-spoofable. Mirrors the guard the agents route has always enforced.
 */
const SYSTEM_PROTECTED_FIELDS = [
  'name',
  'displayName',
  'description',
  'namespace',
  'isSystem',
] as const;

/** Discriminating code for {@link AgentUpdateError}, mapped to HTTP status by the route. */
export type AgentUpdateErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'IMMUTABLE_NAME'
  | 'SYSTEM_PROTECTED';

/**
 * Typed failure from {@link updateAgentManifest}. Callers translate `code` into
 * their transport's error shape (the route into an HTTP status, the MCP tool
 * into an error content block) so the guard logic lives in exactly one place.
 */
export class AgentUpdateError extends Error {
  /**
   * Construct a typed agent-update failure.
   *
   * @param code - The failure category (drives the caller's status mapping).
   * @param message - Human-readable explanation, safe to return to the caller.
   * @param details - Optional structured detail (e.g. flattened Zod issues).
   */
  constructor(
    public readonly code: AgentUpdateErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'AgentUpdateError';
  }
}

/** Minimal MeshCore surface needed for the post-write DB sync (ADR-0043). */
interface MeshSyncLike {
  syncFromDisk(projectPath: string): Promise<boolean>;
}

/**
 * Apply a self-edit patch to the agent manifest at `agentPath`.
 *
 * Enforces, in the same order as the route: schema validation, existence,
 * the immutable-`name` guard (slug is fixed after creation — use `displayName`),
 * and the system-agent identity protections. `soulContent`/`nopeContent` are
 * written to their convention files; remaining fields merge into `agent.json`
 * with `null` meaning "clear this field" (JSON can't carry `undefined`). After a
 * successful write it best-effort syncs the Mesh DB cache (never fatal).
 *
 * @param opts - Update inputs.
 * @param opts.agentPath - The agent's project directory (already resolved and
 *   boundary-validated by the caller).
 * @param opts.body - The raw patch object as received (checked for forbidden
 *   keys before parsing, matching the route's `'name' in req.body` guard).
 * @param opts.meshCore - Optional MeshCore for the post-write DB sync.
 * @returns The updated manifest as written to disk.
 * @throws {AgentUpdateError} On validation, missing agent, or a blocked field.
 */
export async function updateAgentManifest(opts: {
  agentPath: string;
  body: unknown;
  meshCore?: MeshSyncLike;
}): Promise<AgentManifest> {
  const { agentPath, body, meshCore } = opts;

  const parsed = UpdateAgentRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new AgentUpdateError('VALIDATION', 'Validation failed', z.flattenError(parsed.error));
  }

  const existing = await readManifest(agentPath);
  if (!existing) {
    throw new AgentUpdateError('NOT_FOUND', 'No agent registered at this path');
  }

  const rawBody = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

  // Guard: name (slug) is immutable after creation — use displayName instead.
  if ('name' in rawBody) {
    throw new AgentUpdateError(
      'IMMUTABLE_NAME',
      'Agent slug (name) cannot be changed after creation. Use displayName instead.'
    );
  }

  // Guard: system agents cannot have identity fields changed.
  if (existing.isSystem) {
    const blockedFields = SYSTEM_PROTECTED_FIELDS.filter((f) => f in rawBody);
    if (blockedFields.length > 0) {
      throw new AgentUpdateError(
        'SYSTEM_PROTECTED',
        `Cannot modify ${blockedFields.join(', ')} on system agents`
      );
    }
  }

  // Write convention files if provided alongside manifest fields.
  const conventionsResult = UpdateAgentConventionsSchema.safeParse(body);
  const conventionUpdates = conventionsResult.success ? conventionsResult.data : {};

  if (conventionUpdates.soulContent !== undefined) {
    await writeConventionFile(agentPath, 'SOUL.md', conventionUpdates.soulContent);
  }
  if (conventionUpdates.nopeContent !== undefined) {
    await writeConventionFile(agentPath, 'NOPE.md', conventionUpdates.nopeContent);
  }

  // traits and conventions go into agent.json via the manifest update.
  // Null values signal "clear this field" (undefined can't travel over JSON).
  const merged: Record<string, unknown> = { ...existing, ...parsed.data };
  for (const key of Object.keys(merged)) {
    if (merged[key] === null) delete merged[key];
  }
  const updated = merged as AgentManifest;
  await writeManifest(agentPath, updated);

  // ADR-0043: sync to Mesh DB cache (best-effort).
  try {
    await meshCore?.syncFromDisk(agentPath);
  } catch {
    /* non-fatal */
  }

  return updated;
}
