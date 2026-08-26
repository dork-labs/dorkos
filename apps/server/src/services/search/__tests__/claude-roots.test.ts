import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createTestDb } from '@dorkos/test-utils/db';
import { messages, searchSources, eq, type Db } from '@dorkos/db';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { resolveClaudeRootSet } from '../../runtimes/claude-code/claude-config-dir.js';
import { discoverClaudeCodeTranscripts } from '../claude-code-discovery.js';
import { DISCOVERY_FAILURE_KEY } from '../frontier-store.js';
import { sweepFileSource, DUPLICATE_CONTAINERS_KEY } from '../jsonl-frontier.js';
import { claudeCodeSource, createClaudeCodeSource } from '../registry.js';
import type { FileSource, SourceSweep } from '../types.js';

/**
 * Search covers every Claude Code account on the machine, not whichever one the
 * server happened to start with (spec Amendment 2, DOR-682).
 *
 * **The measurement this suite encodes.** Three Claude config roots exist on the
 * operator's machine and all three were written to within the same week.
 * Indexing only the active one covered at most 67% of that corpus — and 3.5%
 * when the server inherited a minor root from its shell, which is how this
 * feature's own decomposition ran. Neither case reported anything: a short
 * result list is indistinguishable from a complete one, which is precisely the
 * failure G4 refuses.
 *
 * So the assertions here are about UNION and about SAYING SO. Every "this root
 * contributed nothing" case is paired with a positive control over the same
 * fixture, because zero rows is what a working exclusion and a broken reader
 * both return.
 */

const ORIGINAL = {
  configDir: process.env.CLAUDE_CONFIG_DIR,
  home: process.env.HOME,
  userProfile: process.env.USERPROFILE,
};

let db: Db;
let tmp: string;

beforeEach(async () => {
  db = createTestDb();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-search-roots-'));
  // `~/.claude` is an unconditional member of the root set, so the answer
  // depends on the developer's real home directory unless the test owns it.
  // Staging HOME is the sanctioned way to do that (`.claude/rules/dork-home.md`)
  // and it also keeps the suite from reading whatever accounts happen to be
  // registered on this machine.
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  delete process.env.CLAUDE_CONFIG_DIR;
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
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Create a Claude config root that qualifies as an account, and return both paths. */
async function makeRoot(name: string): Promise<{ root: string; projects: string }> {
  const root = path.join(tmp, name);
  const projects = path.join(root, 'projects');
  await fs.mkdir(projects, { recursive: true });
  return { root, projects };
}

/** Write one transcript holding a single user message. */
async function writeSession(
  projects: string,
  sessionId: string,
  text: string,
  slug = 'slug-a'
): Promise<string> {
  const file = path.join(projects, slug, `${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    `${JSON.stringify({
      type: 'user',
      cwd: '/repo/project',
      timestamp: '2026-08-24T10:00:00.000Z',
      message: { role: 'user', content: text },
    })}\n`
  );
  return file;
}

/** Sweep a source over the test database. */
async function sweep(source: FileSource, at = '2026-08-24T12:00:00.000Z'): Promise<SourceSweep> {
  return sweepFileSource(db, source, at);
}

/** Every indexed `(originKey, body)` pair, ordered so assertions are stable. */
function indexed(): { originKey: string; body: string }[] {
  return db
    .select({ originKey: messages.originKey, body: messages.body })
    .from(messages)
    .orderBy(messages.body)
    .all();
}

/**
 * Every frontier row's `last_error`, in container order.
 *
 * The column `sourceWarnings` reads, and the only thing that decides whether a
 * person searching is told their corpus is incomplete.
 */
function frontierErrors(): (string | null)[] {
  return db
    .select()
    .from(searchSources)
    .where(eq(searchSources.sourceId, 'claude-code'))
    .orderBy(searchSources.originKey)
    .all()
    .map((row) => row.lastError);
}

/**
 * A config reader over one `runtimes.claudeCode` section, standing in for the
 * `configManager` singleton the resolvers default to.
 */
function fakeConfig(claudeCode: Partial<UserConfig['runtimes']['claudeCode']> = {}): {
  get<K extends keyof UserConfig>(key: K): UserConfig[K];
} {
  const runtimes: UserConfig['runtimes'] = {
    ...USER_CONFIG_DEFAULTS.runtimes,
    claudeCode: {
      defaultAccount: null,
      accounts: [],
      defaultModel: null,
      defaultEffort: null,
      defaultTrustStop: null,
      persistentSession: false,
      ...claudeCode,
    },
  };
  return {
    get: (<K extends keyof UserConfig>(key: K) =>
      key === 'runtimes' ? runtimes : USER_CONFIG_DEFAULTS[key]) as <K extends keyof UserConfig>(
      key: K
    ) => UserConfig[K],
  };
}

describe('the shipped claude-code source reads every account, not the active one', () => {
  it('proves the staged HOME is what the resolver reads', () => {
    // Guards every assertion in this describe: if HOME staging stopped working
    // they would silently start describing the developer's own machine.
    expect(os.homedir()).toBe(tmp);
  });

  it('indexes a session from the inherited root AND one from ~/.claude, with distinct container ids', async () => {
    // The exact shape of the 3.5% failure: the shell exported a minor account,
    // so the server's ACTIVE root is that one and `~/.claude` — where most of
    // the history is — was never opened.
    const inherited = await makeRoot('claude3');
    const home = await makeRoot('.claude');
    process.env.CLAUDE_CONFIG_DIR = inherited.root;
    await writeSession(inherited.projects, 'session-from-shell', 'said in the minor account');
    await writeSession(home.projects, 'session-from-home', 'said in the main account');

    const result = await sweep(claudeCodeSource);

    expect(indexed()).toEqual([
      { originKey: 'session-from-home', body: 'said in the main account' },
      { originKey: 'session-from-shell', body: 'said in the minor account' },
    ]);
    expect(result.failures).toEqual([]);
    // `search_sources` is keyed `(source_id, origin_key)`, so two roots holding
    // one session id would silently overwrite a frontier rather than fail.
    // Session ids are UUIDs and no collision has been measured — asserted here
    // rather than assumed, per Amendment 2.
    const containers = db
      .select({ originKey: searchSources.originKey })
      .from(searchSources)
      .where(eq(searchSources.sourceId, 'claude-code'))
      .all()
      .map((row) => row.originKey);
    expect(new Set(containers).size).toBe(containers.length);
    expect(new Set(containers)).toEqual(new Set(['session-from-shell', 'session-from-home']));
  });

  it('is a real union — the single-root reader over the same fixture sees half of it', async () => {
    // The control that makes the test above mean something. Without it, a reader
    // that happened to pick the right single root would pass, and so would one
    // that read a set of two while opening only the first.
    const inherited = await makeRoot('claude3');
    const home = await makeRoot('.claude');
    process.env.CLAUDE_CONFIG_DIR = inherited.root;
    await writeSession(inherited.projects, 'session-from-shell', 'said in the minor account');
    await writeSession(home.projects, 'session-from-home', 'said in the main account');

    const activeRootOnly = createClaudeCodeSource(() => [inherited.projects]);
    await sweep(activeRootOnly);

    expect(indexed()).toEqual([
      { originKey: 'session-from-shell', body: 'said in the minor account' },
    ]);
  });

  it('indexes an account that exists only because the operator registered it', async () => {
    // The "neither alone" resolution of the open question. `$CLAUDE_CONFIG_DIR`
    // and `~/.claude` are free and provably complete for one process; a third
    // profile is an operator fact DorkOS cannot infer, so it is configuration —
    // `runtimes.claudeCode.accounts`, which already existed. Auto-globbing
    // `~/.claude*` is not the answer: on this machine it sweeps up
    // `.claude-worktrees` and `.claudekit`, which hold no `projects/`.
    const home = await makeRoot('.claude');
    const registered = await makeRoot('claude2');
    await fs.mkdir(path.join(tmp, '.claude-worktrees'), { recursive: true });
    await writeSession(home.projects, 'session-from-home', 'said in the main account');
    await writeSession(registered.projects, 'session-from-client', 'said in the client account');

    const configured = createClaudeCodeSource(() =>
      resolveClaudeRootSet(
        fakeConfig({ accounts: [{ id: 'acme', path: registered.root, label: 'Acme' }] })
      ).map((root) => path.join(root, 'projects'))
    );
    await sweep(configured);

    expect(
      indexed()
        .map((row) => row.originKey)
        .sort()
    ).toEqual(['session-from-client', 'session-from-home']);
  });
});

describe('one root failing does not narrow the corpus silently', () => {
  it('reports the unreadable root, indexes the readable one, and prunes nothing', async () => {
    const healthy = await makeRoot('claude-a');
    await writeSession(healthy.projects, 'session-a', 'still readable');

    // A path that EXISTS and cannot be enumerated. A file where a directory
    // belongs reproduces that deterministically (ENOTDIR) without depending on
    // a permission bit the test runner's uid might ignore.
    const brokenRoot = path.join(tmp, 'claude-b');
    await fs.mkdir(brokenRoot, { recursive: true });
    const brokenProjects = path.join(brokenRoot, 'projects');
    await fs.writeFile(brokenProjects, 'not a directory');

    // Index both roots while both are healthy first, so there is something the
    // prune could destroy. `session-b` is written into the healthy root under a
    // second slug and then removed, standing in for a container that really is
    // gone: what must NOT happen is that an unreadable SIBLING root makes it
    // look like every container vanished.
    const source = createClaudeCodeSource(() => [healthy.projects, brokenProjects]);
    const gone = await writeSession(healthy.projects, 'session-b', 'about to vanish', 'slug-b');
    await sweep(source);
    expect(indexed()).toHaveLength(2);
    await fs.rm(gone);

    const result = await sweep(source, '2026-08-24T13:00:00.000Z');

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.sourceId).toBe('claude-code');
    expect(result.failures[0]?.originKey).toBe(DISCOVERY_FAILURE_KEY);
    // Naming the root is the whole point: without it the operator is told the
    // corpus is incomplete and not which account is missing from it.
    expect(result.failures[0]?.message).toContain(brokenProjects);
    // Not pruned, even though `session-b` really is gone. A partial enumeration
    // cannot tell "this container vanished" from "its root would not open", and
    // deleting an account's whole history on a volume hiccup is far worse than
    // carrying a stale row for one more sweep.
    expect(result.pruned).toBe(0);
    expect(
      indexed()
        .map((row) => row.originKey)
        .sort()
    ).toEqual(['session-a', 'session-b']);
    // **And the person searching is told, which is the whole point of reporting
    // it.** `sourceWarnings` reads `search_sources.last_error` and nothing else,
    // so an account missing from every result raises no warning without this.
    // Every row of the source carries it, deterministically: a stamp written
    // before the loop would survive only on whichever containers happened not to
    // change, so whether anyone was warned would depend on who was talking.
    expect(frontierErrors()).toEqual([
      expect.stringContaining(brokenProjects),
      expect.stringContaining(brokenProjects),
    ]);
  });

  it('stops warning once every root reads again', async () => {
    // A stamp nothing clears is a warning that outlives its fault forever, and
    // an unchanged transcript writes no row of its own to clear it.
    const healthy = await makeRoot('claude-a');
    await writeSession(healthy.projects, 'session-a', 'indexed from the readable root');
    const brokenRoot = path.join(tmp, 'claude-c');
    await fs.mkdir(brokenRoot, { recursive: true });
    const brokenProjects = path.join(brokenRoot, 'projects');
    await fs.writeFile(brokenProjects, 'not a directory');
    const source = createClaudeCodeSource(() => [healthy.projects, brokenProjects]);

    await sweep(source);
    expect(frontierErrors()).toEqual([expect.stringContaining(brokenProjects)]);

    // The root becomes readable: the file standing where the directory belongs
    // is replaced by the directory.
    await fs.rm(brokenProjects);
    await fs.mkdir(brokenProjects, { recursive: true });
    await sweep(source, '2026-08-24T14:00:00.000Z');

    expect(frontierErrors()).toEqual([null]);
  });

  it('prunes normally once every root reads — the control the test above needs', async () => {
    // Paired positive control. `pruned: 0` above passes for the correct
    // suppression AND for a prune that never worked; this proves it works.
    const healthy = await makeRoot('claude-a');
    const second = await makeRoot('claude-b');
    await writeSession(healthy.projects, 'session-a', 'still readable');
    const gone = await writeSession(healthy.projects, 'session-b', 'about to vanish', 'slug-b');

    const source = createClaudeCodeSource(() => [healthy.projects, second.projects]);
    await sweep(source);
    await fs.rm(gone);
    const result = await sweep(source, '2026-08-24T13:00:00.000Z');

    expect(result.failures).toEqual([]);
    expect(result.pruned).toBe(1);
    expect(indexed().map((row) => row.originKey)).toEqual(['session-a']);
  });

  it('says nothing about a root that simply is not there', async () => {
    // An account whose directory was removed, or one Claude Code never ran
    // under. Reporting it would put a permanent warning on every machine with a
    // stale entry in its config, which trains people to ignore the warning that
    // matters.
    const healthy = await makeRoot('claude-a');
    await writeSession(healthy.projects, 'session-a', 'the only account left');
    const source = createClaudeCodeSource(() => [
      healthy.projects,
      path.join(tmp, 'deleted-account', 'projects'),
    ]);

    const result = await sweep(source);

    expect(result.failures).toEqual([]);
    expect(indexed()).toEqual([{ originKey: 'session-a', body: 'the only account left' }]);
  });
});

describe('two accounts claiming one session id', () => {
  it('refuses BOTH twins and names the full path of each, so the colliding accounts are legible', async () => {
    // Within one account a duplicate session id takes a copied transcript;
    // across accounts it takes only a config directory that was copied. The
    // refusal is inherited from the single-root guard — what this asserts is
    // that the message identifies which two roots collided, which a bare session
    // id would not.
    const first = await makeRoot('claude-a');
    const second = await makeRoot('claude-b');
    const twinA = await writeSession(first.projects, 'shared-id', 'from the first account');
    const twinB = await writeSession(second.projects, 'shared-id', 'from the second account');

    const result = await sweep(createClaudeCodeSource(() => [first.projects, second.projects]));

    expect(indexed()).toEqual([]);
    expect(
      db.select().from(searchSources).where(eq(searchSources.originKey, 'shared-id')).all()
    ).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.originKey).toBe('shared-id');
    expect(result.failures[0]?.message).toContain('2 files claim this container id');
    expect(result.failures[0]?.message).toContain(twinA);
    expect(result.failures[0]?.message).toContain(twinB);
  });

  it('summarises a whole duplicated directory as ONE failure naming the two locations', async () => {
    // A copied config directory collides on every session id at once. One
    // failure per id would be several hundred identical warnings every five
    // minutes — which is not a report, it is a way to lose the single fact an
    // operator can act on. The summary has to name the two directories, because
    // "300 ids collided" without them is unactionable too.
    const first = await makeRoot('claude-a');
    const second = await makeRoot('claude-b');
    for (const id of ['s1', 's2', 's3', 's4']) {
      await writeSession(first.projects, id, `${id} from the first account`);
      await writeSession(second.projects, id, `${id} from the second account`);
    }

    const result = await sweep(createClaudeCodeSource(() => [first.projects, second.projects]));

    expect(indexed()).toEqual([]);
    expect(result.failures).toHaveLength(1);
    const [failure] = result.failures;
    expect(failure?.originKey).toBe(DUPLICATE_CONTAINERS_KEY);
    // Not one of the four ids: naming the first would read as a fault in that
    // one session, which is the opposite of what happened.
    expect(failure?.message).toContain('4 container ids');
    // The ACCOUNT directories, not the projects roots: `projects` is shared by
    // both claimants, so the smallest thing that distinguishes them is the
    // account above it — which is also the thing an operator would go and look
    // at, and the thing they would remove from settings.
    expect(failure?.message).toContain(first.root);
    expect(failure?.message).toContain(second.root);
  });

  it('still reports an unrelated single collision separately from a duplicated directory', async () => {
    // The grouping is by WHERE the claimants differ, not "collisions happened".
    // A copied directory and a stray copied transcript are two different faults
    // and must not be folded into one line that names neither properly.
    const first = await makeRoot('claude-a');
    const second = await makeRoot('claude-b');
    for (const id of ['s1', 's2']) {
      await writeSession(first.projects, id, `${id} in the first account`);
      await writeSession(second.projects, id, `${id} in the second account`);
    }
    // A transcript copied to a second slug INSIDE the first account.
    await writeSession(first.projects, 'stray', 'the original', 'slug-a');
    await writeSession(first.projects, 'stray', 'the copy', 'slug-copied');

    const result = await sweep(createClaudeCodeSource(() => [first.projects, second.projects]));

    expect(result.failures).toHaveLength(2);
    const keys = result.failures.map((entry) => entry.originKey).sort();
    expect(keys).toEqual([DUPLICATE_CONTAINERS_KEY, 'stray']);
    const stray = result.failures.find((entry) => entry.originKey === 'stray');
    expect(stray?.message).toContain(path.join(first.projects, 'slug-a', 'stray.jsonl'));
    expect(stray?.message).toContain(path.join(first.projects, 'slug-copied', 'stray.jsonl'));
  });

  it('treats a SYMLINKED root as the same root, not a corpus of twins', async () => {
    // The reproduced blackout. `resolveClaudeRootSet()` deduplicates lexically,
    // so a registered account that is a symlink to another root survives as two
    // spellings of one directory. Every session id then has a twin; twins are
    // refused rather than preferred; the index indexes NOTHING, forever, and
    // says so several hundred times per sweep. One plausible config entry, total
    // blackout — which is why the collapse resolves symlinks rather than
    // trusting the string.
    const real = await makeRoot('claude-a');
    await writeSession(real.projects, 'session-a', 'said once');
    await writeSession(real.projects, 'session-b', 'also said once', 'slug-b');
    const link = path.join(tmp, 'claude-linked');
    await fs.symlink(real.root, link);

    const result = await sweep(
      createClaudeCodeSource(() => [real.projects, path.join(link, 'projects')])
    );

    expect(result.failures).toEqual([]);
    expect(
      indexed()
        .map((row) => row.originKey)
        .sort()
    ).toEqual(['session-a', 'session-b']);
  });

  it('treats one directory named twice as one root rather than a corpus of twins', async () => {
    // A resolver handing back the same root under two spellings would otherwise
    // make EVERY file its own twin and refuse the entire corpus — a total
    // blackout from a duplicate config entry. The collapse is done where the
    // damage would be, not trusted to the caller.
    const only = await makeRoot('claude-a');
    await writeSession(only.projects, 'session-a', 'said once');

    const result = await sweep(
      createClaudeCodeSource(() => [only.projects, `${only.projects}${path.sep}`])
    );

    expect(result.failures).toEqual([]);
    expect(indexed()).toEqual([{ originKey: 'session-a', body: 'said once' }]);
  });
});

describe('the head-read skip survives the extra roots', () => {
  it('reads no transcript head for unchanged files in any root', async () => {
    // The sweep cost math scales with root count: a head read is up to 64 KiB
    // per main-session file per tick, so re-classifying every file in every root
    // every five minutes is the one change that would make covering three
    // accounts cost three times as much for no new information.
    const first = await makeRoot('claude-a');
    const second = await makeRoot('claude-b');
    await writeSession(first.projects, 'session-a', 'in the first account');
    await writeSession(second.projects, 'session-b', 'in the second account');

    const reads: string[] = [];
    const counting = async (filePath: string): Promise<string | null> => {
      reads.push(filePath);
      return '/repo/project';
    };
    const source = createClaudeCodeSource(() => [first.projects, second.projects]);
    const counted: FileSource = {
      ...source,
      discover: (known) =>
        discoverClaudeCodeTranscripts([first.projects, second.projects], known, counting),
    };

    await sweep(counted);
    expect(reads).toHaveLength(2);

    reads.length = 0;
    const second_ = await sweep(counted, '2026-08-24T13:00:00.000Z');

    expect(reads).toEqual([]);
    expect(second_.indexed).toBe(0);
    expect(indexed()).toHaveLength(2);
  });
});
