/**
 * An MCP server write moves the agent's folder settings pin only when a person
 * is behind THAT call: a card they answered, or a caller proven to be one. A
 * standing Allowed permission or a waited-out hold is not a person (DOR-3068).
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const repin = vi.hoisted(() => vi.fn());
vi.mock('../../runtimes/claude-code/folder-settings/folder-config-consent.js', () => ({
  withPersonRepin: (target: unknown, part: unknown, _reason: unknown, write: () => unknown) => {
    repin(target, part);
    return write();
  },
}));

import { personRepin } from '../mcp-capability-deps.js';
import type { CapabilityDeps, CapabilityHandlerContext } from '../../core/capabilities/index.js';

const deps = {
  mcpDeps: {
    service: {},
    agents: { get: (id: string) => (id === 'a1' ? { projectPath: '/homes/a1' } : undefined) },
  },
} as unknown as CapabilityDeps;

const write = vi.fn(async () => 'written');

beforeEach(() => {
  repin.mockClear();
  write.mockClear();
});

describe('personRepin', () => {
  it('moves the pin for a card a person answered for this call', async () => {
    const context = { approval: { via: 'approval', approvalId: 'x' } } as CapabilityHandlerContext;
    await expect(personRepin(deps, 'a1', context, write)).resolves.toBe('written');
    expect(repin).toHaveBeenCalledWith({ agentId: 'a1', home: '/homes/a1' }, 'manifest');
  });

  it.each([
    ['a standing Allowed permission', { approval: { via: 'permission', source: 'default' } }],
    ['a waited-out hold', { approval: { via: 'hold', holdId: 'h', authorityBindingDigest: 'd' } }],
    ['no approval at all', {}],
  ])('leaves the pin alone for %s', async (_label, context) => {
    await expect(
      personRepin(deps, 'a1', context as unknown as CapabilityHandlerContext, write)
    ).resolves.toBe('written');
    expect(repin).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('still writes when the registry can not name the home', async () => {
    const context = { approval: { via: 'approval', approvalId: 'x' } } as CapabilityHandlerContext;
    await expect(personRepin(deps, 'unknown', context, write)).resolves.toBe('written');
    expect(repin).not.toHaveBeenCalled();
  });
});
