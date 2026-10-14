/**
 * Reading the power source on each operating system, from the text each tool
 * really prints. Never throws, and anything it cannot read is null (unknown).
 */
import { describe, expect, it } from 'vitest';
import {
  parsePmsetBatt,
  parseWindowsPowerStatus,
  PMSET_PATH,
  readLinuxPowerSupplies,
  readPower,
  WINDOWS_POWER_SCRIPT,
} from '../power.js';

const PMSET_AC = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=23527523)\t80%; AC attached; not charging present: true
`;
const PMSET_BATTERY = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=23527523)\t7%; discharging; 0:21 remaining present: true
`;
const PMSET_DESKTOP = `Now drawing from 'AC Power'
`;

describe('macOS: pmset -g batt', () => {
  it('reads mains with the battery charge', () => {
    expect(parsePmsetBatt(PMSET_AC)).toEqual({ onAc: true, percent: 80 });
  });

  it('reads battery power', () => {
    expect(parsePmsetBatt(PMSET_BATTERY)).toEqual({ onAc: false, percent: 7 });
  });

  it('reads a Mac with no battery as mains with no charge', () => {
    expect(parsePmsetBatt(PMSET_DESKTOP)).toEqual({ onAc: true, percent: null });
  });

  it('reads a UPS as not mains', () => {
    expect(parsePmsetBatt(`Now drawing from 'UPS Power'\n`)).toEqual({
      onAc: false,
      percent: null,
    });
  });

  it('is unknown for text it does not recognize', () => {
    expect(parsePmsetBatt('')).toBeNull();
  });

  it('runs /usr/bin/pmset with no shell', async () => {
    const calls: Array<[string, readonly string[]]> = [];
    const reading = await readPower({
      platform: 'darwin',
      run: async (command, args) => {
        calls.push([command, args]);
        return PMSET_BATTERY;
      },
    });
    expect(calls).toEqual([[PMSET_PATH, ['-g', 'batt']]]);
    expect(PMSET_PATH).toBe('/usr/bin/pmset');
    expect(reading).toEqual({ onAc: false, percent: 7 });
  });
});

describe('Windows: SystemInformation.PowerStatus', () => {
  it('reads mains and the charge fraction', () => {
    expect(parseWindowsPowerStatus('Online;0.87;High\r\n')).toEqual({ onAc: true, percent: 87 });
  });

  it('reads battery power, including a comma decimal', () => {
    expect(parseWindowsPowerStatus('Offline;0,15;Low')).toEqual({ onAc: false, percent: 15 });
  });

  it('reads a desktop with no battery as no charge', () => {
    expect(parseWindowsPowerStatus('Online;1;NoSystemBattery')).toEqual({
      onAc: true,
      percent: null,
    });
  });

  it('is unknown when the line status is unknown', () => {
    expect(parseWindowsPowerStatus('Unknown;1;Unknown')).toBeNull();
  });

  it('runs the script as an encoded command', async () => {
    let seen: readonly string[] = [];
    const reading = await readPower({
      platform: 'win32',
      run: async (command, args) => {
        expect(command).toBe('powershell.exe');
        seen = args;
        return 'Offline;0.5;Low';
      },
    });
    expect(seen[seen.length - 2]).toBe('-EncodedCommand');
    expect(Buffer.from(seen[seen.length - 1]!, 'base64').toString('utf16le')).toBe(
      WINDOWS_POWER_SCRIPT
    );
    expect(reading).toEqual({ onAc: false, percent: 50 });
  });
});

/** A fake `/sys/class/power_supply` tree: supply name to its files. */
function sysfs(tree: Record<string, Record<string, string>>) {
  return {
    readDir: (path: string) => (path === '/sys/class/power_supply' ? Object.keys(tree) : []),
    readFile: (path: string) => {
      const [, supply, file] = /power_supply\/([^/]+)\/([^/]+)$/.exec(path) ?? [];
      const value = supply && file ? tree[supply]?.[file] : undefined;
      return value === undefined ? null : `${value}\n`;
    },
  };
}

describe('Linux: /sys/class/power_supply', () => {
  it('reads mains online and the battery charge', () => {
    const fs = sysfs({
      AC: { type: 'Mains', online: '1' },
      BAT0: { type: 'Battery', status: 'Charging', capacity: '64', scope: 'System' },
    });
    expect(readLinuxPowerSupplies(fs.readDir, fs.readFile)).toEqual({ onAc: true, percent: 64 });
  });

  it('reads battery power when mains is offline', () => {
    const fs = sysfs({
      ACAD: { type: 'Mains', online: '0' },
      BAT1: { type: 'Battery', status: 'Discharging', capacity: '12' },
    });
    expect(readLinuxPowerSupplies(fs.readDir, fs.readFile)).toEqual({ onAc: false, percent: 12 });
  });

  it('skips a peripheral battery (scope Device)', () => {
    const fs = sysfs({
      AC: { type: 'Mains', online: '1' },
      hidpp_battery_0: { type: 'Battery', status: 'Discharging', capacity: '3', scope: 'Device' },
    });
    expect(readLinuxPowerSupplies(fs.readDir, fs.readFile)).toEqual({ onAc: true, percent: null });
  });

  it('falls back to the battery status when there is no mains supply listed', () => {
    const fs = sysfs({ BAT0: { type: 'Battery', status: 'Full', capacity: '100' } });
    expect(readLinuxPowerSupplies(fs.readDir, fs.readFile)).toEqual({ onAc: true, percent: 100 });
  });

  it('is unknown with no supplies at all (a desktop or a VM)', () => {
    const fs = sysfs({});
    expect(readLinuxPowerSupplies(fs.readDir, fs.readFile)).toBeNull();
  });

  it('goes through readPower on linux', async () => {
    const fs = sysfs({ AC: { type: 'Mains', online: '0' } });
    expect(await readPower({ platform: 'linux', ...fs })).toEqual({ onAc: false, percent: null });
  });
});

describe('readPower', () => {
  it('is unknown when the tool fails, and on an unknown system', async () => {
    expect(await readPower({ platform: 'darwin', run: async () => null })).toBeNull();
    expect(await readPower({ platform: 'freebsd' })).toBeNull();
  });

  it('never rejects, even when the runner throws', async () => {
    await expect(
      readPower({
        platform: 'darwin',
        run: () => {
          throw new Error('boom');
        },
      })
    ).resolves.toBeNull();
  });
});
