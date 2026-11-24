import { state, h, server, EXT_ID, HERE, installPlugin, card, pending } from './harness.js';
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from '@dorkos/test-utils/supertest';
import { APPROVAL_WHY_MAX_LENGTH } from '../../extension-approval-queue.js';

describe('what it would give agents (DOR-2685)', () => {
  /**
   * Install a direct copy that declares tools and skills, then ask what is
   * waiting. A person decides on the row, so each tool, its tier and every
   * refusal has to be on it before the extension has run at all.
   */
  async function installWithTools(): Promise<Record<string, unknown>> {
    const fixture = path.resolve(HERE, '../__fixtures__/agent-tools-ext');
    const dir = path.join(h.dorkHome, 'extensions', 'agent-tools-ext');
    fs.cpSync(fixture, dir, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'extension.json'), 'utf-8'));
    // One tool DorkOS refuses (an open input schema) and one declared skill
    // with no folder, so the row carries both reasons.
    manifest.tools.push({
      name: 'open_ended',
      title: 'Take anything',
      description: 'Accepts any input at all.',
      tier: 'observe',
      inputSchema: { type: 'object' },
    });
    manifest.skills.push('missing-skill');
    fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest));
    await h.manager.enable('agent-tools-ext');
    await h.queue.sync();
    const approvals = await pending();
    expect(approvals).toHaveLength(1);
    return approvals[0];
  }

  it('lists each tool with its tier, and each skill, before it ever runs', async () => {
    const approval = await installWithTools();

    expect(approval.agentTools).toEqual([
      { name: 'echo', title: 'Echo a message', tier: 'observe' },
      { name: 'bump_counter', title: 'Add to the counter', tier: 'act' },
      { name: 'delete_note', title: 'Delete a note', tier: 'destructive' },
      expect.objectContaining({ name: 'open_ended', refusedReason: expect.any(String) }),
    ]);
    expect(approval.agentSkills).toEqual([
      { name: 'tidy-notes' },
      { name: 'missing-skill', droppedReason: 'Its folder is missing from skills/.' },
    ]);
  });

  it('counts no skill when skills/ links out of the extension, on the row and in Settings', async () => {
    // Projection never links through such a folder, so neither the row nor
    // the card (nor list_extensions, which reads the same record) may count it.
    const fixture = path.resolve(HERE, '../__fixtures__/agent-tools-ext');
    const dir = path.join(h.dorkHome, 'extensions', 'agent-tools-ext');
    fs.cpSync(fixture, dir, { recursive: true });
    const shared = path.join(h.dorkHome, 'shared-skills');
    fs.renameSync(path.join(dir, 'skills'), shared);
    fs.symlinkSync(shared, path.join(dir, 'skills'));
    await h.manager.enable('agent-tools-ext');
    await h.queue.sync();

    const reason = 'It isn’t a plain folder inside the extension’s own skills/ folder.';
    const [approval] = await pending();
    expect(approval.agentSkills).toEqual([{ name: 'tidy-notes', droppedReason: reason }]);
    const record = h.manager.listPublic().find((ext) => ext.id === 'agent-tools-ext');
    expect(record?.skills).toEqual([{ name: 'tidy-notes', status: 'dropped', reason }]);
  });
});

describe('the why line', () => {
  it('names every place it declares, in DorkOS’s words (DOR-4282)', async () => {
    await installPlugin('flow', {
      name: 'Flow',
      contributions: {
        inbox: true,
        'command-palette.items': true,
        dialog: true,
        pages: true,
        'right-panel': true,
        canvas: true,
        'made-up': true,
      },
    });

    const [approval] = await pending();
    expect(approval.adds).toBe(
      'It adds a page, a Flow tab, ⌘K commands, dialogs, canvas documents, and Inbox cards'
    );
    expect((approval.permissions as { slots?: string[] } | undefined)?.slots).toEqual([
      'pages',
      'right-panel',
      'command-palette.items',
      'dialog',
      'canvas',
      'inbox',
    ]);
  });

  it('says only who installed it and that it runs as you when there is nothing else', async () => {
    await installPlugin('flow', { name: 'Flow' });

    const [approval] = await pending();
    expect(approval.why).toBe(
      'You installed the flow plugin from dork-labs/marketplace. It runs as you.'
    );
  });

  it('never claims you installed a plugin the installer has no record of', async () => {
    await installPlugin('flow', { name: 'Flow' }, { throughInstaller: false });

    const [approval] = await pending();
    expect(approval.why).toBe('The flow plugin was added to DorkOS. It runs as you.');
    expect(approval.sourceLabel).toBe('flow plugin · not from the installer');
  });

  it('is cut at 300 characters, whatever the manifest says', async () => {
    await installPlugin('flow', { name: 'Flow', description: 'x'.repeat(400) });

    const [approval] = await pending();
    expect((approval.why as string).length).toBeLessThanOrEqual(APPROVAL_WHY_MAX_LENGTH);
    // The author's part is what gets cut; DorkOS's own words always survive.
    expect(approval.why).toMatch(/^You installed the flow plugin from dork-labs\/marketplace\. /);
    expect(approval.why).toMatch(/… It runs as you\.$/);
  });
});

describe('an app whose only new thing is places keeps running (DOR-4282, option C)', () => {
  /** Narrow the stored yes to these places, as an approval given before they were declared. */
  function approvedOnly(slots: string[]): void {
    const stored = (state.extensions as { approvedPermissions?: Record<string, object> })
      .approvedPermissions;
    state.extensions = {
      ...state.extensions,
      approvedPermissions: { ...stored, [EXT_ID]: { ...stored?.[EXT_ID], slots } },
    } as typeof state.extensions;
  }

  // Purpose: a places-only diff keeps the app running with only its old
  // places; the row asks about the new places alone; allowing stores them.
  it('asks only about the new places, and a yes allows exactly them', async () => {
    await installPlugin('flow', {
      name: 'Flow',
      contributions: { 'right-panel': true, pages: true, dialog: true },
    });
    const first = await request(server).post(`/api/extensions/${EXT_ID}/approve`).send(card());
    expect(first.status).toBe(200);
    approvedOnly(['right-panel']);
    await h.queue.sync();

    const record = h.manager.listPublic().find((ext) => ext.id === EXT_ID)!;
    expect(record.approvedToRun).toBe(true);
    expect(record.allowedSlots).toEqual(['right-panel']);
    const [row] = await pending();
    expect(row).toMatchObject({ id: EXT_ID, placesOnly: true, changedFiles: null });
    expect((row.added as { slots?: string[] }).slots).toEqual(['dialog', 'pages']);

    const again = await request(server).post(`/api/extensions/${EXT_ID}/approve`).send(card());
    expect(again.status).toBe(200);
    await h.queue.sync();
    expect(await pending()).toEqual([]);
    expect(h.manager.listPublic().find((ext) => ext.id === EXT_ID)?.allowedSlots).toEqual([
      'pages',
      'right-panel',
      'dialog',
    ]);
  });

  // Purpose: "Not now" leaves it running without the new places.
  it('keeps running without the new places after "Not now"', async () => {
    await installPlugin('flow', {
      name: 'Flow',
      contributions: { 'right-panel': true, pages: true },
    });
    await request(server).post(`/api/extensions/${EXT_ID}/approve`).send(card());
    approvedOnly(['right-panel']);
    await h.queue.sync();
    const [row] = await pending();

    const res = await request(server)
      .post(`/api/extensions/${EXT_ID}/dismiss-approval`)
      .send({ path: row.path, version: row.version });
    expect(res.status).toBe(204);
    await h.queue.sync();

    expect(await pending()).toEqual([]);
    const record = h.manager.listPublic().find((ext) => ext.id === EXT_ID)!;
    expect(record.approvedToRun).toBe(true);
    expect(record.allowedSlots).toEqual(['right-panel']);
  });
});
