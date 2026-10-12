import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import {
  ComputerAgentBinding,
  resolveRegisteredAgentRuntime,
} from '../../../../computers/agent-binding.js';
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
describe('server-owned computer agent placement', () => {
  it('keeps harness identity while resolving exact id/path to the computer without fallback', () => {
    const path = realpathSync(mkdtempSync(join(tmpdir(), 'computer-agent-')));
    homes.push(path);
    const binding = new ComputerAgentBinding();
    binding.configure('agent-one', path);
    expect(binding.forPath(path)).toBe('computer-local');
    expect(binding.forPath(`${path}/foreign`)).toBeUndefined();
    const host = { type: 'opencode' } as AgentRuntime;
    const computer = { type: 'computer-local' } as AgentRuntime;
    const runtimes = new Map([
      ['opencode', host],
      ['computer-local', computer],
    ]);
    const mesh = { getAgent: () => ({ runtime: 'opencode' }) };
    expect(resolveRegisteredAgentRuntime('agent-one', mesh, runtimes, () => host, binding)).toBe(
      computer
    );
    expect(resolveRegisteredAgentRuntime('host-agent', mesh, runtimes, () => host, binding)).toBe(
      host
    );
    runtimes.delete('computer-local');
    expect(() =>
      resolveRegisteredAgentRuntime('agent-one', mesh, runtimes, () => host, binding)
    ).toThrow('UNAVAILABLE');
    expect(binding.forPath(path)).toBe('computer-local');
  });
  it('refuses replacing placement with another id or directory', () => {
    const path = realpathSync(mkdtempSync(join(tmpdir(), 'computer-agent-')));
    homes.push(path);
    const binding = new ComputerAgentBinding();
    binding.configure('agent-one', path);
    expect(() => binding.configure('agent-two', path)).toThrow('BINDING_REFUSED');
    expect(() => binding.configure('agent-one', '/foreign')).toThrow('BINDING_REFUSED');
    binding.configure('agent-one', path);
  });
});
