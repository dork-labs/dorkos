import { stored, copy, PANEL, WITH_PAGE, usePlacesFixture } from './harness.js';
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { ExtensionManifestSchema, type ExtensionManifest } from '@dorkos/extension-api';
import {
  isDismissedCopy,
  mayRunExtensionCode,
  type ExtensionApprovals,
} from '../../../extension-load-policy.js';
import { snapshotRootOf } from '../../extension-snapshots.js';
import { repinPlacesOnlyUpdates } from '../../places-only-update.js';
import { hasRepeatedOrPrototypeKey, manifestOnlyAddsPlaces } from '../../places-only-manifest.js';
import { ExtensionCompiler } from '../../../extension-compiler.js';
import { BASE_BUILD, HEAD_BUILD, writeDorkAppBuild } from '../dork-apps-build-fixture.js';
import { placeSnapshots } from '../../extension-snapshot-placement.js';
import { isPendingApproval } from '../../../extension-approval-queue.js';
import { initAuditTrail, type AuditTrail } from '../../../../audit/audit-trail.js';
import { waitingPlacesOf } from '../../../isolation/place-grace.js';
import type { ExtensionsConfig } from '../../../extension-enable-resolution.js';

describe('an update that only adds places keeps its app running (DOR-4282, C2)', () => {
  const p = usePlacesFixture();

  // Purpose: for an app no build tool stamps (no BUILD.json), only added
  // places may differ, so a new version beside an added place, with every
  // other file byte-identical, still asks again.
  it('leaves any other manifest change for the normal card and pause', async () => {
    await p.approveNow();
    await p.expectNormalCard(await p.updatedTo({ ...WITH_PAGE, version: '1.1.0' }));
    await p.expectNormalCard(await p.updatedTo({ ...WITH_PAGE, description: 'New words' }));
    await p.expectNormalCard(await p.updatedTo({ ...IN_PROCESS, contributions: {} }));
  });

  it('leaves a changed code byte for the normal card and pause', async () => {
    await p.approveNow();
    await fs.writeFile(path.join(p.dir, 'server.ts'), 'export default () => {}; ');
    await p.expectNormalCard(await p.updatedTo(WITH_PAGE));
  });

  it('leaves an added, removed or relinked file for the normal card and pause', async () => {
    await p.approveNow();
    await fs.writeFile(path.join(p.dir, '.hidden.js'), 'more');
    await p.expectNormalCard(await p.updatedTo(WITH_PAGE));
    await fs.rm(path.join(p.dir, '.hidden.js'));
    await fs.rm(path.join(p.dir, '.env.example'));
    await p.expectNormalCard(await p.updatedTo(WITH_PAGE));
  });

  it('treats a changed symbolic link target as a change', async () => {
    await fs.writeFile(path.join(p.dir, 'a.js'), 'a');
    await fs.writeFile(path.join(p.dir, 'b.js'), 'b');
    await fs.symlink('a.js', path.join(p.dir, 'link.js'));
    await p.approveNow();
    await fs.rm(path.join(p.dir, 'link.js'));
    await fs.symlink('b.js', path.join(p.dir, 'link.js'));
    await p.expectNormalCard(await p.updatedTo(WITH_PAGE));
  });

  // Purpose: a repeat that reads back as the approved value reaches the
  // repeat check; without it this would re-pin.
  it('treats a manifest with a repeated key as changed, even one that reads back the same', async () => {
    await p.approveNow();
    const repeated =
      '{"id":"notes","name":"Notes","version":"9.9.9","serverCapabilities":{"serverEntry":"./server.ts"},' +
      '"contributions":{"right-panel":true,"pages":true},"version":"1.0.0"}';
    // Parsed, it is valid and only adds a place: only the repeat check refuses it.
    expect(JSON.parse(repeated)).toEqual(WITH_PAGE);
    expect(ExtensionManifestSchema.safeParse(JSON.parse(repeated)).success).toBe(true);
    expect(hasRepeatedOrPrototypeKey(repeated)).toBe(true);
    await fs.writeFile(path.join(p.dir, 'extension.json'), repeated);
    await p.expectNormalCard(await p.rescanned());
  });

  // Purpose: the same `__proto__` on both sides compares equal, so only the
  // key check refuses it.
  it('treats a manifest with a __proto__ key as changed, even on both sides', async () => {
    const panel =
      '{"id":"notes","name":"Notes","version":"1.0.0","serverCapabilities":{"serverEntry":"./server.ts"},' +
      '"contributions":{"right-panel":true},"__proto__":{}}';
    const withPage = panel.replace('"right-panel":true', '"right-panel":true,"pages":true');
    const strip = (text: string) =>
      JSON.stringify(
        Object.fromEntries(Object.entries(JSON.parse(text)).filter(([key]) => key !== '__proto__'))
      );
    for (const text of [panel, withPage]) {
      expect(Object.hasOwn(JSON.parse(text), '__proto__')).toBe(true);
      expect(ExtensionManifestSchema.safeParse(JSON.parse(text)).success).toBe(true);
      expect(hasRepeatedOrPrototypeKey(text)).toBe(true);
    }
    // Without the key, the same pair is places-only.
    expect(manifestOnlyAddsPlaces(strip(panel), strip(withPage))).toBe(true);

    await fs.writeFile(path.join(p.dir, 'extension.json'), panel);
    await p.approveNow();
    await fs.writeFile(path.join(p.dir, 'extension.json'), withPage);
    await p.expectNormalCard(await p.rescanned());
  });

  // Purpose: the executable bit is in the digest, so it is in the comparison.
  it('treats a changed executable bit as a change', async () => {
    await p.approveNow();
    await fs.chmod(path.join(p.dir, 'index.js'), 0o755);
    await p.expectNormalCard(await p.updatedTo(WITH_PAGE));
  });

  // Purpose: `.git` is outside the digest and never reaches a snapshot, so
  // what runs cannot hold it and it neither blocks nor rides along.
  it('ignores an added .git folder, which no digest or snapshot holds', async () => {
    await p.approveNow();
    await fs.mkdir(path.join(p.dir, '.git'));
    await fs.writeFile(path.join(p.dir, '.git', 'HEAD'), 'ref: refs/heads/main');
    const record = await p.updatedTo(WITH_PAGE);
    const after = await repinPlacesOnlyUpdates(p.dorkHome, [record], p.approvals());
    expect(after.approvedSources!.notes!.digest).toBe(record.currentDigest);
    const snapshot = snapshotRootOf(p.dorkHome, record.currentDigest!)!;
    await expect(fs.access(path.join(snapshot, '.git'))).rejects.toThrow();
  });

  // Purpose (TOCTOU): the compare reads verified snapshots, never the live
  // folder, so a folder swapped mid-check cannot move the pin to other files.
  it('never re-pins when the folder is swapped between the scan and the compare', async () => {
    const { digest } = await p.approveNow();
    const code = path.join(p.dir, 'index.js');
    const original = await fs.readFile(code, 'utf8');
    const stealing = 'export function activate() { steal(); }';
    // The scan reads a tree that changes code as well as places.
    await fs.writeFile(code, stealing);
    const record = await p.updatedTo(WITH_PAGE);
    // Then the folder holds a places-only tree, swapped back to the scanned
    // one the moment anything reads its manifest.
    await fs.writeFile(code, original);
    const liveManifest = path.join(p.dir, 'extension.json');
    const realRead = fs.readFile;
    const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (
      ...args: Parameters<typeof realRead>
    ) => {
      const result = await realRead(...args);
      if (String(args[0]) === liveManifest) writeFileSync(code, stealing);
      return result;
    }) as unknown as typeof realRead);
    try {
      const before = p.approvals();
      const after = await repinPlacesOnlyUpdates(p.dorkHome, [record], before);
      expect(after).toBe(before);
      expect(after.approvedSources!.notes!.digest).toBe(digest);
      expect(after.approvedSources!.notes!.personApprovedDigest).toBe(digest);
      expect(record.pinnedDigest).not.toBe(record.currentDigest);
    } finally {
      spy.mockRestore();
    }
  });

  // Purpose: a tree that fails to read once is not remembered as changed, so
  // the next scan can still keep a places-only update running.
  it.skipIf(process.getuid?.() === 0)(
    'does not remember a pair whose tree failed to read',
    async () => {
      const { digest } = await p.approveNow();
      const record = await p.updatedTo(WITH_PAGE);
      const approvedRoot = snapshotRootOf(p.dorkHome, digest)!;
      const realRename = fs.rename;
      // Right after the current files are snapshotted, the approved snapshot
      // briefly can't be read, so only the compare's own read fails.
      const spy = vi.spyOn(fs, 'rename').mockImplementation((async (
        ...args: Parameters<typeof realRename>
      ) => {
        await realRename(...args);
        await fs.chmod(approvedRoot, 0o000);
      }) as unknown as typeof realRename);
      try {
        const before = p.approvals();
        expect(await repinPlacesOnlyUpdates(p.dorkHome, [record], before)).toBe(before);
      } finally {
        spy.mockRestore();
        await fs.chmod(approvedRoot, 0o755);
      }

      const after = await repinPlacesOnlyUpdates(p.dorkHome, [record], p.approvals());
      expect(after.approvedSources!.notes!.digest).toBe(record.currentDigest);
    }
  );

  it('refuses an added place set to anything but true', async () => {
    await p.approveNow();
    await p.expectNormalCard(
      await p.updatedTo({ ...PANEL, contributions: { 'right-panel': true, pages: 'yes' } })
    );
    await p.expectNormalCard(
      await p.updatedTo({ ...PANEL, contributions: { 'right-panel': true, pages: 1 } })
    );
    await p.expectNormalCard(
      await p.updatedTo({ ...PANEL, contributions: { 'right-panel': true, 'made-up': true } })
    );
    // Valid to the schema, so this one reaches the `=== true` check itself.
    const off = { ...PANEL, contributions: { 'right-panel': true, pages: false } };
    expect(ExtensionManifestSchema.safeParse(off).success).toBe(true);
    expect(manifestOnlyAddsPlaces(JSON.stringify(PANEL), JSON.stringify(off))).toBe(false);
    await p.expectNormalCard(await p.updatedTo(off));
  });

  /**
   * Make the copy a dork-apps build, approve it, then rebuild it: by default
   * with a new place, or as `head` says.
   */
  async function rebuiltDorkApp(head = HEAD_BUILD) {
    for (const name of await fs.readdir(p.dir))
      await fs.rm(path.join(p.dir, name), { recursive: true });
    await writeDorkAppBuild(p.dir, BASE_BUILD);
    const { digest } = await p.approveNow();
    await writeDorkAppBuild(p.dir, head);
    const manifest = JSON.parse(
      await fs.readFile(path.join(p.dir, 'extension.json'), 'utf8')
    ) as ExtensionManifest;
    return { digest, record: await p.rescanned(manifest) };
  }

  // Purpose (C2 widened): a real rebuild (version bump, banners, BUILD.json,
  // an added place) moves the pin, keeps the new place waiting, and the audit
  // line names both versions and both commits.
  it('re-pins a dork-apps rebuild that only adds places', async () => {
    const audit = vi.fn();
    initAuditTrail({
      log: { record: audit } as unknown as AuditTrail['log'],
      accounts: {
        system: () => ({ accountId: 'acct-system' }),
      } as unknown as AuditTrail['accounts'],
    });
    const { digest, record } = await rebuiltDorkApp();
    expect(mayRunExtensionCode(record, p.approvals())).toBe(false);

    const after = await repinPlacesOnlyUpdates(p.dorkHome, [record], p.approvals());

    expect(after.approvedSources!.notes!.digest).toBe(record.currentDigest);
    expect(after.approvedPermissions!.notes!.slots).toEqual(['right-panel']);
    expect(mayRunExtensionCode(record, after)).toBe(true);
    expect(waitingPlacesOf(record, after)).toEqual(['pages']);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'extension.pin_moved_places_only',
        change: [
          { field: 'digest', before: digest, after: record.currentDigest },
          { field: 'version', before: '1.0.0', after: '1.1.0' },
          { field: 'commit', before: 'abc1234', after: 'def5678' },
        ],
      })
    );
  });

  /** A rebuild that only bumps the version and restamps: no new place. */
  const VERSION_ONLY = { ...HEAD_BUILD, contributions: BASE_BUILD.contributions };

  // Purpose (R3): "Not now" is keyed by version. A rebuild that moves the pin
  // to a new version and adds no place carries the person's dismissal along
  // in the same write, so the card they put off does not come back.
  it('keeps a person’s "Not now" across a rebuild that only moves the version', async () => {
    const audit = vi.fn();
    initAuditTrail({
      log: { record: audit } as unknown as AuditTrail['log'],
      accounts: {
        system: () => ({ accountId: 'acct-system' }),
      } as unknown as AuditTrail['accounts'],
    });
    const { record } = await rebuiltDorkApp(VERSION_ONLY);
    const dismissedAt = '2026-11-19T00:00:00.000Z';
    const other = { path: '/elsewhere/notes', version: '1.0.0', dismissedAt };
    stored.extensions = {
      ...stored.extensions,
      dismissedApprovals: { notes: { path: p.dir, version: '1.0.0', dismissedAt }, other },
    };

    const after = await repinPlacesOnlyUpdates(p.dorkHome, [record], p.approvals());

    const extensions = after as ExtensionApprovals & {
      dismissedApprovals: Record<string, { path: string; version: string; dismissedAt: string }>;
    };
    expect(after.approvedSources!.notes!.digest).toBe(record.currentDigest);
    expect(extensions.dismissedApprovals.notes).toEqual({
      path: p.dir,
      version: '1.1.0',
      dismissedAt,
    });
    expect(extensions.dismissedApprovals.other).toEqual(other);
    expect(isDismissedCopy(record, extensions)).toBe(true);
    expect(isPendingApproval(record, extensions)).toBe(false);
    // The audit line says the "Not now" was kept.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'extension.pin_moved_places_only',
        change: expect.arrayContaining([
          { field: 'dismissedVersion', before: '1.0.0', after: '1.1.0' },
        ]),
      })
    );
  });

  // Purpose (R3, review): a rebuild that adds a place brings a place the
  // person never saw, so their "Not now" for the old version is not carried
  // and the card asks about it.
  it('asks again about a place a rebuild adds, even after a "Not now"', async () => {
    const { record } = await rebuiltDorkApp();
    const notNow = { path: p.dir, version: '1.0.0', dismissedAt: '2026-11-19T00:00:00.000Z' };
    stored.extensions = { ...stored.extensions, dismissedApprovals: { notes: notNow } };

    const after = (await repinPlacesOnlyUpdates(
      p.dorkHome,
      [record],
      p.approvals()
    )) as ExtensionApprovals & Pick<ExtensionsConfig, 'dismissedApprovals'>;

    expect(after.approvedSources!.notes!.digest).toBe(record.currentDigest);
    expect(after.dismissedApprovals!.notes).toEqual(notNow);
    expect(waitingPlacesOf(record, after)).toEqual(['pages']);
    expect(isDismissedCopy(record, after)).toBe(false);
    expect(isPendingApproval(record, after)).toBe(true);
  });

  // Purpose (R2): a rebuild that adds no place is still only what the build
  // tool restamps, so its pin moves too.
  it('re-pins a dork-apps rebuild that adds no place', async () => {
    for (const name of await fs.readdir(p.dir))
      await fs.rm(path.join(p.dir, name), { recursive: true });
    await writeDorkAppBuild(p.dir, BASE_BUILD);
    await p.approveNow();
    await writeDorkAppBuild(p.dir, { ...HEAD_BUILD, contributions: BASE_BUILD.contributions });
    const manifest = JSON.parse(
      await fs.readFile(path.join(p.dir, 'extension.json'), 'utf8')
    ) as ExtensionManifest;
    const record = await p.rescanned(manifest);

    const after = await repinPlacesOnlyUpdates(p.dorkHome, [record], p.approvals());

    expect(after.approvedSources!.notes!.digest).toBe(record.currentDigest);
    expect(mayRunExtensionCode(record, after)).toBe(true);
    expect(waitingPlacesOf(record, after)).toEqual([]);
  });

  // Purpose (R2): an app no build tool stamps must still add a place; a
  // manifest that only reads differently (spacing) gets the normal card.
  it('leaves a manifest change that adds no place for the normal card', async () => {
    await p.approveNow();
    const spaced = JSON.stringify(PANEL, null, 2);
    expect(manifestOnlyAddsPlaces(JSON.stringify(PANEL), spaced)).toBe(false);
    await fs.writeFile(path.join(p.dir, 'extension.json'), spaced);
    await p.expectNormalCard(await p.rescanned(PANEL));
  });

  // Purpose (W4): after a re-pin the copy runs from the snapshot of the new
  // digest, so a live file swapped afterwards is not what compiles.
  it('compiles the re-pinned snapshot, not a live file swapped after it', async () => {
    const { record } = await rebuiltDorkApp();
    await placeSnapshots(p.dorkHome, [record], p.approvals());
    const snapshot = path.resolve(snapshotRootOf(p.dorkHome, record.currentDigest!)!);
    expect(record.pinnedDigest).toBe(record.currentDigest);
    const runPath = path.resolve(record.runPath!);
    expect(runPath === snapshot || runPath.startsWith(snapshot + path.sep)).toBe(true);

    const built = await fs.readFile(path.join(runPath, 'index.js'), 'utf8');
    await fs.writeFile(path.join(p.dir, 'index.js'), `${built.split('\n')[0]}\nsteal();\n`);
    const compiler = new ExtensionCompiler(path.join(p.tmp, 'compile-home'));
    const result = await compiler.compile(record);

    expect('code' in result ? result.code : result.error).toBe(built);
  });
});
