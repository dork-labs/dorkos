/**
 * The SQLite add-on has to be findable from every layout a plugin can actually
 * be installed into (DOR-1563).
 *
 * **This loads a real `.node` file rather than asserting a path string.** The
 * thing that was broken before was not a wrong-looking path — it was
 * `require('bindings')('better_sqlite3.node')`, which walks up from the calling
 * file hunting for `build/Release/…` and finds nothing in a vault. A test that
 * compared strings would have agreed with the broken version. So each layout
 * below is built on disk, the add-on is put where the build would put it, and
 * the loader is evaluated for real.
 *
 * The add-on used is the one in `node_modules` — a build for the Node running
 * this test rather than for Electron. That is the point: the loader names the
 * file after `process.versions.modules`, so under Node it asks for the Node
 * build and under Obsidian it asks for the Electron one. The naming rule is what
 * is under test, and it is the same rule in both hosts.
 *
 * @module obsidian-plugin/__tests__/sqlite-addon-layouts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import {
  SQLITE_ADDON_LOADER,
  SQLITE_ADDON_ABIS,
  SQLITE_ADDON_TARGETS,
  addonFileName,
  lockKey,
  prebuildUrl,
  readAddonLock,
  rewriteAddonLoad,
} from '../../build-plugins/sqlite-addon.js';

const require_ = createRequire(import.meta.url);

/** This machine, named the way the loader will name it at runtime. */
const HERE = {
  platform: process.platform,
  arch: process.arch,
  abi: Number(process.versions.modules),
};

/** The add-on this Node can load, standing in for the one Obsidian would. */
const NODE_ADDON = path.join(
  path.dirname(require_.resolve('better-sqlite3/package.json')),
  'build',
  'Release',
  'better_sqlite3.node'
);

let scratch: string;

/**
 * Build one install layout: a `main.js` holding nothing but the loader, and
 * (optionally) the add-on beside it under the name the loader will ask for.
 */
function layout(name: string, opts: { withAddon: boolean }): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'main.js'), `module.exports=${SQLITE_ADDON_LOADER};`);
  if (opts.withAddon) {
    fs.copyFileSync(NODE_ADDON, path.join(dir, addonFileName(HERE)));
  }
  return dir;
}

/**
 * Run a built `main.js` the way Obsidian does — reading the source and
 * evaluating it with `__filename` set to the path the plugin was reached
 * through, which for a symlinked dev install is the SYMLINK and not its target.
 */
function evalAsObsidianWould(mainPath: string): unknown {
  const module_ = { exports: {} as unknown };
  vm.runInNewContext(
    `(function(module,exports,require,__filename,__dirname,process){${fs.readFileSync(mainPath, 'utf-8')}})`,
    { console }
  )(module_, module_.exports, require_, mainPath, path.dirname(mainPath), process);
  return module_.exports;
}

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-addon-layout-'));
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('the layouts a person installs the plugin into', () => {
  it('loads the add-on from the built dist directory', () => {
    // `apps/obsidian-plugin/dist/` — what `turbo run build` produces, and what
    // the docs tell people to symlink.
    const dir = layout('dist', { withAddon: true });

    expect(evalAsObsidianWould(path.join(dir, 'main.js'))).toHaveProperty('Database');
  });

  it('loads the add-on from a real vault plugin directory', () => {
    const vault = path.join(scratch, 'vault', '.obsidian', 'plugins');
    fs.mkdirSync(vault, { recursive: true });
    const dir = layout(path.join('vault', '.obsidian', 'plugins', 'dorkos-copilot'), {
      withAddon: true,
    });

    expect(evalAsObsidianWould(path.join(dir, 'main.js'))).toHaveProperty('Database');
  });

  it('loads the add-on through a symlinked dev install', () => {
    // The documented developer path: the vault's plugin folder is a symlink to
    // the repo's `dist/`. Obsidian hands the plugin the SYMLINK path, so the
    // loader is evaluated with an un-realpathed `__filename` here on purpose —
    // resolution has to work from the path the host actually gave it.
    const real = layout('symlink-target', { withAddon: true });
    const link = path.join(scratch, 'linked-plugin');
    fs.symlinkSync(real, link, 'dir');

    expect(evalAsObsidianWould(path.join(link, 'main.js'))).toHaveProperty('Database');
  });

  it('says what is missing, in a sentence, when this Obsidian has no build', () => {
    // The honest degradation. A person on an Obsidian newer than the ABI window
    // loses search and nothing else, and is told which number was wanted.
    const dir = layout('no-addon', { withAddon: false });

    expect(() => evalAsObsidianWould(path.join(dir, 'main.js'))).toThrow(
      new RegExp(`${process.platform}-${process.arch}-abi${process.versions.modules}`)
    );
  });
});

describe('what gets staged beside the bundle', () => {
  it('names each add-on after the machine AND the ABI the host reports', () => {
    // The loader builds this name at runtime out of `process.platform`,
    // `process.arch` and `process.versions.modules`, so the two halves have to
    // agree letter for letter.
    expect(addonFileName({ platform: 'darwin', arch: 'arm64', abi: 133 })).toBe(
      'better_sqlite3-darwin-arm64-abi133.node'
    );
    expect(SQLITE_ADDON_LOADER).toContain(
      'process.platform+"-"+process.arch+"-abi"+process.versions.modules'
    );
    expect(SQLITE_ADDON_LOADER).toContain('"better_sqlite3-"+target+".node"');
  });

  it('does not offer a wrong-machine build under a name the loader would accept', () => {
    // A `dist/` copied from a Mac to a Windows box. Before the platform and
    // architecture were in the filename, that Mach-O binary sat under exactly
    // the name a Windows host asks for, and the failure was a raw loader error
    // instead of the plugin's own sentence.
    const dir = layout('foreign-machine', { withAddon: false });
    fs.copyFileSync(
      NODE_ADDON,
      path.join(dir, addonFileName({ platform: 'win32', arch: 'x64', abi: HERE.abi }))
    );

    expect(() => evalAsObsidianWould(path.join(dir, 'main.js'))).toThrow(/carries SQLite/);
  });

  it('covers the Electron the current Obsidian is built on', () => {
    // Obsidian 1.8.x ships Electron 34, whose module version is 133. This is the
    // one number the window may not lose without search going dark on the
    // desktop app most people are running.
    expect(SQLITE_ADDON_ABIS).toContain(133);
  });

  it('points at the add-on for the ABI, not for the Node that built it', () => {
    expect(prebuildUrl({ version: '12.11.1', abi: 133, platform: 'darwin', arch: 'arm64' })).toBe(
      'https://github.com/WiseLibs/better-sqlite3/releases/download/v12.11.1/better-sqlite3-v12.11.1-electron-v133-darwin-arm64.tar.gz'
    );
  });
});

describe('finding the add-on load inside the bundle', () => {
  // The real shape, lifted out of `dist/main.js`: Rollup's synthesized
  // `requireBindings()` helper, called with better-sqlite3's own literal.
  const REAL_SITE =
    'let np;if(ep==null?np=Cu||(Cu=requireBindings()("better_sqlite3.node")):typeof ep=="string"';

  it('replaces the call whatever Rollup named the helper', () => {
    const { code, sites } = rewriteAddonLoad(REAL_SITE);

    expect(sites).toBe(1);
    expect(code).not.toContain('requireBindings()');
    expect(code).toContain('better_sqlite3-');
  });

  it('leaves the string alone where it is not being called', () => {
    // A mention in a comment or an error message is not a load site, and
    // rewriting one would produce a syntax error rather than a fix.
    const mention = 'throw new Error("could not find better_sqlite3.node")';

    expect(rewriteAddonLoad(mention).sites).toBe(0);
  });

  it(
    'finds the site in a bundle-sized string without stalling the build',
    { timeout: 5_000 },
    () => {
      // Same trap as the __dirname rewrite next door: an unanchored pattern over
      // 60 MB backtracked for over three minutes without finishing.
      const filler = 'x'.repeat(1_000_000);

      const started = Date.now();
      const { sites } = rewriteAddonLoad(`${filler}${REAL_SITE}${filler}${filler}`);

      expect(sites).toBe(1);
      expect(Date.now() - started).toBeLessThan(1_000);
    }
  );
});

describe('the hashes the build will accept', () => {
  const lock = readAddonLock(path.resolve(import.meta.dirname, '../..'));

  it('pins every add-on the build could download', () => {
    // The build refuses to fetch a target with no pin, so a gap here is not a
    // security hole — it is search silently switched off on that machine. Both
    // are worth failing for.
    const wanted = SQLITE_ADDON_TARGETS.flatMap((target) =>
      SQLITE_ADDON_ABIS.map((abi) => lockKey({ ...target, abi }))
    );

    expect(lock).not.toBeNull();
    expect(wanted.filter((key) => !lock?.entries[key])).toEqual([]);
  });

  it('pins hashes for the better-sqlite3 the bundle actually carries', () => {
    // A lockfile a version behind would pin the hashes of a DIFFERENT binary
    // than the JavaScript in the bundle expects. The build throws on this too;
    // asserting it here means the mismatch is caught before a two-minute build.
    const bundled = (
      JSON.parse(fs.readFileSync(require_.resolve('better-sqlite3/package.json'), 'utf-8')) as {
        version: string;
      }
    ).version;

    expect(lock?.version).toBe(bundled);
  });

  it('holds real SHA-256 digests, not placeholders', () => {
    const digests = Object.values(lock?.entries ?? {});

    expect(digests.every((d) => /^[0-9a-f]{64}$/.test(d))).toBe(true);
    // Distinct per target: one hash copied across every entry would satisfy the
    // shape check above and pin nothing.
    expect(new Set(digests).size).toBe(digests.length);
  });
});
