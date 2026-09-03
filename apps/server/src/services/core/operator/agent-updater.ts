/**
 * Agent self-edit service — the single implementation of the PATCH
 * `/api/agents/current` update semantics (traits, conventions, displayName,
 * SOUL.md/NOPE.md content), shared by the HTTP route and the `update_agent` MCP
 * tool so neither re-implements (and drifts on) the identity guards.
 *
 * The caller resolves and boundary-validates the agent's project directory; this
 * module owns only the manifest-level rules: the write policy that says which
 * fields an agent may set on itself ({@link AGENT_WRITE_POLICY}), schema
 * validation, the system-agent identity protections, convention-file writes, the
 * null-clears-field merge, and the best-effort Mesh DB sync (ADR-0043).
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
import type { SyncFromDiskResult } from '@dorkos/mesh';
import {
  CAPABILITY_CEILING_PHRASE,
  CAPABILITY_TIER_RANK,
  DEFAULT_AGENT_TIER_CEILING,
} from '@dorkos/shared/capabilities';
import { writeConventionFile } from '@dorkos/shared/convention-files-io';
import {
  CONVENTION_FILES,
  MEMORY_MAX_CHARS,
  NOPE_MAX_CHARS,
  SOUL_MAX_CHARS,
} from '@dorkos/shared/convention-files';
import {
  describeAgentOperatorOnlyRefusal,
  findOperatorOnlyAgentPaths,
  NESTED_AGENT_FIELDS,
} from './agent-write-policy.js';

/**
 * Identity fields that cannot be changed on a system agent (`isSystem: true`).
 * A system agent's display name, description and system flag are fixed at
 * creation — DorkBot and friends must remain addressable and un-spoofable.
 * Mirrors the guard the agents route has always enforced.
 *
 * `name` and `namespace` are not listed because they are operator-only for EVERY
 * agent on this seam ({@link AGENT_WRITE_POLICY}), so the policy check refuses
 * them before this one is reached; a row here would never fire.
 */
const SYSTEM_PROTECTED_FIELDS = ['displayName', 'description', 'isSystem'] as const;

/** Discriminating code for {@link AgentUpdateError}, mapped to HTTP status by the route. */
export type AgentUpdateErrorCode =
  'VALIDATION' | 'NOT_FOUND' | 'SYSTEM_PROTECTED' | 'OPERATOR_ONLY';

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

/**
 * Why a convention file was refused, in words an editor can put on screen.
 *
 * The one refusal a person actually hits is a file over its budget, and the
 * number that matters is the budget — the editor bounds the prose it shows,
 * while the limit is on the whole file, personality block included. Anything
 * else falls back to the generic message, with the Zod issues on `details`.
 *
 * @param error - The failed `UpdateAgentConventionsSchema` parse.
 */
function conventionRefusal(error: z.ZodError): string {
  // Keyed by the field the schema refused, so a new convention file is one row
  // here rather than a fourth branch of a ternary — and so a field added to the
  // schema without a row falls through to the generic message loudly instead of
  // being reported as somebody else's file.
  const budgets: Record<string, { file: string; max: number }> = {
    soulContent: { file: CONVENTION_FILES.soul, max: SOUL_MAX_CHARS },
    nopeContent: { file: CONVENTION_FILES.nope, max: NOPE_MAX_CHARS },
    memoryContent: { file: CONVENTION_FILES.memory, max: MEMORY_MAX_CHARS },
  };

  const issue = error.issues.find(
    (candidate) => candidate.code === 'too_big' && budgets[String(candidate.path[0])] !== undefined
  );
  if (!issue) return 'Validation failed';

  const { file, max } = budgets[String(issue.path[0])]!;
  // A colon rather than a dash: this sentence is composed with the caller's own
  // ("Couldn't save your instructions — …"), and two dashes in one line read as
  // an aside inside an aside.
  return `${file} is too long: the whole file has to fit in ${max.toLocaleString('en-US')} characters.`;
}

/** A JSON object, which is the only shape a nested manifest field can merge as. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The value one field of the patch actually writes.
 *
 * For a scalar it is the parsed value, unchanged. For a NESTED field — one whose
 * leaves {@link AGENT_WRITE_POLICY} classifies individually
 * ({@link NESTED_AGENT_FIELDS}) — it is the object already on disk with only the
 * leaves the caller actually sent laid over it.
 *
 * ## Why the merge exists (DOR-1719)
 *
 * These objects are Zod schemas whose leaves carry `.default()`, and every one of
 * those defaults is the permissive end: `ConventionsSchema` defaults all four
 * injection switches to `true`, `TraitsSchema` all six dials to `3`. So parsing
 * `{"conventions":{"soul":false}}` hands back all four flags, and writing that
 * whole object put the three the caller never mentioned back to their defaults —
 * a reviewer watched `memory` flip `false → true` on an unrelated edit, silently
 * reversing a mute a person had chosen. The same shape reset five personality
 * dials whenever an agent nudged the sixth.
 *
 * The leaf intersection is the same rule the top-level patch uses, applied one
 * level down: the raw body's own keys are the only thing that says what the
 * caller meant. It also settles the unknown-key case — `{"traits":{"zzz":1}}`
 * sends no leaf this schema knows, so it writes nothing rather than resetting the
 * object it named, which is how the config seam has always behaved
 * (`applyConfigPatch` deep-merges).
 *
 * **The base comes from the same lockless read every guard on this seam uses**
 * (the `tierCeiling` check says the same thing at more length): read, decide,
 * write, with nothing held over `.dork/agent.json`, so two PATCHes landing
 * together can interleave. This change strictly NARROWS that window rather than
 * opening it — the losing write used to clobber every leaf of the object, and now
 * clobbers only the leaves it actually named. Closing it properly means locking
 * the whole manifest, which is a change to this seam rather than to this function
 * (DOR-1722).
 *
 * @param key - The manifest field being written.
 * @param parsedValue - That field's value from the validated patch.
 * @param rawValue - That field's value as the caller sent it (the record of what
 *   was named).
 * @param existingValue - That field's value as stored on disk.
 * @returns The value to write for `key`.
 */
function mergedFieldValue(
  key: string,
  parsedValue: unknown,
  rawValue: unknown,
  existingValue: unknown
): unknown {
  if (!NESTED_AGENT_FIELDS.has(key)) return parsedValue;
  if (!isPlainObject(parsedValue) || !isPlainObject(rawValue)) return parsedValue;

  const sentLeaves = new Set(Object.keys(rawValue));
  const changed = Object.entries(parsedValue).filter(([leaf]) => sentLeaves.has(leaf));
  return {
    ...(isPlainObject(existingValue) ? existingValue : {}),
    ...Object.fromEntries(changed),
  };
}

/** Minimal MeshCore surface needed for the post-write DB sync (ADR-0043). */
interface MeshSyncLike {
  syncFromDisk(projectPath: string): Promise<SyncFromDiskResult>;
}

/**
 * Apply a self-edit patch to the agent manifest at `agentPath`.
 *
 * Enforces, in this order: the operator-only write policy
 * ({@link AGENT_WRITE_POLICY}), schema validation, existence, the tier-ceiling
 * direction check, and the system-agent identity protections.
 * `soulContent`/`nopeContent`/
 * `memoryContent` are written to their convention files; remaining fields merge into `agent.json`
 * with `null` meaning "clear this field" (JSON can't carry `undefined`), and a
 * field whose value is an object of independent leaves merging leaf by leaf so a
 * partial patch leaves its siblings alone ({@link mergedFieldValue}). After a
 * successful write it best-effort syncs the Mesh DB cache (never fatal).
 *
 * @param opts - Update inputs.
 * @param opts.agentPath - The agent's project directory (already resolved and
 *   boundary-validated by the caller).
 * @param opts.body - The raw patch object as received (checked for forbidden
 *   keys before parsing, so a refusal never depends on the rest of the patch
 *   being well-formed).
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

  const rawBody = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

  // Guard: the fields an agent may not set on itself (DOR-1506).
  //
  // One classification table for the whole seam
  // (`agent-write-policy.ts` — read its module doc for the line and for what it
  // deliberately does not close), replacing the three hand-written guards this
  // used to carry. This is the AGENT-REACHABLE write path: `PATCH
  // /api/agents/current` and the `operator.update_agent` MCP tool both land here.
  //
  // **First, before the schema parse and before the manifest read**, unlike the
  // two value-shaped checks below. The refusal is about WHO may write a field,
  // and that answer cannot be contingent on the rest of the patch being
  // well-formed — `{"roomsManage": null}` fails the boolean schema, and reporting
  // that as a validation error would tell an agent to fix its types and try again
  // at a field it may never write. Naming the field at all (`true`, `false`,
  // `null`, or any object above it — including one whose keys DorkOS does not
  // recognise) is refused, since a patch that names the field is a patch about
  // the field.
  //
  // Refused rather than stripped: an agent told nothing would report the change
  // as done (the DOR-1253 shape). All-or-nothing, matching
  // `operator.config_patch`.
  //
  // The operator's own surface, `PATCH /api/mesh/agents/:id`, writes every one of
  // these and does not come through here. **A cockpit that edits an operator-only
  // field must use that route** — the Tools tab does, for both the tool groups
  // and the rooms-management grant.
  const refusedPaths = findOperatorOnlyAgentPaths(rawBody);
  if (refusedPaths.length > 0) {
    throw new AgentUpdateError('OPERATOR_ONLY', describeAgentOperatorOnlyRefusal(refusedPaths));
  }

  const parsed = UpdateAgentRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new AgentUpdateError('VALIDATION', 'Validation failed', z.flattenError(parsed.error));
  }

  const existing = await readManifest(agentPath);
  if (!existing) {
    throw new AgentUpdateError('NOT_FOUND', 'No agent registered at this path');
  }

  // Guard: an agent may TIGHTEN its own ceiling, never widen one (DOR-486).
  //
  // The policy table above refuses a FIELD. This one refuses a
  // DIRECTION, and the difference is the point: `tierCeiling` is the cap on what
  // an agent may ever reach, so lowering it is an agent giving something up —
  // a normal, safe thing to let it do, and the honest way for an agent to say
  // "I only ever read." Raising it hands privilege back, which is precisely the
  // decision a person has to make (`config-write-policy.ts`: a field is
  // operator-only when changing it alone widens a security control). Clearing
  // the field counts as raising, because absent means `destructive`.
  //
  // AFTER the manifest read, unlike the policy check above, because the answer is
  // a comparison against what is on disk rather than a property of the key. The
  // parse has already rejected a value that is not a tier, so this only ever
  // compares real rungs.
  //
  // The table records this verdict as `tighten-only` and derives
  // `TIGHTEN_ONLY_AGENT_PATHS` from it, so a SECOND field classified that way
  // fails `__tests__/agent-write-policy.test.ts` until somebody teaches this
  // block what "tighter" means for it — the comparison is per field and cannot
  // be generalized by the table alone.
  //
  // The operator's own surface, `PATCH /api/mesh/agents/:id`, does not come
  // through here and sets any ceiling. **A cockpit that edits the ceiling must
  // use that route** — the same split `enabledToolGroups.roomsManage` uses.
  //
  // **The comparison and the write are not atomic**, and that is unchanged from
  // every other guard on this seam: read, decide, write, with no lock over
  // `.dork/agent.json`. Two PATCHes landing together can interleave so the later
  // write is judged against a ceiling the earlier one already replaced. What the
  // window CANNOT do is manufacture a widening out of nothing — every value that
  // reaches the file passed this check against a real recorded ceiling, so the
  // worst case is that a raise the operator made and a lowering the agent made
  // resolve in the other order, and the operator's next write settles it. Closing
  // it properly means file locking for the whole manifest, which is a change to
  // this seam rather than to this field (DOR-486 review).
  if ('tierCeiling' in rawBody) {
    const current = existing.tierCeiling ?? DEFAULT_AGENT_TIER_CEILING;
    const requested = parsed.data.tierCeiling ?? DEFAULT_AGENT_TIER_CEILING;
    if (CAPABILITY_TIER_RANK[requested] > CAPABILITY_TIER_RANK[current]) {
      throw new AgentUpdateError(
        'OPERATOR_ONLY',
        `Only a person can widen what an agent is allowed to do. This agent is limited to ` +
          `${CAPABILITY_CEILING_PHRASE[current]}, and that asks for ` +
          `${CAPABILITY_CEILING_PHRASE[requested]}. Ask them to change it in the agent's ` +
          `Tools settings.`
      );
    }
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
  //
  // A failed parse is a REFUSAL, not a silent skip. This used to fall back to
  // `{}` and carry on: the manifest half of the patch was applied, the route
  // answered 200, and the editor said "Saved" over a SOUL.md the server had
  // thrown away (DOR-1253). Thrown before any write, so an over-budget file
  // leaves nothing half-applied behind it.
  const conventionsResult = UpdateAgentConventionsSchema.safeParse(body);
  if (!conventionsResult.success) {
    throw new AgentUpdateError(
      'VALIDATION',
      conventionRefusal(conventionsResult.error),
      z.flattenError(conventionsResult.error)
    );
  }
  const conventionUpdates = conventionsResult.data;

  if (conventionUpdates.soulContent !== undefined) {
    await writeConventionFile(agentPath, CONVENTION_FILES.soul, conventionUpdates.soulContent);
  }
  if (conventionUpdates.nopeContent !== undefined) {
    await writeConventionFile(agentPath, CONVENTION_FILES.nope, conventionUpdates.nopeContent);
  }
  // The memory file's OTHER writable path (DOR-632). Accepting `memoryContent`
  // on the wire and then not writing it is the DOR-1253 shape exactly: the
  // editor reports a save, the file never changes, and the person finds out the
  // next time they open it.
  if (conventionUpdates.memoryContent !== undefined) {
    await writeConventionFile(agentPath, CONVENTION_FILES.memory, conventionUpdates.memoryContent);
  }

  // traits and conventions go into agent.json via the manifest update.
  //
  // **Only the keys the caller actually SENT.** `UpdateAgentRequestSchema` is
  // `AgentManifestSchema.pick(...).partial()`, and several of the picked fields
  // carry a Zod `.default()` — so parsing `{"model":"sonnet"}` hands back a
  // `description` and a `capabilities` the caller never mentioned, and spreading
  // the whole parse result over the manifest wrote those defaults on top of real
  // values. A PATCH that set a model erased the agent's description and every
  // capability with it (DOR-1253): silent data loss on the most ordinary edit
  // there is. The patch is intersected with the raw body's own keys, which is
  // the only thing that says what the caller meant.
  //
  // `null` still means "clear this field" — `undefined` cannot travel over JSON,
  // so the wire needs a value for the absence and `null` is it.
  //
  // **The same rule one level down, for the fields whose value is an object**
  // ({@link mergedFieldValue}, DOR-1719). `conventions` and `traits` are objects
  // of independent leaves, each with a Zod default, so replacing the object wrote
  // defaults over every flag the caller had not named — reversing a deliberate
  // mute or five personality dials on an edit that touched one.
  const sent = new Set(Object.keys(rawBody));
  const stored: Record<string, unknown> = existing;
  const patch = Object.fromEntries(
    Object.entries(parsed.data)
      .filter(([key]) => sent.has(key))
      .map(([key, value]) => [key, mergedFieldValue(key, value, rawBody[key], stored[key])])
  );
  const merged: Record<string, unknown> = { ...existing, ...patch };
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
