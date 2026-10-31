/**
 * Every launch keeps its file tools out of the mini apps OTHER agents made,
 * and never out of its own (DOR-3068).
 *
 * @module services/runtimes/claude-code/folder-settings/__tests__/agent-extensions-deny
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  applyOtherAgentsExtensionsDeny,
  otherAgentHomesOf,
  otherAgentsExtensionsDenyRules,
  ownExtensionsWritable,
} from '../agent-extensions-deny.js';

let tmp: string;
let dorkHome: string;
let own: string;
let other: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-ext-deny-')));
  dorkHome = path.join(tmp, 'dork');
  own = path.join(tmp, 'agents', 'own');
  other = path.join(tmp, 'agents', 'other');
  for (const home of [own, other]) {
    await fs.mkdir(path.join(home, '.dork', 'extensions'), { recursive: true });
  }
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

describe('otherAgentsExtensionsDenyRules', () => {
  it('denies every write tool another agent’s extensions, anchored absolute', () => {
    const rules = otherAgentsExtensionsDenyRules(own, [own, other], dorkHome);
    for (const tool of TOOLS) {
      expect(rules).toContain(`${tool}(/${other}/.dork/extensions/**)`);
    }
    expect(rules.every((rule) => /\(\/\//.test(rule))).toBe(true);
  });

  it('never denies the launching agent its own extensions', () => {
    const rules = otherAgentsExtensionsDenyRules(own, [own, other], dorkHome);
    expect(rules.some((rule) => rule.includes(`${own}/.dork/extensions`))).toBe(false);
  });

  it('names a symlinked home by its real path too', async () => {
    const link = path.join(tmp, 'link-to-other');
    await fs.symlink(other, link);
    const rules = otherAgentsExtensionsDenyRules(own, [own, link], dorkHome);
    expect(rules).toContain(`Edit(/${link}/.dork/extensions/**)`);
    expect(rules).toContain(`Edit(/${other}/.dork/extensions/**)`);
  });

  it('treats an own home named through a link as its own', async () => {
    const link = path.join(tmp, 'link-to-own');
    await fs.symlink(own, link);
    expect(otherAgentsExtensionsDenyRules(link, [own, other], dorkHome)).not.toContainEqual(
      expect.stringContaining(`${own}/.dork/extensions`)
    );
  });

  it('denies every agent’s extensions to a turn that runs as no agent', () => {
    const rules = otherAgentsExtensionsDenyRules(undefined, [own, other], dorkHome);
    expect(rules).toContain(`Write(/${own}/.dork/extensions/**)`);
    expect(rules).toContain(`Write(/${other}/.dork/extensions/**)`);
  });

  it('never denies the global extensions folder, even for an agent whose home holds it', () => {
    const homeHoldingGlobal = path.dirname(dorkHome);
    const globalDorkHome = path.join(homeHoldingGlobal, '.dork');
    const rules = otherAgentsExtensionsDenyRules(own, [homeHoldingGlobal], globalDorkHome);
    expect(rules).toEqual([]);
  });
});

describe('applyOtherAgentsExtensionsDeny', () => {
  it('adds the rules beside the deny rules already in the launch', () => {
    const options = {
      settings: { fastMode: true, permissions: { deny: ['Read(//secret/**)'] } },
    } as unknown as Options;
    applyOtherAgentsExtensionsDeny(options, own, [own, other], dorkHome);
    const settings = options.settings as { fastMode: boolean; permissions: { deny: string[] } };
    expect(settings.fastMode).toBe(true);
    expect(settings.permissions.deny[0]).toBe('Read(//secret/**)');
    expect(settings.permissions.deny).toContain(`MultiEdit(/${other}/.dork/extensions/**)`);
  });

  it('leaves the launch untouched when there is no other agent', () => {
    const options = {} as Options;
    applyOtherAgentsExtensionsDeny(options, own, [own], dorkHome);
    expect(options.settings).toBeUndefined();
  });
});

describe('otherAgentHomesOf', () => {
  it('reads every agent home the registry lists', () => {
    const registry = {
      listWithPaths: () => [
        { id: 'a', name: 'a', projectPath: '/x/a' },
        { id: 'b', name: 'b', projectPath: '/x/b' },
      ],
    };
    expect(otherAgentHomesOf(registry)).toEqual(['/x/a', '/x/b']);
  });

  it('adds every author folder an approval records, registered or not (DOR-3068)', () => {
    const registry = { listWithPaths: () => [{ id: 'a', name: 'a', projectPath: '/x/a' }] };
    const approvals = {
      approvedSources: {
        notes: { path: '/x/gone/.dork/extensions/notes', authorHome: '/x/gone' },
        flow: { path: '/x/flow', digest: 'sha256:1' },
        mine: { path: '/x/a/.dork/extensions/mine', authorHome: '/x/a' },
      },
    };
    expect(otherAgentHomesOf(registry, approvals)).toEqual(['/x/a', '/x/gone']);
    expect(otherAgentHomesOf(undefined, approvals)).toEqual(['/x/gone', '/x/a']);
  });

  it('names none for a missing registry or one that cannot list', () => {
    expect(otherAgentHomesOf(undefined)).toEqual([]);
    expect(otherAgentHomesOf(null)).toEqual([]);
    expect(otherAgentHomesOf({})).toEqual([]);
  });
});

describe('ownExtensionsWritable', () => {
  it('leaves a turn with no ceiling its own mini apps', () => {
    expect(ownExtensionsWritable({}, '/x/own')).toBe('/x/own');
  });

  it('leaves none to a turn that runs as no agent', () => {
    expect(ownExtensionsWritable({}, undefined)).toBeUndefined();
  });

  it('denies its own mini apps to a turn under a ceiling, or background work under one', () => {
    expect(
      ownExtensionsWritable({ turnPermissionCeiling: 'runtime-default' as never }, '/x/own')
    ).toBeUndefined();
    expect(
      ownExtensionsWritable({ backgroundPermissionCeiling: 'runtime-default' as never }, '/x/own')
    ).toBeUndefined();
    // So the launch denies them like every other agent's.
    const rules = otherAgentsExtensionsDenyRules(
      ownExtensionsWritable({ turnPermissionCeiling: 'runtime-default' as never }, own),
      [own, other],
      dorkHome
    );
    expect(rules).toContain(`Edit(/${own}/.dork/extensions/**)`);
  });
});
