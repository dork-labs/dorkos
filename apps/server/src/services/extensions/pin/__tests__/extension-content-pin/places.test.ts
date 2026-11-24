import { stored, IN_PROCESS, copy, PANEL, WITH_PAGE, usePlacesFixture } from './harness.js';
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type ExtensionManifest } from '@dorkos/extension-api';
import { mayRunExtensionCode, type ExtensionApprovals } from '../../../extension-load-policy.js';
import { awaitsNextScan, liveDigestOf, pinStillHolds } from '../../extension-content-pin.js';
import { ensureSnapshot } from '../../extension-snapshots.js';
import { PIN_MOVED_SUMMARY, repinPlacesOnlyUpdates } from '../../places-only-update.js';
import { placeSnapshots, recheckAtItsLevel } from '../../extension-snapshot-placement.js';
import { isPendingApproval } from '../../../extension-approval-queue.js';
import { toPublic } from '../../../extension-manager-types.js';
import { initAuditTrail, type AuditTrail } from '../../../../audit/audit-trail.js';
import { allowedPlacesOf, placeGraceOf, waitingPlacesOf } from '../../../isolation/place-grace.js';

describe('an update that only adds places keeps its app running (DOR-4282, C2)', () => {
  const p = usePlacesFixture();
  // Purpose: the app keeps running on its old yes; only the new place waits.
  it('re-pins a contributions-only update, keeping the approval and the new place pending', async () => {
    const { digest } = await p.approveNow();
    const record = await p.updatedTo(WITH_PAGE);
    expect(mayRunExtensionCode(record, p.approvals())).toBe(false);

    const after = await repinPlacesOnlyUpdates(p.dorkHome, [record], p.approvals());

    const source = after.approvedSources!.notes!;
    expect(source.digest).toBe(record.currentDigest);
    expect(source.digest).not.toBe(digest);
    expect(source.personApprovedDigest).toBe(record.currentDigest);
    // The stored permission set is untouched: the page is not approved.
    expect(after.approvedPermissions!.notes!.slots).toEqual(['right-panel']);
    expect(mayRunExtensionCode(record, after)).toBe(true);
    expect(allowedPlacesOf(record, after)).toEqual(['right-panel']);
    expect(waitingPlacesOf(record, after)).toEqual(['pages']);
    expect(record.pinnedDigest).toBe(record.currentDigest);
  });

  // Purpose: after the re-pin, the pin holds the new files exactly.
  it('trips the moved pin as soon as a code file is edited', async () => {
    await p.approveNow();
    const record = await p.updatedTo(WITH_PAGE);
    const after = await repinPlacesOnlyUpdates(p.dorkHome, [record], p.approvals());
    expect(await pinStillHolds(record, after)).toBe(true);

    await fs.writeFile(path.join(p.dir, 'index.js'), 'export function activate() { steal(); }');
    expect(await pinStillHolds(record, after)).toBe(false);
    expect(mayRunExtensionCode(record, after)).toBe(false);
  });

  // Purpose: a person's yes moves only when it named exactly the old pin.
  it('leaves a person’s yes that did not name the old pin where it was', async () => {
    await p.approveNow();
    const stale = `sha256:${'9'.repeat(64)}`;
    const sources = p.approvals().approvedSources!;
    sources.notes = { ...sources.notes!, personApprovedDigest: stale };
    const record = await p.updatedTo(WITH_PAGE);

    const after = await repinPlacesOnlyUpdates(p.dorkHome, [record], p.approvals());

    expect(after.approvedSources!.notes!.digest).toBe(record.currentDigest);
    expect(after.approvedSources!.notes!.personApprovedDigest).toBe(stale);
  });

  // Purpose: the pin and the person's yes share one write; a failed one
  // moves neither, and the app stays paused.
  it('moves neither the pin nor the person’s yes when the write fails', async () => {
    const { digest } = await p.approveNow();
    const audit = vi.fn();
    initAuditTrail({
      log: { record: audit } as unknown as AuditTrail['log'],
      accounts: {
        system: () => ({ accountId: 'acct-system' }),
      } as unknown as AuditTrail['accounts'],
    });
    const record = await p.updatedTo(WITH_PAGE);
    stored.failWrite = true;
    const before = p.approvals();

    const after = await repinPlacesOnlyUpdates(p.dorkHome, [record], before);

    expect(after).toBe(before);
    expect(after.approvedSources!.notes!.digest).toBe(digest);
    expect(after.approvedSources!.notes!.personApprovedDigest).toBe(digest);
    expect(record.pinnedDigest).toBeUndefined();
    expect(mayRunExtensionCode(record, after)).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  // Purpose: every moved pin leaves one audit line with both digests.
  it('records the moved pin in the audit trail', async () => {
    const { digest } = await p.approveNow();
    const audit = vi.fn();
    const system = { accountId: 'acct-system', kind: 'system', name: 'DorkOS' };
    initAuditTrail({
      log: { record: audit } as unknown as AuditTrail['log'],
      accounts: { system: () => system } as unknown as AuditTrail['accounts'],
    });
    const record = await p.updatedTo(WITH_PAGE);

    await repinPlacesOnlyUpdates(p.dorkHome, [record], p.approvals());

    expect(PIN_MOVED_SUMMARY).toBe('pin moved by places-only update');
    // The config write logs its own line too; exactly one is the moved pin.
    const moved = audit.mock.calls.filter(
      ([entry]) => (entry as { action?: string }).action === 'extension.pin_moved_places_only'
    );
    expect(moved).toHaveLength(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: system,
        action: 'extension.pin_moved_places_only',
        summary: PIN_MOVED_SUMMARY,
        target: expect.objectContaining({ type: 'extension', id: 'notes' }),
        change: [
          { field: 'digest', before: digest, after: record.currentDigest },
          { field: 'version', before: '1.0.0', after: '1.0.0' },
        ],
      })
    );
  });

  // Purpose (R1): an approval from before places were recorded keeps its
  // undeclared panel tab and Settings page only until its files change. A
  // places-only update never moves its pin, so the grace ends and the normal
  // card asks; an approval that recorded its places still moves.
  it('never moves the pin of an approval with no places, so its grace ends', async () => {
    const pluginRoot = path.join(p.dorkHome, 'plugins', 'notes-kit');
    const appDir = path.join(pluginRoot, '.dork', 'extensions', 'notes');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, 'extension.json'), JSON.stringify(IN_PROCESS));
    await fs.writeFile(path.join(appDir, 'index.js'), 'export function activate() {}');
    await fs.writeFile(path.join(appDir, 'server.ts'), 'export default () => {};');
    const installed = (manifest: ExtensionManifest) =>
      copy({
        path: appDir,
        realPath: appDir,
        scope: 'global',
        manifest,
        sourcePlugin: 'notes-kit',
        trustedOrigin: { plugin: 'notes-kit', source: 'dork-labs/marketplace' },
      });
    const approved = installed(IN_PROCESS);
    const digest = (await liveDigestOf(approved))!;
    approved.currentDigest = digest;
    expect(await ensureSnapshot(p.dorkHome, pluginRoot, digest)).not.toBeNull();
    const inProcess = { runtime: 'in-process' as const, net: [], run: [], agents: false };
    const oldYes = (): ExtensionApprovals => ({
      approvedToRun: ['notes'],
      approvedSources: {
        notes: { path: appDir, plugin: 'notes-kit', digest, personApprovedDigest: digest },
      },
      approvedPermissions: { notes: inProcess },
    });
    stored.extensions = { enabled: ['notes'], disabled: [], ...oldYes() };
    expect(placeGraceOf(approved, p.approvals())).toEqual(['right-panel', 'settings.tabs']);

    const withPage = { ...IN_PROCESS, contributions: { pages: true } } as ExtensionManifest;
    await fs.writeFile(path.join(appDir, 'extension.json'), JSON.stringify(withPage));
    const updated = installed(withPage);
    updated.currentDigest = (await liveDigestOf(updated))!;

    const before = p.approvals();
    const after = await repinPlacesOnlyUpdates(p.dorkHome, [updated], before);

    expect(after).toBe(before);
    expect(after.approvedSources!.notes!.digest).toBe(digest);
    expect(updated.pinnedDigest).toBeUndefined();
    expect(mayRunExtensionCode(updated, after)).toBe(false);
    expect(placeGraceOf(updated, after)).toEqual([]);
    expect(isPendingApproval(updated, { ...after, dismissedApprovals: {} })).toBe(true);

    // The same update under a yes that recorded its places moves the pin.
    stored.extensions = {
      enabled: ['notes'],
      disabled: [],
      ...oldYes(),
      approvedPermissions: { notes: { ...inProcess, slots: ['right-panel'] } },
    };
    const moved = await repinPlacesOnlyUpdates(p.dorkHome, [updated], p.approvals());
    expect(moved.approvedSources!.notes!.digest).toBe(updated.currentDigest);
    expect(mayRunExtensionCode(updated, moved)).toBe(true);
  });

  // Purpose: a pin that misses between scans only pauses. No card, no config
  // write; the next scan decides, and a places-only update keeps its yes.
  it('pauses silently between scans, then recovers at the next scan', async () => {
    await p.approveNow();
    const running = await p.rescanned(PANEL);
    await placeSnapshots(p.dorkHome, [running], p.approvals());
    expect(mayRunExtensionCode(running, p.approvals())).toBe(true);

    // The update lands after the scan; a reload reads it before any scan.
    await fs.writeFile(path.join(p.dir, 'extension.json'), JSON.stringify(WITH_PAGE));
    const atMiss = JSON.stringify(stored.extensions);
    expect(await recheckAtItsLevel(p.dorkHome, running)).toBe(false);

    expect(awaitsNextScan(running)).toBe(true);
    expect(mayRunExtensionCode(running, p.approvals())).toBe(false);
    expect(isPendingApproval(running, p.approvals())).toBe(false);
    expect(JSON.stringify(stored.extensions)).toBe(atMiss);
    // The same copy without the mark would raise the files-changed card.
    expect(isPendingApproval({ ...running }, p.approvals())).toBe(true);

    const next = await p.rescanned(WITH_PAGE);
    await placeSnapshots(p.dorkHome, [next], p.approvals());

    expect(awaitsNextScan(next)).toBe(false);
    expect(mayRunExtensionCode(next, p.approvals())).toBe(true);
    expect(allowedPlacesOf(next, p.approvals())).toEqual(['right-panel']);
    expect(waitingPlacesOf(next, p.approvals())).toEqual(['pages']);
    expect(p.approvals().approvedPermissions!.notes!.slots).toEqual(['right-panel']);
    expect(isPendingApproval(next, p.approvals())).toBe(true);
  });

  // Purpose: a recheck never hides a card the scan already raised. Only a
  // miss the scan did not see waits for the next one.
  it('keeps a card the scan raised when a later recheck misses too', async () => {
    await p.approveNow();
    await fs.writeFile(path.join(p.dir, 'server.ts'), 'export default () => { steal(); };');
    const scanned = await p.rescanned(PANEL);
    await placeSnapshots(p.dorkHome, [scanned], p.approvals());
    expect(isPendingApproval(scanned, p.approvals())).toBe(true);
    const onNewMiss = vi.fn();

    expect(await recheckAtItsLevel(p.dorkHome, scanned, onNewMiss)).toBe(false);

    expect(awaitsNextScan(scanned)).toBe(false);
    expect(isPendingApproval(scanned, p.approvals())).toBe(true);
    expect(toPublic(scanned, p.approvals()).awaitingScan).toBeUndefined();
    expect(onNewMiss).not.toHaveBeenCalled();
  });

  // Purpose: a miss between scans asks for the next scan exactly once, and a
  // rescanned record that still misses never asks again.
  it('asks for one rescan when a miss between scans first pauses the copy', async () => {
    await p.approveNow();
    const running = await p.rescanned(PANEL);
    await placeSnapshots(p.dorkHome, [running], p.approvals());
    await fs.writeFile(path.join(p.dir, 'server.ts'), 'export default () => { steal(); };');
    const onNewMiss = vi.fn();

    expect(await recheckAtItsLevel(p.dorkHome, running, onNewMiss)).toBe(false);
    expect(await recheckAtItsLevel(p.dorkHome, running, onNewMiss)).toBe(false);
    expect(onNewMiss).toHaveBeenCalledTimes(1);
    expect(toPublic(running, p.approvals()).awaitingScan).toBe(true);
    expect(toPublic(running, p.approvals()).approvedToRun).toBe(false);

    const next = await p.rescanned(PANEL);
    await placeSnapshots(p.dorkHome, [next], p.approvals());
    const again = vi.fn();
    expect(await recheckAtItsLevel(p.dorkHome, next, again)).toBe(false);
    expect(again).not.toHaveBeenCalled();
    expect(awaitsNextScan(next)).toBe(false);
    expect(isPendingApproval(next, p.approvals())).toBe(true);
  });
});
