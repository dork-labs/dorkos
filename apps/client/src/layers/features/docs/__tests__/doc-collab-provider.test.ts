/**
 * The live doc provider (DOR-2984) against an in-memory server speaking the
 * same protocol: it syncs both ways, keeps working through a dropped
 * connection, falls back when the server will not serve the doc, and starts
 * over on a fresh copy rather than merging an old one into it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocCollabProvider } from '../model/doc-collab-provider';
import { FakeDocServer, textOf, typeInto } from './fake-doc-server';
import type { Transport } from '@dorkos/shared/transport';

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
    expect(provider.getSnapshot().lostEdits).toBe(0);
  });

  it('reconnects naming its copy, and starts over on a fresh copy without merging the old one in', async () => {
    const server = new FakeDocServer('Old copy.');
    const { provider, transport } = connect(server);
    await vi.waitFor(() => expect(provider.getSnapshot().status).toBe('live'));
    const first = provider.ydoc;

    server.dropAll();
    typeInto(provider.ydoc, 'Typed while away. ');
    server.reload('Fresh copy.');
    await vi.waitFor(() => expect(provider.getSnapshot().status).toBe('live'));

    // It named the copy it held, was told about the fresh one, and came back on it.
    expect(transport.connectDocCollab.mock.calls[1]?.[2]).toEqual({ generation: 'gen-1' });
    expect(transport.connectDocCollab.mock.calls.at(-1)?.[2]).toEqual({
      generation: server.generation,
    });
    expect(provider.getSnapshot().epoch).toBe(1);
    expect(provider.ydoc).not.toBe(first);
    expect(textOf(provider.ydoc)).toContain('Fresh copy.');
    expect(server.text()).not.toContain('Old copy.');
    expect(server.text()).not.toContain('Typed while away.');
    // The words typed away are not dropped silently: the editor is told to keep them.
    expect(provider.getSnapshot().lostEdits).toBe(1);
  });

  it('stops when the server refuses right after a fresh copy was adopted, instead of looping', async () => {
    const server = new FakeDocServer('Old copy.');
    const { provider, transport } = connect(server);
    await vi.waitFor(() => expect(provider.getSnapshot().status).toBe('live'));
    server.dropAll();
    server.reload('Fresh copy.');
    // The reconnect is told about the fresh copy; right after that, Docs are off.
    server.refuseAfterStale = 404;
    await vi.waitFor(() => expect(provider.getSnapshot().status).toBe('unavailable'));
    expect(provider.getSnapshot().epoch).toBe(1);
    const calls = transport.connectDocCollab.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(transport.connectDocCollab.mock.calls.length).toBe(calls);
    expect(calls).toBeLessThanOrEqual(4);
  });

  it('backs off when the server is down after a fresh copy was adopted', async () => {
    const server = new FakeDocServer('Old copy.');
    const transport = server.transport();
    const provider = new DocCollabProvider({ transport, doc, baseDelayMs: 100, maxDelayMs: 100 });
    providers.push(provider);
    await vi.waitFor(() => expect(provider.getSnapshot().status).toBe('live'));
    server.dropAll();
    server.reload('Fresh copy.');
    server.muted = true;
    // A server that is down: every connection opens and closes at once.
    const realConnect =
      transport.connectDocCollab.getMockImplementation() as Transport['connectDocCollab'];
    transport.connectDocCollab.mockImplementation((ref, handlers, options) => {
      if (!server.muted) return realConnect(ref, handlers, options);
      queueMicrotask(() => handlers.onClose({}));
      return { send: vi.fn(), close: vi.fn() };
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    // Backoff of 100 ms: a handful of attempts, never a tight loop.
    expect(transport.connectDocCollab.mock.calls.length).toBeLessThan(10);
  });

  it('does not count edits the file already has as lost when a fresh copy arrives', async () => {
    const server = new FakeDocServer('Old copy.');
    const { provider } = connect(server);
    await vi.waitFor(() => expect(provider.getSnapshot().status).toBe('live'));
    typeInto(provider.ydoc, 'Saved words. ');
    expect(provider.getSnapshot().ownEditsUnsaved).toBe(true);
    server.save('h-after');
    expect(provider.getSnapshot()).toMatchObject({ ownEditsUnsaved: false, savedHash: 'h-after' });

    server.dropAll();
    server.reload('Fresh copy.');
    await vi.waitFor(() => expect(provider.getSnapshot().epoch).toBe(1));
    expect(provider.getSnapshot().lostEdits).toBe(0);
  });

  it('gives a large first sync all the time it needs once the server said hello', async () => {
    const server = new FakeDocServer('A large doc.');
    server.syncDelayMs = 200;
    const provider = new DocCollabProvider({
      transport: server.transport(),
      doc,
      connectTimeoutMs: 50,
    });
    providers.push(provider);
    await vi.waitFor(() => expect(provider.getSnapshot().status).toBe('live'));
    expect(textOf(provider.ydoc)).toContain('A large doc.');
  });

  it('is not synced on a fresh copy until the server has sent it', async () => {
    const server = new FakeDocServer('Body.');
    const { provider } = connect(server);
    expect(provider.getSnapshot().synced).toBe(false);
    await vi.waitFor(() => expect(provider.getSnapshot().synced).toBe(true));
  });

  it('notices a connection that went silent and reconnects', async () => {
    const server = new FakeDocServer('x');
    const transport = server.transport();
    const provider = new DocCollabProvider({
      transport,
      doc,
      // Slow enough that the line is back before the retry: a retry into a
      // still-dead line would wait out the connect timeout instead.
      baseDelayMs: 300,
      maxDelayMs: 300,
      silenceTimeoutMs: 60,
    });
    providers.push(provider);
    await vi.waitFor(() => expect(provider.getSnapshot().status).toBe('live'));
    server.muted = true;
    await vi.waitFor(() => expect(provider.getSnapshot().status).toBe('reconnecting'));
    server.muted = false;
    await vi.waitFor(() => expect(provider.getSnapshot().status).toBe('live'));
    expect(transport.connectDocCollab.mock.calls.length).toBeGreaterThan(1);
  });

  it('sends nothing until the server’s hello confirms the copy it holds', async () => {
    const server = new FakeDocServer('x');
    const sent: Uint8Array[] = [];
    const real = server.transport();
    const transport = {
      connectDocCollab: vi.fn((ref, handlers, options) => {
        const connection = real.connectDocCollab(ref, handlers, options);
        return {
          ...connection,
          send: (frame: Uint8Array) => (sent.push(frame), connection.send(frame)),
        };
      }),
    };
    const provider = new DocCollabProvider({ transport, doc });
    providers.push(provider);
    typeInto(provider.ydoc, 'Before the hello. ');
    expect(sent).toEqual([]);
    await vi.waitFor(() => expect(provider.getSnapshot().status).toBe('live'));
    expect(server.text()).toContain('Before the hello.');
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
