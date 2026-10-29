import { spawnSync } from 'child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { helperBinary } from './helper-binary';

/**
 * The packaged-desktop proof for Electron's fuses (DOR-3053 PR 1).
 *
 * The fuses are switches in the Electron Framework binary that the app and
 * every Helper share. `electron-builder.yml`'s `electronFuses` block sets them
 * at package time. This step reads them back from the packaged app, then
 * checks that each one does what it says, on the app binary and on the Helper:
 *
 * - `NODE_OPTIONS=--require <file>` loads nothing;
 * - `--inspect` on a normal launch of the app opens no inspector;
 * - `ELECTRON_RUN_AS_NODE=1` still runs a script. That row is PR 1's named
 *   residual, not the goal: isolated extensions and Playwright's browser
 *   download need run-as-node until DOR-3358. PR 2 (Keychain) adds a sibling
 *   row that must pass: run-as-node runs, but reading the Keychain item fails
 *   with no prompt.
 *
 * `--inspect` under run-as-node still opens an inspector on Electron 42.11.16:
 * the inspect fuse does not reach that mode. It is part of the same residual,
 * since run-as-node already runs any code, and it closes with DOR-3358. So the
 * inspect probe is a normal launch, where the fuse does apply.
 *
 * Every probe runs first on the stock Electron binary from `node_modules`, whose
 * fuses are all at their defaults, and must take effect there. A probe that
 * cannot succeed on stock Electron proves nothing on the packaged one.
 */

/** The fuses the packaged app must carry. Keep in step with `electron-builder.yml`. */
export const PACKAGED_FUSES = {
  runAsNode: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
} as const;

/** A fuse this app sets. */
export type PackagedFuse = keyof typeof PACKAGED_FUSES;

/** Where each fuse sits on the fuse wire. */
const FUSE_INDEX: Record<PackagedFuse, FuseV1Options> = {
  runAsNode: FuseV1Options.RunAsNode,
  enableNodeOptionsEnvironmentVariable: FuseV1Options.EnableNodeOptionsEnvironmentVariable,
  enableNodeCliInspectArguments: FuseV1Options.EnableNodeCliInspectArguments,
  enableEmbeddedAsarIntegrityValidation: FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
  onlyLoadAppFromAsar: FuseV1Options.OnlyLoadAppFromAsar,
};

/** What a launch with each way in actually did. */
export interface FuseEffects {
  /** `ELECTRON_RUN_AS_NODE=1` ran a script. */
  runAsNode: boolean;
  /** `NODE_OPTIONS=--require` loaded a file. */
  nodeOptions: boolean;
  /** `--inspect` on a normal launch opened an inspector. */
  inspect: boolean;
}

/** What the packaged app's fuses should make each probe do. */
export const EXPECTED_EFFECTS: FuseEffects = {
  runAsNode: PACKAGED_FUSES.runAsNode,
  nodeOptions: PACKAGED_FUSES.enableNodeOptionsEnvironmentVariable,
  inspect: PACKAGED_FUSES.enableNodeCliInspectArguments,
};

const RAN = 'dorkos-fuse-probe-ran';
const PRELOADED = 'dorkos-fuse-probe-preloaded';
/** What Node prints on standard error when `--inspect` opened an inspector. */
const INSPECTOR_LISTENING = /Debugger listening on ws:\/\//;

/** One probe launch can't take longer than this; a hung launch is a failure. */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * How long a normal launch with `--inspect` gets. The inspector line comes
 * before any app code runs, so a few seconds is plenty; the launch is then
 * stopped, since the packaged app would otherwise go on starting DorkOS.
 */
const INSPECT_LAUNCH_MS = 10_000;

/** launchd's PATH, so nothing from the runner's shell answers for the app. */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * A fuse's byte on the wire: ASCII '1' on, '0' off. The package's own
 * `FuseState` enum isn't exported at runtime, only as a type.
 */
const FUSE_ON = 0x31;
const FUSE_OFF = 0x30;

/** Name a fuse byte for an error message. */
function fuseName(byte: number | undefined): string {
  if (byte === FUSE_ON) return 'on';
  if (byte === FUSE_OFF) return 'off';
  return String(byte);
}

/**
 * Read the fuse wire and list every fuse that differs from {@link PACKAGED_FUSES}.
 *
 * @param wire - The wire `getCurrentFuseWire` returned, fuse index to byte.
 * @returns One line per wrong fuse; empty when all match.
 */
export function wrongFuses(wire: Partial<Record<number, number>>): string[] {
  return (Object.keys(PACKAGED_FUSES) as PackagedFuse[]).flatMap((fuse) => {
    const want = PACKAGED_FUSES[fuse] ? FUSE_ON : FUSE_OFF;
    const got = wire[FUSE_INDEX[fuse]];
    return got === want ? [] : [`${fuse}: expected ${fuseName(want)}, got ${fuseName(got)}`];
  });
}

/**
 * Work out what the three probe launches did from their output.
 *
 * @param outputs - Standard output of the run-as-node and NODE_OPTIONS probes,
 *   and everything the normal `--inspect` launch printed.
 */
export function readEffects(outputs: {
  runAsNode: string;
  nodeOptions: string;
  inspect: string;
}): FuseEffects {
  return {
    runAsNode: outputs.runAsNode.includes(RAN),
    nodeOptions: outputs.nodeOptions.includes(PRELOADED),
    inspect: INSPECTOR_LISTENING.test(outputs.inspect),
  };
}

/** Run `binary` as Node with a cut-down environment; returns its standard output. */
function runAsNode(binary: string, args: string[], home: string, extra: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(binary, args, {
    env: { PATH: LAUNCHD_PATH, HOME: home, ELECTRON_RUN_AS_NODE: '1', ...extra },
    encoding: 'utf-8',
    timeout: PROBE_TIMEOUT_MS,
  });
  return result.stdout ?? '';
}

/**
 * Launch `binary` normally (not as Node) with `--inspect`, stop it after
 * {@link INSPECT_LAUNCH_MS}, and return everything it printed.
 */
function launchWithInspect(binary: string, args: string[], home: string): string {
  const result = spawnSync(binary, ['--inspect=127.0.0.1:0', ...args], {
    env: { PATH: LAUNCHD_PATH, HOME: home },
    encoding: 'utf-8',
    timeout: INSPECT_LAUNCH_MS,
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/**
 * Launch `binary` three ways and report what each did.
 *
 * @param binary - An Electron binary (stock, the packaged app, or its Helper).
 * @param dir - A scratch folder for the preload file and HOME.
 * @param appArgs - What a normal launch needs after `--inspect`: a quitting
 *   app for stock Electron, nothing for the packaged app (it loads its own).
 *   `null` skips the normal launch (the Helper, which is not launched alone)
 *   and reports `inspect` as expected; its fuses are the app's, one framework.
 */
export function probeBinary(binary: string, dir: string, appArgs: string[] | null): FuseEffects {
  const preload = path.join(dir, 'preload.cjs');
  writeFileSync(preload, `process.stdout.write(${JSON.stringify(PRELOADED)});\n`);
  const ran = `process.stdout.write(${JSON.stringify(RAN)})`;
  const effects = readEffects({
    runAsNode: runAsNode(binary, ['-e', ran], dir),
    nodeOptions: runAsNode(binary, ['-e', ran], dir, { NODE_OPTIONS: `--require ${preload}` }),
    inspect: appArgs === null ? '' : launchWithInspect(binary, appArgs, dir),
  });
  return appArgs === null ? { ...effects, inspect: EXPECTED_EFFECTS.inspect } : effects;
}

/** Describe effects for an error message. */
function describe(effects: FuseEffects): string {
  return JSON.stringify(effects);
}

/**
 * Prove the packaged app carries its fuses and that they hold.
 *
 * @param appPath - The packaged `.app` bundle.
 * @returns A one-line summary for the smoke log.
 * @throws If a fuse is wrong, a probe is broken on stock Electron, or a way in
 *   still works on the packaged app.
 */
export async function assertFuses(appPath: string): Promise<string> {
  const wrong = wrongFuses(await getCurrentFuseWire(appPath));
  if (wrong.length > 0) {
    throw new Error(
      `The packaged app's fuses are not the ones electron-builder.yml sets:\n  ${wrong.join('\n  ')}`
    );
  }
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dorkos-smoke-fuses-')));
  try {
    const stock = createRequire(import.meta.url)('electron') as string;
    const quitter = path.join(dir, 'quit.cjs');
    writeFileSync(
      quitter,
      "const { app } = require('electron');\napp.whenReady().then(() => app.quit());\n"
    );
    const control = probeBinary(stock, dir, [quitter]);
    if (!control.runAsNode || !control.nodeOptions || !control.inspect) {
      throw new Error(
        `A fuse probe does not work even on stock Electron (${stock}): ${describe(control)}. ` +
          `Fix the probe; a probe that can't succeed there proves nothing here.`
      );
    }
    const app = path.join(appPath, 'Contents', 'MacOS', path.basename(appPath, '.app'));
    const probes: [string, string[] | null][] = [
      [app, []],
      [helperBinary(appPath), null],
    ];
    for (const [binary, appArgs] of probes) {
      const effects = probeBinary(binary, dir, appArgs);
      if (describe(effects) !== describe(EXPECTED_EFFECTS)) {
        throw new Error(
          `${path.basename(binary)} launched with ${describe(effects)}; its fuses should give ` +
            `${describe(EXPECTED_EFFECTS)}.`
        );
      }
    }
    return (
      `wire matches electron-builder.yml; NODE_OPTIONS does nothing on the app or its Helper, ` +
      `--inspect does nothing on a normal launch; run-as-node still runs, --inspect included ` +
      `(residual, DOR-3358)`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
