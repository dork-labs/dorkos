import {
  isOriginalNativeTestModeRuntime,
  readTestModePreparedRoomResponder,
} from '../../../runtimes/test-mode/test-mode-runtime.js';
import { readClaudePreparedRoomResponder } from '../../../runtimes/claude-code/claude-code-runtime.js';
import { readCodexPreparedRoomResponder } from '../../../runtimes/codex/codex-runtime.js';
import { readOpenCodePreparedRoomResponder } from '../../../runtimes/opencode/opencode-runtime.js';
import { agentPause } from '../../../mesh/pause/agent-pause.js';
import type { SseResponse } from '@dorkos/shared/agent-runtime';
import { type Db } from '@dorkos/db';
import type {
  OriginalFrozenRoomSource,
  FrozenRoomSourceData,
  OriginalCommittedRoomResponder,
  PreparedRoomResponder,
} from '../current/current-operation-types.js';
import { readOriginalRoomOperationView } from './room-current-operation.js';

/** Original frozen target is selected privately; neither caller IDs nor a copied key issue source custody. */
export async function prepareResponder(
  operationOwner: object,
  runtime: object,
  holder: SseResponse,
  key: string
): Promise<import('../current/current-operation-types.js').PreparedRoomResponder | undefined> {
  const facet = readOriginalRoomOperationView(operationOwner);
  if (facet.db.$client.inTransaction) throw new Error('Room preparation requires inactive own Db.');
  const pair = [...facet.frozen]
    .filter(
      ([id, token]) =>
        !facet.preparing.has(id) &&
        !facet.preparationUnknown.has(id) &&
        facet.readCurrentFrozenRoomDestination(facet.frozenRoomSources.get(token)!) === key
    )
    .sort((a, b) => {
      const left = facet.frozenRoomSources.get(a[1])!,
        right = facet.frozenRoomSources.get(b[1])!;
      return left.dueAt.localeCompare(right.dueAt) || a[0].localeCompare(b[0]);
    })[0];
  if (!pair) return undefined;
  return facet.prepareFrozenResponder(runtime, holder, key, pair);
}

/** Original private room-operation responsibility; exact constructor identity is required first. */
export async function prepareFrozenResponder(
  operationOwner: object,
  runtime: object,
  holder: SseResponse,
  key: string,
  pair: readonly [string, OriginalFrozenRoomSource]
): Promise<PreparedRoomResponder | undefined> {
  const facet = readOriginalRoomOperationView(operationOwner);
  const [id, token] = pair,
    own = facet.frozenRoomSources.get(token);
  if (
    !own ||
    facet.frozen.get(id) !== token ||
    facet.preparing.has(id) ||
    facet.preparationUnknown.has(id) ||
    facet.db.$client.inTransaction ||
    facet.readCurrentFrozenRoomDestination(own) !== key
  )
    return undefined;
  if (own.engine !== facet.engine || own.db !== facet.db || own.facade !== facet.facade)
    throw new Error('Original frozen Room source is foreign.');
  const paused = agentPause()?.pausedAgentOfTurn({ cwd: own.source.targetAgentPath });
  if (paused) {
    agentPause()?.recordHeld(paused, {
      via: 'turn',
      sessionId: key,
      runtime: own.source.targetRuntime,
    });
    return undefined;
  }
  // Bind facet.originalOwner attempt. Successful preparation consumes the frozen token; thrown setup stays
  // fenced as UNKNOWN. Only a known no-preparation result can choose a new destination later.
  own.effectiveTargetSessionId = key;
  facet.preparing.add(id);
  let prepared: import('../current/current-operation-types.js').PreparedRoomResponder | undefined;
  try {
    prepared = await facet.responder.prepare(runtime, holder, key, token);
    if (!prepared) return undefined;
    const pausedAfterPreparation = agentPause()?.pausedAgentOfTurn({
      cwd: own.source.targetAgentPath,
    });
    if (pausedAfterPreparation) {
      agentPause()?.recordHeld(pausedAfterPreparation, {
        via: 'turn',
        sessionId: key,
        runtime: own.source.targetRuntime,
      });
      await facet.responder.retirePrepared(runtime, prepared);
      prepared = undefined;
      return undefined;
    }
    if (
      facet.frozen.get(id) !== token ||
      facet.frozenRoomSources.get(token) !== own ||
      facet.db.$client.inTransaction
    )
      throw new Error('Prepared Room responder lost its original native/source custody.');
    facet.responder.requirePreparedSource(runtime, prepared, token);
    facet.frozen.delete(id);
    return prepared;
  } catch (cause) {
    facet.preparationUnknown.add(id); // Setup/cleanup uncertainty never becomes automatic retry.
    if (prepared) {
      try {
        await facet.responder.retirePrepared(runtime, prepared);
      } catch {} // Preserve the original cause, including thrown undefined; work stays fenced.
    }
    throw cause;
  } finally {
    if (!prepared && !facet.preparationUnknown.has(id)) own.effectiveTargetSessionId = undefined;
    facet.preparing.delete(id);
  }
}

/** Original private room-operation responsibility; exact constructor identity is required first. */
export function commitResponder(
  operationOwner: object,
  runtime: object,
  prepared: PreparedRoomResponder
): OriginalCommittedRoomResponder {
  const facet = readOriginalRoomOperationView(operationOwner);
  return facet.responder.commitResponder(runtime, prepared);
}

/** Dispatch the same native prepared read; original owner checks remain in the responder. */
export function readOriginalRuntimePreparedResponder(
  runtime: object,
  prepared: PreparedRoomResponder,
  type: FrozenRoomSourceData['source']['targetRuntime']
) {
  return isOriginalNativeTestModeRuntime(runtime)
    ? readTestModePreparedRoomResponder(runtime, prepared)
    : type === 'claude-code'
      ? readClaudePreparedRoomResponder(runtime, prepared)
      : type === 'codex'
        ? readCodexPreparedRoomResponder(runtime, prepared)
        : readOpenCodePreparedRoomResponder(runtime, prepared);
}
