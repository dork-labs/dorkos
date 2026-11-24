import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { ExtensionDiscovery } from '../../extension-discovery.js';
import {
  EMPTY_CONFIG,
  EMPTY_CORE,
  coreMap,
  writeManifest,
  digestOf,
  makeDiscoveryHome,
} from './fixtures.js';
import { approvedSourceOf, mayRunExtensionCode } from '../../extension-load-policy.js';
import type { ExtensionsConfig } from '../../extension-enable-resolution.js';
import { logger } from '../../../../lib/logger.js';
import { recordProjectInstall } from '../../../marketplace/lib/project-install-index.js';
import { normalizeTrustedSource } from '../../../marketplace/lib/trusted-source.js';
import {
  inspectCopy,
  readTrustedInstalls,
  trustedOriginOf,
  type TrustedInstalls,
} from '../../extension-trusted-origin.js';

describe('ExtensionDiscovery', () => {
  let tmpDir: string;
  let dorkHome: string;
  let discovery: ExtensionDiscovery;

  beforeEach(async () => {
    ({ tmpDir, dorkHome, discovery } = await makeDiscoveryHome());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('every known project, and copies from one trusted source (spec flow-multiproject §9)', () => {
    const SOURCE = 'dork-labs/marketplace';
    const ORIGIN = { plugin: 'flow', source: SOURCE };

    /** Write a plugin-carried copy under `pluginsRoot` and return its folder. */
    async function carried(
      pluginsRoot: string,
      version: string,
      { plugin = 'flow', id = 'flow' }: { plugin?: string; id?: string } = {}
    ): Promise<string> {
      const dir = path.join(pluginsRoot, plugin, '.dork', 'extensions', id);
      await writeManifest(dir, { id, name: 'Flow', version });
      return dir;
    }

    /** A project folder with `flow` installed at `version`, recorded by the installer. */
    async function installedProject(
      name: string,
      version: string,
      source: string | null = 'https://github.com/Dork-Labs/marketplace.git'
    ): Promise<{ root: string; dir: string }> {
      const root = path.join(tmpDir, name);
      const dir = await carried(path.join(root, '.dork', 'plugins'), version);
      const normalized = normalizeTrustedSource(source);
      const installRoot = path.join(root, '.dork', 'plugins', 'flow');
      await recordProjectInstall(dorkHome, {
        projectPath: root,
        installRoot,
        name: 'flow',
        ...(normalized ? { source: normalized } : {}),
        // What the installer records: each carried folder's digest.
        installDigest: await digestOf(installRoot),
      });
      return { root, dir };
    }

    /** A global plugin with its own install sidecar. */
    async function globalPlugin(
      version: string,
      sidecar: Record<string, unknown>,
      plugin = 'flow'
    ): Promise<string> {
      const dir = await carried(path.join(dorkHome, 'plugins'), version, { plugin });
      await fs.writeFile(
        path.join(dorkHome, 'plugins', plugin, '.dork', 'install-metadata.json'),
        JSON.stringify({
          name: plugin,
          version,
          type: 'plugin',
          installedAt: '2026-09-29T00:00:00.000Z',
          // Fetched at the default branch unless a test says otherwise.
          sourceKey: {
            cloneUrl: 'https://github.com/dork-labs/marketplace',
            subpath: '',
            ref: 'HEAD',
          },
          ...sidecar,
        })
      );
      return dir;
    }

    /** Approve `copy` the way `approveToRun` records it, origin included. */
    function approve(copy: {
      path: string;
      sourcePlugin?: string;
      trustedOrigin?: { plugin: string; source: string };
      digest?: string;
    }): ExtensionsConfig {
      return {
        enabled: ['flow'],
        disabled: [],
        approvedToRun: ['flow'],
        approvedSources: {
          flow: {
            path: copy.path,
            ...(copy.sourcePlugin ? { plugin: copy.sourcePlugin } : {}),
            ...(copy.trustedOrigin ? { origin: copy.trustedOrigin } : {}),
            ...(copy.digest ? { digest: copy.digest } : {}),
          },
        },
      };
    }

    beforeEach(() => {
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    });

    describe('trustedOriginOf', () => {
      const none: TrustedInstalls = { global: [], project: [] };

      it('reads a global plugin from its own sidecar, https and ssh alike', async () => {
        await globalPlugin('1.0.0', { sourceRepo: 'git@github.com:Dork-Labs/Marketplace.git' });
        const installs = await readTrustedInstalls(dorkHome);
        const [record] = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

        expect(trustedOriginOf(record!, installs, await inspectCopy(record!))).toEqual(ORIGIN);
        expect(record!.trustedOrigin).toEqual(ORIGIN);
      });

      it('gives an installedFrom-only install no trusted origin', async () => {
        await globalPlugin('1.0.0', { installedFrom: 'dork-labs' });
        const [record] = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);

        expect(record!.trustedOrigin).toBeUndefined();
        expect(
          trustedOriginOf(record!, await readTrustedInstalls(dorkHome), await inspectCopy(record!))
        ).toBeNull();
      });

      it('trusts a project copy only through the install index', async () => {
        const recorded = await installedProject('recorded', '1.0.0');
        const recordedCopy = { path: recorded.dir, scope: 'local' as const, sourcePlugin: 'flow' };
        expect(
          trustedOriginOf(
            recordedCopy,
            await readTrustedInstalls(dorkHome),
            await inspectCopy(recordedCopy)
          )
        ).toEqual(ORIGIN);
        expect(trustedOriginOf(recordedCopy, none, await inspectCopy(recordedCopy))).toBeNull();
      });

      it('gives an unrecorded project copy none, whatever its own sidecar claims', async () => {
        const root = path.join(tmpDir, 'cloned');
        const dir = await carried(path.join(root, '.dork', 'plugins'), '9.9.9');
        await fs.writeFile(
          path.join(root, '.dork', 'plugins', 'flow', '.dork', 'install-metadata.json'),
          JSON.stringify({
            name: 'flow',
            version: '9.9.9',
            type: 'plugin',
            installedAt: '2026-09-29T00:00:00.000Z',
            sourceRepo: 'https://github.com/dork-labs/marketplace',
          })
        );
        const copy = { path: dir, scope: 'local' as const, sourcePlugin: 'flow' };

        expect(
          trustedOriginOf(copy, await readTrustedInstalls(dorkHome), await inspectCopy(copy))
        ).toBeNull();
      });

      it('gives a record written before sources were recorded none (no backfill)', async () => {
        const { dir } = await installedProject('old', '1.0.0', null);
        const copy = { path: dir, scope: 'local' as const, sourcePlugin: 'flow' };

        expect(
          trustedOriginOf(copy, await readTrustedInstalls(dorkHome), await inspectCopy(copy))
        ).toBeNull();
      });
    });

    describe('precedence', () => {
      it('row 1: a core extension beats every project copy', async () => {
        const { root } = await installedProject('a', '5.0.0');
        const results = await discovery.discover(
          null,
          EMPTY_CONFIG,
          coreMap({ id: 'flow', defaultEnabled: true, canDisable: true }),
          [root]
        );

        expect(results.filter((r) => r.id === 'flow')).toHaveLength(0);
      });

      it('row 2: a direct copy in another known project is found, and loses to an approved one', async () => {
        const a = path.join(tmpDir, 'a');
        const b = path.join(tmpDir, 'b');
        const aDir = path.join(a, '.dork', 'extensions', 'notes');
        const bDir = path.join(b, '.dork', 'extensions', 'notes');
        await writeManifest(aDir, { id: 'notes', name: 'Notes', version: '1.0.0' });
        await writeManifest(bDir, { id: 'notes', name: 'Notes', version: '2.0.0' });

        const found = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE, [b, a]);
        expect(found.find((r) => r.id === 'notes')?.path).toBe(aDir);

        const approved: ExtensionsConfig = {
          ...EMPTY_CONFIG,
          approvedToRun: ['notes'],
          approvedSources: { notes: { path: bDir } },
        };
        const withApproval = await discovery.discover(null, approved, EMPTY_CORE, [a, b]);
        expect(withApproval.find((r) => r.id === 'notes')?.path).toBe(bDir);
      });

      it('row 3: a copy approved by path wins when it is not part of the approved origin', async () => {
        const a = await installedProject('a', '1.0.0', null);
        const b = await installedProject('b', '2.0.0');

        const results = await discovery.discover(
          null,
          approve({ path: a.dir, sourcePlugin: 'flow' }),
          EMPTY_CORE,
          [a.root, b.root]
        );

        expect(results.find((r) => r.id === 'flow' && !r.shadowedBy)?.path).toBe(a.dir);
      });

      it('row 4: the newest copy of the approved origin is listed, and the older reports shadowedBy', async () => {
        const a = await installedProject('a', '1.0.0');
        const b = await installedProject('b', '1.2.0');
        const config = approve({ path: a.dir, sourcePlugin: 'flow', trustedOrigin: ORIGIN });

        const results = await discovery.discover(null, config, EMPTY_CORE, [a.root, b.root]);
        const running = results.filter((r) => !r.shadowedBy);
        const shadowed = results.filter((r) => r.shadowedBy);

        expect(running).toHaveLength(1);
        expect(running[0]).toMatchObject({ path: b.dir, trustedOrigin: ORIGIN });
        // A newer version is other files: the same source is not a yes to them (DOR-4895).
        expect(mayRunExtensionCode(running[0]!, config)).toBe(false);
        expect(shadowed).toEqual([expect.objectContaining({ path: a.dir, shadowedBy: b.dir })]);
      });
    });

    describe('edge cases', () => {
      it('a clone carrying a newer copy that claims the origin never runs unapproved', async () => {
        const a = await installedProject('a', '1.0.0');
        const cloneRoot = path.join(tmpDir, 'clone');
        const cloneDir = await carried(path.join(cloneRoot, '.dork', 'plugins'), '99.0.0');
        await fs.writeFile(
          path.join(cloneRoot, '.dork', 'plugins', 'flow', '.dork', 'install-metadata.json'),
          JSON.stringify({
            name: 'flow',
            version: '99.0.0',
            type: 'plugin',
            installedAt: '2026-09-29T00:00:00.000Z',
            sourceRepo: 'https://github.com/dork-labs/marketplace',
          })
        );
        const config = approve({ path: a.dir, sourcePlugin: 'flow', trustedOrigin: ORIGIN });

        const results = await discovery.discover(null, config, EMPTY_CORE, [a.root, cloneRoot]);
        const running = results.find((r) => !r.shadowedBy);
        expect(running?.path).toBe(a.dir);
        expect(results.some((r) => r.path === cloneDir)).toBe(false);

        // Alone, it is a row-5 candidate that must be approved by path.
        const alone = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE, [cloneRoot]);
        const clone = alone.find((r) => r.id === 'flow');
        expect(clone?.trustedOrigin).toBeUndefined();
        expect(mayRunExtensionCode(clone!, config)).toBe(false);
        const trusting = { ...config, trustedSources: [{ source: SOURCE, trustedAt: 'now' }] };
        expect(mayRunExtensionCode(clone!, trusting)).toBe(false);
      });

      it('falls back to the next newest trusted copy when the newest is deleted, with no prompt for the approved files', async () => {
        const a = await installedProject('a', '1.0.0');
        const b = await installedProject('b', '1.1.0');
        const c = await installedProject('c', '1.2.0');
        const roots = [a.root, b.root, c.root];
        const byOrigin = approve({ path: a.dir, sourcePlugin: 'flow', trustedOrigin: ORIGIN });

        await fs.rm(path.join(c.root, '.dork', 'plugins'), { recursive: true });
        const results = await discovery.discover(null, byOrigin, EMPTY_CORE, roots);
        const running = results.find((r) => !r.shadowedBy);

        expect(running?.path).toBe(b.dir);
        // Its files are not the approved ones, so it asks (DOR-4895)...
        expect(mayRunExtensionCode(running!, byOrigin)).toBe(false);
        // ...and a yes that names its files covers it with no prompt.
        const toItsFiles = approve({
          path: a.dir,
          sourcePlugin: 'flow',
          trustedOrigin: ORIGIN,
          digest: running!.currentDigest!,
        });
        const again = await discovery.discover(null, toItsFiles, EMPTY_CORE, roots);
        const covered = again.find((r) => !r.shadowedBy);
        expect(covered?.path).toBe(b.dir);
        expect(mayRunExtensionCode(covered!, toItsFiles)).toBe(true);
      });

      it('keeps different sources apart: approval stays bound to its own source', async () => {
        const a = await installedProject('a', '1.0.0');
        const b = await installedProject('b', '5.0.0', 'https://github.com/someone-else/flows');
        const config = approve({ path: a.dir, sourcePlugin: 'flow', trustedOrigin: ORIGIN });

        const results = await discovery.discover(null, config, EMPTY_CORE, [a.root, b.root]);

        expect(results.find((r) => !r.shadowedBy)?.path).toBe(a.dir);
        expect(results.some((r) => r.shadowedBy)).toBe(false);
      });
    });

    describe('security review attacks (DOR-2527)', () => {
      it('a folder rewritten at a recorded project path never takes over the approved flow', async () => {
        const a = await installedProject('a', '1.0.0');
        const b = await installedProject('b', '1.1.0');
        // An agent, a `git pull` or a re-clone writes v99 over B's copy.
        await writeManifest(b.dir, { id: 'flow', name: 'Flow', version: '99.0.0' });
        await fs.writeFile(path.join(b.dir, 'server.ts'), 'export default () => {};\n');
        const config = approve({ path: a.dir, sourcePlugin: 'flow', trustedOrigin: ORIGIN });

        const results = await discovery.discover(null, config, EMPTY_CORE, [a.root, b.root]);
        const running = results.find((r) => r.id === 'flow' && !r.shadowedBy);

        expect(running?.path).toBe(a.dir);
        expect(
          results.some((r) => r.path === b.dir && r.manifest.version === '99.0.0' && !r.shadowedBy)
        ).toBe(false);
      });

      it('says a recorded project copy changed since install, and gives it no origin', async () => {
        const b = await installedProject('b', '1.1.0');
        await fs.writeFile(path.join(b.dir, 'index.ts'), 'export function activate() {}\n');
        const trusting: ExtensionsConfig = {
          ...EMPTY_CONFIG,
          trustedSources: [{ source: SOURCE, trustedAt: '2026-09-29T00:00:00.000Z' }],
        };

        const [record] = await discovery.discover(null, trusting, EMPTY_CORE, [b.root]);

        expect(record).toMatchObject({ path: b.dir, originProblem: 'changed' });
        expect(record?.trustedOrigin).toBeUndefined();
        expect(mayRunExtensionCode(record!, trusting)).toBe(false);
      });

      it('an edit to plugin-level code the extension imports takes the origin away (N1)', async () => {
        const a = await installedProject('a', '1.0.0');
        const b = await installedProject('b', '1.1.0');
        // Flow's extension imports `../../../../scripts/*`: outside its own folder.
        const scripts = path.join(b.root, '.dork', 'plugins', 'flow', 'scripts');
        await fs.mkdir(scripts, { recursive: true });
        await fs.writeFile(path.join(scripts, 'errors.ts'), 'export const x = 1;\n');
        const config = approve({ path: a.dir, sourcePlugin: 'flow', trustedOrigin: ORIGIN });

        const results = await discovery.discover(null, config, EMPTY_CORE, [a.root, b.root]);

        expect(results.find((r) => r.id === 'flow' && !r.shadowedBy)?.path).toBe(a.dir);
        expect(results.some((r) => r.path === b.dir && r.trustedOrigin)).toBe(false);
      });

      it('a symbolic link anywhere in a recorded plugin folder takes the origin away (N2)', async () => {
        const b = await installedProject('b', '1.1.0');
        await fs.writeFile(path.join(tmpDir, 'evil.js'), 'export {};\n');
        await fs.symlink(path.join(tmpDir, 'evil.js'), path.join(b.dir, 'index.js'));
        const trusting: ExtensionsConfig = {
          ...EMPTY_CONFIG,
          trustedSources: [{ source: SOURCE, trustedAt: '2026-09-29T00:00:00.000Z' }],
        };

        const [record] = await discovery.discover(null, trusting, EMPTY_CORE, [b.root]);

        expect(record?.trustedOrigin).toBeUndefined();
        expect(record?.originProblem).toBe('changed');
        expect(mayRunExtensionCode(record!, trusting)).toBe(false);
      });

      it('a symbolic link inside a global plugin takes the origin away and says so (N2)', async () => {
        const dir = await globalPlugin('1.0.0', {
          sourceRepo: 'https://github.com/dork-labs/marketplace',
        });
        await fs.writeFile(path.join(tmpDir, 'evil.js'), 'export {};\n');
        await fs.symlink(path.join(tmpDir, 'evil.js'), path.join(dir, 'index.js'));
        const trusting: ExtensionsConfig = {
          ...EMPTY_CONFIG,
          trustedSources: [{ source: SOURCE, trustedAt: '2026-09-29T00:00:00.000Z' }],
        };

        const [record] = await discovery.discover(null, trusting, EMPTY_CORE);

        expect(record?.trustedOrigin).toBeUndefined();
        expect(record?.originProblem).toBe('linked');
        expect(mayRunExtensionCode(record!, trusting)).toBe(false);
      });

      it('a changed copy approved by path does not keep running; a yes to its files as they are does', async () => {
        const b = await installedProject('b', '1.1.0');
        const pathApproved = approve({ path: b.dir, sourcePlugin: 'flow' });
        await fs.writeFile(path.join(b.dir, 'index.ts'), 'export function activate() {}\n');

        const [changed] = await discovery.discover(null, pathApproved, EMPTY_CORE, [b.root]);
        expect(changed?.originProblem).toBe('changed');
        expect(mayRunExtensionCode(changed!, pathApproved)).toBe(false);

        // A fresh yes records the files as they are now, and pins the copy to them.
        const freshYes: ExtensionsConfig = {
          ...pathApproved,
          approvedSources: { flow: approvedSourceOf({ ...changed!, origin: 'user' }) },
        };
        expect(freshYes.approvedSources?.flow?.digest).toBe(changed?.currentDigest);
        const [again] = await discovery.discover(null, freshYes, EMPTY_CORE, [b.root]);
        expect(mayRunExtensionCode(again!, freshYes)).toBe(true);
        expect(again?.pinnedDigest).toBe(changed?.currentDigest);

        // Any further change asks again.
        await fs.writeFile(path.join(b.dir, 'index.ts'), 'export function activate() { 1; }\n');
        const [later] = await discovery.discover(null, freshYes, EMPTY_CORE, [b.root]);
        expect(mayRunExtensionCode(later!, freshYes)).toBe(false);
      });

      it('gives a symlinked global plugin no origin, whatever its linked sidecar says', async () => {
        const elsewhere = path.join(tmpDir, 'dev-checkout', 'flow');
        await writeManifest(path.join(elsewhere, '.dork', 'extensions', 'flow'), {
          id: 'flow',
          name: 'Flow',
          version: '9.0.0',
        });
        await fs.writeFile(
          path.join(elsewhere, '.dork', 'install-metadata.json'),
          JSON.stringify({
            name: 'flow',
            version: '9.0.0',
            type: 'plugin',
            installedAt: '2026-09-29T00:00:00.000Z',
            sourceRepo: 'https://github.com/dork-labs/marketplace',
            sourceKey: {
              cloneUrl: 'https://github.com/dork-labs/marketplace',
              subpath: '',
              ref: 'HEAD',
            },
          })
        );
        await fs.mkdir(path.join(dorkHome, 'plugins'), { recursive: true });
        await fs.symlink(elsewhere, path.join(dorkHome, 'plugins', 'flow'));
        const trusting: ExtensionsConfig = {
          ...EMPTY_CONFIG,
          trustedSources: [{ source: SOURCE, trustedAt: '2026-09-29T00:00:00.000Z' }],
        };

        const [record] = await discovery.discover(null, trusting, EMPTY_CORE);

        expect(record?.sourcePlugin).toBe('flow');
        expect(record?.trustedOrigin).toBeUndefined();
        expect(mayRunExtensionCode(record!, trusting)).toBe(false);
      });

      it.each([
        ['refs/pull/7/head', false],
        ['refs/remotes/origin/main', false],
        ['0123456789abcdef0123456789abcdef01234567', false],
        ['HEAD', true],
        ['main', true],
        ['refs/heads/release', true],
        ['refs/tags/v1.2.0', true],
      ])('a global install fetched at %s has a trusted origin: %s', async (ref, trusted) => {
        await globalPlugin('1.0.0', {
          sourceRepo: 'https://github.com/dork-labs/marketplace',
          sourceKey: { cloneUrl: 'https://github.com/dork-labs/marketplace', subpath: '', ref },
        });
        const [record] = await discovery.discover(null, EMPTY_CONFIG, EMPTY_CORE);
        expect(record?.trustedOrigin ?? null).toEqual(trusted ? ORIGIN : null);
      });
    });

    describe('trusted sources', () => {
      it("runs a trusted source's new extension with no approval", async () => {
        const a = await installedProject('a', '1.0.0');
        const config: ExtensionsConfig = {
          ...EMPTY_CONFIG,
          trustedSources: [{ source: SOURCE, trustedAt: '2026-09-29T00:00:00.000Z' }],
        };

        const [record] = await discovery.discover(null, config, EMPTY_CORE, [a.root]);

        expect(mayRunExtensionCode(record!, config)).toBe(true);
        expect(mayRunExtensionCode(record!, EMPTY_CONFIG)).toBe(false);
      });

      it('collapses copies from a trusted source to the newest', async () => {
        const a = await installedProject('a', '1.0.0');
        const b = await installedProject('b', '2.0.0');
        const config: ExtensionsConfig = {
          ...EMPTY_CONFIG,
          trustedSources: [{ source: SOURCE, trustedAt: '2026-09-29T00:00:00.000Z' }],
        };

        const results = await discovery.discover(null, config, EMPTY_CORE, [a.root, b.root]);

        expect(results.find((r) => !r.shadowedBy)?.path).toBe(b.dir);
        expect(results.find((r) => r.shadowedBy)?.path).toBe(a.dir);
      });
    });
  });
});
