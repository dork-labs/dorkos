import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'fs/promises';
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

  it('loses only the unreadable folders’ sessions, whichever order readdir picks', async () => {
    // The widened read opens directories that have nothing to do with each
    // other, so one being unreadable must cost that directory and no more.
    // With the walk inside the account-level `try` it cost every directory
    // AFTER it — and `readdir` fixes no order, so WHICH sessions vanished
    // varied run to run, the worst shape a data-loss bug can take.
    //
    // TWO broken directories, named to sort either side of the good one
    // (`apps` < `packages-api` < `zzz`), which is what makes the claim in this
    // test's name real rather than a hope about `readdir`: no ordering exists
    // in which the survivor is not preceded OR followed by a failure, so both
    // halves of the old truncation are exercised on every run. Every fixture
    // here is a WIDENED directory — none is the project's own.
    const survivor = await seedSession(accountA, join(vaultRoot, 'packages', 'api'));
    const brokenDirs: string[] = [];
    for (const name of ['apps', 'zzz']) {
      const broken = join(vaultRoot, name);
      await seedSession(accountA, broken);
      // Slugged AFTER seeding, which is what creates the directory: the slug
      // resolves through `realpath`, so asking before it exists names a
      // directory nobody wrote (`/var/…` where the real one is `/private/var/…`).
      brokenDirs.push(join(accountA, 'projects', reader.getProjectSlug(broken)));
    }
    for (const dir of brokenDirs) await chmod(dir, 0o000);

    const { sessions, warnings } = await reader.listSessionsAcrossAccounts(vaultRoot);
    // Restored before the assertions, not after: teardown cannot remove a
    // directory it may not read, and a failing assertion would leave the temp
    // tree behind for every later run.
    for (const dir of brokenDirs) await chmod(dir, 0o700);

    expect(sessions.map((s) => s.id)).toEqual([survivor]);
    // The loss is REPORTED, not swallowed: an empty-looking list with no notice
    // reads as "this project has no sessions", which is a different sentence.
    // Still ONE notice for the account, however many of its folders failed —
    // the sidebar keys its notices by account.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ runtime: 'claude-code', account: accountA });
    expect(warnings[0]!.message).toContain('2 project folders could not be read');
    expect(warnings[0]!.message).toContain('may be missing');
  });

  it('does not blame the whole account for one folder it could not open', async () => {
    // The companion to the case above, and a DIFFERENT claim. The single broken
    // folder here sorts LAST (`packages-api` < `zzz`), so the sessions come back
    // correct even without per-folder containment — what the old code got wrong
    // was the sentence: having aborted the walk, it reported that the ACCOUNT
    // could not be read. It could; one of its folders could not, and the
    // difference is the difference between "something is missing" and "nothing
    // is here". This case fails on the message, not on the list, which is why
    // it is worth having beside the other one.
    const survivor = await seedSession(accountA, join(vaultRoot, 'packages', 'api'));
    const broken = join(vaultRoot, 'zzz');
    await seedSession(accountA, broken);
    const brokenDir = join(accountA, 'projects', reader.getProjectSlug(broken));
    await chmod(brokenDir, 0o000);

    const { sessions, warnings } = await reader.listSessionsAcrossAccounts(vaultRoot);
    await chmod(brokenDir, 0o700);

    expect(sessions.map((s) => s.id)).toEqual([survivor]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('1 project folder could not be read');
    // The old account-level wording, which must NOT be what a reader is told.
    expect(warnings[0]!.message).not.toContain('could not be read: ');
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
