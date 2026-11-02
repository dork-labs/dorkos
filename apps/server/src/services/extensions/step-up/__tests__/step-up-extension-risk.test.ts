/**
 * The loaded extensions that keep "Confirm it's you" off (DOR-3234, Must 3):
 * one in an agent's folder, or symlinked into it, or changed since a person
 * approved it. Real folders, so links resolve as they would on disk.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtensionRecord } from '@dorkos/extension-api';
import type { ExtensionApprovedSource } from '@dorkos/shared/config-schema';

import { stepUpExtensionRisks } from '../step-up-extension-risk.js';

let root: string;
let agentHome: string;
let dorkHome: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'step-up-risk-')));
  agentHome = path.join(root, 'agents', 'marketing');
  dorkHome = path.join(root, 'dork');
  fs.mkdirSync(path.join(agentHome, '.dork', 'extensions', 'social-queue'), { recursive: true });
  fs.mkdirSync(path.join(dorkHome, 'extensions', 'notes'), { recursive: true });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function record(id: string, folder: string, extra: Partial<ExtensionRecord> = {}): ExtensionRecord {
  return {
    id,
    manifest: { id, name: id === 'social-queue' ? 'Social queue' : 'Notes' },
    status: 'active',
    scope: 'local',
    origin: 'user',
    path: folder,
    realPath: fs.existsSync(folder) ? fs.realpathSync(folder) : folder,
    bundleReady: true,
    hasServerEntry: false,
    hasDataProxy: false,
    ...extra,
  } as unknown as ExtensionRecord;
}

const AGENTS = () => [{ path: agentHome, name: 'dorkos-marketing' }];

describe('stepUpExtensionRisks', () => {
  it('names a loaded mini app inside an agent’s folder, with that agent', () => {
    const risks = stepUpExtensionRisks({
      records: [
        record('social-queue', path.join(agentHome, '.dork', 'extensions', 'social-queue')),
      ],
      approvals: {},
      agents: AGENTS(),
    });
    expect(risks).toEqual([
      {
        id: 'social-queue',
        name: 'Social queue',
        reason: 'agent-folder',
        agentName: 'dorkos-marketing',
      },
    ]);
  });

  it('follows a symlink into an agent’s folder', () => {
    const link = path.join(dorkHome, 'extensions', 'linked');
    fs.symlinkSync(path.join(agentHome, '.dork', 'extensions', 'social-queue'), link);
    const risks = stepUpExtensionRisks({
      records: [record('linked', link)],
      approvals: {},
      agents: AGENTS(),
    });
    expect(risks).toMatchObject([{ id: 'linked', reason: 'agent-folder' }]);
  });

  it('judges where the code runs: a verified snapshot outside the agent’s folder is fine', () => {
    const snapshot = path.join(dorkHome, 'extension-snapshots', 'social-queue');
    fs.mkdirSync(snapshot, { recursive: true });
    const risks = stepUpExtensionRisks({
      records: [
        record('social-queue', path.join(agentHome, '.dork', 'extensions', 'social-queue'), {
          runPath: snapshot,
          currentDigest: 'sha256:a',
        }),
      ],
      approvals: {
        'social-queue': { path: snapshot, digest: 'sha256:a' } as ExtensionApprovedSource,
      },
      agents: AGENTS(),
    });
    expect(risks).toEqual([]);
  });

  it('counts the folder an approval names as the author, registered or not', () => {
    const risks = stepUpExtensionRisks({
      records: [
        record('social-queue', path.join(agentHome, '.dork', 'extensions', 'social-queue')),
      ],
      approvals: {
        'social-queue': { path: agentHome, authorHome: agentHome } as ExtensionApprovedSource,
      },
      agents: [],
    });
    expect(risks).toMatchObject([{ reason: 'agent-folder', agentName: 'marketing' }]);
  });

  it('names a mini app whose files changed since a person approved them', () => {
    const notes = path.join(dorkHome, 'extensions', 'notes');
    const risks = stepUpExtensionRisks({
      records: [record('notes', notes, { currentDigest: 'sha256:new' })],
      approvals: { notes: { path: notes, digest: 'sha256:approved' } as ExtensionApprovedSource },
      agents: AGENTS(),
    });
    expect(risks).toEqual([{ id: 'notes', name: 'Notes', reason: 'changed' }]);
  });

  it('names a copy whose plugin folder no longer holds what was installed', () => {
    const notes = path.join(dorkHome, 'extensions', 'notes');
    expect(
      stepUpExtensionRisks({
        records: [record('notes', notes, { originProblem: 'changed' })],
        approvals: {},
        agents: AGENTS(),
      })
    ).toMatchObject([{ reason: 'changed' }]);
  });

  it('passes a mini app outside every agent’s folder that matches its approval', () => {
    const notes = path.join(dorkHome, 'extensions', 'notes');
    expect(
      stepUpExtensionRisks({
        records: [record('notes', notes, { currentDigest: 'sha256:a' })],
        approvals: { notes: { path: notes, digest: 'sha256:a' } as ExtensionApprovedSource },
        agents: AGENTS(),
      })
    ).toEqual([]);
  });

  it('ignores a mini app that is not loaded', () => {
    expect(
      stepUpExtensionRisks({
        records: [
          record('social-queue', path.join(agentHome, '.dork', 'extensions', 'social-queue'), {
            status: 'disabled',
          }),
        ],
        approvals: {},
        agents: AGENTS(),
      })
    ).toEqual([]);
  });
});
