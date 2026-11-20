/**
 * DOR-4305: approvals for extensions that are no longer installed are dropped
 * on their own, and an installed extension's approvals are never touched. The
 * rule is pure, so no config file is read or written here: every extension name
 * is made up and every folder is a made-up path the fake filesystem answers for.
 */
import { describe, expect, it } from 'vitest';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { withoutStaleApprovals } from '../stale-approvals.js';

type Extensions = UserConfig['extensions'];

/** An `extensions` section with the schema's defaults, overriding only what a case sets. */
const extensionsWith = (partial: Record<string, unknown>): Extensions =>
  ({
    enabled: [],
    disabled: [],
    approvedToRun: [],
    approvedSources: {},
    approvedPermissions: {},
    dismissedApprovals: {},
    trustedSources: [],
    ...partial,
  }) as Extensions;

const HOME = '/demo/dork/extensions';
const source = (id: string, folder = `${HOME}/${id}`) => ({
  path: folder,
  origin: undefined,
  digest: 'sha256-made-up',
});

/** A config with `kestrel-board` installed and `northwind-sync` gone. */
function config() {
  return extensionsWith({
    enabled: ['kestrel-board', 'northwind-sync'],
    disabled: ['northwind-sync'],
    approvedToRun: ['kestrel-board', 'northwind-sync'],
    approvedSources: {
      'kestrel-board': source('kestrel-board'),
      'northwind-sync': source('northwind-sync'),
    },
    approvedPermissions: {
      'kestrel-board': { runtime: 'subprocess' },
      'northwind-sync': { runtime: 'subprocess' },
    },
    dismissedApprovals: {},
    roomAccess: { 'northwind-sync': ['room-1'], 'kestrel-board': ['room-2'] },
    forwardAgents: { 'northwind-sync': ['agent-1'] },
  });
}

/** A fake filesystem holding exactly these paths. */
const holding =
  (...paths: string[]) =>
  (target: string) =>
    paths.includes(target);

describe('dropping approvals for extensions that are gone (DOR-4305)', () => {
  it('drops everything remembered about an extension whose folder is gone', () => {
    const { next, dropped } = withoutStaleApprovals(
      config(),
      new Set(['kestrel-board']),
      holding(HOME, `${HOME}/kestrel-board`)
    );
    expect(dropped).toEqual(['northwind-sync']);
    expect(next.approvedToRun).toEqual(['kestrel-board']);
    expect(Object.keys(next.approvedSources)).toEqual(['kestrel-board']);
    expect(Object.keys(next.approvedPermissions)).toEqual(['kestrel-board']);
    expect(next.enabled).toEqual(['kestrel-board']);
    expect(next.roomAccess).toEqual({ 'kestrel-board': ['room-2'] });
    expect(next.forwardAgents).toEqual({});
    // A person's "keep this off" stays.
    expect(next.disabled).toEqual(['northwind-sync']);
  });

  it('never touches an installed extension, even one this scan did not find', () => {
    // Not found this pass (a project not scanned yet), but its folder is there.
    const { dropped } = withoutStaleApprovals(
      config(),
      new Set(),
      holding(HOME, `${HOME}/kestrel-board`, `${HOME}/northwind-sync`)
    );
    expect(dropped).toEqual([]);
  });

  it('keeps an approval whose folder’s parent is gone too, like an unplugged drive', () => {
    const extensions = extensionsWith({
      approvedToRun: ['acme-search'],
      approvedSources: { 'acme-search': source('acme-search', '/Volumes/demo-drive/acme-search') },
    });
    expect(withoutStaleApprovals(extensions, new Set(), holding()).dropped).toEqual([]);
  });

  it('keeps an approval that never recorded a folder', () => {
    const extensions = extensionsWith({ approvedToRun: ['acme-legacy'] });
    expect(withoutStaleApprovals(extensions, new Set(), holding(HOME)).dropped).toEqual([]);
  });

  it('keeps a “Not now”: dropping it would let a later copy under that id start sooner', () => {
    const extensions = extensionsWith({
      approvedToRun: ['kestrel-notes'],
      approvedSources: { 'kestrel-notes': source('kestrel-notes') },
      dismissedApprovals: {
        'kestrel-notes': { path: `${HOME}/kestrel-notes`, version: '1.0.0', dismissedAt: 'x' },
      },
    });
    const { next, dropped } = withoutStaleApprovals(extensions, new Set(), holding(HOME));
    expect(dropped).toEqual(['kestrel-notes']);
    expect(next.approvedToRun).toEqual([]);
    expect(Object.keys(next.dismissedApprovals)).toEqual(['kestrel-notes']);
  });

  it('writes nothing when nothing is stale', () => {
    const before = config();
    const { next, dropped } = withoutStaleApprovals(
      before,
      new Set(['kestrel-board', 'northwind-sync']),
      holding(HOME)
    );
    expect(dropped).toEqual([]);
    expect(next).toBe(before);
  });
});
