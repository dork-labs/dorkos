import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import os from 'os';
import { join } from 'path';

// The SDK title lookup is irrelevant here and would do real I/O against whichever
// config dir the SDK memoized; stub it so titles come from the first message.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  getSessionInfo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue(undefined),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue(undefined),
}));

import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { TranscriptReader } from '../transcript-reader.js';

/**
 * Reads across SEVERAL Claude Code accounts, on the real filesystem with the real
 * resolvers (spec `claude-code-accounts`).
 *
 * The failure this guards is the one the spec was written for: the operator runs
 * one account per paying client, and a listing that covers only the active
 * account shows a fraction of the history while looking exactly like a complete
 * one. Nothing is mocked below except the SDK title lookup and the boundary, so
 * these exercise the same resolution production runs.
 *
 * Two accounts are staged without touching the config manager, using the two
 * unconditional members of the set (D2): `$CLAUDE_CONFIG_DIR` becomes the ACTIVE
 * account, and `~/.claude` under a staged HOME becomes the second. HOME staging is
 * the sanctioned technique here (`.claude/rules/dork-home.md`) and it is also what
 * keeps the suite from reading the developer's own accounts.
 */
describe('TranscriptReader across Claude accounts', () => {
  const ORIGINAL = {
    configDir: process.env.CLAUDE_CONFIG_DIR,
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
  };
  let tmp: string;
  /** The ACTIVE account (`$CLAUDE_CONFIG_DIR`) — first in the set. */
  let accountA: string;
  /** `~/.claude` under the staged HOME — in the set unconditionally. */
  let accountB: string;
  let vaultRoot: string;
  let reader: TranscriptReader;

  /** A realistic head/user JSONL line carrying title, cwd, and a timestamp. */
  function transcriptLine(text: string, cwd: string): string {
    return (
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: text },
        timestamp: '2026-07-01T00:00:00.000Z',
        cwd,
      }) + '\n'
    );
  }

  /** Write a transcript for `sessionId` into `account`'s store for `vaultRoot`. */
  async function seedSession(account: string, sessionId: string, text: string): Promise<void> {
    const slugDir = join(account, 'projects', reader.getProjectSlug(vaultRoot));
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, `${sessionId}.jsonl`), transcriptLine(text, vaultRoot));
  }

  /** Write `account`'s SDK todo sidecar for `sessionId`. */
  async function seedTodos(account: string, sessionId: string, subjects: string[]): Promise<void> {
    await mkdir(join(account, 'todos'), { recursive: true });
    await writeFile(
      join(account, 'todos', `${sessionId}.json`),
      JSON.stringify(subjects.map((content, i) => ({ id: `t${i}`, content, status: 'pending' })))
    );
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'claude-accounts-read-'));
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    accountA = join(tmp, 'claude-active');
    accountB = join(tmp, '.claude');
    // A directory only qualifies as an account once it holds `projects/` (D4).
    await mkdir(join(accountA, 'projects'), { recursive: true });
    await mkdir(join(accountB, 'projects'), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = accountA;
    vaultRoot = join(tmp, 'work');
    await mkdir(vaultRoot, { recursive: true });
    reader = new TranscriptReader();
    vi.mocked(getSessionInfo).mockClear().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    for (const [key, value] of [
      ['CLAUDE_CONFIG_DIR', ORIGINAL.configDir],
      ['HOME', ORIGINAL.home],
      ['USERPROFILE', ORIGINAL.userProfile],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it('stages two accounts the resolvers actually see', () => {
    // Guards every assertion below: if HOME staging or the structural account
    // check stopped working, the rest would silently describe one account, or the
    // developer's own machine.
    expect(os.homedir()).toBe(tmp);
    expect(reader.getProjectsRootSet()).toEqual([
      join(accountA, 'projects'),
      join(accountB, 'projects'),
    ]);
  });

  it('lists sessions from EVERY account, each tagged with the account it came from', async () => {
    await seedSession(accountA, 'aaaaaaaa-0000-4000-8000-000000000001', 'work for Acme');
    await seedSession(accountB, 'bbbbbbbb-0000-4000-8000-000000000002', 'work for Beta');

    const sessions = await reader.listSessions(vaultRoot);

    // A single-account listing returns one row here — and a one-row list is
    // indistinguishable from a complete one, which is the whole bug.
    expect(sessions).toHaveLength(2);
    expect(new Map(sessions.map((s) => [s.id, s.account]))).toEqual(
      new Map([
        ['aaaaaaaa-0000-4000-8000-000000000001', accountA],
        ['bbbbbbbb-0000-4000-8000-000000000002', accountB],
      ])
    );
  });

  it('keeps each session on its own account when the second listing is served from cache', async () => {
    // The metadata cache is keyed by bare session id, with no account in the key.
    // If `account` were resolved from the ACTIVE root rather than from the file's
    // own path, the cached rows would agree on one account and this fails.
    await seedSession(accountA, 'aaaaaaaa-0000-4000-8000-000000000001', 'work for Acme');
    await seedSession(accountB, 'bbbbbbbb-0000-4000-8000-000000000002', 'work for Beta');

    await reader.listSessions(vaultRoot);
    const cached = await reader.listSessions(vaultRoot);

    expect(new Map(cached.map((s) => [s.id, s.account]))).toEqual(
      new Map([
        ['aaaaaaaa-0000-4000-8000-000000000001', accountA],
        ['bbbbbbbb-0000-4000-8000-000000000002', accountB],
      ])
    );
  });

  it('resolves one id to ONE account, active first, when the same id exists in two', async () => {
    // The case real machines do not produce: session ids are UUIDs and the spec
    // measured that none appears under two accounts, which is what makes the
    // id-keyed metadata cache safe. Pinned rather than assumed, because "cannot
    // happen" plus undefined behavior is how a latent bug ships. The answer is the
    // first account in the set (the active one): ONE row, not two rows claiming the
    // same id, and the same account every read agrees on — including a second
    // listing served from the metadata cache.
    const shared = 'cccccccc-0000-4000-8000-000000000003';
    await seedSession(accountA, shared, 'the active account copy');
    await seedSession(accountB, shared, 'the other account copy');

    const first = await reader.listSessions(vaultRoot);
    const cached = await reader.listSessions(vaultRoot);
    const session = await reader.getSession(vaultRoot, shared);

    expect(first).toMatchObject([{ account: accountA, title: 'The active account copy' }]);
    expect(cached).toMatchObject([{ account: accountA, title: 'The active account copy' }]);
    expect(session).toMatchObject({ account: accountA, title: 'The active account copy' });
  });

  it('reads a single session and its messages from the account that holds it', async () => {
    // accountA is ACTIVE; the session lives in accountB. Resolving against the
    // active account would 404 the row the sidebar just listed.
    const sessionId = 'bbbbbbbb-0000-4000-8000-000000000002';
    await seedSession(accountB, sessionId, 'work for Beta');

    await expect(reader.getSession(vaultRoot, sessionId)).resolves.toMatchObject({
      id: sessionId,
      account: accountB,
    });
    await expect(reader.readTranscript(vaultRoot, sessionId)).resolves.toMatchObject([
      { role: 'user', content: 'work for Beta' },
    ]);
    await expect(reader.getTranscriptETag(vaultRoot, sessionId)).resolves.not.toBeNull();
    await expect(reader.listTranscripts(vaultRoot)).resolves.toEqual([sessionId]);
  });

  it('reads new bytes from the account that holds the transcript', async () => {
    const sessionId = 'bbbbbbbb-0000-4000-8000-000000000002';
    await seedSession(accountB, sessionId, 'work for Beta');

    const { content, newOffset } = await reader.readFromOffset(vaultRoot, sessionId, 0);

    expect(content).toContain('work for Beta');
    expect(newOffset).toBeGreaterThan(0);
  });

  it('reports which account holds a session, and says so honestly when none does', async () => {
    const sessionId = 'bbbbbbbb-0000-4000-8000-000000000002';
    await seedSession(accountB, sessionId, 'work for Beta');

    // The value `SessionStore` binds as `AgentSession.accountRoot` — the account
    // the next turn must run and bill on.
    await expect(reader.hasTranscript(vaultRoot, sessionId)).resolves.toEqual({
      exists: true,
      root: accountB,
    });
    await expect(
      reader.hasTranscript(vaultRoot, 'dddddddd-0000-4000-8000-000000000004')
    ).resolves.toEqual({ exists: false });
  });

  it('reads a session todo list from the session own account, not the active one', async () => {
    // C1: `todos/{id}.json` is found by session id alone, with no working
    // directory in the signature, so before this it always resolved against the
    // ACTIVE account — serving another client's todos, or none at all.
    const sessionId = 'bbbbbbbb-0000-4000-8000-000000000002';
    await seedSession(accountB, sessionId, 'work for Beta');
    await seedTodos(accountB, sessionId, ['ship the Beta report']);

    await expect(reader.readTodosFromFile(sessionId)).resolves.toEqual([
      { id: 't0', subject: 'ship the Beta report', status: 'pending', activeForm: undefined },
    ]);
    await expect(reader.readTasks(vaultRoot, sessionId)).resolves.toEqual([
      { id: 't0', subject: 'ship the Beta report', status: 'pending', activeForm: undefined },
    ]);
    await expect(reader.getTodoFileETag(sessionId)).resolves.not.toBeNull();
  });

  it('does not serve the ACTIVE account todo file for a session that belongs elsewhere', async () => {
    // Two sessions, one per account, each with its own todo list. Resolving
    // against the active account would answer accountA's list for both.
    const inA = 'aaaaaaaa-0000-4000-8000-000000000001';
    const inB = 'bbbbbbbb-0000-4000-8000-000000000002';
    await seedTodos(accountA, inA, ['Acme task']);
    await seedTodos(accountB, inB, ['Beta task']);

    const [fromA, fromB] = await Promise.all([
      reader.readTodosFromFile(inA),
      reader.readTodosFromFile(inB),
    ]);

    expect(fromA?.map((t) => t.subject)).toEqual(['Acme task']);
    expect(fromB?.map((t) => t.subject)).toEqual(['Beta task']);
  });

  it('skips an account with no directory for this project, silently', async () => {
    await seedSession(accountA, 'aaaaaaaa-0000-4000-8000-000000000001', 'work for Acme');

    const { sessions, warnings } = await reader.listSessionsAcrossAccounts(vaultRoot);

    // accountB has never worked on this project — the normal case, and not
    // something to bother the operator about.
    expect(sessions).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('turns an unreadable account into ONE warning and still lists the others', async () => {
    await seedSession(accountA, 'aaaaaaaa-0000-4000-8000-000000000001', 'work for Acme');
    // A regular FILE where accountB's slug directory belongs: reading it fails
    // with ENOTDIR, a real non-ENOENT read failure that needs no permission games
    // (and so behaves the same for a suite running as root).
    await writeFile(
      join(accountB, 'projects', reader.getProjectSlug(vaultRoot)),
      'not a directory'
    );

    const { sessions, warnings } = await reader.listSessionsAcrossAccounts(vaultRoot);

    expect(sessions.map((s) => s.account)).toEqual([accountA]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.runtime).toBe('claude-code');
    expect(warnings[0]!.message).toContain(accountB);
    // The account travels as its own field, not only inside the sentence: every
    // warning from this loop carries the same `runtime`, so the sidebar keys and
    // names its notices by the account, and two unreadable accounts would
    // otherwise collide into one notice (spec §Consequence for the UI).
    expect(warnings[0]!.account).toBe(accountB);
  });

  it('treats no qualifying account as no sessions, never as an error', async () => {
    // A freshly authenticated account has no `projects/` yet, so it is excluded
    // even while active — and then the set is empty (spec §9). Nothing may throw.
    await rm(join(accountA, 'projects'), { recursive: true, force: true });
    await rm(join(accountB, 'projects'), { recursive: true, force: true });
    expect(reader.getProjectsRootSet()).toEqual([]);

    const { sessions, warnings } = await reader.listSessionsAcrossAccounts(vaultRoot);

    expect(sessions).toEqual([]);
    expect(warnings).toEqual([]);
    await expect(
      reader.hasTranscript(vaultRoot, 'aaaaaaaa-0000-4000-8000-000000000001')
    ).resolves.toEqual({ exists: false });
    await expect(reader.listTranscripts(vaultRoot)).resolves.toEqual([]);
  });

  it('asks the SDK for a custom title ONLY for a session on the active account', async () => {
    // D8's chosen degradation, pinned so it stays chosen rather than drifting.
    // `getSessionInfo` runs in-process with no config-dir option, so reading a
    // title from a non-active account would need the process-global env lock —
    // and this call sits on the LISTING path, once per session. Serializing every
    // listing behind that mutation is the systemic risk the spec refused, so the
    // non-active account keeps its derived title instead.
    await seedSession(accountA, 'aaaaaaaa-0000-4000-8000-000000000001', 'work for Acme');
    await seedSession(accountB, 'bbbbbbbb-0000-4000-8000-000000000002', 'work for Beta');
    vi.mocked(getSessionInfo).mockResolvedValue({
      customTitle: 'Renamed in the app',
    } as unknown as Awaited<ReturnType<typeof getSessionInfo>>);

    const titles = new Map(
      (await reader.listSessions(vaultRoot)).map((s) => [s.account, s.title] as const)
    );

    expect(titles.get(accountA)).toBe('Renamed in the app');
    // The honest consequence: a title set on accountB does not display while
    // accountA is active — that row shows its first message instead.
    expect(titles.get(accountB)).toBe('Work for Beta');
    // Asserted on the CALL too, because that is the cost being controlled: one
    // in-process SDK read per listing at most, never one per account.
    expect(vi.mocked(getSessionInfo)).toHaveBeenCalledTimes(1);
  });

  it('re-resolves accounts after invalidateAll, so a switch is not served from cache', async () => {
    const sessionId = 'bbbbbbbb-0000-4000-8000-000000000002';
    await seedSession(accountB, sessionId, 'work for Beta');
    expect((await reader.listSessions(vaultRoot))[0]).toMatchObject({ account: accountB });

    // The account moves — what a switch plus a re-registration looks like on disk.
    // Phase C calls invalidateAll(); without it the remembered account and the
    // cached row both still name the old one.
    const accountC = join(tmp, 'claude-moved');
    await mkdir(join(accountC, 'projects', reader.getProjectSlug(vaultRoot)), { recursive: true });
    await writeFile(
      join(accountC, 'projects', reader.getProjectSlug(vaultRoot), `${sessionId}.jsonl`),
      transcriptLine('work for Beta', vaultRoot)
    );
    await rm(join(accountB, 'projects'), { recursive: true, force: true });
    process.env.CLAUDE_CONFIG_DIR = accountC;
    reader.invalidateAll();

    expect(await reader.listSessions(vaultRoot)).toMatchObject([
      { id: sessionId, account: accountC },
    ]);
    await expect(reader.hasTranscript(vaultRoot, sessionId)).resolves.toEqual({
      exists: true,
      root: accountC,
    });
  });
});
