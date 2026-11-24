/**
 * The dev link watcher (DOR-2696 task 3.1, spec `marketplace-dev-link` §6):
 * what each change asks for, that a burst is acted on once, that nothing it
 * does records an approval or acts on a link that is no longer the dev link,
 * and that it closes every watch it opens.
 *
 * Most tests drive a fake watch so each event is exactly the one the test
 * names; `dev-link-watcher-fs.test.ts` runs the real chokidar watch.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { DevLinkRecord, DevLinkReloadedEvent } from '@dorkos/shared/marketplace-schemas';
import type { ExtensionRecord } from '@dorkos/extension-api';
import {
  classifyDevLinkChanges,
  declaredPathsOf,
  isIgnoredDevLinkPath,
  shapeChanges,
  shapeOf,
  type DevLinkChange,
  type DevLinkChangeKind,
} from '../dev-link-changes.js';
import {
  devLinkExtensionsOf,
  type DevLinkExtensionManager,
  type DevLinkExtensions,
} from '../dev-link-extensions.js';
import {
  DevLinkWatcher,
  type DevLinkWatcherDeps,
  type DevLinkWatchFactory,
  type DevLinkWatchListeners,
} from '../dev-link-watcher.js';
import { updateDevLinks } from '../registry.js';

describe('isIgnoredDevLinkPath', () => {
  it.each([
    ['.git/HEAD', true],
    ['node_modules/x/index.js', true],
    ['.dork/extensions/dash/node_modules/y.js', true],
    ['.dork/data/state.json', true],
    ['.dork/secrets.json', true],
    ['.dork/install-metadata.json', true],
    ['', false],
    ['skills/a/SKILL.md', false],
    ['.dork/extensions/dash/index.ts', false],
    ['.gitignore', false],
    ['my-node_modules-notes.md', false],
    ['target/debug/build/x.rs', true],
    ['.venv/lib/site.py', true],
    ['venv/bin/python', true],
    ['dist/index.js', true],
    ['.dork/extensions/dash/dist/index.js', true],
    ['.dork/extensions/foo/dist/x.js', true],
    ['.dork/extensions/dist/dist/a.js', true],
    ['bin/.venv/lib/x.py', true],
    ['skills/x/__pycache__/a.pyc', true],
    ['skills/.venv/SKILL.md', true],
    ['skills/x/build/out.md', true],
    ['commands/dist/go.md', false],
    ['skills/build/SKILL.md', false],
    ['skills/coverage/SKILL.md', false],
    ['commands/build/x.md', false],
    ['.dork/extensions/dist/index.ts', false],
    ['.dork/extensions/dist/node_modules/a.js', true],
    ['skills/x/.git/HEAD', true],
    ['build/out.js', true],
    ['__pycache__/a.pyc', true],
    ['.next/cache/x', true],
    ['coverage/lcov.info', true],
    ['NODE_MODULES/a.js', true],
    ['.GIT/HEAD', true],
    ['Target/x', true],
    ['bin/build', false],
    ['skills/a/.DS_Store', true],
    ['skills/a/.SKILL.md.swp', true],
    ['commands/go.md~', true],
    ['hooks/4913', true],
  ])('%s → %s', (rel, ignored) => {
    // Purpose: version control, dependencies, build/venv folders (any case),
    // editor leftovers and DorkOS's own runtime state never fire a reload; a
    // look-alike name, or a program named like a build folder, still does.
    expect(isIgnoredDevLinkPath(rel)).toBe(ignored);
  });
});

describe('declaredPathsOf', () => {
  it('lists the paths plugin.json names for declarations, inside the folder only', () => {
    // Purpose: a plugin may keep its hooks or servers file anywhere; an edit
    // there must refresh plugins like an edit to the default file.
    expect(
      declaredPathsOf({
        hooks: './config/hooks.json',
        mcpServers: ['servers/mcp.json', { inline: { command: 'x' } }],
        lspServers: { inline: true },
        experimental: { monitors: 'watch/monitors.json' },
        skills: ['./extra-skills/'],
        commands: '../outside',
        name: 'flow',
      })
    ).toEqual(['config/hooks.json', 'extra-skills', 'servers/mcp.json', 'watch/monitors.json']);
    expect(declaredPathsOf(undefined)).toEqual([]);
  });
});

/** A folder's listing, which these small fixtures always get. */
async function listed(...args: Parameters<typeof shapeOf>): Promise<Map<string, string>> {
  const shape = await shapeOf(...args);
  if (!shape) throw new Error('expected a listing');
  return shape;
}

describe('shapeOf', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'devlink-shape-')));
    await mkdir(path.join(dir, '.dork', 'extensions', 'dash'), { recursive: true });
    await writeFile(path.join(dir, '.dork', 'extensions', 'dash', 'index.ts'), 'x');
    await mkdir(path.join(dir, 'skills', 'a'), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds a file added deep inside an existing skill or extension folder', async () => {
    // Purpose: the sweep backs up a watch that dropped an event; a new file in
    // `skills/a/` or an extension's `src/` must still read as a change, which
    // a directory listing without modification times alone would miss.
    await mkdir(path.join(dir, '.dork', 'extensions', 'dash', 'src', 'deep'), { recursive: true });
    await mkdir(path.join(dir, 'skills', 'build'), { recursive: true });
    const before = await listed(dir);
    await writeFile(path.join(dir, 'skills', 'a', 'SKILL.md'), 'x');
    await writeFile(path.join(dir, 'skills', 'build', 'SKILL.md'), 'x');
    await writeFile(path.join(dir, '.dork', 'extensions', 'dash', 'src', 'deep', 'a.ts'), 'x');
    expect(
      shapeChanges(before, await listed(dir)).sort((a, b) => a.rel.localeCompare(b.rel))
    ).toEqual([
      { rel: '.dork/extensions/dash/src/deep/a.ts', kind: 'add' },
      { rel: 'skills/a/SKILL.md', kind: 'add' },
      { rel: 'skills/build/SKILL.md', kind: 'add' },
    ]);
  });
});

describe('classifyDevLinkChanges', () => {
  const known = new Set(['dash']);
  const plan = (rel: string, kind: DevLinkChangeKind = 'change') =>
    classifyDevLinkChanges([{ rel, kind }], known);

  it.each<[string, DevLinkChangeKind, Partial<ReturnType<typeof plan>>]>([
    ['.dork/extensions/dash/index.ts', 'change', { reload: ['dash'], refreshExtensions: false }],
    ['.dork/extensions/dash/src/deep/a.tsx', 'add', { reload: ['dash'] }],
    [
      '.dork/extensions/dash/extension.json',
      'change',
      { reload: ['dash'], refreshExtensions: true },
    ],
    ['.dork/extensions/dash', 'unlinkDir', { reload: [], refreshExtensions: true }],
    ['.dork/extensions/dash', 'change', { reload: ['dash'], refreshExtensions: false }],
    ['.dork/extensions/fresh', 'addDir', { reload: [], refreshExtensions: true }],
    ['.dork/extensions/fresh/extension.json', 'add', { reload: [], refreshExtensions: true }],
    ['.dork/extensions/fresh/index.ts', 'change', { reload: [], refreshExtensions: true }],
    ['.dork/extensions', 'change', { refreshExtensions: true }],
    ['skills/write/SKILL.md', 'add', { projection: true, plugins: true }],
    ['commands/go.md', 'change', { projection: true, plugins: true }],
    ['hooks/hooks.json', 'change', { projection: true, plugins: true }],
    ['SKILL.md', 'change', { projection: true, plugins: true }],
    ['.dork/tasks/nightly/SKILL.md', 'change', { projection: true, plugins: false }],
    ['.dork/manifest.json', 'change', { plugins: true, projection: true }],
    ['.claude-plugin/plugin.json', 'change', { plugins: true, projection: true }],
    ['bin/tool', 'add', { plugins: true, projection: false }],
    ['.mcp.json', 'change', { plugins: true, projection: false }],
    ['.lsp.json', 'change', { plugins: true, projection: false }],
    ['monitors/monitors.json', 'change', { plugins: true }],
    ['agents/reviewer.md', 'change', { plugins: true, projection: false }],
    ['.dork', 'addDir', { plugins: true, projection: true, refreshExtensions: true }],
    ['skills/build/SKILL.md', 'add', { projection: true, plugins: true }],
    ['commands/build/x.md', 'change', { projection: true, plugins: true }],
  ])('%s (%s)', (rel, kind, expected) => {
    // Purpose: the spec's classification table. Each row is the seam the
    // change must reach, and no other.
    expect(plan(rel, kind)).toMatchObject(expected);
  });

  it.each<[string, DevLinkChangeKind]>([
    ['README.md', 'change'],
    ['src/server.ts', 'change'],
    ['src', 'addDir'],
    ['server.log', 'change'],
    ['logs/today.log', 'add'],
    ['.DS_Store', 'change'],
    ['.README.md.swp', 'add'],
    ['skills/x/.DS_Store', 'add'],
    ['dist/index.js', 'change'],
    ['package.json', 'change'],
    ['.claude/settings.json', 'change'],
  ])('asks for nothing for %s (%s), which no declaration lives at', (rel, kind) => {
    // Purpose (S1): only files readRunnableDeclarations or Harness Sync read
    // refresh plugins. A log a dev-linked server writes into its own folder,
    // or a compiler's output, must not reload every session again and again.
    expect(plan(rel, kind)).toEqual({
      reload: [],
      refreshExtensions: false,
      projection: false,
      plugins: false,
    });
  });

  it('refreshes plugins for a path the plugin.json names', () => {
    // Purpose: `"hooks": "./config/hooks.json"` makes config/ a declaration.
    expect(
      classifyDevLinkChanges([{ rel: 'config/hooks.json', kind: 'change' }], known, [
        'config/hooks.json',
      ])
    ).toMatchObject({ plugins: true, projection: false });
    expect(plan('config/hooks.json')).toMatchObject({ plugins: false });
    expect(
      classifyDevLinkChanges([{ rel: 'dist/hooks.json', kind: 'change' }], known, [
        'dist/hooks.json',
      ])
    ).toMatchObject({ plugins: true });
  });

  it('folds a burst into one plan', () => {
    // Purpose: many events, one decision.
    const changes: DevLinkChange[] = [
      { rel: '.dork/extensions/dash/a.ts', kind: 'change' },
      { rel: '.dork/extensions/dash/b.ts', kind: 'change' },
      { rel: 'skills/x/SKILL.md', kind: 'change' },
    ];
    expect(classifyDevLinkChanges(changes, known)).toEqual({
      reload: ['dash'],
      refreshExtensions: false,
      projection: true,
      plugins: true,
    });
  });
});

/** A fake watch factory: records each watch and lets a test emit events. */
function fakeWatches() {
  const open = new Map<string, { listeners: DevLinkWatchListeners; closed: boolean }>();
  const closes = vi.fn();
  const factory: DevLinkWatchFactory = (folder, _ignored, listeners) => {
    const entry = { listeners, closed: false };
    open.set(folder, entry);
    queueMicrotask(() => listeners.onReady());
    return {
      close: async () => {
        entry.closed = true;
        closes(folder);
      },
    };
  };
  return {
    factory,
    closes,
    emit(folder: string, rel: string, kind: DevLinkChangeKind = 'change') {
      const entry = open.get(folder);
      if (!entry || entry.closed) return false;
      entry.listeners.onEvent(kind, path.join(folder, rel));
      return true;
    },
    isOpen: (folder: string) => open.has(folder) && !open.get(folder)!.closed,
    /** Make a folder's watch die, as chokidar does on `EMFILE`. */
    fail(folder: string) {
      open
        .get(folder)
        ?.listeners.onError(Object.assign(new Error('too many open files'), { code: 'EMFILE' }));
    },
  };
}

/** A promise a test settles by hand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the watcher told the command palette, shared by every watcher built here. */
const refreshProjectCommands = vi.fn<(projectPath: string) => void>();

let base: string;
let home: string;
let work: string;
let projectRoot: string;

/** Write a plugin folder carrying one extension. */
async function writePackage(dir: string): Promise<void> {
  await mkdir(path.join(dir, '.dork', 'extensions', 'dash'), { recursive: true });
  await writeFile(
    path.join(dir, '.dork', 'manifest.json'),
    JSON.stringify({ name: 'flow', version: '1.0.0', type: 'plugin' })
  );
  await writeFile(
    path.join(dir, '.dork', 'extensions', 'dash', 'extension.json'),
    JSON.stringify({ id: 'dash', name: 'dash', version: '1.0.0' })
  );
  await writeFile(path.join(dir, '.dork', 'extensions', 'dash', 'index.ts'), 'export {}\n');
}

/** Put a link in the slot and record it. */
async function recordLink(scope: 'global' | 'project' = 'global'): Promise<DevLinkRecord> {
  const slot =
    scope === 'global'
      ? path.join(home, 'plugins', 'flow')
      : path.join(projectRoot, '.dork', 'plugins', 'flow');
  await mkdir(path.dirname(slot), { recursive: true });
  await symlink(work, slot, 'dir');
  const record: DevLinkRecord = {
    name: 'flow',
    type: 'plugin',
    scope,
    ...(scope === 'project' && { projectPath: projectRoot }),
    slot,
    target: work,
    linkedAt: '2026-10-03T00:00:00.000Z',
    linkedVia: 'app',
  };
  await updateDevLinks(home, (links) => [...links, record], { replaceUnreadable: true });
  return record;
}

/** A fake extension seam that records what it was asked to do. */
function fakeExtensions(
  carried: Array<{ id: string; dir: string }> = [{ id: 'dash', dir: 'dash' }]
) {
  const ext = {
    carried,
    refresh: vi.fn(async () => undefined),
    reload: vi.fn<DevLinkExtensions['reload']>(async () => ({ outcome: 'reloaded' as const })),
  };
  const seam: DevLinkExtensions = {
    carriedBy: () => ext.carried,
    refresh: ext.refresh,
    reload: ext.reload,
  };
  return { ext, seam };
}

/** Wait until `check` passes or the time runs out. */
async function eventually(check: () => void, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

describe('DevLinkWatcher', () => {
  let watches: ReturnType<typeof fakeWatches>;
  let events: DevLinkReloadedEvent[];
  let refreshPlugins: Mock<DevLinkWatcherDeps['refreshPlugins']>;
  let reproject: Mock<DevLinkWatcherDeps['reproject']>;
  let watcher: DevLinkWatcher | undefined;

  function build(extensions?: DevLinkExtensions, quietMs = 40): DevLinkWatcher {
    watcher = new DevLinkWatcher({
      dorkHome: home,
      ...(extensions && { extensions }),
      refreshPlugins,
      reproject,
      refreshProjectCommands,
      broadcast: (event) => events.push(event),
      quietMs,
      rearmMs: 0,
      settleMs: 0,
      watch: watches.factory,
      now: () => new Date('2026-10-03T12:00:00.000Z'),
    });
    return watcher;
  }

  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'devlink-watcher-')));
    home = path.join(base, 'dork-home');
    work = path.join(base, 'work', 'flow');
    projectRoot = path.join(base, 'project');
    await mkdir(path.join(home, 'plugins'), { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await writePackage(work);
    watches = fakeWatches();
    events = [];
    refreshPlugins = vi.fn<DevLinkWatcherDeps['refreshPlugins']>();
    reproject = vi.fn<DevLinkWatcherDeps['reproject']>(async () => undefined);
    refreshProjectCommands.mockClear();
  });

  afterEach(async () => {
    await watcher?.stop();
    watcher = undefined;
    await rm(base, { recursive: true, force: true });
  });

  it('watches every dev link in force at start, and nothing else', async () => {
    // Purpose: boot opens one watch per linked folder; an empty registry opens none.
    const empty = build();
    await empty.start();
    expect(empty.watchedFolders()).toEqual([]);
    await empty.stop();

    await recordLink();
    const w = build();
    await w.start();
    await w.ready();
    expect(w.watchedFolders()).toEqual([work]);
  });

  it('coalesces a burst of edits into one reload', async () => {
    // Purpose: an editor save or a checkout storm is one reload, not one per event.
    await recordLink();
    const { ext, seam } = fakeExtensions();
    const w = build(seam, 80);
    await w.start();
    await w.ready();
    for (let i = 0; i < 25; i++) watches.emit(work, `.dork/extensions/dash/file-${i}.ts`);
    // The quiet period restarts on each event: a trickle that outlasts one
    // window, with no gap as long as it, is still one burst.
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      watches.emit(work, `.dork/extensions/dash/late-${i}.ts`);
    }
    await eventually(() => expect(events).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(events).toHaveLength(1);
    expect(ext.reload).toHaveBeenCalledTimes(1);
    expect(ext.reload).toHaveBeenCalledWith('dash');
    expect(events[0]).toEqual({
      name: 'flow',
      scope: 'global',
      at: '2026-10-03T12:00:00.000Z',
      actions: ['extension'],
    });
    expect(w.lastReloadAt({ name: 'flow', scope: 'global' })).toBe('2026-10-03T12:00:00.000Z');
  });

  it('refreshes plugins for a global link, and does not project it', async () => {
    // Purpose: DorkOS does not project global packages (as for an install);
    // the refresh is what re-checks global consent for a new declaration.
    await recordLink('global');
    const w = build(fakeExtensions().seam);
    await w.start();
    await w.ready();
    watches.emit(work, 'skills/new/SKILL.md', 'add');
    await w.flush();
    await w.projectionsIdle();
    expect(refreshPlugins).toHaveBeenCalledTimes(1);
    expect(reproject).not.toHaveBeenCalled();
    expect(events[0]?.actions).toEqual(['plugins']);
  });

  it('projects a project link through the projection seam, and never reloads session plugins for it', async () => {
    // Purpose: in a project, the projection is where a new skill lands and a
    // new hook is withheld and asked about. A project package is not an SDK
    // plugin, so reloading every live session's plugins would cost a cache
    // rebuild for nothing (S1).
    await recordLink('project');
    const w = build(fakeExtensions().seam);
    await w.start();
    await w.ready();
    watches.emit(work, 'hooks/hooks.json');
    await w.flush();
    await w.projectionsIdle();
    expect(refreshPlugins).not.toHaveBeenCalled();
    expect(reproject).toHaveBeenCalledWith({ packageName: 'flow', projectPath: projectRoot });
    expect(events[0]).toMatchObject({
      scope: 'project',
      projectPath: projectRoot,
      actions: ['projection'],
    });

    reproject.mockClear();
    watches.emit(work, '.dork/tasks/nightly/SKILL.md');
    await w.flush();
    await w.projectionsIdle();
    expect(reproject).toHaveBeenCalledTimes(1);
  });

  it('stops reloading a link whose slot now points somewhere else', async () => {
    // Purpose: link-replaced is no longer the dev link; acting on it would
    // reload code nobody approved through this link.
    const record = await recordLink();
    const { ext, seam } = fakeExtensions();
    const w = build(seam);
    await w.start();
    await w.ready();
    const elsewhere = path.join(base, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await unlink(record.slot);
    await symlink(elsewhere, record.slot, 'dir');
    watches.emit(work, '.dork/extensions/dash/index.ts');
    await w.flush();
    expect(ext.reload).not.toHaveBeenCalled();
    expect(refreshPlugins).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(watches.isOpen(work)).toBe(false);
    expect(w.watchedFolders()).toEqual([]);

    // And the sweep does not bring it back while it stays replaced.
    await w.sweep();
    expect(w.watchedFolders()).toEqual([]);
  });

  it('does nothing for a held link, and watches it again on release only if still in force', async () => {
    // Purpose: unlink holds reloads first; a failed unlink must not leave the
    // link deaf, and a finished one must not be watched again.
    const record = await recordLink();
    const { ext, seam } = fakeExtensions();
    const w = build(seam);
    await w.start();
    await w.ready();
    await w.hold(record);
    expect(watches.isOpen(work)).toBe(false);
    expect(watches.emit(work, '.dork/extensions/dash/index.ts')).toBe(false);
    await w.sweep();
    expect(w.watchedFolders()).toEqual([]);

    // The unlink failed: still recorded and in force.
    await w.release(record);
    await w.ready();
    expect(w.watchedFolders()).toEqual([work]);

    // The unlink succeeded this time.
    await w.hold(record);
    await updateDevLinks(home, () => []);
    await unlink(record.slot);
    await w.release(record);
    expect(w.watchedFolders()).toEqual([]);
    expect(ext.reload).not.toHaveBeenCalled();
  });

  it('closes every watch on stop and acts on nothing after', async () => {
    // Purpose: no chokidar handle survives shutdown, and a pending burst does
    // not fire into a stopped server.
    await recordLink();
    const { ext, seam } = fakeExtensions();
    const w = build(seam, 100);
    await w.start();
    await w.ready();
    watches.emit(work, '.dork/extensions/dash/index.ts');
    await w.stop();
    expect(watches.closes).toHaveBeenCalledWith(work);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ext.reload).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    await w.sync();
    expect(w.watchedFolders()).toEqual([]);
  });
});

describe('DevLinkWatcher under load and during unlink', () => {
  let watches: ReturnType<typeof fakeWatches>;
  let events: DevLinkReloadedEvent[];
  let refreshPlugins: Mock<DevLinkWatcherDeps['refreshPlugins']>;
  let reproject: Mock<DevLinkWatcherDeps['reproject']>;
  let watcher: DevLinkWatcher | undefined;

  function build(extensions?: DevLinkExtensions, quietMs = 40): DevLinkWatcher {
    watcher = new DevLinkWatcher({
      dorkHome: home,
      ...(extensions && { extensions }),
      refreshPlugins,
      reproject,
      refreshProjectCommands,
      broadcast: (event) => events.push(event),
      quietMs,
      rearmMs: 0,
      settleMs: 0,
      watch: watches.factory,
    });
    return watcher;
  }

  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'devlink-watcher-load-')));
    home = path.join(base, 'dork-home');
    work = path.join(base, 'work', 'flow');
    projectRoot = path.join(base, 'project');
    await mkdir(path.join(home, 'plugins'), { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await writePackage(work);
    watches = fakeWatches();
    events = [];
    refreshPlugins = vi.fn<DevLinkWatcherDeps['refreshPlugins']>(async () => undefined);
    reproject = vi.fn<DevLinkWatcherDeps['reproject']>(async () => undefined);
    refreshProjectCommands.mockClear();
  });

  afterEach(async () => {
    await watcher?.stop();
    watcher = undefined;
    await rm(base, { recursive: true, force: true });
  });

  it('never wakes for a change no declaration or extension lives at', async () => {
    // Purpose (S1): a server log, a compiler's output or an editor's swap file
    // in the folder must not even start a burst, let alone refresh plugins.
    await recordLink();
    const { ext, seam } = fakeExtensions();
    const carriedBy = vi.fn(seam.carriedBy);
    const w = build({ ...seam, carriedBy });
    await w.start();
    await w.ready();
    for (const rel of ['README.md', 'src/index.ts', 'server.log', '.DS_Store', '.x.swp']) {
      watches.emit(work, rel);
    }
    watches.emit(work, 'dist/index.js', 'add');
    await w.flush();
    await w.projectionsIdle();
    expect(carriedBy).not.toHaveBeenCalled();
    expect(refreshPlugins).not.toHaveBeenCalled();
    expect(ext.reload).not.toHaveBeenCalled();
    expect(events).toEqual([]);

    watches.emit(work, '.mcp.json');
    await w.flush();
    await w.projectionsIdle();
    expect(refreshPlugins).toHaveBeenCalledTimes(1);
  });

  it('hold waits for a burst under way, and nothing rebuilds after it returns', async () => {
    // Purpose (S3): a burst past its gate used to keep going while the unlink
    // ran, and rebuild whatever sat at the slot under the dev link's approval.
    const record = await recordLink();
    const { ext, seam } = fakeExtensions();
    const scan = deferred();
    ext.refresh.mockImplementation(async () => {
      await scan.promise;
    });
    const w = build(seam);
    await w.start();
    await w.ready();
    // A changed manifest: re-scan, then rebuild.
    watches.emit(work, '.dork/extensions/dash/extension.json');
    const flushing = w.flush();
    await eventually(() => expect(ext.refresh).toHaveBeenCalledTimes(1));

    let held = false;
    const holding = w.hold(record).then(() => {
      held = true;
    });
    await sleep(30);
    expect(held).toBe(false);
    scan.resolve();
    await holding;
    await flushing;
    expect(ext.reload).not.toHaveBeenCalled();
    expect(refreshPlugins).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(watches.isOpen(work)).toBe(false);
  });

  it('runs no owed projection once its dev link is held', async () => {
    // Purpose (S3): the projection lane used to run an owed projection after
    // the unlink, writing the removed package back into the project.
    const record = await recordLink('project');
    const first = deferred();
    reproject.mockImplementationOnce(() => first.promise);
    const w = build(fakeExtensions().seam);
    await w.start();
    await w.ready();
    watches.emit(work, 'skills/a/SKILL.md', 'add');
    await w.flush();
    await eventually(() => expect(reproject).toHaveBeenCalledTimes(1));
    watches.emit(work, 'skills/b/SKILL.md', 'add');
    await w.flush();
    await w.hold(record);
    first.resolve();
    await w.projectionsIdle();
    expect(reproject).toHaveBeenCalledTimes(1);
  });
});

describe('devLinkExtensionsOf', () => {
  const folder = '/work/flow';
  const devRecord = {
    id: 'dash',
    origin: 'user',
    path: '/home/.dork/plugins/flow/.dork/extensions/dash',
    sourcePlugin: 'flow',
    devLink: { path: folder },
    manifest: { id: 'dash', name: 'Dash', version: '1.0.0' },
  } as unknown as ExtensionRecord;
  const installedRecord = {
    id: 'other',
    origin: 'user',
    path: '/home/.dork/plugins/other/.dork/extensions/other',
    sourcePlugin: 'other',
    manifest: { id: 'other', name: 'Other', version: '1.0.0' },
  } as unknown as ExtensionRecord;

  function manager(status: 'compiled' | 'compile_error' = 'compiled') {
    return {
      listRecords: vi.fn(() => [devRecord, installedRecord]),
      reloadExtension: vi.fn(async (id: string) =>
        status === 'compiled'
          ? { id, status: 'compiled' as const, bundleReady: true, sourceHash: 'h2' }
          : {
              id,
              status: 'compile_error' as const,
              bundleReady: false,
              error: { code: 'BUILD', message: 'Unexpected "}"' },
            }
      ),
      requestRefresh: vi.fn(),
      whenIdle: vi.fn(async () => undefined),
    } satisfies DevLinkExtensionManager;
  }

  const approved = {
    enabled: ['dash'],
    disabled: [],
    approvedToRun: ['dash'],
    approvedSources: {
      dash: { path: devRecord.path, plugin: 'flow', devLink: folder },
    },
  };

  it('rebuilds an approved, turned-on extension and tells clients', async () => {
    // Purpose: the edit-and-it-reloads loop, on the dev link's existing yes.
    const m = manager();
    const announce = vi.fn();
    const seam = devLinkExtensionsOf(m, { config: () => approved, announce });
    expect(await seam.reload('dash')).toEqual({ outcome: 'reloaded' });
    expect(m.reloadExtension).toHaveBeenCalledWith('dash');
    expect(announce).toHaveBeenCalledWith(['dash']);
  });
});
