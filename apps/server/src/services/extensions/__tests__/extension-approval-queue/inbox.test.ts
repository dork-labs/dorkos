import {
  state,
  h,
  server,
  EXT_ID,
  broadcasts,
  approvalArrivals,
  historyRows,
  extensionDir,
  writeManifest,
  installPlugin,
  card,
  pending,
} from './harness.js';
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from '@dorkos/test-utils/supertest';
import { startExtensionApprovalQueue } from '../../extension-approval-queue.js';
import { extensionApprovalSubjectId } from '@dorkos/shared/extension-approval-schemas';

describe('an extension waiting to run asks in the inbox', () => {
  it('1. installing a plugin that carries one produces exactly one item and one arrival', async () => {
    expect(await pending()).toEqual([]);

    await installPlugin();

    const approvals = await pending();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      id: EXT_ID,
      name: 'Flow',
      version: '1.0.0',
      plugin: 'flow',
      path: extensionDir('flow'),
      sourceLabel: 'flow plugin · dork-labs/marketplace',
      adds: 'It adds a Flow tab',
      why: 'You installed the flow plugin from dork-labs/marketplace. This adds a Flow tab. It runs as you.',
      runsInServer: false,
    });
    expect(approvalArrivals()).toHaveLength(1);
    expect(approvalArrivals()[0]).toMatchObject({
      title: 'Turn on Flow?',
      tier: 'notable',
      deepLink: '/?settings=extensions',
    });
  });

  it('2. allowing it from there lets it run, empties the queue, and records one answer', async () => {
    await installPlugin();

    const res = await request(server).post(`/api/extensions/${EXT_ID}/approve`).send(card());
    expect(res.status).toBe(200);
    await h.queue.sync();

    expect(h.manager.listPublic().find((ext) => ext.id === EXT_ID)?.approvedToRun).toBe(true);
    expect(await pending()).toEqual([]);
    const rows = historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'approved',
      title: 'You turned on Flow',
      body: 'Flow tab added',
      subject: {
        type: 'system',
        id: extensionApprovalSubjectId({
          id: EXT_ID,
          path: extensionDir('flow'),
          plugin: 'flow',
          version: '1.0.0',
        }),
      },
    });
    // The person answered it themselves, so it is not news to them.
    expect(rows[0].readAt).toBeDefined();
    expect(broadcasts('extension_reloaded')).toEqual([
      expect.objectContaining({ extensionIds: [EXT_ID] }),
    ]);
    // Its arrival is retired everywhere it was drawn.
    expect(broadcasts('standing_resolved')).toEqual([
      expect.objectContaining({ kind: 'extension.approval' }),
    ]);
  });

  it('3. an update from the same approved source asks again, once, naming what changed (DOR-3068)', async () => {
    await installPlugin();
    await request(server).post(`/api/extensions/${EXT_ID}/approve`).send(card());
    await h.queue.sync();
    const arrivalsBefore = approvalArrivals().length;

    writeManifest('flow', { version: '1.1.0' });
    await h.manager.reload();
    // Repeated scans of the same changed files are one row, not one per scan.
    await h.manager.reload();
    await h.queue.sync();

    expect(h.manager.listPublic().find((ext) => ext.id === EXT_ID)?.approvedToRun).toBe(false);
    const approvals = await pending();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      id: EXT_ID,
      version: '1.1.0',
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      changedFiles: [`.dork/extensions/${EXT_ID}/extension.json`],
      // An update says so, naming both versions (the row reads "Update … from
      // 1.0.0 to 1.1.0?").
      updatedFrom: '1.0.0',
    });
    // The title names both versions, so the line says only what changed in the new one.
    expect(approvals[0].why).toBe('Changed in 1.1.0: extension.json. It runs as you.');
    expect(approvalArrivals()).toHaveLength(arrivalsBefore + 1);

    // A yes to a card that showed other files is refused, and changes nothing.
    const stale = await request(server)
      .post(`/api/extensions/${EXT_ID}/approve`)
      .send({ version: '1.1.0', expectedDigest: `sha256:${'0'.repeat(64)}` });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('stale_approval');

    // A yes to exactly the files shown runs them.
    const ok = await request(server)
      .post(`/api/extensions/${EXT_ID}/approve`)
      .send({ version: '1.1.0', expectedDigest: approvals[0].digest });
    expect(ok.status).toBe(200);
    await h.queue.sync();
    expect(await pending()).toEqual([]);
  });

  it('4. the same extension arriving from another source asks again', async () => {
    await installPlugin();
    await request(server).post(`/api/extensions/${EXT_ID}/approve`).send(card());
    await h.queue.sync();

    fs.renameSync(
      path.join(h.dorkHome, 'plugins', 'flow'),
      path.join(h.dorkHome, 'plugins', 'fork')
    );
    await h.manager.reload();
    await h.queue.sync();

    const approvals = await pending();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ id: EXT_ID, plugin: 'fork', path: extensionDir('fork') });
  });

  describe('5. "Not now"', () => {
    it('empties the queue, records the answer, and removes and disables nothing', async () => {
      await installPlugin();
      const [shown] = await pending();

      const res = await request(server)
        .post(`/api/extensions/${EXT_ID}/dismiss-approval`)
        .send({ path: shown.path, version: shown.version });
      expect(res.status).toBe(204);
      await h.queue.sync();

      expect(await pending()).toEqual([]);
      const rows = historyRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: 'dismissed', title: 'Flow is off for now' });
      // Never destructive: still installed, still turned on, still not allowed.
      expect(fs.existsSync(extensionDir('flow'))).toBe(true);
      expect(state.extensions.enabled).toContain(EXT_ID);
      expect(h.manager.get(EXT_ID)?.status).not.toBe('disabled');
      expect(state.extensions.approvedToRun).not.toContain(EXT_ID);
    });

    it('asks again when the version changes', async () => {
      await installPlugin();
      const [shown] = await pending();
      await request(server)
        .post(`/api/extensions/${EXT_ID}/dismiss-approval`)
        .send({ path: shown.path, version: shown.version });
      await h.queue.sync();
      expect(await pending()).toEqual([]);

      writeManifest('flow', { version: '1.1.0' });
      await h.manager.reload();
      await h.queue.sync();

      const approvals = await pending();
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({ version: '1.1.0' });
    });

    it('refuses an answer to a row that is out of date, and writes nothing', async () => {
      await installPlugin();
      writeManifest('flow', { version: '1.1.0' });
      await h.manager.reload();
      await h.queue.sync();

      const res = await request(server)
        .post(`/api/extensions/${EXT_ID}/dismiss-approval`)
        .send({ path: extensionDir('flow'), version: '1.0.0' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('stale_approval');
      expect(state.extensions.dismissedApprovals).toEqual({});
      expect(await pending()).toHaveLength(1);
    });

    it('refuses an agent that names itself, and writes nothing', async () => {
      await installPlugin();
      const [shown] = await pending();

      const res = await request(server)
        .post(`/api/extensions/${EXT_ID}/dismiss-approval`)
        .set('x-dorkos-agent', 'agent-token-abc')
        .send({ path: shown.path, version: shown.version });

      expect(res.status).toBe(403);
      expect(state.extensions.dismissedApprovals).toEqual({});
    });

    it('answers 404 for an extension that is not there', async () => {
      const res = await request(server)
        .post('/api/extensions/nope/dismiss-approval')
        .send({ path: '/x', version: '1.0.0' });
      expect(res.status).toBe(404);
    });

    it('turning a put-off copy on later records that it is on (history tells the truth)', async () => {
      await installPlugin();
      const [shown] = await pending();
      await request(server)
        .post(`/api/extensions/${EXT_ID}/dismiss-approval`)
        .send({ path: shown.path, version: shown.version });
      await h.queue.sync();
      expect(historyRows().map((row) => row.outcome)).toEqual(['dismissed']);

      // The history row's "Turn it on", naming the copy it was about.
      const res = await request(server).post(`/api/extensions/${EXT_ID}/approve`).send({
        path: shown.path,
        version: shown.version,
        plugin: shown.plugin,
        expectedDigest: shown.digest,
      });
      expect(res.status).toBe(200);
      await h.queue.sync();

      const rows = historyRows();
      expect(rows.map((row) => row.outcome).sort()).toEqual(['approved', 'dismissed']);
      expect(rows.find((row) => row.outcome === 'approved')?.title).toBe('You turned on Flow');
    });
  });

  describe('"Stop it"', () => {
    it('puts that copy off: the ask does not come back until the version changes', async () => {
      await installPlugin();
      await request(server).post(`/api/extensions/${EXT_ID}/approve`).send(card());
      await h.queue.sync();
      const arrivalsBefore = approvalArrivals().length;

      const res = await request(server).post(`/api/extensions/${EXT_ID}/revoke`).send({});
      expect(res.status).toBe(200);
      await h.queue.sync();

      expect(state.extensions.approvedToRun).not.toContain(EXT_ID);
      expect(await pending()).toEqual([]);
      expect(approvalArrivals()).toHaveLength(arrivalsBefore);

      writeManifest('flow', { version: '1.1.0' });
      await h.manager.reload();
      await h.queue.sync();
      expect(await pending()).toEqual([expect.objectContaining({ version: '1.1.0' })]);
    });
  });

  describe('uninstalling forgets a "Not now" for the removed copy', () => {
    /** Uninstall the plugin the way `flows/uninstall.ts` does, then rescan. */
    async function uninstallPlugin(plugin = 'flow'): Promise<void> {
      const root = path.join(h.dorkHome, 'plugins', plugin);
      await h.manager.forgetRunApproval(EXT_ID, root);
      fs.rmSync(root, { recursive: true, force: true });
      await h.manager.reload();
      await h.queue.sync();
    }

    it('asks again after "Not now", uninstall, and a reinstall at the same version', async () => {
      await installPlugin();
      const [shown] = await pending();
      await request(server)
        .post(`/api/extensions/${EXT_ID}/dismiss-approval`)
        .send({ path: shown.path, version: shown.version });
      await h.queue.sync();
      expect(await pending()).toEqual([]);

      await uninstallPlugin();
      expect(state.extensions.dismissedApprovals).toEqual({});
      await installPlugin();

      expect(await pending()).toEqual([expect.objectContaining({ id: EXT_ID, version: '1.0.0' })]);
    });

    it('asks again after "Stop it", uninstall, and a reinstall at the same version', async () => {
      await installPlugin();
      await request(server).post(`/api/extensions/${EXT_ID}/approve`).send(card());
      await request(server).post(`/api/extensions/${EXT_ID}/revoke`).send({});
      await h.queue.sync();
      expect(await pending()).toEqual([]);

      await uninstallPlugin();
      await installPlugin();

      expect(await pending()).toEqual([expect.objectContaining({ id: EXT_ID, version: '1.0.0' })]);
    });

    it('keeps a "Not now" for a copy outside the package being removed', async () => {
      await installPlugin();
      const [shown] = await pending();
      await request(server)
        .post(`/api/extensions/${EXT_ID}/dismiss-approval`)
        .send({ path: shown.path, version: shown.version });

      await h.manager.forgetRunApproval(EXT_ID, path.join(h.dorkHome, 'plugins', 'other'));

      expect(Object.keys(state.extensions.dismissedApprovals)).toEqual([EXT_ID]);
    });
  });

  describe('approving from a row binds only the copy the row showed', () => {
    it('refuses when another copy took its place, and turns nothing on', async () => {
      await installPlugin();
      const [shown] = await pending();
      await request(server)
        .post(`/api/extensions/${EXT_ID}/dismiss-approval`)
        .send({ path: shown.path, version: shown.version });

      // An agent drops a project copy with the same id and version; discovery
      // lets a project copy stand in for an unapproved global one.
      const project = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-ext-project-'));
      const agentCopy = path.join(project, '.dork', 'extensions', EXT_ID);
      fs.cpSync(extensionDir('flow'), agentCopy, { recursive: true });
      await h.manager.updateCwd(project);
      expect(h.manager.get(EXT_ID)?.path).toBe(agentCopy);

      const res = await request(server).post(`/api/extensions/${EXT_ID}/approve`).send({
        path: shown.path,
        version: shown.version,
        plugin: shown.plugin,
        expectedDigest: shown.digest,
      });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('stale_approval');
      expect(state.extensions.approvedToRun).not.toContain(EXT_ID);
      expect(state.extensions.approvedSources).toEqual({});
      fs.rmSync(project, { recursive: true, force: true });
    });

    it('binds what the Settings card shows: version and plugin, without a path', async () => {
      await installPlugin();

      const wrong = await request(server)
        .post(`/api/extensions/${EXT_ID}/approve`)
        .send({ version: '9.9.9', plugin: 'flow' });
      expect(wrong.status).toBe(409);
      expect(state.extensions.approvedToRun).toEqual([]);

      const right = await request(server)
        .post(`/api/extensions/${EXT_ID}/approve`)
        .send({ ...card(), plugin: 'flow' });
      expect(right.status).toBe(200);
      expect(state.extensions.approvedToRun).toEqual([EXT_ID]);
    });

    it('refuses a different plugin or version, and approves the exact copy', async () => {
      await installPlugin();
      const [shown] = await pending();

      const wrongPlugin = await request(server)
        .post(`/api/extensions/${EXT_ID}/approve`)
        .send({ path: shown.path, version: shown.version, plugin: 'other' });
      expect(wrongPlugin.status).toBe(409);
      const wrongVersion = await request(server)
        .post(`/api/extensions/${EXT_ID}/approve`)
        .send({ path: shown.path, version: '9.9.9', plugin: shown.plugin });
      expect(wrongVersion.status).toBe(409);
      expect(state.extensions.approvedToRun).toEqual([]);

      const exact = await request(server).post(`/api/extensions/${EXT_ID}/approve`).send({
        path: shown.path,
        version: shown.version,
        plugin: shown.plugin,
        expectedDigest: shown.digest,
      });
      expect(exact.status).toBe(200);
      expect(state.extensions.approvedToRun).toEqual([EXT_ID]);
    });
  });

  it('writes no history row for a copy that simply went away', async () => {
    await installPlugin();

    fs.rmSync(path.join(h.dorkHome, 'plugins', 'flow'), { recursive: true, force: true });
    await h.manager.reload();
    await h.queue.sync();

    expect(await pending()).toEqual([]);
    expect(historyRows()).toEqual([]);
    expect(broadcasts('standing_resolved')).toHaveLength(1);
  });

  it('never asks about an extension someone turned off', async () => {
    await installPlugin();
    await h.manager.disable(EXT_ID);
    await h.queue.sync();

    expect(await pending()).toEqual([]);
  });

  it('does not re-announce what is already waiting when the server restarts', async () => {
    await installPlugin();
    expect(approvalArrivals()).toHaveLength(1);

    // A fresh process: a new queue over the same manager and config.
    h.stopQueue();
    ({ queue: h.queue, stop: h.stopQueue } = startExtensionApprovalQueue(h.manager));
    await h.queue.sync();
    await h.manager.reload();
    await h.queue.sync();

    expect(approvalArrivals()).toHaveLength(1);
    // …and it still knows the copy, so answering it records the answer.
    await request(server).post(`/api/extensions/${EXT_ID}/approve`).send(card());
    await h.queue.sync();
    expect(historyRows().map((row) => row.outcome)).toEqual(['approved']);
  });

  it('gives an agent the list without any absolute path or home folder', async () => {
    const dir = path.join(h.dorkHome, 'extensions', 'solo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'extension.json'),
      JSON.stringify({ id: 'solo', name: 'Solo', version: '2.0.0' })
    );
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export function activate() {}\n');
    await h.manager.enable('solo');

    const asAgent = await request(server)
      .get('/api/extensions/pending-approvals')
      .set('x-dorkos-agent', 'agent-token-abc');
    expect(asAgent.status).toBe(200);
    const body = JSON.stringify(asAgent.body);
    expect(asAgent.body.approvals).toHaveLength(1);
    expect(asAgent.body.approvals[0].path).toBeUndefined();
    expect(body).not.toContain(h.dorkHome);
    expect(body).not.toContain('~/');

    const [asPerson] = await pending();
    expect(asPerson.path).toBe(dir);
  });

  it('keeps one row per copy across repeated re-scans', async () => {
    await installPlugin();
    await h.manager.reload();
    await h.manager.reload();
    await h.queue.sync();

    expect(approvalArrivals()).toHaveLength(1);
  });
});
