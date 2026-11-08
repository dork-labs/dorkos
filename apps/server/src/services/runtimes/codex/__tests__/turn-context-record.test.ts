/**
 * Sealed: what the turn-context record holds for a Codex turn is byte-equal to
 * the prompt the transport was handed. No network, no Codex binary, no key.
 *
 * Each render of the agent context carries a fresh value here, the way a real
 * render carries a fresh fence nonce. So a record built by rendering again,
 * rather than by keeping what was sent, cannot match.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { CodexRuntime } from '../codex-runtime.js';
import type { CodexTransport } from '../transport/index.js';
import { CodexThreadMap } from '../thread-map.js';
import { buildCodexPrompt } from '../turn-input.js';
import { buildAgentContextAppend } from '../../shared/agent-context.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
} from '../../../core/agent-identity/__tests__/agent-home-fixture.js';
import { setTurnContextStore } from '../../../session/turn-context/record-turn-context.js';
import { TurnContextStore } from '../../../session/turn-context/turn-context-store.js';

vi.mock('../../shared/policy/managed-config.js', () => ({
  managedConfigHeld: vi.fn(async () => false),
}));
vi.mock('../../../core/config-manager.js', async () => {
  const { USER_CONFIG_DEFAULTS } = await import('@dorkos/shared/config-schema');
  return {
    configManager: { get: (key: keyof typeof USER_CONFIG_DEFAULTS) => USER_CONFIG_DEFAULTS[key] },
  };
});
vi.mock('../check-dependencies.js', () => ({ checkCodexDependencies: vi.fn() }));
vi.mock('../enumerate-mcp-servers.js', () => ({ enumerateCodexMcpServers: vi.fn() }));
vi.mock('../scan-skill-commands.js', () => ({ scanSkillCommands: vi.fn(() => []) }));

const renders = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../shared/agent-context.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../shared/agent-context.js')>();
  return {
    ...original,
    buildAgentContextAppend: vi.fn(async () => {
      renders.count += 1;
      const stable = '<agent_identity>Name: Made-up agent</agent_identity>';
      const memory = `<agent_memory nonce="${renders.count}">Likes tea.</agent_memory>`;
      return { text: `${stable}\n\n${memory}`, stable, memory };
    }),
  };
});

let store: TurnContextStore;
beforeEach(() => {
  registerEveryFolderAsHome();
  renders.count = 0;
  store = new TurnContextStore(createTestDb());
  setTurnContextStore(store);
});
afterEach(() => {
  setTurnContextStore(null);
  clearTestHomes();
});

function fakeTransport(requests: Array<Parameters<CodexTransport['runTurn']>[0]>): CodexTransport {
  return {
    kind: 'app-server',
    capabilities: {},
    async *runTurn(request) {
      requests.push(request);
      request.onThreadBound('thread-made-up', undefined);
      yield { type: 'text_delta', data: { text: 'ok' } };
      yield {
        type: 'session_status',
        data: { sessionId: request.sessionId, terminalReason: 'completed' },
      };
      yield { type: 'done', data: { sessionId: request.sessionId } };
    },
    interrupt: vi.fn(async () => ({ outcome: 'acked' as const, runtime: 'codex' as const })),
    shutdown: vi.fn(async () => {}),
  } as CodexTransport;
}

describe('Codex turn-context record', () => {
  it('records the exact prompt the transport received, and which turn carried the stable half', async () => {
    const requests: Array<Parameters<CodexTransport['runTurn']>[0]> = [];
    const runtime = new CodexRuntime({
      threadMap: new CodexThreadMap(createTestDb()),
      resolveBinary: async () => '/opt/codex',
      transport: fakeTransport(requests),
    });
    runtime.ensureSession('s1', { permissionMode: 'acceptEdits', cwd: '/project' });

    const bag = [
      { kind: 'git_status' as const, scope: 'per-turn' as const, data: { isRepo: false as const } },
    ];
    for await (const _ of runtime.sendMessage('s1', 'first', {
      cwd: '/project',
      additionalContext: bag,
      messageId: 'm-1',
    })) {
      // drain
    }
    for await (const _ of runtime.sendMessage('s1', 'second', { cwd: '/project' })) {
      // drain
    }

    const records = store.listForSession('s1');
    expect(records).toHaveLength(2);
    expect(requests).toHaveLength(2);
    for (const [i, record] of records.entries()) {
      expect(record.parts).toHaveLength(1);
      expect(record.parts[0]!.slot).toBe('prompt');
      expect(record.parts[0]!.redacted).toBe(false);
      // Byte-equal to what the transport was handed.
      expect(record.parts[0]!.body).toBe(requests[i]!.prompt);
    }
    expect(records[0]).toMatchObject({
      runtime: 'codex',
      place: 'chat',
      messageId: 'm-1',
      permissionMode: 'acceptEdits',
      systemSentThisTurn: true,
    });
    expect(records[0]!.parts[0]!.body).toContain('Made-up agent');
    // The thread already holds the stable half, so the second turn sent memory alone.
    expect(records[1]!.systemSentThisTurn).toBe(false);
    expect(records[1]!.parts[0]!.body).not.toContain('Made-up agent');

    // The mutant: rendering the context again for the record gives other bytes
    // than the turn was sent, so a record rebuilt that way fails the check above.
    const again = await buildAgentContextAppend('/project' as never, '/project');
    expect(records[0]!.parts[0]!.body).toContain('nonce="1"');
    expect(buildCodexPrompt('first', { additionalContext: bag }, again.text)).not.toBe(
      records[0]!.parts[0]!.body
    );
    expect(records[0]!.parts[0]!.body).not.toContain(again.memory);
  });
});
