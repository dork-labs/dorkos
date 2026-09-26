/**
 * Which agent's home a folder belongs to (DOR-2091, DOR-2355).
 *
 * The rule in `agent-home.ts`, pinned at the seam every identity read now goes
 * through (spec `agent-home-desk` §3.1, §11 "Resolver" and "Resolver
 * hardening"). The linked-worktree source is driven against real git, because
 * its whole claim is that it reads what `git worktree add` writes; the room
 * worktree manager's own half is pinned beside the manager in
 * `rooms/repo/__tests__/room-worktree-manager.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  homeOf,
  resolveAgentHome,
  setWorkingCopyOwnerPort,
  turnAgentOf,
  type WorkingCopyOwnerPort,
} from '../agent-home.js';
import { clearTestHomes, registerTestHomes } from './agent-home-fixture.js';

const ANA = '/agents/ana';
const BEN = '/agents/ben';
const WORKTREES = '/dork/rooms/01ROOM/worktrees';
const ANA_WORKTREE = `${WORKTREES}/ana-1a2b3c4d`;
const STRAY_WORKTREE = `${WORKTREES}/ana-00000000`;

/** A port with the manager's shape: location decides "a working copy", a record decides whose. */
function portFor(owners: Record<string, string>): WorkingCopyOwnerPort {
  return {
    ownerOf: (dir) =>
      path.dirname(path.resolve(dir)) === WORKTREES
        ? { owner: owners[path.resolve(dir)] ?? null }
        : null,
  };
}

afterEach(() => {
  setWorkingCopyOwnerPort(undefined);
  clearTestHomes();
});

describe('resolveAgentHome — exact and room working copies', () => {
  it('resolves a registered home to itself, and any other folder to no agent', () => {
    registerTestHomes([ANA, BEN]);

    expect(resolveAgentHome(ANA)).toEqual({ kind: 'home', home: ANA, via: 'exact' });
    expect(resolveAgentHome('/somewhere/plain')).toEqual({ kind: 'none' });
  });

  it('is nobody with no registry wired — never an identity read off the folder', () => {
    expect(resolveAgentHome(ANA)).toEqual({ kind: 'none' });
  });

  it('resolves a room working copy to the agent it was handed to', () => {
    registerTestHomes([ANA, BEN]);
    setWorkingCopyOwnerPort(portFor({ [ANA_WORKTREE]: ANA }));

    expect(resolveAgentHome(ANA_WORKTREE)).toEqual({
      kind: 'home',
      home: ANA,
      via: 'room-worktree',
    });
    expect(homeOf(resolveAgentHome(ANA_WORKTREE, ANA))).toBe(ANA);
  });

  it('never resolves by prefix: a folder inside a home, or inside its worktree, is nobody', () => {
    registerTestHomes([ANA, BEN]);
    setWorkingCopyOwnerPort(portFor({ [ANA_WORKTREE]: ANA }));

    expect(resolveAgentHome(`${ANA}/src`)).toEqual({ kind: 'none' });
    expect(resolveAgentHome(`${ANA_WORKTREE}/src`)).toEqual({ kind: 'none' });
  });

  it('refuses a working copy nobody can vouch for, rather than reading it as nobody', () => {
    registerTestHomes([ANA, BEN]);
    setWorkingCopyOwnerPort(portFor({ [ANA_WORKTREE]: ANA }));

    expect(resolveAgentHome(STRAY_WORKTREE)).toEqual({
      kind: 'refused',
      reason: 'unowned-working-copy',
    });
    // Naming the right agent does not buy a working copy an owner.
    expect(resolveAgentHome(STRAY_WORKTREE, ANA).kind).toBe('refused');
  });

  it('refuses a working copy whose recorded owner is no longer a registered agent', () => {
    registerTestHomes([BEN]);
    setWorkingCopyOwnerPort(portFor({ [ANA_WORKTREE]: ANA }));

    expect(resolveAgentHome(ANA_WORKTREE)).toEqual({
      kind: 'refused',
      reason: 'unregistered-owner',
    });
    expect(resolveAgentHome(ANA_WORKTREE, ANA).kind).toBe('refused');
    expect(resolveAgentHome(ANA)).toEqual({ kind: 'none' });
  });

  it('fails CLOSED when the registry check throws', () => {
    setWorkingCopyOwnerPort(portFor({ [ANA_WORKTREE]: ANA }));
    const { port } = registerTestHomes([]);
    port.isRegisteredHome = () => {
      throw new Error('the registry is gone');
    };

    expect(resolveAgentHome(ANA_WORKTREE).kind).toBe('refused');
    expect(resolveAgentHome(ANA)).toEqual({ kind: 'none' });
  });

  it('fails CLOSED when the working-copy lookup throws', () => {
    registerTestHomes([ANA]);
    setWorkingCopyOwnerPort({
      ownerOf: () => {
        throw new Error('the manager is gone');
      },
    });

    expect(resolveAgentHome('/somewhere/plain').kind).toBe('refused');
  });
});

describe('resolveAgentHome — the turn the folder is for', () => {
  it("refuses agent A's working copy, or A's home, for a turn that is for agent B", () => {
    registerTestHomes([ANA, BEN]);
    setWorkingCopyOwnerPort(portFor({ [ANA_WORKTREE]: ANA }));

    expect(resolveAgentHome(ANA_WORKTREE, BEN)).toEqual({
      kind: 'refused',
      reason: 'not-the-turns-agent',
    });
    expect(resolveAgentHome(ANA, BEN)).toEqual({
      kind: 'refused',
      reason: 'not-the-turns-agent',
    });
    // The same agent spelled with a trailing slash is still the same agent.
    expect(resolveAgentHome(`${BEN}/`, BEN)).toEqual({ kind: 'home', home: BEN, via: 'exact' });
  });

  it("carries the turn's agent where the folder is nobody's home (01-ideation decision 10)", () => {
    // An agent configured `workspace.mode: 'none'` runs at the operator's
    // default directory with identity from its home; so does a turn standing
    // in a subfolder of its own home. Nobody would hand a login-off install's
    // tools to the operator.
    registerTestHomes([ANA, BEN]);

    expect(resolveAgentHome('/default/cwd', BEN)).toEqual({
      kind: 'home',
      home: BEN,
      via: 'turn-agent',
    });
    expect(homeOf(resolveAgentHome(`${BEN}/src`, BEN))).toBe(BEN);
    expect(homeOf(resolveAgentHome(undefined, BEN))).toBe(BEN);
  });

  it('gives a turn that names its agent but stands NOWHERE that agent`s identity', () => {
    // DOR-2091 refused this, so a login-off install would not read it as the
    // operator. Naming the agent now IS the identity (01-ideation decision 10);
    // refusal is kept for an agent that is not registered (below).
    registerTestHomes([BEN]);

    expect(resolveAgentHome(undefined, BEN)).toEqual({
      kind: 'home',
      home: BEN,
      via: 'turn-agent',
    });
    expect(resolveAgentHome('', BEN)).toEqual({ kind: 'home', home: BEN, via: 'turn-agent' });
  });

  it('refuses a turn for an agent that is not registered, rather than reading it as nobody', () => {
    registerTestHomes([ANA]);

    expect(resolveAgentHome('/default/cwd', BEN)).toEqual({
      kind: 'refused',
      reason: 'unregistered-owner',
    });
    expect(resolveAgentHome(undefined, BEN).kind).toBe('refused');
  });

  it('answers none for no folder and no agent', () => {
    expect(resolveAgentHome(undefined)).toEqual({ kind: 'none' });
  });

  it('reads the neutral forAgent first, then the room marker it generalises', () => {
    expect(turnAgentOf({ forAgent: ANA, roomTurn: { agentPath: BEN } })).toBe(ANA);
    expect(turnAgentOf({ roomTurn: { agentPath: BEN } })).toBe(BEN);
    expect(turnAgentOf(undefined)).toBeUndefined();
  });
});

describe('resolveAgentHome — managed workspaces', () => {
  it('resolves a checkout owned by the agent, whatever repo it was checked out from', () => {
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-managed-')));
    try {
      const anaRepo = path.join(scratch, 'ana');
      const benHome = path.join(scratch, 'ben');
      fs.mkdirSync(benHome);
      initRepo(anaRepo);
      // Ben owns a checkout of ANA's repo (a foreign source). The owner, not the
      // source, is who works there — even though the checkout is a linked
      // worktree of a registered home.
      const checkout = path.join(scratch, 'workspaces', 'ben-fix');
      git(anaRepo, 'worktree', 'add', '-q', '-b', 'ben-fix', checkout);
      registerTestHomes([anaRepo, benHome], { managed: { [checkout]: benHome } });

      expect(resolveAgentHome(checkout)).toEqual({
        kind: 'home',
        home: benHome,
        via: 'managed-workspace',
      });
      expect(resolveAgentHome(checkout, anaRepo).kind).toBe('refused');

      // Owned by the agent whose repo it is: the same answer by either source.
      const own = path.join(scratch, 'workspaces', 'ana-fix');
      git(anaRepo, 'worktree', 'add', '-q', '-b', 'ana-fix', own);
      registerTestHomes([anaRepo, benHome], { managed: { [own]: anaRepo } });
      expect(homeOf(resolveAgentHome(own, anaRepo))).toBe(anaRepo);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("refuses a checkout whose owner is gone — never hands it to the source repo's agent", () => {
    // Bob owned a checkout of ANA's repo and was then unregistered. The folder
    // is still a linked worktree of Ana's registered home; falling through to
    // that source would give Bob's checkout Ana's persona, account and relay
    // identity. The managed record is the whole answer.
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-gone-')));
    try {
      const anaRepo = path.join(scratch, 'ana');
      initRepo(anaRepo);
      const checkout = path.join(scratch, 'workspaces', 'bob-fix');
      git(anaRepo, 'worktree', 'add', '-q', '-b', 'bob-fix', checkout);
      registerTestHomes([anaRepo], { managed: { [checkout]: path.join(scratch, 'bob') } });

      expect(resolveAgentHome(checkout)).toEqual({
        kind: 'refused',
        reason: 'unregistered-owner',
      });
      expect(resolveAgentHome(checkout, anaRepo).kind).toBe('refused');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('matches an owner recorded realpath`d against a home registered through a symlink', () => {
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-owner-')));
    try {
      const anaRepo = path.join(scratch, 'ana');
      const bobReal = path.join(scratch, 'real', 'bob');
      const bobLink = path.join(scratch, 'agents-link', 'bob');
      fs.mkdirSync(bobReal, { recursive: true });
      fs.symlinkSync(path.join(scratch, 'real'), path.join(scratch, 'agents-link'));
      initRepo(anaRepo);
      const checkout = path.join(scratch, 'workspaces', 'bob-fix');
      git(anaRepo, 'worktree', 'add', '-q', '-b', 'bob-fix', checkout);
      // Registered through the link; the workspace stores the realpath.
      registerTestHomes([anaRepo, bobLink], { managed: { [checkout]: bobReal } });

      expect(resolveAgentHome(checkout)).toEqual({
        kind: 'home',
        home: bobLink,
        via: 'managed-workspace',
      });
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('resolveAgentHome — one folder, two spellings', () => {
  it('finds a home registered through a symlink from its real path, in the registry`s spelling', () => {
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-link-')));
    try {
      const real = path.join(scratch, 'real-agents', 'ana');
      fs.mkdirSync(real, { recursive: true });
      fs.symlinkSync(path.join(scratch, 'real-agents'), path.join(scratch, 'agents'));
      const link = path.join(scratch, 'agents', 'ana');

      registerTestHomes([link]);
      expect(resolveAgentHome(real)).toEqual({ kind: 'home', home: link, via: 'exact' });
      expect(homeOf(resolveAgentHome('/default/cwd', real))).toBe(link);

      registerTestHomes([real]);
      expect(resolveAgentHome(link)).toEqual({ kind: 'home', home: real, via: 'exact' });
      // Still never a prefix.
      fs.mkdirSync(path.join(real, 'src'));
      expect(resolveAgentHome(path.join(link, 'src'))).toEqual({ kind: 'none' });
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('resolveAgentHome — linked worktrees of a home repo (real git)', () => {
  let scratch: string;
  let home: string;

  beforeAll(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-linked-')));
    home = path.join(scratch, 'ana');
    initRepo(home);
    fs.mkdirSync(path.join(home, 'apps', 'server'), { recursive: true });
    fs.writeFileSync(path.join(home, 'apps', 'server', 'x.txt'), 'x');
    git(home, 'add', '-A');
    git(home, 'commit', '-q', '-m', 'apps');
  });

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('resolves the worktree root, and a subfolder whose twin is a registered home', () => {
    const tree = path.join(scratch, 'trees', 'ana-feature');
    git(home, 'worktree', 'add', '-q', '-b', 'feature', tree);
    const serverAgent = path.join(home, 'apps', 'server');
    registerTestHomes([home, serverAgent]);

    expect(resolveAgentHome(tree)).toEqual({ kind: 'home', home, via: 'linked-worktree' });
    expect(homeOf(resolveAgentHome(path.join(tree, 'apps', 'server')))).toBe(serverAgent);
    // No walk up past the relative position: `apps/` in the tree maps to
    // `apps/` in the home, which is not registered.
    expect(resolveAgentHome(path.join(tree, 'apps'))).toEqual({ kind: 'none' });
  });

  it('still resolves with the worktree`s `.dork/` deleted, and ignores a committed one', () => {
    const tree = path.join(scratch, 'trees', 'no-dork');
    git(home, 'worktree', 'add', '-q', '-b', 'no-dork', tree);
    registerTestHomes([home]);
    fs.rmSync(path.join(tree, '.dork'), { recursive: true, force: true });

    expect(homeOf(resolveAgentHome(tree))).toBe(home);
  });

  it('answers none for a bare common dir', () => {
    const bare = path.join(scratch, 'bare.git');
    git(scratch, 'init', '-q', '--bare', bare);
    git(home, 'push', '-q', bare, 'HEAD:main');
    const tree = path.join(scratch, 'trees', 'from-bare');
    git(bare, 'worktree', 'add', '-q', tree, 'main');
    registerTestHomes([home, bare, scratch]);

    expect(resolveAgentHome(tree)).toEqual({ kind: 'none' });
  });

  it('answers none for a repo under the rooms dir, without looking the candidate up', () => {
    const roomsDir = path.join(scratch, 'rooms');
    const roomRepo = path.join(roomsDir, '01ROOM', 'repo');
    initRepo(roomRepo);
    const tree = path.join(roomsDir, '01ROOM', 'worktrees', 'ana-1a2b3c4d');
    git(roomRepo, 'worktree', 'add', '-q', '-b', 'ana', tree);
    const { port } = registerTestHomes([roomRepo], { roomsDir });
    const lookup = vi.spyOn(port, 'isRegisteredHome');

    expect(resolveAgentHome(tree)).toEqual({ kind: 'none' });
    expect(lookup.mock.calls.map(([dir]) => dir)).not.toContain(roomRepo);
  });

  it('answers none for a hand-written .git pointer with no backlink to it', () => {
    // A `.git` file aimed at a real worktree gitdir of Ana's repo. Git's own
    // `<gitdir>/gitdir` names the REAL worktree, not this folder.
    const real = path.join(scratch, 'trees', 'real');
    git(home, 'worktree', 'add', '-q', '-b', 'real', real);
    const forged = path.join(scratch, 'forged');
    fs.mkdirSync(forged);
    fs.writeFileSync(path.join(forged, '.git'), fs.readFileSync(path.join(real, '.git')));
    registerTestHomes([home]);

    expect(resolveAgentHome(real).kind).toBe('home');
    expect(resolveAgentHome(forged)).toEqual({ kind: 'none' });
  });

  it('answers none for a submodule-shaped .git file (a gitdir with no commondir)', () => {
    const sub = path.join(scratch, 'sub');
    const subGitDir = path.join(home, '.git', 'modules', 'sub');
    fs.mkdirSync(sub);
    fs.mkdirSync(subGitDir, { recursive: true });
    fs.writeFileSync(path.join(sub, '.git'), `gitdir: ${subGitDir}\n`);
    // Even WITH a backlink, no commondir means not a linked worktree.
    fs.writeFileSync(path.join(subGitDir, 'gitdir'), `${path.join(sub, '.git')}\n`);
    registerTestHomes([home]);

    expect(resolveAgentHome(sub)).toEqual({ kind: 'none' });
  });

  it('answers the new owner when a worktree is removed and another repo adds one at the same path', () => {
    const benHome = path.join(scratch, 'ben');
    initRepo(benHome);
    const tree = path.join(scratch, 'trees', 'reused');
    registerTestHomes([home, benHome]);

    git(home, 'worktree', 'add', '-q', '-b', 'reused-a', tree);
    expect(homeOf(resolveAgentHome(tree))).toBe(home);

    git(home, 'worktree', 'remove', '--force', tree);
    git(benHome, 'worktree', 'add', '-q', '-b', 'reused-b', tree);
    expect(homeOf(resolveAgentHome(tree))).toBe(benHome);
  });

  it('stops resolving the moment the home is unregistered', () => {
    const tree = path.join(scratch, 'trees', 'unregister');
    git(home, 'worktree', 'add', '-q', '-b', 'unregister', tree);
    const { homes } = registerTestHomes([home]);
    expect(homeOf(resolveAgentHome(tree))).toBe(home);

    homes.delete(home);
    expect(resolveAgentHome(tree)).toEqual({ kind: 'none' });
    expect(resolveAgentHome(home)).toEqual({ kind: 'none' });
  });
});

/** Run git in `cwd` with a fixed identity, so commits work on any machine. */
function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, stdio: 'pipe' }
  );
}

/** A repo with one commit that carries a committed `.dork/agent.json`. */
function initRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, '.dork'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, '.dork', 'agent.json'), '{"name":"committed-copy"}\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
}
