/**
 * Every agent home's self-grant files stay denied at every level, Full included (DOR-3483,
 * Security's first Must): one agent can't change another's. An agent whose own folder is open
 * (a person set it to Full, the turn is unmarked) is the one home left out, and each other home
 * is then named on its own. DorkOS's own `config.json` stays denied at every level (DOR-3068).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Options, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import {
  agentHomesSelfGrantRules,
  applyPersonOnlyDataDeny,
  otherAgentHomesSelfGrantRules,
  personOnlyFileRules,
} from '../directory-grants.js';
import { setMarkedFullActivity } from '../../../../core/turn-power/full-autonomy.js';
import { selfGrantDenyRules } from '../../folder-settings/apply-folder-allows.js';

let dorkHome: string;
let scout: string;
let other: string;

function denyAt(mode: PermissionMode, ownFolderOpen = false): string[] {
  const options: Options = { permissionMode: mode };
  applyPersonOnlyDataDeny(options, dorkHome, {
    sessionId: 'chat-a',
    agentPath: scout,
    ownFolderOpen,
  });
  return (options.settings as { permissions: { deny: string[] } }).permissions.deny;
}

describe('the agent-home rules on a launch', () => {
  const emit = vi.fn(async () => {});
  beforeEach(() => {
    dorkHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-rules-')));
    scout = path.join(dorkHome, 'agents', 'scout');
    other = path.join(dorkHome, 'agents', 'other');
    for (const dir of [scout, other]) fs.mkdirSync(dir, { recursive: true });
    emit.mockClear();
    setMarkedFullActivity({ emit });
  });
  afterEach(() => {
    setMarkedFullActivity(undefined);
    fs.rmSync(dorkHome, { recursive: true, force: true });
  });

  it.each<PermissionMode>(['default', 'acceptEdits', 'bypassPermissions'])(
    'carries them at %s, quietly',
    (mode) => {
      expect(denyAt(mode)).toEqual(
        expect.arrayContaining(agentHomesSelfGrantRules(dorkHome, 'launch'))
      );
      expect(emit).not.toHaveBeenCalled();
    }
  );

  it('keeps config.json denied at Full', () => {
    expect(denyAt('bypassPermissions')).toEqual(
      expect.arrayContaining(personOnlyFileRules(dorkHome))
    );
  });

  it("leaves the open home out, and names every other home's files on its own", () => {
    const rules = denyAt('bypassPermissions', true);
    for (const rule of agentHomesSelfGrantRules(dorkHome, 'launch')) {
      expect(rules).not.toContain(rule);
    }
    expect(rules).toContain(`Write(/${other}/.claude/settings.json)`);
    expect(rules).toContain(`Edit(/${other}/.dork/agent.json)`);
    expect(rules).toContain(`Write(/${other}/.agents/**)`);
    expect(rules.some((rule) => rule.includes(`${scout}/`))).toBe(false);
    expect(rules).toEqual(expect.arrayContaining(personOnlyFileRules(dorkHome)));
  });

  it('keeps the one rule, and so the open home closed, when another home cannot be named', () => {
    fs.mkdirSync(path.join(dorkHome, 'agents', 'odd?name'));
    expect(otherAgentHomesSelfGrantRules(dorkHome, scout, 'launch')).toBeUndefined();
    expect(denyAt('bypassPermissions', true)).toEqual(
      expect.arrayContaining(agentHomesSelfGrantRules(dorkHome, 'launch'))
    );
  });

  it('beside an approved allow list, opens the own setup but never its agent.json', () => {
    const accountRoot = path.join(dorkHome, 'account');
    const closed = selfGrantDenyRules({ home: scout, dorkHome, accountRoot }) ?? [];
    const open = selfGrantDenyRules({ home: scout, dorkHome, accountRoot, ownFolderOpen: true });
    expect(closed).toContain(`Write(/${scout}/.claude/**)`);
    expect(open).not.toContain(`Write(/${scout}/.claude/**)`);
    expect(open).not.toContain(`Write(/${scout}/.agents/**)`);
    expect(open).not.toContain(`Write(/${scout}/.mcp.json)`);
    expect(open).toContain(`Write(/${scout}/.dork/agent.json)`);
    expect(open).toContain(`Write(/${other}/.claude/**)`);
    expect(open).toContain(`Write(/${accountRoot}/**)`);
  });

  it('leaves the open home out through a symlinked spelling of it', () => {
    const link = path.join(dorkHome, 'scout-link');
    fs.symlinkSync(scout, link);
    const rules = otherAgentHomesSelfGrantRules(dorkHome, link, 'all') ?? [];
    expect(rules.some((rule) => rule.includes(`${scout}/`))).toBe(false);
    expect(rules).toContain(`Write(/${other}/.claude/**)`);
  });
});
