import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { MeshCore } from '@dorkos/mesh';
const configure = vi.hoisted(() => vi.fn());
vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    computerRuntimeForAgentPath: () => undefined,
    configureComputerAgentBinding: configure,
  },
}));
import { configureComputerMesh, createComputerAgentIdentity } from '../computer-agent.js';
let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  configure.mockClear();
});
it('hydrates retained placement without creating an agent until explicit setup', async () => {
  root = await mkdtemp(join(tmpdir(), 'computer-agent-'));
  const anchor = join(root, 'workspace');
  const register = vi.fn().mockResolvedValue({ id: 'agent-one', runtime: 'opencode' });
  configureComputerMesh({ registerByPath: register } as unknown as MeshCore);
  const seed = await createComputerAgentIdentity(root, anchor);
  expect(register).not.toHaveBeenCalled();
  expect(await seed()).toBe('agent-one');
  expect(JSON.parse(await readFile(join(root, 'agent.json'), 'utf8'))).toEqual({
    id: 'agent-one',
    anchor,
  });
  configure.mockClear();
  register.mockClear();
  await createComputerAgentIdentity(root, anchor);
  expect(configure).toHaveBeenCalledWith('agent-one', anchor);
  expect(register).not.toHaveBeenCalled();
});
it('refuses an adopted foreign harness identity', async () => {
  root = await mkdtemp(join(tmpdir(), 'computer-agent-'));
  configureComputerMesh({
    registerByPath: vi.fn().mockResolvedValue({ id: 'foreign', runtime: 'codex' }),
  } as unknown as MeshCore);
  const seed = await createComputerAgentIdentity(root, join(root, 'workspace'));
  await expect(seed()).rejects.toThrow('COMPUTER_AGENT_IDENTITY_REFUSED');
  expect(configure).not.toHaveBeenCalled();
});
