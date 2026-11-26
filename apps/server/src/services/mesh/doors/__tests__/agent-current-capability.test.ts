/**
 * `agent.current` (`GET /api/agents/current`, DOR-4978): who reads what. A
 * person and the agent itself read the whole agent, its own folder through a
 * symlink included; another agent reads no instructions. `routes/__tests__/agents.test.ts` pins the path's answers.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import { composeRegistry } from '../../../core/capabilities/index.js';
import type { AgentIdentity } from '../../../core/agent-identity/agent-identity-service.js';
import { agentCurrentCapability } from '../agent-current-capability.js';

let home: string;
let foundAt: string;

const registry = () =>
  composeRegistry([{ name: 'agent', capabilities: [agentCurrentCapability] }], {
    logger: noopLogger,
    agentHomeDeps: {
      agentAt: async () => ({
        home: foundAt,
        manifest: { id: 'ana', name: 'ana', persona: 'Secret', registeredBy: 'x' },
      }),
    },
  });

const asAgent = (agentPath: string) => ({
  identity: {
    agentPath,
    displayName: 'Bo',
    createdAt: '2026-11-01T00:00:00.000Z',
  } as AgentIdentity,
});

const read = (context?: object) =>
  registry().invoke('agent.current', { path: foundAt }, context) as Promise<
    Record<string, unknown>
  >;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-agent-current-'));
  foundAt = home;
  fs.mkdirSync(path.join(home, '.dork'));
  fs.writeFileSync(path.join(home, '.dork', 'SOUL.md'), 'Ana’s soul');
});
afterEach(() => {
  fs.rmSync(`${home}-link`, { force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('agent.current', () => {
  it('gives a person and the agent itself the whole agent', async () => {
    for (const context of [undefined, asAgent(home)]) {
      expect(await read(context)).toMatchObject({ persona: 'Secret', soulContent: 'Ana’s soul' });
    }
  });

  it('knows the agent itself through a symlinked spelling of its folder', async () => {
    fs.symlinkSync(home, `${home}-link`);
    foundAt = `${home}-link`;
    expect(await read(asAgent(fs.realpathSync(home)))).toMatchObject({ soulContent: 'Ana’s soul' });
  });

  it('leaves another agent’s instructions out, an unverified one’s too', async () => {
    const other = await read(asAgent('/agents/bo'));
    expect(other.name).toBe('ana');
    for (const field of ['persona', 'soulContent', 'nopeContent', 'memoryContent']) {
      expect(other).not.toHaveProperty(field);
    }
    expect(await read({ agentIdentityPresented: true })).not.toHaveProperty('persona');
  });
});
