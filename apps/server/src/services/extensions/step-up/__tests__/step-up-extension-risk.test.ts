/**
 * The loaded extensions that keep "Confirm it's you" off (DOR-3234, Must 3):
 * one in an agent's folder, or symlinked into it, or changed since a person
 * approved it. Real folders, so links resolve as they would on disk. A copy
 * whose bundle the server would refuse to serve is never listed (DOR-4906).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtensionRecord } from '@dorkos/extension-api';
import type { ExtensionApprovedSource } from '@dorkos/shared/config-schema';

import type { ExtensionApprovals } from '../../extension-load-policy.js';
import {
  noteStepUpRisksBeforeServing,
  setStepUpExtensionRiskInputs,
  stepUpExtensionRisks,
} from '../step-up-extension-risk.js';
import { stepUpRiskLedger, useStepUpRiskLedgerFile } from '../step-up-risk-ledger.js';

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

/** A made-up code source the person trusts outright, so its copies are served. */
const KIT = 'made-up/kit';

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

/** A copy from {@link KIT}: served whatever its files, as a trusted source is. */
function fromKit(id: string, folder: string, extra: Partial<ExtensionRecord> = {}) {
  return record(id, folder, { trustedOrigin: { plugin: 'kit', source: KIT }, ...extra });
}

/** `config.extensions` with these approvals, trusting {@link KIT}. */
function extensions(
  approvedSources: Record<string, ExtensionApprovedSource> = {},
  more: Partial<ExtensionApprovals> = {}
): ExtensionApprovals {
  return {
    approvedToRun: Object.keys(approvedSources),
    approvedSources,
    trustedSources: [{ source: KIT, trustedAt: '2026-11-01T00:00:00.000Z' }],
    ...more,
  };
}

const AGENTS = () => [{ path: agentHome, name: 'dorkos-marketing' }];

describe('stepUpExtensionRisks', () => {
  it('names a loaded mini app inside an agent’s folder, with that agent', () => {
    const risks = stepUpExtensionRisks({
      records: [
        fromKit('social-queue', path.join(agentHome, '.dork', 'extensions', 'social-queue')),
      ],
      extensions: extensions(),
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
      records: [fromKit('linked', link)],
      extensions: extensions(),
      agents: AGENTS(),
    });
    expect(risks).toMatchObject([{ id: 'linked', reason: 'agent-folder' }]);
  });

  it('judges where the code runs: a verified snapshot outside the agent’s folder is fine', () => {
    const folder = path.join(agentHome, '.dork', 'extensions', 'social-queue');
    const snapshot = path.join(dorkHome, 'extension-snapshots', 'social-queue');
    fs.mkdirSync(snapshot, { recursive: true });
    const risks = stepUpExtensionRisks({
      records: [record('social-queue', folder, { runPath: snapshot, currentDigest: 'sha256:a' })],
      extensions: extensions({
        'social-queue': { path: folder, digest: 'sha256:a' } as ExtensionApprovedSource,
      }),
      agents: AGENTS(),
    });
    expect(risks).toEqual([]);
  });

  it('counts the folder an approval names as the author, registered or not', () => {
    const risks = stepUpExtensionRisks({
      records: [
        fromKit('social-queue', path.join(agentHome, '.dork', 'extensions', 'social-queue')),
      ],
      extensions: {
        ...extensions(),
        approvedSources: {
          'social-queue': { path: agentHome, authorHome: agentHome } as ExtensionApprovedSource,
        },
      },
      agents: [],
    });
    expect(risks).toMatchObject([{ reason: 'agent-folder', agentName: 'marketing' }]);
  });

  it('names a served mini app whose files changed since a person approved them', () => {
    const notes = path.join(dorkHome, 'extensions', 'notes');
    const risks = stepUpExtensionRisks({
      records: [fromKit('notes', notes, { currentDigest: 'sha256:new' })],
      extensions: extensions({
        notes: { path: notes, digest: 'sha256:approved' } as ExtensionApprovedSource,
      }),
      agents: AGENTS(),
    });
    expect(risks).toEqual([{ id: 'notes', name: 'Notes', reason: 'changed' }]);
  });

  it('names a served copy whose plugin folder no longer holds what was installed', () => {
    const notes = path.join(dorkHome, 'extensions', 'notes');
    expect(
      stepUpExtensionRisks({
        records: [fromKit('notes', notes, { originProblem: 'changed' })],
        extensions: extensions(),
        agents: AGENTS(),
      })
    ).toMatchObject([{ reason: 'changed' }]);
  });

  it('passes a mini app outside every agent’s folder that matches its approval', () => {
    const notes = path.join(dorkHome, 'extensions', 'notes');
    expect(
      stepUpExtensionRisks({
        records: [record('notes', notes, { currentDigest: 'sha256:a' })],
        extensions: extensions({
          notes: { path: notes, digest: 'sha256:a' } as ExtensionApprovedSource,
        }),
        agents: AGENTS(),
      })
    ).toEqual([]);
  });

  it('ignores a mini app that is not loaded', () => {
    expect(
      stepUpExtensionRisks({
        records: [
          fromKit('social-queue', path.join(agentHome, '.dork', 'extensions', 'social-queue'), {
            status: 'disabled',
          }),
        ],
        extensions: extensions(),
        agents: AGENTS(),
      })
    ).toEqual([]);
  });

  describe('a copy waiting for a person (DOR-4906)', () => {
    it('ignores a compiled update whose changed files wait for a yes: its bundle is never served', () => {
      const notes = path.join(dorkHome, 'extensions', 'notes');
      expect(
        stepUpExtensionRisks({
          records: [record('notes', notes, { status: 'compiled', currentDigest: 'sha256:new' })],
          extensions: extensions({
            notes: { path: notes, digest: 'sha256:approved' } as ExtensionApprovedSource,
          }),
          agents: AGENTS(),
        })
      ).toEqual([]);
    });

    it('ignores an update that asks for more than its approval covers', () => {
      // In an agent's folder, so it would be named if it counted as loaded.
      const folder = path.join(agentHome, '.dork', 'extensions', 'social-queue');
      expect(
        stepUpExtensionRisks({
          records: [
            // Now asks to run inside DorkOS; the yes was for a separate process.
            record('social-queue', folder, { status: 'compiled', currentDigest: 'sha256:a' }),
          ],
          extensions: extensions(
            { 'social-queue': { path: folder, digest: 'sha256:a' } as ExtensionApprovedSource },
            {
              approvedPermissions: {
                'social-queue': {
                  runtime: 'subprocess',
                  net: [],
                  run: [],
                  agents: false,
                  slots: [],
                },
              } as ExtensionApprovals['approvedPermissions'],
            }
          ),
          agents: AGENTS(),
        })
      ).toEqual([]);
    });

    it('ignores an agent’s mini app nobody has approved yet', () => {
      expect(
        stepUpExtensionRisks({
          records: [
            record('social-queue', path.join(agentHome, '.dork', 'extensions', 'social-queue')),
          ],
          extensions: { approvedToRun: [], approvedSources: {} },
          agents: AGENTS(),
        })
      ).toEqual([]);
    });

    it('still names a changed copy the server serves, beside a held one', () => {
      const notes = path.join(dorkHome, 'extensions', 'notes');
      const held = path.join(dorkHome, 'extensions', 'held');
      const risks = stepUpExtensionRisks({
        records: [
          fromKit('notes', notes, { originProblem: 'changed' }),
          record('held', held, { status: 'compiled', currentDigest: 'sha256:new' }),
        ],
        extensions: extensions({
          held: { path: held, digest: 'sha256:approved' } as ExtensionApprovedSource,
        }),
        agents: AGENTS(),
      });
      expect(risks).toEqual([{ id: 'notes', name: 'Notes', reason: 'changed' }]);
    });
  });

  describe('the copy being served (DOR-4906)', () => {
    it('counts it as loaded even when a reload has just left its record held', () => {
      const folder = path.join(agentHome, '.dork', 'extensions', 'social-queue');
      const inputs = {
        records: [record('social-queue', folder, { status: 'compiled' })],
        extensions: extensions(),
        agents: AGENTS(),
      };
      expect(stepUpExtensionRisks(inputs)).toEqual([]);
      expect(stepUpExtensionRisks({ ...inputs, served: 'social-queue' })).toMatchObject([
        { id: 'social-queue', reason: 'agent-folder' },
      ]);
    });

    it('notes a served copy that is no longer listed as a risk', () => {
      setStepUpExtensionRiskInputs(() => ({
        records: [],
        extensions: extensions(),
        agents: AGENTS(),
      }));
      try {
        expect(stepUpRiskLedger().mayHoldRiskyCode(Date.now() + 60_000)).toBe(false);
        expect(noteStepUpRisksBeforeServing('gone')).toBe(true);
        expect(stepUpRiskLedger().mayHoldRiskyCode(Date.now() + 60_000)).toBe(true);
      } finally {
        setStepUpExtensionRiskInputs(() => ({
          records: [],
          extensions: { approvedToRun: [], approvedSources: {} },
          agents: [],
        }));
        useStepUpRiskLedgerFile();
      }
    });
  });
});
