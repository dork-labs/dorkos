/**
 * Registering runtimes and choosing the default one. Needs no session store and
 * no defaults resolver, unlike `../runtime-registry.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  RuntimeRegistry,
  applyConfiguredDefaultRuntime,
  applyAndWatchConfiguredDefaultRuntime,
  registerOptionalRuntime,
} from '../../runtime-registry.js';
import { logger } from '../../../../lib/logger.js';
import { createMockRuntime } from './runtime-registry.fixtures.js';

describe('RuntimeRegistry registration', () => {
  let registry: RuntimeRegistry;

  beforeEach(() => {
    registry = new RuntimeRegistry();
  });

  describe('register and get', () => {
    // Spec `audit-trail` PR3: the one seam every turn passes through records
    // every tool call, so a runtime registered here cannot run a tool unseen.
    it('wraps a registered runtime so its tool calls reach the audit log', async () => {
      const { initAuditTrail, resetAuditTrail } = await import('../../../audit/audit-trail.js');
      const { AuditLog } = await import('../../../audit/audit-log.js');
      const { AccountIds } = await import('../../../audit/account-ids.js');
      const { auditEvents } = await import('@dorkos/db');
      const db = createTestDb();
      initAuditTrail({
        log: new AuditLog(db),
        accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
      });
      try {
        registry.register({
          ...createMockRuntime('claude-code'),
          sendMessage: async function* () {
            yield {
              type: 'tool_call_start',
              data: {
                toolCallId: 't1',
                toolName: 'Bash',
                input: '{"command":"ls"}',
                status: 'running',
              },
            };
            yield {
              type: 'tool_result',
              data: { toolCallId: 't1', toolName: 'Bash', status: 'complete' },
            };
          },
        } as AgentRuntime);
        for await (const _event of registry.get('claude-code').sendMessage('s1', 'go', {})) {
          // drain
        }
        expect(
          db
            .select()
            .from(auditEvents)
            .all()
            .map((row) => [row.action, row.targetId])
        ).toEqual([['runtime.tool_used', 'ls']]);
      } finally {
        resetAuditTrail();
      }
    });

    // Spec `audit-trail` PR5: the backstop. A turn for a paused agent is
    // refused at the one seam every turn passes, whatever surface started it.
    it('refuses a paused agent’s turn sent straight through the registry', async () => {
      const { AgentPauseService, initAgentPause, resetAgentPause } =
        await import('../../../mesh/pause/agent-pause.js');
      const { setAgentHomeRegistry } = await import('../../agent-identity/agent-home.js');
      const { agents } = await import('@dorkos/db');
      const db = createTestDb();
      const now = new Date().toISOString();
      db.insert(agents)
        .values({
          id: 'agent-1',
          name: 'scout',
          runtime: 'claude-code',
          projectPath: '/projects/scout',
          registeredAt: now,
          updatedAt: now,
        })
        .run();
      setAgentHomeRegistry({
        isRegisteredHome: (dir) => dir === '/projects/scout',
        listRegisteredHomes: () => ['/projects/scout'],
        managedWorkspaceOwner: () => null,
        roomsDir: null,
      });
      const pauses = new AgentPauseService({ db });
      initAgentPause(pauses);
      try {
        await pauses.pause('agent-1', { accountId: 'p', kind: 'person', name: 'Owner' });
        const sent = vi.fn();
        registry.register({
          ...createMockRuntime('claude-code'),
          sendMessage: async function* () {
            sent();
          },
        } as AgentRuntime);
        const turn = registry
          .get('claude-code')
          .sendMessage('s1', 'go', { cwd: '/projects/scout' });
        await expect(turn.next()).rejects.toMatchObject({ code: 'AGENT_PAUSED' });
        expect(sent).not.toHaveBeenCalled();
      } finally {
        resetAgentPause();
        setAgentHomeRegistry(undefined);
      }
    });
  });

  describe('resolveForAgent', () => {
    it('returns agent-specific runtime when meshCore provides it', () => {
      const cc = createMockRuntime('claude-code');
      const oc = createMockRuntime('opencode');
      registry.register(cc);
      registry.register(oc);
      const meshCore = { getAgent: () => ({ runtime: 'opencode' }) };
      expect(registry.resolveForAgent('agent-1', meshCore).type).toBe('opencode');
    });

    it.each([
      ['the agent has no runtime field', { getAgent: () => ({}) }],
      ['the agent runtime type is not registered', { getAgent: () => ({ runtime: 'aider' }) }],
    ] as const)('falls back to the default when %s', (_case, meshCore) => {
      registry.register(createMockRuntime('claude-code'));
      expect(registry.resolveForAgent('agent-1', meshCore).type).toBe('claude-code');
    });
  });

  describe('applyConfiguredDefaultRuntime', () => {
    it('keeps the host default when the configured runtime is placement-only', () => {
      registry.register(createMockRuntime('claude-code'));
      registry.register(createMockRuntime('computer-local'));
      expect(applyConfiguredDefaultRuntime(registry, 'computer-local')).toBe(false);
      expect(registry.getDefaultType()).toBe('claude-code');
      expect(() => registry.setDefault('computer-local')).toThrow('placement-only');
    });

    it('keeps the built-in default and reports failure when the configured runtime is unregistered', () => {
      registry.register(createMockRuntime('claude-code'));

      const applied = applyConfiguredDefaultRuntime(registry, 'opencode');

      expect(applied).toBe(false);
      expect(registry.getDefaultType()).toBe('claude-code');
    });
  });

  describe('applyAndWatchConfiguredDefaultRuntime', () => {
    /** A settings source under this test's control, with one live listener. */
    function source(initial: string) {
      const state = { value: initial, listeners: [] as ((c: { sections: string[] }) => void)[] };
      return {
        state,
        read: () => state.value,
        onChange: (listener: (c: { sections: readonly string[] }) => void) => {
          state.listeners.push(listener as (c: { sections: string[] }) => void);
          return () => {
            state.listeners = state.listeners.filter((l) => l !== listener);
          };
        },
        write: (value: string, sections = ['runtimes']) => {
          state.value = value;
          for (const listener of state.listeners) listener({ sections });
        },
      };
    }

    it('re-applies it when the setting changes, with no restart', () => {
      // The reason the change-subscription primitive exists: the default runtime is APPLIED once,
      // so without this a person changes it in Settings, the screen agrees, and nothing happens
      // until they restart.
      registry.register(createMockRuntime('claude-code'));
      registry.register(createMockRuntime('codex'));
      const config = source('claude-code');
      applyAndWatchConfiguredDefaultRuntime(registry, config);

      config.write('codex');

      expect(registry.getDefaultType()).toBe('codex');
    });
  });

  describe('registerOptionalRuntime', () => {
    // Codex/OpenCode throw at construction when their CLI is missing (the packaged desktop app).

    it('registers unaffected runtimes when a sibling runtime fails to construct', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
      const claudeCode = createMockRuntime('claude-code');
      registry.register(claudeCode);

      // Codex fails to construct (missing CLI)...
      const codexResult = registerOptionalRuntime('CodexRuntime', 'install the Codex CLI', () => {
        throw new Error('Unable to locate Codex CLI binaries');
      });

      // ...but OpenCode, registered right after, still succeeds — one
      // runtime's init failure never takes the others down with it.
      const openCode = createMockRuntime('opencode');
      const openCodeResult = registerOptionalRuntime(
        'OpenCodeRuntime',
        'install the OpenCode CLI',
        () => {
          registry.register(openCode);
          return openCode;
        }
      );

      expect(codexResult).toBeUndefined();
      expect(openCodeResult).toBe(openCode);
      expect(registry.has('claude-code')).toBe(true);
      expect(registry.has('codex')).toBe(false);
      expect(registry.has('opencode')).toBe(true);

      warn.mockRestore();
    });
  });
});
