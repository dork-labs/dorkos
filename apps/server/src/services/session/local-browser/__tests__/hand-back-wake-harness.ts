/** A fake model behind the real hand-back launcher, registry, queue and projector. */
import { vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { initBoundary } from '../../../../lib/boundary.js';
import { initConfigManager } from '../../../core/config-manager.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { MessageQueueStore, setMessageQueueStore } from '../../message-queue-store.js';
import { isTurnInFlight, resetMessageDispatcher } from '../../message-dispatcher.js';
import { StagedContextStore, setStagedContextStore } from '../../staged-context-store.js';
import { disposeProjector } from '../../session-state-projector.js';

/** Wire one existing conversation to an isolated folder and a fake runtime. */
export async function handBackWakeHarness(cwd: string, sessionId: string) {
  vi.stubEnv('DORK_HOME', cwd);
  vi.stubEnv('HOME', cwd);
  vi.stubEnv('CLAUDE_CONFIG_DIR', cwd);
  vi.stubEnv('DORKOS_TEST_RUNTIME', 'true');
  await initBoundary(cwd);
  initConfigManager(cwd);
  const db = createTestDb();
  const runtime = new FakeAgentRuntime('hand-back-test');
  runtime.getSessionCwd = () => cwd;
  runtimeRegistry.setDb(db);
  runtimeRegistry.register(runtime);
  runtimeRegistry.setDefault(runtime.type);
  await runtimeRegistry.persistSessionRuntime(sessionId, runtime.type, { kind: 'interactive' });
  setMessageQueueStore(new MessageQueueStore(db));
  setStagedContextStore(new StagedContextStore(db));
  return {
    runtime,
    async dispose() {
      if (runtime.sendMessage.mock.calls.length > 0) {
        await vi.waitFor(() => {
          expectSettled();
        });
      }
      resetMessageDispatcher();
      disposeProjector(sessionId);
      setMessageQueueStore(undefined);
      setStagedContextStore(undefined);
      vi.unstubAllEnvs();
    },
  };

  function expectSettled() {
    if (isTurnInFlight(sessionId, runtime)) throw new Error('Hand-back turn is still running');
  }
}
