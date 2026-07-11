import { describe, it, expect } from 'vitest';
import { assertPublishedSetComplete } from '../process.js';
import { SHOTS } from '../shots.js';
import type { AssetEntry } from '../optimize.js';

/**
 * Unit tests for the publish-completeness backstop: the record phase soldiers
 * on past a failed drive, so the process phase must refuse to publish a set
 * with holes in it.
 *
 * @module capture/__tests__/process
 */

/** Build the full expected published set straight from the registry. */
function completeSet(): AssetEntry[] {
  const entry = (file: string, surface: string): AssetEntry => ({
    file,
    surface,
    theme: file.includes('-dark') ? 'dark' : 'light',
    kind: file.endsWith('.webm') ? 'loop' : 'still',
    width: 1280,
    height: 800,
    bytes: 1,
  });
  return SHOTS.flatMap((shot) => {
    const assets = [entry(`${shot.id}-light.png`, shot.id)];
    if (shot.kind === 'loop') {
      assets.push(entry(`${shot.id}-dark.webm`, shot.id), entry(`${shot.id}-dark.png`, shot.id));
    }
    return assets;
  });
}

describe('assertPublishedSetComplete', () => {
  it('accepts a set covering every registered shot', () => {
    expect(() => assertPublishedSetComplete(completeSet())).not.toThrow();
  });

  it('rejects a set missing a still, naming the file', () => {
    const set = completeSet().filter((a) => a.file !== 'cockpit-light.png');
    expect(() => assertPublishedSetComplete(set)).toThrowError(/cockpit-light\.png/);
  });

  it('rejects a set missing a loop or its poster', () => {
    const set = completeSet().filter((a) => a.file !== 'canvas-dark.webm');
    expect(() => assertPublishedSetComplete(set)).toThrowError(/canvas-dark\.webm/);
    const noPoster = completeSet().filter((a) => a.file !== 'canvas-dark.png');
    expect(() => assertPublishedSetComplete(noPoster)).toThrowError(/canvas-dark\.png/);
  });

  it('lists every gap at once so one re-record fixes them all', () => {
    const set = completeSet().filter(
      (a) => a.file !== 'cockpit-light.png' && a.file !== 'canvas-dark.webm'
    );
    expect(() => assertPublishedSetComplete(set)).toThrowError(
      /cockpit-light\.png.*canvas-dark\.webm|canvas-dark\.webm.*cockpit-light\.png/s
    );
  });
});
