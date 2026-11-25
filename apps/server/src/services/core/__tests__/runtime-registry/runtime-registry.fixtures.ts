/**
 * Shared fixtures for the runtime registry tests in this folder and
 * `../runtime-registry.test.ts`.
 */
import type { AgentRuntime, RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { sessionMetadata, eq, type Db } from '@dorkos/db';
import type { TurnOrigin } from '../../../session/index.js';

/** A minimal runtime of `type` that declares one `default` mode unless `overrides` say otherwise. */
export function createMockRuntime(
  type: string,
  overrides?: Partial<RuntimeCapabilities>
): AgentRuntime {
  return {
    type,
    ensureSession: () => {},
    hasSession: () => false,
    updateSession: () => ({ updated: true }),
    sendMessage: async function* () {},
    approveTool: () => true,
    submitAnswers: () => true,
    listSessions: async () => [],
    getSession: async () => null,
    getMessageHistory: async () => [],
    getSessionTasks: async () => [],
    getSessionETag: async () => null,
    readFromOffset: async () => ({ content: '', newOffset: 0 }),
    acquireLock: () => true,
    releaseLock: () => {},
    isLocked: () => false,
    getLockInfo: () => null,
    getSupportedModels: async () => [],
    getCapabilities: () => ({
      type,
      supportsToolApproval: true,
      supportsCostTracking: true,
      supportsResume: true,
      supportsMcp: true,
      supportsQuestionPrompt: true,
      supportsPlugins: true,
      permissionModes: {
        supported: true,
        values: [
          {
            id: 'default',
            label: 'Default',
            stop: 'ask',
            asks: 'always',
            reach: 'edit',
            promise: 'Asks first.',
          },
        ],
      },
      features: {},
      // A mock runtime declares nothing configurable unless a test says otherwise.
      settings: { configSection: null, supportsEffort: true, sections: [] },
      ...overrides,
    }),
    getCommands: async () => ({ commands: [], lastScanned: new Date().toISOString() }),
    checkSessionHealth: () => {},
    getInternalSessionId: () => undefined,
  } as unknown as AgentRuntime;
}

/** The `session_metadata` row for `id`, if any. */
export function rowOf(db: Db, id: string): typeof sessionMetadata.$inferSelect | undefined {
  return db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, id)).get();
}

/**
 * The origin for a case that is not about power at all.
 *
 * Most of this file is about binding, claiming, agent paths and the
 * model/effort seed, and which surface started the session changes none of
 * them. They still have to name one, because the argument is required, so they
 * name the ordinary one: a person at the app. The cases that ARE about power
 * name their origin inline, right where the reader needs to see it.
 */
export const A_PERSON: TurnOrigin = { kind: 'interactive' };
