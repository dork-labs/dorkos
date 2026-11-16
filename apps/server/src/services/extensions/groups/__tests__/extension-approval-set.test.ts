/**
 * "Allow all" for a plugin's extensions (DOR-3583). Purpose: one click allows
 * exactly the first asks DorkOS's own install records say the plugin put on
 * disk, each with its own digest, and only after every member was checked; a
 * foreign id, a dropped-in folder, a missing member, or a permission set that
 * moved since the card refuses the whole set before anything is written; and
 * an error mid-way still reports every member (Security, Nov 8).
 *
 * Membership runs on the REAL checks: the plugin's install sidecar and its
 * installed-files record, written to a throwaway folder the way the installer
 * writes them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { approvalSetHash, type ApprovalSetMember } from '@dorkos/shared/extension-approval-schemas';

const state = vi.hoisted(() => ({
  allowed: new Set<string>(),
  allowedBefore: new Set<string>(),
  digests: new Map<string, string | null>(),
}));

vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: () => ({ approvedToRun: [...state.allowed, ...state.allowedBefore], approvedSources: {} }),
  },
}));
vi.mock('../../extension-load-policy.js', () => ({
  mayLoadClientHalf: (record: ExtensionRecord) => state.allowed.has(record.id),
}));
vi.mock('../../extension-approval-queue.js', async (importOriginal) => ({
  // The real provenance check reads the install sidecar on disk.
  provenanceOf: (await importOriginal<typeof import('../../extension-approval-queue.js')>())
    .provenanceOf,
  isPendingApproval: (record: ExtensionRecord) =>
    record.origin === 'user' && !state.allowed.has(record.id) && record.status !== 'disabled',
  permissionsOf: async (record: ExtensionRecord) => ({
    runtime:
      record.manifest.serverCapabilities?.runtime === 'subprocess' ? 'subprocess' : 'in-process',
    net: [...(record.manifest.serverCapabilities?.allow?.net ?? [])],
    run: [],
    agents: false,
    hasPage: true,
  }),
}));
vi.mock('../../pin/extension-content-pin.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../pin/extension-content-pin.js')>()),
  liveDigestOf: async (record: ExtensionRecord) => state.digests.get(record.id) ?? null,
}));

import { ApprovalRefusedError } from '../../pin/extension-content-pin.js';
import {
  computeInstalledFiles,
  writeInstalledFiles,
} from '../../../marketplace/lib/records/installed-files.js';
import { writeInstallMetadata } from '../../../marketplace/installed-metadata.js';
import {
  approveExtensionSet,
  listApprovalSets,
  type ApprovalSetSource,
} from '../extension-approval-set.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

let home: string;

beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ext-sets-')));
  state.allowed.clear();
  state.allowedBefore.clear();
  state.digests.clear();
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

/** Where a plugin is installed. */
const pluginRoot = (plugin: string) => path.join(home, 'plugins', plugin);

/** An extension folder inside a plugin, with its manifest. */
async function folder(plugin: string, id: string) {
  const dir = path.join(pluginRoot(plugin), '.dork', 'extensions', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify({ id, name: id }));
  return dir;
}

/** Install a plugin the way the installer does: its folders, then its two records. */
async function install(plugin: string, ids: string[]) {
  for (const id of ids) await folder(plugin, id);
  const root = pluginRoot(plugin);
  await writeInstalledFiles(
    root,
    await computeInstalledFiles(root, {
      identity: { name: plugin, type: 'plugin' },
      userEditable: [],
      npmRan: false,
    })
  );
  await writeInstallMetadata(root, {
    name: plugin,
    version: '1.0.0',
    type: 'plugin',
    installedAt: '2026-11-08T00:00:00.000Z',
    sourceRepo: 'dork-labs/marketplace',
  });
}

interface ExtOptions {
  net?: string[];
  run?: string[];
  runtime?: 'subprocess' | 'in-process';
  tools?: string[];
  agents?: boolean;
}

/** The discovery record for a folder in a plugin. */
function ext(id: string, plugin: string | undefined, options: ExtOptions = {}): ExtensionRecord {
  state.digests.set(id, `digest-${id}`);
  const runtime = options.runtime ?? 'subprocess';
  return {
    id,
    manifest: {
      id,
      name: id.toUpperCase(),
      version: '1.0.0',
      summary: `${id} things`,
      serverCapabilities:
        runtime === 'subprocess'
          ? {
              runtime,
              allow: { net: options.net ?? [], run: options.run ?? [], agents: options.agents },
            }
          : undefined,
    },
    status: 'compiled',
    scope: 'global',
    origin: 'user',
    path: path.join(pluginRoot(plugin ?? 'none'), '.dork', 'extensions', id),
    bundleReady: true,
    hasServerEntry: true,
    hasDataProxy: false,
    toolChecks: (options.tools ?? []).map((title) => ({
      name: title.toLowerCase().replace(/\s+/g, '_'),
      title,
      tier: 'act',
      ok: true,
    })),
    ...(plugin ? { sourcePlugin: plugin } : {}),
  } as unknown as ExtensionRecord;
}

function sourceOf(records: ExtensionRecord[]) {
  const approveToRun = vi.fn(async (id: string, _options: { expectedDigest?: string }) => {
    state.allowed.add(id);
    return { id } as never;
  });
  const source: ApprovalSetSource = {
    dorkHome: home,
    listRecords: () => records,
    approveToRun,
  } as unknown as ApprovalSetSource;
  return { source, approveToRun };
}

/** What the card would send back for the set it was drawn with. */
async function cardFor(source: ApprovalSetSource, plugin = 'marketing') {
  const sets = await listApprovalSets(source);
  const set = sets.find((candidate) => candidate.plugin === plugin);
  if (!set) throw new Error(`no set for ${plugin}`);
  const members = set.members.flatMap((member) => (member.echo ? [member.echo] : []));
  return { plugin, members, setHash: set.setHash, set };
}

const plainPermissions = { runtime: 'subprocess' as const, net: [], run: [], agents: false };

describe('listApprovalSets', () => {
  it('groups only what the install put there, shows allowed members, and skips one waiting', async () => {
    await install('marketing', ['writer', 'social', 'cockpit']);
    await install('solo', ['lonely', 'done']);
    const records = [
      ext('writer', 'marketing', { net: ['api.example.com'] }),
      ext('social', 'marketing'),
      ext('cockpit', 'marketing'),
      ext('agent-made', undefined),
      { ...ext('linked', 'marketing'), devLink: { path: '/src/linked' } } as ExtensionRecord,
      ext('lonely', 'solo'),
      ext('done', 'solo'),
    ];
    state.allowed.add('cockpit');
    state.allowed.add('done');
    const { source } = sourceOf(records);

    const sets = await listApprovalSets(source);

    expect(sets.map((set) => set.plugin)).toEqual(['marketing']);
    expect(sets[0]!.members.map((member) => [member.id, member.state])).toEqual([
      ['cockpit', 'allowed'],
      ['social', 'waiting'],
      ['writer', 'waiting'],
    ]);
  });

  // M1, on the real check: location alone never makes a member.
  it('leaves out a folder dropped into an installed plugin after the install', async () => {
    await install('marketing', ['writer', 'social']);
    await folder('marketing', 'planted');
    const { source } = sourceOf([
      ext('writer', 'marketing'),
      ext('social', 'marketing'),
      ext('planted', 'marketing', { runtime: 'in-process' }),
    ]);

    const { set } = await cardFor(source);

    expect(set.members.map((member) => member.id)).toEqual(['social', 'writer']);
  });

  // Fails closed: with no record to prove what the install put there, or one
  // rebuilt by guessing (`inferred`), nothing joins a set.
  it.each([
    [
      'missing',
      async () => fs.rm(path.join(pluginRoot('marketing'), '.dork', 'installed-files.json')),
    ],
    [
      'inferred',
      async () => {
        const file = path.join(pluginRoot('marketing'), '.dork', 'installed-files.json');
        const record = JSON.parse(await fs.readFile(file, 'utf-8'));
        await fs.writeFile(file, JSON.stringify({ ...record, inferred: true }));
      },
    ],
  ])('keeps every member out when the install record is %s', async (_how, spoil) => {
    await install('marketing', ['writer', 'social']);
    await spoil();
    const { source } = sourceOf([ext('writer', 'marketing'), ext('social', 'marketing')]);

    expect(await listApprovalSets(source)).toEqual([]);
  });

  it('leaves out a member whose manifest changed since the install', async () => {
    await install('marketing', ['writer', 'social', 'cockpit']);
    await fs.writeFile(
      path.join(pluginRoot('marketing'), '.dork', 'extensions', 'cockpit', 'extension.json'),
      JSON.stringify({ id: 'cockpit', name: 'Something else' })
    );
    const { source } = sourceOf([
      ext('writer', 'marketing'),
      ext('social', 'marketing'),
      ext('cockpit', 'marketing'),
    ]);

    const { set } = await cardFor(source);

    expect(set.members.map((member) => member.id)).toEqual(['social', 'writer']);
  });

  // M3: a re-ask keeps its own card, which says what changed.
  it('leaves out a member the person allowed before, and needs two first asks', async () => {
    await install('marketing', ['writer', 'social', 'cockpit']);
    state.allowedBefore.add('cockpit');
    const { source } = sourceOf([
      ext('writer', 'marketing'),
      ext('social', 'marketing'),
      ext('cockpit', 'marketing'),
    ]);
    expect((await cardFor(source)).set.members.map((m) => m.id)).toEqual(['social', 'writer']);

    state.allowedBefore.add('social');
    expect(await listApprovalSets(source)).toEqual([]);
  });

  // The card's total comes from the members the hash binds, never more or less.
  it('totals what the waiting members may do, and nothing an allowed one may do', async () => {
    await install('marketing', ['writer', 'social', 'studio', 'cockpit']);
    state.allowed.add('cockpit');
    const { source } = sourceOf([
      ext('writer', 'marketing', {
        net: ['api.example.com'],
        run: ['ffmpeg'],
        tools: ['Draft post'],
      }),
      ext('social', 'marketing', {
        net: ['cdn.example.com', 'api.example.com'],
        run: ['git'],
        agents: true,
      }),
      ext('studio', 'marketing', { runtime: 'in-process', tools: ['Cut video'] }),
      ext('cockpit', 'marketing', { run: ['bash'], tools: ['Hidden'] }),
    ]);

    const { set } = await cardFor(source);

    expect(set.grant).toEqual({
      fullAccess: ['STUDIO'],
      programs: ['ffmpeg', 'git'],
      agentTools: ['Cut video', 'Draft post'],
      agents: ['SOCIAL'],
      network: { anything: true, hosts: ['api.example.com', 'cdn.example.com'] },
    });
  });

  it('lists a member whose folder can’t be read as skipped, with why', async () => {
    await install('marketing', ['writer', 'social', 'cockpit']);
    const { source } = sourceOf([
      ext('writer', 'marketing'),
      ext('social', 'marketing'),
      ext('cockpit', 'marketing'),
    ]);
    state.digests.set('cockpit', null);

    const { set } = await cardFor(source);

    expect(set.members.find((member) => member.id === 'cockpit')).toMatchObject({
      state: 'skipped',
      reason: 'DorkOS can’t read its folder.',
    });
  });
});

describe('approveExtensionSet', () => {
  beforeEach(async () => {
    await install('marketing', ['writer', 'social', 'cockpit']);
  });

  it('approves each waiting member once, with its own digest, recording each as it goes', async () => {
    const { source, approveToRun } = sourceOf([
      ext('writer', 'marketing'),
      ext('social', 'marketing'),
    ]);
    const card = await cardFor(source);
    const recorded: string[] = [];

    const outcome = await approveExtensionSet(source, card, async (result) => {
      recorded.push(`${result.id}:${approveToRun.mock.calls.length}`);
    });

    expect(outcome).toMatchObject({ ok: true, allAllowed: true });
    expect(approveToRun.mock.calls).toEqual([
      ['social', { expectedDigest: 'digest-social' }],
      ['writer', { expectedDigest: 'digest-writer' }],
    ]);
    // Each is recorded before the next one is approved.
    expect(recorded).toEqual(['social:1', 'writer:2']);
  });

  it('refuses a foreign id before approving anything (Must 1)', async () => {
    await install('other', ['spy', 'spy-2']);
    const { source, approveToRun } = sourceOf([
      ext('writer', 'marketing'),
      ext('social', 'marketing'),
      ext('spy', 'other'),
    ]);
    const card = await cardFor(source);
    const foreign: ApprovalSetMember = {
      id: 'spy',
      version: '1.0.0',
      expectedDigest: 'digest-spy',
      permissions: plainPermissions,
    };

    const outcome = await approveExtensionSet(source, {
      ...card,
      members: [...card.members, foreign],
    });

    expect(outcome).toMatchObject({ ok: false, code: 'not_in_set' });
    expect(approveToRun).not.toHaveBeenCalled();
  });

  it('refuses an id with no plugin, and a folder dropped in after the install (Must 1)', async () => {
    await folder('marketing', 'planted');
    const { source, approveToRun } = sourceOf([
      ext('writer', 'marketing'),
      ext('social', 'marketing'),
      ext('loose', undefined),
      ext('planted', 'marketing'),
    ]);
    const card = await cardFor(source);

    for (const id of ['loose', 'planted']) {
      const outcome = await approveExtensionSet(source, {
        ...card,
        members: [
          ...card.members,
          { id, version: '1.0.0', expectedDigest: `digest-${id}`, permissions: plainPermissions },
        ],
      });
      expect(outcome).toMatchObject({ ok: false, code: 'not_in_set' });
    }
    expect(approveToRun).not.toHaveBeenCalled();
  });

  it('refuses a set that leaves out a waiting member (Must 1)', async () => {
    const { source, approveToRun } = sourceOf([
      ext('writer', 'marketing'),
      ext('social', 'marketing'),
      ext('cockpit', 'marketing'),
    ]);
    const card = await cardFor(source);
    const members = card.members.filter((member) => member.id !== 'cockpit');

    const outcome = await approveExtensionSet(source, {
      ...card,
      members,
      setHash: await approvalSetHash(members, sha256),
    });

    expect(outcome).toMatchObject({ ok: false, code: 'stale_set' });
    expect(approveToRun).not.toHaveBeenCalled();
  });

  it('refuses a member whose permission set changed with the same files (Must 2)', async () => {
    const writer = ext('writer', 'marketing', { net: ['api.example.com'] });
    const { source, approveToRun } = sourceOf([writer, ext('social', 'marketing')]);
    const card = await cardFor(source);
    // Same files, same digest: only what it may reach moved since the card.
    (writer.manifest.serverCapabilities as { allow: { net: string[] } }).allow.net = ['*'];

    const outcome = await approveExtensionSet(source, card);

    expect(outcome).toMatchObject({ ok: false, code: 'stale_set' });
    expect(approveToRun).not.toHaveBeenCalled();
  });

  it('refuses a member whose list of apps it calls grew since the card (DOR-3293)', async () => {
    const writer = ext('writer', 'marketing');
    const { source, approveToRun } = sourceOf([writer, ext('social', 'marketing')]);
    const card = await cardFor(source);
    // Same files, same digest: only the apps it calls moved since the card.
    (writer.manifest as { capabilities?: unknown }).capabilities = {
      http: { apps: ['ledger'] },
    };

    const outcome = await approveExtensionSet(source, card);

    expect(outcome).toMatchObject({ ok: false, code: 'stale_set' });
    expect(approveToRun).not.toHaveBeenCalled();
  });

  it('refuses a member whose files changed since the card, before approving any (Must 3)', async () => {
    const { source, approveToRun } = sourceOf([
      ext('writer', 'marketing'),
      ext('social', 'marketing'),
    ]);
    const card = await cardFor(source);
    state.digests.set('writer', 'digest-writer-edited');

    const outcome = await approveExtensionSet(source, card);

    expect(outcome).toMatchObject({ ok: false, code: 'stale_set' });
    expect(approveToRun).not.toHaveBeenCalled();
  });

  it('reports each member when one still fails at its own approval (Must 3)', async () => {
    const { source, approveToRun } = sourceOf([
      ext('writer', 'marketing'),
      ext('social', 'marketing'),
    ]);
    approveToRun.mockImplementation(async (id: string) => {
      if (id === 'writer') {
        throw new ApprovalRefusedError('stale', 'Its files changed since you saw it.');
      }
      return { id } as never;
    });
    const card = await cardFor(source);

    const outcome = await approveExtensionSet(source, card);

    expect(outcome).toEqual({
      ok: true,
      allAllowed: false,
      results: [
        { id: 'social', name: 'SOCIAL', ok: true },
        { id: 'writer', name: 'WRITER', ok: false, reason: 'Its files changed since you saw it.' },
      ],
    });
  });

  // M2: an unexpected error never hides what is already allowed.
  it('keeps going past an unexpected error, and reports every member', async () => {
    const { source, approveToRun } = sourceOf([
      ext('writer', 'marketing'),
      ext('social', 'marketing'),
      ext('cockpit', 'marketing'),
    ]);
    approveToRun.mockImplementation(async (id: string) => {
      if (id === 'social') throw Object.assign(new Error('EIO: disk error'), { code: 'EIO' });
      state.allowed.add(id);
      return { id } as never;
    });
    const card = await cardFor(source);
    const recorded: string[] = [];

    const outcome = await approveExtensionSet(source, card, async (result) => {
      recorded.push(result.id);
    });

    expect(outcome).toEqual({
      ok: true,
      allAllowed: false,
      results: [
        { id: 'cockpit', name: 'COCKPIT', ok: true },
        { id: 'social', name: 'SOCIAL', ok: false, reason: 'DorkOS couldn’t turn it on.' },
        { id: 'writer', name: 'WRITER', ok: true },
      ],
    });
    expect(recorded).toEqual(['cockpit', 'writer']);
  });

  it('refuses more than ten waiting members, so each is approved on its own card', async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `app-${i}`);
    await install('big', ids);
    const { source, approveToRun } = sourceOf(ids.map((id) => ext(id, 'big')));
    const card = await cardFor(source, 'big');
    expect(card.set.tooMany).toBe(true);

    const outcome = await approveExtensionSet(source, card);

    expect(outcome).toMatchObject({ ok: false, code: 'too_many_in_set' });
    expect(approveToRun).not.toHaveBeenCalled();
  });
});
