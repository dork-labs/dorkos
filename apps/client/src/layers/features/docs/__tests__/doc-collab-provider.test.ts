/**
 * The live doc provider (DOR-2984) against an in-memory server speaking the
 * same protocol: it syncs both ways, keeps working through a dropped
 * connection, falls back when the server will not serve the doc, and starts
 * over on a fresh copy rather than merging an old one into it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocCollabProvider } from '../model/doc-collab-provider';
import { FakeDocServer, textOf, typeInto } from './fake-doc-server';

const doc = { cwd: '/work', path: 'plan.md' };
const providers: DocCollabProvider[] = [];

function connect(server: FakeDocServer) {
  const transport = server.transport();
  const provider = new DocCollabProvider({ transport, doc, baseDelayMs: 10, maxDelayMs: 40 });
  providers.push(provider);
  return { provider, transport };
}

afterEach(() => {
  for (const provider of providers.splice(0)) provider.destroy();
});

describe('DocCollabProvider', () => {
  it('syncs the server’s doc, and sends local typing back', async () => {
    const server = new FakeDocServer('From the file.');
    const { provider } = connect(server);
    expect(provider.getSnapshot().status).toBe('connecting');
    await vi.waitFor(() => expect(provider.getSnapshot().status).toBe('live'));
    expect(textOf(provider.ydoc)).toContain('From the file.');

    typeInto(provider.ydoc, 'Typed. ');
    expect(server.text()).toContain('Typed. ');
  });

  it('gives up at once when the server refuses the doc, so the editor can fall back', async () => {
    const server = new FakeDocServer('x');
    server.refuseWith = 404;
    const { provider, transport } = connect(server);
    await vi.waitFor(() => expect(provider.getSnapshot().status).toBe('unavailable'));
    expect(transport.connectDocCollab).toHaveBeenCalledTimes(1);
  });

  it('gives up after a few failed attempts when it never synced', async () => {
    const server = new FakeDocServer('x');
    const transport = {
      connectDocCollab: vi.fn((_doc, handlers) => {
        queueMicrotask(() => handlers.onClose({}));
        return { send: vi.fn(), close: vi.fn() };
      }),
    };
    const provider = new DocCollabProvider({ transport, doc, baseDelayMs: 5, maxDelayMs: 5 });
    providers.push(provider);
    await vi.waitFor(() => expect(provider.getSnapshot().status).toBe('unavailable'));
    expect(transport.connectDocCollab).toHaveBeenCalledTimes(3);
    expect(server.peers.size).toBe(0);
  });

  it('keeps typing through a dropped connection, and sends it on reconnect', async () => {
    const server = new FakeDocServer('Start.');
    const { provider } = connect(server);
    await vi.waitFor(() => expect(provider.getSnapshot().status).toBe('live'));

    server.dropAll();
    expect(provider.getSnapshot().status).toBe('reconnecting');
    typeInto(provider.ydoc, 'Offline words. ');
    expect(server.text()).not.toContain('Offline words.');

    await vi.waitFor(() => expect(provider.getSnapshot().status).toBe('live'));
    expect(server.text()).toContain('Offline words.');
    expect(provider.getSnapshot().offlineEditsLost).toBe(false);
  });

  it('starts over on a fresh copy of the doc instead of merging the old one into it', async () => {
    const server = new FakeDocServer('Old copy.');
    const { provider } = connect(server);
    await vi.waitFor(() => expect(provider.getSnapshot().status).toBe('live'));
    const first = provider.ydoc;

    server.dropAll();
    typeInto(provider.ydoc, 'Typed while away. ');
    server.reload('Fresh copy.');
    await vi.waitFor(() => expect(provider.getSnapshot().status).toBe('live'));

    expect(provider.getSnapshot().epoch).toBe(1);
    expect(provider.ydoc).not.toBe(first);
    expect(textOf(provider.ydoc)).toContain('Fresh copy.');
    // Nothing from the old copy reached the new one.
    expect(server.text()).not.toContain('Old copy.');
    expect(server.text()).not.toContain('Typed while away.');
    expect(provider.getSnapshot().offlineEditsLost).toBe(true);
  });

  it('passes the server’s notes on', async () => {
    const server = new FakeDocServer('x');
    const { provider } = connect(server);
    const notes = vi.fn();
    provider.onNote(notes);
    await vi.waitFor(() => expect(provider.getSnapshot().status).toBe('live'));
    server.note({ type: 'changed', changedBy: { kind: 'agent', name: 'Ada' } });
    expect(notes).toHaveBeenCalledWith({
      type: 'changed',
      changedBy: { kind: 'agent', name: 'Ada' },
    });
  });

  it('shares this person’s presence, and shows others’', async () => {
    const server = new FakeDocServer('x');
    const { provider: mine } = connect(server);
    const { provider: theirs } = connect(server);
    theirs.awareness.setLocalStateField('user', { name: 'Sam', color: '#336699' });
    await vi.waitFor(() => expect(mine.getSnapshot().status).toBe('live'));
    await vi.waitFor(() =>
      expect([...mine.awareness.getStates().values()].map((state) => state.user?.name)).toContain(
        'Sam'
      )
    );
  });
});
