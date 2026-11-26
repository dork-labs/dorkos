/**
 * The process token port's composition (DOR-5264): until startup wires it, a
 * process a runtime reports names no chat (fail closed); once wired, agent
 * identity's map answers for it, and an end it never heard of changes nothing.
 * Both boot paths call the wiring: the server's core stores and the harness.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
  type AgentIdentityService,
} from '../../../services/core/agent-identity/agent-identity-service.js';
import {
  processEnded,
  processStarted,
  setProcessTokenPort,
} from '../../../services/runtimes/shared/references/process-token-port.js';
import { wireProcessTokenPort } from '../work-graph.js';

const CHAT = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';
let identities: AgentIdentityService;

beforeEach(() => {
  identities = initAgentIdentityService(createTestDb());
});

afterEach(() => {
  setProcessTokenPort(undefined);
  resetAgentIdentityService();
});

const envOf = (token: string) => ({ DORKOS_AGENT_TOKEN: token });
const mint = () => identities.mint({ agentPath: '/agents/ana', displayName: 'Ana' });

describe('the process token port at startup', () => {
  it('names no chat for a process reported before it is wired', async () => {
    const token = await mint();
    processStarted(envOf(token), CHAT);
    expect((await identities.resolve(token))?.chatId).toBeUndefined();
  });

  it('once wired, names the chat while the process runs, and not after', async () => {
    wireProcessTokenPort();
    const token = await mint();
    processStarted(envOf(token), CHAT);
    expect((await identities.resolve(token))?.chatId).toBe(CHAT);
    processEnded(envOf('a-token-nobody-minted'));
    processEnded(undefined);
    expect((await identities.resolve(token))?.chatId).toBe(CHAT);
    processEnded(envOf(token));
    expect((await identities.resolve(token))?.chatId).toBeUndefined();
  });

  it('is wired by both boot paths, right after agent identity', () => {
    for (const file of ['../core-stores.ts', '../../../harness-boot.ts']) {
      const source = fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');
      expect(source, file).toMatch(
        /initAgentIdentityService\(db\);\n(\s*\/\/.*\n)?\s*wireProcessTokenPort\(\);/
      );
    }
  });
});
