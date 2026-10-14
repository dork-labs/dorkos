/**
 * Whether this computer runs on mains power or its battery, and how full the
 * battery is: one read, never a watcher.
 *
 * Read the same way the holders are chosen, one OS tool per platform and never
 * through a shell:
 *
 * - **macOS** — `/usr/bin/pmset -g batt`, whose first line names the power
 *   source and whose battery line carries the percentage.
 * - **Windows** — `powershell.exe` reading `SystemInformation.PowerStatus` (the
 *   .NET wrapper over `GetSystemPowerStatus`), passed as `-EncodedCommand`
 *   like the holder.
 * - **Linux** — the files under `/sys/class/power_supply`: a mains or USB
 *   supply that is online, and the system battery's `capacity` and `status`.
 *
 * **It never throws.** Anything it cannot read or make sense of is `null`,
 * which callers treat as "unknown": a battery rule never stops keep-awake on a
 * guess.
 *
 * @module keep-awake/power
 */
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One reading of the power source. */
export interface PowerReading {
  /** Whether the computer is on mains power (charging or full counts). */
  onAc: boolean;
  /** Battery charge, 0 to 100, or null when there is no battery to read. */
  percent: number | null;
}

/** Injection seams for {@link readPower}. All default to the real thing. */
export interface PowerOptions {
  /** The operating system. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Runs a program with no shell and resolves its stdout, or null when it failed. */
  run?: (command: string, args: readonly string[]) => Promise<string | null>;
  /** A file's contents, or null when it cannot be read. */
  readFile?: (path: string) => string | null;
  /** A directory's entries, or an empty list when it cannot be read. */
  readDir?: (path: string) => string[];
}

/** Where macOS installs pmset. */
export const PMSET_PATH = '/usr/bin/pmset';
/** Where Linux lists its power supplies. */
const POWER_SUPPLY_DIR = '/sys/class/power_supply';
/** A power read that takes longer than this is abandoned as unknown. */
const RUN_TIMEOUT_MS = 5_000;

/**
 * The PowerShell script Windows runs: the line status, the charge as a 0..1
 * fraction, and the charge status flags (which say when there is no battery).
 */
export const WINDOWS_POWER_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$s = [System.Windows.Forms.SystemInformation]::PowerStatus',
  '"$($s.PowerLineStatus);$($s.BatteryLifePercent);$($s.BatteryChargeStatus)"',
].join('\n');

function runFile(command: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        [...args],
        { timeout: RUN_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => resolve(err ? null : stdout)
      );
    } catch {
      resolve(null);
    }
  });
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function readDirOrEmpty(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** A percentage clamped to 0..100, or null when it is not a number. */
function toPercent(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Parse `pmset -g batt`. The first line says `Now drawing from 'AC Power'` or
 * `'Battery Power'` (a UPS reads as `'UPS Power'`, which is not mains); the
 * internal battery's line carries `NN%`. A Mac with no battery has no such line.
 *
 * @param text - The command's stdout.
 */
export function parsePmsetBatt(text: string): PowerReading | null {
  const source = /drawing from '([^']+)'/.exec(text)?.[1];
  if (!source) return null;
  const battery = /InternalBattery[^\n]*?(\d{1,3})%/.exec(text)?.[1];
  return {
    onAc: source === 'AC Power',
    percent: battery === undefined ? null : toPercent(Number(battery)),
  };
}

/**
 * Parse the Windows script's one line: `Online;0.87;High`. `BatteryChargeStatus`
 * containing `NoSystemBattery` means a desktop: the charge fraction is
 * meaningless there.
 *
 * @param text - The script's stdout.
 */
export function parseWindowsPowerStatus(text: string): PowerReading | null {
  const [line, fraction, charge] = text.trim().split(';');
  if (line !== 'Online' && line !== 'Offline') return null;
  const noBattery = (charge ?? '').includes('NoSystemBattery');
  const value = Number((fraction ?? '').replace(',', '.'));
  return {
    onAc: line === 'Online',
    percent: noBattery || fraction === undefined ? null : toPercent(value * 100),
  };
}

/**
 * Read Linux's power supplies. Mains is online when any `Mains` or `USB`
 * supply says `online` is 1; with none of those present (some laptops expose
 * only the battery) a battery that is not `Discharging` means mains. Batteries
 * whose `scope` is `Device` (a mouse, a headset) are skipped.
 *
 * @param readDir - Lists a directory.
 * @param readFile - Reads a file.
 */
export function readLinuxPowerSupplies(
  readDir: (path: string) => string[],
  readFile: (path: string) => string | null
): PowerReading | null {
  const field = (supply: string, name: string): string | null =>
    readFile(join(POWER_SUPPLY_DIR, supply, name))?.trim() ?? null;
  let sawMains = false;
  let mainsOnline = false;
  let batteryPercent: number | null = null;
  let batteryStatus: string | null = null;
  for (const supply of readDir(POWER_SUPPLY_DIR)) {
    const type = field(supply, 'type');
    if (type === 'Mains' || type === 'USB') {
      sawMains = true;
      if (field(supply, 'online') === '1') mainsOnline = true;
    } else if (type === 'Battery' && field(supply, 'scope') !== 'Device') {
      if (batteryStatus !== null) continue;
      batteryStatus = field(supply, 'status');
      const capacity = field(supply, 'capacity');
      batteryPercent = capacity === null ? null : toPercent(Number(capacity));
    }
  }
  if (!sawMains && batteryStatus === null) return null;
  const onAc = sawMains ? mainsOnline : batteryStatus !== 'Discharging';
  return { onAc, percent: batteryPercent };
}

/**
 * Read the power source once. Resolves null when it cannot tell (an unknown
 * operating system, a tool that failed, output it does not recognize). Never
 * rejects.
 *
 * @param options - Injection seams; see {@link PowerOptions}.
 */
export async function readPower(options: PowerOptions = {}): Promise<PowerReading | null> {
  try {
    const platform = options.platform ?? process.platform;
    const run = options.run ?? runFile;
    switch (platform) {
      case 'darwin': {
        const out = await run(PMSET_PATH, ['-g', 'batt']);
        return out === null ? null : parsePmsetBatt(out);
      }
      case 'win32': {
        const encoded = Buffer.from(WINDOWS_POWER_SCRIPT, 'utf16le').toString('base64');
        const out = await run('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encoded,
        ]);
        return out === null ? null : parseWindowsPowerStatus(out);
      }
      case 'linux':
        return readLinuxPowerSupplies(
          options.readDir ?? readDirOrEmpty,
          options.readFile ?? readFileOrNull
        );
      default:
        return null;
    }
  } catch {
    return null;
  }
}
