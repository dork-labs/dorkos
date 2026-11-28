/**
 * The turn port `session_start` starts its first turn through (T6), for the
 * tests that drive the tool with the dispatcher itself stood in. The run
 * record, admission and the computer face are real, over a test database;
 * since the dispatcher is a double, nothing moves a run by itself, so a turn's
 * settle (the double's `onSettled`) walks its run to its end here, the way the
 * dispatcher's own hook would.
 *
 * @module services/runtimes/claude-code/mcp-tools/__tests__/session-tools-port.fixture
 */
import { createTestDb } from '@dorkos/test-utils/db';
import { dispatchSessionMessage } from '../../../../session/launch/launch-session.js';
import { createComputerTurnPort } from '../../../../session/turn-port/computer-turn-port.js';
import { holdRun, releaseRun } from '../../../../session/turn-port/facts.js';
import {
  getRunRecord,
  handOverTurn,
  installRunRecord,
  turnPort,
  uninstallRunRecord,
  type RunRecord,
} from '../../../../runs/index.js';
import { setSpinOffTurnPort } from '../../../../session/chat-messages/startup/spin-off-startup.js';

/** An agent as the tests' Mesh lists it. */
interface ListedAgent {
  id: string;
  name: string;
  projectPath: string;
}

/**
 * Walk a run to the end its turn settled with: `ok` is a completed turn,
 * `failed` with the runtime's words a refused one, `failed` alone a failed one.
 * A run already over is left alone.
 */
function finishRun(
  record: RunRecord,
  runId: string,
  outcome: 'ok' | 'failed',
  refusal?: string
): void {
  const { store } = record;
  const begun = ['queued', 'starting', 'started', 'running'] as const;
  let run = store.get(runId);
  while (run && run.status !== 'running' && (begun as readonly string[]).includes(run.status)) {
    run = store.move(run, begun[begun.indexOf(run.status as (typeof begun)[number]) + 1]!);
  }
  if (run?.status !== 'running') return;
  store.move(run, 'ended', {
    ending: outcome === 'ok' ? 'completed' : refusal ? 'refused' : 'failed',
    endedAt: store.stamp(),
    ...(refusal ? { endingDetail: { refusal } } : {}),
  });
}

/**
 * Install the run record and this computer's face for one test.
 *
 * @param listed - The agents Mesh lists right now.
 * @returns Take it down again.
 */
export function installSpinOffPort(listed: () => readonly ListedAgent[]): () => void {
  const mesh = {
    getProjectPath: (id: string) => listed().find((agent) => agent.id === id)?.projectPath,
    listWithPaths: () => [...listed()],
  };
  const computer = createComputerTurnPort({
    meshCore: () => mesh as never,
    roomSessionPlace: () => undefined,
    dispatch: async (opts) => {
      // Held, as the dispatcher holds a plan it took, so the worker never hands it over twice.
      if (opts.runId) holdRun(opts.runId);
      const result = await dispatchSessionMessage({
        ...opts,
        onSettled: (outcome, refusal) => {
          const record = getRunRecord();
          if (opts.runId) releaseRun(opts.runId);
          if (record && opts.runId) finishRun(record, opts.runId, outcome, refusal);
        },
      });
      if (opts.runId && ('refused' in result || !result.accepted)) releaseRun(opts.runId);
      return result;
    },
  });
  installRunRecord(createTestDb(), {
    epoch: '01BOOTEPOCHSESSIONTOOLS000',
    computer: () => computer,
    agentHome: () => (id) => mesh.getProjectPath(id),
  });
  setSpinOffTurnPort({ handOver: handOverTurn, port: turnPort });
  return () => {
    setSpinOffTurnPort(undefined);
    uninstallRunRecord();
  };
}
