/**
 * The asks port end to end (spec `computer-side-starts-alone` §5.7, C14):
 * unwired it fails closed, startup fills every computer-side slot with the
 * space side's port, and what the computer's own askers and pins send through
 * it is plain data that parses with its schema and survives JSON unchanged
 * (proof D11).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AskRequestSchema,
  StandingDecisionSchema,
  UNWIRED_COMPUTER_ASKS,
  type AskRequest,
  type ComputerAsks,
  type FolderAllowRequest,
  type FolderConfigRequest,
  type HookProjectionRequest,
  type RepoConfigRequest,
  type StandingDecision,
} from '@dorkos/shared/computer-asks';
import { wireComputerAsks } from '../../../../../startup/computer-asks.js';
import { harnessAsks, setHarnessAsks } from '../../../../harness/computer-asks.js';
import { askForHookProjection } from '../../../../harness/ask-withheld-hooks.js';
import { runtimeAsks, setRuntimeAsks } from '../../../../runtimes/computer-asks.js';
import { askForFolderAllows } from '../../../../runtimes/claude-code/folder-settings/folder-allow-approval.js';
import { askForFolderConfig } from '../../../../runtimes/claude-code/folder-settings/folder-config-approval.js';
import { pinPersonCreatedAgent } from '../../../../runtimes/claude-code/folder-settings/folder-config-consent.js';
import { pinRegisteredFolderConfigsOnce } from '../../../../runtimes/claude-code/folder-settings/pin-folder-configs.js';
import { askForRepoConfig } from '../../../../runtimes/claude-code/repo-settings/repo-config-approval.js';
import { setWorkspaceAsks, workspaceAsks } from '../../../../workspace/computer-asks.js';
import { computerAsks, createComputerAsks } from '../index.js';

const DIGESTS = { hooks: 'h'.repeat(64), mcpJson: 'm'.repeat(64), manifest: 'f'.repeat(64) };
const FOLDER_ALLOWS: FolderAllowRequest = {
  agentId: '01AGENT',
  agentName: 'Marketing',
  home: '/homes/marketing',
  rules: ['Bash(ls:*)'],
};
const FOLDER_CONFIG: FolderConfigRequest = {
  agentId: '01AGENT',
  agentName: 'Marketing',
  home: '/homes/marketing',
  digests: DIGESTS,
  changed: ['hooks'],
  detail: 'Hooks:\n{}',
};
const REPO_CONFIG: RepoConfigRequest = {
  kind: 'hooks',
  digest: 'd'.repeat(64),
  names: ['.claude/hooks/guard.mjs'],
  detail: '--- a\n+++ b',
  cwd: '/work/cedar',
  agentName: 'Ops',
};
const HOOK: HookProjectionRequest = {
  projectPath: '/work/cedar',
  packageName: 'lunar-hooks',
  hooks: [{ event: 'Stop', command: 'sh run.sh' }],
  scripts: [['run.sh', 'a'.repeat(64)]],
};

/** A port that says no to everything and keeps what it was sent. */
function capturingPort(): ComputerAsks & { asked: AskRequest[]; recorded: StandingDecision[] } {
  const asked: AskRequest[] = [];
  const recorded: StandingDecision[] = [];
  return {
    asked,
    recorded,
    raise: (request) => {
      asked.push(request);
      return Promise.resolve({ outcome: 'denied' });
    },
    record: (decision) => {
      recorded.push(decision);
    },
    reaskedHooks: () => [],
    isReaskedHook: () => false,
  };
}

/** Clear every computer-side slot. */
function unwireAll(): void {
  setRuntimeAsks(undefined);
  setHarnessAsks(undefined);
  setWorkspaceAsks(undefined);
}

let dorkHome: string;
let agentHome: string;

beforeAll(async () => {
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-asks-home-'));
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-asks-agent-'));
  const { initConfigManager } = await import('../../../config-manager.js');
  initConfigManager(dorkHome);
});

afterAll(() => {
  wireComputerAsks();
  fs.rmSync(dorkHome, { recursive: true, force: true });
  fs.rmSync(agentHome, { recursive: true, force: true });
});

beforeEach(() => {
  unwireAll();
});

describe('the asks port, before a space side wires it', () => {
  it('fails closed in every computer-side folder: nobody asked, nothing recorded', async () => {
    for (const asks of [runtimeAsks(), harnessAsks(), workspaceAsks()]) {
      expect(asks).toBe(UNWIRED_COMPUTER_ASKS);
      expect(await asks.raise({ kind: 'folder_allows', request: FOLDER_ALLOWS })).toEqual({
        outcome: 'unwired',
      });
      expect(asks.reaskedHooks()).toEqual([]);
      expect(asks.isReaskedHook(HOOK)).toBe(false);
    }
  });

  it('lets nothing apply: each asker on the computer side hears no', async () => {
    expect(await askForFolderAllows(runtimeAsks(), FOLDER_ALLOWS)).toBe(false);
    expect(await askForFolderConfig(runtimeAsks(), FOLDER_CONFIG)).toBe(false);
    expect(
      await askForRepoConfig(
        runtimeAsks(),
        REPO_CONFIG,
        async () => 'unknown',
        () => undefined
      )
    ).toBe(false);
    expect(await askForHookProjection(harnessAsks(), HOOK)).toBe(false);
  });

  it('writes no standing decision: an unwired pin leaves the settings as they were', async () => {
    const { configManager } = await import('../../../config-manager.js');
    const before = {
      harness: configManager.get('harness'),
      permissions: configManager.get('permissions'),
    };
    expect(pinPersonCreatedAgent('01NEW', agentHome)).toBe(true);
    await pinRegisteredFolderConfigsOnce(async () => [{ id: '01OLD', projectPath: agentHome }]);
    expect(configManager.get('harness')).toEqual(before.harness);
    expect(configManager.get('permissions')).toEqual(before.permissions);
  });

  it('raises no card on the space side until it has an approval service', async () => {
    expect(
      await createComputerAsks(null).raise({ kind: 'repo_config', request: REPO_CONFIG })
    ).toEqual({ outcome: 'unwired' });
  });
});

describe('startup', () => {
  it('fills every computer-side slot with the space side’s port', () => {
    wireComputerAsks();
    expect(runtimeAsks()).toBe(computerAsks);
    expect(harnessAsks()).toBe(computerAsks);
    expect(workspaceAsks()).toBe(computerAsks);
  });
});

describe('what crosses the port is plain data (D11)', () => {
  it('every ask and decision the computer sends parses and survives JSON unchanged', async () => {
    const port = capturingPort();
    setRuntimeAsks(port);
    await askForFolderAllows(port, FOLDER_ALLOWS);
    await askForFolderConfig(port, FOLDER_CONFIG);
    await askForRepoConfig(
      port,
      REPO_CONFIG,
      async () => 'unknown',
      () => undefined
    );
    await askForHookProjection(port, HOOK, { notInstalledByDorkos: true, resumeOnly: true });
    pinPersonCreatedAgent('01NEW', agentHome);
    await pinRegisteredFolderConfigsOnce(async () => [{ id: '01OLD', projectPath: agentHome }]);

    expect(port.asked.map((ask) => ask.kind)).toEqual([
      'folder_allows',
      'folder_config',
      'repo_config',
      'hook_projection',
    ]);
    expect(port.recorded.map((decision) => decision.kind)).toEqual([
      'folder_config_approved',
      'folder_config_approved',
      'folder_configs_pinned',
    ]);
    for (const ask of port.asked) {
      expect(AskRequestSchema.parse(ask)).toStrictEqual(ask);
      expect(JSON.parse(JSON.stringify(ask))).toStrictEqual(ask);
    }
    for (const decision of port.recorded) {
      expect(StandingDecisionSchema.parse(decision)).toStrictEqual(decision);
      expect(JSON.parse(JSON.stringify(decision))).toStrictEqual(decision);
    }
  });
});
