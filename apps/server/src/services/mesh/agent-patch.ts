/**
 * The pieces of the operator's agent routes (`routes/mesh.ts`) that decide what
 * a request may write, kept here so the route reads as the sequence of steps.
 *
 * @module services/mesh/agent-patch
 */
import type { AgentManifest, UpdateAgentRequest } from '@dorkos/shared/mesh-schemas';
import { currentCreatorAccountId } from '../heartbeats/reports-to.js';
import {
  canonicalReportsTo,
  checkReportsToWrite,
  recordReportsToChange,
  type ReportsToMesh,
  type ReportsToRefusal,
} from '../heartbeats/reports-to-writes.js';

/**
 * The fields a registration mints a manifest with: the caller's overrides and
 * the resolved identity, minus the two the body never decides (spec
 * `heartbeats` §4.1). `createdBy` is the account making the request;
 * `reportsTo` is set afterwards, through a write surface that refuses a loop.
 *
 * @param overrides - What the request body asked for.
 * @param identity - The resolved name and display name.
 */
export function registrationFields<T extends Partial<AgentManifest>>(
  overrides: T | undefined,
  identity: Partial<AgentManifest>
): Partial<AgentManifest> {
  const { reportsTo: _ignoredReportsTo, createdBy: _ignoredCreatedBy, ...rest } = overrides ?? {};
  return { ...rest, ...identity, createdBy: currentCreatorAccountId() };
}

/** A PATCH ready to write, or the reason it may not be. */
export type PreparedAgentPatch =
  | { refusal: { error: string; code: ReportsToRefusal['code'] } }
  | {
      /** Only the keys the caller sent; `null` turned into `undefined` (clear). */
      fields: Partial<AgentManifest>;
      /** Record what changed once the write has landed; passes the result through. */
      recorded: <M extends AgentManifest | undefined>(updated: M) => M;
    };

/**
 * Turn a parsed agent PATCH into the fields to write.
 *
 * PATCH semantics: only the keys the caller sent are written (Zod fills in
 * defaults for the rest), and `null` means "clear this field" because
 * `undefined` cannot travel over JSON. A `reportsTo` is checked like on every
 * write surface — a manager who does not exist, or a loop, is refused — and an
 * owner alias is stored as the owner's canonical id.
 *
 * @param mesh - Where agents are looked up.
 * @param agentId - The agent being changed.
 * @param body - The raw request body (what the caller actually named).
 * @param data - The parsed body.
 */
export function prepareAgentPatch(
  mesh: ReportsToMesh,
  agentId: string,
  body: unknown,
  data: UpdateAgentRequest
): PreparedAgentPatch {
  const sent = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const fields = Object.fromEntries(
    Object.entries(data)
      .filter(([key]) => key in sent)
      .map(([key, value]) => [key, value === null ? undefined : value])
  ) as Partial<AgentManifest>;
  if (!('reportsTo' in sent)) return { fields, recorded: (updated) => updated };

  const requested = data.reportsTo ?? null;
  const refusal = checkReportsToWrite(mesh, agentId, requested);
  if (refusal) return { refusal: { error: refusal.message, code: refusal.code } };
  fields.reportsTo = canonicalReportsTo(mesh, requested) ?? undefined;
  const before = mesh.get(agentId)?.reportsTo ?? null;
  return {
    fields,
    recorded: (updated) => {
      if (updated) recordReportsToChange(updated, before, updated.reportsTo ?? null);
      return updated;
    },
  };
}
