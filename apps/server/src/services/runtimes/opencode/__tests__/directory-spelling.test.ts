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
 * These cases run against a fake sidecar that reproduces exactly that
 * asymmetry over a REAL symlinked directory on disk, because that is the whole
 * defect — a fake that filtered leniently, or a temp path with no symlink in
 * it, would pass whatever the adapter did. No live sidecar is involved, and
 * none is needed: the adapter's job is to speak one spelling, and what it
 * sends is observable right here.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, symlink, rm, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OpencodeClient, Session as OpenCodeSession } from '@opencode-ai/sdk';
import { OpenCodeRuntime } from '../opencode-runtime.js';
import { canonicalDirectory } from '../canonical-directory.js';
import { sessionInfo } from './opencode-sse-fixtures.js';

vi.mock('../providers/check-dependencies.js', () => ({
  checkOpenCodeDependencies: vi.fn(() => []),
  resolveOpenCodeBinaryPath: vi.fn(() => null),
  getConnectedOpenCodeProvider: vi.fn(() => null),
}));

const SESSION_ID = '3f2b8c1e-9d4a-4b6f-8a1c-2e5d7f9b0a3c';

/** A real directory plus a symlink that reaches it under another name. */
let base: string;
let realProject: string;
let linkedProject: string;

beforeAll(async () => {
  // `realpath` the temp root first: on macOS `os.tmpdir()` is itself under the
  // `/var` symlink, and a fixture that is accidentally non-canonical would
  // make every assertion below mean something other than what it says.
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dorkos-oc-spelling-')));
  realProject = path.join(base, 'real-project');
  await mkdir(realProject);
  linkedProject = path.join(base, 'linked-project');
  await symlink(realProject, linkedProject);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/**
 * A sidecar that behaves the way the real one was measured to behave: it
 * canonicalizes the directory it STORES and filters on the literal string it
 * is GIVEN. `limit` is honoured, because the adapter probes for exactly that
 * and rejects a listing from a sidecar that ignores it.
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
        const matched = stored.filter((session) => session.directory === query.directory);
        return { data: query.limit === undefined ? matched : matched.slice(0, query.limit) };
      }),
      get: vi.fn(async () => ({ data: undefined })),
      messages: vi.fn(async () => ({ data: [] })),
      update: vi.fn(async () => ({ data: stored[0] })),
    },
  };
  return { client, stored };
}

function createRuntime(client: ReturnType<typeof createSidecarFake>['client']) {
  return new OpenCodeRuntime({
    provider: {
      getClient: vi.fn(async () => client as unknown as OpencodeClient),
      peekClient: vi.fn(() => client as unknown as OpencodeClient),
    },
  });
}

describe('canonicalDirectory', () => {
  it('resolves a symlinked directory to the path the sidecar stores', () => {
    expect(canonicalDirectory(linkedProject)).toBe(realProject);
  });

  it('collapses a trailing separator and a `..` hop', () => {
    expect(canonicalDirectory(`${realProject}/`)).toBe(realProject);
    expect(canonicalDirectory(path.join(realProject, 'nowhere', '..'))).toBe(realProject);
  });

  it('normalizes a directory that does not exist rather than throwing', () => {
    const missing = path.join(base, 'not-created', 'sub', '..');
    expect(canonicalDirectory(missing)).toBe(path.join(base, 'not-created'));
  });

  it('leaves a relative path alone, so the listing can still reject it', () => {
    expect(canonicalDirectory('relative/project')).toBe('relative/project');
  });
});

describe('OpenCode sessions across directory spellings (DOR-695)', () => {
  it('lists a stored session through the symlinked spelling of its directory', async () => {
    const { client } = createSidecarFake([sessionInfo('ses_stored1', realProject)]);
    const runtime = createRuntime(client);

    const sessions = await runtime.listSessions(linkedProject);

    expect(sessions.map((session) => session.id)).toHaveLength(1);
    expect(sessions[0]?.cwd).toBe(realProject);
  });

  it('lists a stored session through a trailing-slash and a `..` spelling', async () => {
    const { client } = createSidecarFake([sessionInfo('ses_stored1', realProject)]);
    const runtime = createRuntime(client);

    await expect(runtime.listSessions(`${linkedProject}/`)).resolves.toHaveLength(1);
    await expect(
      runtime.listSessions(path.join(realProject, 'packages', '..'))
    ).resolves.toHaveLength(1);
  });

  it('finds a session again through the exact path that created it', async () => {
    const { client, stored } = createSidecarFake();
    const creator = createRuntime(client);
    creator.ensureSession(SESSION_ID, { permissionMode: 'default', cwd: linkedProject });
    await vi.waitFor(() => expect(client.session.create).toHaveBeenCalled());
    // The sidecar stored the REAL path, not the one it was handed — the
    // asymmetry this whole defect rests on.
    expect(stored[0]?.directory).toBe(realProject);

    // A FRESH runtime, so the answer comes from the sidecar rather than from
    // the in-memory registry: this is the session an operator sees after a
    // restart, or one started from the OpenCode TUI.
    const sessions = await createRuntime(client).listSessions(linkedProject);

    expect(sessions).toHaveLength(1);
  });

  it('keeps listing sessions through the canonical spelling', async () => {
    const { client } = createSidecarFake([sessionInfo('ses_stored1', realProject)]);
    const runtime = createRuntime(client);

    // The spelling that worked before this fix has to keep working: every
    // session already on disk was stored under it.
    await expect(runtime.listSessions(realProject)).resolves.toHaveLength(1);
  });

  it('keeps a tracked session listed under the spelling that registered it', async () => {
    // The cold-sidecar half: `listSessions` never boots one, so this session is
    // known only to the in-memory registry, which holds the cwd whoever created
    // it used. Asking in the other spelling must not lose it.
    const runtime = new OpenCodeRuntime({
      provider: {
        getClient: vi.fn(async () => {
          throw new Error('sidecar unavailable');
        }),
        peekClient: vi.fn(() => null),
      },
    });
    runtime.ensureSession(SESSION_ID, { permissionMode: 'default', cwd: linkedProject });

    await expect(runtime.listSessions(linkedProject)).resolves.toHaveLength(1);
    await expect(runtime.listSessions(realProject)).resolves.toHaveLength(1);
  });

  it('still refuses a relative directory instead of quietly matching nothing', async () => {
    const { client } = createSidecarFake();
    await expect(createRuntime(client).listSessions('relative/project')).rejects.toThrow(
      /needs a full folder path/
    );
  });

  it('does not gather a sibling directory that merely shares a name prefix', async () => {
    const sibling = path.join(base, 'real-project-2');
    await mkdir(sibling, { recursive: true });
    const { client } = createSidecarFake([sessionInfo('ses_sibling', sibling)]);

    await expect(createRuntime(client).listSessions(linkedProject)).resolves.toEqual([]);
  });
});
