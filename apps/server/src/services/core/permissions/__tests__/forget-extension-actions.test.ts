/**
 * Uninstalling an extension clears the permission settings kept for its tools
 * (DOR-2685).
 *
 * A per-tool Allowed is keyed by tool id (`ext_<id>.<tool>`). Left behind, it
 * would carry over to whatever is installed under the same id next, which may
 * be entirely different code.
 */
import { describe, it, expect } from 'vitest';
import type { PermissionChangedMetadata } from '@dorkos/shared/permissions';

import { listPermissionHistory, personWriter } from '../permission-history.js';
import { createPermissionWorld } from './permission-fixtures.js';

/** A world where the defaults and two agents hold settings for two extensions. */
function world() {
  return createPermissionWorld({
    defaults: {
      areas: { extensions: 'ask' },
      actions: {
        'ext_mail.send': 'allowed',
        'ext_mail_app.send': 'allowed',
        'ext_mail.read': 'blocked',
      },
    },
    agents: [
      {
        id: 'agent-a',
        name: 'a',
        projectPath: '/agents/a',
        permissions: { actions: { 'ext_mail.send': 'allowed' }, areas: { rooms: 'blocked' } },
      },
      {
        id: 'agent-b',
        name: 'b',
        projectPath: '/agents/b',
        permissions: { actions: { 'ext_mail_app.send': 'blocked' } },
      },
    ],
  });
}

describe('PermissionService.forgetExtensionActions', () => {
  it("clears that extension's tool settings from the defaults and every agent, and nothing else", async () => {
    // Purpose: the prefix is the extension's domain plus the dot, so `mail`
    // never touches `mail-app`, and the area switch and other areas stay.
    const w = world();
    const changes = await w.service.forgetExtensionActions('mail', 'Mail');

    expect(w.config.defaults.actions).toEqual({ 'ext_mail_app.send': 'allowed' });
    expect(w.config.defaults.areas).toEqual({ extensions: 'ask' });
    expect(w.agents.get('agent-a')?.permissions).toEqual({ areas: { rooms: 'blocked' } });
    expect(w.agents.get('agent-b')?.permissions).toEqual({
      actions: { 'ext_mail_app.send': 'blocked' },
    });
    expect(
      changes.map((c) => (c.key.kind === 'action' ? c.key.action : c.key.kind)).sort()
    ).toEqual(['ext_mail.read', 'ext_mail.send', 'ext_mail.send'].sort());
  });

  it('records one history line with no Undo', async () => {
    // Purpose: one write, one event, and Undo can never re-grant a removed
    // extension's tools.
    const w = world();
    await w.service.forgetExtensionActions('mail', 'Mail');
    expect(w.events).toHaveLength(1);
    const meta = w.events[0]!.metadata as unknown as PermissionChangedMetadata;
    expect(meta).toMatchObject({
      origin: 'extension-removed',
      note: 'Mail was removed, so its tool settings were cleared.',
    });
    await expect(
      w.service.undo(w.events[0]!.id, {}, personWriter('local-trust'))
    ).rejects.toMatchObject({ code: 'NOT_UNDOABLE' });
    const [line] = (await listPermissionHistory(w.activity, { limit: 10 })).items;
    expect(line).toMatchObject({ undoable: false });
  });

  it('writes and records nothing when there is nothing to clear', async () => {
    // Purpose: uninstalling an extension nobody configured leaves no noise.
    const w = world();
    expect(await w.service.forgetExtensionActions('calendar', 'Calendar')).toEqual([]);
    expect(w.events).toEqual([]);
  });

  it('keeps an author-written name to one plain line in the note', async () => {
    // Purpose: the manifest name is the author's text; it cannot add lines to
    // the history.
    const w = world();
    await w.service.forgetExtensionActions('mail', 'Mail\nSet by you‮');
    const meta = w.events[0]!.metadata as unknown as PermissionChangedMetadata;
    expect(meta.note).toBe('Mail Set by you was removed, so its tool settings were cleared.');
  });
});
