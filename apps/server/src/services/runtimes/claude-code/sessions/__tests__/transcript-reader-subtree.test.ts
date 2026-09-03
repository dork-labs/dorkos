import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// The SDK title lookup would do real I/O against whichever config dir the SDK
// memoized; stub it so titles come from the first message.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  getSessionInfo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue(undefined),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue(undefined),
}));

import { TranscriptReader } from '../transcript-reader.js';

/**
 * A project's session list covers the project's SUBTREE (DOR-1550), on the real
 * filesystem with the real slug computation.
 *
 * The bug these cover is one a person hits the first time they start an agent in
 * `packages/api`: Claude Code files that session under its OWN slug directory,
 * and a listing that opened only `<project>`'s slug directory never saw it —
 * from the project it did not exist. Nothing is mocked below except the SDK
 * title lookup and the boundary, so the directories, the slugs and the JSONL are
 * the real thing; a fixture built out of doubles could only re-state the
 * hypothesis about where the SDK puts files.
 *
 * HOME is staged so the suite reads its own accounts rather than the
 * developer's (the sanctioned technique in `.claude/rules/dork-home.md`).
 */
describe('TranscriptReader lists a project’s subtree', () => {
  const ORIGINAL = {
    configDir: process.env.CLAUDE_CONFIG_DIR,
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
  };
  let tmp: string;
  /** The ACTIVE account (`$CLAUDE_CONFIG_DIR`). */
  let accountA: string;
  /** `~/.claude` under the staged HOME — in the account set unconditionally. */
  let accountB: string;
  let vaultRoot: string;
  let reader: TranscriptReader;
  let nextId = 0;

  /**
   * Write a transcript for a session running at `cwd`, into `account`'s store,
   * under the slug directory the SDK would have named for that cwd.
   *
   * The directory is created first: the slug is computed through `realpath`, so
   * a cwd that does not exist on disk would slug to a name the SDK never writes
   * and the fixture would stop resembling the machine it stands in for.
   *
   * @param account - The Claude account root to write under.
   * @param cwd - The working directory the session runs in.
   * @param recordCwd - Whether the head record carries a `cwd` at all. `false`
   *   stands in for a transcript whose head is oversized or unparseable.
   * @returns The seeded session's id.
   */
  async function seedSession(account: string, cwd: string, recordCwd = true): Promise<string> {
    nextId += 1;
    const sessionId = `aaaaaaaa-0000-4000-8000-00000000000${nextId}`;
    await mkdir(cwd, { recursive: true });
    const slugDir = join(account, 'projects', reader.getProjectSlug(cwd));
    await mkdir(slugDir, { recursive: true });
    await writeFile(
      join(slugDir, `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: `working in ${cwd}` },
        timestamp: '2026-07-01T00:00:00.000Z',
        ...(recordCwd ? { cwd } : {}),
      }) + '\n'
    );
    return sessionId;
  }

  /** The ids `listSessions(vaultRoot)` reports, in list order. */
  async function listedIds(): Promise<string[]> {
    return (await reader.listSessions(vaultRoot)).map((s) => s.id);
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'claude-subtree-'));
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    accountA = join(tmp, 'claude-active');
    accountB = join(tmp, '.claude');
    // A directory only qualifies as an account once it holds `projects/`.
    await mkdir(join(accountA, 'projects'), { recursive: true });
    await mkdir(join(accountB, 'projects'), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = accountA;
    vaultRoot = join(tmp, 'work');
    await mkdir(vaultRoot, { recursive: true });
    reader = new TranscriptReader();
    nextId = 0;
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

  it('stages the fixture the way the SDK really lays it out', async () => {
    // Guards every case below. A subfolder session must land in a DIFFERENT
    // directory from the project's own — if the two ever slugged the same, the
    // rest of this file would pass without the widened read existing.
    const subfolder = join(vaultRoot, 'packages', 'api');
    await mkdir(subfolder, { recursive: true });
    expect(reader.getProjectSlug(subfolder)).not.toBe(reader.getProjectSlug(vaultRoot));
    expect(
      reader.getProjectSlug(subfolder).startsWith(`${reader.getProjectSlug(vaultRoot)}-`)
    ).toBe(true);
  });

  it('lists a session started in a subfolder, still reporting its own cwd', async () => {
    const subfolder = join(vaultRoot, 'packages', 'api');
    const sessionId = await seedSession(accountA, subfolder);

    const sessions = await reader.listSessions(vaultRoot);

    expect(sessions.map((s) => s.id)).toEqual([sessionId]);
    // The row says where it is really running — the point of listing it at all
    // is that a person can see the agent is in `packages/api`.
    expect(sessions[0]!.cwd).toBe(subfolder);
  });

  it('lists a session started deep inside the project', async () => {
    const deep = join(vaultRoot, 'apps', 'server', 'src', 'services');
    const sessionId = await seedSession(accountA, deep);

    await expect(listedIds()).resolves.toEqual([sessionId]);
  });

  it('leaves out a sibling project whose name merely starts the same way', async () => {
    // `work-2` slugs to `<work's slug>-2`, so it survives the widened READ and
    // has to be thrown back out by the membership predicate — the trap a raw
    // prefix comparison falls into.
    await seedSession(accountA, `${vaultRoot}-2`);
    await seedSession(accountA, join(`${vaultRoot}-2`, 'packages'));

    await expect(listedIds()).resolves.toEqual([]);
  });

  it('leaves out an unrelated project and the folder above this one', async () => {
    await seedSession(accountA, join(tmp, 'elsewhere'));
    await seedSession(accountA, tmp);

    await expect(listedIds()).resolves.toEqual([]);
  });

  it('still lists the project’s own sessions, across accounts', async () => {
    const own = await seedSession(accountA, vaultRoot);
    const otherAccount = await seedSession(accountB, join(vaultRoot, 'packages', 'api'));

    await expect(listedIds()).resolves.toEqual(expect.arrayContaining([own, otherAccount]));
    await expect(listedIds()).resolves.toHaveLength(2);
  });

  it('attributes a cwd-less transcript in the project’s OWN directory to the project', async () => {
    // ADR 260707-193314, unchanged by the widening: a transcript whose head
    // carries no cwd is credited to the directory it was found in, and its own
    // slug directory is proof of which project that is.
    const sessionId = await seedSession(accountA, vaultRoot, false);

    const sessions = await reader.listSessions(vaultRoot);

    expect(sessions.map((s) => s.id)).toEqual([sessionId]);
    expect(sessions[0]!.cwd).toBe(vaultRoot);
  });

  it('leaves out a cwd-less transcript found in a widened directory', async () => {
    // The slug is lossy, so a directory name alone cannot say which folder a
    // cwd-less session ran in — and `<project>-2`'s directory is widened into
    // as readily as `<project>/packages`. Nothing is credited on the strength
    // of a name.
    await seedSession(accountA, join(vaultRoot, 'packages', 'api'), false);

    await expect(listedIds()).resolves.toEqual([]);
  });

  it('says nothing about an account that has never run Claude Code', async () => {
    // accountB has a `projects/` dir but nothing in it; an account with no
    // directory for this project contributes no sessions and no warning.
    const own = await seedSession(accountA, join(vaultRoot, 'packages'));

    const { sessions, warnings } = await reader.listSessionsAcrossAccounts(vaultRoot);

    expect(sessions.map((s) => s.id)).toEqual([own]);
    expect(warnings).toEqual([]);
  });
});
