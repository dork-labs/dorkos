/**
 * One directory, several spellings (DOR-695).
 *
 * The sidecar canonicalizes the `directory` it is given on `POST /session` and
 * stores THAT, but filters on the literal string it is given on
 * `GET /session`. Measured against a real `opencode serve` 1.17.13: one
 * project returned 126 sessions through its real path and zero through the
 * symlink form, a trailing slash, or a `..` spelling. On macOS `/tmp` and
 * `/var` are symlinks, so an operator hits this on the first try.
 *
 * These cases run against a fake sidecar that reproduces that asymmetry over a
 * REAL symlinked directory on disk, because that is the whole defect — a fake
 * that filtered leniently, or a temp path with no symlink in it, would pass
 * whatever the adapter did. No live sidecar is involved, and none is needed:
 * the adapter's job is to speak one spelling, and what it sends is observable
 * right here.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdirSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { OpencodeClient, Session as OpenCodeSession } from '@opencode-ai/sdk';
import { OpenCodeRuntime } from '../opencode-runtime.js';
import { sessionInfo } from './opencode-sse-fixtures.js';

// A real directory plus a symlink that reaches it under another name. Built
// inside `vi.hoisted` — not in `beforeAll` — because the `resolve-root` mock
// below has to close over the linked path: `vi.mock` factories are hoisted
// above every module-scope statement, and `DEFAULT_CWD` is a module-level const
// read long before any hook runs.
//
// `realpath` the temp root first: on macOS `os.tmpdir()` is itself under the
// `/var` symlink, and a fixture that is accidentally non-canonical would make
// every assertion below mean something other than what it says.
// The NAMES are computed with nothing but globals, because a `vi.hoisted`
// factory runs before this file's imports are bound; the directories
// themselves are made just below, once `node:fs` is available.
const { ROOT, LINKED_PROJECT } = vi.hoisted(() => {
  const root = `${process.env.TMPDIR?.replace(/\/$/, '') ?? '/tmp'}/dorkos-oc-spelling-${process.pid}`;
  return { ROOT: root, LINKED_PROJECT: `${root}/linked-project` };
});

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(path.join(ROOT, 'real-project'), { recursive: true });
symlinkSync(path.join(ROOT, 'real-project'), LINKED_PROJECT);
/** The temp root as it really is — `os.tmpdir()` is itself under `/var` on macOS. */
const BASE = realpathSync(ROOT);
const REAL_PROJECT = path.join(BASE, 'real-project');

vi.mock('../providers/check-dependencies.js', () => ({
  checkOpenCodeDependencies: vi.fn(() => []),
  resolveOpenCodeBinaryPath: vi.fn(() => null),
  getConnectedOpenCodeProvider: vi.fn(() => null),
}));

// The provider catalog is read at `DEFAULT_CWD`, which is taken verbatim from
// `DORKOS_DEFAULT_CWD`. Pointing it at the SYMLINKED spelling is the only way
// to tell a canonicalized query from a passed-through one — the repo's own
// path has no symlink in it, so the two would be the same string.
vi.mock('../../../../lib/resolve-root.js', () => ({ DEFAULT_CWD: LINKED_PROJECT }));

vi.mock('../providers/ollama.js', () => ({
  detectOllama: vi.fn(async () => ({ running: false, models: [] })),
}));

const SESSION_ID = '3f2b8c1e-9d4a-4b6f-8a1c-2e5d7f9b0a3c';

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/**
 * A sidecar that behaves the way the real one was measured to behave: it
 * canonicalizes the directory it STORES, and answers a listing only for the
 * literal string it is GIVEN.
 *
 * Its listing deliberately OVER-returns, by raw string prefix. The adapter
 * asks at `scope: 'project'` precisely because `?directory=` alone matches one
 * exact folder and a project's sessions live in its subfolders too (DOR-674),
 * so a fake that returned only exact matches would let a naive `startsWith`
 * membership rule pass — the row it should reject would never arrive. This
 * over-return is what makes the adapter's own narrowing observable.
 *
 * `limit` is honoured, because the adapter probes for exactly that and rejects
 * a listing from a sidecar that ignores it.
 */
function createSidecarFake(seed: OpenCodeSession[] = []) {
  const stored = [...seed];
  let nextId = 0;
  const client = {
    global: { event: vi.fn(async () => ({ stream: (async function* () {})() })) },
    session: {
      create: vi.fn(async ({ query }: { query: { directory: string } }) => {
        nextId += 1;
        const created = sessionInfo(`ses_created${nextId}`, realpathSync(query.directory));
        stored.push(created);
        return { data: created };
      }),
      list: vi.fn(async ({ query }: { query: { directory: string; limit?: number } }) => {
        const matched = stored.filter((session) => session.directory.startsWith(query.directory));
        return { data: query.limit === undefined ? matched : matched.slice(0, query.limit) };
      }),
      get: vi.fn(async () => ({ data: undefined })),
      messages: vi.fn(async () => ({ data: [] })),
      update: vi.fn(async () => ({ data: stored[0] })),
    },
    provider: { list: vi.fn(async () => ({ data: { all: [], default: {}, connected: [] } })) },
  };
  return { client, stored };
}

type SidecarFake = ReturnType<typeof createSidecarFake>['client'];

function createRuntime(client: SidecarFake | null) {
  return new OpenCodeRuntime({
    provider: {
      getClient: vi.fn(async () => {
        if (!client) throw new Error('sidecar unavailable');
        return client as unknown as OpencodeClient;
      }),
      peekClient: vi.fn(() => (client ? (client as unknown as OpencodeClient) : null)),
    },
  });
}

describe('OpenCode sessions across directory spellings (DOR-695)', () => {
  it('has a fixture whose two spellings really are one folder', () => {
    // If this ever stops holding, every case below is asserting nothing.
    expect(LINKED_PROJECT).not.toBe(REAL_PROJECT);
    expect(realpathSync(LINKED_PROJECT)).toBe(REAL_PROJECT);
  });

  it('lists a stored session through the symlinked spelling of its directory', async () => {
    const { client } = createSidecarFake([sessionInfo('ses_stored1', REAL_PROJECT)]);
    const runtime = createRuntime(client);

    const sessions = await runtime.listSessions(LINKED_PROJECT);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.cwd).toBe(REAL_PROJECT);
  });

  it('lists a stored session through a trailing-slash and a `..` spelling', async () => {
    const { client } = createSidecarFake([sessionInfo('ses_stored1', REAL_PROJECT)]);
    const runtime = createRuntime(client);

    await expect(runtime.listSessions(`${LINKED_PROJECT}/`)).resolves.toHaveLength(1);
    await expect(
      runtime.listSessions(path.join(REAL_PROJECT, 'packages', '..'))
    ).resolves.toHaveLength(1);
  });

  it('finds a session again through the exact path that created it', async () => {
    const { client, stored } = createSidecarFake();
    const creator = createRuntime(client);
    creator.ensureSession(SESSION_ID, { permissionMode: 'default', cwd: LINKED_PROJECT });
    await vi.waitFor(() => expect(client.session.create).toHaveBeenCalled());
    // The sidecar stored the REAL path, not the one it was handed — the
    // asymmetry this whole defect rests on.
    expect(stored[0]?.directory).toBe(REAL_PROJECT);

    // A FRESH runtime, so the answer comes from the sidecar rather than from
    // the in-memory registry: this is the session an operator sees after a
    // restart, or one started from the OpenCode TUI.
    const sessions = await createRuntime(client).listSessions(LINKED_PROJECT);

    expect(sessions).toHaveLength(1);
  });

  it('rebuilds a lost binding for a history read asked through the symlink', async () => {
    // `getMessageHistory` re-lists to recover a binding it does not hold
    // (post-restart, or a session DorkOS never created). That read carries
    // `?directory=` too, so the symlinked spelling recovered nothing and the
    // history quietly degraded to the DorkOS-side event log.
    const { client } = createSidecarFake([sessionInfo('ses_stored1', REAL_PROJECT)]);
    const knownId = (await createRuntime(client).listSessions(REAL_PROJECT))[0]!.id;

    const fresh = createRuntime(client);
    await fresh.getMessageHistory(LINKED_PROJECT, knownId);

    expect(client.session.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ directory: REAL_PROJECT }) })
    );
    // Reached only once the binding was rebuilt — the log-backed fallback
    // never touches the sidecar, so this is what separates "recovered" from
    // "degraded quietly".
    expect(client.session.messages).toHaveBeenCalledWith({ path: { id: 'ses_stored1' } });
  });

  it('reads the provider catalog at the canonical spelling of DEFAULT_CWD', async () => {
    const { client } = createSidecarFake();

    await createRuntime(client).getSupportedModels();

    expect(client.provider.list).toHaveBeenCalledWith({ query: { directory: REAL_PROJECT } });
  });

  it('keeps listing sessions through the canonical spelling', async () => {
    const { client } = createSidecarFake([sessionInfo('ses_stored1', REAL_PROJECT)]);
    const runtime = createRuntime(client);

    // The spelling that worked before this fix has to keep working: every
    // session already on disk was stored under it.
    await expect(runtime.listSessions(REAL_PROJECT)).resolves.toHaveLength(1);
  });

  it('keeps a tracked session listed under the spelling that registered it', async () => {
    // The cold-sidecar half: `listSessions` never boots one, so this session is
    // known only to the in-memory registry, which holds the cwd whoever created
    // it used. Asking in the other spelling must not lose it.
    const runtime = createRuntime(null);
    runtime.ensureSession(SESSION_ID, { permissionMode: 'default', cwd: LINKED_PROJECT });

    await expect(runtime.listSessions(LINKED_PROJECT)).resolves.toHaveLength(1);
    await expect(runtime.listSessions(REAL_PROJECT)).resolves.toHaveLength(1);
  });

  it('still refuses a relative directory instead of quietly matching nothing', async () => {
    const { client } = createSidecarFake();
    await expect(createRuntime(client).listSessions('relative/project')).rejects.toThrow(
      /needs a full folder path/
    );
  });

  it('does not gather a sibling directory that merely shares a name prefix', async () => {
    // The sidecar DOES hand this row over — its listing widens past the exact
    // directory — so rejecting it is the adapter's own work, and a membership
    // rule written with `startsWith` would keep it.
    const sibling = path.join(BASE, 'real-project-2');
    mkdirSync(sibling, { recursive: true });
    const { client } = createSidecarFake([sessionInfo('ses_sibling', sibling)]);

    const sessions = await createRuntime(client).listSessions(LINKED_PROJECT);

    await expect(client.session.list.mock.results[0]?.value).resolves.toEqual({
      data: [expect.objectContaining({ id: 'ses_sibling' })],
    });
    expect(sessions).toEqual([]);
  });
});
