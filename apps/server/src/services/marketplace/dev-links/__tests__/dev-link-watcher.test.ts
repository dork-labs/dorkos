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
  relativeTo,
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

  it('ignores a build or dependency folder itself only when it is one', () => {
    // Purpose: chokidar must skip opening `target/` (S2), but a file called
    // `build` is a real change.
    expect(isIgnoredDevLinkPath('target', true)).toBe(true);
    expect(isIgnoredDevLinkPath('Node_Modules', true)).toBe(true);
    expect(isIgnoredDevLinkPath('bin/build', false)).toBe(false);
  });

  it('keeps a build-named folder only where the package named it', () => {
    // Purpose: a skill or extension called `build`/`dist`, or a folder on the
    // way to a plugin.json path, is the package's own; a build folder inside
    // one (or a venv anywhere) is output, and watching it would bring back
    // the too-many-watches risk.
    expect(isIgnoredDevLinkPath('skills/build', true)).toBe(false);
    expect(isIgnoredDevLinkPath('.dork/extensions/dist', true)).toBe(false);
    expect(isIgnoredDevLinkPath('.dork/extensions/foo/dist', true)).toBe(true);
    expect(isIgnoredDevLinkPath('skills/x/__pycache__', true)).toBe(true);
    expect(isIgnoredDevLinkPath('bin/.venv', true)).toBe(true);
    expect(isIgnoredDevLinkPath('bin/build', true)).toBe(true);
    expect(isIgnoredDevLinkPath('skills/venv', true)).toBe(true);
    expect(isIgnoredDevLinkPath('skills/node_modules', true)).toBe(true);
    const declared = ['dist/hooks.json'];
    expect(isIgnoredDevLinkPath('dist', true, declared)).toBe(false);
    expect(isIgnoredDevLinkPath('dist/hooks.json', false, declared)).toBe(false);
    // `dist` itself is the package's, but a build folder inside it is not.
    expect(isIgnoredDevLinkPath('dist/build/x.js', false, declared)).toBe(true);
    expect(isIgnoredDevLinkPath('dist', true)).toBe(true);
  });
});

describe('relativeTo', () => {
  it('keeps a name starting with two dots inside the folder', () => {
    // Purpose: `..foo` is a file in the folder, not a path out of it.
    expect(relativeTo('/w/flow', '/w/flow/..foo')).toBe('..foo');
    expect(relativeTo('/w/flow', '/w/flow/skills/..a/SKILL.md')).toBe('skills/..a/SKILL.md');
    expect(relativeTo('/w/flow', '/w/other')).toBeNull();
    expect(relativeTo('/w/flow', '/w')).toBeNull();
    expect(relativeTo('/w/flow', '/w/flow')).toBe('');
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

  it('does not change when something appears inside an ignored folder or runtime state', async () => {
    // Purpose (N1): a folder's own modification time moves when a child is
    // added; `node_modules` filling up or `.dork/data` being written must not
    // read as a change to the extension or the manifest folder.
    const before = await listed(dir);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await mkdir(path.join(dir, '.dork', 'extensions', 'dash', 'node_modules', 'x'), {
      recursive: true,
    });
    await mkdir(path.join(dir, '.dork', 'data'), { recursive: true });
    await writeFile(path.join(dir, '.dork', 'secrets.json'), '{}');
    await mkdir(path.join(dir, 'target', 'debug'), { recursive: true });
    await writeFile(path.join(dir, 'target', 'debug', 'out'), 'x');
    await mkdir(path.join(dir, 'skills', 'a', 'node_modules'), { recursive: true });
    expect(shapeChanges(before, await listed(dir))).toEqual([]);

    // And a real file at a swept level does.
    await writeFile(path.join(dir, '.dork', 'extensions', 'dash', 'more.ts'), 'y');
    expect(shapeChanges(before, await listed(dir))).toEqual([
      { rel: '.dork/extensions/dash/more.ts', kind: 'add' },
    ]);
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

  it('lists a path plugin.json names, even through a build-named folder', async () => {
    // Purpose: `"hooks": "./dist/hooks.json"` is a declaration the sweep must see.
    await mkdir(path.join(dir, 'dist'), { recursive: true });
    const before = await listed(dir, ['dist/hooks.json']);
    await writeFile(path.join(dir, 'dist', 'hooks.json'), '{}');
    await writeFile(path.join(dir, 'dist', 'bundle.js'), 'x');
    expect(shapeChanges(before, await listed(dir, ['dist/hooks.json']))).toEqual([
      { rel: 'dist/hooks.json', kind: 'add' },
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

  it('rebuilds an extension whose folder is named like a build folder', () => {
    // Purpose: an extension called `dist` is still an extension.
    expect(
      classifyDevLinkChanges(
        [{ rel: '.dork/extensions/dist/index.ts', kind: 'change' }],
        new Set(['dist'])
      )
    ).toMatchObject({ reload: ['dist'] });
  });

  it('asks for nothing at all for ignored paths', () => {
    // Purpose: a dependency install or a git operation must not reload.
    expect(
      classifyDevLinkChanges(
        [
          { rel: 'node_modules/a/b.js', kind: 'add' },
          { rel: '.git/index', kind: 'change' },
          { rel: '.dork/data/x.db', kind: 'change' },
        ],
        known
      )
    ).toEqual({ reload: [], refreshExtensions: false, projection: false, plugins: false });
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

  it('acts on a burst that never goes quiet, by the maximum wait', async () => {
    // Purpose: a tool writing without pause cannot hold every reload back.
    await recordLink();
    const { seam } = fakeExtensions();
    watcher = new DevLinkWatcher({
      dorkHome: home,
      extensions: seam,
      refreshPlugins,
      reproject,
      refreshProjectCommands,
      broadcast: (event) => events.push(event),
      quietMs: 100,
      maxWaitMs: 200,
      rearmMs: 0,
      settleMs: 0,
      watch: watches.factory,
    });
    await watcher.start();
    await watcher.ready();
    const started = Date.now();
    const timer = setInterval(() => watches.emit(work, 'hooks/hooks.json'), 20);
    try {
      await eventually(() => expect(events.length).toBeGreaterThan(0), 2_000);
    } finally {
      clearInterval(timer);
    }
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('re-scans for a new extension folder and never rebuilds it', async () => {
    // Purpose: a new extension is discovered unapproved and asks on its own
    // card; the watcher must not build or run it on the dev link's yes.
    await recordLink();
    const { ext, seam } = fakeExtensions();
    const w = build(seam);
    await w.start();
    await w.ready();
    watches.emit(work, '.dork/extensions/sneaky', 'addDir');
    watches.emit(work, '.dork/extensions/sneaky/extension.json', 'add');
    watches.emit(work, '.dork/extensions/sneaky/index.ts', 'add');
    await w.flush();
    expect(ext.refresh).toHaveBeenCalledTimes(1);
    expect(ext.reload).not.toHaveBeenCalled();
    expect(events[0]?.actions).toEqual(['extension']);
  });

  it('rebuilds an extension whose manifest changed only after re-scanning', async () => {
    // Purpose: a changed extension.json is read by the scan first, so the
    // rebuild uses the new manifest.
    await recordLink();
    const order: string[] = [];
    const { ext, seam } = fakeExtensions();
    ext.refresh.mockImplementation(async () => {
      order.push('refresh');
    });
    ext.reload.mockImplementation(async (id) => {
      order.push(`reload:${id}`);
      return { outcome: 'reloaded' };
    });
    const w = build(seam);
    await w.start();
    await w.ready();
    watches.emit(work, '.dork/extensions/dash/extension.json');
    await w.flush();
    expect(order).toEqual(['refresh', 'reload:dash']);
  });

  it('reports a build error in the event, and an extension it may not run as nothing', async () => {
    // Purpose: a compile error is not a watcher failure; a skipped extension
    // (off, or not approved) is neither an action nor an error.
    await recordLink();
    const { ext, seam } = fakeExtensions([
      { id: 'dash', dir: 'dash' },
      { id: 'other', dir: 'other' },
    ]);
    ext.reload.mockImplementation(async (id) =>
      id === 'dash' ? { outcome: 'failed', error: 'Unexpected "}"' } : { outcome: 'skipped' }
    );
    const w = build(seam);
    await w.start();
    await w.ready();
    watches.emit(work, '.dork/extensions/dash/index.ts');
    watches.emit(work, '.dork/extensions/other/index.ts');
    await w.flush();
    expect(events).toEqual([
      expect.objectContaining({
        actions: ['extension'],
        errors: ['dash didn\'t build: Unexpected "}"'],
      }),
    ]);

    events.length = 0;
    watches.emit(work, '.dork/extensions/other/index.ts');
    await w.flush();
    expect(events).toEqual([]);
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

  it("refreshes the project's command list after each projection, and never for a global link", async () => {
    // Purpose: a command or skill projected from a project dev link must reach
    // that project's palette; its cached command list is refreshed only once
    // the projection has written it.
    await recordLink('project');
    const running = deferred();
    reproject.mockImplementationOnce(() => running.promise);
    const w = build(fakeExtensions().seam);
    await w.start();
    await w.ready();
    watches.emit(work, 'commands/go.md', 'add');
    await w.flush();
    await eventually(() => expect(reproject).toHaveBeenCalledTimes(1));
    expect(refreshProjectCommands).not.toHaveBeenCalled();
    running.resolve();
    await w.projectionsIdle();
    expect(refreshProjectCommands).toHaveBeenCalledWith(projectRoot);
    await w.stop();

    refreshProjectCommands.mockClear();
    await updateDevLinks(home, () => []);
    await recordLink('global');
    const g = build(fakeExtensions().seam);
    await g.start();
    await g.ready();
    watches.emit(work, 'commands/go.md', 'add');
    await g.flush();
    await g.projectionsIdle();
    expect(refreshPlugins).toHaveBeenCalled();
    expect(refreshProjectCommands).not.toHaveBeenCalled();
  });

  it('keeps at most one projection running and one more owed', async () => {
    // Purpose: a projection can wait hours on a hook card; edits meanwhile
    // must not queue one projection each.
    await recordLink('project');
    let release!: () => void;
    reproject.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const w = build(fakeExtensions().seam);
    await w.start();
    await w.ready();
    for (let i = 0; i < 5; i++) {
      watches.emit(work, `skills/s${i}/SKILL.md`, 'add');
      await w.flush();
    }
    await eventually(() => expect(reproject).toHaveBeenCalledTimes(1));
    release();
    await w.projectionsIdle();
    expect(reproject).toHaveBeenCalledTimes(2);
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

  it('stops reloading a link that is no longer recorded', async () => {
    // Purpose: a hand edit of the registry or an unlink in another process
    // ends reloads at the next burst.
    await recordLink();
    const { ext, seam } = fakeExtensions();
    const w = build(seam);
    await w.start();
    await w.ready();
    await updateDevLinks(home, () => []);
    watches.emit(work, '.dork/extensions/dash/index.ts');
    await w.flush();
    expect(ext.reload).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(watches.isOpen(work)).toBe(false);
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

  it('shares one watch between two dev links of the same folder and tells both', async () => {
    // Purpose: one folder linked globally and into a project is one watch and
    // one rebuild, but each dev link hears about it.
    await recordLink('global');
    await recordLink('project');
    const { ext, seam } = fakeExtensions();
    const w = build(seam);
    await w.start();
    await w.ready();
    watches.emit(work, '.dork/extensions/dash/index.ts');
    await w.flush();
    expect(ext.reload).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.scope).sort()).toEqual(['global', 'project']);
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

  it('gives edits that arrive mid-burst their own quiet period, never a back-to-back pass', async () => {
    // Purpose (S1): events during a slow reload used to be acted on the
    // moment it finished, so a folder that kept changing drove one reload
    // after another with no debounce at all.
    await recordLink();
    const { ext, seam } = fakeExtensions();
    const first = deferred();
    let firstEnded = 0;
    let secondStarted = 0;
    ext.reload.mockImplementationOnce(async () => {
      await first.promise;
      firstEnded = Date.now();
      return { outcome: 'reloaded' };
    });
    ext.reload.mockImplementation(async () => {
      secondStarted = Date.now();
      return { outcome: 'reloaded' };
    });
    const w = build(seam, 200);
    await w.start();
    await w.ready();
    watches.emit(work, '.dork/extensions/dash/index.ts');
    await eventually(() => expect(ext.reload).toHaveBeenCalledTimes(1));
    watches.emit(work, '.dork/extensions/dash/index.ts');
    await sleep(20);
    first.resolve();
    await eventually(() => expect(ext.reload).toHaveBeenCalledTimes(2));
    expect(secondStarted - firstEnded).toBeGreaterThanOrEqual(180);
  });

  it('runs one plugin refresh at a time, with at most one more owed', async () => {
    // Purpose (S1): a refresh round-trips every live session; bursts that
    // finish while one is running must not start more beside it.
    await recordLink();
    const running = deferred();
    refreshPlugins.mockImplementationOnce(() => running.promise);
    const w = build(fakeExtensions().seam);
    await w.start();
    await w.ready();
    watches.emit(work, 'hooks/hooks.json');
    await w.flush();
    await eventually(() => expect(refreshPlugins).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 3; i++) {
      watches.emit(work, '.mcp.json');
      await w.flush();
    }
    expect(refreshPlugins).toHaveBeenCalledTimes(1);
    running.resolve();
    await w.projectionsIdle();
    expect(refreshPlugins).toHaveBeenCalledTimes(2);
  });

  it('catches up a watch that died against the last listing, not by replaying everything', async () => {
    // Purpose (S2): a watch that dies on every arm (EMFILE) must not re-run
    // every extension's code and refresh plugins at every sweep.
    await recordLink();
    const { ext, seam } = fakeExtensions();
    const w = build(seam);
    await w.start();
    await w.ready();
    for (let i = 0; i < 3; i++) {
      watches.fail(work);
      await w.sweep();
      await w.ready();
      await w.flush();
    }
    expect(ext.reload).not.toHaveBeenCalled();
    expect(ext.refresh).not.toHaveBeenCalled();
    expect(refreshPlugins).not.toHaveBeenCalled();
    expect(events).toEqual([]);

    // A change made while the watch was dead is still caught, alone.
    watches.fail(work);
    await writeFile(
      path.join(work, '.dork', 'extensions', 'dash', 'index.ts'),
      'export const a = 2;\n'
    );
    await w.sweep();
    await w.ready();
    await w.flush();
    expect(ext.reload).toHaveBeenCalledTimes(1);
    expect(ext.reload).toHaveBeenCalledWith('dash');
    expect(ext.refresh).not.toHaveBeenCalled();
    expect(refreshPlugins).not.toHaveBeenCalled();
  });

  it('keeps an extension folder appearing when a later report says it changed', async () => {
    // Purpose (N3): pending changes are one per path; a later `change` must
    // not hide that the folder is new, which needs a re-scan first.
    await recordLink();
    const { ext, seam } = fakeExtensions();
    const w = build(seam);
    await w.start();
    await w.ready();
    watches.emit(work, '.dork/extensions/dash', 'addDir');
    watches.emit(work, '.dork/extensions/dash', 'change');
    await w.flush();
    expect(ext.refresh).toHaveBeenCalledTimes(1);
  });

  it('forgets a missing folder whose dev link went away, so linking it again replays nothing', async () => {
    // Purpose (N2): a lost folder's catch-up belongs to the dev link that
    // lost it; a fresh link of the same folder starts clean.
    const record = await recordLink();
    const { ext, seam } = fakeExtensions();
    const w = build(seam);
    await w.start();
    await w.ready();
    await rm(work, { recursive: true, force: true });
    await w.sweep();
    expect(w.watchedFolders()).toEqual([]);
    await updateDevLinks(home, () => []);
    await unlink(record.slot);
    await w.sweep();

    await writePackage(work);
    await recordLink();
    await w.sync();
    await w.ready();
    await w.flush();
    expect(w.watchedFolders()).toEqual([work]);
    expect(ext.reload).not.toHaveBeenCalled();
    expect(ext.refresh).not.toHaveBeenCalled();
    expect(refreshPlugins).not.toHaveBeenCalled();
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

  it('lists only the extensions that come from the folder', () => {
    // Purpose: an edit in one folder never rebuilds another package's extension.
    const seam = devLinkExtensionsOf(manager(), { config: () => approved, announce: vi.fn() });
    expect(seam.carriedBy(folder)).toEqual([{ id: 'dash', dir: 'dash' }]);
  });

  it('rebuilds an approved, turned-on extension and tells clients', async () => {
    // Purpose: the edit-and-it-reloads loop, on the dev link's existing yes.
    const m = manager();
    const announce = vi.fn();
    const seam = devLinkExtensionsOf(m, { config: () => approved, announce });
    expect(await seam.reload('dash')).toEqual({ outcome: 'reloaded' });
    expect(m.reloadExtension).toHaveBeenCalledWith('dash');
    expect(announce).toHaveBeenCalledWith(['dash']);
  });

  it.each([
    ['not approved', { ...approved, approvedToRun: [], approvedSources: {} }],
    [
      'approved for the installed copy, not the dev link',
      {
        ...approved,
        approvedSources: { dash: { path: devRecord.path, plugin: 'flow' } },
      },
    ],
    ['turned off', { ...approved, enabled: [] }],
  ])('builds nothing for an extension that is %s', async (_label, config) => {
    // Purpose: a reload never widens trust. Building an extension a person
    // has not approved for this dev link, or has turned off, is refused here.
    const m = manager();
    const announce = vi.fn();
    const seam = devLinkExtensionsOf(m, { config: () => config, announce });
    expect(await seam.reload('dash')).toEqual({ outcome: 'skipped' });
    expect(m.reloadExtension).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  it('reports a build error without telling clients to load anything', async () => {
    // Purpose: a broken bundle is reported; the last good one keeps running.
    const announce = vi.fn();
    const seam = devLinkExtensionsOf(manager('compile_error'), {
      config: () => approved,
      announce,
    });
    expect(await seam.reload('dash')).toEqual({ outcome: 'failed', error: 'Unexpected "}"' });
    expect(announce).not.toHaveBeenCalled();
  });

  it('re-scans and waits for the scan', async () => {
    // Purpose: rebuilds after a re-scan must see the records it produced.
    const m = manager();
    const seam = devLinkExtensionsOf(m, { config: () => approved, announce: vi.fn() });
    await seam.refresh();
    expect(m.requestRefresh).toHaveBeenCalledTimes(1);
    expect(m.whenIdle).toHaveBeenCalledTimes(1);
  });
});
