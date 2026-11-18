import path from 'path';
import { z } from 'zod';
import { ManifestUnreadableError } from '@dorkos/mesh';
import { UpdateAgentRequestSchema } from '@dorkos/shared/mesh-schemas';
import { clearsTheAgentBar, refuseUnlessAccountOwner } from '../lib/caller-authority.js';
import { clearAgentByPerson, declareAgent } from '../services/core/turn-power/declared-readers.js';
import { READS_OUTSIDE_TEXT_PERSON_ONLY } from '../services/core/operator/agent-updater.js';
import { withPersonRepin } from '../services/runtimes/claude-code/folder-settings/folder-config-consent.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { setCreditsAllowedForAgent } from '../services/core/cloud/credits-defaults.js';
import { creditsAgentPatchRefusal } from '../services/core/cloud/credits-model-gate.js';
import { CREDITS_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import { writeAgentManifest } from '../services/core/agent-observation/agent-execution-writes.js';
import { prepareAgentPatch } from '../services/mesh/agent-patch.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Context } from 'hono';
import type { MeshRouterDeps } from './mesh.js';
import { runAccountWrite } from './cloud-owner-bar.js';

/** Update agent details, holding lasting credits consent before any manifest write. */
export async function patchMeshAgent(
  c: Context<ApiEnv>,
  deps: MeshRouterDeps,
  confirmation?: { facts: RequestFacts; revision: string }
): Promise<Response> {
  const { meshCore } = deps;
  const caller = confirmation?.facts ?? honoRequestFacts(c);

  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Agent not found' }, 404);
  // Read as an object: anything else fails the schema below before a field
  // is looked up, as `req.body` did on Express.
  const body = readJsonBody(c) as Record<string, unknown>;
  // What an agent may do is never written here (spec `agent-permissions` D10).
  // This route has no caller guard of its own, so any local program can reach
  // it; the permission routes are the one way in, behind a person and with an
  // audit event. Refused by name rather than stripped by the schema, so the
  // caller learns where to go instead of getting a 200 that changed nothing.
  const refused = retiredPermissionFields(body);
  if (refused.length > 0) {
    return c.json(
      {
        error:
          'Only a person can change permissions, from the Permissions page. Agents can ask the person.',
        code: 'USE_PERMISSIONS_API',
        fields: refused,
      },
      400
    );
  }
  const result = UpdateAgentRequestSchema.safeParse(body);
  if (!result.success) {
    return c.json({ error: 'Validation failed', details: z.flattenError(result.error) }, 400);
  }
  // Anyone may say an agent reads outside text; only a person takes it back (DOR-3969).
  const readsOutsideText = result.data.readsOutsideText;
  if (readsOutsideText === false && !clearsTheAgentBar(caller)) {
    return c.json({ error: READS_OUTSIDE_TEXT_PERSON_ONLY, code: 'person_only' }, 403);
  }

  // Guard: system agents cannot have identity fields changed
  const SYSTEM_PROTECTED_FIELDS = ['name', 'description', 'namespace', 'isSystem'] as const;
  const blockedFields = meshCore.get(id)?.isSystem
    ? SYSTEM_PROTECTED_FIELDS.filter((f) => f in body)
    : [];
  if (blockedFields.length > 0) {
    return c.json(
      {
        error: `Cannot modify ${blockedFields.join(', ')} on system agents`,
      },
      403
    );
  }

  // Only the keys the caller sent, `null` as "clear", and a reports-to change
  // checked for loops (spec `heartbeats` §4.1) — see `prepareAgentPatch`.
  const patch = prepareAgentPatch(meshCore, id, body, result.data);
  if ('refusal' in patch) return c.json(patch.refusal, 400);
  // An agent on DorkOS credits may be set only to a model credits serve on
  // its runtime's protocol, the same menu its Model row offers (DOR-2636).
  const modelRefusal = await creditsAgentPatchRefusal(
    id,
    patch.fields,
    Object.hasOwn(body as object, 'account'),
    meshCore.get(id)
  );
  if (modelRefusal) return c.json({ error: modelRefusal, code: 'UNSUPPORTED_MODEL' }, 400);
  const grantsCredits =
    body.account === CREDITS_ACCOUNT_ID && refuseUnlessAccountOwner(caller) === undefined;
  if (grantsCredits && !confirmation) {
    if (!meshCore.get(id)) return c.json({ error: 'Agent not found' }, 404);
    const revision = await agentPatchRevision(meshCore, id);
    return runAccountWrite(c, {
      kind: 'cloud.credits',
      target: 'agent:' + id,
      input: { id, body: result.data, revision },
      reason: 'Use DorkOS credits for this agent.',
      run: (facts) => patchMeshAgent(c, deps, { facts, revision }),
    });
  }
  if (confirmation && (await agentPatchRevision(meshCore, id)) !== confirmation.revision)
    return c.json({ error: 'The agent changed. Try again.', code: 'AGENT_CHANGED' }, 409);

  // ADR-0043: update() is async — writes to disk first, then DB.
  //
  // It REFUSES when the manifest is present but unreadable, rather than
  // rebuilding one from the DB row, because that row cannot carry
  // `permissions`, `mcpServers` or `workspace` and the rebuild would erase all
  // three (DOR-486 review). Answered as a 409 with the
  // reason: the request is fine, the state on disk is not, and the operator
  // can act on the sentence.
  // Narrowed to the sentinel class on purpose. An unconditional catch here
  // also swallowed `writeManifest`'s schema rejection and any I/O failure, and
  // answered all of them `409 MANIFEST_UNREADABLE` with the raw message —
  // a wrong status over a wrong story, and internals on the wire (DOR-486
  // re-review). Anything else rethrows to the error middleware, which is where
  // an unexpected failure belongs.
  let updated;
  // Through the observer of outside changes when it names the runtime, model
  // or effort, so this person's change is never reported as one (DOR-2337).
  const home = meshCore.getProjectPath(id);
  const write = () =>
    writeAgentManifest(body, home, async () => {
      if (confirmation && (await agentPatchRevision(meshCore, id)) !== confirmation.revision)
        throw new AgentPatchChangedError();
      return patch.recorded(await meshCore.update(id, patch.fields));
    });
  try {
    // A person's own account change moves the agent's folder settings pin
    // with it; anyone else's waits for a card on its next turn (DOR-3068).
    updated =
      home && Object.hasOwn(body, 'account') && clearsTheAgentBar(caller)
        ? await withPersonRepin(
            { agentId: id, home },
            'manifest',
            "changing an agent's account",
            write
          )
        : await write();
  } catch (err) {
    if (err instanceof AgentPatchChangedError)
      return c.json({ error: 'The agent changed. Try again.', code: 'AGENT_CHANGED' }, 409);
    if (!(err instanceof ManifestUnreadableError)) throw err;
    return c.json({ error: err.message, code: 'MANIFEST_UNREADABLE' }, 409);
  }
  if (!updated) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  // DorkOS's own record, which no edit of the file clears: a person's `false`
  // (checked above) is the only way out (DOR-3969).
  if (readsOutsideText === true) declareAgent(id, home);
  if (readsOutsideText === false) clearAgentByPerson(id, home);
  // Only the owner of this DorkOS can put an agent on DorkOS credits
  // (ADR 261001-000811, DOR-2652). The file now says what was asked; the
  // consent lives in DorkOS config, recorded only for the owner, so an agent,
  // another signed-in account, or a cloned file naming credits on its own
  // spends nothing.
  if (Object.hasOwn(body as object, 'account') && refuseUnlessAccountOwner(caller) === undefined) {
    setCreditsAllowedForAgent(id, (body as { account?: unknown }).account === CREDITS_ACCOUNT_ID);
  }
  return c.json(updated);
}

/**
 * The permission fields a mesh agent PATCH names, which this route refuses: the
 * `permissions` object, and the two retired fields that used to carry the same
 * answer, `enabledToolGroups` and `tierCeiling` (spec `agent-permissions` D13).
 * Refused by name rather than stripped, so a caller still sending one learns
 * where the setting went instead of hearing "done".
 *
 * @param body - The raw request body.
 * @returns The refused field paths, empty when the body names none.
 */
function retiredPermissionFields(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const record = body as Record<string, unknown>;
  return ['permissions', 'enabledToolGroups', 'tierCeiling'].filter((field) =>
    Object.hasOwn(record, field)
  );
}

class AgentPatchChangedError extends Error {}

/** Bind the target and execution settings to the exact manifest bytes the person saw. */
async function agentPatchRevision(
  meshCore: MeshRouterDeps['meshCore'],
  id: string
): Promise<string> {
  const agent = meshCore.get(id);
  if (!agent) return 'missing-agent';
  const home = meshCore.getProjectPath(id);
  let manifest = 'missing-home';
  if (home) {
    try {
      manifest = createHash('sha256')
        .update(await readFile(path.join(home, '.dork', 'agent.json')))
        .digest('hex');
    } catch (error) {
      manifest = 'unreadable:' + ((error as NodeJS.ErrnoException).code ?? 'unknown');
    }
  }
  return createHash('sha256')
    .update(
      JSON.stringify({
        home: home ?? null,
        manifest,
        id: agent.id,
        name: agent.name,
        account: agent.account ?? null,
        runtime: agent.runtime,
        model: agent.model ?? null,
        effort: agent.effort ?? null,
        isSystem: agent.isSystem ?? false,
      })
    )
    .digest('hex');
}
