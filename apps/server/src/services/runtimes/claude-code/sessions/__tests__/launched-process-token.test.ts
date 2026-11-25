/**
 * A persistent Claude Code process's identity token names its chat until THAT
 * process exits (DOR-5264), never until another process of the chat does: a
 * restart boots the new process before the old one's exit lands, and the old
 * exit must leave the new token's chat alone. Real child processes, a real
 * identity service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Options, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
  type AgentIdentityService,
} from '../../../../core/agent-identity/agent-identity-service.js';
import { startLaunchedProcess } from '../pump-launch.js';
import { createTrackedSpawn } from '../tracked-spawn.js';
import { WarmProcessLedger } from '../warm-process-ledger.js';

const CHAT = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';

let dorkHome: string;
let identities: AgentIdentityService;
const children: SpawnedProcess[] = [];

beforeEach(() => {
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'launched-token-'));
  identities = initAgentIdentityService(createTestDb());
});

afterEach(() => {
  // Only ever the children this test started, only ever through their own handles.
  for (const child of children.splice(0))
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  resetAgentIdentityService();
  fs.rmSync(dorkHome, { recursive: true, force: true });
});

/** Boot a long-lived child the way the pump does, holding `token`. */
function boot(token: string): SpawnedProcess {
  const options = { env: { DORKOS_AGENT_TOKEN: token } } as unknown as Options;
  const child = createTrackedSpawn(new WarmProcessLedger(dorkHome), () =>
    startLaunchedProcess(options)
  )({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 30000)'],
    cwd: dorkHome,
    env: { ...process.env },
    signal: new AbortController().signal,
  });
  children.push(child);
  return child;
}

const mint = () => identities.mint({ agentPath: '/agents/ana', displayName: 'Ana', chatId: CHAT });

describe('a launched process and the chat its token names', () => {
  it('an old process exiting after its replacement booted forgets only its own token', async () => {
    const oldToken = await mint();
    const old = boot(oldToken);
    const newToken = await mint();
    boot(newToken);

    old.kill('SIGKILL');
    await vi.waitFor(async () =>
      expect((await identities.resolve(oldToken))?.chatId).toBeUndefined()
    );
    expect((await identities.resolve(newToken))?.chatId).toBe(CHAT);
  });
});
