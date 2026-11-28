/**
 * A real turn port under the relay, for tests of relay turns (spec
 * `turns-survive-restarts` T13): the run record, its outbox's worker, the
 * computer face over the real launch path, dispatcher and projector, on SQLite.
 * Only the runtimes are doubles, registered in `runtimeRegistry` by the test,
 * since the dispatcher resolves a turn's runtime there.
 *
 * An agent is a registered home whose manifest names its Mesh id, the way boot
 * sees one: the relay names a turn's agent by that id, and the computer face
 * finds its home again through the stand-in Mesh here.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '@dorkos/db';
import type { MeshCore } from '@dorkos/mesh';
import { createTestDb } from '@dorkos/test-utils/db';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../core/agent-identity/__tests__/agent-home-fixture.js';
import { resetMessageDispatcher } from '../../session/message-dispatcher.js';
import { MessageQueueStore, setMessageQueueStore } from '../../session/message-queue-store.js';
import { createComputerTurnPort } from '../../session/turn-port/computer-turn-port.js';
import {
  getRunRecord,
  installRunRecord,
  turnPort,
  uninstallRunRecord,
  type TurnRun,
} from '../../runs/index.js';
import { setRelayTurnPort } from '../relay-turns/port-runtime.js';
import { initBoundary } from '../../../lib/boundary.js';
import { registerClaudeCodeFacts } from '../../../startup/register-claude-code-facts.js';

// The boot's own registration, so a launch can read the agent facts it needs.
registerClaudeCodeFacts();

/** The port a relay test runs over. */
export interface RelayPort {
  /** The machine store the record and the registry share. */
  db: Db;
  /**
   * Stand an agent at a folder: write its manifest and register its home and Mesh id.
   *
   * @param home - The agent's home, absolute.
   * @param id - Its Mesh id.
   */
  standAgent: (home: string, id: string) => void;
  /** Every run of a chat, by any id it answers to, oldest first. */
  runsOf: (sessionId: string) => TurnRun[];
}

/**
 * Install the port. Call {@link uninstallRelayPort} after each test.
 *
 * @param opts.boundary - The boundary folder; `/` unless a test needs its own.
 */
export async function installRelayPort(opts: { boundary?: string } = {}): Promise<RelayPort> {
  const db = createTestDb();
  runtimeRegistry.setDb(db);
  await initBoundary(opts.boundary ?? '/');
  setMessageQueueStore(new MessageQueueStore(db));
  const { homes } = registerTestHomes([]);
  const agents = new Map<string, string>();
  const meshCore = {
    getProjectPath: (id: string) => agents.get(id),
    listWithPaths: () => [...agents].map(([id, projectPath]) => ({ id, projectPath })),
  } as unknown as Pick<MeshCore, 'getProjectPath' | 'listWithPaths'>;
  const computer = createComputerTurnPort({
    meshCore: () => meshCore,
    roomSessionPlace: () => undefined,
  });
  installRunRecord(db, {
    epoch: '01BOOTEPOCHRELAYPORT000000',
    computer: () => computer,
    agentHome: () => (id) => agents.get(id),
    admission: { admission: { pausedAgent: () => undefined, machineFull: () => false } },
  });
  getRunRecord()!.worker.start();
  setRelayTurnPort(turnPort);
  const store = () => getRunRecord()!.store;
  return {
    db,
    standAgent(home, id) {
      fs.mkdirSync(path.join(home, '.dork'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.dork', 'agent.json'),
        JSON.stringify({
          id,
          name: 'Ana',
          runtime: 'claude-code',
          registeredAt: '2026-11-01T10:00:00.000Z',
          registeredBy: 'test',
        })
      );
      homes.add(path.resolve(home));
      agents.set(id, home);
    },
    runsOf: (sessionId) => store().listForChat(sessionId),
  };
}

/** Take the port down again. */
export function uninstallRelayPort(): void {
  setRelayTurnPort(() => undefined);
  uninstallRunRecord();
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  clearTestHomes();
}
