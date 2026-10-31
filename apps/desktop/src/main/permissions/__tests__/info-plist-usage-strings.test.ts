import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * The privacy usage strings the packaged Mac app ships in `Info.plist`.
 *
 * macOS refuses file access to an app with no purpose string for that place,
 * silently and with EPERM, so the five file locations agents work in need one.
 * Every other usage string either stays stripped (`null`) or stays absent:
 * each one is a new thing the app may ask for, and that is a Security review.
 */

const CONFIG = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'electron-builder.yml'
);

/** The file locations agents read and change, keyed by their usage string. */
const FILE_LOCATION_KEYS = [
  'NSRemovableVolumesUsageDescription',
  'NSNetworkVolumesUsageDescription',
  'NSDesktopFolderUsageDescription',
  'NSDocumentsFolderUsageDescription',
  'NSDownloadsFolderUsageDescription',
];

/** Electron's default strings for things the app never captures. */
const STRIPPED_KEYS = [
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSAudioCaptureUsageDescription',
];

/** The `mac.extendInfo` block of electron-builder.yml. */
function extendInfo(): Record<string, unknown> {
  const config = parse(readFileSync(CONFIG, 'utf-8')) as {
    mac?: { extendInfo?: Record<string, unknown> };
  };
  expect(config.mac?.extendInfo, 'electron-builder.yml has no mac.extendInfo').toBeDefined();
  return config.mac!.extendInfo!;
}

describe('Info.plist usage strings', () => {
  // Purpose: without these, macOS never prompts and an agent's read of a USB
  // drive or the Documents folder fails with EPERM.
  it.each(FILE_LOCATION_KEYS)('ships a purpose string for %s', (key) => {
    const value = extendInfo()[key];
    expect(typeof value).toBe('string');
    expect((value as string).trim()).not.toBe('');
  });

  // Purpose: macOS grants access to the whole app, so the prompt must say the
  // answer covers every agent, not one.
  it.each(FILE_LOCATION_KEYS)('%s says the access covers every agent', (key) => {
    const value = extendInfo()[key] as string;
    expect(value).toMatch(/^Lets the agents you run in DorkOS /);
    expect(value).toMatch(/This applies to every agent\.$/);
    expect(value).not.toMatch(/\bwe\b/i);
  });

  // Purpose: camera, microphone, Bluetooth and audio capture stay stripped.
  it.each(STRIPPED_KEYS)('keeps %s stripped', (key) => {
    const info = extendInfo();
    expect(key in info).toBe(true);
    expect(info[key]).toBeNull();
  });

  // Purpose: no other usage string (Apple Events, contacts, calendars,
  // photos…) slips in without a Security review.
  it('ships no other usage strings', () => {
    const usageKeys = Object.keys(extendInfo()).filter((key) => /UsageDescription$/.test(key));
    expect(usageKeys.sort()).toEqual([...FILE_LOCATION_KEYS, ...STRIPPED_KEYS].sort());
  });
});
