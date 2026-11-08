/**
 * "Allow all" for a plugin's extensions (DOR-3583). Purpose: one click allows
 * exactly the members DorkOS's own records say the plugin installed, each with
 * its own digest, and only after every member was checked; a foreign id, a
 * missing member, or a permission set that moved since the card refuses the
 * whole set before anything is written (Security, Nov 8, Musts 1-3).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { approvalSetHash, type ApprovalSetMember } from '@dorkos/shared/extension-approval-schemas';

const state = vi.hoisted(() => ({
  allowed: new Set<string>(),
  digests: new Map<string, string | null>(),
  handmade: new Set<string>(),
}));

vi.mock('../../../core/config-manager.js', () => ({
  configManager: { get: () => ({ approvedToRun: [...state.allowed] }) },
}));
vi.mock('../../extension-load-policy.js', () => ({
  mayLoadClientHalf: (record: ExtensionRecord) => state.allowed.has(record.id),
}));
vi.mock('../../extension-approval-queue.js', () => ({
  isPendingApproval: (record: ExtensionRecord) =>
    record.origin === 'user' && !state.allowed.has(record.id) && record.status !== 'disabled',
  provenanceOf: async (record: ExtensionRecord) =>
    state.handmade.has(record.id)
      ? { kind: 'added', place: 'DorkOS' }
      : { kind: 'installer', from: 'dork-labs/marketplace' },
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
  approveExtensionSet,
  listApprovalSets,
  type ApprovalSetSource,
} from '../extension-approval-set.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** A user extension carried by `plugin` (or none), subprocess with these hosts. */
function ext(id: string, plugin: string | undefined, net: string[] = []): ExtensionRecord {
  state.digests.set(id, `digest-${id}`);
  return {
    id,
    manifest: {
      id,
      name: id.toUpperCase(),
      version: '1.0.0',
      summary: `${id} things`,
      serverCapabilities: { runtime: 'subprocess', allow: { net } },
    },
    status: 'compiled',
    scope: 'global',
    origin: 'user',
    path: `/home/.dork/plugins/${plugin ?? 'none'}/.dork/extensions/${id}`,
    bundleReady: true,
    hasServerEntry: true,
    hasDataProxy: false,
    ...(plugin ? { sourcePlugin: plugin } : {}),
  } as unknown as ExtensionRecord;
}

function sourceOf(records: ExtensionRecord[]) {
  const approveToRun = vi.fn(async (id: string, _options: { expectedDigest?: string }) => {
    state.allowed.add(id);
    return { id } as never;
  });
  const source: ApprovalSetSource = {
    dorkHome: '/home/.dork',
    listRecords: () => records,
    approveToRun,
  } as unknown as ApprovalSetSource;
  return { source, approveToRun };
}

/** What the card would send back for the set it was drawn with. */
async function cardFor(source: ApprovalSetSource, plugin = 'marketing') {
  const sets = await listApprovalSets(source);
  const set = sets.find((candidate) => candidate.plugin === plugin)!;
  const members = set.members.flatMap((member) => (member.echo ? [member.echo] : []));
  return { plugin, members, setHash: set.setHash, set };
}

beforeEach(() => {
  state.allowed.clear();
  state.digests.clear();
  state.handmade.clear();
});

describe('listApprovalSets', () => {
  it('groups only what the plugin installed, shows allowed members, and skips one-member plugins', async () => {
    const records = [
      ext('writer', 'marketing', ['api.example.com']),
      ext('social', 'marketing'),
      ext('cockpit', 'marketing'),
      ext('handmade', 'marketing'),
      ext('agent-made', undefined),
      { ...ext('linked', 'marketing'), devLink: { path: '/src/linked' } } as ExtensionRecord,
      ext('lonely', 'solo'),
    ];
    state.handmade.add('handmade');
    state.allowed.add('cockpit');
    const { source } = sourceOf(records);

    const sets = await listApprovalSets(source);

    expect(sets.map((set) => set.plugin)).toEqual(['marketing']);
    const members = sets[0]!.members;
    expect(members.map((member) => [member.id, member.state])).toEqual([
      ['cockpit', 'allowed'],
      ['social', 'waiting'],
      ['writer', 'waiting'],
    ]);
    expect(members.find((member) => member.id === 'writer')!.reachesInternet).toBe(true);
    expect(members.find((member) => member.id === 'social')!.reachesInternet).toBe(false);
  });

  it('lists a member whose folder can’t be read as skipped, with why', async () => {
    const { source } = sourceOf([ext('writer', 'marketing'), ext('social', 'marketing')]);
    state.digests.set('social', null);

    const { set } = await cardFor(source);

    expect(set.members.find((member) => member.id === 'social')).toMatchObject({
      state: 'skipped',
      reason: 'DorkOS can’t read its folder.',
    });
  });
});

describe('approveExtensionSet', () => {
  it('approves each waiting member once, with its own digest', async () => {
    const { source, approveToRun } = sourceOf([
      ext('writer', 'marketing'),
      ext('social', 'marketing'),
    ]);
    const card = await cardFor(source);

    const outcome = await approveExtensionSet(source, card);

    expect(outcome).toMatchObject({ ok: true, allAllowed: true });
    expect(approveToRun.mock.calls).toEqual([
      ['social', { expectedDigest: 'digest-social' }],
      ['writer', { expectedDigest: 'digest-writer' }],
    ]);
  });

  it('refuses a foreign id before approving anything (Must 1)', async () => {
    const records = [ext('writer', 'marketing'), ext('social', 'marketing'), ext('spy', 'other')];
    const { source, approveToRun } = sourceOf(records);
    const card = await cardFor(source);
    const foreign: ApprovalSetMember = {
      id: 'spy',
      version: '1.0.0',
      expectedDigest: 'digest-spy',
      permissions: { runtime: 'subprocess', net: [], run: [], agents: false },
    };

    const outcome = await approveExtensionSet(source, {
      ...card,
      members: [...card.members, foreign],
    });

    expect(outcome).toMatchObject({ ok: false, code: 'not_in_set' });
    expect(approveToRun).not.toHaveBeenCalled();
  });

  it('refuses an id with no plugin, and one a person dropped in by hand (Must 1)', async () => {
    const records = [
      ext('writer', 'marketing'),
      ext('social', 'marketing'),
      ext('loose', undefined),
    ];
    records.push(ext('handmade', 'marketing'));
    state.handmade.add('handmade');
    const { source, approveToRun } = sourceOf(records);
    const card = await cardFor(source);

    for (const id of ['loose', 'handmade']) {
      const outcome = await approveExtensionSet(source, {
        ...card,
        members: [
          ...card.members,
          {
            id,
            version: '1.0.0',
            expectedDigest: `digest-${id}`,
            permissions: { runtime: 'subprocess', net: [], run: [], agents: false },
          },
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
    const writer = ext('writer', 'marketing', ['api.example.com']);
    const { source, approveToRun } = sourceOf([writer, ext('social', 'marketing')]);
    const card = await cardFor(source);
    // Same files, same digest: only what it may reach moved since the card.
    (writer.manifest.serverCapabilities as { allow: { net: string[] } }).allow.net = ['*'];

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
      if (id === 'writer')
        throw new ApprovalRefusedError('stale', 'Its files changed since you saw it.');
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

  it('refuses more than ten waiting members, so each is approved on its own card', async () => {
    const records = Array.from({ length: 11 }, (_, i) => ext(`app-${i}`, 'marketing'));
    const { source, approveToRun } = sourceOf(records);
    const card = await cardFor(source);
    expect(card.set.tooMany).toBe(true);

    const outcome = await approveExtensionSet(source, card);

    expect(outcome).toMatchObject({ ok: false, code: 'too_many_in_set' });
    expect(approveToRun).not.toHaveBeenCalled();
  });
});
